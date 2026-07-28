/**
 * @monit/repair-agent/confidence - 确定性×AI 信心门禁
 *
 * 研究原则（§6）："AI 只做规则结构上做不到的；AI 不做确定性门禁（幻觉风险）"。
 * 本模块是【确定性】门禁：综合 Verifier 结果 + 回归结果 + 改动局部性 + 测试覆盖，
 * 决定 high（自动 MR 草稿）/ low（仅诊断转人工）。
 *
 * 对标：SWE-bench Pro 企业真实 <18% -> 全自动仅限"测试充分 + 改动局部 + 强护栏"。
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