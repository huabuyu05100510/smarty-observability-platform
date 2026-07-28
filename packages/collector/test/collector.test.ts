// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BreadcrumbCollector } from '../src/breadcrumbs';
import { Reporter } from '../src/reporter';
import { installErrors, reportReactError } from '../src/errors';
import { initCollector } from '../src/index';
import type { MonitorEvent } from '@monit/contracts';

// jsdom 没有 sendBeacon / 完整 PerformanceObserver，mock 掉
beforeEach(() => {
  // @ts-expect-error mock
  navigator.sendBeacon = vi.fn(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BreadcrumbCollector', () => {
  it('records click breadcrumbs with element descriptor', () => {
    const bc = new BreadcrumbCollector(10);
    bc.install();
    document.body.innerHTML = '<button id="btn" class="cta primary">x</button>';
    const btn = document.getElementById('btn')!;
    btn.click();
    const recent = bc.recent();
    expect(recent.length).toBe(1);
    expect(recent[0].type).toBe('click');
    expect(recent[0].message).toContain('button');
    expect(recent[0].message).toContain('#btn');
    bc.uninstall();
  });

  it('records route changes (pushState)', () => {
    const bc = new BreadcrumbCollector(10);
    bc.install();
    history.pushState({}, '', '/new-page');
    const recent = bc.recent();
    expect(recent.some(b => b.type === 'route' && b.message.includes('/new-page'))).toBe(true);
    bc.uninstall();
  });

  it('caps buffer at capacity', () => {
    const bc = new BreadcrumbCollector(3);
    bc.install();
    for (let i = 0; i < 5; i++) {
      history.pushState({}, '', `/p${i}`);
    }
    expect(bc.recent().length).toBe(3);
    bc.uninstall();
  });
});

describe('Reporter', () => {
  it('flushes batch via fetch keepalive when sendBeacon unavailable', async () => {
    // @ts-expect-error disable sendBeacon
    navigator.sendBeacon = undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const reporter = new Reporter({ endpoint: 'https://ingest/x', batchSize: 2 });
    reporter.enqueue({ id: 'e1', type: 'error', subType: 'js', timestamp: 1, traceId: 't', spanId: 's', sessionId: 'sess', release: 'r', payload: {}, piiSafe: true, sampled: true });
    reporter.enqueue({ id: 'e2', type: 'error', subType: 'js', timestamp: 2, traceId: 't', spanId: 's', sessionId: 'sess', release: 'r', payload: {}, piiSafe: true, sampled: true });
    // batchSize=2 触发自动 flush
    await new Promise(r => setTimeout(r, 10));
    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as MonitorEvent[];
    expect(body.length).toBe(2);
    reporter.stop();
  });

  it('flushes on visibilitychange hidden (fetch keepalive primary path)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const reporter = new Reporter({ endpoint: 'https://ingest/x', flushInterval: 99999 });
    reporter.start();
    reporter.enqueue({ id: 'e1', type: 'error', subType: 'js', timestamp: 1, traceId: 't', spanId: 's', sessionId: 'sess', release: 'r', payload: {}, piiSafe: true, sampled: true });
    // 模拟 hidden
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(r => setTimeout(r, 20));
    expect(fetchSpy).toHaveBeenCalled();
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.keepalive).toBe(true);
    reporter.stop();
    fetchSpy.mockRestore();
  });
});

describe('installErrors', () => {
  it('captures JS errors with fingerprint', () => {
    const errors: Array<{ signal: { message: string }; fp: { primary: string } }> = [];
    const uninstall = installErrors({
      onError: (signal, fp) => errors.push({ signal, fp: fp as { primary: string } }),
    });
    const error = new Error('Cannot read properties of null (reading "map")');
    error.stack = 'TypeError: Cannot read properties of null\n    at renderList (app.js:42:17)';
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message, filename: 'app.js', lineno: 42, colno: 17 }));
    expect(errors.length).toBe(1);
    expect(errors[0].signal.message).toContain('Cannot read');
    expect(errors[0].fp.primary).toMatch(/^[0-9a-f]+$/);
    uninstall();
  });

  it('captures promise rejections', () => {
    const errors: Array<{ signal: { type: string } }> = [];
    const uninstall = installErrors({
      onError: (signal) => errors.push({ signal }),
    });
    // jsdom 无 PromiseRejectionEvent 构造函数，用合成事件（handler 读 event.reason）
    const ev = new Event('unhandledrejection');
    Object.defineProperty(ev, 'reason', { value: new Error('async fail') });
    (ev as { promise?: unknown }).promise = Promise.resolve();
    window.dispatchEvent(ev);
    expect(errors.some(e => e.signal.type === 'promise')).toBe(true);
    uninstall();
  });

  it('reportReactError produces react-type signal with componentStack', () => {
    const errors: Array<{ signal: { type: string; componentStack?: string } }> = [];
    reportReactError(new Error('render crash'), 'in Component\n  at Child', {
      onError: (signal) => errors.push({ signal }),
    });
    expect(errors[0].signal.type).toBe('react');
    expect(errors[0].signal.componentStack).toContain('Child');
  });
});

describe('initCollector integration', () => {
  it('installs and routes errors to reporter with traceId + fingerprint', async () => {
    const events: MonitorEvent[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const batch = JSON.parse((init?.body as string) ?? '[]') as MonitorEvent[];
      events.push(...batch);
      return new Response('{}', { status: 200 });
    });
    // @ts-expect-error disable beacon to force fetch path
    navigator.sendBeacon = undefined;

    const handle = initCollector({
      endpoint: 'https://ingest/x',
      release: 'v1.0.0',
      batchSize: 1,
      flushInterval: 99999,
    });

    const error = new Error('boom');
    error.stack = 'Error: boom\n    at fn (app.js:1:1)';
    window.dispatchEvent(new ErrorEvent('error', { error, message: 'boom', filename: 'app.js', lineno: 1, colno: 1 }));

    // batchSize=1 触发 flush
    await new Promise(r => setTimeout(r, 20));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const errEvent = events.find(e => e.type === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(errEvent!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(errEvent!.release).toBe('v1.0.0');
    expect(errEvent!.fingerprint?.primary).toMatch(/^[0-9a-f]+$/);

    handle.uninstall();
    fetchSpy.mockRestore();
  });
});