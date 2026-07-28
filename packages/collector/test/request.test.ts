// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { installRequestMonitor, extractGraphQL, type RequestEventPayload } from '../src/request';

afterEach(() => { vi.restoreAllMocks(); });

describe('extractGraphQL', () => {
  it('extracts operation from single query body', () => {
    const r = extractGraphQL(JSON.stringify({ query: 'mutation CreateUser($n: String!) { createUser }', operationName: 'CreateUser' }));
    expect(r?.operationName).toBe('CreateUser');
    expect(r?.summary).toContain('mutation CreateUser');
  });

  it('returns null for non-GraphQL body', () => {
    expect(extractGraphQL(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(extractGraphQL('plain text')).toBeNull();
    expect(extractGraphQL(undefined)).toBeNull();
  });

  it('handles batch (takes first)', () => {
    const r = extractGraphQL(JSON.stringify([{ query: 'query Q1{ a }', operationName: 'Q1' }]));
    expect(r?.operationName).toBe('Q1');
  });

  it('derives operationName from query when missing', () => {
    const r = extractGraphQL(JSON.stringify({ query: 'query GetItem($id: ID!) { item }' }));
    expect(r?.operationName).toBe('GetItem');
  });
});

describe('installRequestMonitor (fetch capture)', () => {
  it('captures non-2xx fetch as request event', async () => {
    const events: Array<{ subType: string; payload: RequestEventPayload }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('err', { status: 500 })) as typeof fetch;
    const handle = installRequestMonitor({}, { onEvent: (subType, payload) => events.push({ subType, payload }) });
    await fetch('/api/x', { method: 'POST', body: 'hello' }).catch(() => {});
    expect(events.some(e => e.subType === 'fetch' && e.payload.status === 500)).toBe(true);
    handle.uninstall();
    globalThis.fetch = orig;
  });

  it('captures slow fetch as slow event', async () => {
    const events: Array<{ subType: string; payload: RequestEventPayload }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 60));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const handle = installRequestMonitor({ slowThresholdMs: 30 }, { onEvent: (subType, payload) => events.push({ subType, payload }) });
    await fetch('/api/slow');
    expect(events.some(e => e.subType === 'slow' && e.payload.duration >= 30)).toBe(true);
    handle.uninstall();
    globalThis.fetch = orig;
  });

  it('captures fetch network error with failReason', async () => {
    const events: Array<{ subType: string; payload: RequestEventPayload }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    const handle = installRequestMonitor({}, { onEvent: (subType, payload) => events.push({ subType, payload }) });
    await fetch('/api/fail').catch(() => {});
    const ev = events.find(e => e.subType === 'fetch');
    expect(ev).toBeDefined();
    expect(ev!.payload.status).toBe(0);
    expect(ev!.payload.failReason).toBeDefined();
    handle.uninstall();
    globalThis.fetch = orig;
  });

  it('ignores configured URLs (e.g. reporter endpoint)', async () => {
    const events: Array<{ subType: string }> = [];
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch;
    const handle = installRequestMonitor({ ignore: u => u === '/report' }, { onEvent: (subType) => events.push({ subType }) });
    await fetch('/report');
    expect(events.length).toBe(0); // 200 + ignored -> no event
    handle.uninstall();
    globalThis.fetch = orig;
  });
});
