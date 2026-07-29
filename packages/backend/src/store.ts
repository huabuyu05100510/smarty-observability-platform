/**
 * @monit/backend/store - 内存时序存储 + 指纹分组聚合
 *
 * 接收 collector 上报的 MonitorEvent，按错误指纹 primary 聚合（first/last seen、count、sample），
 * 按 vital name 算 p75，按 session 聚合事件计数。
 * 对标 Sentry issue grouping + Datadog RUM 聚合。
 *
 * P2 内存版；真实生产可替换为 ClickHouse / Postgres（schema 不变）。
 */

import type { MonitorEvent, VitalMetric } from '@monit/contracts';
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
  private vitals = new Map<string, number[]>(); // name -> values
  private sessions = new Map<string, SessionInfo>();
  private readonly capacity: number;

  constructor(capacity = 10000) {
    this.capacity = capacity;
  }

  ingest(events: MonitorEvent[]): void {
    for (const e of events) {
      this.events.push(e);
      this.indexError(e);
      this.indexVital(e);
      this.indexSession(e);
    }
    // 容量限制（FIFO）
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
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
    if (e.sessionId) group.sessionsAffected.add(e.sessionId);
  }

  private indexVital(e: MonitorEvent): void {
    if (e.type !== 'vital') return;
    const payload = e.payload as VitalMetric;
    if (!payload || typeof payload.value !== 'number') return;
    const arr = this.vitals.get(payload.name) ?? [];
    arr.push(payload.value);
    if (arr.length > 1000) arr.shift();
    this.vitals.set(payload.name, arr);
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

  /** vital 聚合 */
  vitalsAggregation(): VitalAggregation[] {
    const out: VitalAggregation[] = [];
    for (const [name, values] of this.vitals) {
      if (values.length === 0) continue;
      const sorted = [...values].sort((a, b) => a - b);
      out.push({
        name,
        count: values.length,
        p75: percentile(sorted, 75),
        p99: percentile(sorted, 99),
        worstRating: ratingForWorst(name, Math.max(...values)),
      });
    }
    return out;
  }

  /** session 列表 */
  sessionsList(): SessionInfo[] {
    return [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** 全部事件（分页） */
  recentEvents(limit = 100): MonitorEvent[] {
    return this.events.slice(-limit);
  }

  clear(): void {
    this.events = [];
    this.errorGroups.clear();
    this.vitals.clear();
    this.sessions.clear();
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function ratingForWorst(name: string, value: number): string {
  if (name === 'INP') return value > 500 ? 'poor' : value > 200 ? 'needs-improvement' : 'good';
  if (name === 'LCP') return value > 4000 ? 'poor' : value > 2500 ? 'needs-improvement' : 'good';
  if (name === 'CLS') return value > 0.25 ? 'poor' : value > 0.1 ? 'needs-improvement' : 'good';
  return 'good';
}