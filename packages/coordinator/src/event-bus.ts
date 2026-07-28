/**
 * @monit/coordinator/event-bus - 内存环形缓冲事件总线
 *
 * 吸收 smarty-monitor coordinator 的 ring buffer。
 * 采集器/诊断/修复引擎通过 BusEvent 通信，coordinator 持有最近 N 条。
 */

import type { BusEvent } from '@monit/contracts';

export class EventBus {
  private buffer: BusEvent[] = [];
  private readonly capacity: number;
  private listeners: Array<(e: BusEvent) => void> = [];

  constructor(capacity = 50) {
    this.capacity = capacity;
  }

  publish(event: BusEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) {
      this.buffer.shift();
    }
    for (const l of this.listeners) l(event);
  }

  recent(): BusEvent[] {
    return [...this.buffer];
  }

  subscribe(fn: (e: BusEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  clear(): void {
    this.buffer = [];
  }
}