/**
 * @monit/collector/reporter - 上报器（批处理 + sendBeacon / fetch keepalive）
 *
 * 对标 monitor-sdk @monit/core reporter。批处理 + 可见性切换时 flush。
 * 离线时丢弃（P1 简化；P2 可接 IndexedDB 重试）。
 */

import type { MonitorEvent } from '@monit/contracts';

export interface ReporterOptions {
  endpoint: string;
  /** 批大小，默认 10 */
  batchSize?: number;
  /** flush 间隔 ms，默认 5000 */
  flushInterval?: number;
  /** release / version */
  release?: string;
}

export class Reporter {
  private queue: MonitorEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<Pick<ReporterOptions, 'endpoint' | 'batchSize' | 'flushInterval'>> & { release?: string };

  constructor(opts: ReporterOptions) {
    this.opts = {
      endpoint: opts.endpoint,
      batchSize: opts.batchSize ?? 10,
      flushInterval: opts.flushInterval ?? 5000,
      release: opts.release,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushInterval);
    // 可见性切换 hidden 时立即 flush（sendBeacon 适合此时机）
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  enqueue(event: MonitorEvent): void {
    this.queue.push(event);
    if (this.queue.length >= this.opts.batchSize) {
      void this.flush();
    }
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      void this.flush();
    }
  };

  async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    const body = JSON.stringify(batch);

    // 主：fetch keepalive。做正规 CORS preflight（跨源可靠），keepalive 也能在卸载时存活。
    // 注意：不能用 sendBeacon(application/json)——sendBeacon 无法 preflight，
    // 非 simple 的 application/json 跨源会被浏览器静默拦截（且 sendBeacon 返回 true 误导）。
    try {
      const res = await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
      if (res.ok) return;
    } catch {
      // fall through to sendBeacon fallback
    }

    // 兜底：sendBeacon 用 text/plain（simple 请求，免 preflight，跨源可送达，卸载最稳）。
    // 后端按 body 内容解析，不依赖 Content-Type。
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'text/plain' });
      if (navigator.sendBeacon(this.opts.endpoint, blob)) return;
    }

    // 全失败：重新入队（限流防溢出），P2 接 IndexedDB 重试
    if (this.queue.length < 100) this.queue.unshift(...batch);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    void this.flush();
  }
}