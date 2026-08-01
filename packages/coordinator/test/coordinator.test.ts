import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventBus } from '../src/event-bus';
import { applyPatchesLocally } from '../src/github-pr';
import { createCoordinatorServer } from '../src/server';
import type { AiPatchProposal } from '@monit/contracts';

const handles: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close();
});

describe('EventBus', () => {
  it('keeps last N events (ring buffer)', () => {
    const bus = new EventBus(3);
    bus.publish({ type: 'diag.started', target: 'a' });
    bus.publish({ type: 'diag.started', target: 'b' });
    bus.publish({ type: 'diag.started', target: 'c' });
    bus.publish({ type: 'diag.started', target: 'd' });
    expect(bus.recent().length).toBe(3);
    expect((bus.recent()[0] as { target: string }).target).toBe('b');
  });

  it('notifies subscribers', () => {
    const bus = new EventBus();
    const received: unknown[] = [];
    bus.subscribe(e => received.push(e));
    bus.publish({ type: 'diag.started', target: 'x' });
    expect(received.length).toBe(1);
  });
});

describe('applyPatchesLocally (anti-hallucination guard)', () => {
  it('applies patch when searchCode exists', async () => {
    const files = new Map([['app.js', 'function foo(){ return null; }']]);
    const proposal: AiPatchProposal = {
      id: 'p1', basedOn: 'r1', track: 'mr-draft', patchType: 'replace',
      diagnosis: 'x', riskScore: 0.2, createdAt: 0,
      patches: [{ filePath: 'app.js', searchCode: 'return null;', replaceCode: 'return [];' }],
      riskNotes: [],
    };
    const result = await applyPatchesLocally(
      proposal,
      (p) => Promise.resolve(files.get(p) ?? ''),
      (p, c) => { files.set(p, c); return Promise.resolve(); },
    );
    expect(result.applied).toBe(1);
    expect(files.get('app.js')).toBe('function foo(){ return []; }');
  });

  it('skips patch when searchCode does NOT exist (hallucination guard)', async () => {
    const files = new Map([['app.js', 'function foo(){}']]);
    const proposal: AiPatchProposal = {
      id: 'p1', basedOn: 'r1', track: 'mr-draft', patchType: 'replace',
      diagnosis: 'x', riskScore: 0.2, createdAt: 0,
      patches: [{ filePath: 'app.js', searchCode: 'NONEXISTENT CODE', replaceCode: 'x' }],
      riskNotes: [],
    };
    const result = await applyPatchesLocally(
      proposal,
      (p) => Promise.resolve(files.get(p) ?? ''),
      (p, c) => { files.set(p, c); return Promise.resolve(); },
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect(files.get('app.js')).toBe('function foo(){}'); // 未改动
  });
});

describe('coordinator server routes', () => {
  it('GET /health returns ok', async () => {
    const h = createCoordinatorServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3920;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it('POST /events publishes and GET /events returns it', async () => {
    const h = createCoordinatorServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3920;
    const base = `http://127.0.0.1:${port}`;

    const postRes = await fetch(`${base}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'diag.started', target: 't1' }),
    });
    expect(postRes.status).toBe(201);

    const getRes = await fetch(`${base}/events`);
    const json = await getRes.json() as { events: Array<{ target: string }> };
    expect(json.events.some(e => e.target === 't1')).toBe(true);
  });

  it('POST /ai/patch returns 503 when LLM not configured', async () => {
    const h = createCoordinatorServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3920;
    const res = await fetch(`http://127.0.0.1:${port}/ai/patch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: { id: 'r' }, files: [] }),
    });
    expect(res.status).toBe(503);
  });

  it('POST /heal/apply 登记签名 patch + GET /heal/patches + POST /heal/revoke 闭环', async () => {
    const h = createCoordinatorServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3920;
    const base = `http://127.0.0.1:${port}`;

    // 1. /heal/apply 登记签名 patch
    const res = await fetch(`${base}/heal/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: 'fp-1', patchType: 'guard', targetPath: 'window.app.foo' }),
    });
    const json = await res.json() as { rollbackToken: string; track: string; patchId: string; signature: string };
    expect(res.status).toBe(200);
    expect(json.track).toBe('runtime-hotfix');
    expect(json.rollbackToken).toMatch(/^rb-/);
    expect(json.patchId).toMatch(/^patch-/);
    expect(json.signature).toMatch(/^[0-9a-f]{128}$/); // Ed25519 = 64 bytes

    // 2. /heal/patches 拉取活跃 patch
    const list = await (await fetch(`${base}/heal/patches`)).json() as { patches: Array<{ id: string; fingerprint: string }> };
    expect(list.patches.length).toBe(1);
    expect(list.patches[0].fingerprint).toBe('fp-1');

    // 3. /heal/revoke 吊销
    const rev = await (await fetch(`${base}/heal/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patchId: json.patchId }),
    })).json() as { revoked: boolean };
    expect(rev.revoked).toBe(true);
    const list2 = await (await fetch(`${base}/heal/patches`)).json() as { patches: unknown[] };
    expect(list2.patches.length).toBe(0);
  });

  it('POST /heal/apply 拒绝非行为保留 patchType（masking/prototype）', async () => {
    const h = createCoordinatorServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3920;
    const res = await fetch(`http://127.0.0.1:${port}/heal/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fingerprint: 'fp', patchType: 'prototype', targetPath: 'a.b' }),
    });
    expect(res.status).toBe(400);
  });

  it('unknown route returns 404', async () => {
    const h = createCoordinatorServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3920;
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});