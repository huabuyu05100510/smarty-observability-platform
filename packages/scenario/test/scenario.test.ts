import { describe, it, expect } from 'vitest';
import { runScenarioMeasure, scenario, type ScenarioBrowser, type ScenarioPage } from '../src';

function mockPage(measureValue: number): { page: ScenarioPage; calls: string[] } {
  const calls: string[] = [];
  const page: ScenarioPage = {
    goto: async (url) => { calls.push(`goto:${url}`); },
    click: async (sel) => { calls.push(`click:${sel}`); },
    type: async (sel, val) => { calls.push(`type:${sel}=${val}`); },
    waitForTimeout: async (ms) => { calls.push(`wait:${ms}`); },
    evaluate: async (script: string) => { calls.push(`eval:${script.slice(0, 32)}`); return measureValue as unknown as never; },
    close: async () => { calls.push('close'); },
  };
  return { page, calls };
}

describe('scenario · 执行重放 measure 测试床', () => {
  it('按序跑 actions,返回最后 measure 值', async () => {
    const { page, calls } = mockPage(420);
    const browser: ScenarioBrowser = { newPage: async () => page, close: async () => {} };
    const s = scenario('inp-click', 'http://x', [
      { type: 'goto' },
      { type: 'click', selector: '#btn' },
      { type: 'wait', delayMs: 50 },
      { type: 'measure', script: 'performance.now()' },
    ]);
    const v = await runScenarioMeasure(s, browser);
    expect(v).toBe(420);
    expect(calls).toEqual(['goto:http://x', 'click:#btn', 'wait:50', 'eval:performance.now()', 'close']);
  });

  it('无 measure action → 抛错(causal fail-closed 捕获降级)', async () => {
    const { page } = mockPage(0);
    const browser: ScenarioBrowser = { newPage: async () => page, close: async () => {} };
    const s = scenario('no-measure', 'http://x', [{ type: 'goto' }]);
    await expect(runScenarioMeasure(s, browser)).rejects.toThrow(/no finite measure/);
  });

  it('page 抛错 → 透传(浏览器失败由 causal fail-closed 捕获)', async () => {
    const page: ScenarioPage = {
      goto: async () => { throw new Error('navigation failed'); },
      click: async () => {}, type: async () => {}, waitForTimeout: async () => {},
      evaluate: async () => 0 as unknown as never, close: async () => {},
    };
    const browser: ScenarioBrowser = { newPage: async () => page, close: async () => {} };
    const s = scenario('fail', 'http://x', [{ type: 'goto' }, { type: 'measure', script: '1' }]);
    await expect(runScenarioMeasure(s, browser)).rejects.toThrow(/navigation failed/);
  });
});
