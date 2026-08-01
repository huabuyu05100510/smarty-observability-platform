// Content script: 后台自动捕获 INP/LoAF/错误/Web Vitals，事件发给 **background（扩展 origin）落盘**，
// live 状态通过消息推给 side panel。content script 不再直接写存储——页面 origin 与扩展 origin 的 IndexedDB 不共享。
(function () {
  const sessId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const release = 'chrome-ext@' + (chrome.runtime.getManifest?.().version || '1.0.0');
  const route = location.pathname + location.search;
  const host = location.host || 'unknown';
  const origin = location.origin; // 落进事件,供 sidepanel 归因引擎比对"是否第三方"(不能用扩展自身 location.origin)
  const UA = (navigator && navigator.userAgent) || '';
  const eventId = () => `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 设置（与 sidepanel 共用 'inp_copilot_settings'）。sourceMapAuto 控制是否自动还原源码。
  let settings = { sourceMapAuto: true };
  try { chrome.storage?.local?.get('inp_copilot_settings', (r) => { if (r && r['inp_copilot_settings']) settings = Object.assign(settings, r['inp_copilot_settings']); }); } catch {}

  // 最近交互流（喂实时面板 Stream 卡片）
  const interactions = [];

  // 事件发给 background（扩展 origin IndexedDB + chrome.storage 兜底）
  const sendEvent = (ev) => { try { chrome.runtime.sendMessage({ type: 'EVENT', payload: ev }); } catch (e) { /* background 未就绪 */ } };

  // 从 Error.stack 解析 url:line:col 帧（top N）
  const parseStackFrames = (stack, maxN = 3) => {
    const out = [];
    if (!stack) return out;
    for (const line of String(stack).split('\n')) {
      const m = line.match(/(?:at\s+)?(?:.*?\s+\(?)?(https?:\/\/[^\s)]+):(\d+):(\d+)\)?/);
      if (m) { out.push({ url: m[1], line: +m[2], col: +m[3] }); if (out.length >= maxN) break; }
    }
    return out;
  };
  // sourcemap 还原：dev 自动（//# sourceMappingURL 或 url.map）。跨域/CORS 失败则跳过。
  const resolveFrames = async (frames) => {
    const out = []; const SM = globalThis.__sourcemap; if (!SM) return out;
    for (const f of frames) {
      try {
        if (!f.url || !/^https?:/.test(f.url)) continue;
        const js = await (await fetch(f.url, { credentials: 'omit' })).text();
        let mapUrl = (js.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/) || [])[1];
        if (mapUrl) mapUrl = new URL(mapUrl, f.url).href;
        else mapUrl = f.url.split('?')[0] + '.map';
        const map = await (await fetch(mapUrl, { credentials: 'omit' })).json();
        const c = SM.consumeMap(map);
        const r = c.originalPositionFor({ line: f.line, column: Math.max(0, (f.col || 1) - 1) });
        if (!r.source) continue;
        out.push({ generated: (f.url.split('/').pop() || '').slice(0, 28) + ':' + f.line + ':' + f.col, source: r.source, line: r.line, column: r.column, name: r.name, snippet: c.snippet(r.source, r.line, 2) });
      } catch (e) { /* CORS / 404 / 无 map → 跳过该帧 */ }
    }
    return out;
  };
  // sourcemap 还原(按 LoAF 字符位置):sourceCharPosition → line/col → 源文件:行:列 + snippet
  // 用于把 LoAF 锚点的字符偏移还原成真实源码(INP 根因代码定位)。charPosition 不支持/无 map → null 降级。
  const resolveByCharPos = async (url, charPos) => {
    const SM = globalThis.__sourcemap;
    if (!SM || !url || !/^https?:/.test(url) || charPos == null || charPos < 0) return null;
    try {
      const js = await (await fetch(url, { credentials: 'omit' })).text();
      // charPos(0-based 字符偏移)→ 1-based line / 0-based col
      let line = 1, col = 0; const upto = Math.min(charPos, js.length);
      for (let i = 0; i < upto; i++) { if (js.charCodeAt(i) === 10) { line++; col = 0; } else { col++; } }
      let mapUrl = (js.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/) || [])[1];
      if (mapUrl) mapUrl = new URL(mapUrl, url).href;
      else mapUrl = url.split('?')[0] + '.map';
      const map = await (await fetch(mapUrl, { credentials: 'omit' })).json();
      const c = SM.consumeMap(map);
      const r = c.originalPositionFor({ line, column: Math.max(0, col) });
      if (!r.source) return null;
      return { generated: (url.split('/').pop() || '').slice(0, 28) + ':' + line + ':' + col, source: r.source, line: r.line, column: r.column, name: r.name, snippet: c.snippet(r.source, r.line, 2) };
    } catch (e) { return null; /* CORS / 404 / 无 map / charPosition 不支持 */ }
  };
  // 发事件（即时）；若有栈，异步 sourcemap 还原后用同 eventId 覆盖补 resolvedFrames
  const captureError = (ev, frames) => {
    sendEvent(ev);
    if (frames && frames.length && settings.sourceMapAuto && globalThis.__sourcemap) {
      resolveFrames(frames).then((resolved) => { if (resolved && resolved.length) sendEvent(Object.assign({}, ev, { resolvedFrames: resolved })); }).catch(() => {});
    }
  };

  // 把当前状态推给 side panel（throttle 到 250ms）
  let pendingPayload = null;
  let pushTimer = null;
  const pushToSidePanel = (payload) => {
    pendingPayload = { ...(pendingPayload || {}), ...payload };
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      const p = { ...pendingPayload, route, host, sessionMeta: 'sess ' + sessId.slice(-6) };
      pendingPayload = null;
      pushTimer = null;
      try {
        chrome.runtime.sendMessage({ type: 'INP_UPDATE', payload: p });
      } catch (e) { /* side panel 未开 */ }
    }, 250);
  };

  // LoAF buffer（与 INP 交叉）
  const loafBuffer = [];
  try {
    const loafPo = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // 设置面板「LoAF 阈值」：单帧 duration 低于阈值不入 buffer（默认 50ms，与 LoAF 自带阈值一致）
        if (entry.duration < (settings.loafThresholdMs || 50)) continue;
        loafBuffer.push({
          startTime: entry.startTime,
          duration: entry.duration,
          scripts: (entry.scripts || []).map(s => ({
            sourceURL: s.sourceURL, sourceFunctionName: s.sourceFunctionName,
            invoker: s.invoker, sourceCharPosition: s.sourceCharPosition,
            duration: s.duration,
          })),
        });
        if (loafBuffer.length > 10) loafBuffer.shift();
      }
    });
    loafPo.observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* FF/Safari 无 LoAF */ }

  // INP（event，取最差交互）
  let worstInp = 0;
  let worstEntry = null;
  try {
    const inpPo = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const et = entry;
        const inputDelay = et.processingStart - et.startTime;
        const processingDuration = et.processingEnd - et.processingStart;
        const presentationDelay = et.duration - (et.processingEnd - et.startTime);
        const target = et.target?.tagName?.toLowerCase() || et.name;
        // 交互流：每次交互都记一条（喂面板 Stream 卡片）
        interactions.unshift({
          time: Date.now(),
          type: target,
          value: et.duration,
          state: et.duration > 500 ? '已升级为事件' : et.duration > 200 ? '观察中' : '正常',
        });
        if (interactions.length > 8) interactions.pop();
        if (et.duration > worstInp) {
          worstInp = et.duration;
          worstEntry = et;
          // 交叉时间窗内的 LoAF
          const intersecting = loafBuffer.filter(l =>
            l.startTime <= et.startTime + et.duration && l.startTime + l.duration >= et.startTime
          );
          const eid = eventId();
          const loafScripts = intersecting.flatMap(l => l.scripts);
          const payload = {
            inp: {
              value: et.duration,
              inputDelay, processingDuration, presentationDelay,
              interactionTarget: target,
            },
            loafScripts,
            interactions: interactions.slice(),
          };
          pushToSidePanel(payload);
          // 发给 background 落盘（扩展 origin IndexedDB）
          const inpEv = {
            eventId: eid,
            host, route, origin,
            timestamp: Date.now(),
            sessionId: sessId, release,
            type: 'vital', subType: 'inp',
            value: et.duration,
            inputDelay, processingDuration, presentationDelay,
            interactionTarget: target,
            loafScripts,
          };
          sendEvent(inpEv);
          // INP sourcemap 还原：对首个 LoAF 脚本按字符位置还原源码，异步用同 eventId 覆盖补 resolvedScript
          const lf0 = loafScripts[0];
          if (lf0 && lf0.sourceURL && lf0.sourceCharPosition != null && settings.sourceMapAuto && globalThis.__sourcemap) {
            resolveByCharPos(lf0.sourceURL, lf0.sourceCharPosition)
              .then((resolved) => { if (resolved) sendEvent(Object.assign({}, inpEv, { resolvedScript: resolved })); })
              .catch(() => {});
          }
        } else {
          // 非最差也把最新流推给面板（throttle 合并）
          pushToSidePanel({ interactions: interactions.slice() });
        }
      }
    });
    inpPo.observe({ type: 'event', buffered: true });
  } catch { /* unsupported */ }

  // ===== Web Vitals: FCP / LCP / CLS =====
  const vitals = { fcp: null, lcp: null, lcpElement: null, lcpUrl: null, lcpSize: 0, cls: 0, shifts: [], ttfb: null, domParse: null, resLoad: null, navType: 'navigation' };
  function descEl(el) {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.dataset && el.dataset.testid) s += `[data-testid="${el.dataset.testid}"]`;
    else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s.slice(0, 60);
  }
  function ttfbOf() {
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) return { ttfb: nav.responseStart - nav.requestStart, domParse: nav.domInteractive - nav.responseEnd, navType: nav.type };
    } catch {}
    return null;
  }
  function pushVital(merge) { pushToSidePanel({ vitals: Object.assign({}, vitals, merge || {}) }); }
  function persistVital(subType, value, extra) {
    sendEvent(Object.assign({
      eventId: eventId(), host, route, timestamp: Date.now(), sessionId: sessId, release, ua: UA,
      type: 'vital', subType, value,
    }, extra || {}));
  }
  // FCP
  try {
    const fcpPo = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-contentful-paint' && e.startTime > 0) {
          const t = ttfbOf() || {};
          vitals.fcp = e.startTime; vitals.ttfb = t.ttfb ?? null; vitals.domParse = t.domParse ?? null; vitals.navType = t.navType || 'navigation';
          persistVital('fcp', e.startTime, { ttfb: t.ttfb, domParse: t.domParse, navType: t.navType });
          pushVital();
        }
      }
    });
    fcpPo.observe({ type: 'paint', buffered: true });
  } catch { /* unsupported */ }
  // LCP（持续跟踪最大值，落盘在 pagehide）
  try {
    const lcpPo = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        vitals.lcp = e.startTime; vitals.lcpElement = descEl(e.element); vitals.lcpUrl = e.url || ''; vitals.lcpSize = e.size || 0;
        // 实时 resLoad:资源若尚未加载完 → getEntriesByName 取不到 → null 降级(终值仍由 finalize 落盘)
        if (e.url) { const r = performance.getEntriesByName(e.url).pop(); vitals.resLoad = r ? r.duration : null; }
        pushVital();
      }
    });
    lcpPo.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { /* unsupported */ }
  // CLS（标准 session window：5s 窗口内累加，与上次位移间隔>1s 或窗口超 5s 则开新 session；
  // 取所有 session 的最大累计值，对齐 web-vitals 口径——简单累加会随页面停留单调增长、系统性高估）
  let clsMax = 0, clsCurr = 0, clsPrevTime = -Infinity, clsSessionStart = -Infinity;
  try {
    const clsPo = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        if (e.startTime - clsPrevTime > 1000 || e.startTime - clsSessionStart > 5000) { clsCurr = 0; clsSessionStart = e.startTime; }
        clsPrevTime = e.startTime;
        clsCurr += e.value;
        if (clsCurr > clsMax) clsMax = clsCurr;
        vitals.cls = clsMax;
        const src = (e.sources && e.sources[0]) || {};
        const node = (src.node && descEl(src.node)) || src.nodeName || 'unknown';
        vitals.shifts.unshift({ time: Date.now(), value: e.value, source: node, kind: src.entryType || 'unknown' });
        if (vitals.shifts.length > 10) vitals.shifts.pop();
        pushVital();
      }
    });
    clsPo.observe({ type: 'layout-shift', buffered: true });
  } catch { /* unsupported */ }
  // 页面隐藏时落盘最终 LCP/CLS(每页一次;pagehide 与 visibilitychange 都可能触发 → flag 去重避免重复落盘)
  let finalized = false;
  const finalize = () => {
    if (finalized) return; finalized = true;
    try {
      if (vitals.lcp != null) {
        const t = ttfbOf() || {};
        let resLoad = 0;
        if (vitals.lcpUrl) { const r = performance.getEntriesByName(vitals.lcpUrl).pop(); if (r) resLoad = r.duration; }
        persistVital('lcp', vitals.lcp, { ttfb: t.ttfb ?? vitals.ttfb, resLoad, element: vitals.lcpElement, url: vitals.lcpUrl, navType: t.navType || vitals.navType });
      }
      if (vitals.cls > 0) persistVital('cls', vitals.cls, { shifts: vitals.shifts.slice(0, 8), largest: vitals.shifts.reduce((m, s) => Math.max(m, s.value), 0), element: vitals.shifts[0] && vitals.shifts[0].source });
    } catch {}
  };
  window.addEventListener('pagehide', finalize, { once: true });
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') finalize(); }, { once: true });

  // 错误捕获 → IndexedDB
  // 注意:资源(img/script/link/iframe)加载失败的 ErrorEvent 是 message="" + error=null,
  // 必须先判资源分支,否则会被 `!e.error && !e.message` 守卫提前 return 掉(资源错误永远采不到)。
  const RESOURCE_TAGS = ['img', 'script', 'link', 'iframe'];
  window.addEventListener('error', (e) => {
    const t = e.target;
    const isResource = t && t.tagName && RESOURCE_TAGS.includes(t.tagName.toLowerCase());
    if (!e.error && !e.message && !isResource) return;
    if (isResource) {
      const tag = t.tagName.toLowerCase();
      sendEvent({
        eventId: eventId(), host, route, origin, timestamp: Date.now(),
        sessionId: sessId, release,
        type: 'error', subType: 'resource', ua: UA,
        message: 'Failed ' + tag + ': ' + (t.src || t.href), sourceURL: t.src || t.href,
      });
      return;
    }
    const ev = {
      eventId: eventId(), host, route, origin, timestamp: Date.now(),
      sessionId: sessId, release,
      type: 'error', subType: 'js', ua: UA,
      message: e.message, stack: e.error?.stack, filename: e.filename, lineno: e.lineno, colno: e.colno,
    };
    const frames = e.filename ? [{ url: e.filename, line: e.lineno, col: e.colno }, ...parseStackFrames(e.error && e.error.stack)] : parseStackFrames(e.error && e.error.stack);
    captureError(ev, frames);
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    captureError({
      eventId: eventId(), host, route, timestamp: Date.now(),
      sessionId: sessId, release,
      type: 'error', subType: 'promise', ua: UA,
      message: r?.message ?? String(r), stack: r?.stack,
    }, parseStackFrames(r && r.stack));
  });
})();