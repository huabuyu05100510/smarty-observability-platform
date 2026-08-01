/**
 * @monit/repair-agent/confidence - 【遗留】加权 score 信心门禁
 *
 * ⚠️ 遗留实现：用未校准的加权 score（0.35/0.30/0.15/0.20，阈值 0.7）做门禁，
 *    属于"伪精度"——加权无依据、阈值拍脑袋。且本函数【不校验 reproRedBefore / contamination】，
 *    因此无法防止"通过测试≠真修复"的假阳性。
 *
 * 现行门禁请用 {@link import('./gate').assessGate | assessGate}：
 *   - 确定性布尔向量 GateVector（repro 红转绿 / 套件 / 局部 / 污染 / Verifier）
 *   - 显式档位匹配（auto-mr / hotfix / human），AI 不持有门禁
 *   - 由 {@link import('./pipeline').runHealPipeline | runHealPipeline} 真正驱动
 *
 * 本模块仅保留向后兼容（旧 runHarness 路径），新代码勿用，README 示例亦应指向 assessGate。
 */

import type { ConfidenceTier, PatchResult, VerifierResult } from '@monit/contracts';

export interface LocalitySignals {
  /** 补丁涉及的文件数 */
  filesChanged: number;
  /** 补丁总行数 */
  linesChanged: number;
  /** 是否有对应测试覆盖 */
  hasTestCoverage: boolean;
  /** 是否类型检查通过 */
  typecheckPasses: boolean;
}

export interface ConfidenceGateInput {
  verifier: VerifierResult;
  regression: PatchResult;
  locality: LocalitySignals;
}

export interface ConfidenceGateOutput {
  tier: ConfidenceTier;
  score: number; // 0-1
  reasons: string[];
  /** 自动应用建议（仅 high 时为 true） */
  canAutoApply: boolean;
}

/**
 * @deprecated 遗留加权 score 门禁（未校准伪精度，且不校验 reproRedBefore/contamination）。
 * 新代码请用 {@link import('./gate').assessGate | assessGate}（确定性布尔向量门禁）。
 *
 * 确定性信心评分。每项 0/1，加权求和，阈值 0.7 -> high。
 * - Verifier 不被否（0.35）：逻辑验证通过，反事实未击穿
 * - 回归通过（0.30）：经验验证，错误不再复现
 * - 改动局部（0.15）：filesChanged<=1 && linesChanged<=50
 * - 测试覆盖 + 类型通过（0.20）：双重确定性兜底
 */
export function assessConfidence(input: ConfidenceGateInput): ConfidenceGateOutput {
  const { verifier, regression, locality } = input;
  const reasons: string[] = [];
  let score = 0;

  // 1. Verifier 逻辑验证
  if (!verifier.refuted) {
    score += 0.35;
    reasons.push(`Verifier accepted (confidence ${verifier.confidence.toFixed(2)})`);
  } else {
    reasons.push(`Verifier REFUTED: ${verifier.reason}`);
  }

  // 2. 回归经验验证
  if (regression.regressionPassed) {
    score += 0.3;
    reasons.push(`Regression ${regression.verdict} (${regression.passes}/${regression.replays} replays)`);
  } else {
    reasons.push(`Regression FAILED (${regression.passes}/${regression.replays})`);
  }

  // 3. 改动局部性
  const isLocal = locality.filesChanged <= 1 && locality.linesChanged <= 50;
  if (isLocal) {
    score += 0.15;
    reasons.push(`Local change (${locality.filesChanged} file, ${locality.linesChanged} lines)`);
  } else {
    reasons.push(`Non-local change (${locality.filesChanged} files, ${locality.linesChanged} lines)`);
  }

  // 4. 测试覆盖 + 类型检查（确定性兜底）
  if (locality.hasTestCoverage) {
    score += 0.1;
    reasons.push('Has test coverage');
  }
  if (locality.typecheckPasses) {
    score += 0.1;
    reasons.push('Typecheck passes');
  }

  const tier: ConfidenceTier =
    !verifier.refuted && regression.regressionPassed && score >= 0.7 ? 'high' : 'low';
  // 自动应用必须同时满足：Verifier 不否 + 回归通过 + 改动局部 + 类型通过
  // （测试覆盖是加分项但非硬性，因为很多修复场景无现成测试）
  // 回归失败/Verifier 否决 = 补丁没真正修好或诊断站不住 -> 永不自动应用
  const canAutoApply =
    !verifier.refuted &&
    regression.regressionPassed &&
    isLocal &&
    locality.typecheckPasses;

  return { tier, score, reasons, canAutoApply };
}