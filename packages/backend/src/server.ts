/**
 * @monit/backend/server - ingest + 查询 + 内置面板
 *
 * 端点：
 * - POST /api/events        批量 ingest（collector 上报）
 * - GET  /api/errors        错误分组列表（按指纹聚合，count 降序）
 * - GET  /api/errors/:fp    错误分组详情 + 事件
 * - GET  /api/vitals        vital 聚合（p75/p99）
 * - GET  /api/sessions      session 列表
 * - GET  /                  内置面板 HTML
 */

import http from 'node:http';
import type { MonitorEvent } from '@monit/contracts';
import { EventStore, type ErrorGroup } from './store';
import { SourcemapStore } from './sourcemap';
import { SqlitePersister } from './persist';
import { dashboardHtml } from './dashboard';
import { chat, type LLMConfig } from '@monit/repair-agent';

export interface BackendOptions {
  port?: number;
  host?: string;
  /** CORS origin（默认 *，本地） */
  corsOrigin?: string;
  /** 可选 GitHub raw 回退基址（sourcemap 远端获取） */
  githubRawBase?: string;
  /** 可选 SQLite 持久化路径（不传则纯内存）；:memory: 为内存 SQLite */
  dbPath?: string;
  /** 可选 React 面板 HTML 文件路径（设了则作为 / 主面板，替代内置简单 HTML） */
  dashboardFile?: string;
  /** 可选 LLM 配置（设了则错误流入后自动调 AI 出诊断，fire-and-forget） */
  llmConfig?: LLMConfig;
  /** 可选自愈自动触发配置：AI 诊断后调 coordinator /auto-heal 跑完整 runMrDraftTrack → 开 PR */
  autoHeal?: {
    coordinatorUrl: string;
    sourceFiles: Array<{ path: string; content: string }>;
    testFiles?: Array<{ path: string; content: string }>;
    /** demo 用：高阈值让 demo 触发 auto-pr（产品里应保持默认 0.4 严护栏） */
    riskThreshold?: number;
  };
}

export interface BackendHandle {
  server: http.Server;
  store: EventStore;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

export function createBackendServer(opts: BackendOptions = {}): BackendHandle {
  const store = new EventStore(10000);
  const sourcemaps = new SourcemapStore({ githubRawBase: opts.githubRawBase });
  // SQLite 持久化（可选）：启动时 hydrate，ingest 时落盘
  const persister = opts.dbPath ? new SqlitePersister({ dbPath: opts.dbPath }) : null;
  if (persister) {
    const historical = persister.loadAll();
    if (historical.length > 0) store.ingest(historical);
  }
  const port = opts.port ?? 3921;
  const host = opts.host ?? '127.0.0.1';
  const corsOrigin = opts.corsOrigin ?? '*';

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    try {
      // POST /api/events - ingest（兼容裸数组 [..] 与 {events:[..]} 信封）
      if (url === '/api/events' && method === 'POST') {
        const body = await readBody(req);
        const parsed = JSON.parse(body || '[]') as unknown;
        const events: unknown[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray((parsed as { events?: unknown[] })?.events)
            ? (parsed as { events: unknown[] }).events
            : [];
        store.ingest(events as never);
        persister?.saveEvents(events as never);

        // 自动 AI 诊断（fire-and-forget）：新错误组触发 MiniMax 出诊断
        if (opts.llmConfig) {
          for (const e of events as MonitorEvent[]) {
            const fp = e.fingerprint?.primary;
            if (e.type !== 'error' || !fp) continue;
            const g = store.errorGroup(fp);
            if (!g || g.aiDiagnosisPending || g.aiDiagnosis) continue;
            g.aiDiagnosisPending = true;
            void runAiDiagnosis(opts.llmConfig, g).then(async (diag) => {
              if (diag) store.setAiDiagnosis(fp, diag);
              if (g) g.aiDiagnosisPending = false;
              // AI 诊断后：若配了 sourceFiles（demo 仓库的源文件），自动触发自愈闭环
              // （coordinator /auto-heal：诊断→生成补丁→护栏→开 PR）
              if (diag && diag.formatMatched && opts.autoHeal?.sourceFiles?.length && opts.autoHeal?.coordinatorUrl) {
                const errPayload = g.sample.payload as { message?: string; stack?: string };
                const autoRecord = {
                  id: 'rec-' + fp,
                  symptomId: fp,
                  symptom: { kind: 'error' as const, observed: errPayload?.message ?? '' },
                  candidates: [{
                    kind: 'error.js' as const,
                    confidence: g.rootCause?.confidence ?? 0.8,
                    evidence: g.rootCause?.evidence ?? [],
                    anchors: { errorId: fp },
                    suggestedHealIds: g.rootCause?.suggestedHealIds ?? [],
                  }],
                  severity: 'critical' as const,
                  createdAt: g.firstSeen,
                };
                fetch(`${opts.autoHeal.coordinatorUrl}/auto-heal`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    record: autoRecord,
                    sourceFiles: opts.autoHeal.sourceFiles,
                    testFiles: opts.autoHeal.testFiles ?? [],
                    riskThreshold: opts.autoHeal.riskThreshold,
                    anomaly: { startedAt: g.firstSeen, spikeRatio: 1 },
                  }),
                }).catch((e) => console.warn('[auto-heal] trigger failed:', e));
              }
            });
          }
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ingested: events.length }));
        return;
      }

      // GET /api/errors
      if (url === '/api/errors' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        // sessionsAffected Set -> JSON 友好（数量 + 数组）
        const groups = store.errorGroupsList().map(g => ({
          ...g,
          affectedSessions: g.sessionsAffected.size,
          sessionsAffected: undefined,
        }));
        res.end(JSON.stringify({ groups }));
        return;
      }

      // GET /api/errors/trend
      if (url === '/api/errors/trend' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ trend: store.errorTrend() }));
        return;
      }

      // GET /api/errors/stats（按 subType 分布）
      if (url === '/api/errors/stats' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ stats: store.errorStats() }));
        return;
      }

      // GET /api/releases（release 分桶）
      if (url === '/api/releases' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ releases: store.releaseBreakdown() }));
        return;
      }

      // GET /api/errors/:fp
      const errMatch = url.match(/^\/api\/errors\/([^/]+)$/);
      if (errMatch && method === 'GET') {
        const fp = decodeURIComponent(errMatch[1]);
        const group = store.errorGroup(fp);
        const events = store.eventsForFingerprint(fp);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ group, events }));
        return;
      }

      // GET /api/vitals
      if (url === '/api/vitals' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ vitals: store.vitalsAggregation() }));
        return;
      }

      // GET /api/sessions
      if (url === '/api/sessions' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ sessions: store.sessionsList() }));
        return;
      }

      // GET /api/health - 平台自检（稳定性：随时能看是否健康）
      if (url === '/api/health' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        const totalEvents = store.recentEvents(9999).length;
        const errorGroups = store.errorGroupsList().length;
        const sessions = store.sessionsList().length;
        const aiPending = store.errorGroupsList().filter(g => g.aiDiagnosisPending).length;
        res.end(JSON.stringify({
          ok: true,
          uptime: process.uptime(),
          events: totalEvents,
          errorGroups,
          sessions,
          aiDiagnosisPending: aiPending,
        }));
        return;
      }

      // POST /api/sourcemaps/upload - 上传 .map（body 为 map 文本；query: appId/version/filename）
      if (url.startsWith('/api/sourcemaps/upload') && method === 'POST') {
        const u = new URL(url, 'http://x');
        const appId = u.searchParams.get('appId') ?? 'default';
        const version = u.searchParams.get('version') ?? 'latest';
        const filename = u.searchParams.get('filename') ?? 'bundle.js';
        const content = await readBody(req);
        const stored = sourcemaps.save(appId, version, filename, content);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, stored }));
        return;
      }

      // POST /api/sourcemaps/resolve - 还原压缩栈（body: {appId, version, stack}）
      if (url === '/api/sourcemaps/resolve' && method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}') as { appId?: string; version?: string; stack?: string };
        const frames = sourcemaps.resolveStack(b.appId ?? 'default', b.version ?? 'latest', b.stack ?? '');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ frames }));
        return;
      }

      // GET / - dashboard（React 面板优先，否则内置简单 HTML）
      if (url === '/' && method === 'GET') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (opts.dashboardFile) {
          try {
            const fs = await import('node:fs');
            res.end(fs.readFileSync(opts.dashboardFile, 'utf-8'));
            return;
          } catch { /* 降级到内置 HTML */ }
        }
        res.end(dashboardHtml);
        return;
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'not found' }));
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  server.listen(port, host);

  return {
    server,
    store,
    close: () => new Promise((resolve) => { server.close(() => { persister?.close(); resolve(); }); }),
  };
}

/**
 * 自动 AI 诊断（后台触发）。fire-and-forget，错误流即用 @monit/repair-agent chat 调 LLM 出诊断+修复建议。
 * 失败不影响 ingest。
 *
 * 鲁棒性：LLM 可能不严格遵循 ===DIAGNOSIS===/===FIX=== 格式。优先结构化解析；
 * 解析结果过短或无标记时，兜底用原始 LLM 输出（confidence 标低），不静默丢。
 */
async function runAiDiagnosis(
  llmConfig: LLMConfig,
  g: ErrorGroup,
): Promise<{ diagnosis: string; suggestedFix: string; confidence: number; ts: number; formatMatched: boolean } | null> {
  try {
    const payload = g.sample.payload as { message?: string; stack?: string };
    const userPrompt = `你是资深前端工程师。诊断以下错误并给出最小修复建议（2-3 句）。

错误: ${payload?.message ?? '未知'}
${payload?.stack ? `栈: ${payload.stack.slice(0, 600)}` : ''}

严格用以下格式输出（不要其他内容）：
===DIAGNOSIS===
<根因>
===FIX===
<最小修复>`;

    const res = await chat(llmConfig, [
      { role: 'system', content: '只输出 ===DIAGNOSIS=== 和 ===FIX=== 两段。基于堆栈，不复述问题。' },
      { role: 'user', content: userPrompt },
    ]);

    const d = res.content.match(/===DIAGNOSIS===\s*([\s\S]*?)(?:===FIX===|$)/i)?.[1]?.trim() ?? '';
    const f = res.content.match(/===FIX===\s*([\s\S]*?)$/i)?.[1]?.trim() ?? '';
    const formatMatched = d.length >= 8 && f.length >= 4;

    // 兜底：格式不匹配时，用原始 LLM 输出作为诊断（标低置信，不静默丢）
    const diagnosis = formatMatched
      ? d
      : (res.content.trim().slice(0, 300) || '(LLM 无输出)');
    const suggestedFix = formatMatched ? f : '(未按格式输出，请人工审查)';

    return {
      diagnosis,
      suggestedFix,
      confidence: formatMatched ? 0.7 : 0.4,
      ts: Date.now(),
      formatMatched,
    };
  } catch {
    return null;
  }
}