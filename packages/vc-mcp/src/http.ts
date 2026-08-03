// http.ts · localhost findings 接收器(node:http,loopback only)
// ----------------------------------------------------------------------------
// 扩展(MV3 sidepanel/background)经 fetch POST 把 findings 推到这里;stdio MCP(agent)读出。
// 两者同进程:HTTP listener 与 MCP stdio 并发跑,共享 store 文件。
//
// 安全:
//   - 绑 127.0.0.1 + 显式 peer 校验(defense-in-depth,非 loopback 一律 403)。
//   - 写操作(POST/DELETE)可选 Bearer token(VC_SIDECAR_TOKEN);不配则仅靠 loopback 边界。
//   - body cap 2MB(findings 几 KB,超即 413,挡异常/恶意灌库)。
//   - id/createdAt 服务端分配(makeFinding),绝不信任客户端 —— 扩展是浏览器侧可被改。
import http from 'node:http';
import { appendFinding, clearFindings, loadFindings, makeFinding, type VcFinding } from './store';

export interface HttpReceiverOpts {
  port: number;
  host: string;
  storePath: string;
  token?: string;
}
export interface HttpReceiver {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function startHttpReceiver(opts: HttpReceiverOpts): Promise<HttpReceiver> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => handle(req, res, opts, startedAt));
    server.on('error', reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: HttpReceiverOpts, startedAt: number) {
  const peer = req.socket.remoteAddress || '';
  if (!LOOPBACK.has(peer)) {
    return json(res, 403, { error: 'non-loopback peer rejected' });
  }
  const url = (req.url || '').split('?')[0];
  const method = req.method || 'GET';
  const send = (code: number, body: unknown) => json(res, code, body);

  if (method === 'GET' && url === '/health') {
    return send(200, { ok: true, uptime: Date.now() - startedAt, count: loadFindings(opts.storePath).length });
  }

  // 写操作鉴权(若配了 token)
  if (opts.token) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${opts.token}`) return send(401, { error: 'unauthorized' });
  }

  if (method === 'DELETE' && url === '/findings') {
    clearFindings(opts.storePath);
    return send(200, { ok: true });
  }

  if (method === 'POST' && url === '/findings') {
    return readBody(req, (err, data) => {
      if (err) return send(err.code, { error: err.message });
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return send(400, { error: 'invalid json' });
      }
      const v = validateFinding(parsed);
      if (!v.ok) return send(400, { error: v.error });
      const finding = makeFinding(v.value);
      appendFinding(opts.storePath, finding);
      return send(201, { ok: true, id: finding.id });
    });
  }

  return send(404, { error: 'not found' });
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, cb: (err: { code: number; message: string } | null, data: string) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  const finish = (err: { code: number; message: string } | null, data: string) => {
    if (done) return;
    done = true;
    cb(err, data);
  };
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) {
      req.destroy();
      finish({ code: 413, message: 'body too large (>2MB)' }, '');
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => finish({ code: 400, message: String((e as Error).message || e) }, ''));
}

/** 最小形状校验:diff.{search,replace} 为字符串 + targets[] ≥1 且每项 {file,search,replace}。 */
function validateFinding(p: unknown): { ok: true; value: Partial<VcFinding> } | { ok: false; error: string } {
  if (!p || typeof p !== 'object') return { ok: false, error: 'payload not object' };
  const o = p as Record<string, unknown>;
  const diff = o.diff;
  if (!diff || typeof diff !== 'object') return { ok: false, error: 'diff.{search,replace} required' };
  const d = diff as Record<string, unknown>;
  if (typeof d.search !== 'string' || typeof d.replace !== 'string') return { ok: false, error: 'diff.{search,replace} required' };
  const targets = o.targets;
  if (!Array.isArray(targets) || targets.length === 0) return { ok: false, error: 'targets[] required (>=1)' };
  for (const t of targets) {
    if (!t || typeof t !== 'object') return { ok: false, error: 'target.{file,search,replace} required' };
    const tg = t as Record<string, unknown>;
    if (typeof tg.file !== 'string' || typeof tg.search !== 'string' || typeof tg.replace !== 'string') {
      return { ok: false, error: 'target.{file,search,replace} required' };
    }
  }
  return { ok: true, value: o as Partial<VcFinding> };
}
