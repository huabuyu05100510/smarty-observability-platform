/**
 * @monit/scenario · ⚠️ experimental
 * 确定性场景执行重放 —— 作为 @monit/causal 统计验证的 measure 测试床。
 *
 * 为什么是"执行重放"而非 rrweb 视觉重放:causal 的 measure 需要【运行时指标】(点击延迟/INP),
 * 视觉重放(JS 不真跑)产不出。故本包做最小执行重放:声明式操作序列 + 注入浏览器抽象 +
 * 在真页面测指标。rrweb 实时录制(操作序列的实时来源)是后续工作(见 docs/录制重放系统-设计方案.md)。
 *
 * 设计:浏览器抽象 ScenarioBrowser 注入 —— scenario 包不硬依赖 puppeteer;测试用 mock,
 * 真实环境用 puppeteer 适配器(见 scripts/causal-scenario-demo.mjs)。
 */

export type ScenarioActionType = 'goto' | 'click' | 'input' | 'wait' | 'eval' | 'measure';

export interface ScenarioAction {
  type: ScenarioActionType;
  selector?: string;
  value?: string;
  delayMs?: number;
  /** eval/measure:页面内执行的 JS 表达式(measure 须返回 number) */
  script?: string;
}

export interface Scenario {
  schema: 'scenario';
  version: 1;
  name: string;
  url: string;
  actions: ScenarioAction[];
}

/** 浏览器页面抽象(对齐 puppeteer page 子集;注入以避免硬依赖) */
export interface ScenarioPage {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  type(selector: string, value: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<unknown>;
  evaluate<T>(script: string): Promise<T>;
  close(): Promise<unknown>;
}
export interface ScenarioBrowser {
  newPage(): Promise<ScenarioPage>;
  close(): Promise<unknown>;
}

/**
 * 执行场景:按序跑 actions,返回最后一个 measure action 的指标值(number)。
 * 用作 causal causalValidation.measure —— patch applied/reverted 时各跑一次,供统计裁决。
 * 抛错(无 measure / 浏览器失败)由调用方捕获(causal 已 fail-closed 降级)。
 */
export async function runScenarioMeasure(scenario: Scenario, browser: ScenarioBrowser): Promise<number> {
  const page = await browser.newPage();
  try {
    let lastMeasure: number | undefined;
    for (const a of scenario.actions) {
      switch (a.type) {
        case 'goto': await page.goto(scenario.url); break;
        case 'click': if (a.selector) await page.click(a.selector); break;
        case 'input': if (a.selector) await page.type(a.selector, a.value ?? ''); break;
        case 'wait': await page.waitForTimeout(a.delayMs ?? 100); break;
        case 'eval': if (a.script) await page.evaluate<void>(a.script); break;
        case 'measure': {
          if (!a.script) throw new Error('measure action requires script');
          lastMeasure = await page.evaluate<number>(a.script);
          break;
        }
      }
    }
    if (lastMeasure == null || !Number.isFinite(lastMeasure)) {
      throw new Error(`scenario "${scenario.name}" produced no finite measure (last=${lastMeasure})`);
    }
    return lastMeasure;
  } finally {
    await page.close();
  }
}

/** 构造场景(便利函数)。 */
export function scenario(name: string, url: string, actions: ScenarioAction[]): Scenario {
  return { schema: 'scenario', version: 1, name, url, actions };
}
