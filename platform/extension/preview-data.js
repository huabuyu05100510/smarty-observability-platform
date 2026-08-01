// preview-data.js · 仅用于 preview.html：注入内存样本数据 + chrome 桩，让 8 屏全部有内容。
// 不参与扩展正式加载（manifest 不引用）。
(function (global) {
  const now = Date.now();
  const host = 'shop.example.com', route = '/checkout/cart', release = 'v2.4.1', sess = 'ext-9c12-8f3a';
  const eid = (i) => 'evt_' + (0xb911b + i).toString(16);
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  const stack = "TypeError: Cannot read properties of undefined (reading 'price')\n    at recalcCart (https://shop.example.com/assets/cart-C4f9a.js:47:12)\n    at CartView (https://shop.example.com/assets/cart-C4f9a.js:118:4)\n    at render (https://shop.example.com/assets/app-2d1.js:23:8)";
  const events = [];
  const push = (o) => events.push(Object.assign({ eventId: eid(events.length + 1), timestamp: now - Math.floor(Math.random() * 28 * 60000), sessionId: sess, release, host, route, ua }, o));

  // INP 样本（最近 5min 多发，含一次 612ms 峰值）
  const inpPoints = [612, 588, 531, 244, 412, 188, 612, 503, 271, 144, 588, 360, 209, 122, 644];
  for (let i = 0; i < 60; i++) {
    const v = inpPoints[i % inpPoints.length] + Math.floor(Math.random() * 60) - 30;
    const inputDelay = Math.round(v * 0.12), processing = Math.round(v * 0.78), presentation = Math.max(8, v - inputDelay - processing);
    push({ type: 'vital', subType: 'inp', value: v, inputDelay, processingDuration: processing, presentationDelay: presentation,
      interactionTarget: i % 3 === 0 ? 'button.checkout-cta' : i % 3 === 1 ? 'input.search' : 'button.update-cart',
      loafScripts: v > 400 ? [{ sourceURL: 'https://shop.example.com/assets/cart-C4f9a.js', sourceFunctionName: 'recalcCart', invoker: 'BUTTON.click', duration: Math.round(v * 0.7) }] : [] });
  }
  // 错误样本
  for (let i = 0; i < 38; i++) push({ type: 'error', subType: 'js', message: "Cannot read properties of undefined (reading 'price')", stack, filename: 'https://shop.example.com/assets/cart-C4f9a.js', lineno: 47, colno: 12 });
  for (let i = 0; i < 17; i++) push({ type: 'error', subType: 'js', message: 'ReferenceError: $coupon_evaluator is not defined', stack: '    at eval (https://shop.example.com/assets/checkout-7a4.js:91:3)\n    at https://shop.example.com/assets/checkout-7a4.js:12:2', filename: 'https://shop.example.com/assets/checkout-7a4.js', lineno: 91, colno: 3 });
  for (let i = 0; i < 14; i++) push({ type: 'error', subType: 'promise', message: 'Uncaught promise timeout 4s · /api/cart/sync', stack: '    at https://shop.example.com/assets/api-b21.js:9:2' });
  for (let i = 0; i < 12; i++) push({ type: 'error', subType: 'resource', message: 'Failed script: https://shop.example.com/assets/cart.7a4.chunk.js', sourceURL: 'https://shop.example.com/assets/cart.7a4.chunk.js' });
  for (let i = 0; i < 9; i++) push({ type: 'error', subType: 'js', message: "Cannot read properties of null (reading 'toFixed')", stack, filename: 'https://shop.example.com/assets/cart-C4f9a.js', lineno: 47, colno: 18 });

  // LCP 样本（~4.2s poor，带 ttfb/资源加载/element）
  const lcpPts = [4200, 4600, 3800, 2900, 4100, 5200, 2400, 4400, 3100];
  for (let i = 0; i < 40; i++) push({ type: 'vital', subType: 'lcp', value: lcpPts[i % lcpPts.length] + Math.floor(Math.random() * 500 - 250), ttfb: 900, resLoad: 2400, element: 'img.pdp-hero[data-testid="heritage-denim"]', url: 'https://shop.example.com/assets/hero-denim.webp', navType: ['navigation', 'reload', 'back-fwd'][i % 3] });
  // FCP 样本（~3.4s poor）
  const fcpPts = [3400, 3800, 2100, 2900, 3600, 4200, 1800];
  for (let i = 0; i < 40; i++) push({ type: 'vital', subType: 'fcp', value: fcpPts[i % fcpPts.length] + Math.floor(Math.random() * 400 - 200), ttfb: 1300, domParse: 600, navType: ['navigation', 'reload', 'prerender'][i % 3] });
  // CLS 样本（~0.28 poor，带 shifts）
  const shifts = [{ value: 0.10, source: 'img.feed-hero[data-testid="media"]', kind: 'image' }, { value: 0.06, source: 'link.font.inter', kind: 'font' }, { value: 0.04, source: 'div#banner-ad', kind: 'dom' }, { value: 0.08, source: 'iframe.embed', kind: 'embed' }];
  for (let i = 0; i < 40; i++) push({ type: 'vital', subType: 'cls', value: 0.18 + Math.random() * 0.18, shifts: shifts.slice(0, 2 + (i % 3)), largest: 0.10, element: 'img.feed-hero[data-testid="media"]' });

  const store = { events };
  global.__inpDb = {
    STORES: ['events', 'attributions', 'heals', 'mrs'],
    put: async (s, r) => { (store[s] = store[s] || []).push(r); },
    getAll: async (s) => store[s] || [],
    count: async (s) => (store[s] || []).length,
    clear: async (s) => { store[s] = []; },
  };

  const LIVE = {
    inp: { value: 612, inputDelay: 48, processingDuration: 531, presentationDelay: 33, interactionTarget: 'button.checkout-cta[data-testid="submit-order"]' },
    loafScripts: [{ sourceURL: 'https://shop.example.com/assets/cart-C4f9a.js', sourceFunctionName: 'recalcCart', invoker: 'BUTTON.click', duration: 438 }],
    interactions: [
      { time: now - 1000, type: 'pointerdown', value: 612, state: '已升级为事件' },
      { time: now - 3200, type: 'keydown', value: 244, state: '观察中' },
      { time: now - 5400, type: 'pointerdown', value: 588, state: '已升级为事件' },
      { time: now - 12000, type: 'click', value: 118, state: '正常' },
      { time: now - 19000, type: 'pointerdown', value: 596, state: '已升级为事件' },
    ],
    vitals: {
      fcp: 3400, lcp: 4200, cls: 0.28, ttfb: 1300, navType: 'navigation',
      lcpElement: 'img.pdp-hero[data-testid="heritage-denim"]', lcpUrl: 'https://shop.example.com/assets/hero-denim.webp',
      shifts: [
        { time: now - 1500, value: 0.10, source: 'img.feed-hero', kind: 'image' },
        { time: now - 4000, value: 0.04, source: 'link.font.inter', kind: 'font' },
        { time: now - 7000, value: 0.08, source: 'iframe.embed', kind: 'embed' },
        { time: now - 15000, value: 0.01, source: 'div#banner', kind: 'dom' },
        { time: now - 22000, value: 0.05, source: 'img.feed-card', kind: 'image' },
      ],
    },
    route, host, sessionMeta: 'sess 9c12·8f · 5m41s',
  };

  global.chrome = {
    runtime: {
      onMessage: { _h: [], addListener(h) { this._h.push(h); }, removeListener(h) { this._h = this._h.filter((x) => x !== h); }, hasListeners() { return true; } },
      sendMessage(msg, cb) {
        const r = msg && msg.type === 'GET_LATEST' ? { payload: LIVE }
          : msg && msg.type === 'APPLY_HEAL' ? { ok: true, token: 'preview-' + Date.now(), summary: 'preview 注入（未真正执行）' }
          : msg && msg.type === 'ROLLBACK_HEAL' ? { ok: true } : {};
        cb && cb(r);
      },
    },
    storage: { local: { get: (k, cb) => cb && cb({}), set: () => {} } },
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
