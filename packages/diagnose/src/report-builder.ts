/**
 * @monit/diagnose/report-builder - L3 事件流 -> L4 诊断报告（聚合胶水）
 *
 * 把 collector 上报的 MonitorEvent[] 归约成 DiagnosticReport，
 * 供 analyzeRootCauses / diagnoseWithCorrelation 消费。
 *
 * 这是 L1/L3（事件流）与 L4（诊断）之间的缺失胶水：
 * 后端存储的是 per-signal MonitorEvent，诊断需要 per-session 快照 DiagnosticReport。
 */

import type {
  DiagnosticReport,
  ErrorSignal,
  InpAttribution,
  LoafEntry,
  LongTaskSignal,
  MonitorEvent,
  VitalMetric,
} from '@monit/contracts';

export interface BuildReportOptions {
  url?: string;
  route?: string;
  /** 取最近 N 条错误（防海量） */
  maxErrors?: number;
}

/**
 * MonitorEvent[] -> DiagnosticReport。
 * - type='error' -> ErrorSignal[]
 * - type='vital' subType='inp' -> InpAttribution（payload 即 InpAttribution）
 * - type='vital' 其他 -> VitalMetric[]
 * - type='long-task' -> LongTaskSignal[]
 * - inp.longAnimationFrameEntries -> loafEntries
 */
export function buildReportFromEvents(
  events: MonitorEvent[],
  opts: BuildReportOptions = {},
): DiagnosticReport {
  const maxErrors = opts.maxErrors ?? 100;
  const errors: ErrorSignal[] = [];
  const vitals: VitalMetric[] = [];
  const longTasks: LongTaskSignal[] = [];
  const loafEntries: LoafEntry[] = [];
  let inp: InpAttribution | undefined;
  let createdAt = Date.now();

  for (const e of events) {
    createdAt = Math.min(createdAt, e.timestamp);
    if (e.type === 'error') {
      const p = e.payload as Partial<ErrorSignal> & { message?: string };
      errors.push({
        id: e.id,
        type: (e.subType === 'react' ? 'react' : e.subType === 'promise' ? 'promise' : e.subType === 'resource' ? 'resource' : 'js') as ErrorSignal['type'],
        message: p.message ?? e.subType,
        stack: p.stack,
        filename: p.filename,
        lineno: p.lineno,
        colno: p.colno,
        timestamp: e.timestamp,
        sourceURL: p.sourceURL,
        componentStack: p.componentStack,
        handled: p.handled,
      });
    } else if (e.type === 'vital') {
      if (e.subType === 'inp') {
        const attr = e.payload as InpAttribution;
        inp = attr;
        if (attr.longAnimationFrameEntries) {
          loafEntries.push(...attr.longAnimationFrameEntries);
        }
      } else {
        const m = e.payload as VitalMetric;
        if (m && typeof m.value === 'number') vitals.push(m);
      }
    } else if (e.type === 'long-task') {
      const lt = e.payload as LongTaskSignal;
      if (lt) longTasks.push(lt);
    }
  }

  // 截断错误，取最近 maxErrors
  const trimmedErrors = errors.slice(-maxErrors);

  const issueCount =
    (inp && inp.value >= 200 ? 1 : 0) +
    trimmedErrors.length +
    longTasks.filter(t => t.duration >= 100).length;
  const worstSeverity = trimmedErrors.length > 0 ? 'critical' : inp && inp.value > 500 ? 'critical' : issueCount > 0 ? 'warning' : 'info';

  return {
    id: `report-${createdAt}`,
    url: opts.url ?? '',
    route: opts.route,
    createdAt,
    vitals,
    inp,
    errors: trimmedErrors,
    longTasks,
    loafEntries,
    summary: {
      issueCount,
      worstSeverity,
      headline:
        worstSeverity === 'critical'
          ? `${trimmedErrors.length} errors + ${issueCount} issues`
          : `${issueCount} issues detected`,
    },
  };
}