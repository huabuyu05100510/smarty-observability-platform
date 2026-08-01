/**
 * @monit/backend/store - 内存时序存储 + 指纹分组聚合
 *
 * 接收 collector 上报的 MonitorEvent，按错误指纹 primary 聚合（first/last seen、count、sample），
 * 按 vital name 算 p75，按 session 聚合事件计数。
 * 对标 Sentry issue grouping + Datadog RUM 聚合。
 *
 * P2 内存版；真实生产可替换为 ClickHouse / Postgres（schema 不变）。
 */

import type { MonitorEvent, VitalMetric, SpanRecord } from '@monit/contracts';
import { buildReportFromEvents, analyzeRootCauses } from '@monit/diagnose';

export interface ErrorGroup {
  fingerprint: string;
  secondaryFingerprint?: string;
  type: string;
  subType: string;
  message: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** 首次出现的 release（release 回归关联：错误首发于哪个版本）*/
  firstRelease?: string;
  sample: MonitorEvent;
  sessionsAffected: Set<string>;
  /** 自动确定性根因（首次建组时算，闭环展示） */
  rootCause?: { kind: string; confidence: number; evidence: string[]; suggestedHealIds: string[] };
  /** 自动 AI 诊断（错误流入后异步调 LLM，闭环第二轨） */
  aiDiagnosis?: { diagnosis: string; suggestedFix: string; confidence: number; ts: number };
  /** 标记 AI 诊断已调度（避免重复触发） */
  aiDiagnosisPending?: boolean;
}

export interface VitalAggregation {
  name: string;
  count: number;
  p75: number;
  p99: number;
  worstRating: string;
  /** 最差样本的原始 payload（含归因：INP 三段/interactionTarget、LCP url/element、CLS shifts 等）*/
  sample?: unknown;
  subType?: string;
  /** 该最差样本所属 release（RCA sourcemap 还原用）*/
  release?: string;
  /** 深度根因分析：主导原因 + 可执行建议 + 行业基线（对标 Sentry/Datadog 性能归因）*/
  analysis?: VitalAnalysis;
}

export interface VitalAnalysis {
  /** 主导原因（如 "presentation=722ms 主导" / "资源 xxx.png"）*/
  dominantCause?: string;
  /** 可执行优化建议（基于归因，actionable）*/
  suggestions: string[];
  /** 行业基线对比（good/poor 阈值 + 当前值 + 判定）*/
  baseline: { good: number; poor: number; yours: number; verdict: string };
  /** 同指标跨版本回归（与上个 release 对比，可参考性）*/
  regression?: { vsRelease?: string; delta?: number; direction?: 'better' | 'worse' | 'same' };
  /** 用户故事：结合当前页面 + 行为序列 + 交互目标的具体上下文（非通用模板）*/
  userStory?: string;
  /** 用户行为序列（面包屑，还原"用户做了什么导致这次慢"）*/
  userActions?: string[];
  /** 发生页面（path）*/
  page?: string;
}

export interface SessionInfo {
  sessionId: string;
  release: string;
  eventCount: number;
  errorCount: number;
  firstSeen: number;
  lastSeen: number;
}

export class EventStore {
  private events: MonitorEvent[] = [];
  private errorGroups = new Map<string, ErrorGroup>();
  private vitals = new Map<string, Array<{ value: number; rating?: string; subType: string; payload: unknown; release: string }>>();
  private sessions = new Map<string, SessionInfo>();
  private spans: SpanRecord[] = []; // 跨层 trace join：后端 span
  private readonly capacity: number;
  /** errorGroups / sessions 的上限（events/spans 已 FIFO 封顶；这两个 Map 之前无界 -> 长跑 OOM）*/
  private readonly maxGroups: number;
  private readonly maxSessions: number;
  private readonly maxVitals: number;

  constructor(capacity = 10000) {
    this.capacity = capacity;
    this.maxGroups = Math.max(1000, Math.floor(capacity / 2));
    this.maxSessions = Math.max(1000, Math.floor(capacity / 2));
    this.maxVitals = Math.max(1000, Math.floor(capacity / 10));
  }

  ingest(events: MonitorEvent[]): { ingested: number; malformed: number } {
    // 每条事件 schema 校验 + try/catch：畸形事件跳过计数，不致整批 500 / store 半一致。
    let ingested = 0;
    let malformed = 0;
    for (const e of events) {
      if (!isValidEvent(e)) { malformed++; continue; }
      try {
        this.events.push(e);
        this.indexError(e);
        this.indexVital(e);
        this.indexSession(e);
        ingested++;
      } catch {
        malformed++;
      }
    }
    // 容量限制（FIFO）
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    // errorGroups / sessions 有界淘汰（超 10% 时批量回收，摊销排序成本）
    this.evictMaps();
    return { ingested, malformed };
  }

  private evictMaps(): void {
    if (this.errorGroups.size > this.maxGroups * 1.1) {
      const sorted = [...this.errorGroups.entries()].sort((a, b) => a[1].firstSeen - b[1].firstSeen);
      const remove = sorted.slice(0, this.errorGroups.size - this.maxGroups);
      for (const [k] of remove) this.errorGroups.delete(k);
    }
    if (this.sessions.size > this.maxSessions * 1.1) {
      const sorted = [...this.sessions.entries()].sort((a, b) => a[1].firstSeen - b[1].firstSeen);
      const remove = sorted.slice(0, this.sessions.size - this.maxSessions);
      for (const [k] of remove) this.sessions.delete(k);
    }
  }

  private indexError(e: MonitorEvent): void {
    if (e.type !== 'error' || !e.fingerprint) return;
    const fp = e.fingerprint.primary;
    let group = this.errorGroups.get(fp);
    if (!group) {
      const payload = e.payload as { message?: string };
      group = {
        fingerprint: fp,
        secondaryFingerprint: e.fingerprint.secondary,
        type: e.type,
        subType: e.subType,
        message: payload.message ?? e.subType,
        count: 0,
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
        firstRelease: e.release,
        sample: e,
        sessionsAffected: new Set(),
      };
      // 自动确定性根因（闭环：错误一流入即算根因，面板自动展示）
      try {
        const report = buildReportFromEvents([e]);
        const records = analyzeRootCauses(report);
        const top = records[0]?.candidates[0];
        if (top) {
          group.rootCause = {
            kind: top.kind,
            confidence: top.confidence,
            evidence: top.evidence,
            suggestedHealIds: top.suggestedHealIds,
          };
        }
      } catch { /* 根因计算失败不影响 ingest */ }
      this.errorGroups.set(fp, group);
    }
    group.count++;
    group.lastSeen = Math.max(group.lastSeen, e.timestamp);
    group.firstSeen = Math.min(group.firstSeen, e.timestamp);
    if (!group.firstRelease && e.release) group.firstRelease = e.release;
    if (e.sessionId) group.sessionsAffected.add(e.sessionId);
  }

  private indexVital(e: MonitorEvent): void {
    if (e.type !== 'vital') return;
    const payload = e.payload as VitalMetric & Record<string, unknown>;
    if (!payload || typeof payload.value !== 'number') return;
    // name：LCP/CLS/FCP/TTFB 在 payload.name；INP 上报的是 InpAttribution（无 name）→ 用 subType
    const name = payload.name || e.subType.toUpperCase();
    const arr = this.vitals.get(name) ?? [];
    arr.push({ value: payload.value, rating: payload.rating as string | undefined, subType: e.subType, payload, release: e.release });
    if (arr.length > this.maxVitals) arr.shift();
    this.vitals.set(name, arr);
  }

  private indexSession(e: MonitorEvent): void {
    let s = this.sessions.get(e.sessionId);
    if (!s) {
      s = {
        sessionId: e.sessionId,
        release: e.release,
        eventCount: 0,
        errorCount: 0,
        firstSeen: e.timestamp,
        lastSeen: e.timestamp,
      };
      this.sessions.set(e.sessionId, s);
    }
    s.eventCount++;
    if (e.type === 'error') s.errorCount++;
    s.lastSeen = Math.max(s.lastSeen, e.timestamp);
    s.firstSeen = Math.min(s.firstSeen, e.timestamp);
  }

  /** 错误分组列表（按 count 降序） */
  errorGroupsList(): ErrorGroup[] {
    return [...this.errorGroups.values()]
      .sort((a, b) => b.count - a.count)
      .map(g => ({ ...g, sessionsAffected: new Set(g.sessionsAffected) }));
  }

  /** 按指纹取错误分组详情 */
  errorGroup(fingerprint: string): ErrorGroup | undefined {
    const g = this.errorGroups.get(fingerprint);
    return g ? { ...g, sessionsAffected: new Set(g.sessionsAffected) } : undefined;
  }

  /** 设置 AI 诊断（异步 LLM 调用后回写） */
  setAiDiagnosis(fp: string, diag: NonNullable<ErrorGroup['aiDiagnosis']>): void {
    const g = this.errorGroups.get(fp);
    if (g) g.aiDiagnosis = diag;
  }

  /**
   * 原子认领 AI 诊断：在【live group】上 check-and-set pending 标记。
   * 返回 true=本次认领成功（应跑诊断）；false=已 pending 或已诊断（跳过，防每事件重复触发）。
   * 之前 server 在 errorGroup() 返回的【克隆】上设 pending，标记从不落库 -> 去重失效、每事件都触发 LLM。
   */
  tryClaimAiDiagnosis(fp: string): boolean {
    const g = this.errorGroups.get(fp);
    if (!g || g.aiDiagnosisPending || g.aiDiagnosis) return false;
    g.aiDiagnosisPending = true;
    return true;
  }

  /** 清除 pending 标记（诊断完成后，无论成功失败）*/
  clearAiDiagnosisPending(fp: string): void {
    const g = this.errorGroups.get(fp);
    if (g) g.aiDiagnosisPending = false;
  }

  /** 该错误分组的所有事件 */
  eventsForFingerprint(fingerprint: string): MonitorEvent[] {
    return this.events.filter(e => e.fingerprint?.primary === fingerprint);
  }

  /** 错误趋势：按时间桶聚合 error 事件数（默认 24 桶，覆盖最近窗口） */
  errorTrend(buckets = 24, windowMs = 24 * 60 * 60 * 1000): Array<{ ts: number; count: number }> {
    const now = Date.now();
    const start = now - windowMs;
    const bucketMs = windowMs / buckets;
    const counts = new Array(buckets).fill(0);
    for (const e of this.events) {
      if (e.type !== 'error' || e.timestamp < start) continue;
      const idx = Math.min(buckets - 1, Math.floor((e.timestamp - start) / bucketMs));
      counts[idx]++;
    }
    return counts.map((count, i) => ({ ts: start + i * bucketMs, count }));
  }

  /** 错误按 subType 分布 */
  errorStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const e of this.events) {
      if (e.type !== 'error') continue;
      stats[e.subType] = (stats[e.subType] ?? 0) + 1;
    }
    return stats;
  }

  /** 按 release 分桶（错误数 + 事件数 + 受影响 session） */
  releaseBreakdown(): Array<{ release: string; errors: number; events: number; sessions: number }> {
    const map = new Map<string, { errors: number; events: number; sessions: Set<string> }>();
    for (const e of this.events) {
      const r = e.release ?? 'unknown';
      const cur = map.get(r) ?? { errors: 0, events: 0, sessions: new Set<string>() };
      cur.events++;
      if (e.type === 'error') cur.errors++;
      cur.sessions.add(e.sessionId);
      map.set(r, cur);
    }
    return [...map.entries()]
      .map(([release, v]) => ({ release, errors: v.errors, events: v.events, sessions: v.sessions.size }))
      .sort((a, b) => b.events - a.events);
  }

  /**
   * 错误首发 release 回归关联：按 firstRelease 聚合错误组数 + 受影响 session。
   * 回答"哪个 release 引入了新错误"（release 回归定位）。
   */
  newErrorsByRelease(): Array<{ release: string; newErrorGroups: number; affectedSessions: number; samples: string[] }> {
    const map = new Map<string, { groups: number; sessions: Set<string>; samples: string[] }>();
    for (const g of this.errorGroups.values()) {
      const r = g.firstRelease ?? 'unknown';
      const cur = map.get(r) ?? { groups: 0, sessions: new Set<string>(), samples: [] as string[] };
      cur.groups++;
      g.sessionsAffected.forEach(s => cur.sessions.add(s));
      if (cur.samples.length < 3) cur.samples.push(g.message.slice(0, 80));
      map.set(r, cur);
    }
    return [...map.entries()]
      .map(([release, v]) => ({ release, newErrorGroups: v.groups, affectedSessions: v.sessions.size, samples: v.samples }))
      .sort((a, b) => b.newErrorGroups - a.newErrorGroups);
  }

  /** 行为沮丧信号聚合（行为支柱：按 kind 计数）*/
  frustrationStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const e of this.events) {
      if (e.type !== 'behavior') continue;
      const p = e.payload as { kind?: string };
      if (p?.kind) stats[p.kind] = (stats[p.kind] ?? 0) + 1;
    }
    return stats;
  }

  /** 白屏事件列表（白屏支柱）*/
  whiteScreenEvents(limit = 50): Array<{ timestamp: number; type: string; causalErrorId?: string; causalResourceUrl?: string }> {
    const out: Array<{ timestamp: number; type: string; causalErrorId?: string; causalResourceUrl?: string }> = [];
    for (const e of this.events) {
      if (e.type !== 'white-screen') continue;
      const p = e.payload as { timestamp?: number; type?: string; causalErrorId?: string; causalResourceUrl?: string };
      out.push({ timestamp: p.timestamp ?? e.timestamp, type: p.type ?? 'unknown', causalErrorId: p.causalErrorId, causalResourceUrl: p.causalResourceUrl });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** vital 聚合（含最差样本归因 sample） */
  vitalsAggregation(): VitalAggregation[] {
    const out: VitalAggregation[] = [];
    for (const [name, samples] of this.vitals) {
      if (samples.length === 0) continue;
      const values = samples.map((s) => s.value);
      const sorted = [...values].sort((a, b) => a - b);
      const worst = samples.reduce((w, s) => (s.value > w.value ? s : w), samples[0]);
      out.push({
        name,
        count: samples.length,
        p75: percentile(sorted, 75),
        p99: percentile(sorted, 99),
        worstRating: ratingForWorst(name, Math.max(...values)),
        sample: worst.payload,
        subType: worst.subType,
        release: worst.release,
        analysis: vitalAnalysis(name, worst.payload as Record<string, unknown>),
      });
    }
    return out;
  }

  /** session 列表 */
  sessionsList(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 某 vital 的原始样本序列（供趋势/分布图，按时间升序）*/
  vitalsSamples(name: string): Array<{ ts: number; value: number; rating?: string }> {
    const out: Array<{ ts: number; value: number; rating?: string }> = [];
    for (const e of this.events) {
      if (e.type !== 'vital') continue;
      const p = e.payload as { name?: string; value?: number; rating?: string };
      const n = p.name || e.subType.toUpperCase();
      if (n !== name) continue;
      if (typeof p.value === 'number') out.push({ ts: e.timestamp, value: p.value, rating: p.rating });
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** 全部事件（分页） */
  recentEvents(limit = 100): MonitorEvent[] {
    return this.events.slice(-limit);
  }

  /** 事件总数（health/统计用，O(1)，替代 recentEvents(9999).length） */
  size(): number {
    return this.events.length;
  }

  /** 错误分组列表摘要（不 clone sessionsAffected Set，直接返数量）—— 高频 read 端点用 */
  errorGroupsListSummary(): Array<{
    fingerprint: string; type: string; subType: string; message: string;
    count: number; firstSeen: number; lastSeen: number; firstRelease?: string;
    affectedSessions: number; rootCause?: ErrorGroup['rootCause'];
    aiDiagnosis?: ErrorGroup['aiDiagnosis']; aiDiagnosisPending?: boolean;
  }> {
    return [...this.errorGroups.values()]
      .sort((a, b) => b.count - a.count)
      .map((g) => ({
        fingerprint: g.fingerprint, type: g.type, subType: g.subType, message: g.message,
        count: g.count, firstSeen: g.firstSeen, lastSeen: g.lastSeen, firstRelease: g.firstRelease,
        affectedSessions: g.sessionsAffected.size, rootCause: g.rootCause,
        aiDiagnosis: g.aiDiagnosis, aiDiagnosisPending: g.aiDiagnosisPending,
      }));
  }

  clear(): void {
    this.events = [];
    this.errorGroups.clear();
    this.vitals.clear();
    this.sessions.clear();
    this.spans = [];
  }

  // ── 跨层 trace join：span 摄入与查询 ──────────────────────────────────

  /** 摄入后端 span（同 traceId 串起前端 error/vital <-> 后端 span）*/
  ingestSpans(spans: SpanRecord[]): void {
    for (const s of spans) {
      this.spans.push(s);
    }
    // 容量限制（FIFO）
    if (this.spans.length > this.capacity) {
      this.spans.splice(0, this.spans.length - this.capacity);
    }
  }

  /** 取某 trace 下所有 span（按 startTime 排序）*/
  spansForTrace(traceId: string): SpanRecord[] {
    return this.spans
      .filter(s => s.traceId === traceId)
      .sort((a, b) => a.startTime - b.startTime);
  }

  /** 取某 trace 下的慢 span（durationMs > slowThreshold）*/
  slowSpansForTrace(traceId: string, slowThresholdMs = 500): SpanRecord[] {
    return this.spansForTrace(traceId).filter(s => s.durationMs >= slowThresholdMs);
  }

  /** 全部 span（调试/面板）*/
  allSpans(limit = 200): SpanRecord[] {
    return this.spans.slice(-limit);
  }
}

/** 最小 schema 校验：畸形事件跳过（防整批 ingest 失败 + store 半一致）。 */
function isValidEvent(e: unknown): e is MonitorEvent {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.type !== 'string' || typeof o.timestamp !== 'number') return false;
  if (o.fingerprint !== undefined) {
    const f = o.fingerprint as Record<string, unknown>;
    if (typeof f?.primary !== 'string') return false;
  }
  return true;
}

/** 百分位（线性插值，rank=(n-1)*p/100）。匹配 CrUX/Chrome Web Vitals p75 定义；
 *  之前用 nearest-rank floor，对 [100..1000] 10 样本 p75 返回 800 而非规范的 775。 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function ratingForWorst(name: string, value: number): string {
  if (name === 'INP') return value > 500 ? 'poor' : value > 200 ? 'needs-improvement' : 'good';
  if (name === 'LCP') return value > 4000 ? 'poor' : value > 2500 ? 'needs-improvement' : 'good';
  if (name === 'CLS') return value > 0.25 ? 'poor' : value > 0.1 ? 'needs-improvement' : 'good';
  return 'good';
}

/**
 * 性能根因深度分析：主导原因 + 可执行建议 + 行业基线（对标 Sentry Performance / Datadog RUM 归因）。
 * 让 vitals 不只是数字，而是"为什么慢 + 怎么改 + 比行业如何"。
 */
function vitalAnalysis(name: string, s: Record<string, unknown>): VitalAnalysis {
  const value = typeof s.value === 'number' ? s.value : 0;
  const attr = (s.attribution && typeof s.attribution === 'object' ? s.attribution : {}) as Record<string, unknown>;
  const base = (good: number, poor: number): VitalAnalysis['baseline'] => ({
    good, poor, yours: value,
    verdict: value <= good ? 'good（达行业 75 分位内）' : value <= poor ? 'needs-improvement（需优化）' : 'poor（差于行业 95 分位）',
  });
  const suggestions: string[] = [];

  if (name === 'INP') {
    const phases: Array<[string, number]> = [
      ['inputDelay', typeof s.inputDelay === 'number' ? s.inputDelay : 0],
      ['processing', typeof s.processingDuration === 'number' ? s.processingDuration : 0],
      ['presentation', typeof s.presentationDelay === 'number' ? s.presentationDelay : 0],
    ];
    const dom = [...phases].sort((a, b) => b[1] - a[1])[0];
    const domLabel = (dom[0] === 'inputDelay' ? '输入延迟（主线程被占用）' : dom[0] === 'processing' ? '回调处理（交互逻辑耗时）' : '渲染呈现（布局/绘制）');
    const pct = (dom[1] / (value || 1) * 100).toFixed(0);
    // 结合当前页面 + 用户行为序列 + 交互目标 → "用户故事"（非通用模板）
    const page = (s.page && typeof s.page === 'object') ? (s.page as { path?: string; url?: string }) : null;
    const bcrumbs = (Array.isArray(s.breadcrumbs) ? s.breadcrumbs : []) as Array<{ type?: string; message?: string; target?: string }>;
    const target = typeof s.interactionTarget === 'string' ? s.interactionTarget : null;
    const actions = bcrumbs.slice(-5).map((b) => b.message || (b.type === 'click' && b.target ? '点击 ' + b.target : b.type || '操作')).filter(Boolean);
    const storyParts: string[] = [];
    if (page) storyParts.push(`发生在页面 ${page.path || page.url}`);
    if (actions.length) storyParts.push(`用户刚做了: ${actions.join(' → ')}`);
    if (target) storyParts.push(`本次慢交互目标: ${target}`);
    storyParts.push(`${domLabel} 占 ${pct}%（${dom[1].toFixed(0)}ms）`);
    const userStory = storyParts.join('；');
    // 具体建议：绑定到"这个页面的这个交互"，而非泛泛
    if (dom[0] === 'inputDelay') suggestions.push(`用户${target ? '点击「' + target + '」' : '交互'}时主线程被占 → 该页面有长任务/定时器阻塞了输入；检查此页同步重计算，scheduler.yield() 拆分`);
    else if (dom[0] === 'processing') suggestions.push(`点击「${target || '该元素'}」的回调耗时过长 → 追踪该事件处理；若涉及大文档解析(office 项目常见)，改流式/分片/Web Worker`);
    else suggestions.push(`「${target || '该交互'}」触发后渲染慢 → 该页面 DOM 过大/重排；content-visibility 懒渲染，读写分离防 layout thrashing`);
    if (Array.isArray(s.longAnimationFrameEntries) && s.longAnimationFrameEntries[0]) suggestions.push('LoAF 已定位到具体脚本 → 点「LoAF 根因还原」直接跳到源码行 + 代码片段');
    return { dominantCause: `${domLabel} = ${dom[1].toFixed(0)}ms（占 ${pct}%）`, suggestions, baseline: base(200, 500), userStory, userActions: actions, page: page?.path };
  }
  if (name === 'LCP') {
    if (attr.url) {
      suggestions.push(`LCP 资源：${attr.url} → 加 fetchpriority="high"/<link rel=preload>，WebP/AVIF+尺寸优化，走 CDN`);
      suggestions.push('检查渲染阻塞 JS/CSS 是否排在它前面 → 关键 CSS 内联，非关键 JS defer');
    } else {
      suggestions.push('LCP 为元素渲染 → 减少 TTFB（CDN/边缘缓存），内联关键 CSS，defer 非关键 JS');
    }
    if (attr.element) suggestions.push(`LCP 元素：${attr.element}`);
    return { dominantCause: attr.url ? `资源加载 ${attr.url}` : '元素渲染阻塞', suggestions, baseline: base(2500, 4000) };
  }
  if (name === 'CLS') {
    suggestions.push('为图片/视频/广告/嵌入设 width/height 或 aspect-ratio 预留空间');
    suggestions.push('避免在已有内容上方插入元素（除非用户交互触发）');
    suggestions.push('字体用 font-display:swap + size-adjust 防 FOUT 抖动');
    if (attr.target) suggestions.push(`最大 shift 目标：${attr.target}`);
    return { dominantCause: attr.target ? `布局抖动（${attr.target}）` : '布局抖动', suggestions, baseline: base(0.1, 0.25) };
  }
  if (name === 'TTFB') {
    suggestions.push('CDN/边缘缓存 + HTTP/2，减少服务端响应，dns-prefetch/preconnect 预热连接');
    return { dominantCause: '服务端响应/连接', suggestions, baseline: base(800, 1800) };
  }
  if (name === 'FCP') {
    suggestions.push('内联关键 CSS，defer 非关键 JS，减少首屏阻塞资源');
    return { dominantCause: '首屏渲染阻塞', suggestions, baseline: base(1800, 3000) };
  }
  return { suggestions, baseline: base(0, Infinity) };
}