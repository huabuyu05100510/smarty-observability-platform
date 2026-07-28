/**
 * 灌入示例数据（让面板立刻有内容看）。
 * 用法：先启动后端，再 node scripts/seed-demo.mjs [port]
 * 模拟 collector 上报：3 个错误（2 种指纹）+ INP/LCP/CLS vitals + 2 个 session。
 */
const port = Number(process.argv[2] ?? 3921);
const base = `http://127.0.0.1:${port}`;

function err(fp, msg, sess, ts) {
  return {
    id: `e-${ts}-${Math.random().toString(36).slice(2, 6)}`, type: 'error', subType: 'js', timestamp: ts,
    traceId: 'a'.repeat(32), spanId: Math.random().toString(16).slice(2, 18).padStart(16, '0'),
    sessionId: sess, release: 'v1.2.3',
    payload: { id: 'e', type: 'js', message: msg, stack: `TypeError: ${msg}\n    at renderList (src/renderList.ts:42:17)`, filename: 'src/renderList.ts', lineno: 42, colno: 17, timestamp: ts, sourceURL: 'src/renderList.ts' },
    piiSafe: true, sampled: true, fingerprint: { primary: fp, secondary: 'sec-' + fp },
  };
}
function vital(name, value, sess) {
  const rating = name === 'INP' ? (value > 500 ? 'poor' : value > 200 ? 'needs-improvement' : 'good')
    : name === 'LCP' ? (value > 4000 ? 'poor' : value > 2500 ? 'needs-improvement' : 'good')
    : (value > 0.25 ? 'poor' : value > 0.1 ? 'needs-improvement' : 'good');
  return {
    id: `v-${name}-${Math.random().toString(36).slice(2, 6)}`, type: 'vital', subType: name.toLowerCase(),
    timestamp: Date.now(), traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sessionId: sess, release: 'v1.2.3',
    payload: { name, value, rating }, piiSafe: true, sampled: true,
  };
}

const now = Date.now();
const events = [
  err('fp-null-map', "Cannot read properties of null (reading 'map')", 'sess-a', now - 60000),
  err('fp-null-map', "Cannot read properties of null (reading 'map')", 'sess-a', now - 50000),
  err('fp-null-map', "Cannot read properties of null (reading 'map')", 'sess-b', now - 40000),
  err('fp-undefined', "Cannot read properties of undefined (reading 'id')", 'sess-b', now - 30000),
  vital('INP', 320, 'sess-a'),
  vital('INP', 580, 'sess-b'),
  vital('LCP', 2800, 'sess-a'),
  vital('CLS', 0.18, 'sess-b'),
];

const res = await fetch(`${base}/api/events`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(events),
});
const json = await res.json();
console.log(`已灌入 ${json.ingested} 个事件到 ${base}`);
console.log(`打开 ${base} 查看面板（错误收件箱 / Web Vitals / Sessions）`);
