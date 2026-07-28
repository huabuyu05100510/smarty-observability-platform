import { describe, it, expect } from 'vitest';
import {
  analyzeRootCauses,
  proposeHealActions,
  buildReportSummary,
  buildPerfFlamegraph,
  buildDiffFlamegraph,
  correlateChange,
  diagnoseWithCorrelation,
  buildReportFromEvents,
} from '../src/index';
import type { DiagnosticReport, PerfFlamegraphData, MonitorEvent } from '@monit/contracts';

function makeReport(over: Partial<DiagnosticReport> = {}): DiagnosticReport {
  return {
    id: 'r1',
    url: 'https://app.example.com/',
    createdAt: 1_700_000_000_000,
    vitals: [],
    errors: [],
    longTasks: [],
    loafEntries: [],
    summary: { issueCount: 0, worstSeverity: 'info', headline: '' },
    ...over,
  };
}

describe('analyzeRootCauses', () => {
  it('attributes INP >= 200ms to dominant phase', () => {
    const report = makeReport({
      inp: {
        value: 320,
        rating: 'poor',
        inputDelay: 30,
        processingDuration: 250,
        presentationDelay: 40,
        longAnimationFrameEntries: [
          {
            id: 'loaf1',
            startTime: 0,
            duration: 240,
            scripts: [
              { id: 's1', name: 'heavy', sourceURL: '/app.js', sourceFunctionName: 'compute', duration: 200, startTime: 0 },
            ],
          },
        ],
      },
    });
    const records = analyzeRootCauses(report);
    expect(records.length).toBe(1);
    expect(records[0].candidates[0].kind).toBe('inp.processing');
    expect(records[0].candidates[0].anchors.sourceFunctionName).toBe('compute');
    expect(records[0].candidates[0].suggestedHealIds).toContain('suggest_scheduler_yield');
  });

  it('attributes JS errors with stack anchor', () => {
    const report = makeReport({
      errors: [
        { id: 'e1', type: 'js', message: 'Cannot read of null', stack: 'TypeError\n    at foo (app.js:10:5)', timestamp: 1 },
      ],
    });
    const records = analyzeRootCauses(report);
    expect(records[0].candidates[0].kind).toBe('error.js');
    expect(records[0].severity).toBe('critical');
    expect(records[0].candidates[0].suggestedHealIds).toContain('safe_null_guard_hint');
  });

  it('skips long tasks below 100ms threshold', () => {
    const report = makeReport({
      longTasks: [{ id: 'lt1', startTime: 0, duration: 50 }],
    });
    expect(analyzeRootCauses(report).length).toBe(0);
  });

  it('sorts by severity then confidence', () => {
    const report = makeReport({
      inp: { value: 320, rating: 'poor', inputDelay: 30, processingDuration: 250, presentationDelay: 40 },
      longTasks: [{ id: 'lt1', startTime: 0, duration: 200 }],
    });
    const records = analyzeRootCauses(report);
    // INP warning(0.6) vs long_task warning(0.5) -> INP 先（置信度高）
    expect(records[0].symptom.metric).toBe('INP');
  });
});

describe('proposeHealActions', () => {
  it('dedupes heal actions across records', () => {
    const report = makeReport({
      inp: { value: 320, rating: 'poor', inputDelay: 30, processingDuration: 250, presentationDelay: 40 },
      longTasks: [{ id: 'lt1', startTime: 0, duration: 200 }],
    });
    const records = analyzeRootCauses(report);
    const actions = proposeHealActions(records);
    // INP suggests scheduler_yield + quiet_wrap, long_task suggests scheduler_yield (dup)
    const ids = actions.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('suggest_scheduler_yield');
  });

  it('all heal actions are safe=true', () => {
    const report = makeReport({
      errors: [{ id: 'e1', type: 'js', message: 'x', timestamp: 1 }],
    });
    const actions = proposeHealActions(analyzeRootCauses(report));
    for (const a of actions) expect(a.safe).toBe(true);
  });
});

describe('buildReportSummary', () => {
  it('reports worst severity', () => {
    const report = makeReport({
      errors: [{ id: 'e1', type: 'js', message: 'x', timestamp: 1 }],
    });
    const s = buildReportSummary(report);
    expect(s.worstSeverity).toBe('critical');
    expect(s.issueCount).toBe(1);
  });
});

describe('buildPerfFlamegraph', () => {
  it('builds INP root -> 3 phases -> LoAF scripts', () => {
    const report = makeReport({
      inp: {
        value: 320,
        rating: 'poor',
        inputDelay: 30,
        processingDuration: 250,
        presentationDelay: 40,
        longAnimationFrameEntries: [
          {
            id: 'loaf1',
            startTime: 0,
            duration: 240,
            scripts: [{ id: 's1', name: 'heavy', sourceFunctionName: 'compute', duration: 200, startTime: 0 }],
          },
        ],
      },
    });
    const fg = buildPerfFlamegraph(report);
    expect(fg.roots.length).toBe(1);
    expect(fg.roots[0].children.length).toBe(3); // 3 phases
    const processing = fg.roots[0].children[1];
    expect(processing.children.length).toBe(1); // 1 LoAF script
    expect(processing.children[0].name).toBe('compute');
  });

  it('synthetic fallback when no LoAF data', () => {
    const report = makeReport({
      inp: { value: 320, rating: 'poor', inputDelay: 30, processingDuration: 250, presentationDelay: 40 },
    });
    const fg = buildPerfFlamegraph(report);
    const processing = fg.roots[0].children[1];
    expect(processing.children[0].synthetic).toBe(true);
  });
});

describe('correlateChange', () => {
  const anomaly = { startedAt: 1_700_000_000_000, spikeRatio: 4, release: 'v1.2.3', metric: 'error_rate' };

  it('correlates a recent deployment with matching release', () => {
    const changes = [
      { id: 'c1', kind: 'deployment' as const, at: anomaly.startedAt - 60_000, release: 'v1.2.3', summary: 'deploy v1.2.3', commitSha: 'abc123' },
    ];
    const cand = correlateChange(changes, anomaly);
    expect(cand).not.toBeNull();
    expect(cand!.kind).toBe('deployment');
    expect(cand!.confidence).toBeGreaterThan(0.4);
    expect(cand!.anchors.commitSha).toBe('abc123');
  });

  it('returns null for changes outside the time window', () => {
    const changes = [
      { id: 'c1', kind: 'deployment' as const, at: anomaly.startedAt - 60 * 60 * 1000, release: 'v1.2.3', summary: 'old deploy' },
    ];
    expect(correlateChange(changes, anomaly)).toBeNull();
  });

  it('caps confidence at 0.7 (correlation != causation)', () => {
    const changes = [
      { id: 'c1', kind: 'deployment' as const, at: anomaly.startedAt - 1000, release: 'v1.2.3', summary: 'deploy' },
    ];
    const cand = correlateChange(changes, { ...anomaly, spikeRatio: 100 });
    expect(cand!.confidence).toBeLessThanOrEqual(0.7);
  });
});

describe('diagnoseWithCorrelation (multi-source candidates)', () => {
  it('appends change-correlation candidate to the candidate chain, sorted by confidence', () => {
    const report = makeReport({
      errors: [{ id: 'e1', type: 'js', message: 'TypeError', stack: 'TypeError\n    at fn (app.js:10:5)', timestamp: 1 }],
    });
    const records = diagnoseWithCorrelation({
      report,
      changes: [
        { id: 'c1', kind: 'deployment', at: report.createdAt - 60_000, release: 'v1.2.3', summary: 'deploy v1.2.3', commitSha: 'abc' },
      ],
      anomaly: { startedAt: report.createdAt, spikeRatio: 4, release: 'v1.2.3', metric: 'error_rate' },
    });
    expect(records.length).toBe(1);
    const cand = records[0].candidates;
    // 确定性 error.js 候选（0.8）+ 变更关联候选（<=0.7）
    expect(cand.length).toBe(2);
    // 按置信度降序：error.js(0.8) 应在前
    expect(cand[0].kind).toBe('error.js');
    expect(cand[1].kind).toBe('deployment');
  });

  it('no relevant change -> single deterministic candidate', () => {
    const report = makeReport({
      errors: [{ id: 'e1', type: 'js', message: 'x', timestamp: 1 }],
    });
    const records = diagnoseWithCorrelation({
      report,
      changes: [],
      anomaly: { startedAt: report.createdAt, spikeRatio: 2 },
    });
    expect(records[0].candidates.length).toBe(1);
  });
});

describe('buildDiffFlamegraph (regression visualization)', () => {
  function makeFlame(totalMs: number, scriptMs: number): PerfFlamegraphData {
    return {
      roots: [{
        id: 'root', name: `INP ${totalMs}ms`, kind: 'frame', startMs: 0, durationMs: totalMs, depth: 0,
        children: [{
          id: 'p', name: 'processing', kind: 'inp_phase', startMs: 0, durationMs: scriptMs, depth: 1,
          children: [{ id: 's', name: 'compute', kind: 'script', startMs: 0, durationMs: scriptMs, depth: 2, children: [] }],
        }],
      }],
      totalMs,
      p99: scriptMs,
    };
  }

  it('marks regressed frames (after slower than before)', () => {
    const before = makeFlame(300, 250);
    const after = makeFlame(400, 350);
    const diff = buildDiffFlamegraph(before, after);
    expect(diff.regressionRatio).toBeGreaterThan(0);
    const script = diff.roots[0].children[0].children[0];
    expect(script.trend).toBe('regression');
    expect(script.deltaMs).toBeGreaterThan(0);
  });

  it('marks improved frames (after faster)', () => {
    const before = makeFlame(400, 350);
    const after = makeFlame(300, 250);
    const diff = buildDiffFlamegraph(before, after);
    expect(diff.regressionRatio).toBeLessThan(0);
    expect(diff.roots[0].children[0].children[0].trend).toBe('improvement');
  });

  it('marks new frames absent in baseline', () => {
    const before: PerfFlamegraphData = { roots: [], totalMs: 0, p99: 0 };
    const after = makeFlame(400, 350);
    const diff = buildDiffFlamegraph(before, after);
    expect(diff.roots[0].trend).toBe('new');
  });
});

describe('buildReportFromEvents (L3 -> L4 聚合胶水)', () => {
  function evt(type: string, subType: string, payload: unknown): MonitorEvent {
    return {
      id: `${type}-${Math.random()}`, type: type as never, subType: subType as never,
      timestamp: Date.now(), traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
      sessionId: 'sess', release: 'v1', payload, piiSafe: true, sampled: true,
    };
  }

  it('reduces error events into ErrorSignal[]', () => {
    const report = buildReportFromEvents([
      evt('error', 'js', { id: 'e1', type: 'js', message: 'boom', stack: 'Error\n    at fn (a.js:1:1)', timestamp: 1 }),
    ]);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0].message).toBe('boom');
    expect(report.summary.worstSeverity).toBe('critical');
  });

  it('reduces INP vital into InpAttribution + loafEntries', () => {
    const report = buildReportFromEvents([
      evt('vital', 'inp', {
        value: 320, rating: 'poor', inputDelay: 30, processingDuration: 250, presentationDelay: 40,
        longAnimationFrameEntries: [{ id: 'l1', startTime: 0, duration: 200, scripts: [{ id: 's1', name: 'x', duration: 200, startTime: 0 }] }],
      }),
    ]);
    expect(report.inp?.value).toBe(320);
    expect(report.loafEntries.length).toBe(1);
  });

  it('reduces non-inp vitals into VitalMetric[]', () => {
    const report = buildReportFromEvents([
      evt('vital', 'lcp', { name: 'LCP', value: 2500, rating: 'good' }),
      evt('vital', 'cls', { name: 'CLS', value: 0.05, rating: 'good' }),
    ]);
    expect(report.vitals.length).toBe(2);
    expect(report.inp).toBeUndefined();
  });

  it('empty events -> info severity report', () => {
    const report = buildReportFromEvents([]);
    expect(report.errors.length).toBe(0);
    expect(report.summary.worstSeverity).toBe('info');
  });

  it('feeds directly into analyzeRootCauses', () => {
    const report = buildReportFromEvents([
      evt('error', 'js', { id: 'e1', type: 'js', message: 'TypeError', stack: 'TypeError\n    at fn (a.js:1:1)', timestamp: 1 }),
    ]);
    const records = analyzeRootCauses(report);
    expect(records.length).toBe(1);
    expect(records[0].candidates[0].kind).toBe('error.js');
  });
});