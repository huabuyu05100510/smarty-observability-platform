import { describe, it, expect } from 'vitest';
import { HeadSampler, TailSampler, composeSamplers, SampleStatsCounter } from '../src/index';
import type { MonitorEventLike } from '../src/index';

function ev(over: Partial<MonitorEventLike> = {}): MonitorEventLike {
  return { type: 'vital', subType: 'lcp', timestamp: 1, ...over };
}

describe('HeadSampler', () => {
  it('keeps all when sampleRate=1', () => {
    const s = new HeadSampler({ sampleRate: 1 });
    for (let i = 0; i < 20; i++) expect(s.shouldKeep(ev({ traceId: `t${i}` }))).toBe(true);
  });

  it('drops all when sampleRate=0', () => {
    const s = new HeadSampler({ sampleRate: 0 });
    expect(s.shouldKeep(ev({ traceId: 't' }))).toBe(false);
  });

  it('deterministic per traceId (same traceId -> same decision)', () => {
    const s = new HeadSampler({ sampleRate: 0.5 });
    const e = ev({ traceId: 'abc-123' });
    expect(s.shouldKeep(e)).toBe(s.shouldKeep(e));
  });

  it('roughly respects sampleRate over many traceIds', () => {
    const s = new HeadSampler({ sampleRate: 0.3 });
    let kept = 0;
    for (let i = 0; i < 1000; i++) if (s.shouldKeep(ev({ traceId: `t${i}` }))) kept++;
    expect(kept).toBeGreaterThan(200);
    expect(kept).toBeLessThan(400);
  });

  it('keeps all when no hash field available', () => {
    const s = new HeadSampler({ sampleRate: 0.1 });
    expect(s.shouldKeep(ev())).toBe(true); // no traceId
  });
});

describe('TailSampler', () => {
  it('always keeps errors', () => {
    const s = new TailSampler({ sampleRate: 0 });
    expect(s.shouldKeep(ev({ type: 'error', traceId: 'x' }))).toBe(true);
  });

  it('always keeps slow requests', () => {
    const s = new TailSampler({ sampleRate: 0, slowThresholdMs: 1000 });
    expect(s.shouldKeep(ev({ type: 'request', payload: { duration: 2000 } }))).toBe(true);
  });

  it('keeps=0 rate drops non-error non-slow', () => {
    const s = new TailSampler({ sampleRate: 0 });
    expect(s.shouldKeep(ev({ type: 'vital', traceId: 't1' }))).toBe(false);
  });

  it('custom rule forces keep/drop', () => {
    const s = new TailSampler({ sampleRate: 1, rules: [e => e.subType === 'cls' ? true : undefined] });
    expect(s.shouldKeep(ev({ type: 'vital', subType: 'cls', traceId: 'x' }))).toBe(true);
  });
});

describe('composeSamplers', () => {
  it('OR semantics: any keep -> keep', () => {
    const dropAll = new HeadSampler({ sampleRate: 0 });
    const errTail = new TailSampler({ sampleRate: 0 });
    const composed = composeSamplers(dropAll, errTail);
    expect(composed.shouldKeep(ev({ type: 'vital', traceId: 'x' }))).toBe(false);
    expect(composed.shouldKeep(ev({ type: 'error', traceId: 'x' }))).toBe(true); // errTail keeps
  });
});

describe('SampleStatsCounter', () => {
  it('tracks total/kept/rate', () => {
    const c = new SampleStatsCounter();
    c.record(true); c.record(false); c.record(true);
    const s = c.snapshot();
    expect(s.total).toBe(3);
    expect(s.kept).toBe(2);
    expect(s.rate).toBeCloseTo(0.667, 2);
  });
});
