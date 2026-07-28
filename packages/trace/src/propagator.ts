/**
 * @monit/trace/propagator - W3C Trace Context 传播
 *
 * 吸收自 tracesdk/src/core/TraceContext.ts（质量高，原样保留核心算法）。
 *
 * 模型（对标 Datadog-RUM / 阿里 ARMS）：
 * - 每个 view（页面加载 / SPA 路由切换）一个 trace，持有一个 root spanId。
 * - 首个 view 的 traceId 从服务端渲染的 `<meta name="traceparent">` 或 cookie 继承，
 *   使文档请求回链到渲染页面的服务端 trace。
 * - 每个出站请求生成新 spanId（当前 traceId 下），该 spanId 成为 traceparent 的 parent-id。
 *
 * traceparent 格式（W3C）：version "-" trace-id "-" parent-id "-" trace-flags
 *   version:     00
 *   trace-id:    32 lowercase hex, not all zero
 *   parent-id:   16 lowercase hex, not all zero
 *   trace-flags: 2 hex (bit 0x01 = sampled)
 */

export const TRACEPARENT_HEADER = 'traceparent';

export interface TraceParentParts {
  traceId: string;
  spanId: string;
  flags: string;
}

export type RequestSpanContext = TraceParentParts;

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

interface ViewContext extends TraceParentParts {
  inherited: boolean;
}

export interface TraceContextOptions {
  enabled: boolean;
  inheritFromMeta?: string;
  inheritFromCookie?: string;
  traceFlags: string;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
const DEFAULT_FLAGS = '01';

// ─── W3C primitive helpers ───────────────────────────────────────────────────

function randomHex(byteLen: number): string {
  const bytes = new Uint8Array(byteLen);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLen; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < byteLen; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** 生成 W3C 合规 trace-id（32 hex，禁全 0） */
export function generateTraceIdHex(): string {
  let id = randomHex(16);
  if (id === ZERO_TRACE) id = randomHex(16);
  return id;
}

/** 生成 W3C 合规 span-id（16 hex，禁全 0） */
export function generateSpanIdHex(): string {
  let id = randomHex(8);
  if (id === ZERO_SPAN) id = randomHex(8);
  return id;
}

export function encodeTraceparent(parts: TraceParentParts): string {
  return `00-${parts.traceId}-${parts.spanId}-${parts.flags}`;
}

/**
 * 解析并校验入站 traceparent。任何畸形/全零/非 00 版本返回 null（W3C 要求忽略）。
 */
export function parseTraceparent(input: string | null | undefined): ParsedTraceparent | null {
  if (!input) return null;
  const m = input.trim().match(TRACEPARENT_RE);
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (version !== '00') return null;
  if (traceId === ZERO_TRACE) return null;
  if (spanId === ZERO_SPAN) return null;
  return { version, traceId, spanId, flags };
}

function readMetaContent(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const metas = document.getElementsByTagName('meta');
  for (let i = 0; i < metas.length; i++) {
    if (metas[i].getAttribute('name') === name) {
      return metas[i].getAttribute('content');
    }
  }
  return null;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined' || !document.cookie) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|; )' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// ─── Trace context manager (singleton) ───────────────────────────────────────

class TraceContextManager {
  private _options: TraceContextOptions = { enabled: true, traceFlags: DEFAULT_FLAGS };
  private _view: ViewContext | null = null;

  configure(opts: Partial<TraceContextOptions>): void {
    this._options = {
      enabled: opts.enabled ?? true,
      inheritFromMeta: opts.inheritFromMeta,
      inheritFromCookie: opts.inheritFromCookie,
      traceFlags: opts.traceFlags ?? DEFAULT_FLAGS,
    };
  }

  reset(): void {
    this._options = { enabled: true, traceFlags: DEFAULT_FLAGS };
    this._view = null;
  }

  get inherited(): boolean {
    return this._view?.inherited ?? false;
  }

  get current(): ViewContext | null {
    return this._view;
  }

  /** 当前 traceId（无 view 时 null） */
  get traceId(): string | null {
    return this._view?.traceId ?? null;
  }

  /**
   * (Re)initialize view trace。有入站 traceparent（meta/cookie）则继承 traceId
   * 并生成新 view root spanId；否则起新 trace。
   */
  startView(): ViewContext {
    const flags = this._options.traceFlags;
    const inbound = this._readInbound();
    if (inbound) {
      this._view = {
        traceId: inbound.traceId,
        spanId: generateSpanIdHex(),
        flags,
        inherited: true,
      };
    } else {
      this._view = {
        traceId: generateTraceIdHex(),
        spanId: generateSpanIdHex(),
        flags,
        inherited: false,
      };
    }
    return this._view;
  }

  /**
   * 为单个出站请求生成 span context。传播关闭时返回 null。无 view 时懒启动。
   */
  forRequest(): RequestSpanContext | null {
    if (!this._options.enabled) return null;
    const view = this._view ?? this.startView();
    return {
      traceId: view.traceId,
      spanId: generateSpanIdHex(),
      flags: view.flags,
    };
  }

  private _readInbound(): ParsedTraceparent | null {
    const metaName = this._options.inheritFromMeta;
    if (metaName) {
      const parsed = parseTraceparent(readMetaContent(metaName));
      if (parsed) return parsed;
    }
    const cookieName = this._options.inheritFromCookie;
    if (cookieName) {
      const parsed = parseTraceparent(readCookie(cookieName));
      if (parsed) return parsed;
    }
    return null;
  }
}

export const traceContext = new TraceContextManager();