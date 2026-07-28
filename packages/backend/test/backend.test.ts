import { describe, it, expect, afterEach } from 'vitest';
import { EventStore, createBackendServer } from '../src/index';
import type { MonitorEvent } from '@monit/contracts';

const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
});

function makeErrorEvent(fp: string, msg: string, sess = 'sess1', ts = 1_700_000_000_000): MonitorEvent {
  return {
    id: `e-${ts}-${Math.random()}`, type: 'error', subType: 'js', timestamp: ts,
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sessionId: sess, release: 'v1.0.0',
    payload: { message: msg }, piiSafe: true, sampled: true,
    fingerprint: { primary: fp, secondary: 'sec-' + fp },
  };
}

function makeVitalEvent(name: 'INP' | 'LCP' | 'CLS', value: number, sess = 'sess1'): MonitorEvent {
  return {
    id: `v-${value}`, type: 'vital', subType: name.toLowerCase() as never, timestamp: Date.now(),
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sessionId: sess, release: 'v1.0.0',
    payload: { name, value, rating: 'good' }, piiSafe: true, sampled: true,
  };
}

describe('EventStore', () => {
  it('groups errors by primary fingerprint with count + first/last seen', () => {
    const store = new EventStore();
    store.ingest([
      makeErrorEvent('fp1', 'Cannot read map', 's1', 1000),
      makeErrorEvent('fp1', 'Cannot read map', 's2', 2000),
      makeErrorEvent('fp2', 'Other error', 's1', 3000),
    ]);
    const groups = store.errorGroupsList();
    expect(groups.length).toBe(2);
    expect(groups[0].fingerprint).toBe('fp1'); // count 2 > 1
    expect(groups[0].count).toBe(2);
    expect(groups[0].sessionsAffected.size).toBe(2);
    expect(groups[0].firstSeen).toBe(1000);
    expect(groups[0].lastSeen).toBe(2000);
  });

  it('aggregates vitals p75/p99', () => {
    const store = new EventStore();
    const values = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    store.ingest(values.map(v => makeVitalEvent('INP', v)));
    const vitals = store.vitalsAggregation();
    expect(vitals.length).toBe(1);
    expect(vitals[0].name).toBe('INP');
    expect(vitals[0].count).toBe(10);
    expect(vitals[0].p99).toBeGreaterThanOrEqual(900);
  });

  it('tracks sessions with event/error counts', () => {
    const store = new EventStore();
    store.ingest([
      makeErrorEvent('fp1', 'x', 's1', 1000),
      makeErrorEvent('fp1', 'x', 's1', 2000),
      makeVitalEvent('INP', 300, 's1'),
    ]);
    const sessions = store.sessionsList();
    expect(sessions.length).toBe(1);
    expect(sessions[0].errorCount).toBe(2);
    expect(sessions[0].eventCount).toBe(3);
  });

  it('eventsForFingerprint returns all events with that fingerprint', () => {
    const store = new EventStore();
    store.ingest([makeErrorEvent('fp1', 'a'), makeErrorEvent('fp1', 'b'), makeErrorEvent('fp2', 'c')]);
    expect(store.eventsForFingerprint('fp1').length).toBe(2);
  });
});

describe('backend server', () => {
  async function start() {
    const h = createBackendServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3921;
    return { h, base: `http://127.0.0.1:${port}` };
  }

  it('POST /api/events ingests and GET /api/errors returns groups', async () => {
    const { base } = await start();
    await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([makeErrorEvent('fp1', 'boom'), makeErrorEvent('fp1', 'boom')]),
    });
    const res = await fetch(`${base}/api/errors`);
    const json = await res.json() as { groups: Array<{ count: number; fingerprint: string }> };
    expect(json.groups.length).toBe(1);
    expect(json.groups[0].count).toBe(2);
  });

  it('GET /api/errors/:fp returns group + events', async () => {
    const { base } = await start();
    await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([makeErrorEvent('fp1', 'boom')]),
    });
    const res = await fetch(`${base}/api/errors/fp1`);
    const json = await res.json() as { group: { fingerprint: string }; events: unknown[] };
    expect(json.group.fingerprint).toBe('fp1');
    expect(json.events.length).toBe(1);
  });

  it('GET /api/vitals returns aggregation', async () => {
    const { base } = await start();
    await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([makeVitalEvent('INP', 300), makeVitalEvent('INP', 600)]),
    });
    const res = await fetch(`${base}/api/vitals`);
    const json = await res.json() as { vitals: Array<{ name: string; count: number }> };
    expect(json.vitals.length).toBe(1);
    expect(json.vitals[0].count).toBe(2);
  });

  it('GET / returns dashboard HTML', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('smarty-observability-platform');
    expect(html).toContain('错误收件箱');
  });

  it('handles CORS preflight', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/api/errors`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});