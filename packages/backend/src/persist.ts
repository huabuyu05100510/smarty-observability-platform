/**
 * @monit/backend/persist - JSONL 文件持久化（纯 fs，零原生依赖）
 *
 * append-only 日志：每个 MonitorEvent 一行 JSON。重启时按行读回 hydrate EventStore。
 * 比 SQLite 更简单可靠（无原生编译、无 vite 解析问题），本规模够用。
 * 真实生产可换 ClickHouse/Postgres，schema（MonitorEvent）不变。
 */

import fs from 'node:fs';
import type { MonitorEvent } from '@monit/contracts';

export interface PersisterOptions {
  /** JSONL 文件路径；:memory: 退化为内存数组（测试用） */
  dbPath: string;
}

export class JsonlPersister {
  private readonly path: string;
  private readonly inMemory: boolean;
  private mem: MonitorEvent[] = [];

  constructor(opts: PersisterOptions) {
    this.path = opts.dbPath;
    this.inMemory = opts.dbPath === ':memory:';
    if (!this.inMemory) {
      // 确保目录存在、文件可追加
      const dir = this.path.includes('/') ? this.path.slice(0, this.path.lastIndexOf('/')) : '.';
      if (dir) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(this.path)) fs.writeFileSync(this.path, '');
    }
  }

  /** 批量持久化（追加） */
  saveEvents(events: MonitorEvent[]): void {
    if (events.length === 0) return;
    if (this.inMemory) { this.mem.push(...events); return; }
    const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(this.path, lines);
  }

  /** 载入全部事件（hydrate 用；按 id 去重后写覆盖、按 timestamp 升序） */
  loadAll(): MonitorEvent[] {
    const raw = this.inMemory ? this.mem : this.readLines();
    // append-only：同 id 后写覆盖前写（对齐 INSERT OR REPLACE 语义）
    const byId = new Map<string, MonitorEvent>();
    for (const e of raw) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
  }

  /** 取最近 N 条 */
  recent(limit: number): MonitorEvent[] {
    const all = this.loadAll();
    return all.slice(-limit);
  }

  count(): number {
    return this.loadAll().length;
  }

  clear(): void {
    if (this.inMemory) { this.mem = []; return; }
    fs.writeFileSync(this.path, '');
  }

  close(): void { /* fs 同步无需关闭 */ }

  private readLines(): MonitorEvent[] {
    if (!fs.existsSync(this.path)) return [];
    const content = fs.readFileSync(this.path, 'utf-8');
    return content.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as MonitorEvent);
  }
}

// 向后兼容别名（server.ts / index.ts 用 SqlitePersister 名）
export const SqlitePersister = JsonlPersister;
