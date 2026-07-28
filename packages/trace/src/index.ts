/**
 * @monit/trace - W3C Trace Context 传播 + 出站请求 header 注入
 *
 * 主链贯通的关键：前端采集 ↔ 后端 OTLP trace 首次串联。
 */

export {
  traceContext,
  encodeTraceparent,
  parseTraceparent,
  generateTraceIdHex,
  generateSpanIdHex,
  TRACEPARENT_HEADER,
  type TraceParentParts,
  type RequestSpanContext,
  type ParsedTraceparent,
  type TraceContextOptions,
} from './propagator';

export {
  installTracePropagation,
  instrumentFetch,
  instrumentXhr,
  type InterceptorOptions,
  type InterceptorHandle,
} from './interceptor';