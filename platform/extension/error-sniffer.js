// error-sniffer.js · MAIN world 错误嗅探器
// content script 跑在 isolated world,直接 addEventListener('error') 收不到页面 main world 抛的
// JS 错误,且 event.error 跨 world 为 null(拿不到堆栈)——见 Chromium #41157066。
// 故本文件在 MAIN world(document_start)注册 error/unhandledrejection,拿到真实 error.stack,
// 经 window.postMessage 回传给 content.js(isolated)→ 走原 sendEvent 链路。
// (INP/LCP/CLS 不受此限:它们走 PerformanceObserver,浏览器级 API 跨 world 正常。)
(function () {
  if (window.__vcErrSniffer) return; // 防重复注入
  window.__vcErrSniffer = true;

  const RESOURCE_TAGS = ['img', 'script', 'link', 'iframe'];
  // targetOrigin 锁页面自身 origin:同源投递,避免跨 origin 泄漏;接收方 content.js 与页面同源。
  const post = (payload) => { try { window.postMessage({ __vc: 'err', payload }, location.origin); } catch {} };

  window.addEventListener('error', (e) => {
    // 资源错误(img/script/link/iframe 加载失败):ErrorEvent 是 message="" + error=null,
    // 事件目标是被加载的元素 → 必须在 window 捕获阶段拿 e.target,先判资源分支。
    const t = e.target;
    const isResource = t && t.tagName && RESOURCE_TAGS.includes(t.tagName.toLowerCase());
    if (isResource) {
      const tag = t.tagName.toLowerCase();
      post({ subType: 'resource', message: 'Failed ' + tag + ': ' + (t.src || t.href), sourceURL: t.src || t.href, time: Date.now() });
      return;
    }
    if (!e.error && !e.message) return;
    // MAIN world:e.error 是真实 Error 对象,e.error.stack 可用(isolated world 拿不到)。
    post({
      subType: 'js',
      message: e.message,
      stack: e.error && e.error.stack,
      filename: e.filename, lineno: e.lineno, colno: e.colno,
      time: Date.now(),
    });
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    post({
      subType: 'promise',
      message: (r && r.message) ? r.message : String(r),
      stack: r && r.stack,
      time: Date.now(),
    });
  });
})();
