/**
 * HTTP Router —— 守卫在 dispatch 层强制（不可绕过）。
 *
 * 每个 RouteSpec 声明 policy（write/read/sdk/open），Router 在进入 handler 前【自动】依次执行：
 *   CORS preflight → Origin 校验 → 限流 → 鉴权（write/sdk）→ 有界 body。
 * handler 无需也无法跳过守卫 —— 这是"每个写端点强制过中间件，非 opt-in"的落实。
 *
 * 路由匹配优先级：精确 > 带参(:x) > 前缀(*)，按 specificity 而非声明序，
 * 消灭 "/api/errors/:fp" 吃掉 "/api/errors/trend" 的脆弱顺序。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { checkAuth } from './auth';
import { checkOrigin, corsHeaders, readOrigin } from './cors';
import { readBody, decodeBody } from './body';
import { audit } from './audit';

export type RoutePolicy = 'write' | 'read' | 'sdk' | 'open';

export interface RouteContext {
  method: string;
  url: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: string;
  req: IncomingMessage;
}

export interface RouteResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

export interface RouteSpec {
  method: string;
  /** 精确 '/x' / 带参 '/x/:id' / 前缀 '/x/*' */
  path: string;
  policy: RoutePolicy;
  bodyMax?: number;
  handler: RouteHandler;
}

export interface GuardConfig {
  /** write policy 的 bearer token；未配置时 loopback 放行、非 loopback 拒绝 */
  authToken?: string;
  /** sdk policy（如 /heal/patches）的独立只读 token；未配置则回退 authToken */
  sdkToken?: string;
  allowOrigins: string[];
  allowLoopbackOrigin: boolean;
  bodyMax: Record<RoutePolicy, number>;
  rateLimit: Record<RoutePolicy, import('./ratelimit').RateLimiter>;
  audit?: import('./audit').AuditSink;
}

interface CompiledRoute {
  spec: RouteSpec;
  kind: 'exact' | 'param' | 'prefix';
  segs: string[];
  prefix: string;
  specificity: number; // exact=3, param=2, prefix=1
}

function compileRoute(spec: RouteSpec): CompiledRoute {
  const segs = spec.path.split('/').filter(Boolean);
  let kind: CompiledRoute['kind'] = 'exact';
  if (segs.some((s) => s === '*')) kind = 'prefix';
  else if (segs.some((s) => s.startsWith(':'))) kind = 'param';
  const prefix = kind === 'prefix' ? '/' + segs.filter((s) => s !== '*').join('/') : spec.path;
  const specificity = kind === 'exact' ? 3 : kind === 'param' ? 2 : 1;
  return { spec, kind, segs, prefix, specificity };
}

function matchRoute(route: CompiledRoute, pathname: string): Record<string, string> | null {
  if (route.kind === 'exact') {
    return pathname === route.spec.path ? {} : null;
  }
  const parts = pathname.split('/').filter(Boolean);
  if (route.kind === 'param') {
    if (parts.length !== route.segs.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < route.segs.length; i++) {
      const seg = route.segs[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) return null;
    }
    return params;
  }
  // prefix
  const pre = route.prefix;
  if (pathname === pre || pathname.startsWith(pre.endsWith('/') ? pre : pre + '/')) return {};
  if (pre === '/' ) return {};
  return null;
}

export class HttpRouter {
  private routes: CompiledRoute[];
  constructor(private cfg: GuardConfig, routes: RouteSpec[]) {
    this.routes = routes.map(compileRoute).sort((a, b) => b.specificity - a.specificity);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    let pathname = rawUrl;
    let query = new URLSearchParams();
    const qIdx = rawUrl.indexOf('?');
    if (qIdx >= 0) {
      pathname = rawUrl.slice(0, qIdx);
      query = new URLSearchParams(rawUrl.slice(qIdx + 1));
    }

    const origin = readOrigin(req);
    const cors = corsHeaders(origin, this.cfg.allowOrigins, this.cfg.allowLoopbackOrigin);

    // CORS preflight
    if (method === 'OPTIONS') {
      this.send(res, 204, undefined, cors);
      return;
    }

    const remote = req.socket?.remoteAddress ?? '?';

    // 404 也限流 + 审计（防路由扫描）
    const route = this.routes.find((r) => r.spec.method.toUpperCase() === method && matchRoute(r, pathname));
    if (!route) {
      if (!this.cfg.rateLimit.open.allow(remote)) {
        audit(this.cfg.audit, { level: 'deny', method, url: pathname, origin, remote, status: 429, reason: 'rate-limit' });
        this.send(res, 429, { error: 'rate limited' }, { ...cors, 'Retry-After': '1' });
        return;
      }
      audit(this.cfg.audit, { level: 'info', method, url: pathname, origin, remote, status: 404 });
      this.send(res, 404, { error: 'not found' }, cors);
      return;
    }

    const policy = route.spec.policy;

    // Origin 校验（跨源写必须白名单/loopback；非浏览器无 Origin 放行）
    const o = checkOrigin(req, this.cfg.allowOrigins, this.cfg.allowLoopbackOrigin);
    if (!o.allowed) {
      audit(this.cfg.audit, { level: 'deny', method, url: pathname, origin, remote, status: 403, reason: 'origin-not-allowed' });
      this.send(res, 403, { error: 'origin not allowed' }, cors);
      return;
    }

    // 限流
    if (!this.cfg.rateLimit[policy].allow(remote)) {
      audit(this.cfg.audit, { level: 'deny', method, url: pathname, origin, remote, status: 429, reason: 'rate-limit' });
      this.send(res, 429, { error: 'rate limited' }, { ...cors, 'Retry-After': '1' });
      return;
    }

    // 鉴权（write / sdk）
    if (policy === 'write' || policy === 'sdk') {
      const token = policy === 'sdk' ? (this.cfg.sdkToken ?? this.cfg.authToken) : this.cfg.authToken;
      const a = checkAuth(req, token);
      if (!a.ok) {
        audit(this.cfg.audit, { level: 'deny', method, url: pathname, origin, remote, status: a.status, reason: a.reason });
        this.send(res, a.status, a.body, cors);
        return;
      }
    }

    // 有界 body（仅 body 方法）
    let body: unknown = null;
    let rawBody = '';
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const max = route.spec.bodyMax ?? this.cfg.bodyMax[policy];
      const br = await readBody(req, max);
      if (!br.ok) {
        audit(this.cfg.audit, { level: 'deny', method, url: pathname, origin, remote, status: br.status, reason: br.error });
        this.send(res, br.status, { error: br.error }, cors);
        return;
      }
      const encoding = req.headers['content-encoding'];
      rawBody = decodeBody(br.bytes ?? '', Array.isArray(encoding) ? encoding[0] : encoding);
      if (rawBody) {
        try {
          body = JSON.parse(rawBody);
        } catch {
          body = null; // 非 JSON：handler 自行用 rawBody（如 sourcemap raw 文本）
        }
      }
    }

    const params = matchRoute(route, pathname) ?? {};
    const ctx: RouteContext = {
      method, url: pathname, query, params,
      headers: req.headers as Record<string, string | string[] | undefined>,
      body, rawBody, req,
    };

    let result: RouteResult;
    try {
      result = await route.spec.handler(ctx);
    } catch (err) {
      audit(this.cfg.audit, { level: 'deny', method, url: pathname, origin, remote, status: 500, reason: 'handler-throw' });
      result = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }

    audit(this.cfg.audit, { level: result.status >= 400 ? 'deny' : 'info', method, url: pathname, origin, remote, status: result.status });
    this.send(res, result.status, result.body, { ...cors, ...(result.headers ?? {}) });
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string>): void {
    res.statusCode = status;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    if (body === undefined || status === 204) {
      res.end();
    } else {
      if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    }
  }
}
