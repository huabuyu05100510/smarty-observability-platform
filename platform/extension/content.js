// Content script: 后台自动捕获错误/LoAF（**不开 F12** 就能采），POST 到平台 backend。
// 与 collector 并存：collector 走 SDK 集成（应用主动接入），content script 走浏览器级兜底（任何页面都能采）。
(function () {
  const ENDPOINT = 'http://127.0.0.1:3921/api/events';
  const sessId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const release = 'chrome-ext@0.1.0';

  const send = (events) => {
    if (!events || !events.length) return;
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 不用 keepalive（64KB 限）；content script 生命周期长，普通 fetch 即可
      body: JSON.stringify({ events }),
    }).catch(() => {});
  };

  const toEvent = (id, type, subType, payload) => ({
    id: `ext-${id}-${Math.random().toString(36).slice(2, 6)}`,
    type, subType, timestamp: Date.now(),
    traceId: '', spanId: '',
    sessionId: sessId, release,
    payload, piiSafe: true, sampled: true,
  });

  // JS 错误
  window.addEventListener('error', (e) => {
    if (!e.error && !e.message) return;
    send([toEvent('js', 'error', 'js', {
      message: e.message, stack: e.error?.stack, filename: e.filename, lineno: e.lineno, colno: e.colno,
    })]);
  }, true);

  // Promise rejection
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    send([toEvent('prom', 'error', 'promise', {
      message: reason?.message ?? String(reason), stack: reason?.stack,
    })]);
  });

  // 资源加载错误
  window.addEventListener('error', (e) => {
    const t = e.target;
    if (!t || !t.tagName) return;
    const tag = t.tagName.toLowerCase();
    if (!['img', 'script', 'link', 'iframe'].includes(tag)) return;
    send([toEvent('res', 'error', 'resource', {
      message: `Failed ${tag}: ${t.src || t.href}`, sourceURL: t.src || t.href,
    })]);
  }, true);

  // LoAF / INP（Chrome 123+）
  try {
    const loaf = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < 50) continue;
        send([toEvent('inp', 'vital', 'inp', {
          value: entry.duration, rating: entry.duration > 500 ? 'poor' : entry.duration > 200 ? 'needs-improvement' : 'good',
          longAnimationFrameEntries: [{ id: `loaf-${entry.startTime}`, startTime: entry.startTime, duration: entry.duration, scripts: [] }],
        })]);
      }
    });
    loaf.observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* FF/Safari 无 LoAF */ }
})();
