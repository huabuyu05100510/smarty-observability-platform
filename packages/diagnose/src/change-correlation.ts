/**
 * @monit/diagnose/change-correlation - 变更关联根因（P1，MTTR 杀手）
 *
 * 业界公认范式（Datadog Watchdog / 阿里 ARMS）："最近什么变了（deploy/AB/依赖变更）"
 * × 异常激增 的时序/版本相关性。**关联型，非真因果**（调研证实生产 RCA 偏关联而非 SCM）。
 *
 * 产出 AttributionCandidate（kind=deployment/dependency/traffic_spike），
 * 作为 AttributionRecord.candidates 的一条，与确定性规则候选并列排序。
 * 关联强度由时间窗口与版本匹配度决定，confidence 上限 0.7（关联≠因果，留余地）。
 */

import type { AttributionCandidate } from '@monit/contracts';

export interface ChangeEvent {
  id: string;
  kind: 'deployment' | 'dependency' | 'feature_flag' | 'infra';
  /** 发生时间戳 */
  at: number;
  /** 关联版本/release */
  release?: string;
  /** 变更描述 */
  summary: string;
  /** commit sha */
  commitSha?: string;
}

export interface AnomalySignal {
  /** 异常开始时间 */
  startedAt: number;
  /** 异常激增倍率（相对于基线，如 3 = 3x） */
  spikeRatio: number;
  /** 关联的 release（若已知） */
  release?: string;
  metric?: string;
}

export interface CorrelationOptions {
  /** 变更与异常的最大时间窗（ms），默认 30 分钟 */
  windowMs?: number;
  /** 关联置信度上限 */
  maxConfidence?: number;
}

/**
 * 计算变更关联候选。返回 null 表示无显著关联。
 *
 * 关联强度 = 时间邻近度 × 版本匹配度 × 激增倍率，封顶 maxConfidence。
 * - 时间邻近：变更发生在异常前 windowMs 内，越近越强
 * - 版本匹配：变更 release == 异常 release 则加权
 * - 激增倍率：spikeRatio 越高越可能由变更引起
 */
export function correlateChange(
  changes: ChangeEvent[],
  anomaly: AnomalySignal,
  opts: CorrelationOptions = {},
): AttributionCandidate | null {
  const windowMs = opts.windowMs ?? 30 * 60 * 1000;
  const maxConfidence = opts.maxConfidence ?? 0.7;

  // 找异常发生前 windowMs 内、最近的变更
  const preceding = changes
    .filter(c => c.at <= anomaly.startedAt && anomaly.startedAt - c.at <= windowMs)
    .sort((a, b) => b.at - a.at); // 最近在前

  if (preceding.length === 0) return null;

  const change = preceding[0];
  const elapsed = anomaly.startedAt - change.at;
  const timeCloseness = 1 - elapsed / windowMs; // 0..1，越近越接近 1
  const versionMatch = change.release && anomaly.release && change.release === anomaly.release ? 1 : 0.6;
  const spikeFactor = Math.min(1, anomaly.spikeRatio / 5); // 5x 激增封顶

  const confidence = Math.min(
    maxConfidence,
    0.4 * timeCloseness + 0.3 * versionMatch + 0.3 * spikeFactor,
  );

  const kind: AttributionCandidate['kind'] =
    change.kind === 'deployment'
      ? 'deployment'
      : change.kind === 'dependency'
        ? 'dependency'
        : change.kind === 'infra'
          ? 'infra_failure'
          : 'traffic_spike';

  return {
    kind,
    confidence,
    evidence: [
      `${change.kind} "${change.summary}" at ${new Date(change.at).toISOString()}`,
      `anomaly started ${Math.round(elapsed / 1000)}s after change (spike ${anomaly.spikeRatio}x)`,
      versionMatch === 1 ? `release match: ${change.release}` : 'no release match',
    ],
    anchors: {
      commitSha: change.commitSha,
    },
    suggestedHealIds: [],
  };
}