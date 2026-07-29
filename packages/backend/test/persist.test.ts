import { describe, it, expect } from 'vitest';
import { SqlitePersister } from '../src/persist';
import { EventStore } from '../src/store';
import type { MonitorEvent } from '@monit/contracts';

function ev(id: string, fp?: string): MonitorEvent {
  return {
    id, type: 'error', subType: 'js', timestamp: Date.now(),
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sessionId: 'sess1', release: 'v1',
    payload: { message: 'boom' }, piiSafe: true, sampled: true,
    ...(fp ? { fingerprint: { primary: fp } } : {}),
  };
}

describe('SqlitePersister', () => {
  it('persists and reloads events', () => {
    const p = new SqlitePersister({ dbPath: ':memory:' });
    p.saveEvents([ev('e1', 'fp1'), ev('e2', 'fp1'), ev('e3', 'fp2')]);
    expect(p.count()).toBe(3);
    const all = p.loadAll();
    expect(all.length).toBe(3);
    expect(all[0].id).toBe('e1'); // 按 timestamp 升序
    expect(all.find(e => e.id === 'e1')?.fingerprint?.primary).toBe('fp1');
    p.close();
  });

  it('hydrates EventStore on restart (fingerprint grouping preserved)', () => {
    // 模拟第一次运行：持久化
    const path = ':memory:';
    const p1 = new SqlitePersister({ dbPath: path });
    p1.saveEvents([ev('e1', 'fp1'), ev('e2', 'fp1'), ev('e3', 'fp2')]);
    const all = p1.loadAll();
    p1.close();

    // 模拟重启：用 loadAll hydrate 一个新 EventStore
    const store = new EventStore();
    store.ingest(all);
    const groups = store.errorGroupsList();
    expect(groups.length).toBe(2);
    expect(groups.find(g => g.fingerprint === 'fp1')?.count).toBe(2);
  });

  it('recent() returns last N', () => {
    const p = new SqlitePersister({ dbPath: ':memory:' });
    const evs = [];
    for (let i = 0; i < 10; i++) evs.push(ev(`e${i}`));
    p.saveEvents(evs);
    const recent = p.recent(3);
    expect(recent.length).toBe(3);
    expect(recent.map(e => e.id)).toEqual(['e7', 'e8', 'e9']);
    p.close();
  });

  it('insert OR REPLACE dedupes by id', () => {
    const p = new SqlitePersister({ dbPath: ':memory:' });
    p.saveEvents([ev('e1', 'fp1')]);
    p.saveEvents([ev('e1', 'fp1')]); // 同 id 再写
    expect(p.count()).toBe(1);
    p.close();
  });
});
