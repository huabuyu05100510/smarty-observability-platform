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
loadModule('diagnose.js');
loadModule('error-diagnose.js');
loadModule('localize.js');
const causal = globalThis.__causal;
const sm = globalThis.__sourcemap;
const LOC = globalThis.__localize;

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

// ============ 汇总 ============
const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length} checks) ====`);
process.exit(failed.length ? 1 : 0);
