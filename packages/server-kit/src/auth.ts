/**
 * Bearer token 鉴权。常量时间比较（防时序侧信道）。
 *
 * 不可绕过策略：
 * - 未配置 token 时，loopback（127.0.0.1/::1）放行（本地开发友好），
 *   非 loopback 一律 401（强制配置 token 才能对外）。
 * - 配置了 token 后，所有非 open 端点必须带匹配 Bearer；错误 token 401。
 */
import { timingSafeEqual } from 'node:crypto';

export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

export interface AuthResult {
  ok: boolean;
  status: number;
  body?: unknown;
  reason: string;
  loopback: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(remoteAddress?: string): boolean {
  return !!remoteAddress && LOOPBACK.has(remoteAddress);
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function extractBearer(headers: Record<string, string | string[] | undefined> | undefined): string | undefined {
  const raw = headers?.authorization ?? headers?.Authorization;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v === 'string' && v.startsWith('Bearer ')) return v.slice(7).trim();
  return undefined;
}

/**
 * @param token 已配置的 token（undefined = 未配置）
 */
export function checkAuth(req: RequestLike, token: string | undefined): AuthResult {
  const remote = req.socket?.remoteAddress;
  const loopback = isLoopback(remote);

  if (!token) {
    // 未配置：loopback 放行，远程拒绝（强制配置才能对外暴露）
    return loopback
      ? { ok: true, status: 200, loopback, reason: 'no-token-loopback' }
      : { ok: false, status: 401, loopback, body: { error: 'auth token not configured; remote access disabled' }, reason: 'no-token-remote' };
  }

  const presented = extractBearer(req.headers);
  if (presented && safeEqualString(presented, token)) {
    return { ok: true, status: 200, loopback, reason: 'token-ok' };
  }
  return { ok: false, status: 401, loopback, body: { error: 'unauthorized' }, reason: 'bad-token' };
}
