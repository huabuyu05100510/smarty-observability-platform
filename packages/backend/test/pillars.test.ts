import { describe, it, expect } from 'vitest';
import { EventStore } from '../src/store';
import type { MonitorEvent } from '@monit/contracts';

function ev(partial: Partial<MonitorEvent> & { type: MonitorEvent['type']; subType: MonitorEvent['subType'] }): MonitorEvent {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    traceId: 't', spanId: 's', sessionId: 'sess', release: 'v1',
    payload: {}, piiSafe: true, sampled: true,
    ...partial,
  } as MonitorEvent;
}

describe('四支柱 store 聚合', () => {
  it('newErrorsByRelease：错误首发 release 回归关联', () => {
    const s = new EventStore();
    s.ingest([
      ev({ type: 'error', subType: 'js', release: 'v1', fingerprint: { primary: 'fp-a' }, payload: { message: 'a' } }),
      ev({ type: 'error', subType: 'js', release: 'v1', fingerprint: { primary: 'fp-a' }, payload: { message: 'a' } }),
      ev({ type: 'error', subType: 'js', release: 'v2', fingerprint: { primary: 'fp-b' }, payload: { message: 'b' } }),
      ev({ type: 'error', subType: 'js', release: 'v2', fingerprint: { primary: 'fp-c' }, payload: { message: 'c' } }),
    ]);
    const byRel = s.newErrorsByRelease();
    const v2 = byRel.find(r => r.release === 'v2');
    expect(v2?.newErrorGroups).toBe(2); // fp-b, fp-c 首发于 v2
    const v1 = byRel.find(r => r.release === 'v1');
    expect(v1?.newErrorGroups).toBe(1); // fp-a 首发于 v1（重复不增）
  });

  it('frustrationStats：行为沮丧信号按 kind 计数', () => {
    const s = new EventStore();
    s.ingest([
      ev({ type: 'behavior', subType: 'frustration', payload: { kind: 'rage_click', count: 3 } }),
      ev({ type: 'behavior', subType: 'frustration', payload: { kind: 'rage_click', count: 3 } }),
      ev({ type: 'behavior', subType: 'frustration', payload: { kind: 'dead_click', count: 1 } }),
    ]);
    const stats = s.frustrationStats();
    expect(stats.rage_click).toBe(2);
    expect(stats.dead_click).toBe(1);
  });

  it('whiteScreenEvents：白屏事件 + 因果归因字段', () => {
    const s = new EventStore();
    s.ingest([
      ev({ type: 'white-screen', subType: 'white-screen', payload: { detected: true, type: 'crashed_render', causalErrorId: 'err-1', timestamp: Date.now() } }),
      ev({ type: 'white-screen', subType: 'white-screen', payload: { detected: true, type: 'critical_resource_blocked', causalResourceUrl: 'https://x/app.js', timestamp: Date.now() } }),
    ]);
    const ws = s.whiteScreenEvents();
    expect(ws.length).toBe(2);
    expect(ws[0].type).toBe('crashed_render');
    expect(ws[0].causalErrorId).toBe('err-1');
    expect(ws[1].causalResourceUrl).toBe('https://x/app.js');
  });
});
