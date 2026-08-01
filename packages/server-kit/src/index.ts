/**
 * @monit/server-kit —— Node 端 HTTP 守卫与签名工具（@monit/backend 与 @monit/coordinator 共享）。
 *
 * 守卫在 Router dispatch 层强制（鉴权/Origin/限流/有界 body），杜绝各 server 各自实现漂移与遗漏。
 * Ed25519 私钥签名 + acorn AST 严格白名单 + 行 diff，支撑热修不可伪造与门禁 locality 准确。
 */
export { TokenBucket, RateLimiter, type RateLimiterOptions } from './ratelimit';
export { checkAuth, extractBearer, isLoopback, type AuthResult, type RequestLike as AuthRequestLike } from './auth';
export { checkOrigin, corsHeaders, readOrigin, type OriginResult } from './cors';
export { readBody, decodeBody, type BodyResult, type ReadStreamLike } from './body';
export { audit, consoleAudit, type AuditEntry, type AuditSink } from './audit';
export {
  generateSigningKeyPair,
  privateKeyFromPem,
  publicKeyFromPem,
  privateKeyFromDerBase64,
  publicKeyToSpkiBase64,
  signPatch,
  verifyPatchSignatureNode,
  type SigningKeyPair,
} from './signing';
export { countChangedLines } from './diff';
export { validatePatchCodeStrict } from './patch-ast';
export {
  HttpRouter,
  type RouteSpec,
  type RoutePolicy,
  type RouteContext,
  type RouteResult,
  type RouteHandler,
  type GuardConfig,
} from './router';
// 复用 crypto-kit 跨端件
export { canonicalPayload, createEd25519Verifier, type SignablePatch } from '@monit/crypto-kit';
