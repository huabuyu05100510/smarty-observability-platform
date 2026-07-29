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
import { EventStore } from './store';
import { SourcemapStore } from './sourcemap';
import { SqlitePersister } from './persist';
import { dashboardHtml } from './dashboard';

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