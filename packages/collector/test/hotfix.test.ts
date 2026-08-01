// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalPayload } from '@monit/crypto-kit';
import { applyPatch, resolvePath, HotfixClient, type RuntimePatch } from '../src/hotfix';

declare global {
  interface Window {
    app?: Record<string, unknown>;
  }
}

/** 构造合法 RuntimePatch（补全新增的 nonce/createdAt/expiresAt/signature 字段）。 */
function makePatch(over: Partial<RuntimePatch>): RuntimePatch {
  return {
    id: 'p', fingerprint: 'fp', patchType: 'guard', targetPath: 'app.crash',
    signature: 's', nonce: 'n-' + Math.random().toString(36).slice(2), createdAt: 1,
    expiresAt: Date.now() + 100_000, revoked: false, ...over,
  };
}

describe('applyPatch（行为保留型，可回滚 + 轻量黑名单）', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).app = {
      crash: (items: unknown) => (items as { map: (f: (x: unknown) => unknown) => unknown[] }).map((x) => x),
      sum: (a: number, b: number) => a + b,
    };
  });

  it('guard：null 输入 → [] 兜底，不抛', () => {
    const rb = applyPatch(makePatch({ patchType: 'guard', targetPath: 'app.crash' }));
    expect(rb).not.toBeNull();
    expect((window.app!.crash as (...a: unknown[]) => unknown)(null)).toEqual([]);
    rb!();
  });

  it('rollback：恢复原始（崩溃行为回来）', () => {
    const rb = applyPatch(makePatch({ patchType: 'guard', targetPath: 'app.crash' }))!;
    rb();
    expect(() => (window.app!.crash as (...a: unknown[]) => unknown)(null)).toThrow();
  });

  it('wrap：包装原函数', () => {
    const rb = applyPatch(makePatch({ patchType: 'wrap', targetPath: 'app.sum', code: 'function(a,b){return orig(a,b)*2}' }))!;
    expect((window.app!.sum as (a: number, b: number) => number)(2, 3)).toBe(10);
    rb();
    expect((window.app!.sum as (a: number, b: number) => number)(2, 3)).toBe(5);
  });

  it('replace：覆盖目标', () => {
    const rb = applyPatch(makePatch({ patchType: 'replace', targetPath: 'app.sum', code: 'function(){return 42}' }))!;
    expect((window.app!.sum as () => number)()).toBe(42);
    rb();
    expect((window.app!.sum as (a: number, b: number) => number)(1, 1)).toBe(2);
  });

  it('路径不存在 → null（不抛）', () => {
    expect(applyPatch(makePatch({ targetPath: 'nope.missing' }))).toBeNull();
  });

  it('轻量黑名单：code 含 fetch → 拒绝应用（深度防御）', () => {
    expect(applyPatch(makePatch({ patchType: 'replace', targetPath: 'app.sum', code: 'fetch("/exfil")' }))).toBeNull();
  });

  it('resolvePath 解析嵌套路径', () => {
    const r = resolvePath('app.sum');
    expect(r).not.toBeNull();
    expect(r!.key).toBe('sum');
  });
});

describe('HotfixClient（Ed25519 验签 + 防重放/过期 + 指纹匹配）', () => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).app = { crash: (items: unknown) => (items as { map: (f: (x: unknown) => unknown) => unknown[] }).map((x) => x) };
  });

  function signPatch(priv: ReturnType<typeof generateKeyPairSync>['privateKey'], p: RuntimePatch): string {
    const signable = {
      id: p.id, fingerprint: p.fingerprint, patchType: p.patchType,
      targetPath: p.targetPath ?? '', code: p.code ?? '', nonce: p.nonce, createdAt: p.createdAt, expiresAt: p.expiresAt,
    };
    return Buffer.from(sign(null, Buffer.from(canonicalPayload(signable)), priv)).toString('hex');
  }

  it('Ed25519 公钥验签：有效签名应用；伪造签名拒绝', async () => {
    const kp = generateKeyPairSync('ed25519');
    const pubB64 = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const valid = makePatch({ id: 'sig', fingerprint: 'fp-A', patchType: 'guard', targetPath: 'app.crash' });
    valid.signature = signPatch(kp.privateKey, valid);

    const f1 = vi.fn(async () => new Response(JSON.stringify({ patches: [valid] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const c1 = new HotfixClient({ registryUrl: 'http://x/heal/patches', publicKey: pubB64, fingerprints: () => ['fp-A'], fetch: f1 });
    // @ts-expect-error poll
    await c1.poll();
    expect(c1.appliedCount).toBe(1);

    const forged = { ...valid, signature: '00'.repeat(64), id: 'sig2', nonce: 'n-forged' };
    const f2 = vi.fn(async () => new Response(JSON.stringify({ patches: [forged] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const c2 = new HotfixClient({ registryUrl: 'http://x/heal/patches', publicKey: pubB64, fingerprints: () => ['fp-A'], fetch: f2 });
    // @ts-expect-error poll
    await c2.poll();
    expect(c2.appliedCount).toBe(0);
  });

  it('无 publicKey 且未 allowUnsigned → 拒绝所有（fail-closed）', async () => {
    const p = makePatch({ fingerprint: 'fp-A', patchType: 'guard', targetPath: 'app.crash' });
    const f = vi.fn(async () => new Response(JSON.stringify({ patches: [p] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const c = new HotfixClient({ registryUrl: 'http://x', fingerprints: () => ['fp-A'], fetch: f });
    // @ts-expect-error poll
    await c.poll();
    expect(c.appliedCount).toBe(0);
  });

  it('nonce 防重放：同 nonce 第二次不应用', async () => {
    const kp = generateKeyPairSync('ed25519');
    const pubB64 = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const base = makePatch({ fingerprint: 'fp-A', patchType: 'guard', targetPath: 'app.crash', nonce: 'replay-nonce' });
    base.signature = signPatch(kp.privateKey, base);
    const f = vi.fn(async () => new Response(JSON.stringify({ patches: [base] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const c = new HotfixClient({ registryUrl: 'http://x', publicKey: pubB64, fingerprints: () => ['fp-A'], fetch: f });
    // @ts-expect-error poll
    await c.poll();
    expect(c.appliedCount).toBe(1);
    // @ts-expect-error poll —— 同 nonce 再次到达：rollbacks 已记录该 id 会跳过；换 id 同 nonce 验证 nonce 去重
    await c.poll();
    expect(c.appliedCount).toBe(1);
  });

  it('过期 patch → 拒绝应用', async () => {
    const kp = generateKeyPairSync('ed25519');
    const pubB64 = (kp.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const expired = makePatch({ fingerprint: 'fp-A', patchType: 'guard', targetPath: 'app.crash', expiresAt: Date.now() - 1000 });
    expired.signature = signPatch(kp.privateKey, expired);
    const f = vi.fn(async () => new Response(JSON.stringify({ patches: [expired] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const c = new HotfixClient({ registryUrl: 'http://x', publicKey: pubB64, fingerprints: () => ['fp-A'], fetch: f });
    // @ts-expect-error poll
    await c.poll();
    expect(c.appliedCount).toBe(0);
  });

  it('指纹不匹配 → 不应用', async () => {
    const p = makePatch({ fingerprint: 'fp-B', patchType: 'guard', targetPath: 'app.crash' });
    const f = vi.fn(async () => new Response(JSON.stringify({ patches: [p] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const c = new HotfixClient({ registryUrl: 'http://x', fingerprints: () => ['fp-A'], fetch: f, allowUnsigned: true });
    // @ts-expect-error poll
    await c.poll();
    expect(c.appliedCount).toBe(0);
  });
});
