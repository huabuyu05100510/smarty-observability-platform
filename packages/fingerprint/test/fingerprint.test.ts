import { describe, it, expect } from 'vitest';
import {
  fnv1a,
  djb2,
  normalizeStackFrame,
  fingerprintStack,
  normalizeMessage,
  normalizeUrl,
  objectOrder,
  computeFingerprint,
} from '../src/index';

describe('hash primitives', () => {
  it('fnv1a is deterministic and hex', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).toMatch(/^[0-9a-f]+$/);
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
  });

  it('djb2 is deterministic and hex', () => {
    expect(djb2('hello')).toBe(djb2('hello'));
    expect(djb2('hello')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('stack frame normalization', () => {
  it('strips line:col', () => {
    const f = normalizeStackFrame('    at foo (app.js:42:17)');
    expect(f).not.toMatch(/42/);
    expect(f).not.toMatch(/17/);
  });

  it('strips query string', () => {
    const f = normalizeStackFrame('    at foo (app.js?v=1.2.3:42:17)');
    expect(f).not.toMatch(/v=1.2.3/);
  });

  it('generalizes content-hash bundles', () => {
    const f = normalizeStackFrame('    at foo (https://cdn.x.com/assets/index-a1b2c3d4.js:42:17)');
    expect(f).not.toMatch('a1b2c3d4');
    expect(f).toMatch(/\[hash\]/);
  });

  it('does not corrupt paren-less Safari/Firefox frames', () => {
    // Safari/Firefox: fn@app.js:42:17 —— 无尾括号，绝不能凭空补 ')'
    const safari = normalizeStackFrame('renderList@app.js:42:17');
    expect(safari).toBe('renderList@app.js');
    expect(safari).not.toMatch(/\)$/);

    // 同一崩溃点，Chrome (at fn (url:l:c)) 与 Firefox (fn@url:l:c) 归一后结构等价
    const chrome = normalizeStackFrame('    at renderList (app.js:42:17)');
    // Chrome 形态保留其 ')'；两者行列号都已剥离
    expect(chrome).not.toMatch(/42|17/);
    expect(safari).not.toMatch(/42|17/);
  });
});

describe('fingerprintStack groups same root cause', () => {
  const stackA = [
    'TypeError: Cannot read properties of null (reading "map")',
    '    at renderList (app.js:42:17)',
    '    at App (app.js:10:5)',
    '    at renderRoot (app.js:88:3)',
  ].join('\n');

  const stackB = [
    'TypeError: Cannot read properties of null (reading "map")',
    '    at renderList (app.js:99:24)', // 不同行列
    '    at App (app.js:10:5)',
    '    at renderRoot (app.js:88:3)',
  ].join('\n');

  it('same call site (different line/col) -> same primary fingerprint', () => {
    // top-3 归一化后，行列被剥离，前两帧一致 -> 同指纹
    // 注意：stackA 的 frame2 行列不同但归一化后相同
    expect(fingerprintStack(stackA)).toBe(fingerprintStack(stackB));
  });

  it('different top frame -> different primary fingerprint', () => {
    const stackC = stackA.replace('renderList', 'otherFn');
    expect(fingerprintStack(stackA)).not.toBe(fingerprintStack(stackC));
  });

  it('undefined stack -> stable sentinel', () => {
    expect(fingerprintStack(undefined)).toBe(fingerprintStack(undefined));
  });
});

describe('message / url normalization', () => {
  it('normalizes numbers, uuids, urls, quoted strings', () => {
    expect(normalizeMessage("Cannot read 'foo' of id 123 at https://x.com/y"))
      .toBe('Cannot read <str> of id <n> at <url>');
    expect(normalizeMessage('user a1b2c3d4-1234-5678-9abc-def012345678 failed'))
      .toBe('user <uuid> failed');
  });

  it('normalizes url path segments and query', () => {
    expect(normalizeUrl('/api/users/123/posts?a=1')).toBe('/api/users/<n>/posts');
    expect(normalizeUrl('https://cdn.x.com/assets/index-a1b2c3d4.js'))
      .toBe('https://cdn.x.com/assets/index-[hash].js');
  });
});

describe('objectOrder', () => {
  it('order-independent for same keys', () => {
    expect(objectOrder({ a: 1, b: 2 })).toBe(objectOrder({ b: 2, a: 1 }));
  });
  it('order-dependent for different keys', () => {
    expect(objectOrder({ a: 1 })).not.toBe(objectOrder({ a: 1, b: 2 }));
  });
});

describe('computeFingerprint dual-dimension', () => {
  it('produces primary + secondary', () => {
    const fp = computeFingerprint({
      message: 'Cannot read properties of null',
      stack: '    at foo (app.js:42:17)',
      sourceURL: '/api/users/123',
      errorType: 'TypeError',
    });
    expect(fp.primary).toMatch(/^[0-9a-f]+$/);
    expect(fp.secondary).toMatch(/^[0-9a-f]+$/);
  });

  it('same interface error (different user id) -> same secondary', () => {
    const a = computeFingerprint({ message: 'fetch failed', sourceURL: '/api/users/123', errorType: 'NetworkError' });
    const b = computeFingerprint({ message: 'fetch failed', sourceURL: '/api/users/456', errorType: 'NetworkError' });
    expect(a.secondary).toBe(b.secondary);
  });

  it('promise rejection object normalized via objectOrder', () => {
    const a = computeFingerprint({ message: 'x', reason: { code: 'E1', msg: 'x' }, errorType: 'PromiseError' });
    const b = computeFingerprint({ message: 'x', reason: { msg: 'x', code: 'E1' }, errorType: 'PromiseError' });
    expect(a.secondary).toBe(b.secondary);
  });
});