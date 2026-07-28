import { describe, it, expect, beforeEach } from 'vitest';
import {
  traceContext,
  encodeTraceparent,
  parseTraceparent,
  generateTraceIdHex,
  generateSpanIdHex,
} from '../src/propagator';

describe('W3C traceparent primitives', () => {
  beforeEach(() => traceContext.reset());

  it('generates spec-compliant trace-id (32 hex, not all zero)', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateTraceIdHex();
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(id).not.toBe('0'.repeat(32));
    }
  });

  it('generates spec-compliant span-id (16 hex, not all zero)', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateSpanIdHex();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(id).not.toBe('0'.repeat(16));
    }
  });

  it('encodes parts into version-00 traceparent', () => {
    const tp = encodeTraceparent({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      flags: '01',
    });
    expect(tp).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });

  it('parses valid traceparent', () => {
    const parsed = parseTraceparent(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
    expect(parsed).toEqual({
      version: '00',
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      flags: '01',
    });
  });

  it('rejects malformed / all-zero / non-00 version', () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`)).toBeNull(); // all-zero trace
    expect(parseTraceparent(`00-${'a'.repeat(32)}-${'0'.repeat(16)}-01`)).toBeNull(); // all-zero span
    expect(parseTraceparent(`01-${'a'.repeat(32)}-${'b'.repeat(16)}-01`)).toBeNull(); // unknown version
  });
});

describe('TraceContextManager view lifecycle', () => {
  beforeEach(() => traceContext.reset());

  it('starts a fresh view when no inbound traceparent', () => {
    const view = traceContext.startView();
    expect(view.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(view.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(view.inherited).toBe(false);
    expect(traceContext.traceId).toBe(view.traceId);
  });

  it('forRequest returns distinct spanIds under same traceId', () => {
    traceContext.startView();
    const a = traceContext.forRequest();
    const b = traceContext.forRequest();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.traceId).toBe(b!.traceId);
    expect(a!.spanId).not.toBe(b!.spanId);
  });

  it('forRequest lazily starts a view if none exists', () => {
    expect(traceContext.current).toBeNull();
    const span = traceContext.forRequest();
    expect(span).not.toBeNull();
    expect(traceContext.current).not.toBeNull();
  });

  it('returns null when disabled', () => {
    traceContext.configure({ enabled: false, traceFlags: '01' });
    traceContext.startView();
    expect(traceContext.forRequest()).toBeNull();
  });
});