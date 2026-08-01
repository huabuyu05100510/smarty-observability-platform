/**
 * @monit/coordinator/patch-registry - 运行时热修 patch 注册表（轨道 A 真实化）
 *
 * 交付模型 = patch-registry-over-SDK（非 CDP）：服务端把【Ed25519 签名】patch 入注册表，
 * SDK 拉取后用【公钥】验签，按错误指纹应用行为保留型补丁（replace/wrap/guard）。
 *
 * 安全（Ed25519 非对称，本轮升级 —— 密钥不分发）：
 * - 服务端持私钥签名，SDK 持公钥验签：SDK 无需任何密钥，签名不可伪造。
 * - payload 含 nonce + createdAt + expiresAt：防重放 + 防 TTL 绕过（过期 patch SDK 拒绝）。
 * - 登记时强制 validatePatchCodeStrict（acorn AST 白名单）：恶意/危险代码进不了注册表。
 * - rollbackToken 末尾 randomSuffix 在吊销时二次校验：堵"裸 patchId 即可吊销"。
 *
 * 行为保留：只允许 replace/wrap/guard（治标可逆），禁用 prototype（全局破坏）与
 *           error-boundary 关键字吞错（masking，与可观测使命冲突）。
 */

import { randomBytes, type KeyObject } from 'node:crypto';
import { signPatch, verifyPatchSignatureNode, validatePatchCodeStrict, type SignablePatch } from '@monit/server-kit';

/** 行为保留型 patch（轨道 A 白名单，不含 masking/prototype）*/
export type HotfixPatchType = 'replace' | 'wrap' | 'guard';

export interface RuntimePatchInput {
  /** 匹配的错误指纹（SDK 按指纹应用）*/
  fingerprint: string;
  patchType: HotfixPatchType;
  /** 如 "window.app.utils.fetchData" */
  targetPath?: string;
  /** replace/wrap 的补丁代码（IIFE 内的函数体/表达式）*/
  code?: string;
}

export interface RuntimePatch extends RuntimePatchInput {
  id: string;
  signature: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface RegisteredPatch {
  patchId: string;
  /** 回滚令牌（SDK 凭此请求 revoke，或本地直接回滚）*/
  rollbackToken: string;
  signature: string;
  nonce: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function toSignable(p: {
  id: string; fingerprint: string; patchType: string; targetPath?: string; code?: string;
  nonce: string; createdAt: number; expiresAt: number;
}): SignablePatch {
  return {
    id: p.id, fingerprint: p.fingerprint, patchType: p.patchType,
    targetPath: p.targetPath ?? '', code: p.code ?? '',
    nonce: p.nonce, createdAt: p.createdAt, expiresAt: p.expiresAt,
  };
}

export class PatchRegistry {
  private patches = new Map<string, RuntimePatch>();
  private rollbackSuffixes = new Map<string, string>();

  constructor(
    private readonly privateKey: KeyObject,
    private readonly publicKey: KeyObject,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  /**
   * 登记一个签名运行时 patch，返回 patchId + rollbackToken。
   * 登记时强制 AST 校验：危险/恶意 code 抛错（进不了注册表）。
   */
  register(input: RuntimePatchInput): RegisteredPatch {
    if (input.patchType !== 'guard') {
      if (!input.code) throw new Error('replace/wrap patch requires code');
      const v = validatePatchCodeStrict(input.code);
      if (!v.ok) throw new Error(`patch code rejected by AST whitelist: ${v.reason}`);
    }
    const id = `patch-${randomBytes(4).toString('hex')}`;
    const nonce = randomBytes(16).toString('hex');
    const createdAt = Date.now();
    const expiresAt = createdAt + this.ttlMs;
    const rollbackSuffix = randomBytes(4).toString('hex');
    const signature = signPatch(this.privateKey, toSignable({ id, ...input, nonce, createdAt, expiresAt }));
    const patch: RuntimePatch = { ...input, id, signature, nonce, createdAt, expiresAt, revoked: false };
    this.patches.set(id, patch);
    this.rollbackSuffixes.set(id, rollbackSuffix);
    return { patchId: id, rollbackToken: `rb-${id}-${rollbackSuffix}`, signature, nonce, expiresAt };
  }

  /** 活跃 patch 列表（供 SDK 拉取；自动排除已吊销与已过期）。*/
  active(): RuntimePatch[] {
    const now = Date.now();
    return [...this.patches.values()].filter((p) => !p.revoked && p.expiresAt > now);
  }

  get(id: string): RuntimePatch | undefined {
    return this.patches.get(id);
  }

  /** 服务端自校验：签名有效 + 未吊销 + 未过期。SDK 侧用 createEd25519Verifier（WebCrypto）做同样判定。*/
  verify(patch: RuntimePatch): boolean {
    if (patch.revoked) return false;
    if (patch.expiresAt <= Date.now()) return false;
    return verifyPatchSignatureNode(this.publicKey, toSignable(patch), patch.signature);
  }

  /** 吊销（回滚）*/
  revoke(id: string): boolean {
    const p = this.patches.get(id);
    if (!p) return false;
    p.revoked = true;
    return true;
  }

  /** 按 rollbackToken 吊销（token 格式 rb-<patchId>-<hex8>）。hex8 须匹配签发时的 randomSuffix。*/
  revokeByToken(token: string): boolean {
    if (!token.startsWith('rb-')) return false;
    const rest = token.slice(3);
    const m = rest.match(/^(.*)-([0-9a-f]{8})$/);
    if (!m) return false;
    const id = m[1];
    const suffix = m[2];
    if (this.rollbackSuffixes.get(id) !== suffix) return false; // 伪造 suffix 拒绝
    return this.revoke(id);
  }
}
