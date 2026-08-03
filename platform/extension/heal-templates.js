// heal-templates.js · 模板化白名单自愈（不能 eval 动态代码，每个模板是预编译函数）
// 适用场景: 开发阶段一键试不同修复，看 INP 是否下降（不连真 patch-registry，零后端）
(function (global) {
  const HEAL_STORE = new Map(); // token -> rollback fn

  // === 模板 1: debounce_handler ===
  // 给 listener 加 debounce。默认仅 click —— 对 input/keydown/keyup 全局加 debounce 会明显破坏表单输入/输入法,
  // 需显式 opts.types 开启(如 heal-templates apply({types:['input','keydown']}))。
  function debounceHandlerTemplate(opts = {}) {
    const delay = opts.delay || 300;
    const types = (Array.isArray(opts.types) && opts.types.length) ? opts.types : ['click'];
    const origAdd = EventTarget.prototype.addEventListener;
    if (window.__inpHealDebounced) return { ok: false, reason: 'already applied' };
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (types.includes(type) && typeof listener === 'function') {
        let timer;
        const debounced = function (e) {
          clearTimeout(timer);
          timer = setTimeout(() => listener.apply(this, arguments), delay);
        };
        return origAdd.call(this, type, debounced, options);
      }
      return origAdd.call(this, type, listener, options);
    };
    window.__inpHealDebounced = true;
    const token = 'heal-debounce-' + Date.now();
    // rollback 仅恢复原型方法 → 之后新 addEventListener 走原方法；
    // 已注册的 debounced wrapper 仍挂在各 listener 上（无法批量还原），随元素销毁/页面刷新清除。
    HEAL_STORE.set(token, () => {
      EventTarget.prototype.addEventListener = origAdd;
      delete window.__inpHealDebounced;
    });
    // 诚实局限:prototype patch 只包装 apply 之后「新注册」的 listener;页面加载时已绑定的 handler 不会被重包
    // (要重包需 removeEventListener+重新 add,这里拿不到原 fn/options/capture)。多数页面 handler 在 init 期就绑完 →
    // 对当前页面即时效果有限,treated 常与 baseline 接近。真修需应用源码 diff(见「AI 真自愈」)。
    return { ok: true, token, summary: `${types.join('/')} listener 加 ${delay}ms debounce${types.length === 1 ? '(默认仅 click;打字类事件需显式开启)' : ''} · ⚠仅对 apply 后新增 listener 生效,已注册 handler 不重绑` };
  }

  // === 模板 2: throttle_third_party ===
  // 拦截跨域 script 标签加载，加 async（释放主线程）。
  // 注意：async 与 defer 互斥，设 async 后 defer 被浏览器忽略，故仅设 async（不写 defer）。
  // 同时覆盖 head 与 body 的 appendChild，避免 body 插入的第三方脚本漏网。
  function throttleThirdPartyTemplate() {
    const mark = (node) => {
      if (node && node.tagName === 'SCRIPT' && node.src && !node.src.startsWith(location.origin)) {
        node.async = true;
        node.setAttribute('data-inp-healed', 'third-party-throttle');
      }
    };
    const origHead = HTMLHeadElement.prototype.appendChild;
    const origBody = HTMLBodyElement.prototype.appendChild;
    HTMLHeadElement.prototype.appendChild = function (node) { mark(node); return origHead.call(this, node); };
    HTMLBodyElement.prototype.appendChild = function (node) { mark(node); return origBody.call(this, node); };
    const token = 'heal-3p-' + Date.now();
    HEAL_STORE.set(token, () => { HTMLHeadElement.prototype.appendChild = origHead; HTMLBodyElement.prototype.appendChild = origBody; });
    return { ok: true, token, summary: '已启用:对未来新插入 head/body 的跨域 script 加 async(已有脚本不受影响)' };
  }

  // === 模板 3: lazy_load ===
  // 给非首屏、未设 loading 的 img/iframe 加 loading=lazy + decoding=async。
  // 重要：首屏/above-the-fold 图片（尤其 LCP 元素）加 lazy 会推迟加载、损害 LCP → 必须排除；
  //       带 fetchpriority="high" 的也跳过（应用已显式标高优先级）。
  const isAboveFold = (el) => {
    try { return el.getBoundingClientRect().top < (window.innerHeight || document.documentElement.clientHeight); } catch { return false; }
  };
  const lazyable = (el) => !!el && !el.hasAttribute('loading')
    && el.getAttribute('fetchpriority') !== 'high'
    && !isAboveFold(el);
  function lazyLoadTemplate() {
    let count = 0;
    document.querySelectorAll('img:not([loading]), iframe:not([loading])').forEach((el) => {
      if (!lazyable(el)) return;
      el.loading = 'lazy';
      el.decoding = 'async';
      el.setAttribute('data-inp-healed', 'lazy-load');
      count++;
    });
    // 监听后续 DOM 变化（仅非首屏）
    const obs = new MutationObserver((muts) => {
      muts.forEach((m) => m.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        if ((n.tagName === 'IMG' || n.tagName === 'IFRAME') && lazyable(n)) {
          n.loading = 'lazy'; n.decoding = 'async'; n.setAttribute('data-inp-healed', 'lazy-load'); count++;
        }
      }));
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const token = 'heal-lazy-' + Date.now();
    HEAL_STORE.set(token, () => obs.disconnect());
    return { ok: true, token, summary: `已给 ${count} 个非首屏 img/iframe 加 loading=lazy（首屏/LCP 图已排除）` };
  }

  // === 模板 4: memo_wrap（仅给提示，不真注入 React.memo）===
  function memoWrapTemplate() {
    console.info('[INP Copilot] memo_wrap hint: 在你怀疑的组件外加 React.memo(Component) 或 export default React.memo(Component)');
    return { ok: true, token: 'heal-memo-hint-' + Date.now(), summary: '已 console.info 提示，检查 DevTools console' };
  }

  // === 模板 5: inject_cleanup（轻量版 - 全局错误吞掉，由 content script 卸载事件）===
  function injectCleanupTemplate() {
    console.info('[INP Copilot] inject_cleanup hint: 在 useEffect 里 return () => { removeEventListener/clearTimeout/subscription.unsubscribe() }');
    return { ok: true, token: 'heal-cleanup-hint-' + Date.now(), summary: '已 console.info 提示，检查 DevTools console' };
  }

  // 入口
  global.__inpHeal = {
    apply: (templateId, opts) => {
      switch (templateId) {
        case 'debounce_handler': return debounceHandlerTemplate(opts);
        case 'throttle_third_party': return throttleThirdPartyTemplate();
        case 'lazy_load': return lazyLoadTemplate();
        case 'memo_wrap': return memoWrapTemplate();
        case 'inject_cleanup': return injectCleanupTemplate();
        default: return { ok: false, reason: 'unknown template: ' + templateId };
      }
    },
    rollback: (token) => {
      const fn = HEAL_STORE.get(token);
      if (fn) { fn(); HEAL_STORE.delete(token); return { ok: true }; }
      return { ok: false, reason: 'token not found' };
    },
    list: () => [
      { id: 'debounce_handler', label: 'Handler 防抖', desc: 'click 默认加 300ms debounce(仅对 apply 后新增 listener;已注册 handler 不重绑 → 真修见 AI 真自愈)', hint: '适合: processing 重' },
      { id: 'throttle_third_party', label: '第三方脚本节流', desc: '跨域 script 加 async', hint: '适合: inputDelay 长 + 第三方嫌疑' },
      { id: 'lazy_load', label: '图片/iframe 懒加载', desc: '非首屏元素补 lazy(首屏/LCP 图排除)', hint: '适合: 非首屏图片/CLS 优化' },
      { id: 'memo_wrap', label: 'Memo 提示', desc: 'console.info 提示手动包 React.memo', hint: '适合: presentation 抖动' },
      { id: 'inject_cleanup', label: 'Cleanup 提示', desc: 'console.info 提示补 useEffect cleanup', hint: '适合: 长任务/泄漏嫌疑' },
    ],
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);