import { describe, it, expect } from 'vitest';
import { PatchRegistry, type RuntimePatch } from '../src/patch-registry';
import { generateSigningKeyPair, publicKeyToSpkiBase64, createEd25519Verifier, type SignablePatch } from '@monit/server-kit';

function makeRegistry(ttlMs?: number): PatchRegistry {
  const kp = generateSigningKeyPair();
  return new PatchRegistry(kp.privateKey, kp.publicKey, ttlMs);
}

function toSignable(p: RuntimePatch): SignablePatch {
  return {
    id: p.id, fingerprint: p.fingerprint, patchType: p.patchType,
    targetPath: p.targetPath ?? '', code: p.code ?? '',
    nonce: p.nonce, createdAt: p.createdAt, expiresAt: p.expiresAt,
  };
}

describe('PatchRegistry（Ed25519 签名运行时热修注册表）', () => {
  it('register → patchId/rollbackToken/signature/nonce/expiresAt，且出现在 active', () => {
    const r = makeRegistry();
    const reg = r.register({ fingerprint: 'fp-1', patchType: 'guard', targetPath: 'window.app.foo' });
    expect(reg.patchId).toMatch(/^patch-/);
    expect(reg.rollbackToken).toMatch(/^rb-/);
    expect(reg.signature).toMatch(/^[0-9a-f]{128}$/); // Ed25519 = 64 bytes hex
    expect(reg.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(reg.expiresAt).toBeGreaterThan(Date.now());
    expect(r.active().length).toBe(1);
    expect(r.active()[0].fingerprint).toBe('fp-1');
  });

  it('verify（node）：签名正确 → true', () => {
    const r = makeRegistry();
    const reg = r.register({ fingerprint: 'fp-1', patchType: 'guard', targetPath: 'a.b' });
    expect(r.verify(r.get(reg.patchId)!)).toBe(true);
  });

  it('跨端互通：node 签 ↔ WebCrypto（SDK）公钥验签 → true；篡改 → false', async () => {
    const kp = generateSigningKeyPair();
    const r = new PatchRegistry(kp.privateKey, kp.publicKey);
    const reg = r.register({ fingerprint: 'fp-1', patchType: 'replace', targetPath: 'a.b', code: '1' });
    const patch = r.get(reg.patchId)!;
    const verify = createEd25519Verifier(publicKeyToSpkiBase64(kp.publicKey));
    await expect(verify(toSignable(patch), patch.signature)).resolves.toBe(true);
    await expect(verify(toSignable({ ...patch, code: '999' }), patch.signature)).resolves.toBe(false);
  });

  it('verify：篡改 code/targetPath/fingerprint → 签名失效', () => {
    const r = makeRegistry();
    const reg = r.register({ fingerprint: 'fp-1', patchType: 'replace', targetPath: 'a.b', code: '1' });
    const tampered = r.get(reg.patchId)!;
    tampered.code = '999';
    expect(r.verify(tampered)).toBe(false);
  });

  it('不同密钥对签名不互认（防伪造）', () => {
    const r1 = makeRegistry();
    const r2 = makeRegistry();
    const reg = r1.register({ fingerprint: 'fp-1', patchType: 'guard', targetPath: 'a.b' });
    expect(r2.verify(r1.get(reg.patchId)!)).toBe(false);
  });

  it('revoke → active 移除、verify 失败', () => {
    const r = makeRegistry();
    const reg = r.register({ fingerprint: 'fp-1', patchType: 'guard', targetPath: 'a.b' });
    expect(r.revoke(reg.patchId)).toBe(true);
    expect(r.active().length).toBe(0);
    expect(r.verify(r.get(reg.patchId)!)).toBe(false);
  });

  it('revokeByToken 凭回滚令牌吊销；伪造 suffix → 拒绝', () => {
    const r = makeRegistry();
    const reg = r.register({ fingerprint: 'fp-1', patchType: 'guard', targetPath: 'a.b' });
    expect(r.revokeByToken(reg.rollbackToken)).toBe(true);
    // 重新登记一个，用伪造 suffix 吊销 → 失败
    const reg2 = r.register({ fingerprint: 'fp-2', patchType: 'guard', targetPath: 'a.b' });
    const forged = reg2.rollbackToken.replace(/[0-9a-f]{8}$/, 'deadbeef');
    expect(r.revokeByToken(forged)).toBe(false);
    expect(r.get(reg2.patchId)!.revoked).toBe(false);
  });

  it('过期 patch：verify 失败、active 排除', () => {
    const r = makeRegistry(0); // ttl=0 → 立即过期
    const reg = r.register({ fingerprint: 'fp-1', patchType: 'guard', targetPath: 'a.b' });
    expect(r.verify(r.get(reg.patchId)!)).toBe(false);
    expect(r.active().length).toBe(0);
  });

  it('登记时 AST 严格校验：恶意 code 抛错（进不了注册表）', () => {
    const r = makeRegistry();
    expect(() => r.register({ fingerprint: 'fp', patchType: 'replace', targetPath: 'a.b', code: 'fetch("/exfil")' })).toThrow();
    expect(() => r.register({ fingerprint: 'fp', patchType: 'replace', targetPath: 'a.b', code: 'new Function("x")' })).toThrow();
    expect(r.active().length).toBe(0);
  });

  it('登记时 replace/wrap 缺 code → 抛错', () => {
    const r = makeRegistry();
    expect(() => r.register({ fingerprint: 'fp', patchType: 'replace', targetPath: 'a.b' } as never)).toThrow();
  });
});
