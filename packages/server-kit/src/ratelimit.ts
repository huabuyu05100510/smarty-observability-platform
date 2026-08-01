/**
 * 令牌桶限流（per-key，默认 per-IP）。手写零依赖。
 * 写端点用更紧的桶（防扫描/暴力），读端点稍宽。
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(public readonly capacity: number, refillPerSec: number) {
    this.tokens = capacity;
    this.last = Date.now();
    this.refillPerMs = refillPerSec / 1000;
  }
  private readonly refillPerMs: number;

  take(cost = 1): boolean {
    const now = Date.now();
    const elapsed = now - this.last;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  /** 是否已回满（用于空闲清扫）。 */
  isFull(): boolean {
    const now = Date.now();
    const refilled = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    return refilled >= this.capacity;
  }
}

export interface RateLimiterOptions {
  capacity: number;
  refillPerSec: number;
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private lastSweep = Date.now();
  private readonly sweepIntervalMs = 60_000;

  constructor(private readonly opts: RateLimiterOptions) {}

  allow(key: string): boolean {
    const now = Date.now();
    if (now - this.lastSweep > this.sweepIntervalMs) {
      for (const [k, b] of this.buckets) if (b.isFull()) this.buckets.delete(k);
      this.lastSweep = now;
    }
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.opts.capacity, this.opts.refillPerSec);
      this.buckets.set(key, b);
    }
    return b.take();
  }

  /** 测试/调试：当前 key 剩余令牌近似值。 */
  tokens(key: string): number {
    return this.buckets.get(key)?.['tokens' as keyof TokenBucket] as unknown as number ?? this.opts.capacity;
  }
}
