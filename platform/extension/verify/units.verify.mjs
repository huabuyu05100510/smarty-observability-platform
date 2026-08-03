// units.verify.mjs · causal.js / sourcemap.js 纯函数「已知答案」测试(纯 Node,无需浏览器)
// 这两个模块是纯数学:Welch t 统计 + Base64 VLQ / source-map 还原。不需要 Playwright/浏览器,
// 用可手算 / 对照教科书的已知答案钉死正确性——reviewer 要信扩展产出的 p 值与源码还原,
// 先得信这些底层算式是对的。与 loop.verify.mjs(测控制流)互补:这里专测数学本身。
//
// 运行:`node units.verify.mjs`(或 `npm run units`)。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');

// 模块是 IIFE(挂 globalThis.__x),非 ESM → runInThisContext 在当前进程全局上下文执行,
// 使文件内的 globalThis.__causal / __sourcemap 赋值对本进程可见。
function loadModule(file) {
  const code = readFileSync(path.join(EXT, file), 'utf8');
  vm.runInThisContext(code, { filename: file });
}
loadModule('causal.js');
loadModule('sourcemap.js');
loadModule('noise-gate.js');
loadModule('diagnose.js');
loadModule('error-diagnose.js');
loadModule('localize.js');
loadModule('db.js');
loadModule('data.js');
loadModule('sidecar.js');
const causal = globalThis.__causal;
const sm = globalThis.__sourcemap;
const LOC = globalThis.__localize;
const D = globalThis.__data;

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? '✓ PASS' : '✗ FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
};
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ============ causal.js · Welch t 已知答案(全部可手算)============
// baseline/treated 各 n=5:
//   [600,610,590,605,595] mean=600, sample variance(÷n-1)=62.5
//   [200,210,190,205,195] mean=200, sample variance=62.5
//   t = (200-600)/sqrt(62.5/5 + 62.5/5) = -400/sqrt(25) = -80
//   df(Welch–Satterthwaite,方差相等时)= 2n-2 = 8
//   双尾 p(|t|=80, df=8) ≈ 0
{
  const baseline = [600, 610, 590, 605, 595];
  const treated = [200, 210, 190, 205, 195];
  const r = causal.runCausalValidation(baseline, treated, { direction: 'decrease', alpha: 0.05 });

  ok('样本方差 = 62.5(÷n-1,手算)', approx(r.baseline.variance, 62.5) && approx(r.treated.variance, 62.5), `varB=${r.baseline.variance} varT=${r.treated.variance}`);
  ok('Welch t = -80(手算: 均值差 / √(var/n 和))', approx(r.tStatistic, -80), `t=${r.tStatistic}`);
  ok('effectSize = -400(均值差)', approx(r.effectSize, -400), `effect=${r.effectSize}`);
  ok('relativeChange = -2/3', approx(r.relativeChange, -2 / 3), `rel=${r.relativeChange}`);
  ok('p 值极显著(< 1e-6,df=8 下 |t|=80)', r.pValue < 1e-6, `p=${r.pValue}`);
  ok('significant=true 且 conclusion=accepted(下降方向命中)', r.significant === true && r.conclusion === 'accepted', `sig=${r.significant} conc=${r.conclusion}`);
}

// 相同样本 → t=0 / p=1 / inconclusive(无差异绝不应判显著)
{
  const r = causal.runCausalValidation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], { direction: 'decrease' });
  ok('相同样本 t=0', approx(r.tStatistic, 0), `t=${r.tStatistic}`);
  ok('相同样本 p=1(t=0 → regularizedBeta(df/df,...)=1)', approx(r.pValue, 1), `p=${r.pValue}`);
  ok('相同样本 inconclusive(不夸大)', r.conclusion === 'inconclusive' && r.significant === false, `conc=${r.conclusion} sig=${r.significant}`);
}

// 样本不足(n<2)→ welchT 安全返回 0,不抛、判 inconclusive
{
  const r = causal.runCausalValidation([100], [90], { direction: 'decrease' });
  ok('n<2 安全降级 t=0', approx(r.tStatistic, 0) && r.conclusion === 'inconclusive', `t=${r.tStatistic} conc=${r.conclusion}`);
}

// 方向门禁:treated 反而升高 → 即便极显著也判 rejected(direction=decrease,诚实门禁)
{
  const r = causal.runCausalValidation([100, 110, 90, 105, 95], [300, 310, 290, 305, 295], { direction: 'decrease' });
  ok('方向相反→rejected(显著但变差,不冒充修复)', r.significant === true && r.conclusion === 'rejected', `sig=${r.significant} conc=${r.conclusion} effect=${r.effectSize}`);
}

// ============ sourcemap.js · Base64 VLQ 已知答案 ============
// 规则:每 5-bit 组,bit5=continuation,组内 LSB=符号,其余=幅度。
//   'A'(idx0)=0 ; 'C'(idx2)=+1 ; 'D'(idx3)=-1 ; 'E'(idx4)=+2
{
  ok('VLQ "A"→[0]', JSON.stringify(sm.decodeVlq('A')) === '[0]');
  ok('VLQ "C"→[1]', JSON.stringify(sm.decodeVlq('C')) === '[1]');
  ok('VLQ "D"→[-1](符号位)', JSON.stringify(sm.decodeVlq('D')) === '[-1]');
  ok('VLQ "E"→[2]', JSON.stringify(sm.decodeVlq('E')) === '[2]');
  ok('VLQ "AAAAA"→[0,0,0,0,0]', JSON.stringify(sm.decodeVlq('AAAAA')) === '[0,0,0,0,0]');
}

// ============ sourcemap.js · originalPositionFor / snippet 端到端还原 ============
// 极小 map:mappings "AAAA,CAAC"(1 生成行,2 段,纯 delta 累积):
//   段1 @genCol0(delta0) → src0·line0·col0   段2 @genCol1(+1) → src0·line0·col1
// 还原后按 0-based→1-based:gen 1:0 → foo.js 1:1 ; gen 1:1 → foo.js 1:2
{
  const c = sm.consumeMap({
    version: 3,
    sources: ['foo.js'],
    sourcesContent: ['abc\ndef\nghi'],
    names: [],
    mappings: 'AAAA,CAAC',
  });
  const a = c.originalPositionFor({ line: 1, column: 0 });
  ok('还原 gen 1:0 → foo.js 1:1', a.source === 'foo.js' && a.line === 1 && a.column === 1, JSON.stringify(a));
  const b = c.originalPositionFor({ line: 1, column: 1 });
  ok('还原 gen 1:1 → foo.js 1:2', b.source === 'foo.js' && b.line === 1 && b.column === 2, JSON.stringify(b));
  const none = c.originalPositionFor({ line: 2, column: 0 });
  ok('无映射的生成行 → source=null(不造假源码位置)', none.source === null, JSON.stringify(none));
  const snip = c.snippet('foo.js', 2, 1);
  ok('snippet line2±1 → 3 行(def 居中, hl=1)', !!snip && snip.rows.length === 3 && snip.rows[1].code === 'def' && snip.hl === 1, JSON.stringify(snip));
}

// ============ localize.js · 域通用定位路由器(对齐官方归因)============
// INP 三段:inputDelay 主导 → 族含 inject_cleanup/throttle_third_party
{
  const r = LOC.inp({ inputDelay: 300, processingDuration: 50, presentationDelay: 20 });
  ok('INP dominant=inputDelay(三段最大)', r.dominant === 'inputDelay', 'dom=' + r.dominant);
  ok('INP dimension=phase, segments=3', r.dimension === 'phase' && r.segments.length === 3, 'len=' + r.segments.length);
  ok('INP 族含 inject_cleanup/throttle_third_party(段位兜底)', r.family.includes('inject_cleanup') && r.family.includes('throttle_third_party'), JSON.stringify(r.family));
}
// LCP 四段(官方):resStart/resEnd 齐全 → 4 段,load delay 主导 → preload_lcp
{
  // ttfb=400,resStart=2000(loadDelay=1600),resEnd=2600(loadTime=600),value=3000(renderDelay=400)
  const r = LOC.lcp({ value: 3000, ttfb: 400, resStart: 2000, resEnd: 2600 });
  ok('LCP 四段(官方)segments=4', r.segments.length === 4, 'len=' + r.segments.length);
  ok('LCP dominant=resourceLoadDelay(1600 最大)', r.dominant === 'resourceLoadDelay', 'dom=' + r.dominant);
  ok('LCP load-delay 族 = preload_lcp', r.family.length === 1 && r.family[0] === 'preload_lcp', JSON.stringify(r.family));
}
// LCP 降级:缺 resStart/resEnd(旧数据)→ 三段,不崩
{
  const r = LOC.lcp({ value: 3000, ttfb: 400, resLoad: 2200 });
  ok('LCP 旧数据降级三段', r.segments.length === 3, 'len=' + r.segments.length);
  ok('LCP 降级 dominant 仍可判', !!r.dominant, 'dom=' + r.dominant);
}
// FCP 三段:blocking 主导 → defer_css
{
  const r = LOC.fcp({ value: 2000, ttfb: 400, domParse: 300 }); // blocking=1300
  ok('FCP dominant=blocking', r.dominant === 'blocking', 'dom=' + r.dominant);
  ok('FCP blocking 族 = defer_css', r.family.length === 1 && r.family[0] === 'defer_css', JSON.stringify(r.family));
}
// CLS 来源类:media 主导 → size_attrs
{
  const r = LOC.cls({ sourceBreakdown: { media: 0.15, font: 0.02, dom: 0.03 } });
  ok('CLS dimension=source, dominant=media', r.dimension === 'source' && r.dominant === 'media', 'dom=' + r.dominant);
  ok('CLS media 族 = size_attrs', r.family.length === 1 && r.family[0] === 'size_attrs', JSON.stringify(r.family));
}
// 错误分类:null_access → optional_chaining/null_guard
{
  const r = LOC.error({ subType: 'js', message: "Cannot read properties of undefined (reading 'x')", stack: 'at f (https://x.com/a.js:10:5)' });
  ok('错误 dimension=class', r.dimension === 'class', 'dim=' + r.dimension);
  ok('错误 dominant 命中 null_access', /null_access/.test(r.dominant || ''), 'dom=' + r.dominant);
  ok('错误 族含 optional_chaining/null_guard', r.family.includes('optional_chaining') && r.family.includes('null_guard'), JSON.stringify(r.family));
}
// route 分派 + 未知信号安全降级
{
  ok('route(inp) 走 inp', LOC.route('inp', { inputDelay: 300, processingDuration: 50, presentationDelay: 20 }).signal === 'inp');
  ok('route(unknown) 安全空返回', LOC.route('nope', {}).family.length === 0);
}

// ============ critical fix 回归:regularizedBeta swap(中段 |t| 不再假阳性)============
// 此前 |t| 小(接近无差异)时 p 误算≈0 → 无效 patch 被判「极显著 accepted」。修复后必须 p 大、不显著。
{
  const r = causal.runCausalValidation([100, 200, 50, 250, 80], [90, 190, 40, 240, 70], { direction: 'decrease' });
  ok('critical fix · |t| 小(交互差异大)→ p>0.5 inconclusive', r.pValue > 0.5 && r.conclusion === 'inconclusive', 't=' + r.tStatistic.toFixed(3) + ' p=' + r.pValue.toFixed(3));
}
// 中等 |t| 也要合理(非 0 非 1):均值差 5、低方差 → 显著但 p 不应≈1
{
  const r = causal.runCausalValidation([50, 52, 48, 51, 49], [45, 47, 43, 46, 44], { direction: 'decrease' });
  ok('中等 |t| → 显著 accepted(p<0.01 量级)', r.conclusion === 'accepted' && r.pValue < 0.01, 't=' + r.tStatistic.toFixed(2) + ' p=' + r.pValue.toExponential(2));
}

// ============ CUPED 协变量校正 ============
{
  const Y = [600, 610, 590, 605, 595], X = [602, 608, 592, 603, 597];
  const adj = causal.cupedAdjustSeries(Y, X);
  const my = 600;
  const varY = Y.reduce((s, v) => s + (v - my) ** 2, 0) / 4;
  const ma = adj.reduce((s, v) => s + v, 0) / adj.length;
  const varAdj = adj.reduce((s, v) => s + (v - ma) ** 2, 0) / (adj.length - 1);
  ok('CUPED 强相关协变量 → 方差降低 >80%', varAdj < varY * 0.2, 'varY=' + varY.toFixed(2) + ' varAdj=' + varAdj.toFixed(2));
  ok('CUPED 保持均值(不偏)', Math.abs(ma - my) < 1, 'ma=' + ma.toFixed(3));
  const r0 = causal.runCausalValidationCuped([600, 610, 590, 605, 595], [200, 210, 190, 205, 195]);
  ok('CUPED 无协变量 → cuped=false 诚实退化(非静默冒充)', r0.cuped === false && r0.design === 'sequential', 'cuped=' + r0.cuped);
  const r1 = causal.runCausalValidationCuped([600, 610, 590, 605, 595], [200, 210, 190, 205, 195], [602, 608, 592, 603, 597], [202, 208, 192, 203, 197]);
  ok('CUPED 有协变量 → cuped=true design=cuped', r1.cuped === true && r1.design === 'cuped', 'cuped=' + r1.cuped);
}

// ============ 功效分析(normInv + sampleSizeFor)============
{
  ok('normInv(0.975)≈1.95996', Math.abs(causal.normInv(0.975) - 1.95996) < 1e-3, 'z=' + causal.normInv(0.975));
  ok('normInv(0.8)≈0.84162', Math.abs(causal.normInv(0.8) - 0.84162) < 1e-3, 'z=' + causal.normInv(0.8));
  ok('normInv 对称:z(p)=-z(1-p)', Math.abs(causal.normInv(0.1) + causal.normInv(0.9)) < 1e-9, causal.normInv(0.1) + '+' + causal.normInv(0.9));
  ok('sampleSizeFor(Δ=60,σ=60)=16(N=6 功效不足的反证)', causal.sampleSizeFor(60, 60) === 16, 'n=' + causal.sampleSizeFor(60, 60));
  ok('sampleSizeFor(Δ=150,σ=60)=3', causal.sampleSizeFor(150, 60) === 3, 'n=' + causal.sampleSizeFor(150, 60));
  ok('sampleSizeFor(Δ≤0 或 σ≤0)→ 下限 2', causal.sampleSizeFor(0, 60) === 2 && causal.sampleSizeFor(60, 0) === 2);
}

// ============ Holm 多重比较校正 ============
{
  const r = causal.holmCorrect([0.01, 0.02, 0.03, 0.04, 0.05], 0.05);
  ok('Holm rejected=[T,F,F,F,F](经典步降)', JSON.stringify(r.map((x) => x.rejected)) === '[true,false,false,false,false]', JSON.stringify(r.map((x) => x.rejected)));
  ok('Holm adjustedP 单调非递减', r.every((x, i) => i === 0 || r[i - 1].adjustedP <= x.adjustedP + 1e-9), JSON.stringify(r.map((x) => x.adjustedP.toFixed(3))));
  ok('Holm 顺序保持(返回与输入同序)', r.every((x, i) => x.originalIndex === i));
  ok('Holm 全显著(都极小)→ 全 rejected', causal.holmCorrect([1e-6, 1e-6, 1e-6], 0.05).every((x) => x.rejected));
}

// ============ 配对 t 检验 ============
{
  const r = causal.pairedTTest([100, 110, 90, 105, 95], [60, 70, 50, 65, 55], { direction: 'decrease' });
  ok('配对 t 一致改善 → accepted, design=paired', r.conclusion === 'accepted' && r.design === 'paired', 'conc=' + r.conclusion);
  ok('配对 t effectSize = mean(d) = -40', Math.abs(r.effectSize - (-40)) < 1e-9, 'effect=' + r.effectSize);
  ok('配对 t n<2 → inconclusive(安全降级)', causal.pairedTTest([100], [90]).conclusion === 'inconclusive');
  // 配对消除交互差异:独立 t 检不出、配对 t 检得出
  const indep = causal.runCausalValidation([100, 200, 50, 250, 80], [90, 190, 40, 240, 70], { direction: 'decrease' });
  const pair = causal.pairedTTest([100, 200, 50, 250, 80], [90, 190, 40, 240, 70], { direction: 'decrease' });
  ok('配对 > 独立功效:独立 inconclusive / 配对 accepted', indep.conclusion === 'inconclusive' && pair.conclusion === 'accepted', 'indep=' + indep.conclusion + ' pair=' + pair.conclusion);
}

// ============ 属性测试(property-based):不变量对随机输入成立 ============
{
  const rand = (n) => Array.from({ length: n }, () => Math.random() * 500 + 50);
  let inRange = true, nonNeg = true, sameIsInconcl = true;
  for (let i = 0; i < 300; i++) {
    const n = 3 + Math.floor(Math.random() * 8);
    const a = rand(n), b = rand(n);
    const r = causal.runCausalValidation(a, b, { direction: 'decrease' });
    if (!(r.pValue >= 0 && r.pValue <= 1)) inRange = false;
    if (r.baseline.variance < 0 || r.treated.variance < 0) nonNeg = false;
  }
  for (let i = 0; i < 50; i++) {
    const s = rand(5);
    if (causal.runCausalValidation(s, s, { direction: 'decrease' }).conclusion !== 'inconclusive') sameIsInconcl = false;
  }
  ok('属性 · p∈[0,1] 对 300 随机样本恒成立', inRange);
  ok('属性 · variance≥0 对 300 随机样本恒成立', nonNeg);
  ok('属性 · 相同样本 → inconclusive(50 次)', sameIsInconcl);
}

// ============ 采集层契约 · INP 三段无损分解 ============
// content.js 内联公式:inputDelay+processingDuration+presentationDelay 恒 = duration,且 presentation≥0。
{
  const cases = [[100, 120, 180, 200], [0, 50, 200, 250], [10, 60, 90, 100], [0, 0, 50, 50]];
  let lossless = true, presNonNeg = true;
  for (const [start, pStart, pEnd, dur] of cases) {
    const inputDelay = pStart - start, proc = pEnd - pStart, pres = dur - (pEnd - start);
    if (Math.abs((inputDelay + proc + pres) - dur) > 1e-9) lossless = false;
    if (pres < -1e-9) presNonNeg = false;
  }
  ok('INP 三段无损:inputDelay+processing+presentation = duration', lossless);
  ok('INP presentationDelay ≥ 0(物理约束)', presNonNeg);
}

// ============ 聚合层 · data.js(pct / rateSig / fmtSig)============
{
  ok('pct([1..10],0.75)=8(nearest-rank)', D.pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.75) === 8, 'p75=' + D.pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.75));
  ok('pct 空数组 = 0(不抛)', D.pct([], 0.75) === 0);
  ok('rateSig(inp):150=good / 300=warn / 600=bad', D.rateSig('inp', 150) === 'good' && D.rateSig('inp', 300) === 'warn' && D.rateSig('inp', 600) === 'bad');
  ok('rateSig(cls):0.05=good / 0.15=warn / 0.30=bad', D.rateSig('cls', 0.05) === 'good' && D.rateSig('cls', 0.15) === 'warn' && D.rateSig('cls', 0.30) === 'bad');
  ok('fmtSig(inp,300)=300ms', D.fmtSig('inp', 300) === '300ms', 'got=' + D.fmtSig('inp', 300));
  ok('fmtSig(lcp,3000)=3.0s', D.fmtSig('lcp', 3000) === '3.0s', 'got=' + D.fmtSig('lcp', 3000));
  ok('fmtSig 缺值 = —', D.fmtSig('inp', null) === '—');
}

// ============ Schema 契约 · 违约探测 ============
{
  loadModule('schema.js');
  const sch = globalThis.__schema;
  const good = { type: 'vital', subType: 'inp', eventId: 'e', host: 'h', route: '/', timestamp: 1, sessionId: 's', release: 'r', value: 1, inputDelay: 1, processingDuration: 1, presentationDelay: 1, interactionTarget: 'b', origin: 'o' };
  ok('schema 完整 inp → ok=true', sch.validate(good).ok);
  const noOr = Object.assign({}, good); delete noOr.origin;
  ok('schema 缺 origin → missing 含 origin(违约可探测)', sch.validate(noOr).missing.includes('origin'), JSON.stringify(sch.validate(noOr).missing));
  ok('schema assert 违约 → violationDelta 计数', !sch.assert(noOr).ok && sch.violationDelta().delta >= 1);
  ok('schema 未知 subType → 放行(向前兼容)', sch.validate(Object.assign({}, good, { subType: 'future' })).ok);
  ok('schema keyOf', sch.keyOf(good) === 'vital.inp' && sch.keyOf({}) === null);
}

// ============ memory 泄漏链路(loadMemory / memoryCandidates / localize.memory / analyzeRootCause)============
{
  const memStore = { events: [] };
  globalThis.__inpDb = { put: async () => {}, getAll: async (s) => memStore[s] || [], count: async () => 0, clear: async () => {} }; // 桩覆盖 db.js(供 loadMemory 读)
  const t0 = 1000000;
  // 场景1:堆单调增长(每样本 +2MB),nav@5 且后段不回落
  for (let i = 0; i < 10; i++) memStore.events.push({ type: 'vital', subType: 'memory', timestamp: t0 + i * 5000, value: (20 + i * 2) * 1048576, used: (20 + i * 2) * 1048576, total: 100 * 1048576, limit: 200 * 1048576, domCount: 1000 + i * 10, nav: i === 5 });
  const r1 = await D.loadMemory({ vitals: { memory: [] } });
  ok('loadMemory 堆单调增 → heapSlopeMB≈24(2MB/sample×12)', r1.heapSlopeMB > 23 && r1.heapSlopeMB < 25, 'slope=' + r1.heapSlopeMB.toFixed(2));
  ok('loadMemory domSlope≈120/min', r1.domSlope > 115 && r1.domSlope < 125, 'dom=' + r1.domSlope.toFixed(0));
  ok('loadMemory nav@5 后段不回落 → noRelease=true', r1.noRelease === true);
  ok('loadMemory leakSuspect 含「堆单调增长」', /堆单调增长/.test(r1.leakSuspect), r1.leakSuspect);
  const c1 = D.memoryCandidates(r1.cur);
  ok('memoryCandidates 单调增结果 → heap_growth', c1[0].kind === 'memory.heap_growth', c1[0].kind);

  // 场景2/3:near_limit / stable
  ok('memoryCandidates ratio0.9 → near_limit', D.memoryCandidates({ ratio: 0.9, value: 180 * 1048576, limit: 200 * 1048576 })[0].kind === 'memory.near_limit');
  ok('memoryCandidates 平稳 → stable', D.memoryCandidates({ value: 10 * 1048576, heapSlopeMB: 0.1, ratio: 0.05 })[0].kind === 'memory.stable');
  ok('memoryCandidates dom_bloat → weak_ref 族', D.memoryCandidates({ domCount: 6000, domSlope: 100, value: 30 * 1048576 })[0].suggestedHealIds.includes('weak_ref'));

  // localize.memory route
  ok('localize.memory(ratio0.9) dominant=near_limit dimension=leak', LOC.memory({ ratio: 0.9 }).dominant === 'near_limit' && LOC.memory({ ratio: 0.9 }).dimension === 'leak');
  ok('localize.memory heap_growth 族含 clear_timers', LOC.memory({ heapSlopeMB: 2, value: 50 * 1048576 }).family.includes('clear_timers'));
  ok('route(memory) 走 memory', LOC.route('memory', { ratio: 0.9 }).signal === 'memory');

  // linearSlope 属性
  ok('linearSlope 单调增 → 正', D.linearSlope([1, 2, 3, 4, 5]) > 0);
  ok('linearSlope 单调减 → 负', D.linearSlope([5, 4, 3, 2, 1]) < 0);
  ok('linearSlope 常量 → 0', D.linearSlope([3, 3, 3, 3]) === 0);
  ok('linearSlope <2 样本 → 0(安全降级)', D.linearSlope([5]) === 0);

  // analyzeRootCause memory 分支
  const arc = await D.analyzeRootCause('memory', { value: 50 * 1048576, limit: 200 * 1048576, ratio: 0.25, heapSlopeMB: 2, domSlope: 10, domCount: 1000 });
  ok('analyzeRootCause(memory) signal=memory + 泄漏判定', arc.signal === 'memory' && arc.verdict.title === '泄漏判定');
  ok('analyzeRootCause(memory) hypotheses 含 heap_growth', arc.hypotheses.some((h) => /heap_growth/.test(h.label)));
  ok('analyzeRootCause(memory) evidenceSteps 4 步 + advisory 标注', arc.evidenceSteps.length === 4 && arc.evidenceSteps[3].text.includes('advisory'));

  // checklist memory 域 + mr-draft memory 模板(知识→解法链完整)
  loadModule('checklist.js'); loadModule('mr-draft.js');
  const CL = globalThis.__checklist, MR = globalThis.__inpMrDraft;
  ok('checklist.memory ≥6 条', CL.CHECKLIST.memory.length >= 6);
  ok('checklist.memory inject_cleanup 挂运行时模板', CL.CHECKLIST.memory.some((m) => m.healId === 'inject_cleanup'));
  ok('mr-draft 含 clear_timers + weak_ref 模板', !!MR.TEMPLATE_DIFFS.clear_timers && !!MR.TEMPLATE_DIFFS.weak_ref);
}

// ============ FPS(rateSig 反向 + localize.fps)============
{
  ok('rateSig fps 反向:60=good', D.rateSig('fps', 60) === 'good');
  ok('rateSig fps 反向:40=warn', D.rateSig('fps', 40) === 'warn');
  ok('rateSig fps 反向:20=bad', D.rateSig('fps', 20) === 'bad');
  const lf = LOC.fps({ value: 20 });
  ok('localize.fps 20fps → low_fps + 族含 debounce_handler', lf.dominant === 'low_fps' && lf.family.includes('debounce_handler'), JSON.stringify(lf.family));
  ok('localize.fps 60fps → smooth(无修复族)', LOC.fps({ value: 60 }).dominant === 'smooth' && LOC.fps({ value: 60 }).family.length === 0);
  ok('route(fps) 走 fps', LOC.route('fps', { value: 20 }).signal === 'fps');
  ok('SIGNALS.fps 存在 + thr.good=50/poor=30', !!D.SIGNALS.fps && D.SIGNALS.fps.thr.good === 50 && D.SIGNALS.fps.thr.poor === 30);
}

// ============ host scope 域名隔离(P5)============
{
  const store2 = { events: [
    { host: 'a.com', eventId: 'a1', value: 600, timestamp: 1, type: 'vital', subType: 'inp' },
    { host: 'a.com', eventId: 'a2', value: 550, timestamp: 2, type: 'vital', subType: 'inp' },
    { host: 'b.com', eventId: 'b1', value: 700, timestamp: 3, type: 'vital', subType: 'inp' },
  ] };
  globalThis.__inpDb = { put: async () => {}, getAll: async (k) => store2[k] || [], count: async () => 0, clear: async () => {} };
  D.clearEventsCache();
  D.setHostScope('a.com');
  const a = await D.allEvents();
  ok('host scope a.com → 只该 host 事件(2 条)', a.length === 2 && a.every((e) => e.host === 'a.com'), 'len=' + a.length);
  D.setHostScope('b.com');
  const b = await D.allEvents();
  ok('host scope b.com → 只该 host 事件(1 条)', b.length === 1 && b[0].host === 'b.com');
  D.setHostScope(null);
  const all = await D.allEvents();
  ok('host scope null → 全部(3 条,向后兼容)', all.length === 3);
  D.setHostScope(null);
}

// ============ ③b① pre-AI 规则读源码(scopeHeft:heavy_handler 真检函数体)============
{
  const D2 = globalThis.__inpDiagnose;
  const base = { inputDelay: 10, processingDuration: 80, presentationDelay: 10, value: 100, interactionTarget: 'b', origin: 'o' };
  const find = (ev) => D2.analyzeRootCauses(ev).find((c) => c.kind === 'inp.processing.heavy_handler');
  const noScope = find(base);
  ok('heavy_handler 无源码 → 纯阈值 conf≈0.65', Math.abs(noScope.confidence - 0.65) < 0.01, 'conf=' + noScope.confidence);
  const confirm = find(Object.assign({}, base, { resolvedScript: { scope: { body: 'for(let i=0;i<n;i++){work()}', antiPatterns: [{ id: 'large_sync_loop' }] } } }));
  ok('heavy_handler 源码确认(同步重活)→ conf +0.15≈0.80', Math.abs(confirm.confidence - 0.8) < 0.01, 'conf=' + confirm.confidence);
  ok('heavy_handler 源码确认 → evidence 含「源码核对」', confirm.evidence.some((e) => /源码核对/.test(e)));
  const contradict = find(Object.assign({}, base, { resolvedScript: { scope: { body: 'return 1;', antiPatterns: [] } } }));
  ok('heavy_handler 源码反驳(无同步重活)→ conf -0.10≈0.55', Math.abs(contradict.confidence - 0.55) < 0.01, 'conf=' + contradict.confidence);
}

// ============ ③b② grounding 持久化 + analyzeRootCause 写回 ============
{
  const store = { events: [], attributions: [] };
  globalThis.__inpDb = { put: async (s, v) => { store[s] = store[s] || []; const i = store[s].findIndex((x) => x.eventId === v.eventId); if (i >= 0) store[s][i] = v; else store[s].push(v); }, getAll: async (s) => store[s] || [], count: async () => 0, clear: async () => {} };
  const D = globalThis.__data;
  D.clearEventsCache();
  await D.recordAiRca('evt-1', { rootCause: 'foo bug', confidence: 0.7, grounding: { ok: false, missingFiles: ['x.ts'] } });
  const got = await D.getAiRca('evt-1');
  ok('recordAiRca/getAiRca round-trip', got && got.rootCause === 'foo bug' && got.grounding.ok === false, JSON.stringify(got));
  const arc = await D.analyzeRootCause('inp', { eventId: 'evt-1', value: 600, inputDelay: 300, processingDuration: 250, presentationDelay: 50, interactionTarget: 'btn', origin: 'o' });
  ok('analyzeRootCause 写回 aiRca(已持久化)', arc.aiRca && arc.aiRca.rootCause === 'foo bug', JSON.stringify(arc.aiRca && arc.aiRca.rootCause));
  ok('analyzeRootCause grounding 未通过 → verdict.aiGrounding=ungrounded', arc.verdict && arc.verdict.aiGrounding === 'ungrounded', 'aiG=' + (arc.verdict && arc.verdict.aiGrounding));
  // 无 aiRca 的事件 → 不影响(aiRca 字段缺)
  const arc2 = await D.analyzeRootCause('inp', { eventId: 'evt-none', value: 600, inputDelay: 300, processingDuration: 250, presentationDelay: 50, interactionTarget: 'btn', origin: 'o' });
  ok('analyzeRootCause 无持久化 aiRca → aiRca 字段缺(不崩)', arc2.aiRca === undefined || arc2.aiRca === null);
}

// ============ sidecar.js · buildFindings payload shape(扩展→vc-mcp 契约)============
{
  const sc = globalThis.__vcSidecar;
  ok('sidecar.js 加载(__vcSidecar)', !!sc);
  const sp = sc.splitPathSymbol('src/Foo.tsx · handleX');
  ok('splitPathSymbol 拆 file+symbol', sp.file === 'src/Foo.tsx' && sp.symbol === 'handleX', JSON.stringify(sp));
  ok('splitPathSymbol 无 symbol → 整串为 file', sc.splitPathSymbol('src/Foo.tsx').file === 'src/Foo.tsx');
  const payload = sc.buildFindings({
    aiHeal: { diff: { search: 'return null;', replace: 'return 0;', explanation: '兜底', risk: 'low', riskReason: '防 null' } },
    verification: { accepted: true, reason: '命中', confidence: 0.85 },
    aiDiag: { rootCause: 'foo() 返回 null 崩溃', confidence: 0.8, evidence: ['e1'] },
    codeSlices: [{ path: 'webpack:///./src/Foo.tsx · handleX', symbol: 'handleX', content: '...' }],
    event: { eventId: 'evt-1', host: 'app.x.com', origin: 'https://app.x.com', route: '/p', resolvedFrames: [{ source: 'src/Bar.ts', scope: { symbol: 'bar' } }] },
    signal: 'inp',
  });
  ok('buildFindings diff 透传(含 riskReason)', payload.diff.search === 'return null;' && payload.diff.replace === 'return 0;' && payload.diff.riskReason === '防 null');
  ok('buildFindings rootCause/confidence/verification', payload.rootCause === 'foo() 返回 null 崩溃' && payload.confidence === 0.8 && payload.verification.accepted === true);
  ok('buildFindings targets[0] = codeSlices[0] 原始 source(file 未归一,vc-mcp 侧归一)', payload.targets[0].file === 'webpack:///./src/Foo.tsx' && payload.targets[0].symbol === 'handleX');
  ok('buildFindings targets 兜底候选 resolvedFrames.source', payload.targets.some((t) => t.file === 'src/Bar.ts'));
  ok('buildFindings 每 target 带 search/replace(无 diff 字段)', payload.targets.every((t) => t.diff === undefined && t.search === 'return null;' && t.replace === 'return 0;'));
  ok('buildFindings 带 host/origin/route/signal/eventId', payload.host === 'app.x.com' && payload.signal === 'inp' && payload.eventId === 'evt-1');
  ok('buildFindings riskScore 映射(low→0.2)', payload.riskScore === 0.2);
}

// ============ 汇总 ============
const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length} checks) ====`);
process.exit(failed.length ? 1 : 0);
