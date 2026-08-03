// ai-rca.js · 真根因 AI 引擎(替代 diagnose 规则启发式)
// ----------------------------------------------------------------------------
// 移植自 packages/llm-rca(Navigator→Diagnoser→Verifier 多 agent + 残差融合)→ 扩展端纯 JS。
// 输入:signal + event + 确定性候选(diagnose/localize)+ source map 还原源码。
// 流程:① Navigator 选最有希望候选 → ② Diagnoser 生成具体根因(到源码+为什么) → ③ Verifier 反事实对抗否决 → ④ 残差融合(确定性×LLM,Verifier 否决降权)。
// 输出:「X 函数在 Y 场景因为 Z」级别的真根因 + 置信 + 证据 + 对抗验证结果。
//
// local-first:只把「源码片段+trace+候选」发 LLM 推理,全量数据仍在本地。
// 诚实:LLM-RCA 封顶 0.9(不 100% 信任),Verifier 否决 ×0.3,残差大降信心。
(function (global) {
  const NAVIGATOR_PROMPT = 'You are the Navigator in a root-cause analysis system. Given a symptom + ranked candidates + evidence + code slices, identify the SINGLE most promising candidate to focus deeper analysis on. If none fit, propose a new direction. Respond ONLY JSON: {"focusCandidateIndex": number, "rationale": string, "newDirection"?: string}. focusCandidateIndex: 0-based index into candidates, or -1 if none fit.';

  const DIAGNOSER_PROMPT = 'You are the Diagnoser. Given a focused candidate + evidence + code slices, produce a precise root-cause hypothesis EXPLAINING the observed symptom. Constraints: ground every claim in the provided evidence/code (do NOT fabricate); be specific (name the function, the data flow, the failing assumption); respond in 中文(Chinese). Respond ONLY JSON: {"rootCause": string(中文,具体到函数/数据流/为何), "confidence": number 0-1, "evidence": [string], "alternativeRootCause"?: string}.';

  const VERIFIER_PROMPT = 'You are an adversarial Verifier. Given symptom + root cause + evidence + code, do TWO checks: (1) PREDICTION — if this root cause is true, what specific signals MUST be present in the symptom data / source code? Are they actually present? (2) REFUTATION — try hard to find counterexamples, alternative explanations, or reasons it does NOT hold. Be skeptical — default refuted=true if the predicted signals are absent OR you can refute. Respond ONLY JSON: {"refuted": boolean, "reason": string(中文, MUST state: 预测必现的信号 + 实际是否观察到 + 否决理由), "confidence": number 0-1}.';

  // opt-in 独立 Predictor(默认关;默认走 Verifier 内置预测检验)。纯预测:列必现信号 + 逐条核对其是否真在 symptom/code。
  const PREDICTOR_PROMPT = 'You are a Predictor in a root-cause analysis system. Given symptom + proposed root cause + evidence + code, do PURE prediction (no refutation): list the SPECIFIC signals that MUST be present if this root cause is true, then for each state whether it is actually observed in the symptom data / source code. Respond ONLY JSON: {"signals":[{"expected":"string","observed":boolean}], "signalsAbsent": boolean (true if ANY required signal is NOT observed), "summary": "string(中文,含缺失项)".}';

  // 从 event 组装代码上下文:优先 enclosing 函数体(scope.body,采集时富化),回退 ±2 行 snippet。
  // slice 额外带 symbol/antiPatterns/framework → 进 Diagnoser/Verifier 提示,并供 grounding 核对。
  function buildCodeContext(event) {
    const slices = [];
    if (!event) return slices;
    const push = (anchor, fallbackPath) => {
      if (!anchor) return;
      const scope = anchor.scope;
      const symbol = (scope && scope.symbol) || anchor.name || '';
      const path = (anchor.source || fallbackPath) + (symbol ? ' · ' + symbol : '');
      let content = (scope && scope.body) || '';
      if (!content && anchor.snippet && anchor.snippet.rows) content = anchor.snippet.rows.map((r) => r.code).join('\n'); // 回退 ±2 行
      if (content) slices.push({ path, content, symbol, antiPatterns: (scope && scope.antiPatterns) || [], framework: (scope && scope.framework) || '' });
    };
    push(event.resolvedScript, 'inp-anchor'); // INP: LoAF 锚点
    if (event.resolvedFrames && event.resolvedFrames.length) event.resolvedFrames.slice(0, 3).forEach((f) => push(f, f.generated || 'error-frame')); // 错误栈帧
    return slices;
  }

  // 确定性 grounding 核对(0 额外 LLM):Diagnoser 引用的文件/符号是否真在 code slices(现含函数体)。
  // 缺失 → LLM 编造嫌疑(hallucination)→ 调用方降权。保守:文件引用缺失即判弱;长标识符需 ≥3 且 >70% 缺失才判弱。
  function groundingCheck(rootCause, codeSlices) {
    const text = String(rootCause || '');
    const corpus = codeSlices.map((s) => (s.path || '') + '\n' + (s.content || '')).join('\n');
    const sliceFiles = codeSlices.map((s) => String(s.path || '')).join('\n');
    const citedFiles = text.match(/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|vue|svelte|mjs)\b/g) || [];
    const missingFiles = citedFiles.filter((f) => { const b = f.split('/').pop(); return b && !sliceFiles.includes(b); });
    const STOP = new Set(['true', 'false', 'null', 'undefined', 'return', 'function', 'async', 'await', 'const', 'render', 'React', 'Array', 'Object', 'Math', 'JSON', 'Promise', 'window', 'document', 'console', 'function', 'handling', 'because']);
    const ids = text.match(/[A-Za-z_$][\w$]{6,}/g) || []; // 长标识符(>6)才查,避短词噪音
    const uniqIds = [...new Set(ids)].filter((id) => !STOP.has(id) && !/^[A-Z0-9]+$/.test(id));
    const missing = uniqIds.filter((id) => !corpus.includes(id));
    const idMissRatio = uniqIds.length ? missing.length / uniqIds.length : 0;
    const ok = missingFiles.length === 0 && !(uniqIds.length >= 3 && idMissRatio > 0.7);
    return { ok, missingFiles, suspicious: missing.slice(0, 8), checkedIds: uniqIds.length };
  }

  function buildNavigatorPrompt(ctx) {
    const L = [];
    L.push('## Symptom', ctx.signal + ': ' + (ctx.event && ctx.event.value != null ? ctx.signal + '=' + ctx.event.value : (ctx.event && ctx.event.message || 'observed')));
    L.push('', '## Ranked Candidate Causes (deterministic + localized)');
    (ctx.candidates || []).forEach((c, i) => {
      L.push('[' + i + '] kind=' + c.kind + ' confidence=' + (c.confidence || 0).toFixed(2));
      (c.evidence || []).forEach((e) => L.push('    - ' + e));
    });
    if (ctx.codeSlices && ctx.codeSlices.length) {
      L.push('', '## Code Slices (source-mapped)');
      ctx.codeSlices.forEach((c) => L.push('### ' + c.path, '```', (c.content || '').slice(0, 2000), '```'));
    }
    if (ctx.event && ctx.event.stack) L.push('', '## Stack', '```', String(ctx.event.stack).slice(0, 1500), '```');
    L.push('', 'Which candidate should Diagnoser focus on? JSON only.');
    return L.join('\n');
  }

  function buildDiagnoserPrompt(ctx, focused, newDirection) {
    const L = ['## Focused Candidate'];
    if (focused) {
      L.push('kind=' + focused.kind + ', confidence=' + (focused.confidence || 0).toFixed(2));
      (focused.evidence || []).forEach((e) => L.push('- ' + e));
    }
    if (newDirection) L.push('', '## Navigator New Direction', newDirection);
    if (ctx.codeSlices && ctx.codeSlices.length) {
      L.push('', '## Code Slices (enclosing function body)');
      ctx.codeSlices.forEach((c) => L.push('### ' + c.path, '```', (c.content || '').slice(0, 3000), '```'));
    }
    const ap = (ctx.codeSlices || []).flatMap((c) => c.antiPatterns || []);
    if (ap.length) L.push('', '## 静态反模式命中(advisory,值得排查的嫌疑)', [...new Set(ap.map((p) => p.id + '·' + p.hint))].map((s) => '- ' + s).join('\n'));
    const fw = (ctx.codeSlices || []).map((c) => c.framework).filter(Boolean)[0];
    if (fw && fw !== 'unknown') L.push('', '## 框架', fw);
    if (ctx.event && ctx.event.stack) L.push('', '## Stack', '```', String(ctx.event.stack).slice(0, 1500), '```');
    L.push('', 'Produce a precise root-cause hypothesis (中文). JSON only.');
    return L.join('\n');
  }

  function buildVerifierPrompt(ctx, diag) {
    const L = ['## Symptom', ctx.signal + ': ' + (ctx.event && ctx.event.value != null ? ctx.event.value : (ctx.event && ctx.event.message || ''))];
    L.push('', '## Proposed Root Cause', diag.rootCause, '(confidence=' + (diag.confidence || 0).toFixed(2) + ')');
    if (diag.evidence && diag.evidence.length) L.push('', '## Evidence', ...diag.evidence.map((e) => '- ' + e));
    if (ctx.codeSlices && ctx.codeSlices.length) {
      L.push('', '## Code');
      ctx.codeSlices.forEach((c) => L.push('```', (c.content || '').slice(0, 2000), '```'));
    }
    L.push('', 'Try to REFUTE this root cause. JSON only.');
    return L.join('\n');
  }
  function buildPredictorPrompt(ctx, diag) {
    const L = ['## Symptom', ctx.signal + ': ' + (ctx.event && ctx.event.value != null ? ctx.event.value : (ctx.event && ctx.event.message || ''))];
    L.push('', '## Proposed Root Cause', diag.rootCause);
    if (ctx.codeSlices && ctx.codeSlices.length) { L.push('', '## Code'); ctx.codeSlices.forEach((c) => L.push('```', (c.content || '').slice(0, 2000), '```')); }
    L.push('', 'List required signals + whether each is observed. JSON only.');
    return L.join('\n');
  }

  // 主入口:真根因诊断。opts={signal, event, candidates, llmConfig?}
  // 返回 {rootCause, confidence, evidence, verification, residual, detConf, llmConf} 或 {error}
  async function diagnose(opts) {
    const L = globalThis.__llm;
    if (!L) return { error: 'llm-client.js 未加载' };
    const cfg = (opts && opts.llmConfig) || await L.getConfig();
    if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) return { error: '未配置 LLM(设置→AI 引擎 填 provider+key+model)' };

    const ctx = {
      signal: opts.signal,
      event: opts.event || {},
      candidates: opts.candidates || [],
      codeSlices: (opts && opts.codeSlices) || buildCodeContext(opts.event),
    };

    let nav, diag, ver, pred = null;
    try {
      // ① Navigator
      nav = await L.chatJson(cfg, [{ role: 'system', content: NAVIGATOR_PROMPT }, { role: 'user', content: buildNavigatorPrompt(ctx) }]);
      const focusIdx = (nav && nav.focusCandidateIndex != null && nav.focusCandidateIndex >= 0) ? nav.focusCandidateIndex : 0;
      const focused = ctx.candidates[focusIdx] || ctx.candidates[0];
      // ② Diagnoser
      diag = await L.chatJson(cfg, [{ role: 'system', content: DIAGNOSER_PROMPT }, { role: 'user', content: buildDiagnoserPrompt(ctx, focused, nav && nav.newDirection) }]);
      if (!diag || !diag.rootCause) return { error: 'LLM 诊断无有效结果' };
      // ③ Verifier 对抗
      ver = await L.chatJson(cfg, [{ role: 'system', content: VERIFIER_PROMPT }, { role: 'user', content: buildVerifierPrompt(ctx, diag) }]);
      // ③b③ opt-in 独立 Predictor(默认关;失败不阻断主链路)
      if (opts && opts.predictor) { try { pred = await L.chatJson(cfg, [{ role: 'system', content: PREDICTOR_PROMPT }, { role: 'user', content: buildPredictorPrompt(ctx, diag) }]); } catch (e) { pred = null; } }
    } catch (e) {
      return { error: (e && (e.llmError || e.message)) || String(e) };
    }

    const verification = { refuted: !!(ver && ver.refuted), reason: (ver && ver.reason) || '', confidence: (ver && ver.confidence) != null ? ver.confidence : 0.5 };
    // ④ 残差融合
    const focused2 = ctx.candidates[(nav && nav.focusCandidateIndex >= 0 ? nav.focusCandidateIndex : 0)] || ctx.candidates[0];
    const detConf = (focused2 && focused2.confidence) || 0.5;
    const llmConf = diag.confidence != null ? diag.confidence : 0.5;
    const residual = Math.abs(detConf - llmConf);
    let fused = Math.sqrt(detConf * llmConf) - 0.3 * residual;
    if (verification.refuted) fused *= 0.3;
    // grounding 核对(确定性):rootCause 引用的文件/符号是否真在源码(函数体)中 → 编造嫌疑降权
    const grounding = groundingCheck(diag.rootCause, ctx.codeSlices);
    if (!grounding.ok) fused *= 0.5;
    if (pred && pred.signalsAbsent) fused *= 0.4; // opt-in Predictor:预测必现信号缺失 → 额外降权
    fused = Math.max(0, Math.min(0.9, fused));

    return {
      kind: 'ai_rca',
      rootCause: diag.rootCause,
      confidence: fused,
      evidence: (diag.evidence || []).concat([
        '确定性 conf=' + detConf.toFixed(2) + ' · LLM conf=' + llmConf.toFixed(2) + ' · 残差=' + residual.toFixed(2),
        'Verifier: ' + (verification.refuted ? '已否决' : '未否决') + (verification.reason ? '(' + verification.reason + ')' : ''),
        'grounding: ' + (grounding.ok ? '引用均在源码中找到' : ('⚠ 引用未在源码找到: ' + grounding.missingFiles.concat(grounding.suspicious).slice(0, 4).join(', '))),
      ]),
      alternativeRootCause: diag.alternativeRootCause,
      verification, grounding, prediction: pred, residual, detConf, llmConf,
      navigator: nav, diagnoser: diag,
    };
  }

  global.__aiRca = { diagnose, buildCodeContext, groundingCheck, buildNavigatorPrompt, buildDiagnoserPrompt, buildVerifierPrompt, buildPredictorPrompt, NAVIGATOR_PROMPT, DIAGNOSER_PROMPT, VERIFIER_PROMPT, PREDICTOR_PROMPT };
})(typeof globalThis !== 'undefined' ? globalThis : self);
