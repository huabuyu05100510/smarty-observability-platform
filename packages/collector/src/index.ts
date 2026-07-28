/**
 * @monit/collector - 浏览器端采集 SDK（L1）
 *
 * initCollector 串起 vitals + errors + breadcrumbs + reporter，
 * 产出统一 MonitorEvent 信封（带 W3C traceId + 错误指纹 + 面包屑），
 * 经 @monit/trace 注入 traceparent 出站，主链「采集 -> trace -> 后端」贯通。
 *
 * 对标 monitor-sdk @monit/browser + Sentry SDK。
 */

import type { MonitorEvent, MonitorEventSubType, ErrorSignal, VitalMetric, InpAttribution, ErrorFingerprint } from '@monit/contracts';
import { traceContext, generateSpanIdHex } from '@monit/trace';
import { installVitals } from './vitals';
import { installErrors, reportReactError } from './errors';
import { BreadcrumbCollector } from './breadcrumbs';
import { Reporter, type OfflineStore } from './reporter';
import { createIdbOfflineStore } from './offline-store';
import { installRequestMonitor } from './request';

export interface CollectorOptions {
  endpoint: string;
  release?: string;
  sessionId?: string;
  /** traceparent 透传配置 */
  trace?: {
    enabled?: boolean;
    inheritFromMeta?: string;
    inheritFromCookie?: string;
  };
  batchSize?: number;
  flushInterval?: number;
  /** 采样率 0-1，默认 1 */
  sampleRate?: number;
  /** 离线存储（默认自动用 IndexedDB；传 null 禁用离线重试） */
  offlineStore?: OfflineStore;
  /** gzip 压缩上报（需 pako 可用） */
  compress?: boolean;
  /** 慢请求阈值 ms（默认 3000，0 关闭） */
  slowThresholdMs?: number;
}

export interface CollectorHandle {
  /** 手动上报一个事件 */
  report(event: MonitorEvent): void;
  /** React ErrorBoundary 调用 */
  reportReactError(error: Error, componentStack: string): void;
  /** 立即 flush */
  flush(): Promise<void>;
  /** 卸载所有监听 */
  uninstall(): void;
  /** 取最近面包屑（调试用） */
  breadcrumbs(): Breadcrumb[];
}

import type { Breadcrumb } from './breadcrumbs';

let sessionIdCounter = 0;

export function initCollector(opts: CollectorOptions): CollectorHandle {
  const sessionId = opts.sessionId ?? `sess-${Date.now()}-${sessionIdCounter++}`;
  const sampleRate = opts.sampleRate ?? 1;

  // 1. 配置 trace（view 级 traceId；request 监控会注入 traceparent）
  traceContext.configure({
    enabled: opts.trace?.enabled ?? true,
    inheritFromMeta: opts.trace?.inheritFromMeta,
    inheritFromCookie: opts.trace?.inheritFromCookie,
    traceFlags: '01',
  });
  traceContext.startView();

  // 2. reporter（带 IndexedDB 离线队列重试，非阻塞挂载）
  const reporter = new Reporter({
    endpoint: opts.endpoint,
    release: opts.release,
    batchSize: opts.batchSize,
    flushInterval: opts.flushInterval,
    offlineStore: opts.offlineStore,
    compress: opts.compress,
  });
  reporter.start();
  if (!opts.offlineStore) {
    reporter.attachOfflineWhenReady(createIdbOfflineStore());
  }

  // 3. 面包屑
  const breadcrumbs = new BreadcrumbCollector(50);
  breadcrumbs.install();

  // 4. 构造 MonitorEvent 的辅助
  const traceId = traceContext.traceId ?? '';
  const makeEvent = (
    type: MonitorEvent['type'],
    subType: MonitorEventSubType,
    payload: unknown,
    fingerprint?: ErrorFingerprint,
    extraTags?: Record<string, string>,
  ): MonitorEvent => {
    const sampled = Math.random() < sampleRate;
    return {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      subType,
      timestamp: Date.now(),
      traceId,
      spanId: generateSpanIdHex(),
      sessionId,
      release: opts.release ?? 'unknown',
      payload,
      piiSafe: true,
      sampled,
      sampleRate,
      fingerprint,
      tags: extraTags,
    };
  };

  // 5. 采集回调 -> MonitorEvent -> reporter
  const uninstallVitals = installVitals({
    onVital: (metric: VitalMetric) => {
      reporter.enqueue(makeEvent('vital', metric.name.toLowerCase() as MonitorEventSubType, metric));
    },
    onInp: (attribution: InpAttribution) => {
      reporter.enqueue(makeEvent('vital', 'inp', attribution, undefined, { rating: attribution.rating }));
    },
  });

  const uninstallErrors = installErrors({
    onError: (signal: ErrorSignal, fingerprint: ErrorFingerprint) => {
      // 错误事件附带最近面包屑（还原用户操作路径）
      const event = makeEvent('error', signal.type as MonitorEventSubType, {
        ...signal,
        breadcrumbs: breadcrumbs.recent(),
      }, fingerprint);
      reporter.enqueue(event);
    },
  });

  // 请求监控（fetch + XHR，含 traceparent 注入；忽略上报自身）
  const requestHandle = installRequestMonitor(
    { slowThresholdMs: opts.slowThresholdMs, ignore: (u) => u === opts.endpoint },
    {
      onEvent: (subType, payload) => {
        reporter.enqueue(makeEvent('request', subType, payload, undefined, payload.failReason ? { failReason: payload.failReason } : undefined));
      },
    },
  );

  return {
    report(event) {
      reporter.enqueue(event);
    },
    reportReactError(error, componentStack) {
      reportReactError(error, componentStack, {
        onError: (signal, fingerprint) => {
          reporter.enqueue(makeEvent('error', 'react', { ...signal, breadcrumbs: breadcrumbs.recent() }, fingerprint));
        },
      });
    },
    async flush() {
      await reporter.flush();
    },
    uninstall() {
      uninstallVitals();
      uninstallErrors();
      requestHandle.uninstall();
      breadcrumbs.uninstall();
      reporter.stop();
      traceContext.reset();
    },
    breadcrumbs() {
      return breadcrumbs.recent();
    },
  };
}