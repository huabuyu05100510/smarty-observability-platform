/**
 * @monit/diagnose/flamegraph - 性能火焰图构建
 *
 * 吸收 smarty-monitor/packages/diagnose/flamegraph.ts 的 buildPerfFlamegraph。
 * 嵌套 icicle 树：INP root -> 三段（input/processing/presentation）-> LoAF 脚本。
 *
 * 对标：Brendan Gregg 火焰图方法论（CACM）-- 把 profiler 文本压缩成可交互图形。
 * MySQL 案例：591,622 行 -> 火焰图定位真热点 -> CPU 降 40%。
 */

import type {
  AttributionRecord,
  DiagnosticReport,
  LoafScriptFrame,
  PerfFlameRow,
  PerfFlamegraphData,
} from '@monit/contracts';

/** 第一方检测（同源 / 已知 CDN 白名单） */
export function isFirstParty(url: string | undefined, pageOrigin?: string): boolean {
  if (!url) return true;
  try {
    const u = new URL(url, pageOrigin ?? 'https://localhost');
    if (pageOrigin && u.origin === new URL(pageOrigin).origin) return true;
    // 常见第一方静态域名特征
    return /\.(woff2?|png|jpe?g|svg)$/i.test(u.pathname) === false && !u.hostname.includes('.');
  } catch {
    return true;
  }
}

/** p99 近似（小样本退化为 max） */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length < 20) return Math.max(...values); // 小样本用 max 更稳
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

let rowCounter = 0;
function rowId(): string {
  return `flame-${rowCounter++}`;
}

function loafScriptToRow(script: LoafScriptFrame, startMs: number, depth: number, p99: number): PerfFlameRow {
  const name = script.sourceFunctionName ?? script.invoker ?? script.name ?? '<anon script>';
  return {
    id: rowId(),
    name,
    kind: 'script',
    startMs: script.startTime,
    durationMs: script.duration,
    depth,
    children: [],
    isHot: script.duration >= p99 * 0.5,
    meta: {
      sourceURL: script.sourceURL,
      invokerType: script.invokerType,
      sourceCharPosition: script.sourceCharPosition,
    },
  };
}

/**
 * 构建 INP 火焰图：root -> 3 phases -> LoAF scripts。
 * LoAF 数据不足时产合成回退帧（synthetic=true），保证 demo 可渲染。
 */
export function buildPerfFlamegraph(
  report: DiagnosticReport,
  _records?: AttributionRecord[],
): PerfFlamegraphData {
  rowCounter = 0;
  const inp = report.inp;
  if (!inp) {
    return { roots: [], totalMs: 0, p99: 0 };
  }

  const loafScripts = (inp.longAnimationFrameEntries ?? []).flatMap(e => e.scripts);
  const p99 = percentile(loafScripts.map(s => s.duration), 99);

  const phases: PerfFlameRow[] = [
    {
      id: rowId(),
      name: `input delay (${inp.inputDelay}ms)`,
      kind: 'inp_phase',
      startMs: 0,
      durationMs: inp.inputDelay,
      depth: 1,
      children: [],
      isHot: inp.inputDelay >= p99 * 0.5 && p99 > 0,
    },
    {
      id: rowId(),
      name: `processing (${inp.processingDuration}ms)`,
      kind: 'inp_phase',
      startMs: inp.inputDelay,
      durationMs: inp.processingDuration,
      depth: 1,
      children: loafScripts.map(s => loafScriptToRow(s, inp.inputDelay, 2, p99)),
      isHot: inp.processingDuration >= p99 * 0.5 && p99 > 0,
    },
    {
      id: rowId(),
      name: `presentation (${inp.presentationDelay}ms)`,
      kind: 'inp_phase',
      startMs: inp.inputDelay + inp.processingDuration,
      durationMs: inp.presentationDelay,
      depth: 1,
      children: [],
      isHot: inp.presentationDelay >= p99 * 0.5 && p99 > 0,
    },
  ];

  const root: PerfFlameRow = {
    id: rowId(),
    name: `INP ${inp.value}ms (${inp.rating})`,
    kind: 'frame',
    startMs: 0,
    durationMs: inp.value,
    depth: 0,
    children: phases,
    isHot: inp.value >= 500,
  };

  // 合成回退：无 LoAF 数据时加一个 synthetic 帧提示
  if (loafScripts.length === 0 && inp.value >= 200) {
    phases[1].children.push({
      id: rowId(),
      name: '<no LoAF attribution — fallback>',
      kind: 'script',
      startMs: inp.inputDelay,
      durationMs: inp.processingDuration,
      depth: 2,
      children: [],
      synthetic: true,
      meta: { note: 'LoAF unsupported on this browser, or no scripts >5ms' },
    });
  }

  return {
    roots: [root],
    totalMs: inp.value,
    p99,
  };
}

// ─── 差异火焰图（性能回归可视化） ─────────────────────────────────────────────
// 对标 Brendan Gregg differential flame graph：红=上升（回归），蓝=下降（改善）。
// Netflix 每日夜间自动生成，识别性能回归。

export interface DiffFlameRow extends PerfFlameRow {
  /** 与基线对比的时长差（正=变慢/回归，负=变快/改善） */
  deltaMs?: number;
  /** 趋势 */
  trend?: 'regression' | 'improvement' | 'stable' | 'new' | 'removed';
}

export interface DiffFlamegraphData {
  roots: DiffFlameRow[];
  totalMs: number;
  baselineTotalMs: number;
  /** 整体回归幅度（>0 = 变慢） */
  regressionRatio: number;
}

/** 索引火焰图：name@depth -> row（用于匹配前后两图） */
function indexFlame(rows: PerfFlameRow[], depth = 0, out = new Map<string, PerfFlameRow>()): Map<string, PerfFlameRow> {
  for (const r of rows) {
    const key = `${r.name}@${depth}`;
    if (!out.has(key)) out.set(key, r);
    if (r.children.length > 0) indexFlame(r.children, depth + 1, out);
  }
  return out;
}

function diffRows(
  after: PerfFlameRow[],
  beforeIndex: Map<string, PerfFlameRow>,
  depth = 0,
): DiffFlameRow[] {
  return after.map(r => {
    const key = `${r.name}@${depth}`;
    const before = beforeIndex.get(key);
    const deltaMs = before ? r.durationMs - before.durationMs : r.durationMs;
    let trend: DiffFlameRow['trend'];
    if (!before) trend = 'new';
    else if (deltaMs > 5) trend = 'regression';
    else if (deltaMs < -5) trend = 'improvement';
    else trend = 'stable';

    return {
      ...r,
      deltaMs,
      trend,
      children: diffRows(r.children, beforeIndex, depth + 1),
    };
  });
}

/**
 * 构建差异火焰图：after vs before，标记回归/改善帧。
 * 用于性能回归可视化（优化前后对比，避免"感觉变快"的主观判断）。
 */
export function buildDiffFlamegraph(
  before: PerfFlamegraphData,
  after: PerfFlamegraphData,
): DiffFlamegraphData {
  const beforeIndex = indexFlame(before.roots);
  const roots = diffRows(after.roots, beforeIndex);
  const regressionRatio = before.totalMs > 0
    ? (after.totalMs - before.totalMs) / before.totalMs
    : 0;
  return {
    roots,
    totalMs: after.totalMs,
    baselineTotalMs: before.totalMs,
    regressionRatio,
  };
}