// localize.js · 域通用定位路由器(对齐官方归因模型)
// 把"哪个维度主导"统一成 localize(signal,event) → {dimension, dominant, segments[], family[]},
// 供 heal-loop(①定位)、checklist 高亮、根因视图共用。纯函数、零副作用 → 可单测。
// 归因模型依据见 docs/heal-tournament.md「localize 路由器契约」:
//   INP 三段 / LCP 四段(官方 web.dev/optimize-lcp) / FCP 三段(经验) / CLS 来源类(官方无相位) / 错误 分类+栈。
(function (global) {
  const DIAG = () => global.__inpDiagnose;       // INP 规则引擎(diagnose.js)
  const EDIAG = () => global.__inpErrorDiagnose; // 错误分类器(error-diagnose.js)

  // 取 value 最大的段 id(主导维度=元凶)
  function pickDom(segs) {
    let best = null, max = -1;
    for (const s of segs) { if ((s.value || 0) > max) { max = s.value || 0; best = s.id; } }
    return best;
  }

  // ---- INP:官方三段(Input Delay / Processing Duration / Presentation Delay)----
  // 来源 web.dev/optimize-inp。family = 该事件命中的所有 INP 规则 suggestedHealIds 取并集(更全)。
  function inp(ev) {
    const dom = (DIAG() && DIAG().dominantInpPhase(ev)) || null;
    const inputDelay = ev.inputDelay || 0, processing = ev.processingDuration || 0, presentation = ev.presentationDelay || 0;
    const total = Math.max(1, inputDelay + processing + presentation);
    const segs = [
      { id: 'inputDelay', label: 'Input Delay 输入延迟', value: inputDelay, ratio: inputDelay / total },
      { id: 'processingDuration', label: 'Processing 事件处理', value: processing, ratio: processing / total },
      { id: 'presentationDelay', label: 'Presentation 渲染呈现', value: presentation, ratio: presentation / total },
    ];
    const cands = (DIAG() && DIAG().analyzeRootCauses(ev)) || [];
    const fromRules = [];
    cands.forEach((c) => (c.suggestedHealIds || []).forEach((id) => { if (!fromRules.includes(id)) fromRules.push(id); }));
    const fallback = { inputDelay: ['inject_cleanup', 'throttle_third_party'], processingDuration: ['debounce_handler', 'inject_cleanup'], presentationDelay: ['memo_wrap', 'debounce_handler'] };
    return { signal: 'inp', dimension: 'phase', dominant: dom ? dom.phase : null, segments: segs, family: fromRules.length ? fromRules : (fallback[dom && dom.phase] || []) };
  }

  // ---- LCP:官方四段(TTFB / Resource Load Delay / Resource Load Time / Element Render Delay)----
  // 来源 web.dev/optimize-lcp。字段 ev.ttfb / ev.resStart / ev.resEnd / ev.value(=LCP,即 lcpStart)。
  // 缺 resStart/resEnd(旧数据)→ 降级三段。Load Delay(可发现性)与 Load Time(传输)解法族不同,必须分。
  function lcp(ev) {
    const v = ev.value || 0;
    const ttfb = ev.ttfb != null ? ev.ttfb : 0;
    const famByDom = { ttfb: [], resourceLoadDelay: ['preload_lcp'], resourceLoadTime: [], elementRenderDelay: ['defer_css'] };
    let segs;
    if (ev.resStart != null && ev.resEnd != null) {
      const loadDelay = Math.max(0, (ev.resStart || 0) - ttfb);   // TTFB → 资源开始拉取(可发现性/preload)
      const loadTime = Math.max(0, (ev.resEnd || 0) - (ev.resStart || 0)); // 拉取耗时(传输)
      const renderDelay = Math.max(0, v - (ev.resEnd || 0));      // 资源就绪 → 元素绘制
      const total = Math.max(1, v);
      segs = [
        { id: 'ttfb', label: 'TTFB 首字节', value: ttfb, ratio: ttfb / total },
        { id: 'resourceLoadDelay', label: '资源加载延迟·可发现性', value: loadDelay, ratio: loadDelay / total },
        { id: 'resourceLoadTime', label: '资源加载耗时·传输', value: loadTime, ratio: loadTime / total },
        { id: 'elementRenderDelay', label: '元素渲染延迟', value: renderDelay, ratio: renderDelay / total },
      ];
    } else {
      // 降级三段(旧数据:只有 resLoad,Delay/Time 未细分)
      const res = ev.resLoad || 0;
      const rest = Math.max(0, v - ttfb - res);
      const total = Math.max(1, v);
      segs = [
        { id: 'ttfb', label: 'TTFB 首字节', value: ttfb, ratio: ttfb / total },
        { id: 'resourceLoadTime', label: '资源加载(延迟/耗时未细分)', value: res, ratio: res / total },
        { id: 'elementRenderDelay', label: '其余(渲染/阻塞)', value: rest, ratio: rest / total },
      ];
    }
    const dom = pickDom(segs);
    return { signal: 'lcp', dimension: 'phase', dominant: dom, segments: segs, family: famByDom[dom] || [] };
  }

  // ---- FCP:经验三段(TTFB / HTML 解析 / 渲染阻塞);无 LCP 那样权威多段,但 TTFB 主导是共识 ----
  function fcp(ev) {
    const v = ev.value || 0;
    const ttfb = ev.ttfb != null ? ev.ttfb : 0;
    const parse = ev.domParse != null ? ev.domParse : 0;
    const blocking = Math.max(0, v - ttfb - parse);
    const total = Math.max(1, v);
    const segs = [
      { id: 'ttfb', label: 'TTFB 首字节', value: ttfb, ratio: ttfb / total },
      { id: 'parse', label: 'HTML 解析执行', value: parse, ratio: parse / total },
      { id: 'blocking', label: '渲染阻塞资源', value: blocking, ratio: blocking / total },
    ];
    const dom = pickDom(segs);
    const famByDom = { ttfb: [], parse: [], blocking: ['defer_css'] };
    return { signal: 'fcp', dimension: 'phase', dominant: dom, segments: segs, family: famByDom[dom] || [] };
  }

  // ---- CLS:来源类(官方无加性相位,按罪魁元素类归因)----
  // 来源 Chrome Layout shift culprits。media(无尺寸图/嵌入)/ font(FOUT)/ dom(动态注入)。
  function clsBreakdown(shifts) {
    const b = { media: 0, font: 0, dom: 0 };
    for (const s of shifts || []) {
      const k = (s.source || s.kind || '').toLowerCase();
      if (/img|image|embed|iframe|video/.test(k)) b.media += s.value;
      else if (/font|link|style/.test(k)) b.font += s.value;
      else b.dom += s.value;
    }
    return b;
  }
  function cls(ev) {
    const sb = ev.sourceBreakdown || clsBreakdown(ev.shifts || []);
    const total = Math.max(0.0001, sb.media + sb.font + sb.dom);
    const segs = [
      { id: 'media', label: '图片/嵌入无尺寸', value: sb.media, ratio: sb.media / total },
      { id: 'font', label: 'Web Font FOUT', value: sb.font, ratio: sb.font / total },
      { id: 'dom', label: '动态注入 DOM', value: sb.dom, ratio: sb.dom / total },
    ];
    const dom = pickDom(segs);
    const famByDom = { media: ['size_attrs'], font: ['font_display'], dom: ['size_attrs'] };
    return { signal: 'cls', dimension: 'source', dominant: dom, segments: segs, family: famByDom[dom] || [] };
  }

  // ---- 错误:分类(error-diagnose)+ 栈锚点。无"分解",按 class 置信度排序 ----
  function error(ev) {
    const cands = (EDIAG() && EDIAG().analyzeErrorRootCauses(ev)) || [];
    const top = cands[0] || null;
    return {
      signal: 'error', dimension: 'class',
      dominant: top ? top.kind : null,
      segments: cands.slice(0, 4).map((c) => ({ id: c.kind, label: c.kind.replace('error.', ''), value: c.confidence, ratio: c.confidence })),
      family: top ? (top.suggestedHealIds || []) : [],
    };
  }

  function route(signal, ev) {
    if (signal === 'inp') return inp(ev);
    if (signal === 'lcp') return lcp(ev);
    if (signal === 'fcp') return fcp(ev);
    if (signal === 'cls') return cls(ev);
    if (signal === 'error') return error(ev);
    return { signal, dimension: null, dominant: null, segments: [], family: [] };
  }

  global.__localize = { route, inp, lcp, fcp, cls, error, clsBreakdown, pickDom };
})(typeof globalThis !== 'undefined' ? globalThis : self);
