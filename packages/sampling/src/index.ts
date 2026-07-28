/**
 * @monit/sampling - 监控事件采样（head + tail 两阶段）
 *
 * 移植自 monitor-sdk/packages/sampling（生产级实现）。
 *
 * - HeadSampler：入队前按 traceId 哈希取模决策（早决策省带宽，同 traceId 整链路一致）
 * - TailSampler：error 必留 + 慢请求必留 + 其他按 rate 抽样（保重要 trace 不丢）
 * - 安全模式：head 全量 + tail 兜底（head.sampleRate=1, tail.sampleRate=0.1）
 */

export type SampleDecision = 'keep' | 'drop' | 'unknown'

export interface Sampler {
  shouldKeep(event: MonitorEventLike): boolean
  readonly effectiveRate: number
}

export interface MonitorEventLike {
  type: string
  subType: string
  timestamp: number
  payload?: Record<string, unknown> | null
  traceId?: string
  sessionId?: string
  [key: string]: unknown
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function fnv1a(s: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function pickHashKey(event: MonitorEventLike, field: 'traceId' | 'sessionId' | 'message'): string | null {
  if (field === 'message') {
    const m = event.payload?.message
    return typeof m === 'string' ? m : null
  }
  const v = event[field]
  return typeof v === 'string' && v ? v : null
}

function isError(event: MonitorEventLike): boolean {
  return event.type === 'error' || event.payload?.status === 'error'
}

function isSlow(event: MonitorEventLike, thresholdMs: number): boolean {
  const d = event.payload?.duration
  return typeof d === 'number' && d > thresholdMs
}

// ─── HeadSampler ───────────────────────────────────────────────────────────────

export interface HeadSamplerOptions {
  sampleRate?: number
  hashField?: 'traceId' | 'sessionId' | 'message'
  hashFn?: (s: string) => number
}

export class HeadSampler implements Sampler {
  private readonly sampleRate: number
  private readonly hashField: 'traceId' | 'sessionId' | 'message'
  private readonly hashFn: (s: string) => number

  constructor(opts: HeadSamplerOptions = {}) {
    this.sampleRate = clamp01(opts.sampleRate ?? 1)
    this.hashField = opts.hashField ?? 'traceId'
    this.hashFn = opts.hashFn ?? fnv1a
  }

  get effectiveRate(): number { return this.sampleRate }

  shouldKeep(event: MonitorEventLike): boolean {
    if (this.sampleRate >= 1) return true
    if (this.sampleRate <= 0) return false
    const key = pickHashKey(event, this.hashField)
    if (key === null) return true
    return this.hashFn(key) / 0x100000000 < this.sampleRate
  }
}

// ─── TailSampler ──────────────────────────────────────────────────────────────

export interface TailSamplerOptions {
  sampleRate?: number
  slowThresholdMs?: number
  keepError?: boolean
  rules?: Array<(event: MonitorEventLike) => boolean | undefined>
}

export class TailSampler implements Sampler {
  private readonly sampleRate: number
  private readonly slowThresholdMs: number
  private readonly keepError: boolean
  private readonly rules: NonNullable<TailSamplerOptions['rules']>
  private readonly head: HeadSampler

  constructor(opts: TailSamplerOptions = {}) {
    this.sampleRate = clamp01(opts.sampleRate ?? 0.1)
    this.slowThresholdMs = opts.slowThresholdMs ?? 5000
    this.keepError = opts.keepError ?? true
    this.rules = opts.rules ?? []
    this.head = new HeadSampler({ sampleRate: this.sampleRate })
  }

  get effectiveRate(): number { return this.sampleRate }

  shouldKeep(event: MonitorEventLike): boolean {
    for (const r of this.rules) {
      const d = r(event)
      if (d === true) return true
      if (d === false) return false
    }
    if (this.keepError && isError(event)) return true
    if (isSlow(event, this.slowThresholdMs)) return true
    return this.head.shouldKeep(event)
  }
}

// ─── 组合 ─────────────────────────────────────────────────────────────────────

/** 任一 keep 即 keep（OR）。适合 head 全量 + tail 兜底。 */
export function composeSamplers(...samplers: Sampler[]): Sampler {
  if (samplers.length === 0) return new HeadSampler({ sampleRate: 1 })
  if (samplers.length === 1) return samplers[0]!
  return {
    get effectiveRate() { return Math.max(...samplers.map(s => s.effectiveRate)) },
    shouldKeep(event) { return samplers.some(s => s.shouldKeep(event)) },
  }
}

/** 链式 AND（更保守）。 */
export function andSamplers(...samplers: Sampler[]): Sampler {
  if (samplers.length === 0) return new HeadSampler({ sampleRate: 1 })
  return {
    get effectiveRate() { return Math.min(...samplers.map(s => s.effectiveRate)) },
    shouldKeep(event) { return samplers.every(s => s.shouldKeep(event)) },
  }
}

// ─── 采样统计（监控自身用） ─────────────────────────────────────────────────────

export interface SampleStats { total: number; kept: number; dropped: number; rate: number }

export class SampleStatsCounter {
  private total = 0
  private kept = 0
  record(kept: boolean): void { this.total++; if (kept) this.kept++ }
  snapshot(): SampleStats {
    return { total: this.total, kept: this.kept, dropped: this.total - this.kept, rate: this.total === 0 ? 1 : this.kept / this.total }
  }
  reset(): void { this.total = 0; this.kept = 0 }
}
