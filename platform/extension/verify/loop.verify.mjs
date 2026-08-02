// loop.verify.mjs · 自愈 loop 收敛验证(Playwright)
// 用真实 Chromium 跑:页面注入真实 causal.js(Welch t)+ heal-loop.js(runHealLoop 控制流),
// 喂合成 measure,断言 4 个场景:首候选收敛 / 次候选收敛(迭代) / 候选耗尽 inconclusive /
// 诚实性(显著下降但 treated 未进 good 段 → 不判优秀)。
// 注意:沙箱无法 load MV3 扩展,故不测 chrome.runtime 真实接线;此处验证 loop 控制流 + 真实 causal 数学,
// 这正是本次实现的核心。真实扩展 e2e 需用户本机 chrome://extensions 手动验。
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

async function runScenario(page, scenario) {
  return page.evaluate(async (cfg) => {
    const HL = globalThis.__healLoop;
    const causal = globalThis.__causal;
    const baseline = cfg.baseline;
    const cands = cfg.candidates;
    const deps = {
      baselineValues: baseline,
      initialContext: {},
      maxIters: cfg.maxIters || 5,
      localize: () => ({ phase: 'processingDuration', candidateIds: cands.map((c) => c.id) }),
      generateCandidate: (_loc, tried) => { for (const c of cands) { if (!tried.has(c.id)) return c; } return null; },
      applyProxy: async (cand) => ({ token: 'tok-' + cand.id, applyTime: Date.now() }),
      collectTreated: async (cand) => ((cfg.treatedById && cfg.treatedById[cand.id]) || cfg.treatedDefault || [600, 610, 590, 605, 595, 600]).slice(),
      rollback: async () => {},
      verify: (b, t) => causal.runCausalValidation(b, t, { direction: 'decrease', alpha: 0.05 }),
      isExcellent: (verdict, treated) => {
        const m = treated.reduce((s, x) => s + x, 0) / treated.length;
        return m > 0 && m <= 200 && !!verdict.significant && verdict.conclusion === 'accepted';
      },
      onProgress: () => {},
    };
    return await HL.runHealLoop(deps);
  }, scenario);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  await page.addScriptTag({ path: path.join(EXT, 'causal.js') });
  await page.addScriptTag({ path: path.join(EXT, 'heal-loop.js') });

  const loaded = await page.evaluate(() => ({ causal: !!globalThis.__causal, healLoop: !!globalThis.__healLoop }));
  check('模块加载(__causal / __healLoop)', loaded.causal && loaded.healLoop, JSON.stringify(loaded));

  const baseline = [600, 610, 590, 605, 595, 600, 615, 585];

  // 1. 首候选即优秀 → 1 轮收敛
  const s1 = await runScenario(page, { baseline, candidates: [{ id: 'debounce_handler', label: 'Handler 防抖', semantic: false }], treatedById: { debounce_handler: [150, 160, 155, 145, 150, 165] } });
  check('场景1 首候选即优秀→收敛(1轮)', s1.outcome === 'excellent' && s1.iterations.length === 1 && s1.winner && s1.winner.id === 'debounce_handler',
    `outcome=${s1.outcome} iters=${s1.iterations.length} p=${s1.evidence && s1.evidence.verdict.pValue.toFixed(4)}`);

  // 2. 首候选不优秀,次候选优秀 → 2 轮收敛
  const s2 = await runScenario(page, { baseline, candidates: [{ id: 'debounce_handler', label: '防抖', semantic: false }, { id: 'throttle_third_party', label: '3p节流', semantic: false }], treatedById: { debounce_handler: [590, 600, 610, 595, 605, 600], throttle_third_party: [160, 155, 170, 150, 165, 158] } });
  check('场景2 次候选收敛→迭代2轮', s2.outcome === 'excellent' && s2.iterations.length === 2 && s2.winner.id === 'throttle_third_party',
    `outcome=${s2.outcome} iters=${s2.iterations.length} winner=${s2.winner && s2.winner.id}`);

  // 3. 全候选不优秀 → inconclusive(候选耗尽)
  const s3 = await runScenario(page, { baseline, candidates: [{ id: 'debounce_handler', label: '防抖', semantic: false }, { id: 'throttle_third_party', label: '3p节流', semantic: false }], treatedDefault: [580, 590, 600, 595, 605, 598] });
  const s3Iterated = s3.iterations.filter((it) => it.phase === 'iterated').length;
  check('场景3 候选耗尽→inconclusive', s3.outcome === 'inconclusive' && s3.winner === null && s3Iterated === 2,
    `outcome=${s3.outcome} iterated=${s3Iterated}`);

  // 4. 诚实性:显著下降但 treated 仍 >200(warn 段) → 不判优秀 → inconclusive
  const s4 = await runScenario(page, { baseline, candidates: [{ id: 'debounce_handler', label: '防抖', semantic: false }], treatedDefault: [300, 310, 290, 295, 305, 300] });
  const it0 = s4.iterations[0];
  check('场景4 显著但未进good段→不优秀(诚实门禁)', s4.outcome === 'inconclusive' && it0 && it0.verdict && it0.verdict.conclusion === 'accepted' && it0.excellent === false,
    `outcome=${s4.outcome} conclusion=${it0 && it0.verdict && it0.verdict.conclusion} excellent=${it0 && it0.excellent} effect=${it0 && it0.verdict && Math.round(it0.verdict.effectSize)}`);

  await browser.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length} checks) ====`);
  await browser.close().catch(() => {});
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('VERIFY ERROR:', e); process.exit(2); });
