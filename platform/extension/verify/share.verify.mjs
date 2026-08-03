// share.verify.mjs · 分享重现 round-trip 测试(纯 Node)
// 编码(链接 base64 + .vc-repro 文件) → 解码 → 还原;中文 UTF-8 / 非法输入 / 端到端 buildScene+importScene。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
vm.runInThisContext(readFileSync(path.join(EXT, 'share.js'), 'utf8'));
vm.runInThisContext(readFileSync(path.join(EXT, 'db.js'), 'utf8'));
vm.runInThisContext(readFileSync(path.join(EXT, 'diagnose.js'), 'utf8'));
vm.runInThisContext(readFileSync(path.join(EXT, 'error-diagnose.js'), 'utf8'));
vm.runInThisContext(readFileSync(path.join(EXT, 'data.js'), 'utf8'));

let store = {};
globalThis.__inpDb = { put: async (k, r) => { store[k] = store[k] || []; store[k].push(r); }, getAll: async (k) => store[k] || [] };
const S = globalThis.__share, D = globalThis.__data;
const results = [];
const check = (n, c, d) => { results.push({ name: n, pass: !!c }); console.log(`${c ? '✓ PASS' : '✗ FAIL'}: ${n}${d ? ' — ' + d : ''}`); };

// ===== 编解码 round-trip =====
const scene = { host: 'a.com', route: '/x', rootCause: { signal: 'inp', verdict: { body: '堆泄漏嫌疑' } }, events: [{ type: 'vital', subType: 'inp', value: 600, timestamp: 1, eventId: 'e1' }], sessions: [{ startTime: 1, events: [{ type: 'click', t: 0 }] }] };
const enc = S.encodeScene(scene);
check('encodeScene 产出 link + file', !!enc.link && !!enc.file);
check('链接 round-trip 还原 rootCause', S.decodeLink(enc.link).rootCause.signal === 'inp');
check('链接 round-trip 中文 UTF-8 不乱码', S.decodeLink(enc.link).rootCause.verdict.body === '堆泄漏嫌疑', S.decodeLink(enc.link).rootCause.verdict.body);
check('链接 round-trip events/sessions', S.decodeLink(enc.link).events.length === 1 && S.decodeLink(enc.link).sessions.length === 1);
check('文件 round-trip kind=vc-repro', S.decodeFile(enc.file).kind === 'vc-repro');
check('链接 hasHeap=false(核心不含堆)', S.decodeLink(enc.link).hasHeap === false);
check('非法输入 → null', S.decodeLink('garbage') === null && S.decodeFile('not json') === null && S.decodeFile('{}') === null);
check('链接 size < 50KB(可直接发)', enc.sizeLink < 50000, (enc.sizeLink / 1024).toFixed(2) + 'KB');

// ===== 端到端 buildScene + importScene(现场打包→还原) =====
(async () => {
  await D.putEvent({ type: 'vital', subType: 'inp', value: 700, timestamp: 1, eventId: 'orig1', host: 'b.com', inputDelay: 100, processingDuration: 500, presentationDelay: 100 });
  const built = await D.buildScene({ signal: 'inp' }, {});
  check('buildScene 收集现场事件', built.events.length >= 1);
  const enc2 = S.encodeScene(built);
  store.events = []; D.clearEventsCache(); // 模拟「他方」空库
  const imported = S.decodeLink(enc2.link);
  const r = await D.importScene(imported);
  check('importScene 灌回事件', r.events >= 1, 'events=' + r.events);
  const after = await D.allEvents();
  check('导入后 allEvents 含还原事件(imported 标记)', after.length >= 1 && after.some((e) => e.imported), 'after=' + after.length);
  check('还原事件值一致(700ms)', after.some((e) => e.value === 700));

  // D2: 链接排除 domSnapshot(控 size),文件含完整现场
  {
    const sc = { host: 'a.com', events: [], rootCause: null, sessions: [{ eventId: 's1', startTime: 1, events: [], meta: { heapEnd: { used: 100 }, domEnd: 500, domSnapshot: '<html>...big dom snapshot...</html>', resources: [{ url: 'x.js', duration: 10 }] } }] };
    const enc = S.encodeScene(sc);
    const dLink = S.decodeLink(enc.link);
    const dFile = S.decodeFile(enc.file);
    const linkMeta = dLink.sessions[0] && dLink.sessions[0].meta;
    check('D2 链接排除 domSnapshot(控 size)', linkMeta && linkMeta.domSnapshot === undefined, JSON.stringify(linkMeta || {}));
    check('D2 链接保留 heapEnd/domEnd 摘要', linkMeta && linkMeta.domEnd === 500);
    const fileMeta = dFile.sessions[0] && dFile.sessions[0].meta;
    check('D2 文件含完整 domSnapshot', fileMeta && typeof fileMeta.domSnapshot === 'string' && fileMeta.domSnapshot.includes('big dom'));
    check('D2 文件含 resources', fileMeta && Array.isArray(fileMeta.resources) && fileMeta.resources.length === 1);
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length} checks) ====`);
  process.exit(failed.length ? 1 : 0);
})();
