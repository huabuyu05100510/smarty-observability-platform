/**
 * @monit/repair-agent/regression-runner - 回归验证（3-replay 多数投票）
 *
 * 吸收 sentinel-x sandbox/regression-runner.ts 的核心机制：
 * 不信任 LLM 置信度，信任测试。注入补丁后回放用户行为 N 次，
 * 多数通过（passVotes >= ceil(N/2)）才算修复，处理概率性错误。
 *
 * 对标：SWE-bench 经验 -- "通过测试 ≠ 真正修复"，故需多次回放投票，
 * 并结合 Verifier 的逻辑验证（注入前）形成双层护栏。
 */

import type { PatchResult, PatchVerdict } from '@monit/contracts';

export interface RegressionOptions {
  /** 回放次数，默认 3 */
  replays?: number;
  /** 通过阈值（多数），默认 ceil(N/2) */
  threshold?: number;
}

/**
 * @param checkFn 回放一次后检查错误是否仍触发。返回 true=错误仍存在（未修复），false=已修复。
 *                抽象出来便于测试（真实环境由 CDP 注入后回放用户行为）。
 * @param resetFn 每次回放前重置错误计数
 */
export async function runRegression(
  proposalId: string,
  checkFn: () => Promise<boolean> | boolean,
  resetFn: () => Promise<void> | void,
  opts: RegressionOptions = {},
): Promise<PatchResult> {
  const replays = opts.replays ?? 3;
  const threshold = opts.threshold ?? Math.ceil(replays / 2);

  let passes = 0;
  for (let i = 0; i < replays; i++) {
    await resetFn();
    const errorStillFires = await checkFn();
    if (!errorStillFires) passes++;
  }

  const regressionPassed = passes >= threshold;
  const verdict: PatchVerdict = regressionPassed
    ? passes === replays
      ? 'fixed'
      : 'partial'
    : 'failed';

  return {
    proposalId,
    verdict,
    injected: true,
    regressionPassed,
    replays,
    passes,
  };
}