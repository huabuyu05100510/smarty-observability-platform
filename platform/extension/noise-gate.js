// noise-gate.js · 噪音分组与抑制(Sentry-style,纯函数,零依赖)
// ----------------------------------------------------------------------------
// 把"同一根因反复抛"挡在根因/自愈之前。两段式架构里它同时服务两端:
//   · 源端(content.js):isBenign 丢已知良性 + shouldCoalesce 合并错误风暴(只对 error;
//     INP/快样本喂 p75,不可丢 → 只在读端分组)。
//   · 读端(data.js):fingerprint 做权威分组键(替代旧的 subType+message前48字符)。
// 全自包含:自带栈帧解析 + INP 主导段判定(不依赖 diagnose.js/error-diagnose.js —— 那俩
// 只在 side panel 加载,content script 里拿不到)。纯函数、零副作用 → 可单测。
// 设计权衡(见 plans/compiled-nibbling-thompson.md):
//   1. 指纹基于「原始 generated 帧」而非 sourcemap 还原帧 —— 否则同一错误在 resolvedFrames
//      overlay 到达前后会拆成两组;还原源码仅展示富化,不进分组键。
//   2. 白名单保守:只丢通用良性(ResizeObserver 自抛 / 跨域 Script error);AbortError 等
//      可能掩盖真问题,留 BENIGN_OPT_IN 默认关闭,需要时再开。
(function (global) {

  // ---- 消息归一:trim + 折叠空白 + 截断。不过度归一(Sentry 默认不合并不同属性名) ----
  function normalizeMsg(msg) {
    return String(msg == null ? '' : msg).trim().replace(/\s+/g, ' ').slice(0, 120);
  }

  // ---- 生成位置归一:剥 query、取 basename:line:col(跨 hash/部署版本稳定) ----
  function normLoc(url, line, col) {
    const base = String(url || '').split('?')[0].split('/').pop() || String(url || '') || 'unknown';
    return base + ':' + (line || 0) + ':' + (col || 0);
  }

  // ---- 栈顶帧:优先事件自带 filename/lineno/colno,否则粗解析 stack 取首帧 ----
  function topFrame(ev) {
    if (ev && ev.filename) return normLoc(ev.filename, ev.lineno, ev.colno);
    const stack = ev && ev.stack;
    if (stack) {
      for (const line of String(stack).split('\n')) {
        const m = line.match(/(?:at\s+)?(?:.*?\s+\(?)?(https?:\/\/[^\s)]+|[\w./-]+\.(?:js|ts|tsx|jsx|mjs)):(\d+):(\d+)/);
        if (m) return normLoc(m[1], +m[2], +m[3]);
      }
    }
    return 'noframe';
  }

  // ---- INP 主导段(自包含,不依赖 diagnose.dominantInpPhase) ----
  function inpDominant(ev) {
    const id = ev.inputDelay || 0, pd = ev.processingDuration || 0, sd = ev.presentationDelay || 0;
    return id >= pd && id >= sd ? 'inputDelay' : (pd >= sd ? 'processingDuration' : 'presentationDelay');
  }

  // ============ 异常类 / 资源名(Sentry 用 exception type 分组;本处从 message/sourceURL 推导)============
  function excClass(msg) {
    const m = String(msg == null ? '' : msg);
    const mm = m.match(/^(TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|Error|ChunkLoadError|NetworkError|DOMException)/);
    if (mm) return mm[1];
    if (/cannot read|of undefined|of null|is not a function/i.test(m)) return 'TypeError-like';
    if (/is not defined/i.test(m)) return 'ReferenceError-like';
    if (/unhandled promise|promise rejection/i.test(m)) return 'PromiseRejection';
    return 'Other';
  }
  function basename(u) { try { return decodeURIComponent(String(u || '').split('?')[0].split('/').pop() || '').slice(0, 64); } catch { return String(u || '').slice(-64); } }

  // ============ 权威指纹(Sentry-style 帧主导)============
  // js/promise 错误:subType + 异常类 + 栈顶 generated 帧。**不把完整 message 进键** →
  //   同帧不同变量名("reading 'foo'"/"'bar'")并组(变体由 group 的 messages Set 展示);
  //   不同栈帧同消息前缀分开(修旧指纹"前缀相同误并"问题)。
  // resource 错误:按资源文件分(无有用栈)。
  // INP:'inp' + interactionTarget + 主导段(同 target 不同瓶颈段分开,符合"瓶颈迁移"现实)。
  // 其余 vital(LCP/FCP/CLS/memory/fps):不分组 → 退化为稳定键(防 read 端意外把异质事件并组)。
  function fingerprint(ev) {
    if (!ev) return 'null';
    if (ev.subType === 'inp' || (ev.value != null && ev.inputDelay != null)) {
      return 'inp::' + (ev.interactionTarget || '?') + '::' + inpDominant(ev);
    }
    if (ev.subType === 'resource') {
      return 'resource::' + (ev.sourceURL ? basename(ev.sourceURL) : ('msg::' + normalizeMsg(ev.message)));
    }
    if (ev.type === 'error' || ev.subType === 'js' || ev.subType === 'promise') {
      return (ev.subType || 'err') + '::' + excClass(ev.message) + '::' + topFrame(ev);
    }
    return (ev.subType || ev.type || 'x') + '::' + normalizeMsg(ev.message);
  }

  // ============ 已知良性(白名单丢弃) ============
  // 默认只放通用、无歧义的良性模式。新增前先确认不会掩盖真问题。
  const BENIGN = [
    { re: /ResizeObserver loop completed with undelivered notifications/i, reason: 'ResizeObserver loop(浏览器自抛,良性)' },
    { re: /^Script error\.?$/i, reason: '跨域 Script error(CORS 屏蔽,无栈可分析,低价值)' },
  ];
  // 可选良性(默认关):AbortError 常为有意取消,但可能掩盖 fetch 链真问题 → 按需开启。
  const BENIGN_OPT_IN = [
    { re: /AbortError/i, reason: 'AbortError(常为有意取消,默认不丢)' },
  ];
  function isBenign(ev, opts) {
    const msg = ev && ev.message != null ? String(ev.message) : '';
    const list = (opts && opts.includeOptIn) ? BENIGN.concat(BENIGN_OPT_IN) : BENIGN;
    for (const b of list) if (b.re.test(msg)) return { drop: true, reason: b.reason };
    return { drop: false };
  }

  // ============ 风暴合并(per-page 窗口内同指纹只发首条) ============
  // state:调用方持有的 Map<fingerprint, {firstSeen, count}>。窗口内同指纹第 2+ 条 → suppress。
  // opts.now 注入便于单测;窗口默认 1s(挡 rAF/scroll/proposal 风暴,正常错误远达不到)。
  function shouldCoalesce(ev, state, opts) {
    if (!state) return { suppress: false };
    const o = opts || {};
    const win = o.windowMs != null ? o.windowMs : 1000;
    const t = o.now != null ? o.now : Date.now();
    const fp = fingerprint(ev);
    let entry = state.get(fp);
    if (!entry || t - entry.firstSeen > win) {
      state.set(fp, { firstSeen: t, count: 1 });
      return { suppress: false, fp, count: 1 };
    }
    entry.count = (entry.count || 1) + 1;
    return { suppress: true, fp, count: entry.count };
  }

  // ============ INP 分组(读端用:同 target+主导段 → ×N) ============
  // 输出与 data.js groupErrors 同形:{ fp, sample, count, first, last } 按 last 降序。
  function groupInp(events) {
    const map = new Map();
    for (const e of (events || [])) {
      if (!e || e.subType !== 'inp' && !(e.value != null && e.inputDelay != null)) continue;
      const fp = fingerprint(e);
      if (!map.has(fp)) map.set(fp, { fp, target: e.interactionTarget || '?', phase: inpDominant(e), sample: e, count: 0, first: e.timestamp, last: e.timestamp, values: [] });
      const g = map.get(fp);
      g.count++; g.values.push(e.value || 0);
      g.first = Math.min(g.first || Infinity, e.timestamp || 0);
      g.last = Math.max(g.last || 0, e.timestamp || 0);
    }
    return [...map.values()].sort((a, b) => (b.last || 0) - (a.last || 0));
  }

  global.__noiseGate = { fingerprint, isBenign, shouldCoalesce, groupInp, inpDominant, topFrame, excClass, basename, normalizeMsg, BENIGN, BENIGN_OPT_IN };
})(typeof globalThis !== 'undefined' ? globalThis : self);
