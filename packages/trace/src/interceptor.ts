/**
 * @monit/trace/interceptor - 给出站请求注入 W3C traceparent header
 *
 * 这是 monitor-sdk 当前的最大断点：只生成 traceId/spanId 不注入 header，
 * 导致前端采集 ↔ 后端 OTLP trace 无法串联。本模块补齐这一缺口。
 *
 * 对标：OpenTelemetry @opentelemetry/instrumentation-fetch / -xhr
 * 但零依赖、手写，避免引入完整 OTel SDK 的体积。
 */

import {
  traceContext,
  encodeTraceparent,
  TRACEPARENT_HEADER,
  type RequestSpanContext,
} from './propagator';

export interface InterceptorOptions {
  /**
   * 返回 false 则不注入（如监控上报自身、第三方 CDN）。
   * 默认对所有同源请求注入。
   */
  shouldInject?: (url: string) => boolean;
  /** 已安装标记键，防重复 patch */
  markKey?: string;
}

const DEFAULT_MARK_KEY = '__monit_trace_installed';

export interface InterceptorHandle {
  uninstall(): void;
}

function isSameOrigin(url: string): boolean {
  if (typeof location === 'undefined') return true;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function resolveSpanContext(url: string, shouldInject?: (u: string) => boolean): RequestSpanContext | null {
  if (shouldInject) {
    if (!shouldInject(url)) return null;
  } else if (!isSameOrigin(url)) {
    // 默认仅同源注入（跨源需显式 opt-in，避免 CORS 预检副作用）
    return null;
  }
  return traceContext.forRequest();
}

/**
 * Patch fetch，给出站请求注入 traceparent header。
 */
export function instrumentFetch(opts: InterceptorOptions = {}): InterceptorHandle {
  if (typeof globalThis.fetch === 'undefined') {
    return { uninstall() {} };
  }
  const markKey = opts.markKey ?? DEFAULT_MARK_KEY;
  // @ts-expect-error - mark on global
  if (globalThis.fetch[markKey]) return { uninstall() {} };

  const original = globalThis.fetch;
  const patched = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const span = resolveSpanContext(url, opts.shouldInject);
    if (span) {
      const headerValue = encodeTraceparent(span);
      init = init ?? {};
      init.headers = new Headers(init.headers);
      // 仅当未显式设置时注入（不覆盖业务自带的 traceparent）
      if (!init.headers.has(TRACEPARENT_HEADER)) {
        init.headers.set(TRACEPARENT_HEADER, headerValue);
      }
    }
    return original(input, init);
  };

  // @ts-expect-error - mark on global
  patched[markKey] = true;
  globalThis.fetch = patched as typeof fetch;

  return {
    uninstall() {
      if (globalThis.fetch === patched) {
        globalThis.fetch = original;
      }
    },
  };
}

/**
 * Patch XMLHttpRequest，给出站请求注入 traceparent header。
 */
export function instrumentXhr(opts: InterceptorOptions = {}): InterceptorHandle {
  if (typeof XMLHttpRequest === 'undefined') {
    return { uninstall() {} };
  }
  const markKey = opts.markKey ?? DEFAULT_MARK_KEY;
  // @ts-expect-error - mark on proto
  if (XMLHttpRequest.prototype[markKey]) return { uninstall() {} };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  const openMark = markKey + ':url';

  XMLHttpRequest.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string,
    ...rest: unknown[]
  ) {
    // @ts-expect-error - stash url on instance
    this[openMark] = url;
    // @ts-expect-error - forward variadic
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    // @ts-expect-error - read stashed url
    const url: string | undefined = this[openMark];
    if (url) {
      const span = resolveSpanContext(url, opts.shouldInject);
      if (span) {
        try {
          this.setRequestHeader(TRACEPARENT_HEADER, encodeTraceparent(span));
        } catch {
          // setRequestHeader 必须在 open 之后 send 之前；此处正是该窗口。
          // 若状态机异常则静默跳过（不阻断业务请求）。
        }
      }
    }
    return originalSend.call(this, body);
  };

  // @ts-expect-error - mark on proto
  XMLHttpRequest.prototype[markKey] = true;

  return {
    uninstall() {
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    },
  };
}

/**
 * 一键安装 fetch + XHR 注入。返回统一 uninstall。
 */
export function installTracePropagation(opts: InterceptorOptions = {}): InterceptorHandle {
  const fetchHandle = instrumentFetch(opts);
  const xhrHandle = instrumentXhr(opts);
  return {
    uninstall() {
      fetchHandle.uninstall();
      xhrHandle.uninstall();
    },
  };
}