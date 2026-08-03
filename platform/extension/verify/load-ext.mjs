import { chromium } from 'playwright';
// 真实扩展加载诊断(每次改动跑,告别「测了但没测真机」盲区)。headless:false 需要 GUI。
const EXT = '/Users/huabuyu/代码项目/前端AI/smarty-observability-platform/platform/extension';
const swErrors = [];
const ctx = await chromium.launchPersistentContext('/tmp/vc-profile', {
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check'],
  headless: false,
}).catch((e) => { console.log('LAUNCH 失败:', e.message.slice(0, 200)); process.exit(0); });
ctx.on('weberror', (e) => swErrors.push('WEBERR: ' + e.error().message));
await ctx.newPage();
await new Promise((r) => setTimeout(r, 4000));
const sws = ctx.serviceWorkers();
console.log('SW 数:', sws.length);
let sidepanelUrl = null;
if (sws[0]) {
  const bg = await sws[0].evaluate(() => ({ url: chrome.runtime.getURL('sidepanel.html'), ok: typeof latestPayload })).catch((e) => ({ err: e.message }));
  console.log('bg:', JSON.stringify(bg));
  sidepanelUrl = bg && bg.url;
}
if (sidepanelUrl) {
  const sp = await ctx.newPage();
  const errs = [];
  sp.on('pageerror', (e) => errs.push('PAGEERR: ' + e.message + ' @ ' + (e.stack || '').slice(0, 200)));
  sp.on('console', (m) => { if (m.type() === 'error') errs.push('[console.err] ' + m.text()); });
  await sp.goto(sidepanelUrl).catch((e) => errs.push('goto err: ' + e.message));
  await new Promise((r) => setTimeout(r, 2500));
  const info = await sp.evaluate(async () => {
    const D = globalThis.__data;
    let dbOk = '?';
    try {
      await D.putEvent({ eventId: 'r1', type: 'vital', subType: 'inp', value: 600, host: 'a.com', timestamp: Date.now(), inputDelay: 1, processingDuration: 1, presentationLevel: 1, interactionTarget: 'b', origin: 'http://a.com' });
      const all = await D.allEvents();
      dbOk = 'put+getAll=' + all.length;
    } catch (e) { dbOk = 'DBERR: ' + e.message; }
    // dev key 优先级测试
    let devKeyPriority = '?';
    try {
      const L = globalThis.__llm;
      const orig = globalThis.__devLlmKey;
      globalThis.__devLlmKey = { provider: 'x', apiKey: 'test-key', baseUrl: 'http://x', model: 'm' };
      const after = await L.getConfig();
      globalThis.__devLlmKey = orig;
      devKeyPriority = (after && after.apiKey === 'test-key') ? 'dev 优先✓' : 'dev 未优先✗';
    } catch (e) { devKeyPriority = 'err:' + e.message; }
    return {
      rootLen: ((document.getElementById('root') || {}).innerHTML || '').length,
      rootText: ((document.getElementById('root') || {}).innerText || '').slice(0, 150),
      dataLoaded: !!D, schemaLoaded: !!globalThis.__schema, correlateLoaded: !!globalThis.__correlate, llmLoaded: !!globalThis.__llm, shareLoaded: !!globalThis.__share, devLlmKeyLoaded: !!globalThis.__devLlmKey, devKeyPriority, dbOk,
    };
  }).catch((e) => ({ evalErr: e.message }));
  console.log('=== SIDEPANEL 真实渲染 ===');
  console.log(JSON.stringify(info, null, 2));
  console.log('sidepanel errors (' + errs.length + '):');
  errs.slice(0, 12).forEach((e) => console.log('  ' + e));
}
console.log('weberrors:', swErrors.length);
await ctx.close();
