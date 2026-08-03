// ai-heal.js · 真自愈 AI 引擎(淘汰 5 模板白名单)
// ----------------------------------------------------------------------------
// 基于具体根因 + 源码,LLM 生成针对性 search/replace diff → applyPatch 应用 → new Function 语法校验 →
// (record-replay 重放验证 + 统计显著性裁决,复用 heal-loop/causal)→ Verifier 对抗(扩展端自对抗,不依赖后端)。
// 与模板白名单的区别:补丁针对具体根因动态生成(如针对"foo() O(n²)"生成"foo() 改用 Map 缓存"),非固定模板。
//
// local-first:只发源码片段+根因给 LLM;new Function 校验零依赖(无需 vendor acorn)。
(function (global) {
  const HEAL_PROMPT = 'You are a frontend performance/bug repair agent. Given a precise root cause + source code, generate a MINIMAL targeted fix as a search/replace diff. Constraints: search = the EXACT original code snippet to find (must appear verbatim in source, copy precisely); replace = the fixed code; minimal change, preserve surrounding logic; respond in 中文 for explanation. Respond ONLY JSON: {"search": string, "replace": string, "explanation": string(中文,为何这样修), "risk": "low"|"medium"|"high", "riskReason": string(中文)}.';

  const VERIFY_PROMPT = 'You are an adversarial patch Verifier. Given root cause + proposed patch (search/replace) + source code, judge if the patch ACTUALLY fixes the root cause without breaking other logic. Be skeptical — reject if: the search snippet won\'t verbatim-match the source, or the fix doesn\'t address the root cause, or it introduces regressions. Respond ONLY JSON: {"accepted": boolean, "reason": string(中文), "confidence": number 0-1}.';

  // 应用 search/replace diff 到源码(精确 verbatim 匹配;不匹配返回 null)
  function applyPatch(source, diff) {
    if (!source || !diff || diff.search == null) return null;
    const search = String(diff.search);
    const idx = source.indexOf(search);
    if (idx < 0) return null;
    return source.slice(0, idx) + String(diff.replace == null ? '' : diff.replace) + source.slice(idx + search.length);
  }

  // 语法校验(零依赖:new Function 试编译;仅语法合法,不校验语义/运行时)
  function validateSyntax(code) {
    if (!code) return false;
    try { new Function(code); return true; } catch { return false; }
  }

  // LLM 生成补丁。opts={rootCause, codeSlices, llmConfig?}
  // 返回 {diff, patched, sourceMatched, syntaxOk} 或 {error}
  async function generate(opts) {
    const L = globalThis.__llm;
    if (!L) return { error: 'llm-client.js 未加载' };
    const cfg = (opts && opts.llmConfig) || await L.getConfig();
    if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) return { error: '未配置 LLM(设置→AI 引擎)' };
    let diff;
    try { diff = await L.chatJson(cfg, [{ role: 'system', content: HEAL_PROMPT }, { role: 'user', content: buildHealPrompt(opts) }]); }
    catch (e) { return { error: (e && (e.llmError || e.message)) || String(e) }; }
    if (!diff || diff.search == null || diff.replace == null) return { error: 'LLM 未生成有效 search/replace' };
    // 校验:apply 到源码切片 + 语法合法
    const source = (opts.codeSlices && opts.codeSlices[0] && opts.codeSlices[0].content) || '';
    const patched = source ? applyPatch(source, diff) : null;
    const syntaxOk = patched != null ? validateSyntax(patched) : null;
    return { diff, patched, sourceMatched: patched != null, syntaxOk };
  }

  // Verifier 对抗:patch 是否真能修复根因(扩展端自对抗,第二个 LLM call)
  async function verify(opts) {
    const L = globalThis.__llm;
    if (!L) return { accepted: false, reason: 'llm-client.js 未加载', confidence: 0 };
    const cfg = (opts && opts.llmConfig) || await L.getConfig();
    if (!cfg || !cfg.apiKey) return { accepted: false, reason: '未配置 LLM', confidence: 0 };
    let v;
    try { v = await L.chatJson(cfg, [{ role: 'system', content: VERIFY_PROMPT }, { role: 'user', content: buildVerifyPrompt(opts) }]); }
    catch (e) { return { accepted: false, reason: (e && (e.llmError || e.message)) || String(e), confidence: 0 }; }
    return { accepted: !!(v && v.accepted), reason: (v && v.reason) || '', confidence: (v && v.confidence) != null ? v.confidence : 0.5 };
  }

  function buildHealPrompt(opts) {
    const L = [];
    L.push('## Root Cause(待修复的根因)', opts.rootCause || '(未提供)');
    if (opts.codeSlices && opts.codeSlices.length) {
      L.push('', '## Source Code(待修复)');
      opts.codeSlices.forEach((c, i) => L.push('### ' + (c.path || ('slice' + i)), '```', (c.content || '').slice(0, 4000), '```'));
    }
    L.push('', 'Generate a minimal search/replace fix targeting the root cause. JSON only.');
    return L.join('\n');
  }
  function buildVerifyPrompt(opts) {
    const L = [];
    L.push('## Root Cause', opts.rootCause || '');
    L.push('', '## Proposed Patch');
    L.push('search:', '```', (opts.diff && opts.diff.search) || '', '```');
    L.push('replace:', '```', (opts.diff && opts.diff.replace) || '', '```');
    if (opts.diff && opts.diff.explanation) L.push('explanation:', opts.diff.explanation);
    if (opts.codeSlices && opts.codeSlices.length) { L.push('', '## Source'); opts.codeSlices.forEach((c) => L.push('```', (c.content || '').slice(0, 3000), '```')); }
    L.push('', 'Judge if this patch truly fixes the root cause without regressions. JSON only.');
    return L.join('\n');
  }

  // 从 AI 生成的 diff + 根因 推断「最接近的运行时代理模板」,供 runLiveProxyValidation 做方向性验证。
  // 机械类(debounce/throttle/lazy)→ runnable:true,可经运行时代理近似验证「修这个根因能否改善指标」;
  // 语义类(memo/cleanup)→ runnable:false,运行时无法注入(React.memo / useEffect cleanup 需改源码)。
  // 诚实:这是 keyword 启发式映射,只为把「源码补丁」与「可测量的运行时代理」连起来作方向性验证,
  //      不保证语义等价;真补丁效果以应用 diff 后的源码为准。
  function deriveProxyTemplate(diff, rootCause) {
    const t = String((diff && (String(diff.search) + ' ' + String(diff.replace) + ' ' + (diff.explanation || ''))) || '') + ' ' + String(rootCause || '');
    const s = t.toLowerCase();
    if (/(debounce|防抖|节流|throttle)/.test(s)) return { templateId: 'debounce_handler', runnable: true, semantic: false, note: 'debounce 类:运行时给后续 listener 加防抖(已有 listener 不重绑)→ 近似验证「降低 handler 频率」方向' };
    if (/(async|defer|第三方|third.?party|analytics|gtag|script)/.test(s)) return { templateId: 'throttle_third_party', runnable: true, semantic: false, note: '第三方脚本类:运行时给后续新插入 script 加 async → 近似验证「释放主线程」方向' };
    if (/(lazy|loading|懒加载|图片|image|iframe|首屏)/.test(s)) return { templateId: 'lazy_load', runnable: true, semantic: false, note: '懒加载类:运行时给非首屏 img/iframe 加 lazy → 近似验证「降低 presentation 压力」方向' };
    if (/(memo|缓存|cache|\.map\(|重渲染|re-?render)/.test(s)) return { templateId: 'memo_wrap', runnable: false, semantic: true, note: 'memo/缓存类:运行时无法注入 React.memo,需应用 diff 到源码后复测' };
    if (/(cleanup|removeEventListener|clearTimeout|clearinterval|unsubscribe|卸载|泄漏|leak|timer|setinterval)/.test(s)) return { templateId: 'inject_cleanup', runnable: false, semantic: true, note: 'cleanup 类:运行时无法补 useEffect cleanup,需应用 diff 到源码后复测' };
    return null; // 未识别到可近似模板 → 源码级,不强测
  }

  global.__aiHeal = { generate, verify, applyPatch, validateSyntax, deriveProxyTemplate, HEAL_PROMPT, VERIFY_PROMPT };
})(typeof globalThis !== 'undefined' ? globalThis : self);
