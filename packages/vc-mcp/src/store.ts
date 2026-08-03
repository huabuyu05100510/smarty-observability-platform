// store.ts · findings 缓冲 + 持久化
// ----------------------------------------------------------------------------
// localhost HTTP(扩展推入)与 stdio MCP(agent 读出)跨进程/跨 session 的共享层。
// 一个 JSON 文件做环形缓冲(cap 50):扩展推一条 → 落盘;agent 任何时候 get/list 都能读到。
//
// 设计:
//   - 原子写(tmp + rename):并发 http 推入 / mcp 读出共享同一文件,半写不可见。
//   - 损坏/读失败 → [](不抛):调用方降级,绝不因磁盘问题阻断 MCP 主链路。
//   - id/createdAt 由服务端(http.ts)分配,绝不信任客户端传入 —— 扩展是浏览器侧,可被改。
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface VcTarget {
  /** sourcemap sources[] 原始条目(可能带 webpack:/// 等前缀,由 normalize.ts 归一) */
  file: string;
  symbol?: string;
  search: string;
  replace: string;
}

export interface VcFinding {
  id: string;
  createdAt: number;
  rootCause: string;
  confidence: number;
  evidence: string[];
  diff: { search: string; replace: string; explanation?: string; risk?: string; riskReason?: string };
  verification: { accepted: boolean; reason: string; confidence: number };
  targets: VcTarget[];
  sourceHint?: string;
  diagnosis?: string;
  riskScore?: number;
  riskNotes?: string[];
  host?: string;
  origin?: string;
  route?: string;
  signal?: string;
  eventId?: string;
}

export function loadFindings(p: string): VcFinding[] {
  try {
    if (!existsSync(p)) return [];
    const raw = readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as VcFinding[]) : [];
  } catch {
    return []; // 损坏/读失败 → 空,不抛
  }
}

export function saveFindings(p: string, items: VcFinding[]): void {
  try {
    const dir = path.dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(items), 'utf8');
    renameSync(tmp, p); // 原子:rename 后读端才看到整份新 buffer
  } catch {
    /* 持久化失败不阻断:调用方仍持有内存中的新 buffer */
  }
}

/** 追加并环形裁剪到 cap;返回新 buffer(http 推入用)。 */
export function appendFinding(p: string, f: VcFinding, cap = 50): VcFinding[] {
  const items = loadFindings(p);
  items.push(f);
  while (items.length > cap) items.shift(); // 超 cap 丢最旧
  saveFindings(p, items);
  return items;
}

export function clearFindings(p: string): void {
  saveFindings(p, []);
}

/** append 顺序 → 末尾为最新。 */
export function latest(items: VcFinding[]): VcFinding | null {
  return items.length ? items[items.length - 1] : null;
}

/** 给 http 接收端构造一个带服务端 id 的 finding(合并客户端传入字段)。 */
export function makeFinding(input: Partial<VcFinding>): VcFinding {
  const createdAt = Date.now();
  return {
    id: `f-${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt,
    rootCause: '',
    confidence: 0,
    evidence: [],
    diff: { search: '', replace: '' },
    verification: { accepted: false, reason: '', confidence: 0 },
    targets: [],
    ...input,
  };
}
