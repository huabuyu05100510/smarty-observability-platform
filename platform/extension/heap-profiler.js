// heap-profiler.js · 扩展侧 chrome.debugger + CDP 内存深度检测(sidepanel)
// ----------------------------------------------------------------------------
// 把内存链路从「advisory 趋势推断」升级到「精确计数 + 堆快照 diff」:
//   L1 getMetrics():CDP Performance.getMetrics → Nodes/JSEventListeners/JSHeap 精确计数
//       (Nodes 含 detached DOM、JSEventListeners 是监听器总数 —— performance.memory 拿不到,泄漏直接信号)
//   L2 takeDiffSnapshot():CDP HeapProfiler startTracking/stopTracking → addHeapSnapshotChunk 事件流
//       → heap-snapshot.js parse + diff → 泄漏对象类型 top N(selfSizeDelta)
//
// 代价:chrome.debugger attach 时浏览器顶部显示「Vitals Copilot 正在调试此标签页」提示条(CDP 强制)。
// 故仅用户点「深度分析」才 attach;日常 advisory 趋势(content.js performance.memory)不 attach、无提示。
//
// 消息流:sidepanel → background(HEAP_ATTACH/DETACH/CDP) → chrome.debugger;CDP 事件(background onEvent)
// → HEAP_CDP_EVENT → sidepanel 监听收集(chunk 流)。
(function (global) {
  const HS = () => global.__heapSnapshot;
  let attached = false;

  const cdp = (method, params) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: 'HEAP_CDP', method, params: params || {} }, (r) => resolve(r || { error: 'no resp' })); }
    catch (e) { resolve({ error: String(e) }); }
  });
  function attach() {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage({ type: 'HEAP_ATTACH' }, (r) => { attached = !!(r && r.ok); resolve(r || { error: 'no resp' }); }); }
      catch (e) { resolve({ error: String(e) }); }
    });
  }
  function detach() {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage({ type: 'HEAP_DETACH' }, (r) => { attached = false; resolve(r || { ok: true }); }); }
      catch { attached = false; resolve({ ok: true }); }
    });
  }

  // L1 精确计数(advisory 拿不到的 detached DOM/监听器精确值)
  async function getMetrics() {
    if (!attached) return { error: '未 attach(点「深度分析」启用 chrome.debugger)' };
    await cdp('Performance.enable');
    const r = await cdp('Performance.getMetrics');
    if (!r || !r.ok || !r.result) return { error: (r && r.error) || 'getMetrics 失败' };
    const m = {};
    (r.result.metrics || []).forEach((x) => { m[x.name] = x.value; });
    return { nodes: m.Nodes, listeners: m.JSEventListeners, heapUsed: m.JSHeapUsedSize, heapTotal: m.JSHeapTotalSize, raw: m };
  }

  // L2 收集一次完整快照(监听 HEAP_CDP_EVENT chunk 流;startTracking+stopTracking 停止时发送)
  function _collectSnapshot(timeoutMs) {
    return new Promise((resolve) => {
      let json = '';
      let done = false;
      const finish = () => { if (done) return; done = true; try { chrome.runtime.onMessage.removeListener(onEvt); } catch {} resolve(json); };
      const onEvt = (msg) => {
        if (!msg || msg.type !== 'HEAP_CDP_EVENT') return;
        if (msg.method === 'HeapProfiler.addHeapSnapshotChunk' && msg.params && msg.params.chunk) json += msg.params.chunk;
        if (msg.method === 'HeapProfiler.reportHeapSnapshotProgress' && msg.params && msg.params.finished) finish();
      };
      chrome.runtime.onMessage.addListener(onEvt);
      cdp('HeapProfiler.enable')
        .then(() => cdp('HeapProfiler.startTrackingHeapObjects', { trackAllocations: false }))
        .then(() => cdp('HeapProfiler.stopTrackingHeapObjects', { reportProgress: true }))
        .catch(() => {});
      setTimeout(finish, timeoutMs || 8000); // 兜底(快照大/事件未通)
    });
  }

  // L2 两次快照 diff:基线 → (opts.between 用户操作) → GC → 二次 → diff
  // 返回 { topLeaks, totalLeak, baselineBytes, afterBytes, error? }。事件流不通(如 headless)→ error,真机 chrome.debugger 待验。
  async function takeDiffSnapshot(opts) {
    if (!attached) return { error: '未 attach' };
    const H = HS();
    if (!H) return { error: 'heap-snapshot.js 未加载' };
    const json1 = await _collectSnapshot(opts && opts.timeoutMs);
    if (!json1) return { error: '基线快照为空(CDP 事件流未通,真机 chrome.debugger 待验)' };
    const agg1 = H.aggregateByType(H.parse(json1));
    if (opts && typeof opts.between === 'function') { try { await opts.between(); } catch {} }
    await cdp('HeapProfiler.collectGarbage');
    const json2 = await _collectSnapshot(opts && opts.timeoutMs);
    if (!json2) return { error: '二次快照为空', baselineBytes: json1.length };
    const agg2 = H.aggregateByType(H.parse(json2));
    const top = H.topLeaks(agg1, agg2, (opts && opts.topN) || 10);
    const totalLeak = top.reduce((s, l) => s + l.selfSizeDelta, 0);
    return { topLeaks: top, totalLeak, baselineBytes: json1.length, afterBytes: json2.length };
  }

  global.__heapProfiler = { attach, detach, isAttached: () => attached, getMetrics, takeDiffSnapshot, _collectSnapshot };
})(typeof globalThis !== 'undefined' ? globalThis : self);
