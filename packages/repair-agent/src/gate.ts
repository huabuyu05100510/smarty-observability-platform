/**
 * @monit/repair-agent/gate - 确定性布尔向量门禁（BP-4）
 *
 * 替代旧 assessConfidence 的加权 score（未校准伪精度）。
 * 门禁是【确定性策略】：交付档位 = 显式向量匹配，AI 不持有门禁。
 *
 * 研究原则（§6）："AI 只做语义、确定性规则做最终门禁（幻觉风险）"。
 * GateVector 各字段由确定性检查 + 独立模型 Verifier 填充，本函数只做布尔合取判定。
 *
 * 交付档位：
 * - auto-mr：verifier=pass & reproRedBefore & reproGreenAfter & suiteGreen
 *            & typecheck & locality.ok & contamination=clean
 * - hotfix ：verifier=pass & reproGreenAfter & behaviorPreserving（可逆治标）
 * - human  ：任一不满足 -> 永不自动
 *
 * Verifier=skipped（未配独立模型）：auto-mr 不可达，最多 hotfix 且标 reason。
 * 回归/Verifier 否决 = 硬阻断，无论 AI 自报多高。
 */

import type { GateVector, HealDelivery, HealDecision } from '@monit/contracts';

/** auto-MR 的局部性硬阈值（≤1 文件 / ≤50 行）*/
export const AUTO_MR_MAX_FILES = 1;
export const AUTO_MR_MAX_LINES = 50;

export function localityOk(loc: { files: number; lines: number }): boolean {
  return loc.files <= AUTO_MR_MAX_FILES && loc.lines <= AUTO_MR_MAX_LINES;
}

/**
 * 由 GateVector 判定交付档位。纯函数，确定性。
 */
export function assessGate(gate: GateVector): HealDecision {
  const reasons: string[] = [];

  const local = localityOk(gate.locality);
  const verifierPassed = gate.verifier === 'pass';
  const verifierSkipped = gate.verifier === 'skipped';
  const verifierRefuted = gate.verifier === 'refuted';

  if (verifierRefuted) reasons.push('Verifier REFUTED: 诊断站不住，硬阻断');
  if (verifierSkipped) reasons.push('Verifier skipped: 未配独立模型，自动交付不可达，转人工');
  if (!gate.verifierConfident && !verifierRefuted && !verifierSkipped) reasons.push('Verifier 置信度低: 弱验证，不放行自动交付');
  if (!gate.reproRedBefore) reasons.push('repro 测试未在打补丁前失败: 复现无效，回炉重生成');
  if (!gate.reproGreenAfter) reasons.push('repro 测试打补丁后未通过: 补丁未真正修复');
  if (!gate.suiteGreen) reasons.push('现有套件被补丁破坏: 回归');
  if (!gate.typecheck) reasons.push('typecheck 未通过');
  if (!local) reasons.push(`改动非局部（${gate.locality.files} 文件 / ${gate.locality.lines} 行 > ${AUTO_MR_MAX_FILES}/${AUTO_MR_MAX_LINES}）`);
  if (gate.contamination === 'detected') reasons.push('数据污染检测命中: 疑似复现 gold patch，全档位阻断');

  // auto-MR：全闸通过 —— 独立模型 Verifier 高置信 + repro 红转绿 + 套件不破 + 类型 + 局部 + 无污染
  const canAutoMr =
    verifierPassed &&
    gate.verifierConfident &&
    gate.reproRedBefore &&
    gate.reproGreenAfter &&
    gate.suiteGreen &&
    gate.typecheck &&
    local &&
    gate.contamination === 'clean';

  // hotfix：可逆运行时热修（治标）。仍要求独立模型 Verifier 高置信 + repro 有效（红转绿）+
  // 套件不破 + 行为保留 + 无污染。skipped/refuted/低置信均不达 hotfix（强制配独立模型才能自动）。
  // 不查 typecheck（运行时注入是 JS，TS 类型运行时不存在）/ locality（可逆注入，非合并卫生）——
  // 但 contamination 全档位阻断（污染补丁疑似复现 gold patch，绝不上生产）。
  const canHotfix =
    verifierPassed &&
    gate.verifierConfident &&
    gate.reproRedBefore &&
    gate.reproGreenAfter &&
    gate.suiteGreen &&
    gate.behaviorPreserving &&
    gate.contamination === 'clean';

  let delivery: HealDelivery;
  if (canAutoMr) {
    delivery = 'auto-mr';
    reasons.unshift('auto-MR：全闸通过（独立模型 Verifier + repro 红转绿 + 套件不破 + 局部 + 无污染）');
  } else if (canHotfix) {
    delivery = 'hotfix';
    reasons.unshift('hotfix：可逆运行时热修（治标），仍人审兜底');
  } else {
    delivery = 'human';
    reasons.unshift('human：门禁未全过，转人工，AI 不自动放行');
  }

  return { delivery, gate, reasons };
}
