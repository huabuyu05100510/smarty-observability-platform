/**
 * @monit/causal/patch-validation · ⚠️ experimental
 * 把 InterventionProtocol 接到 patch 验证:在 applied/reverted 两态间交替切换 + 测量,
 * 产出统计裁决。供闭环 agent 在【交付前】验证"patch 真改善指标"——把自愈验证从
 * 单次 before/after 升级为统计显著性实验。
 *
 * 调用方负责:measure(真实页面/回放/或 mock)+ apply/revert(真实 patch 句柄)。
 * 本函数只做采样编排 + 统计,可独立测试(注入 mock apply/revert/measure)。
 */

import { InterventionProtocol, type ExperimentResult, type Hypothesis } from './experiment';

export interface PatchCausalValidationOptions {
  /** 测量当前状态指标值(状态由 apply/revert 决定)*/
  measure: () => Promise<number>;
  /** 应用 patch → treated 状态(须 idempotent)*/
  applyPatch: () => Promise<void>;
  /** 回滚 patch → baseline 状态(须 idempotent)*/
  revertPatch: () => Promise<void>;
  metric?: string;
  /** 优化方向,默认 decrease(如降 INP)*/
  direction?: 'decrease' | 'increase';
  alpha?: number;
  samples?: number;
  claim?: string;
}

/**
 * 在 patch applied/reverted 两态交替采样,跑 Welch t 统计裁决。
 * 返回 ExperimentResult;调用方据 conclusion 决定交付(accepted=统计显著改善)。
 *
 * 协议交替:baseline(revert→measure)、treated(apply→measure),各 samples 次。
 * 结束时处于 treated(applied)状态——若调用方决定不交付,须自行 revert 清理。
 */
export async function runCausalValidationOnPatch(opts: PatchCausalValidationOptions): Promise<ExperimentResult> {
  const proto = new InterventionProtocol({ alpha: opts.alpha, minSamples: opts.samples ?? 8 });
  const hyp: Hypothesis = {
    claim: opts.claim ?? `patch ${opts.direction ?? 'decrease'}s ${opts.metric ?? 'metric'}`,
    intervention: 'patch',
    expectedDirection: opts.direction ?? 'decrease',
    metric: opts.metric ?? 'metric',
  };
  const baseline = async () => {
    await opts.revertPatch();
    return { value: await opts.measure() };
  };
  const treated = async () => {
    await opts.applyPatch();
    return { value: await opts.measure() };
  };
  return proto.run(hyp, baseline, treated, opts.samples ?? 8);
}
