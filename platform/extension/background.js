// MV3 service worker（minimal relay + 标签页统计）
const BACKEND = 'http://127.0.0.1:3921';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'GET_BACKEND') {
    sendResponse({ backend: BACKEND });
    return true;
  }
  return false;
});
