// heal-loop.js · 自愈 loop 编排器(纯核心 runHealLoop + sidepanel adapter)
// 设计正本见 docs/heal-loop.md。结构决策:定位(①)在 loop 内、生 patch(②)在 verify(④)前、MR 人决定。
// 纯核心 runHealLoop(deps) 注入所有副作用 → 可独立单测/Playwright 验证控制流;adapter 把 deps 接到真实件。
// 诚实耦合:④ 测的是③运行时代理,MR 交付的是②源码 diff——机械类代理≡源码效果,语义类代理近似(已标注)。
(function (global) {
  function mean(xs) { return xs && xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }

  // ---- 候选映射:templateId → { label, semantic, fit(适配的 INP 段) } ----
  // proxy 走 heal-templates.js(templateId);sourceDiff 取自 mr-draft.js TEMPLATE_DIFFS。
  // semantic=true 的候选:运行时代理只能近似真 patch 效果,真源码 patch 需模型确认。
  const CANDIDATE_MAP = {
    debounce_handler:     { label: 'Handler 防抖',         semantic: false, fit: ['processingDuration'] },
    throttle_third_party: { label: '第三方脚本节流',       semantic: false, fit: ['inputDelay'] },
    lazy_load:            { label: '图片/iframe 懒加载',   semantic: false, fit: ['presentationDelay'] },
    memo_wrap:            { label: 'Memo 包裹',            semantic: true,  fit: ['presentationDelay'] },
    inject_cleanup:       { label: 'Effect cleanup',       semantic: true,  fit: ['processingDuration'] },
  };

  // ============ 纯核心:迭代收敛控制 ============
  // deps: {
  //   baselineValues:number[], initialContext:obj,
  //   localize(ctx) → { phase, candidateIds[] },                       // ① 每轮可重跑
  //   generateCandidate(loc, triedSet) → cand | null,                  // ② 生候选(源码diff+代理)
  //   applyProxy(cand) → Promise<{token, applyTime}>,                  // ③ apply 代理
  //   collectTreated(cand, applied) → Promise<number[]>,               // 采集 treated(代理 active 期间)
  //   rollback(token) → Promise<void>,                                 // 测完即撤
  //   verify(baseline, treated) → verdict,                             // ④ causal Welch t
  //   isExcellent(verdict, treated) → bool,                            // ⑤ 优秀?
  //   maxIters:int, onProgress(iter) → void,
  // }
  // 返回 { outcome:'excellent'|'inconclusive', winner|null, iterations[], evidence|null }
  // 多重比较校正:loop 跨候选各做一次 t 检验(最多 maxIters 次),family-wise error 膨胀。
  // Holm-Bonferroni 对所有 iterated 候选的 p 值步降校正,写回每个 iter.holm。单候选无需校正。
  function applyHolm(iterations) {
    const iterated = iterations.filter((it) => it.phase === 'iterated' && it.verdict);
    if (iterated.length < 2) return; // 单候选无多重比较问题
    const C = global.__causal;
    if (!C || !C.holmCorrect) return;
    const corrected = C.holmCorrect(iterated.map((it) => it.verdict.pValue), 0.05);
    iterated.forEach((it, i) => { it.holm = corrected[i]; });
  }
  async function runHealLoop(deps) {
    const maxIters = deps.maxIters || 5;
    const tried = new Set();
    const iterations = [];
    let loc = deps.localize(deps.initialContext || {});
    for (let i = 0; i < maxIters; i++) {
      // ② 生 patch:挑下一个未试候选;耗尽 → inconclusive
      const cand = deps.generateCandidate(loc, tried);
      if (!cand) { iterations.push({ i, phase: 'exhausted' }); break; }
      tried.add(cand.id);

      // ③ apply → 采集 treated → ④ verify → ⑤ 判定(任一步失败记 error,不中断 loop)
      const applied = await deps.applyProxy(cand);
      let treated = [], verdict = null, excellent = false, err = null;
      try {
        treated = await deps.collectTreated(cand, applied);
        verdict = deps.verify(deps.baselineValues, treated);
        excellent = deps.isExcellent(verdict, treated);
      } catch (e) { err = String((e && e.message) || e); }
      // 测完即撤:代理只供测量,MR 交付的是源码 diff(见诚实耦合)
      await deps.rollback(applied && applied.token);

      const iter = { i, phase: 'iterated', candidate: cand, treated, verdict, excellent, error: err };
      iterations.push(iter);
      if (deps.onProgress) { try { deps.onProgress(iter); } catch {} }

      if (excellent && !err) {
        applyHolm(iterations); // 多重比较校正:跨已试候选的 p 值 Holm 步降(≥2 候选才生效)
        const winnerIter = iterations.find((it) => it.candidate === cand);
        return { outcome: 'excellent', winner: cand, iterations, evidence: { verdict, baselineMean: mean(deps.baselineValues), treatedMean: mean(treated), holm: (winnerIter && winnerIter.holm) || null } };
      }
      // 没到优秀 → ① 重新定位(瓶颈可能已迁移;至少推进到下一个候选)
      loc = deps.localize(Object.assign({}, deps.initialContext || {}, { lastVerdict: verdict, lastCandidate: cand }));
    }
    applyHolm(iterations); // 多重比较校正(候选耗尽路径)
    return { outcome: 'inconclusive', winner: null, iterations, evidence: null };
  }

  // ============ adapter:把纯核心 deps 接到扩展真实件 ============
  // opts: { event, baselineValues:number[], getLiveInteractions:()=>[{time,value}],
  //         goodThresholdMs=200, need=6, collectTimeoutMs=20000, maxIters=5 }
  function buildAdapter(opts) {
    opts = opts || {};
    const good = opts.goodThresholdMs || 200;
    const collectTimeoutMs = opts.collectTimeoutMs || 20000;
    // 功效自适应 need:基于 baseline 均值/标准差 + 最小可检效应(MDE),算每组最小样本量,
    // 取代写死 need=6。MDE 默认「≥15% 改善 或 ≥30ms」(取大者更保守)。钳到 [4, treatedCap]:
    // 下限保统计意义,上限=采集来源的硬上限(treated 来自 content.js 的 live interactions 流,
    // 该流 cap=8;need>cap 时永远凑不齐 → 每候选空等 collectTimeoutMs=20s,无谓耗时)。
    // treatedCap 默认 8(对齐 content.js interactions cap),无 causal → 安全退回默认 6。
    const computeNeed = (vals) => {
      const C = global.__causal;
      const xs = (vals || []).filter((v) => v > 0);
      if (!C || !C.sampleSizeFor || xs.length < 2) return opts.need || 6;
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      const sigma = Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
      const mde = Math.max(m * (opts.mdeRatio != null ? opts.mdeRatio : 0.15), opts.mdeMinMs != null ? opts.mdeMinMs : 30);
      const cap = opts.treatedCap || 8;
      return Math.max(4, Math.min(C.sampleSizeFor(mde, sigma, 0.05, 0.8), cap));
    };
    const need = computeNeed(opts.baselineValues);
    const DIAG = () => global.__inpDiagnose;
    const CAUSAL = () => global.__causal;
    const MR = () => global.__inpMrDraft;

    return {
      baselineValues: opts.baselineValues || [],
      initialContext: { event: opts.event },
      maxIters: opts.maxIters || 5,

      // ① 定位:走域通用 __localize.inp(对齐官方三段);候选 id = family ∩ 可用模板,段位兜底
      localize(ctx) {
        const ev = (ctx && ctx.event) || opts.event || {};
        const L = global.__localize;
        const loc = (L && L.inp(ev)) || null;
        const phase = loc ? loc.dominant : ((DIAG() && DIAG().dominantInpPhase(ev) || {}).phase);
        const ids = [];
        (loc ? loc.family : []).forEach(id => { if (CANDIDATE_MAP[id] && !ids.includes(id)) ids.push(id); });
        if (!ids.length && phase) Object.entries(CANDIDATE_MAP).forEach(([id, m]) => { if (m.fit.includes(phase)) ids.push(id); });
        if (!ids.length) ids.push('debounce_handler'); // 最后兜底
        return { phase: phase || 'unknown', candidateIds: ids };
      },

      // ② 生 patch:挑未试候选 → 映射成 (proxy + sourceDiff) 对
      generateCandidate(loc, tried) {
        for (const id of (loc.candidateIds || [])) {
          if (tried.has(id)) continue;
          const m = CANDIDATE_MAP[id]; if (!m) continue;
          if (m.semantic) continue; // 语义类(memo_wrap/inject_cleanup)运行时仅 console.info,无真实 patch 效果 → 进 loop 必 inconclusive 且白等采集,跳过。它们仍在 checklist/MR 可见,只是不进测量 loop。
          const diff = (MR() && MR().TEMPLATE_DIFFS && MR().TEMPLATE_DIFFS[id]) || null;
          return {
            id, label: m.label, semantic: m.semantic,
            proxy: { templateId: id, opts: {} },
            sourceDiff: diff,
            summary: m.label + (m.semantic ? '(语义类·代理近似,真 patch 需模型确认)' : '(机械类·代理≡源码效果)'),
          };
        }
        return null;
      },

      // ③ apply:background APPLY_HEAL(→ MAIN world __inpHeal.apply)
      applyProxy(cand) {
        return new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'APPLY_HEAL', templateId: cand.proxy.templateId, opts: cand.proxy.opts || {} }, (resp) => {
              resolve({ token: (resp && resp.token) || null, applyTime: Date.now() });
            });
          } catch { resolve({ token: null, applyTime: Date.now() }); }
        });
      },

      // 采集 treated:轮询 live interactions,取 applyTime 后 need 个真实 INP
      collectTreated(_cand, applied) {
        const applyTime = (applied && applied.applyTime) || Date.now();
        return new Promise((resolve) => {
          const t0 = Date.now();
          const poll = () => {
            const inter = (opts.getLiveInteractions && opts.getLiveInteractions()) || [];
            const treated = inter.filter(x => (x.time || 0) > applyTime && (x.value || 0) > 0).map(x => x.value).slice(0, need);
            if (treated.length >= need) return resolve(treated);
            if (Date.now() - t0 > collectTimeoutMs) return resolve(treated); // 超时给已有:verify(runCausalValidation)不强求 need——8 条亦能出显著结论,此处只是采到来源上限(content.js interactions cap=8)或超时
            setTimeout(poll, 400);
          };
          poll();
        });
      },

      rollback(token) {
        if (!token) return Promise.resolve();
        return new Promise((resolve) => {
          try { chrome.runtime.sendMessage({ type: 'ROLLBACK_HEAL', token }, () => resolve()); } catch { resolve(); }
        });
      },

      // ④ verify:causal Welch t(direction=decrease);无 causal → 安全降级 inconclusive
      verify(baseline, treated) {
        return (CAUSAL() && CAUSAL().runCausalValidation(baseline, treated, { direction: 'decrease', alpha: 0.05 }))
          || { conclusion: 'inconclusive', significant: false, effectSize: 0, pValue: 1 };
      },

      // ⑤ 优秀:treated 进入 good 段 且 有显著下降(accepted)
      isExcellent(verdict, treated) {
        const m = mean(treated);
        return m > 0 && m <= good && !!verdict && !!verdict.significant && verdict.conclusion === 'accepted';
      },

      // 配对实验用:经 background → content replay.js 重放 record → {samples,notes}
      replayRecord(record) {
        return new Promise((resolve) => {
          if (!record || !record.events || !record.events.length) { resolve({ samples: [], notes: ['空 record'] }); return; }
          try {
            chrome.runtime.sendMessage({ type: 'REPLAY_RUN', record, opts: {} }, (resp) => {
              resolve(resp && resp.samples ? resp : { samples: [], notes: [(resp && resp.error) || 'replay 无响应'] });
            });
          } catch { resolve({ samples: [], notes: ['chrome.runtime 不可用'] }); }
        });
      },
    };
  }

  // ============ 配对因果实验(依赖 record-replay)============
  // 同一 record 在 patch 前/后各重放一次 → 配对 t(消除交互间固有差异,功效高于独立 Welch t)。
  // deps: { candidate, record, applyProxy(cand)→{token,applyTime}, rollback(token), replay(record)→{samples,notes} }
  // 返回 { candidate, baseline[], treated[], n, verdict, replayNotes }
  async function runPairedExperiment(deps) {
    const cand = deps.candidate;
    // ① baseline:patch 未 apply 时重放
    const baseR = await deps.replay(deps.record);
    const baseline = (baseR && baseR.samples) || [];
    // ② apply patch
    const applied = await deps.applyProxy(cand);
    // ③ treated:patch apply 后重放同一 record
    const treatR = await deps.replay(deps.record);
    const treated = (treatR && treatR.samples) || [];
    // ④ 测完即撤
    await deps.rollback(applied && applied.token);
    // ⑤ 配对 t(等长截断)
    const n = Math.min(baseline.length, treated.length);
    const C = global.__causal;
    const verdict = (n >= 2 && C && C.pairedTTest)
      ? C.pairedTTest(baseline.slice(0, n), treated.slice(0, n), { direction: 'decrease', alpha: 0.05 })
      : { conclusion: 'inconclusive', significant: false, pValue: 1, effectSize: 0, design: 'paired', caveats: ['配对不足(n<2):重放未产出足够样本'] };
    return { candidate: cand, baseline, treated, n, verdict, replayNotes: (baseR && baseR.notes) || [] };
  }

  // ============ 运行时代理方向性验证(连接 ai-heal 源码补丁 ↔ 因果引擎)============
  // 动机:ai-heal 生成的 search/replace 是**源码级**补丁,无构建环境的扩展无法把它灌进线上 bundle →
  // 无法对 AI diff 本身做运行时测量。但可把 diff 映射到「最接近的机械运行时代理」(deriveProxyTemplate),
  // apply 该代理 → 采 treated → Welch t → rollback,验证「修这个根因能否改善指标」的**方向**。
  // 诚实:代理仅近似源码补丁(机械类≈效果,如 lazy_load 立即生效;debounce 对已注册 listener 无效),
  //      verdict 是方向性证据(advisory,非 RCT),真补丁效果以应用 diff 后的源码为准。
  //      这正是 charter「LLM 补丁 → 统计显著性裁决」在 local-first 无构建环境下的诚实落地。
  function sendBg(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(resp);
        });
      } catch (e) { reject(e); }
    });
  }
  // deps: { proxyTemplateId, baselineValues:number[], getLiveInteractions:()=>[{time,value}],
  //         need=6, treatedCap=8, collectTimeoutMs=20000, rollbackAuto=true }
  // 返回 { runnable, proxyTemplateId?, token?, baseline, treated, verdict?, need, caveat?, reason? }
  async function runLiveProxyValidation(deps) {
    const templateId = deps && deps.proxyTemplateId;
    const C = global.__causal;
    if (!templateId) return { runnable: false, reason: '源码级补丁无机械运行时代理(语义类)→ 无法近似,请应用 diff 后在真实环境复测' };
    if (!C || !C.runCausalValidation) return { runnable: false, reason: 'causal.js 未加载' };
    const baseline = ((deps && deps.baselineValues) || []).filter((v) => v > 0);
    if (baseline.length < 4) return { runnable: false, reason: 'baseline 不足(需 ≥4 个真实交互)——先在页面产生几次交互再验证' };

    const need = Math.max(4, Math.min((deps && deps.need) || 6, (deps && deps.treatedCap) || 8)); // live interactions cap(content.js=8)
    const timeoutMs = (deps && deps.collectTimeoutMs) || 20000;

    // ① apply 代理(MAIN world prototype patch,经 background)
    const applyTime = Date.now();
    let token = null;
    try { const resp = await sendBg({ type: 'APPLY_HEAL', templateId, opts: {} }); token = (resp && resp.token) || null; }
    catch (e) { return { runnable: false, reason: 'apply 代理失败: ' + ((e && e.message) || e) }; }
    if (!token) return { runnable: false, reason: 'apply 代理未生效(无 token)——MAIN world patch 可能未注入(如 chrome:// 页)或返回 ok:false' };

    // ② 轮询 live treated(applyTime 之后的新交互)。verify 不强求 need,有几条算几条。
    const treated = await new Promise((resolve) => {
      const t0 = Date.now(); const seen = new Set(); const out = [];
      const poll = () => {
        const inter = (deps && deps.getLiveInteractions && deps.getLiveInteractions()) || [];
        for (const x of inter) {
          if ((x.time || 0) > applyTime && (x.value || 0) > 0 && !seen.has(x.time)) { seen.add(x.time); out.push(x.value); }
        }
        if (out.length >= need) return resolve(out.slice(0, need));
        if (Date.now() - t0 > timeoutMs) return resolve(out);
        setTimeout(poll, 400);
      };
      poll();
    });

    // ③ Welch t(direction=decrease)
    const verdict = C.runCausalValidation(baseline, treated, { direction: 'decrease', alpha: 0.05 });

    // ④ 测完即撤(代理只供测量;AI diff 是否应用由人决定)
    if ((deps && deps.rollbackAuto) !== false && token) { try { await sendBg({ type: 'ROLLBACK_HEAL', token }); } catch {} }

    return {
      runnable: true, proxyTemplateId: templateId, token, baseline, treated, verdict, need,
      caveat: '运行时代理仅近似源码补丁方向(机械类≈效果;debounce 类对已注册 listener 无效);真补丁效果以应用 diff 后源码为准。样本为同会话时序前后对照(非 RCT),p 值 advisory。',
    };
  }

  global.__healLoop = { runHealLoop, buildAdapter, runPairedExperiment, runLiveProxyValidation, CANDIDATE_MAP, mean };
})(typeof globalThis !== 'undefined' ? globalThis : self);
