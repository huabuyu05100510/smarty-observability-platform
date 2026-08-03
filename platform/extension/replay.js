// replay.js · 交互录制/重放(record-replay)——为配对因果设计(P1-8)提供「同一可重复输入」
// ----------------------------------------------------------------------------
// 设计动机:此前的 causal treated 来自「用户继续浏览的不可重复真实流量」,confounder 不可控。
// 录制一段交互序列后,对 patch 前/后「同一序列」重放,采集 handler 同步耗时 → 配对 t 检验,
// 消除「不同交互固有难度差异」这个最大 confounder,让自愈验证可重复、可回归。
//
// ⚠ 诚实边界:合成事件(dispatchEvent)非 trusted input,Event Timing API 不计为 INP 真值。
//   故重放测的是「handler 同步处理耗时代理」,非 INP 真值——与现有「机械类代理≡源码效果」哲学一致。
//   DOM 结构变化会让选择器失配 → 重放 skip 并在 notes 记录,绝不造假样本。
//
// 消息桥接:有 chrome.runtime 时自动注册 onMessage,供 sidepanel 经 background 中转调用
//   (REPLAY_START_RECORD / REPLAY_STOP_RECORD / REPLAY_GET_RECORD / REPLAY_RUN);
//   无 chrome.runtime(如 Playwright 直接注入)则仅挂 window.__vcReplay,可直接调用。
(function () {
  if (window.__vcReplay) return; // 防重复注入
  const REC_TYPES = ['pointerdown', 'click', 'keydown'];
  let recording = false;
  let recEvents = [];
  let recStart = 0;
  let recOrigin = '';

  // 生成尽量稳定的 CSS 选择器:id 唯一优先,否则 nth-of-type 路径(限深 6,防爆)。
  function selectorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) {
      try { if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id); } catch {}
    }
    const parts = [];
    let cur = el, depth = 0;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && depth < 6) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentNode;
      if (parent && parent.children) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      cur = parent; depth++;
    }
    return parts.length ? parts.join(' > ') : null;
  }

  // 构造合成事件(非 trusted;Event Timing 不计入,但能触发 addEventListener 注册的 handler)
  function makeEvent(type) {
    const o = { bubbles: true, cancelable: true, view: window };
    try {
      if (type === 'click' || type === 'mousedown' || type === 'mouseup' || type === 'pointerdown') return new MouseEvent(type, o);
      if (type === 'keydown' || type === 'keyup' || type === 'keypress') return new KeyboardEvent(type, o);
    } catch {}
    return new Event(type, o);
  }

  function onRec(e) {
    if (!recording || !e.isTrusted) return; // 只录真实用户输入(排除合成/重放事件)
    const sel = selectorFor(e.target);
    if (!sel) return;
    // 现场快照点:当时的堆 + DOM 节点数 → 回放/分享时可对比「录制时 vs 重放后」,判断泄漏是否复现
    const m = performance.memory;
    const snap = m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null;
    recEvents.push({ type: e.type, selector: sel, t: Date.now() - recStart, snap: { heap: snap, domCount: document.getElementsByTagName('*').length } });
    if (recEvents.length > 200) recEvents.shift(); // 上限防爆
  }

  function startRecord() {
    if (recording) return { recording: true };
    recording = true; recEvents = []; recStart = Date.now(); recOrigin = location.origin;
    REC_TYPES.forEach((t) => window.addEventListener(t, onRec, true));
    return { recording: true };
  }
  // D1 现场快照:DOM outerHTML(截断)+ 最近资源时序,供「完整现场重建」(他人导入复现)。
  // 网络用 performance.getEntriesByType('resource') —— 浏览器级,isolated world 可读,无需 patch fetch/XHR。
  function snapshotField() {
    let domSnapshot = '';
    try { domSnapshot = (document.documentElement && document.documentElement.outerHTML || '').slice(0, 50000); } catch {}
    let resources = [];
    try { resources = performance.getEntriesByType('resource').slice(-30).map((r) => ({ url: r.name, duration: Math.round(r.duration), type: r.initiatorType })); } catch {}
    return { domSnapshot, resources, domCount: document.getElementsByTagName('*').length };
  }
  function stopRecord() {
    recording = false;
    REC_TYPES.forEach((t) => window.removeEventListener(t, onRec, true));
    const m = performance.memory;
    const snap = snapshotField();
    return { origin: recOrigin, host: location.host, startTime: recStart, duration: Date.now() - recStart, events: recEvents.slice(), meta: { heapEnd: m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize, limit: m.jsHeapSizeLimit } : null, domEnd: snap.domCount, domSnapshot: snap.domSnapshot, resources: snap.resources } };
  }
  function isRecording() { return recording; }
  function getRecord() { return { origin: recOrigin, startTime: recStart, events: recEvents.slice() }; }

  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  // 重放:按录制时的相对时序,对每个选择器重新 dispatchEvent,用 performance.now 量 handler 同步耗时。
  // 返回 { samples:number[], notes:string[], count }。samples = 每次重放的 handler 同步耗时(ms)代理。
  async function replay(record, opts) {
    opts = opts || {};
    const events = ((record && record.events) || []).slice().sort((a, b) => a.t - b.t);
    const samples = [];
    const notes = ['合成事件重放 · handler 同步耗时代理(非 Event Timing INP 真值)'];
    const speed = opts.speed > 0 ? opts.speed : 1;
    const start = Date.now();
    for (const ev of events) {
      const due = start + ev.t / speed;
      await sleep(due - Date.now());
      const el = document.querySelector(ev.selector);
      if (!el) { notes.push('skip · ' + ev.selector + ' 未匹配(DOM 已变?)'); continue; }
      const t0 = performance.now();
      try { el.dispatchEvent(makeEvent(ev.type)); }
      catch (e) { notes.push('err · ' + (e && e.message)); continue; }
      samples.push(performance.now() - t0);
    }
    return { samples, notes, count: events.length };
  }

  window.__vcReplay = { startRecord, stopRecord, isRecording, getRecord, replay };

  // 可选消息桥接(扩展环境)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return false;
      if (msg.type === 'REPLAY_START_RECORD') { sendResponse(startRecord()); return false; }
      if (msg.type === 'REPLAY_STOP_RECORD') { sendResponse(stopRecord()); return false; }
      if (msg.type === 'REPLAY_GET_RECORD') { sendResponse(getRecord()); return false; }
      if (msg.type === 'REPLAY_RUN') { replay(msg.record, msg.opts || {}).then((r) => sendResponse(r)).catch((e) => sendResponse({ error: String(e) })); return true; }
      return false;
    });
  }
})();
