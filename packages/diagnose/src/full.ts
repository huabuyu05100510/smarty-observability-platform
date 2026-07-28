/**
 * @monit/diagnose/full - 多源归因（确定性规则 + 变更关联）
 *
 * 把 correlateChange 的候选并入 AttributionRecord.candidates 链，
 * 使根因候选真正多源：确定性规则候选（inp / error 类）+ 变更关联候选
 * （kind=deployment/dependency/...），按置信度统一排序。
 *
 * 对标 Datadog Watchdog：拓扑感知关联 + 预定义根因模板，关联型非真因果。
 */

import type { AttributionRecord, DiagnosticReport } from '@monit/contracts';
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