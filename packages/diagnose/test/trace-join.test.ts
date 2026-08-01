import { describe, it, expect } from 'vitest';
import { buildReportFromEvents, analyzeRootCauses, joinTraceSpans } from '../src';
import type { MonitorEvent, SpanRecord } from '@monit/contracts';

function errEvent(traceId: string): MonitorEvent {
  return {
    id: 'e1', type: 'error', subType: 'js', timestamp: Date.now(),
    traceId, spanId: 's1', sessionId: 'sess', release: 'v1',
    payload: {
      id: 'e1', type: 'js', message: "Cannot read properties of null (reading 'map')",
      stack: 'TypeError: null\n    at renderList (src/renderList.ts:42:17)',
      filename: 'src/renderList.ts', lineno: 42, colno: 17, timestamp: Date.now(), sourceURL: 'src/renderList.ts',
    },
    piiSafe: true, sampled: true, fingerprint: { primary: 'fp-null-map' },
  } as MonitorEvent;
}

describe('跨层 trace join（性能皇冠）', () => {
  it('buildReportFromEvents 携带 traceId', () => {
    const report = buildReportFromEvents([errEvent('trace-abc')]);
    expect(report.traceId).toBe('trace-abc');
  });

  it('analyzeRootCauses 产出的 record 携带 report.traceId', () => {
    const report = buildReportFromEvents([errEvent('trace-abc')]);
    const records = analyzeRootCauses(report);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r.traceId).toBe('trace-abc');
  });

  it('joinTraceSpans：同 trace 慢 span -> 产 dependency candidate 指向 span', () => {
    const report = buildReportFromEvents([errEvent('trace-abc')]);
    const records = analyzeRootCauses(report);
    const spans: SpanRecord[] = [
      { traceId: 'trace-abc', spanId: 'span-1', name: 'GET /api/users', kind: 'server', serviceName: 'backend', startTime: 0, durationMs: 1800, status: 'ok', slow: true },
      { traceId: 'other', spanId: 'span-2', name: 'GET /api/x', kind: 'server', startTime: 0, durationMs: 9999, status: 'ok' }, // 不同 trace，不应被 join
      { traceId: 'trace-abc', spanId: 'span-3', name: 'GET /api/fast', kind: 'server', startTime: 0, durationMs: 50, status: 'ok' }, // 太快，不达阈值
    ];
    joinTraceSpans(records, spans);
    const rec = records[0];
    const dep = rec.candidates.find(c => c.kind === 'dependency');
    expect(dep).toBeDefined();
    expect(dep!.anchors.traceSpanId).toBe('span-1');
    expect(dep!.evidence[0]).toContain('GET /api/users');
    expect(dep!.evidence[0]).toContain('1800ms');
  });

  it('joinTraceSpans：无同 trace 慢 span 时不加 dependency candidate', () => {
    const report = buildReportFromEvents([errEvent('trace-abc')]);
    const records = analyzeRootCauses(report);
    const before = records[0].candidates.length;
    joinTraceSpans(records, []);
    expect(records[0].candidates.length).toBe(before);
    expect(records[0].candidates.some(c => c.kind === 'dependency')).toBe(false);
  });

  it('joinTraceSpans：候选链按置信度降序', () => {
    const report = buildReportFromEvents([errEvent('trace-abc')]);
    const records = analyzeRootCauses(report);
    joinTraceSpans(records, [
      { traceId: 'trace-abc', spanId: 's', name: 'slow', kind: 'server', startTime: 0, durationMs: 3000, status: 'ok' },
    ]);
    for (let i = 1; i < records[0].candidates.length; i++) {
      expect(records[0].candidates[i - 1].confidence).toBeGreaterThanOrEqual(records[0].candidates[i].confidence);
    }
  });
});
