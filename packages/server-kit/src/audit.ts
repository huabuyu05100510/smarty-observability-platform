/**
 * 审计日志：写端点与拒绝事件留痕。
 */
export interface AuditEntry {
  ts: number;
  level: 'info' | 'warn' | 'deny';
  method: string;
  url: string;
  origin?: string;
  remote?: string;
  status: number;
  bytes?: number;
  reason?: string;
}

export type AuditSink = (e: AuditEntry) => void;

export const consoleAudit: AuditSink = (e) => {
  const line = `[audit] ${e.method} ${e.url} ${e.status} ${e.remote ?? '-'} ${e.origin ?? '-'} ${e.reason ?? ''}`;
  if (e.level === 'deny') console.warn(line);
  else console.log(line);
};

export function audit(sink: AuditSink | undefined, e: Omit<AuditEntry, 'ts'>): void {
  if (!sink) return;
  sink({ ts: Date.now(), ...e });
}
