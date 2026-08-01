/**
 * @monit/diagnose/full - 多源归因（确定性规则 + 变更关联）
 *
 * 把 correlateChange 的候选并入 AttributionRecord.candidates 链，
 * 使根因候选真正多源：确定性规则候选（inp / error 类）+ 变更关联候选
 * （kind=deployment/dependency/...），按置信度统一排序。
 *
 * 对标 Datadog Watchdog：拓扑感知关联 + 预定义根因模板，关联型非真因果。
 */

import type { AttributionRecord, AttributionCandidate, DiagnosticReport, SpanRecord } from '@monit/contracts';
import { analyzeRootCauses } from './index';
import { correlateChange, type ChangeEvent, type AnomalySignal } from './change-correlation';

export interface DiagnoseWithCorrelationInput {
  report: DiagnosticReport;
  /** 近期变更事件（发布/AB/依赖/infra） */
  changes: ChangeEvent[];
  /** 异常信号（错误激增 / 性能劣化） */
  anomaly: AnomalySignal;
}

/**
 * 多源归因：确定性规则 + 变更关联，候选链按置信度排序。
 */
export function diagnoseWithCorrelation(input: DiagnoseWithCorrelationInput): AttributionRecord[] {
  const records = analyzeRootCauses(input.report);

  // 为每条 record 追加变更关联候选（若相关）
  for (const rec of records) {
    const changeCand = correlateChange(input.changes, input.anomaly);
    if (changeCand) {
      rec.candidates.push(changeCand);
      // 按置信度降序重排
      rec.candidates.sort((a, b) => b.confidence - a.confidence);
    }
  }

  return records;
}

/**
 * 跨层 trace join（性能皇冠）：用 record.traceId 查同 trace 的慢后端 span，
 * 产 kind='dependency' candidate 指向 span，并入候选链。
 *
 * 这是多数可观测工具在吹却没做实的事：前端慢/错 -> 定位到后端具体 span。
 * record.traceId 由 analyzeRootCauses 从 report.traceId 填充；span 来自 backend SpanStore。
 */
export function joinTraceSpans(records: AttributionRecord[], spans: SpanRecord[], slowThresholdMs = 200): AttributionRecord[] {
  for (const rec of records) {
    if (!rec.traceId) continue;
    const traceSpans = spans.filter(s => s.traceId === rec.traceId && s.durationMs >= slowThresholdMs);
    if (traceSpans.length === 0) continue;
    const slowest = traceSpans.reduce((m, s) => (s.durationMs > m.durationMs ? s : m), traceSpans[0]);
    const depCand: AttributionCandidate = {
      kind: 'dependency',
      // 越慢越可能是根因，封顶 0.85（关联型，留余地）
      confidence: Math.min(0.85, 0.5 + slowest.durationMs / 4000),
      evidence: [
        `backend span "${slowest.name}" took ${slowest.durationMs}ms (kind=${slowest.kind}, status=${slowest.status})`,
        `traceId=${rec.traceId}, spanId=${slowest.spanId}${slowest.serviceName ? `, service=${slowest.serviceName}` : ''}`,
      ],
      anchors: { traceSpanId: slowest.spanId },
      suggestedHealIds: [],
    };
    rec.candidates.push(depCand);
    rec.candidates.sort((a, b) => b.confidence - a.confidence);
  }
  return records;
}