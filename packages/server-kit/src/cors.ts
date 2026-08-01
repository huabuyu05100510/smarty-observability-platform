/**
 * Origin 守卫 —— CSRF 防护核心。
 *
 * 策略：
 * - 无 Origin 头（curl / 同源浏览器请求）→ 放行；
 * - 有 Origin：默认允许 loopback（127.0.0.1/localhost/::1 任意端口，本地开发友好），
 *   其余必须在 allowOrigins 白名单中，否则 403。
 * - CORS 响应头：仅对被允许的 Origin 回显具体值（不再用 '*'），并附 Vary: Origin。
 *
 * 这堵住"任意恶意网页跨源 POST 到本地 :3920/:3921"的 CSRF 攻击链。
 */
export interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
}

export interface OriginResult {
  allowed: boolean;
  origin?: string;
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

export function readOrigin(req: RequestLike): string | undefined {
  const raw = req.headers?.origin;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function checkOrigin(
  req: RequestLike,
  allowOrigins: string[],
  allowLoopback = true,
): OriginResult {
  const origin = readOrigin(req);
  if (!origin) return { allowed: true }; // 非浏览器/同源：无 Origin
  if (allowLoopback && isLoopbackOrigin(origin)) return { allowed: true, origin };
  if (allowOrigins.includes(origin)) return { allowed: true, origin };
  return { allowed: false, origin };
}

/** 计算应回显的 CORS 响应头（仅允许的 Origin 才回显）。 */
export function corsHeaders(
  origin: string | undefined,
  allowOrigins: string[],
  allowLoopback = true,
): Record<string, string> {
  if (origin && (allowOrigins.includes(origin) || (allowLoopback && isLoopbackOrigin(origin)))) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
    };
  }
  return { 'Vary': 'Origin' };
}
