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
import { dashboardHtml } from './dashboard';

export interface BackendOptions {
  port?: number;
  host?: string;
  /** CORS origin（默认 *，本地） */
  corsOrigin?: string;
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
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, ingested: events.length }));
        return;
      }

      // GET /api/errors
      if (url === '/api/errors' && method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ groups: store.errorGroupsList() }));
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

      // GET / - dashboard
      if (url === '/' && method === 'GET') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}