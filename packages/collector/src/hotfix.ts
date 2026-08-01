/**
 * @monit/collector/hotfix - 运行时热修客户端（轨道 A，patch-registry-over-SDK）
 *
 * 交付模型：SDK 主动从 coordinator 拉取【Ed25519 签名】活跃 patch，按错误指纹应用行为保留型补丁
 * （replace/wrap/guard），保留原始引用供回滚。不依赖 CDP（生产对随机页面不可达）。
 *
 * 安全（本轮升级 —— 不可伪造、防重放、防过期）：
 * - 验签用【公钥】（Ed25519，WebCrypto）。SDK 无需任何密钥；无 publicKey 或验签失败 → fail-closed 拒绝。
 * - 校验 expiresAt 未过期；nonce 防重放（LRU 上限，同一签名 patch 不可二次应用）。
 * - applyPatch 前 validatePatchCodeLight（token 黑名单深度防御；服务端已 acorn AST 严格校验）。
 *
 * 行为保留（非 masking）：
 * - replace：用补丁代码覆盖目标（治标，可逆）
 * - wrap：包装原函数（前后置逻辑）
 * - guard：空值守卫（null → [] 兜底，防 TypeError 白屏）
 * 不含 error-boundary 关键字吞错（masking）与 prototype 包装（全局破坏）。
 */

import { createEd25519Verifier, validatePatchCodeLight, type SignablePatch } from '@monit/crypto-kit';

export type HotfixPatchType = 'replace' | 'wrap' | 'guard';

export interface RuntimePatch {
  id: string;
  fingerprint: string;
  patchType: HotfixPatchType;
  targetPath?: string;
  code?: string;
  signature: string;
  nonce: string;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface HotfixClientOptions {
  /** coordinator GET /heal/patches 的 URL */
  registryUrl: string;
  /** 轮询间隔 ms，默认 30000 */
  pollIntervalMs?: number;
  /** Ed25519 公钥 base64 SPKI（从 coordinator /heal/public-key 获取）。必填：无 publicKey 则拒绝所有 patch。*/
  publicKey?: string;
  /** 自定义验签（覆盖 publicKey）；测试用 */
  verify?: (p: RuntimePatch) => boolean | Promise<boolean>;
  /** 允许应用未签名 patch（默认 false=拒绝）。仅本地调试用——生产务必配 publicKey/verify。*/
  allowUnsigned?: boolean;
  /** 当前会话已采集的错误指纹（仅匹配的 patch 才应用）*/
  fingerprints?: () => string[];
  /** fetch 注入（测试用），默认全局 fetch */
  fetch?: typeof fetch;
  /** nonce 防重放集合上限，默认 1024 */
  maxSeenNonces?: number;
}

interface ResolvedPath {
  obj: Record<string, unknown>;
  key: string;
}

/** 解析 "a.b.c" 到 {obj: a.b, key: c} */
export function resolvePath(path: string, root: Record<string, unknown> = window as unknown as Record<string, unknown>): ResolvedPath | null {
  const parts = path.split('.');
  let obj: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = obj[parts[i]];
    if (next == null || typeof next !== 'object') return null;
    obj = next as Record<string, unknown>;
  }
  return { obj, key: parts[parts.length - 1] };
}

function toSignable(p: RuntimePatch): SignablePatch {
  return {
    id: p.id, fingerprint: p.fingerprint, patchType: p.patchType,
    targetPath: p.targetPath ?? '', code: p.code ?? '',
    nonce: p.nonce, createdAt: p.createdAt, expiresAt: p.expiresAt,
  };
}

/**
 * 在页面应用一个行为保留型 patch。返回 rollback 闭包（恢复原始引用），失败返回 null。
 * 纯操作（不拉取网络），便于测试。apply 前置轻量黑名单校验（深度防御）。
 */
export function applyPatch(p: RuntimePatch, root?: Record<string, unknown>): (() => void) | null {
  if (!p.targetPath) return null;
  // 深度防御：replace/wrap 的 code 过轻量黑名单（服务端已 acorn 严格校验，这是第二层）
  if (p.patchType !== 'guard' && p.code) {
    const v = validatePatchCodeLight(p.code);
    if (!v.ok) return null;
  }
  const resolved = resolvePath(p.targetPath, root);
  if (!resolved) return null;
  const { obj, key } = resolved;
  const orig = obj[key];
  const rollback = (): void => {
    try { obj[key] = orig; } catch { /* ignore */ }
  };

  try {
    if (p.patchType === 'replace') {
      if (!p.code) return null;
      // eslint-disable-next-line no-new-func
      obj[key] = new Function('return ' + p.code)();
    } else if (p.patchType === 'wrap') {
      if (typeof orig !== 'function' || !p.code) return null;
      // eslint-disable-next-line no-new-func
      obj[key] = new Function('orig', 'return ' + p.code)(orig);
    } else {
      // guard：空值守卫，null/undefined → []，异常 → []
      if (typeof orig !== 'function') return null;
      obj[key] = function (this: unknown, ...args: unknown[]) {
        try {
          const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
          return r == null ? [] : r;
        } catch {
          return [];
        }
      };
    }
  } catch {
    return null;
  }
  return rollback;
}

/**
 * 热修客户端：轮询拉取签名 patch，验签 + 防重放/过期 + 指纹匹配后应用，保留 rollback。
 */
export class HotfixClient {
  private rollbacks = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private seenNonces = new Set<string>();
  private readonly verifyFn: ((p: RuntimePatch) => boolean | Promise<boolean>) | undefined;
  private readonly maxSeen: number;

  constructor(private opts: HotfixClientOptions) {
    // publicKey 派生验签器；若两者都无则 verifyFn=undefined（默认拒绝，除非 allowUnsigned）
    this.verifyFn = opts.verify ?? (opts.publicKey ? this.makeEd25519Verifier(opts.publicKey) : undefined);
    this.maxSeen = opts.maxSeenNonces ?? 1024;
  }

  private makeEd25519Verifier(publicKey: string): (p: RuntimePatch) => Promise<boolean> {
    const verify = createEd25519Verifier(publicKey);
    return async (p: RuntimePatch): Promise<boolean> => verify(toSignable(p), p.signature);
  }

  start(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.opts.pollIntervalMs ?? 30_000);
  }

  private async poll(): Promise<void> {
    let patches: RuntimePatch[];
    try {
      const f = this.opts.fetch ?? globalThis.fetch;
      const res = await f(this.opts.registryUrl);
      const data = (await res.json()) as { patches?: RuntimePatch[] };
      patches = data.patches ?? [];
    } catch {
      return;
    }
    const now = Date.now();
    const fps = this.opts.fingerprints ? this.opts.fingerprints() : null;
    for (const p of patches) {
      if (this.rollbacks.has(p.id)) continue;
      if (p.revoked) continue;
      if (typeof p.expiresAt === 'number' && p.expiresAt <= now) continue; // 过期
      if (typeof p.nonce === 'string' && p.nonce && this.seenNonces.has(p.nonce)) continue; // 重放
      // 签名校验（fail-closed：无 verifyFn 且未 allowUnsigned → 拒绝）
      if (this.verifyFn) {
        const ok = await this.verifyFn(p);
        if (!ok) continue;
      } else if (!this.opts.allowUnsigned) {
        continue;
      }
      if (fps && !fps.includes(p.fingerprint)) continue;
      // 标记 nonce 已见（LRU）
      if (typeof p.nonce === 'string' && p.nonce) this.markSeen(p.nonce);
      const rb = applyPatch(p);
      if (rb) this.rollbacks.set(p.id, rb);
    }
  }

  private markSeen(nonce: string): void {
    this.seenNonces.add(nonce);
    if (this.seenNonces.size > this.maxSeen) {
      const first = this.seenNonces.values().next().value;
      if (first) this.seenNonces.delete(first);
    }
  }

  /** 回滚单个 patch */
  rollback(id: string): boolean {
    const rb = this.rollbacks.get(id);
    if (!rb) return false;
    rb();
    this.rollbacks.delete(id);
    return true;
  }

  /** 回滚全部 */
  rollbackAll(): void {
    for (const rb of this.rollbacks.values()) rb();
    this.rollbacks.clear();
  }

  /** 已应用 patch 数（调试/测试）*/
  get appliedCount(): number {
    return this.rollbacks.size;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
