/**
 * Ed25519 私钥签名（Node 端）。配合 @monit/crypto-kit 的 canonicalPayload 与浏览器侧
 * createEd25519Verifier（WebCrypto）。两端对同一 SignablePatch 产出/校验同一签名。
 *
 * 服务端持私钥，公钥下发给 SDK —— SDK 无需任何密钥即可验签，密钥不分发 = 不可伪造。
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { canonicalPayload, type SignablePatch } from '@monit/crypto-kit';

export interface SigningKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey };
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

export function publicKeyFromPem(pem: string): KeyObject {
  return createPublicKey(pem);
}

/** 公钥导出为 SPKI base64（下发给 SDK 用于 WebCrypto 验签）。 */
export function publicKeyToSpkiBase64(publicKey: KeyObject): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
}

/** 私钥从 SPKI/PKCS8 DER base64 加载（便于配置）。 */
export function privateKeyFromDerBase64(b64: string): KeyObject {
  return createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
}

/** 用私钥对 patch 签名，返回 hex。 */
export function signPatch(privateKey: KeyObject, patch: SignablePatch): string {
  const sig = sign(null, Buffer.from(canonicalPayload(patch)), privateKey);
  return Buffer.from(sig).toString('hex');
}

/** Node 端验签（用于服务端自校验 / 测试）。 */
export function verifyPatchSignatureNode(
  publicKey: KeyObject,
  patch: SignablePatch,
  signatureHex: string,
): boolean {
  try {
    return cryptoVerify(null, Buffer.from(canonicalPayload(patch)), publicKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
