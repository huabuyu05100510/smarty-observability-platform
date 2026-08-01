/**
 * 灌入示例数据（让面板立刻有内容看）+ 上传 fixture sourcemap（让 INP LoAF 能还原到源码）。
 * 用法：先启动后端（pnpm backend），再 node scripts/seed-demo.mjs [port]
 *
 * 模拟 collector 上报：
 *  - 3 个错误（2 种指纹）
 *  - INP 全归因样本（poor 620ms：三段分解 + interactionTarget + LoAF 脚本带 sourceURL/charPosition）
 *    + 若干 good/NI/poor INP 样本（供聚合/分布/趋势）
 *  - LCP / CLS vitals
 *  - 2 个 session
 * 并上传 fixture bundle.js + bundle.js.map（identity map，带 sourcesContent）到
 *  uploads/sourcemaps/default/demo-1.0.0/，让 /api/vitals/INP/rca 的 LoAF 还原有源码片段。
 */
const port = Number(process.argv[2] ?? 3921);
const base = `http://127.0.0.1:${port}`;

// ── fixture 源码（bundle = 源码本身，identity sourcemap）──────────────────────
// 一段真实的 INP 瓶颈代码：handleFilter 在 onClick 回调里同步遍历 + DOM 读写交替（layout thrashing）。
const SOURCE_PATH = 'src/handleFilter.js';
const SOURCE = `// src/handleFilter.js -- 列表筛选回调（INP 瓶颈）
import { fetchUsers } from './api.js';

export function handleFilter(query, allItems) {
  const q = (query || '').toLowerCase();
  // 慢点：同步遍历 + DOM 读写交替 -> processing 段过长，阻塞下一帧
  const filtered = [];
  for (let i = 0; i < allItems.length; i++) {
    const item = allItems[i];
    if (item.name.toLowerCase().includes(q)) {
      const el = document.querySelector('#row-' + item.id);
      if (el) el.classList.add('match');      // 强制重排（layout thrashing）
      filtered.push(item);
    }
  }
  renderResults(filtered);
  return filtered;
}

function renderResults(list) {
  const root = document.querySelector('#results');
  root.innerHTML = list.map((x) => '<li>' + x.name + '</li>').join('');
}
`;

// LoAF 指向的"慢行"（1-based）：强制重排那行
const SLOW_LINE = 11;
// 该行起始的字符偏移（bundle = SOURCE，偏移即源码偏移）
const lines = SOURCE.split('\n');
let charPosition = 0;
for (let i = 0; i < SLOW_LINE - 1; i++) charPosition += lines[i].length + 1;

// identity sourcemap：每行映射到自身（gen line L -> orig line L, col 0）
// VLQ: 0='A', 1='C'。行1='AAAA'，行>=2 orig_line delta=1 -> 'AACA'
const N = lines.length;
const mappings = 'AAAA' + ';AACA'.repeat(Math.max(0, N - 1));
const sourceMap = {
  version: 3,
  file: 'bundle.js',
  sources: [SOURCE_PATH],
  sourcesContent: [SOURCE],
  names: [],
  mappings,
};

const SOURCE_URL = 'https://app.demo.com/assets/bundle.js';
const RELEASE = 'demo-1.0.0';

// ── 上传 sourcemap（bundle.js + bundle.js.map）──────────────────────────────
async function uploadSourcemap(filename, content) {
  const u = `${base}/api/sourcemaps/upload?appId=default&version=${RELEASE}&filename=${encodeURIComponent(filename)}`;
  const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: content });
  return res.ok;
}

// ── 事件构造 ─────────────────────────────────────────────────────────────────
function err(fp, msg, sess, ts) {
  return {
    id: `e-${ts}-${Math.random().toString(36).slice(2, 6)}`, type: 'error', subType: 'js', timestamp: ts,
    traceId: 'a'.repeat(32), spanId: Math.random().toString(16).slice(2, 18).padStart(16, '0'),
    sessionId: sess, release: 'v1.2.3',
    payload: { id: 'e', type: 'js', message: msg, stack: `TypeError: ${msg}\n    at renderList (src/renderList.ts:42:17)`, filename: 'src/renderList.ts', lineno: 42, colno: 17, timestamp: ts, sourceURL: 'src/renderList.ts' },
    piiSafe: true, sampled: true, fingerprint: { primary: fp, secondary: 'sec-' + fp },
  };
}

/** INP 样本（InpAttribution）。full=true 带 LoAF + 完整归因（用于最差样本下钻）。*/
function inp(value, sess, ts, full) {
  const rating = value > 500 ? 'poor' : value > 200 ? 'needs-improvement' : 'good';
  const idelay = Math.round(value * 0.16);
  const pdur = Math.round(value * 0.71);
  const ppres = value - idelay - pdur;
  const payload = {
    value, rating,
    interactionType: 'pointer',
    interactionTarget: 'input#filter-input',
    inputDelay: idelay,
    processingDuration: pdur,
    presentationDelay: ppres,
    loadState: 'complete',
    page: { path: '/products', url: 'https://app.demo.com/products' },
    breadcrumbs: [
      { type: 'navigation', message: '进入 /products', ts: ts - 8000 },
      { type: 'click', message: '点击筛选', target: 'input#filter-input', ts: ts - 200 },
    ],
  };
  if (full) {
    payload.longAnimationFrameEntries = [{
      id: 'loaf-' + ts, startTime: idelay, duration: pdur, blockingDuration: pdur - 30,
      renderStart: idelay + pdur - 40, styleAndLayoutStart: idelay + pdur - 20,
      scripts: [{
        id: 'sc-' + ts, name: 'handleFilter', invoker: 'BUTTON#filter.onclick',
        invokerType: 'event-listener',
        sourceURL: SOURCE_URL, sourceFunctionName: 'handleFilter',
        sourceCharPosition: charPosition,
        duration: pdur - 15, startTime: idelay + 5,
        forcedStyleAndLayoutDuration: 60, pauseDuration: 5,
      }],
    }];
  }
  return {
    id: `v-inp-${ts}-${Math.random().toString(36).slice(2, 6)}`, type: 'vital', subType: 'inp',
    timestamp: ts, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sessionId: sess, release: RELEASE,
    payload, piiSafe: true, sampled: true,
  };
}

function vital(name, value, sess) {
  const rating = name === 'LCP' ? (value > 4000 ? 'poor' : value > 2500 ? 'needs-improvement' : 'good')
    : (value > 0.25 ? 'poor' : value > 0.1 ? 'needs-improvement' : 'good');
  return {
    id: `v-${name}-${Math.random().toString(36).slice(2, 6)}`, type: 'vital', subType: name.toLowerCase(),
    timestamp: Date.now(), traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sessionId: sess, release: RELEASE,
    payload: { name, value, rating }, piiSafe: true, sampled: true,
  };
}

const now = Date.now();
const events = [
  err('fp-null-map', "Cannot read properties of null (reading 'map')", 'sess-a', now - 60000),
  err('fp-null-map', "Cannot read properties of null (reading 'map')", 'sess-a', now - 50000),
  err('fp-null-map', "Cannot read properties of null (reading 'map')", 'sess-b', now - 40000),
  err('fp-undefined', "Cannot read properties of undefined (reading 'id')", 'sess-b', now - 30000),
  // INP 时间序列（good/NI/poor 分布，最差样本带完整 LoAF 归因）
  inp(180, 'sess-a', now - 240000, false),
  inp(240, 'sess-b', now - 180000, false),
  inp(350, 'sess-a', now - 120000, false),
  inp(440, 'sess-b', now - 60000, false),
  inp(620, 'sess-a', now - 20000, true),   // 最差样本：完整 LoAF -> 火焰图 + 源码还原
  vital('LCP', 2800, 'sess-a'),
  vital('CLS', 0.18, 'sess-b'),
];

// ── 执行 ─────────────────────────────────────────────────────────────────────
const smJs = await uploadSourcemap('bundle.js', SOURCE);
const smMap = await uploadSourcemap('bundle.js.map', JSON.stringify(sourceMap));
console.log(`sourcemap 上传: bundle.js=${smJs}, bundle.js.map=${smMap} (version=${RELEASE}, charPos=${charPosition} -> 行 ${SLOW_LINE})`);

const res = await fetch(`${base}/api/events`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(events),
});
const json = await res.json();
console.log(`已灌入 ${json.ingested} 个事件到 ${base}（INP 最差 620ms poor，带 LoAF 归因）`);
console.log(`打开 ${base} -> "INP 归因与自愈" 视图：聚合 -> 火焰图 -> 根因 -> 源码 -> 解决 -> 自愈`);
