/**
 * @monit/repair-agent/source-map-resolver - sourcemap 双缓存还原
 *
 * 吸收 sentinel-x resolver/source-map-resolver.ts 的双缓存思想：
 * L1 内存缓存 + L2 持久缓存（IndexedDB / 文件，7 天 TTL）。
 *
 * 安全范式（调研）：生产绝不部署 sourcemap（泄露源码），上报原始压缩栈，
 * 在隔离环境用 sourcemap 还原。前端 SDK 只负责上传 sourcemap 到私有端点。
 */

export interface SourceMapLoader {
  /** 按 sourceURL + release 取 sourcemap JSON，返回 null 表示无 */
  load(sourceURL: string, release?: string): Promise<unknown | null>;
}

export interface ResolvedFrame {
  filename: string;
  functionName: string;
  line: number;
  column: number;
  source?: string;
  /** 还原后的源码片段（上下文几行） */
  sourceContext?: string;
}

export interface RawFrame {
  filename: string;
  functionName?: string;
  line: number;
  column: number;
}

/** L2 持久缓存接口（浏览器 IndexedDB / Node 文件系统） */
export interface PersistentCache {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 双缓存 sourcemap 还原器。
 * - L1 内存 Map（同会话命中）
 * - L2 持久缓存（跨会话命中，7 天 TTL）
 * - 未命中则从 loader 加载，写入两级缓存
 */
export class SourceMapResolver {
  private l1 = new Map<string, unknown>();
  constructor(
    private loader: SourceMapLoader,
    private l2?: PersistentCache,
  ) {}

  private cacheKey(sourceURL: string, release?: string): string {
    return `${sourceURL}@${release ?? 'latest'}`;
  }

  async resolveStack(frames: RawFrame[], release?: string): Promise<ResolvedFrame[]> {
    const out: ResolvedFrame[] = [];
    for (const f of frames) {
      out.push(await this.resolveFrame(f, release));
    }
    return out;
  }

  async resolveFrame(frame: RawFrame, release?: string): Promise<ResolvedFrame> {
    const sm = await this.getSourceMap(frame.filename, release);
    if (!sm || typeof sm !== 'object') {
      return { ...frame, functionName: frame.functionName ?? '<anonymous>' };
    }
    // 真实环境用 source-map 库的 SourceMapConsumer.originalPositionFor
    // 此处用接口占位，避免引入 source-map 依赖（P0 专注架构）
    const consumer = sm as { originalPositionFor?: (pos: { line: number; column: number }) => ResolvedFrame | null };
    if (typeof consumer.originalPositionFor === 'function') {
      const resolved = consumer.originalPositionFor({ line: frame.line, column: frame.column });
      if (resolved) return resolved;
    }
    return { ...frame, functionName: frame.functionName ?? '<anonymous>' };
  }

  private async getSourceMap(sourceURL: string, release?: string): Promise<unknown | null> {
    const key = this.cacheKey(sourceURL, release);

    // L1
    if (this.l1.has(key)) return this.l1.get(key);

    // L2
    if (this.l2) {
      const cached = await this.l2.get(key);
      if (cached) {
        this.l1.set(key, cached);
        return cached;
      }
    }

    // load
    const sm = await this.loader.load(sourceURL, release);
    if (sm) {
      this.l1.set(key, sm);
      if (this.l2) await this.l2.set(key, sm, TTL_MS);
    }
    return sm;
  }

  /** 清空 L1（测试/卸载用） */
  clear(): void {
    this.l1.clear();
  }
}