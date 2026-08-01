/**
 * @monit/crypto-kit — 跨端（浏览器 + Node）纯密码学工具
 *
 * 服务端签名（@monit/server-kit 用 Node crypto）与浏览器验签（@monit/collector/hotfix 用
 * WebCrypto）必须对同一 payload 产出/校验同一签名。本包提供：
 *  1. canonicalPayload —— 确定性序列化（数组固定顺序，杜绝对象键序漂移），两端字节级一致；
 *  2. createEd25519Verifier —— WebCrypto 公钥验签（SDK 无需任何密钥，不可伪造）；
 *  3. validatePatchCodeLight —— 热修代码轻量黑名单（SDK 侧深度防御，零依赖）。
 *
 * 纯 TS + 全局 WebCrypto，无 Node 内置依赖 → 可进浏览器 bundle。
 *
 * 签名方案：Ed25519（非对称）。服务端持私钥签名，浏览器持公钥验签。
 * payload 含 nonce + createdAt + expiresAt → 防重放 + 防 TTL 绕过。
 */

/** 参与签名的补丁字段（coalesce 后，全必填）。 */
export interface SignablePatch {
  id: string;
  fingerprint: string;
  patchType: string;
  targetPath: string; // 已 coalesce '' （undefined → ''）
  code: string; // 已 coalesce ''
  /** 一次性随机数（防重放，register 时由服务端生成） */
  nonce: string;
  /** 签发时间（ms） */
  createdAt: number;
  /** 过期时间（ms） */
  expiresAt: number;
}

/**
 * 签名 payload 的确定性序列化。
 * 用【数组 + 固定顺序】而非对象 —— JSON.stringify 对对象按插入序，但两端若字段集合不同会漂移；
 * 数组顺序写死，且缺字段立刻错位 → 签名不匹配，fail-closed。
 */
export function canonicalPayload(p: SignablePatch): string {
  return JSON.stringify([
    p.id,
    p.fingerprint,
    p.patchType,
    p.targetPath,
    p.code,
    p.nonce,
    p.createdAt,
    p.expiresAt,
  ]);
}

/** 签名算法标识（Ed25519）。 */
const ED25519 = { name: 'Ed25519' } as KeyAlgorithm;

/** base64 → Uint8Array（浏览器 atob / Node atob 均可用）。 */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** hex → Uint8Array。 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** bytes → hex（小写）。 */
export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * 构造 Ed25519 公钥验签器（浏览器/WebCrypto）。
 * @param publicKeySpkiBase64 公钥 SPKI DER 的 base64
 * @returns async (patch, signatureHex) => boolean。无 WebCrypto 或任何异常 → false（fail-closed）。
 *
 * subtle.verify 本身是密码学常量时间实现，无需额外比较。
 */
export function createEd25519Verifier(
  publicKeySpkiBase64: string,
): (patch: SignablePatch, signatureHex: string) => Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  const keyBytes = base64ToBytes(publicKeySpkiBase64);
  let keyPromise: Promise<CryptoKey> | null = null;
  const enc = new TextEncoder();

  return async (patch: SignablePatch, signatureHex: string): Promise<boolean> => {
    if (!subtle) return false; // 无 WebCrypto：拒绝（fail-closed，绝不放行未验签代码）
    try {
      if (!keyPromise) {
        keyPromise = subtle.importKey('spki', keyBytes, ED25519, false, ['verify']);
      }
      const key = await keyPromise;
      const data = enc.encode(canonicalPayload(patch));
      const sig = hexToBytes(signatureHex);
      return await subtle.verify(ED25519, key, sig, data);
    } catch {
      return false;
    }
  };
}

/**
 * 常量时间十六进制字符串比较（防时序侧信道）。长度不等直接 false。
 * 保留供 HMAC 兼容路径或其他用途。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 校验结果。 */
export interface PatchCodeValidation {
  ok: boolean;
  /** 失败原因（ok=false 时）。 */
  reason?: string;
}

/**
 * 热修代码【轻量】黑名单校验（SDK 侧深度防御，零依赖）。
 *
 * 注意：这是 token 扫描，无法防御 `window['ev'+'al']` 这类间接构造。
 * 服务端（@monit/server-kit.validatePatchCodeStrict）用 acorn AST 白名单做严格门禁，
 * 恶意代码在登记阶段就被拒（根本进不了注册表）。本函数是第二层兜底。
 *
 * 禁止：网络外泄、全局破坏、DOM/BOM 访问、原型链污染、动态代码执行、URL 字面量。
 */
const FORBIDDEN_IDENTIFIERS = new Set<string>([
  // 动态代码执行
  'eval', 'Function', 'importScripts', 'require', 'import',
  // 网络
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'navigator',
  // 全局破坏 / BOM
  'globalThis', 'process', 'window', 'self', 'top', 'parent', 'frames', 'opener',
  'location', 'navigate', 'open', 'close', 'alert', 'confirm', 'prompt',
  'postMessage', 'addEventListener', 'removeEventListener',
  // 存储
  'localStorage', 'sessionStorage', 'indexedDB', 'cookie',
  // 原型链污染
  'constructor', 'prototype', '__proto__',
  // 底层/反射
  'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'Proxy', 'Reflect',
  'queueMicrotask', 'structuredClone', 'exports', 'module', 'document', 'script',
]);

/** URL / 危险协议字面量（含字符串内）。热修不应有任何网络/数据协议。 */
const DANGEROUS_LITERAL = /(?:https?:|file:|ftp:|data:|blob:|javascript:|vbscript:)/i;

/** 括号配平检查。 */
function bracketsBalanced(code: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let inStr: false | "'" | '"' | '`' = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const next = code[i + 1];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') inBlockComment = false;
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = false;
      continue;
    }
    if (c === '/' && next === '/') { inLineComment = true; continue; }
    if (c === '/' && next === '*') { inBlockComment = true; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c as '"' | "'" | '`'; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== pairs[c]) return false;
    }
  }
  return stack.length === 0 && !inStr && !inBlockComment;
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

export function validatePatchCodeLight(code: string): PatchCodeValidation {
  if (typeof code !== 'string' || code.length === 0) return { ok: false, reason: 'empty code' };
  if (code.length > 4096) return { ok: false, reason: 'code too long (>4096)' };
  if (!bracketsBalanced(code)) return { ok: false, reason: 'unbalanced brackets' };
  if (DANGEROUS_LITERAL.test(code)) {
    return { ok: false, reason: 'forbidden URL/protocol literal' };
  }
  const matches = code.match(IDENT_RE) ?? [];
  for (const id of matches) {
    if (FORBIDDEN_IDENTIFIERS.has(id)) {
      return { ok: false, reason: `forbidden identifier: ${id}` };
    }
  }
  return { ok: true };
}
