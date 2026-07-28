/**
 * @monit/collector/request - 请求监控（fetch + XHR）+ traceparent 注入
 *
 * 移植自 monitor-sdk/packages/request（fetchPlugin + xhrPlugin），适配到统一 MonitorEvent。
 *
 * 能力（之前薄壳只有 traceparent 注入，缺请求捕获）：
 * - 非 2xx / network 错误捕获（method/url/status/duration/requestBody/responseText 片段）
 * - 慢请求检测（duration > slowThresholdMs 额外报 slow 事件）
 * - GraphQL operation 提取（operationName + summary，不取 variables 防 PII）
 * - 失败原因分类（offline / cors-or-network / network-unknown）
 * - W3C traceparent 注入（同源；合并进单一 wrapper，避免与 @monit/trace 双重 patch）
 */

import type { MonitorEventSubType } from '@monit/contracts';
import { traceContext, encodeTraceparent, TRACEPARENT_HEADER } from '@monit/trace';

export interface RequestEventPayload {
  method: string;
  url: string;
  status: number;
  duration: number;
  requestBody?: string;
  responseText?: string;
  failReason?: string;
  threshold?: number;
  graphqlOperation?: string;
  graphqlSummary?: string;
}

export interface RequestMonitorOptions {
  /** 慢请求阈值 ms，默认 3000；0 关闭 */
  slowThresholdMs?: number;
  /** 是否注入 traceparent（同源），默认 true */
  injectTraceparent?: boolean;
  /** 忽略某些 URL（如监控上报自身） */
  ignore?: (url: string) => boolean;
}

export interface RequestHandle {
  uninstall(): void;
}

export interface RequestCallbacks {
  onEvent: (subType: MonitorEventSubType, payload: RequestEventPayload, tags?: Record<string, string>) => void;
}

function isSameOrigin(url: string): boolean {
  if (typeof location === 'undefined') return true;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** GraphQL operation 提取（defensive，不取 variables 防 PII） */
export function extractGraphQL(body: BodyInit | null | undefined): { operationName: string; summary: string } | null {
  if (typeof body !== 'string') return null;
  if (!body.includes('"query"') && !body.includes('"operationName"')) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (Array.isArray(parsed) && parsed.length > 0) parsed = parsed[0];
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { query?: unknown; operationName?: unknown };
  const query = typeof obj.query === 'string' ? obj.query : '';
  if (!query) return null;
  const lines = query.split('\n').map(l => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const opLine = lines.find(l => /^(query|mutation|subscription|fragment)\b/i.test(l)) ?? lines[0] ?? '';
  const summary = opLine.slice(0, 100);
  const operationName = (typeof obj.operationName === 'string' && obj.operationName) || (summary.match(/^(?:query|mutation|subscription|fragment)\s+([A-Za-z_]\w*)/i)?.[1] ?? '');
  return { operationName, summary };
}

function classifyZeroStatus(response: Response | null): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (response) {
    try { if (response.headers.get('content-type') === null) return 'cors-or-network'; } catch { /* ignore */ }
  }
  return 'network-unknown';
}

/**
 * 安装 fetch + XHR 监控（含 traceparent 注入）。
 */
export function installRequestMonitor(opts: RequestMonitorOptions, cb: RequestCallbacks): RequestHandle {
  const slowThresholdMs = opts.slowThresholdMs ?? 3000;
  const inject = opts.injectTraceparent ?? true;
  const ignore = opts.ignore ?? (() => false);
  const cleanups: Array<() => void> = [];

  const injectHeader = (url: string, headers: Headers): void => {
    if (!inject || !isSameOrigin(url)) return;
    const span = traceContext.forRequest();
    if (span && !headers.has(TRACEPARENT_HEADER)) {
      headers.set(TRACEPARENT_HEADER, encodeTraceparent(span));
    }
  };

  // ── fetch ──────────────────────────────────────────────────────────
  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    const mark = `__monit_req_fetch`;
    // @ts-expect-error mark
    if (!originalFetch[mark]) {
      const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (ignore(url)) return originalFetch(input, init);

        const newInit: RequestInit = init ? { ...init } : {};
        if (inject) {
          newInit.headers = new Headers(init?.headers);
          injectHeader(url, newInit.headers as Headers);
        }
        const requestBody = typeof init?.body === 'string' ? init.body.slice(0, 500) : '';
        const graphql = extractGraphQL(init?.body);
        const start = Date.now();

        try {
          const response = await originalFetch(input as RequestInfo, newInit);
          const duration = Date.now() - start;

          if (!response.ok) {
            const cloned = response.clone();
            const responseText = await cloned.text().catch(() => '');
            cb.onEvent('fetch', {
              method, url, status: response.status, duration, requestBody,
              responseText: responseText.slice(0, 500),
              ...(graphql ? { graphqlOperation: graphql.operationName, graphqlSummary: graphql.summary } : {}),
            });
          }
          if (slowThresholdMs > 0 && duration > slowThresholdMs) {
            cb.onEvent('slow', { method, url, status: response.status, duration, threshold: slowThresholdMs });
          }
          return response;
        } catch (error) {
          const duration = Date.now() - start;
          cb.onEvent('fetch', {
            method, url, status: 0, duration, requestBody,
            responseText: error instanceof Error ? error.message : String(error),
            failReason: classifyZeroStatus(null),
            ...(graphql ? { graphqlOperation: graphql.operationName, graphqlSummary: graphql.summary } : {}),
          });
          throw error;
        }
      };
      patched[mark] = true;
      globalThis.fetch = patched as typeof fetch;
      cleanups.push(() => { if (globalThis.fetch === patched) globalThis.fetch = originalFetch; });
    }
  }

  // ── XHR ────────────────────────────────────────────────────────────
  if (typeof XMLHttpRequest === 'function') {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const mark = '__monit_req_xhr';
    // @ts-expect-error mark
    if (!XMLHttpRequest.prototype[mark]) {
      const urlKey = mark + ':url';
      const methodKey = mark + ':method';
      const startKey = mark + ':start';

      XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
        // @ts-expect-error stash
        this[urlKey] = url; this[methodKey] = method;
        // @ts-expect-error forward
        return originalOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
        // @ts-expect-error read
        const url: string = this[urlKey] ?? '';
        // @ts-expect-error read
        const method: string = (this[methodKey] ?? 'GET').toUpperCase();
        // @ts-expect-error set
        this[startKey] = Date.now();
        if (!ignore(url)) {
          this.addEventListener('loadend', () => {
            // @ts-expect-error read
            const start: number = this[startKey] ?? Date.now();
            const duration = Date.now() - start;
            const status = this.status;
            if (status === 0 || status >= 400) {
              cb.onEvent('xhr', { method, url, status, duration, responseText: (this.responseText ?? '').slice(0, 500) });
            } else if (slowThresholdMs > 0 && duration > slowThresholdMs) {
              cb.onEvent('slow', { method, url, status, duration, threshold: slowThresholdMs });
            }
          });
        }
        return originalSend.call(this, body);
      };
      // traceparent 注入（同源）：setRequestHeader 时若未设则补
      XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
        // @ts-expect-error read
        const url: string = this[urlKey] ?? '';
        if (inject && isSameOrigin(url) && name.toLowerCase() === TRACEPARENT_HEADER) {
          // 业务已显式设 traceparent，标记不再自动注入
          // @ts-expect-error mark
          this[mark + ':tp'] = true;
        }
        return originalSetHeader.call(this, name, value);
      };
      // open 后 send 前自动注入 traceparent：在 open 末尾补一次 setRequestHeader
      const origOpen2 = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
        // @ts-expect-error forward
        const r = origOpen2.call(this, method, url, ...rest);
        if (inject && isSameOrigin(url)) {
          const span = traceContext.forRequest();
          if (span) {
            try { originalSetHeader.call(this, TRACEPARENT_HEADER, encodeTraceparent(span)); } catch { /* state */ }
          }
        }
        return r;
      };
      // @ts-expect-error mark
      XMLHttpRequest.prototype[mark] = true;
      cleanups.push(() => {
        XMLHttpRequest.prototype.open = originalOpen;
        XMLHttpRequest.prototype.send = originalSend;
        XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
      });
    }
  }

  return { uninstall() { cleanups.forEach(fn => fn()); } };
}
