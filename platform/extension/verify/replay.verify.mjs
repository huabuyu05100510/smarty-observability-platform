// replay.verify.mjs · record-replay 引擎验证(Playwright)
// 真实 Chromium:注入 replay.js,合成「button click handler 做 30ms busy」,
// 断言:① startRecord 后 trusted click 能被录到 → record.events 非空;
//      ② 重放同一 record → samples 非空 且 handler 同步耗时被量到(>15ms);
//      ③ DOM 选择器失配 → skip 记录、不造假样本;④ isRecording 状态正确。
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><button id="b">go</button><button id="c">c2</button></body></html>');
  await page.addScriptTag({ path: path.join(EXT, 'replay.js') });

  // 注入 30ms busy 的 click handler(模拟重 handler)
  await page.evaluate(() => {
    document.getElementById('b').addEventListener('click', () => {
      const t = performance.now(); while (performance.now() - t < 30) {}
    });
  });

  const loaded = await page.evaluate(() => !!window.__vcReplay);
  check('replay.js 加载(__vcReplay)', loaded);

  // ① 录制:每次真实点击产生 pointerdown+click 两个 trusted 事件 → 2 次点击 = 4 条
  await page.evaluate(() => window.__vcReplay.startRecord());
  check('startRecord → isRecording=true', await page.evaluate(() => window.__vcReplay.isRecording()) === true);
  await page.click('#b');
  await page.click('#b');
  const record = await page.evaluate(() => window.__vcReplay.stopRecord());
  check('录到 4 条 trusted 事件(pointerdown+click)', record && record.events && record.events.length === 4, 'events=' + (record && record.events && record.events.length));
  check('stopRecord → isRecording=false', await page.evaluate(() => window.__vcReplay.isRecording()) === false);
  check('事件类型含 pointerdown 与 click', ['pointerdown', 'click'].every((t) => record.events.some((e) => e.type === t)), JSON.stringify(record.events.map((e) => e.type)));
  check('所有 selector 解析为 #b', record.events.every((e) => e.selector === '#b'));

  // ② 重放:click handler busy 30ms → 对应 sample >15;pointerdown 无 handler → 接近 0
  const replayed = await page.evaluate((r) => window.__vcReplay.replay(r), record);
  check('重放 samples 数 = 事件数', replayed && replayed.samples.length === 4, 'samples=' + (replayed && replayed.samples.length));
  check('≥2 个 sample >15ms(两个 click handler busy 被量到)', replayed.samples.filter((s) => s > 15).length >= 2, 'samples=' + JSON.stringify(replayed.samples.map((s) => Math.round(s))));
  check('重放 notes 含诚实标注(非 INP 真值)', replayed.notes.some((n) => /非 Event Timing INP 真值/.test(n)));

  // ③ DOM 全失配 → 全 skip、0 样本、不造假
  const bad = JSON.parse(JSON.stringify(record)); bad.events.forEach((e) => { e.selector = '#not-exist'; });
  const r2 = await page.evaluate((rr) => window.__vcReplay.replay(rr), bad);
  check('全失配 → 0 samples + skip notes(不造假)', r2.samples.length === 0 && r2.notes.some((n) => /skip/.test(n)), 'samples=' + r2.samples.length);

  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length} checks) ====`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY ERROR:', e); process.exit(2); });
