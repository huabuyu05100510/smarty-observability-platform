/**
 * @monit/diagnose - 确定性根因规则引擎
 *
 * 吸收 smarty-monitor/packages/diagnose 的 analyzeRootCauses / proposeHealActions，
 * 适配新的 AttributionCandidate 候选链结构（L4 产出，L5/L6 消费）。
 *
 * 确定性×AI 分工：本模块是【确定性】部分（规则可解释、无幻觉）。
 * LLM-RCA 作为另一条 candidate（kind='llm_rca'）在 P2 叠加，
 * 走 AttributionRecord.candidates 排序，不破坏确定性分。
 *
 * 对标：Datadog Watchdog（拓扑感知关联，非真因果）+ Brendan Gregg 火焰图方法论
 */

import type {
  AttributionCandidate,
  AttributionRecord,
  DiagnosticReport,
  HealAction,
  Severity,
} from '@monit/contracts';

const INP_THRESHOLD = 200; // good≤200ms, poor>500ms
const LONG_TASK_THRESHOLD = 100; // ms

function uid(prefix: string, i: number): string {
  return `${prefix}-${i}`;
}

/** 选出 INP 三段中占比最大的阶段 */
function dominantInpPhase(inp: NonNullable<DiagnosticReport['inp']>): {
  phase: 'inputDelay' | 'processingDuration' | 'presentationDelay';
  kind: 'inp.input_delay' | 'inp.processing' | 'inp.presentation';
  value: number;
} {
  const phases = [
    { phase: 'inputDelay' as const, kind: 'inp.input_delay' as const, value: inp.inputDelay },
    { phase: 'processingDuration' as const, kind: 'inp.processing' as const, value: inp.processingDuration },
    { phase: 'presentationDelay' as const, kind: 'inp.presentation' as const, value: inp.presentationDelay },
  ];
  return phases.reduce((max, p) => (p.value > max.value ? p : max), phases[0]);
}

/** 取相交 LoAF 中耗时最大的脚本 */
function topLoafScript(
  inp: NonNullable<DiagnosticReport['inp']>,
): { sourceURL?: string; sourceFunctionName?: string; loafEntryId?: string; duration: number } | null {
  const entries = inp.longAnimationFrameEntries ?? [];
  let best: { sourceURL?: string; sourceFunctionName?: string; loafEntryId?: string; duration: number } | null = null;
  for (const entry of entries) {
    for (const script of entry.scripts) {
      if (!best || script.duration > best.duration) {
        best = {
          sourceURL: script.sourceURL,
          sourceFunctionName: script.sourceFunctionName,
          loafEntryId: entry.id,
          duration: script.duration,
        };
      }
    }
  }
  return best;
}

/**
 * 确定性根因分析：DiagnosticReport -> AttributionRecord[]
 * 每条 record 携带按置信度排序的候选链（确定性规则产 1 条候选）。
 */
export function analyzeRootCauses(report: DiagnosticReport): AttributionRecord[] {
  const records: AttributionRecord[] = [];
  let i = 0;

  // ── INP 归因 ───────────────────────────────────────────────────────────
  if (report.inp && report.inp.value >= INP_THRESHOLD) {
    const dom = dominantInpPhase(report.inp);
    const topScript = topLoafScript(report.inp);
    const evidence = [
      `INP=${report.inp.value}ms (${report.inp.rating})`,
      `${dom.phase}=${dom.value}ms (dominant phase)`,
    ];
    if (topScript) {
      evidence.push(`top LoAF script: ${topScript.sourceFunctionName ?? '<anon>'} @ ${topScript.sourceURL ?? '?'}`);
    }
    const candidate: AttributionCandidate = {
      kind: dom.kind,
      confidence: topScript ? 0.85 : 0.6,
      evidence,
      anchors: {
        interactionTarget: report.inp.interactionTarget,
        scriptURL: topScript?.sourceURL,
        sourceFunctionName: topScript?.sourceFunctionName,
        loafEntryId: topScript?.loafEntryId,
      },
      suggestedHealIds:
        dom.kind === 'inp.processing'
          ? ['suggest_scheduler_yield', 'suggest_quiet_wrap']
          : dom.kind === 'inp.input_delay'
            ? ['suggest_debounce']
            : [],
    };
    records.push({
      id: uid('attr', i++),
      symptomId: report.inp.interactionTarget ?? 'inp',
      symptom: { kind: 'perf', metric: 'INP', observed: report.inp.value },
      candidates: [candidate],
      severity: report.inp.value > 500 ? 'critical' : 'warning',
      createdAt: report.createdAt,
    });
  }

  // ── 错误归因 ───────────────────────────────────────────────────────────
  for (const err of report.errors) {
    const kind =
      err.type === 'js' ? 'error.js' : err.type === 'promise' ? 'error.promise' : err.type === 'react' ? 'error.react' : 'error.resource';
    const candidate: AttributionCandidate = {
      kind,
      confidence: 0.8,
      evidence: [`${err.type} error: ${err.message}`, err.stack ? `stack-top: ${err.stack.split('\n')[0]}` : 'no stack'],
      anchors: {
        errorId: err.id,
        stackTop: err.stack?.split('\n')[1]?.trim(),
        scriptURL: err.sourceURL ?? err.filename,
      },
      suggestedHealIds:
        err.type === 'js' || err.type === 'promise'
          ? ['safe_null_guard_hint', 'inject_error_boundary_hint']
          : [],
    };
    records.push({
      id: uid('attr', i++),
      symptomId: err.id,
      symptom: { kind: 'error', observed: err.message },
      candidates: [candidate],
      severity: 'critical',
      createdAt: report.createdAt,
    });
  }

  // ── 长任务归因 ─────────────────────────────────────────────────────────
  for (const lt of report.longTasks) {
    if (lt.duration < LONG_TASK_THRESHOLD) continue;
    const candidate: AttributionCandidate = {
      kind: 'long_task',
      confidence: 0.5,
      evidence: [`long task=${lt.duration}ms`, lt.attribution?.[0]?.containerSrc ?? 'no attribution'],
      anchors: {
        scriptURL: lt.attribution?.[0]?.containerSrc,
      },
      suggestedHealIds: ['suggest_scheduler_yield'],
    };
    records.push({
      id: uid('attr', i++),
      symptomId: lt.id,
      symptom: { kind: 'perf', metric: 'longTask', observed: lt.duration },
      candidates: [candidate],
      severity: 'warning',
      createdAt: report.createdAt,
    });
  }

  // 按严重度、候选置信度排序
  const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  records.sort((a, b) => {
    const s = sevRank[a.severity] - sevRank[b.severity];
    if (s !== 0) return s;
    return (b.candidates[0]?.confidence ?? 0) - (a.candidates[0]?.confidence ?? 0);
  });

  return records;
}

/**
 * 确定性安全自愈建议（5 类白名单，safe=true，仅建议不写盘）。
 * 真正写盘改动走 AI patch + 人审（@monit/repair-agent + @monit/coordinator）。
 */
export function proposeHealActions(records: AttributionRecord[]): HealAction[] {
  const actions: HealAction[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    for (const cand of rec.candidates) {
      for (const id of cand.suggestedHealIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        actions.push(HEAL_CATALOG[id]);
      }
    }
  }
  return actions;
}

export const HEAL_CATALOG: Record<string, HealAction> = {
  suggest_scheduler_yield: {
    id: 'suggest_scheduler_yield',
    label: '调度器让步（scheduler.yield）',
    description: '长任务拆分：在同步块结束处 scheduler.yield() / setTimeout(0) 让出主线程，降低 INP processing 段。',
    safe: true,
    basedOn: '',
  },
  suggest_quiet_wrap: {
    id: 'suggest_quiet_wrap',
    label: '安静包装（quiet wrap）',
    description: '将耗时回调包装为非阻塞执行，避免阻塞下一帧渲染。',
    safe: true,
    basedOn: '',
  },
  suggest_debounce: {
    id: 'suggest_debounce',
    label: '输入防抖（debounce）',
    description: '高频输入事件 debounce，降低 input delay 段。',
    safe: true,
    basedOn: '',
  },
  inject_error_boundary_hint: {
    id: 'inject_error_boundary_hint',
    label: '注入错误边界',
    description: '在组件树关键节点加 React ErrorBoundary，捕获渲染异常防止白屏。',
    safe: true,
    basedOn: '',
  },
  safe_null_guard_hint: {
    id: 'safe_null_guard_hint',
    label: '空值守卫',
    description: '在访问 .map/.length 前加可选链 ?. 与空数组兜底，防御 Cannot read of null。',
    safe: true,
    basedOn: '',
  },
};

/** 报告摘要（issueCount / worstSeverity / headline） */
export function buildReportSummary(report: DiagnosticReport): {
  issueCount: number;
  worstSeverity: Severity;
  headline: string;
} {
  const records = analyzeRootCauses(report);
  const issueCount = records.length;
  const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  const worst = records.reduce<Severity>(
    (w, r) => (sevRank[r.severity] < sevRank[w] ? r.severity : w),
    'info' as Severity,
  );
  const headline =
    worst === 'critical'
      ? `${issueCount} critical issues need attention`
      : `${issueCount} issues detected`;
  return { issueCount, worstSeverity: worst, headline };
}

export { buildPerfFlamegraph } from './flamegraph';
export { correlateChange, type ChangeEvent } from './change-correlation';