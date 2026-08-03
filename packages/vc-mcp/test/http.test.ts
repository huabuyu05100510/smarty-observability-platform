import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startHttpReceiver, type HttpReceiver } from '../src/http';
import { loadFindings } from '../src/store';

let dir: string;
let file: string;
let base: string;
let rcvr: HttpReceiver;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'vc-http-'));
  file = path.join(dir, 'f.json');
  rcvr = await startHttpReceiver({ port: 0, host: '127.0.0.1', storePath: file });
  base = `http://127.0.0.1:${rcvr.port}`;
});
afterEach(async () => {
  await rcvr.close();
  rmSync(dir, { recursive: true, force: true });
});

const VALID = {
  diff: { search: 'return null;', replace: 'return 0;' },
  targets: [{ file: 'src/Foo.ts', search: 'return null;', replace: 'return 0;' }],
  rootCause: 'foo() 返回 null',
};

describe('http receiver', () => {
  it('GET /health → ok + count', async () => {
    const r = await fetch(base + '/health');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.count).toBe(0);
  });

  it('POST /findings valid → 201 + persisted + server-assigned id', async () => {
    const r = await fetch(base + '/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.id).toMatch(/^f-\d+-/);
    const items = loadFindings(file);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(j.id);
    expect(items[0].diff.search).toBe('return null;');
  });

  it('POST malformed json → 400', async () => {
    const r = await fetch(base + '/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    expect(r.status).toBe(400);
  });

  it('POST missing targets → 400, nothing persisted', async () => {
    const r = await fetch(base + '/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ diff: { search: 'a', replace: 'b' } }) });
    expect(r.status).toBe(400);
    expect(loadFindings(file)).toHaveLength(0);
  });

  it('DELETE /findings → clears', async () => {
    await fetch(base + '/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(VALID) });
    expect(loadFindings(file)).toHaveLength(1);
    const r = await fetch(base + '/findings', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(loadFindings(file)).toHaveLength(0);
  });

  it('404 unknown route', async () => {
    const r = await fetch(base + '/nope');
    expect(r.status).toBe(404);
  });
});
