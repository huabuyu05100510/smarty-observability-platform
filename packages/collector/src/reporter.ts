/**
 * @monit/collector/reporter - 上报器（离线队列重试 + 可选 gzip + 双通道）
 *
 * 移植自 monitor-sdk/packages/core/src/reporter.ts（生产级实现），替换之前的薄壳。
 *
 * 关键能力（之前薄壳缺失的）：
 * - 离线队列：失败（网络错误/non-2xx）入 IndexedDB，定时 + online 事件 flushOffline 重试，maxAttempts 丢弃
 * - 双通道：fetch keepalive 主（能读 status，触发离线回退），sendBeacon 兜底（unload 保数据）
 * - 可选 gzip：compress:true 走 pako gzip+base64，省带宽（pako 动态 import，不强制依赖）
 *
 * 跨源 CORS 修复（之前 bug）：sendBeacon(application/json) 跨源被静默拦截 → 这里 sendBeacon
 * 用 text/plain（simple 免 preflight），fetch keepalive 主通道做正规 preflight。
 */

import type { MonitorEvent } from '@monit/contracts'
import type { Sampler } from '@monit/sampling'

export interface OfflineQueueItem {
  id?: number
  payload: MonitorEvent[]
  attempts: number
  lastAttemptAt: number
  dsn: string
}

export interface OfflineStore {
  add(item: Omit<OfflineQueueItem, 'id'>): Promise<void>
  all(): Promise<OfflineQueueItem[]>
  remove(id: number): Promise<void>
  update(item: OfflineQueueItem): Promise<void>
}

export interface ReporterOptions {
  endpoint: string
  release?: string
  batchSize?: number
  flushInterval?: number
  /** 离线存储（不传则失败即丢） */
  offlineStore?: OfflineStore
  /** 最大重试次数，默认 5 */
  maxAttempts?: number
  /** gzip 压缩（需 pako 可用） */
  compress?: boolean
  /** 采样器（入队前 shouldKeep 决策；不传则全留） */
  sampler?: Sampler
}

export class Reporter {
  private queue: MonitorEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private onlineHandler: (() => void) | null = null
  private readonly opts: Required<Pick<ReporterOptions, 'endpoint' | 'batchSize' | 'flushInterval' | 'maxAttempts'>> & {
    release?: string; offlineStore?: OfflineStore; compress?: boolean; sampler?: Sampler
  }

  constructor(opts: ReporterOptions) {
    this.opts = {
      endpoint: opts.endpoint,
      batchSize: opts.batchSize ?? 10,
      flushInterval: opts.flushInterval ?? 5000,
      maxAttempts: opts.maxAttempts ?? 5,
      release: opts.release,
      offlineStore: opts.offlineStore,
      compress: opts.compress,
      sampler: opts.sampler,
    }
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.flush(), this.opts.flushInterval)
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    // online 事件触发离线队列重发
    if (typeof window !== 'undefined') {
      this.onlineHandler = () => void this.flushOffline()
      window.addEventListener('online', this.onlineHandler)
    }
    // 启动时重发一次历史离线队列
    void this.flushOffline()
  }

  enqueue(event: MonitorEvent): void {
    // 采样：shouldKeep=false 则丢弃（不入队、不入离线队列）
    if (this.opts.sampler && !this.opts.sampler.shouldKeep(event as never)) {
      event.sampled = false
      return
    }
    this.queue.push(event)
    if (this.queue.length >= this.opts.batchSize) void this.flush()
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') void this.flush()
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.queue.length)
    await this.sendWithRetry(batch)
  }

  /** 单批发送：成功即止；失败入离线队列（若有）。 */
  private async sendWithRetry(events: MonitorEvent[]): Promise<void> {
    const ok = await sendOnce(this.opts.endpoint, events, { compress: this.opts.compress })
    if (ok) return
    if (!this.opts.offlineStore) return // 失败即丢（无离线存储）
    try {
      await this.opts.offlineStore.add({
        payload: events, attempts: 0, lastAttemptAt: Date.now(), dsn: this.opts.endpoint,
      })
    } catch (e) {
      // IDB 写失败（配额满/事务冲突）：不静默丢，记 warn 便于排查
      console.warn('[reporter] offline enqueue failed; batch may be lost on reload:', e)
    }
    void this.flushOffline()
  }

  /** 重发离线队列：成功删、失败 attempts+1、达 maxAttempts 丢弃。 */
  async flushOffline(): Promise<void> {
    const store = this.opts.offlineStore
    if (!store) return
    let items: OfflineQueueItem[]
    try { items = await store.all() } catch { return }
    for (const item of items) {
      if (item.dsn !== this.opts.endpoint || item.id === undefined) continue
      if (item.attempts >= this.opts.maxAttempts) {
        try { await store.remove(item.id) } catch { /* ignore */ }
        continue
      }
      const ok = await sendOnce(item.dsn, item.payload, { compress: this.opts.compress })
      if (ok) {
        try { await store.remove(item.id) } catch { /* ignore */ }
      } else {
        try { await store.update({ ...item, attempts: item.attempts + 1, lastAttemptAt: Date.now() }) } catch { /* ignore */ }
      }
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    if (this.onlineHandler && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineHandler)
    }
    void this.flush()
  }

  /** 异步挂载离线存储（IDB 打开完成后注入，不阻塞 init）。 */
  attachOfflineWhenReady(storePromise: Promise<OfflineStore | null>): void {
    storePromise
      .then((store) => {
        if (store) {
          this.opts.offlineStore = store
          void this.flushOffline()
        }
      })
      .catch(() => {})
  }
}

/**
 * 单次发送。返回 true=成功(2xx/queued)，false=失败。
 * fetch keepalive 主（读 status，跨源做正规 preflight）；sendBeacon(text/plain) 兜底。
 */
/** 单事件 payload 体积上限（< 64KB keepalive 限）。超限剥离 sessionReplay，避免整批被拖累/卸载时丢失。 */
const SINGLE_EVENT_MAX_BYTES = 48_000;

/** 若事件序列化超限且含 sessionReplay，剥离之并标记（保留事件本身上报）。 */
function stripOversizedReplay(e: MonitorEvent): MonitorEvent {
  const raw = JSON.stringify(e);
  if (byteLength(raw) <= SINGLE_EVENT_MAX_BYTES) return e;
  const p = e.payload;
  if (p && typeof p === 'object' && 'sessionReplay' in (p as Record<string, unknown>)) {
    const np = { ...(p as Record<string, unknown>) };
    delete np.sessionReplay;
    np.sessionReplayDropped = true;
    return { ...e, payload: np };
  }
  return e;
}

async function sendOnce(
  dsn: string,
  events: MonitorEvent[],
  opts: { compress?: boolean },
): Promise<boolean> {
  const safeEvents = events.map(stripOversizedReplay);
  const body = JSON.stringify({ events: safeEvents })

  // 可选 gzip（pako 动态 import，不可用则降级未压缩）
  if (opts.compress) {
    try {
      const { gzip } = await import('pako')
      const gz = gzip(body) as Uint8Array
      try {
        const resp = await fetch(dsn, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip-base64' },
          body: uint8ToBase64(gz),
          keepalive: true,
        })
        if (resp.ok) return true
      } catch { /* fallthrough */ }
    } catch { /* pako 不可用，降级 */ }
  }

  // 主：fetch。keepalive 能在卸载时存活，但有 ~64KB body 上限——
  // 超限时改普通 fetch（无 64KB 限，但卸载时可能被取消）。
  if (typeof fetch === 'function') {
    // 注意：必须按【字节】而非字符数判断——body.length 数的是 UTF-16 码元，
    // CJK/多字节载荷实际字节数远大于 length，会绕过 64KB 上限被 Chrome 静默拒收。
    const big = byteLength(body) > 60000
    try {
      const resp = await fetch(dsn, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        ...(big ? {} : { keepalive: true }),
      })
      if (resp.ok) return true
      // non-2xx：继续尝试 sendBeacon 兜底（某些 4xx 可能仍可送达）
    } catch { /* fallthrough to sendBeacon */ }
  }

  // 兜底：sendBeacon(text/plain) —— simple 请求免 preflight，跨源可送达，unload 最稳
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([body], { type: 'text/plain' })
      if (navigator.sendBeacon(dsn, blob)) return true
    } catch { /* ignore */ }
  }
  return false
}

/** 字符串字节长度（UTF-8）。TextEncoder 不可用时回退码元数（近似）。 */
function byteLength(s: string): number {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(s).byteLength;
  return s.length;
}

/** Uint8Array → base64（浏览器 btoa chunked + Node Buffer 兼容） */
function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[])
    }
    return btoa(binary)
  }
  const Buf = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer
  if (Buf) return Buf.from(bytes).toString('base64')
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}
