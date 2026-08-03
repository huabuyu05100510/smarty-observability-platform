// noise.verify.mjs · noise-gate.js 纯函数「已知答案」测试(纯 Node,无需浏览器)
// 噪音门是错误/慢交互进根因前的第一道闸。分组键错了会把不同错误并组、或把同一错误拆组;
// 白名单错了会丢真错误、或放任已知良性刷屏;风暴合并错了会误丢首条或永不合并。
// 这里用确定性 fixture 钉死三类正确性。运行:node noise.verify.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');

function loadModule(file) {
  const code = readFileSync(path.join(EXT, file), 'utf8');
  vm.runInThisContext(code, { filename: file });
}
loadModule('noise-gate.js');
const NG = globalThis.__noiseGate;

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
};

// ============ fingerprint · INP ============
{
  const a = { subType: 'inp', interactionTarget: 'button#submit', inputDelay: 300, processingDuration: 50, presentationDelay: 20 };
  const b = { subType: 'inp', interactionTarget: 'button#submit', inputDelay: 310, processingDuration: 40, presentationDelay: 15 }; // 同 target 同主导段(inputDelay)
  const c = { subType: 'inp', interactionTarget: 'button#submit', inputDelay: 50, processingDuration: 400, presentationDelay: 20 }; // 同 target 主导=processing
  const d = { subType: 'inp', interactionTarget: 'input#search', inputDelay: 300, processingDuration: 50, presentationDelay: 20 }; // 不同 target
  ok('INP 同 target+同主导段 → 同指纹', NG.fingerprint(a) === NG.fingerprint(b), `${NG.fingerprint(a)} vs ${NG.fingerprint(b)}`);
  ok('INP 同 target 不同主导段 → 不同指纹(瓶颈迁移要分开)', NG.fingerprint(a) !== NG.fingerprint(c));
  ok('INP 不同 target → 不同指纹', NG.fingerprint(a) !== NG.fingerprint(d));
}

// ============ fingerprint · error 帧主导(Sentry-style)============
{
  // 同帧、不同变量名(reading 'foo'/'bar')→ 同组(帧主导,完整 message 不进键)
  const e1 = { type: 'error', subType: 'js', message: "Cannot read properties of undefined (reading 'foo')", filename: 'https://x.com/app.js', lineno: 42, colno: 10 };
  const e2 = { type: 'error', subType: 'js', message: "Cannot read properties of undefined (reading 'bar')", filename: 'https://x.com/app.js', lineno: 42, colno: 10 };
  ok('错误 同帧不同变量名 → 同组(帧主导,修旧"变量名拆组"问题)', NG.fingerprint(e1) === NG.fingerprint(e2), `${NG.fingerprint(e1)} vs ${NG.fingerprint(e2)}`);
  // 不同帧、同异常类 → 不同组(修旧"前缀相同误并"问题)
  const e3 = { type: 'error', subType: 'js', message: 'Cannot read properties of undefined', filename: 'https://x.com/other.js', lineno: 1, colno: 1 };
  ok('错误 不同帧同异常类 → 不同组', NG.fingerprint(e1) !== NG.fingerprint(e3));
  // 同帧、不同异常类(TypeError-like vs ReferenceError-like)→ 不同组
  const e4 = { type: 'error', subType: 'js', message: 'x is not defined', filename: 'https://x.com/app.js', lineno: 42, colno: 10 };
  ok('错误 同帧不同异常类 → 不同组', NG.fingerprint(e1) !== NG.fingerprint(e4));
  // URL query / 部署 hash 不影响指纹
  const e5 = { type: 'error', subType: 'js', message: 'Cannot read properties of undefined', filename: 'https://x.com/app.js?v=2', lineno: 42, colno: 10 };
  const e5b = { type: 'error', subType: 'js', message: 'Cannot read properties of undefined', filename: 'https://x.com/app.js', lineno: 42, colno: 10 };
  ok('错误 URL query 不影响指纹(部署版本变 hash 不拆组)', NG.fingerprint(e5) === NG.fingerprint(e5b));
}

// ============ fingerprint · 稳定性:sourcemap overlay 到达前后不变 ============
// resolvedFrames 是展示富化字段,不进分组键 → 还原前后同组(否则同一错误拆两组)
{
  const base = { type: 'error', subType: 'js', message: 'TypeError: x is undefined', filename: 'app.js', lineno: 10, colno: 5 };
  const withResolved = Object.assign({}, base, { resolvedFrames: [{ source: 'src/foo.ts', line: 84, snippet: { rows: [] } }] });
  ok('fingerprint 加 resolvedFrames 前后不变(还原仅展示,不进键)', NG.fingerprint(base) === NG.fingerprint(withResolved));
}

// ============ fingerprint · resource(按资源文件分)============
{
  const r1 = { type: 'error', subType: 'resource', message: '404', sourceURL: 'https://x.com/chunk.a1b2c3.js' };
  const r2 = { type: 'error', subType: 'resource', message: 'net::ERR', sourceURL: 'https://x.com/chunk.a1b2c3.js' };
  const r3 = { type: 'error', subType: 'resource', message: '404', sourceURL: 'https://x.com/vendor.js' };
  ok('resource 同 sourceURL 不同 message → 同组', NG.fingerprint(r1) === NG.fingerprint(r2));
  ok('resource 不同 sourceURL → 不同组', NG.fingerprint(r1) !== NG.fingerprint(r3));
}

// ============ isBenign(保守白名单)============
{
  ok('isBenign ResizeObserver loop → drop', NG.isBenign({ message: 'ResizeObserver loop completed with undelivered notifications.' }).drop);
  ok('isBenign "Script error." → drop', NG.isBenign({ message: 'Script error.' }).drop);
  ok('isBenign 真 TypeError → 不 drop(不误杀)', !NG.isBenign({ message: 'TypeError: x is undefined' }).drop);
  ok('isBenign AbortError 默认不 drop(保守,防掩盖 fetch 真问题)', !NG.isBenign({ message: 'AbortError: The user aborted a request' }).drop);
  ok('isBenign AbortError includeOptIn → drop(可配置开启)', NG.isBenign({ message: 'AbortError: x' }, { includeOptIn: true }).drop);
}

// ============ shouldCoalesce(风暴合并,per-page 窗口)============
{
  const st = new Map();
  const ev = { type: 'error', subType: 'js', message: 'TypeError: x', filename: 'a.js', lineno: 1, colno: 1 };
  const t = (ms) => NG.shouldCoalesce(ev, st, { now: ms, windowMs: 1000 });
  ok('coalesce 首条 → suppress=false', t(0).suppress === false);
  ok('coalesce 窗口内第 2 条 → suppress=true', t(100).suppress === true);
  const c3 = t(200);
  ok('coalesce 窗口内 count 累加(=3)', c3.count === 3, 'count=' + c3.count);
  ok('coalesce 跨窗口(>1000ms)→ suppress=false 重置', t(1500).suppress === false);
  // 不同指纹互不影响
  const st2 = new Map();
  const eA = { type: 'error', subType: 'js', message: 'TypeError: a', filename: 'a.js', lineno: 1, colno: 1 };
  const eB = { type: 'error', subType: 'js', message: 'ReferenceError: b', filename: 'b.js', lineno: 1, colno: 1 };
  NG.shouldCoalesce(eA, st2, { now: 0 });
  ok('coalesce 不同指纹互不影响', NG.shouldCoalesce(eB, st2, { now: 10 }).suppress === false);
  ok('coalesce state 缺 → 不 suppress(安全降级)', NG.shouldCoalesce(ev, null).suppress === false);
}

// ============ groupInp(读端分组)============
{
  const evs = [
    { subType: 'inp', interactionTarget: 'button#a', inputDelay: 300, processingDuration: 10, presentationDelay: 10, timestamp: 100, value: 320 },
    { subType: 'inp', interactionTarget: 'button#a', inputDelay: 310, processingDuration: 10, presentationDelay: 10, timestamp: 200, value: 330 },
    { subType: 'inp', interactionTarget: 'button#a', inputDelay: 10, processingDuration: 300, presentationDelay: 10, timestamp: 300, value: 320 }, // 同 target 不同段 → 另一组
    { subType: 'inp', interactionTarget: 'button#b', inputDelay: 300, processingDuration: 10, presentationDelay: 10, timestamp: 400, value: 320 },
  ];
  const g = NG.groupInp(evs);
  ok('groupInp 分 3 组(a-inputDelay / a-processing / b)', g.length === 3, 'len=' + g.length);
  const topA = g.find((x) => x.target === 'button#a' && x.phase === 'inputDelay');
  ok('groupInp button#a/inputDelay count=2', !!topA && topA.count === 2, 'count=' + (topA && topA.count));
  ok('groupInp 按 last 降序', g[0].last >= g[g.length - 1].last);
  ok('groupInp 空输入 → []', NG.groupInp([]).length === 0);
}

// ============ data.js 委托集成(源端/读端共享同一指纹)============
{
  loadModule('data.js');
  const D = globalThis.__data;
  ok('data.fingerprint 委托 noise-gate(同帧同异常类同组)', D.fingerprint({ type: 'error', subType: 'js', message: "Cannot read 'foo'", filename: 'a.js', lineno: 1, colno: 1 }) === NG.fingerprint({ type: 'error', subType: 'js', message: "Cannot read 'bar'", filename: 'a.js', lineno: 1, colno: 1 }));
  ok('data.groupInp 导出且委托 noise-gate', typeof D.groupInp === 'function' && D.groupInp([{ subType: 'inp', interactionTarget: 'b', inputDelay: 300, processingDuration: 10, presentationDelay: 10, timestamp: 1 }]).length === 1);
  ok('data.fingerprint 缺 noise-gate 时降级(不崩)', (() => { const saved = globalThis.__noiseGate; delete globalThis.__noiseGate; const r = D.fingerprint({ subType: 'js', message: 'abc' }); globalThis.__noiseGate = saved; return typeof r === 'string'; })());
}

// ============ 汇总 ============
const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length} checks) ====`);
process.exit(failed.length ? 1 : 0);
