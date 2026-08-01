/**
 * causal + scenario 端到端演示:科学闭环(假设 → 干预 → 统计 → 裁决)。
 *
 * 用 mock ScenarioBrowser(无需 Chromium);真实环境把 mockBrowser 换成 puppeteer 适配器:
 *   import puppeteer from 'puppeteer-core';
 *   const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
 *   // b.newPage()/page.goto/click/evaluate 与 ScenarioBrowser 接口一致
 *
 * 跑:先 pnpm build,再 node scripts/causal-scenario-demo.mjs
 */
import { runCausalValidationOnPatch } from '../packages/causal/dist/index.js';
import { runScenarioMeasure, scenario } from '../packages/scenario/dist/index.js';

// mock:patchState 由 apply/revert 切换;measure 返回值反映 handler 快慢(INP 代理指标)
let patchState = 'buggy';
const measureValue = () => (patchState === 'patched' ? 350 + Math.random() * 25 : 620 + Math.random() * 25);

const mockBrowser = {
  newPage: async () => ({
    goto: async () => {}, click: async () => {}, type: async () => {}, waitForTimeout: async () => {},
    evaluate: async () => measureValue(),
    close: async () => {},
  }),
  close: async () => {},
};

const s = scenario('inp-click', 'http://localhost:5179', [
  { type: 'goto' },
  { type: 'click', selector: '#slow-btn' },
  { type: 'measure', script: 'window.__lastClickDelay' },
]);

console.log('╔══ causal + scenario 科学闭环演示 ══╗');
console.log('║ 假设:patch 降低点击响应延迟(INP 代理)');
console.log('║ 干预:apply/revert patch,各采样 8 次');
console.log('║ 裁决:Welch t 统计显著性\n');

const r = await runCausalValidationOnPatch({
  measure: async () => runScenarioMeasure(s, mockBrowser),
  applyPatch: async () => { patchState = 'patched'; },
  revertPatch: async () => { patchState = 'buggy'; },
  direction: 'decrease', samples: 8, metric: 'INP-proxy', claim: 'patch 降低点击响应延迟',
});

console.log(`baseline mean: ${r.baseline.mean.toFixed(1)} ms (n=${r.baseline.n})`);
console.log(`treated  mean: ${r.treated.mean.toFixed(1)} ms (n=${r.treated.n})`);
console.log(`effect: ${r.effectSize.toFixed(1)} ms (${(r.relativeChange * 100).toFixed(1)}%)`);
console.log(`Welch t=${r.tStatistic.toFixed(2)}, p=${r.pValue.toFixed(4)}, alpha=${r.alpha}`);
console.log(`conclusion: ${r.conclusion} (significant=${r.significant})`);
console.log(r.conclusion === 'accepted' ? '\n✓ 统计显著改善 → agent 放行交付' : '\n✗ 未达显著 → agent fail-closed 降级 human');

// 对照:无效 patch(无差异 → inconclusive → 降级)
console.log('\n── 对照:无效 patch(无差异)──');
const fixedBrowser = {
  newPage: async () => ({
    goto: async () => {}, click: async () => {}, type: async () => {}, waitForTimeout: async () => {},
    evaluate: async () => 500,
    close: async () => {},
  }),
  close: async () => {},
};
const r2 = await runCausalValidationOnPatch({
  measure: async () => runScenarioMeasure(s, fixedBrowser),
  applyPatch: async () => {}, revertPatch: async () => {},
  direction: 'decrease', samples: 8,
});
console.log(`effect: ${r2.effectSize.toFixed(1)}, p=${r2.pValue.toFixed(3)}, conclusion: ${r2.conclusion} → 降级`);
