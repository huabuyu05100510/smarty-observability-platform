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

  /** 该错误分组的所有事件 */
  eventsForFingerprint(fingerprint: string): MonitorEvent[] {
    return this.events.filter(e => e.fingerprint?.primary === fingerprint);
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