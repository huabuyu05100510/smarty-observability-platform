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
import { Recorder } from './replay';
import { installWhiteScreen } from './white-screen';
import { installBehavior } from './behavior';
import { HotfixClient, type RuntimePatch } from './hotfix';
import { redactPayload, type RedactOptions } from '@monit/pii';
import { HeadSampler, TailSampler, composeSamplers, type Sampler } from '@monit/sampling';

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
  /** PII 脱敏（默认开启；false 关闭，传对象自定义规则） */
  pii?: RedactOptions | false;
  /** 自定义采样器（默认：head sampleRate + tail 兜底 error/慢请求必留） */
  sampler?: Sampler;
  /** 会话回放录制（rrweb 风格，默认开 30s 环；false 关闭） */
  replay?: false | { windowMs?: number; maskInputs?: boolean };
  /** 运行时热修（轨道 A）：从 coordinator 拉取 Ed25519 签名 patch，按指纹应用行为保留补丁，可回滚。
   *  安全：默认【拒绝】未签名 patch（applyPatch 用 new Function 执行下发代码）。配 publicKey 自动 Ed25519 公钥
   *  验签（从 coordinator /heal/public-key 获取），或传 verify 自定义；allowUnsigned:true 仅本地调试放行未签名。*/
  hotfix?: {
    registryUrl: string;
    publicKey?: string;
    verify?: (p: RuntimePatch) => boolean | Promise<boolean>;
    allowUnsigned?: boolean;
    pollIntervalMs?: number;
  };
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

  // 2. reporter（带 IndexedDB 离线队列重试 + 采样，非阻塞挂载）
  // 采样默认策略：head 按 sampleRate + tail 兜底（error/慢请求必留）
  const sampler: Sampler = opts.sampler ?? composeSamplers(
    new HeadSampler({ sampleRate: opts.sampleRate ?? 1 }),
    new TailSampler({ sampleRate: 1, keepError: true, slowThresholdMs: opts.slowThresholdMs ?? 3000 }),
  );
  const reporter = new Reporter({
    endpoint: opts.endpoint,
    release: opts.release,
    batchSize: opts.batchSize,
    flushInterval: opts.flushInterval,
    offlineStore: opts.offlineStore,
    compress: opts.compress,
    sampler,
  });
  reporter.start();
  if (!opts.offlineStore) {
    reporter.attachOfflineWhenReady(createIdbOfflineStore());
  }

  // 3. 面包屑
  const breadcrumbs = new BreadcrumbCollector(50);
  breadcrumbs.install();

  // 3b. 会话回放录制（rrweb 风格，默认开 30s 环；错误事件带 sessionReplay）
  const replay = opts.replay === false ? null : new Recorder(opts.replay ?? {});
  replay?.install();

  // 4. 构造 MonitorEvent 的辅助
  const traceId = traceContext.traceId ?? '';
  /** 当前页面上下文（供根因分析结合"在哪个页面发生"）*/
  const pageCtx = (): { url: string; path: string; title?: string } | undefined => {
    if (typeof location === 'undefined') return undefined;
    return { url: location.href, path: location.pathname, title: typeof document !== 'undefined' ? document.title : undefined };
  };
  const makeEvent = (
    type: MonitorEvent['type'],
    subType: MonitorEventSubType,
    payload: unknown,
    fingerprint?: ErrorFingerprint,
    extraTags?: Record<string, string>,
  ): MonitorEvent => {
    // sampled 的唯一真值来源 = reporter 的确定性采样器（HeadSampler 按 traceId 哈希 + TailSampler 兜底）。
    // 这里乐观置 true；reporter.enqueue 在 shouldKeep=false 时改写为 false。
    // 绝不能用 Math.random() 另掷一次——那会让 sampled/sampleRate 与实际保留决策自相矛盾。
    const sampled = true;
    // PII 脱敏（默认开启；opts.pii=false 关闭，opts.pii={...} 自定义规则）
    const piiOpts = opts.pii === false ? null : (opts.pii ?? {});
    const safePayload = piiOpts ? redactPayload(payload, piiOpts) : payload;
    return {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      subType,
      timestamp: Date.now(),
      traceId,
      spanId: generateSpanIdHex(),
      sessionId,
      release: opts.release ?? 'unknown',
      payload: safePayload,
      piiSafe: piiOpts !== null,
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
      // 结合当前页面 + 用户行为：INP 附带页面上下文 + 最近面包屑，供后端生成"用户故事"式具体根因
      reporter.enqueue(makeEvent('vital', 'inp', {
        ...attribution,
        page: pageCtx(),
        breadcrumbs: breadcrumbs.recent().slice(-6),
      }, undefined, { rating: attribution.rating }));
    },
  });

  // 白屏因果归因上下文：近期错误 + 失败资源（白屏检测按时序关联）
  const recentErrorsList: Array<{ id?: string; message: string; source?: string; type?: string; timestamp: number }> = [];
  const failedResourcesList: Array<{ url: string; tagName: string; timestamp: number }> = [];
  // 轨道 A 热修：已采集的错误指纹（HotfixClient 仅应用匹配指纹的 patch）
  const seenFingerprints = new Set<string>();

  const uninstallErrors = installErrors({
    onError: (signal: ErrorSignal, fingerprint: ErrorFingerprint) => {
      // 喂白屏因果上下文 + 热修指纹
      seenFingerprints.add(fingerprint.primary);
      recentErrorsList.push({ id: signal.id, message: signal.message, source: signal.sourceURL, type: signal.type, timestamp: signal.timestamp });
      if (recentErrorsList.length > 20) recentErrorsList.shift();
      if (signal.type === 'resource' && signal.sourceURL) {
        const tagMatch = signal.message.match(/Failed to load (\w+):/);
        failedResourcesList.push({ url: signal.sourceURL, tagName: tagMatch?.[1] ?? 'unknown', timestamp: signal.timestamp });
        if (failedResourcesList.length > 20) failedResourcesList.shift();
      }
      // 错误事件附带最近面包屑 + 会话回放（还原用户操作路径）
      const event = makeEvent('error', signal.type as MonitorEventSubType, {
        ...signal,
        breadcrumbs: breadcrumbs.recent(),
        ...(replay ? { sessionReplay: replay.getSnapshot() } : {}),
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

  // 白屏检测（加载后采样 + 因果归因，detected 才上报）
  const uninstallWhiteScreen = installWhiteScreen(
    { onDetect: (d) => reporter.enqueue(makeEvent('white-screen', 'white-screen', d)) },
    { context: { recentErrors: () => recentErrorsList, failedResources: () => failedResourcesList } },
  );

  // 行为沮丧信号（rage/dead click + erratic mouse）
  const uninstallBehavior = installBehavior({
    onFrustration: (s) => reporter.enqueue(makeEvent('behavior', 'frustration', s)),
  });

  // 轨道 A 运行时热修（patch-registry-over-SDK）：拉取签名 patch 按指纹应用，可回滚
  const hotfixClient = opts.hotfix
    ? new HotfixClient({
        registryUrl: opts.hotfix.registryUrl,
        publicKey: opts.hotfix.publicKey,
        verify: opts.hotfix.verify,
        allowUnsigned: opts.hotfix.allowUnsigned,
        pollIntervalMs: opts.hotfix.pollIntervalMs,
        fingerprints: () => [...seenFingerprints],
      })
    : null;
  hotfixClient?.start();

  return {
    report(event) {
      // 手动上报也经 PII 脱敏（堵 report() 绕过 makeEvent 的脱敏）
      const piiOpts = opts.pii === false ? null : (opts.pii ?? {});
      const finalEvent = piiOpts && !event.piiSafe
        ? { ...event, payload: redactPayload(event.payload, piiOpts), piiSafe: true }
        : event;
      reporter.enqueue(finalEvent);
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
      uninstallWhiteScreen();
      uninstallBehavior();
      hotfixClient?.stop();
      breadcrumbs.uninstall();
      replay?.uninstall();
      reporter.stop();
      traceContext.reset();
    },
    breadcrumbs() {
      return breadcrumbs.recent();
    },
  };
}