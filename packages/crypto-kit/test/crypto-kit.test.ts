import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalPayload,
  createEd25519Verifier,
  validatePatchCodeLight,
  bytesToHex,
} from '../src/index';

const samplePatch = {
  id: 'p1',
  fingerprint: 'fp',
  patchType: 'replace',
  targetPath: 'a.b',
  code: '1',
  nonce: 'n1',
  createdAt: 100,
  expiresAt: 200,
};

describe('canonicalPayload', () => {
  it('固定数组顺序，同输入同输出', () => {
    expect(canonicalPayload(samplePatch)).toBe('["p1","fp","replace","a.b","1","n1",100,200]');
    expect(canonicalPayload(samplePatch)).toBe(canonicalPayload(samplePatch));
  });
  it('任一字段变化都会改变 payload（含 nonce/时间，防重放与 TTL 绕过）', () => {
    expect(canonicalPayload({ ...samplePatch, code: '2' })).not.toBe(canonicalPayload(samplePatch));
    expect(canonicalPayload({ ...samplePatch, nonce: 'n2' })).not.toBe(canonicalPayload(samplePatch));
    expect(canonicalPayload({ ...samplePatch, expiresAt: 999 })).not.toBe(canonicalPayload(samplePatch));
  });
});

describe('createEd25519Verifier（Node 私钥签 ↔ WebCrypto 公钥验，实际部署模型）', () => {
  it('有效签名通过；篡改 code / 签名 / nonce 全拒绝', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pubB64 = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const verify = createEd25519Verifier(pubB64);
    const sigHex = bytesToHex(new Uint8Array(sign(null, Buffer.from(canonicalPayload(samplePatch)), privateKey)));

    await expect(verify(samplePatch, sigHex)).resolves.toBe(true);
    await expect(verify({ ...samplePatch, code: '2' }, sigHex)).resolves.toBe(false); // 篡改 code
    await expect(verify({ ...samplePatch, nonce: 'n2' }, sigHex)).resolves.toBe(false); // 重放换 nonce
    await expect(verify(samplePatch, '00'.repeat(64))).resolves.toBe(false); // 篡改签名
  });

  it('跨密钥对：用 B 私钥签的签名被 A 公钥拒绝（不可伪造）', async () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const pubB64 = (a.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
    const verify = createEd25519Verifier(pubB64);
    const sigHex = bytesToHex(new Uint8Array(sign(null, Buffer.from(canonicalPayload(samplePatch)), b.privateKey)));
    await expect(verify(samplePatch, sigHex)).resolves.toBe(false);
  });
});

describe('validatePatchCodeLight', () => {
  it('允许简单行为保留代码', () => {
    expect(validatePatchCodeLight('function(x){ return x ?? [] }').ok).toBe(true);
    expect(validatePatchCodeLight('function(orig){ return function(...a){ return orig.apply(this,a) } }').ok).toBe(true);
    expect(validatePatchCodeLight('1').ok).toBe(true);
  });
  it('禁止网络/全局/DOM 标识符', () => {
    for (const bad of ['fetch("/x")', 'document.cookie', 'window.location', 'eval("1")', 'new Function("x")', 'localStorage.getItem("k")', 'navigator.userAgent', 'globalThis.x']) {
      expect(validatePatchCodeLight(bad).ok, bad).toBe(false);
    }
  });
  it('禁止原型链污染', () => {
    expect(validatePatchCodeLight('x.__proto__').ok).toBe(false);
    expect(validatePatchCodeLight('o.constructor.prototype').ok).toBe(false);
  });
  it('禁止 URL / 危险协议字面量', () => {
    expect(validatePatchCodeLight('var u = "https://evil.com"').ok).toBe(false);
    expect(validatePatchCodeLight('const d = "data:text/html,x"').ok).toBe(false);
  });
  it('禁止不平衡括号 / 注释截断', () => {
    expect(validatePatchCodeLight('function({').ok).toBe(false);
    expect(validatePatchCodeLight('/* 未闭合').ok).toBe(false);
  });
  it('拒绝空 / 超长', () => {
    expect(validatePatchCodeLight('').ok).toBe(false);
    expect(validatePatchCodeLight('a'.repeat(5000)).ok).toBe(false);
  });
  it('不误报正常代码中的 http 注释（注释内 URL 仍视为危险——保守）', () => {
    // 注释里出现协议字面量也拒绝（热修代码不应含任何协议串）
    expect(validatePatchCodeLight('// see https://doc').ok).toBe(false);
  });
});
