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

    // 优先 sendBeacon（不阻塞卸载）
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      const ok = navigator.sendBeacon(this.opts.endpoint, blob);
      if (ok) return;
    }

    // 回退 fetch keepalive
    try {
      await fetch(this.opts.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      });
    } catch {
      // 离线/失败：丢弃（P2 接 IndexedDB 重试）
      // 重新入队首部，避免丢失（限流防溢出）
      if (this.queue.length < 100) this.queue.unshift(...batch);
    }
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