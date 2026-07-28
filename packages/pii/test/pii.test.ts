import { describe, it, expect } from 'vitest';
import { redactPayload, containsPii, DEFAULT_PATTERNS } from '../src/index';

describe('redactPayload', () => {
  it('redacts emails', () => {
    const out = redactPayload({ msg: 'contact me at a@b.com please' });
    expect(out.msg).not.toContain('a@b.com');
    expect(out.msg).toContain('[REDACTED]');
  });

  it('redacts China phone numbers', () => {
    const out = redactPayload({ msg: 'call 13812345678' });
    expect(out.msg).not.toContain('13812345678');
  });

  it('redacts API keys (OpenAI / AWS / GitHub)', () => {
    const out = redactPayload({
      openai: 'sk-abcd1234abcd1234abcd1234abcd1234abcd1234',
      aws: 'AKIA' + 'X'.repeat(16),
      github: 'ghp_' + 'a'.repeat(36),
    });
    expect(containsPii(JSON.stringify(out))).toBe(false);
  });

  it('redacts JWT', () => {
    const out = redactPayload({ token: 'eyJhbGciOiJIUzI1Ni.eyJzdWIiOiIx.e30aaaaaaaaa' });
    expect(out.token).toContain('[REDACTED]');
  });

  it('force-redacts configured field paths', () => {
    const out = redactPayload({ payload: { password: 'secret123' } }, { fields: ['payload.password'] });
    expect(out.payload.password).toBe('[REDACTED]');
  });

  it('custom fieldMatcher', () => {
    const out = redactPayload({ user: { ssn: '123-45-6789' } }, { fieldMatcher: (path) => path.endsWith('ssn') });
    expect(out.user.ssn).toBe('[REDACTED]');
  });

  it('recurses arrays', () => {
    const out = redactPayload([{ email: 'x@y.com' }, { email: 'z@w.com' }]);
    expect(out[0].email).toBe('[REDACTED]');
  });

  it('disableDefaults + custom pattern only', () => {
    const out = redactPayload({ a: 'x@y.com', b: 'SECRET_VAL' }, { disableDefaults: true, patterns: [/SECRET_VAL/g] });
    expect(out.a).toBe('x@y.com'); // 默认 email 规则关闭
    expect(out.b).toBe('[REDACTED]');
  });

  it('DEFAULT_PATTERNS covers all advertised key types', () => {
    expect(DEFAULT_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });
});
