// MV3 service worker：消息中转 + latest live 缓存 + self-test + 自愈调度 + 事件缓冲。
// 数据归属：扩展 origin。事件由 background 缓冲（chrome.storage，抗 SW 终止）+ 转发 sidepanel；
// sidepanel（持久页面）负责写入扩展 origin IndexedDB。开屏时 sidepanel 先 flush 缓冲。
let latestPayload = { inp: null, loafScripts: [], interactions: [], vitals: null, route: '' };
const BUFFER_KEY = 'eventBuffer';
const BUFFER_CAP = 500;

// manifest 同时声明了 side_panel.default_path —— 此时点 action 图标默认打开 side panel（openPanelOnActionClick=true），
// 会拦截 chrome.action.onClicked（overlay toggle 不触发）。显式关闭默认行为，让 onClicked 接管 → 点图标 toggle 浮层。
// 仍保留 sidePanel 声明供偏好原生侧栏的用户从菜单打开。
try { chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }); } catch { /* 旧版无 setPanelBehavior */ }

// 点图标 toggle 页面内悬浮 overlay（content script 注入的 fixed 浮层，压在页面之上）。
chrome.action?.onClicked?.addListener(async (tab) => {
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = (t && t.id) || (tab && tab.id);
    if (tabId != null) { chrome.tabs.sendMessage(tabId, { type: 'TOGGLE_OVERLAY' }).catch(() => {}); return; }
  } catch { /* ignore */ }
});

// 事件缓冲（durable，抗 SW 终止）。sidepanel 关闭时累积，打开时 flush 进 IndexedDB。
// 串行化:get→push→set 跨 await,若并发调用会读到同一快照互相覆盖丢事件 → 单飞 promise 链排队。
let bufferQueue = Promise.resolve();
function bufferEvent(ev) {
  bufferQueue = bufferQueue.then(async () => {
    try {
      const { [BUFFER_KEY]: buf = [] } = await chrome.storage.local.get(BUFFER_KEY);
      buf.push(ev);
      if (buf.length > BUFFER_CAP) buf.splice(0, buf.length - BUFFER_CAP);
      await chrome.storage.local.set({ [BUFFER_KEY]: buf });
    } catch (e) { /* storage 不可用 */ }
  }).catch(() => {});
  return bufferQueue;
}

// 自愈自动回滚:chrome.alarms 调度(抗 SW 终止)。token 作 alarm 名,到点对 apply 时的 tab rollback;
// 若页面已卸载/导航,patch 随之自然失效,rollback 失败忽略。
const PENDING_KEY = 'pendingRollbacks';
async function setPendingRollback(token, info) {
  try { const { [PENDING_KEY]: m = {} } = await chrome.storage.local.get(PENDING_KEY); m[token] = info; await chrome.storage.local.set({ [PENDING_KEY]: m }); } catch {}
}
async function getPendingRollback(token) {
  try { const { [PENDING_KEY]: m = {} } = await chrome.storage.local.get(PENDING_KEY); return m[token]; } catch { return null; }
}
async function delPendingRollback(token) {
  try { const { [PENDING_KEY]: m = {} } = await chrome.storage.local.get(PENDING_KEY); if (m[token]) { delete m[token]; await chrome.storage.local.set({ [PENDING_KEY]: m }); } } catch {}
}
chrome.alarms?.onAlarm?.addListener(async (alarm) => {
  const token = alarm && alarm.name;
  if (!token || !token.startsWith('heal-')) return;
  const info = await getPendingRollback(token);
  if (info && info.tabId != null) {
    try { await chrome.scripting.executeScript({ target: { tabId: info.tabId, allFrames: false }, func: (t) => globalThis.__inpHeal?.rollback(t), args: [token], world: 'MAIN' }); }
    catch (e) { /* tab 已关闭/导航 → patch 随页面卸载自然失效 */ }
  }
  await delPendingRollback(token);
  chrome.runtime.sendMessage({ type: 'HEAL_AUTO_ROLLED_BACK', token }).catch(() => {});
});

const SELF_TEST_FUNC = () => {
  // 在目标 tab 的 MAIN world 跑：合成 60ms 长帧，等一拍，查 LoAF observer 是否采到
  return new Promise((resolve) => {
    let captured = null; let po;
    try {
      po = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!captured) captured = {
            duration: entry.duration, startTime: entry.startTime,
            scripts: (entry.scripts || []).map((s) => ({ sourceURL: s.sourceURL, sourceFunctionName: s.sourceFunctionName, invoker: s.invoker, duration: s.duration })),
          };
        }
      });
      po.observe({ type: 'long-animation-frame', buffered: false });
    } catch (e) { resolve({ ok: false, reason: 'PerformanceObserver(long-animation-frame) unsupported', captured: null }); return; }
    const t0 = performance.now();
    while (performance.now() - t0 < 60) { /* block */ }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { po.disconnect(); } catch {}
      if (!captured) resolve({ ok: false, reason: 'No long-animation-frame captured (>50ms threshold not met?)', captured: null });
      else {
        const f = captured.scripts[0] || {};
        resolve({ ok: true, reason: 'OK', captured: { frameDuration: captured.duration, scriptCount: captured.scripts.length, sampleSourceURL: f.sourceURL, sampleSourceFunctionName: f.sourceFunctionName, sampleInvoker: f.invoker } });
      }
    }));
  });
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // content → 这里：仅更新 latestPayload 缓存(供 sidepanel 开屏 GET_LATEST)。
  // 不再转发:content 的 runtime.sendMessage 已直达 sidepanel/overlay,转发会造成重复投递。
  if (msg?.type === 'INP_UPDATE') {
    latestPayload = Object.assign({}, latestPayload, msg.payload || {});
    return false;
  }
  // content → 这里：捕获事件 → 缓冲 + 转发 sidepanel（持久页面写 IndexedDB）
  if (msg?.type === 'EVENT') {
    bufferEvent(msg.payload);
    chrome.runtime.sendMessage({ type: 'EVENT_RELAY', payload: msg.payload }).catch(() => {});
    return false;
  }
  if (msg?.type === 'GET_LATEST') { sendResponse({ payload: latestPayload }); return true; }
  // sidepanel 开屏：取走缓冲，清空（由 sidepanel 写入 IndexedDB）
  if (msg?.type === 'FLUSH_BUFFER') {
    (async () => {
      try {
        const { [BUFFER_KEY]: buf = [] } = await chrome.storage.local.get(BUFFER_KEY);
        if (buf.length) await chrome.storage.local.set({ [BUFFER_KEY]: [] });
        sendResponse({ events: buf });
      } catch (e) { sendResponse({ events: [] }); }
    })();
    return true;
  }
  if (msg?.type === 'RUN_SELF_TEST') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ ok: false, reason: 'no active tab' }); return; }
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: SELF_TEST_FUNC, world: 'MAIN' });
        sendResponse(result);
      } catch (e) { sendResponse({ ok: false, reason: 'executeScript failed: ' + (e?.message || String(e)) }); }
    })();
    return true;
  }
  // 自愈:在页面 MAIN world 跑(prototype patch 才真正生效)
  if (msg?.type === 'APPLY_HEAL') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ ok: false, reason: 'no active tab' }); return; }
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: (templateId, opts) => globalThis.__inpHeal?.apply(templateId, opts), args: [msg.templateId, msg.opts || {}], world: 'MAIN' });
        // 调度自动回滚(chrome.alarms,抗 SW 终止;到点对 apply 时的 tab rollback)
        if (result && result.ok && result.token) {
          const min = (msg.opts && Number(msg.opts.rollbackMin)) || 30;
          try { await chrome.alarms.create(result.token, { delayInMinutes: Math.max(1, min) }); await setPendingRollback(result.token, { tabId: tab.id, templateId: msg.templateId }); } catch {}
        }
        sendResponse(result);
      } catch (e) { sendResponse({ ok: false, reason: 'executeScript failed: ' + (e?.message || String(e)) }); }
    })();
    return true;
  }
  if (msg?.type === 'ROLLBACK_HEAL') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id) { sendResponse({ ok: false, reason: 'no active tab' }); return; }
        const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, func: (token) => globalThis.__inpHeal?.rollback(token), args: [msg.token], world: 'MAIN' });
        try { await chrome.alarms.clear(msg.token); await delPendingRollback(msg.token); } catch {}
        sendResponse(result);
      } catch (e) { sendResponse({ ok: false, reason: 'executeScript failed: ' + (e?.message || String(e)) }); }
    })();
    return true;
  }
  return false;
});
