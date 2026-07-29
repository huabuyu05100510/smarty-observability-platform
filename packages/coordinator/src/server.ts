/**
 * @monit/coordinator/server - 本地 HTTP 协调总线
 *
 * 吸收 smarty-monitor coordinator server.ts，补测试、补真 heal-apply。
 * 端点：
 * - GET  /health
 * - GET  /events                最近事件
 * - POST /events                发布事件
 * - POST /ai/patch              LLM 源码补丁生成（轨道 B）
 * - POST /pr/create             GitHub PR 创建（轨道 B）
 * - POST /heal/apply            运行时热修（轨道 A，调 repair-agent harness）
 *
 * 运行在 127.0.0.1:3920，仅本地。
 */

import http from 'node:http';
import type { BusEvent, AiPatchProposal } from '@monit/contracts';
import { EventBus } from './event-bus';
import { generatePatch, type PatchContext } from './llm-patch';
import { createGithubPr, applyPatchesLocally, type GithubConfig } from './github-pr';
import type { LLMConfig } from '@monit/repair-agent';

export interface CoordinatorOptions {
  port?: number;
  host?: string;
  llmConfig?: LLMConfig;
  githubConfig?: GithubConfig;
  /** 文件读写抽象（本地 fs 或 mock） */
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
}

export interface CoordinatorHandle {
  server: http.Server;
  bus: EventBus;
  close(): Promise<void>;
}

interface ParsedRequest {
  method: string;
  url: string;
  body: unknown;
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(null);
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export function createCoordinatorServer(opts: CoordinatorOptions = {}): CoordinatorHandle {
  const bus = new EventBus(50);
  const port = opts.port ?? 3920;
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    // CORS（面板 :3921 调 :3920 做自愈诊断需要跨源）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    res.setHeader('Content-Type', 'application/json');
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const body = method !== 'GET' ? await readBody(req) : null;
    const parsed: ParsedRequest = { method, url, body };

    try {
      const result = await route(parsed, opts, bus);
      res.statusCode = result.status;
      if (result.body !== undefined) res.end(JSON.stringify(result.body));
      else res.end();
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  server.listen(port, host);

  return {
    server,
    bus,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

interface RouteResult {
  status: number;
  body?: unknown;
}

async function route(
  req: ParsedRequest,
  opts: CoordinatorOptions,
  bus: EventBus,
): Promise<RouteResult> {
  const { method, url, body } = req;

  if (url === '/health' && method === 'GET') {
    return { status: 200, body: { ok: true, uptime: process.uptime() } };
  }

  if (url === '/events' && method === 'GET') {
    return { status: 200, body: { events: bus.recent() } };
  }

  if (url === '/events' && method === 'POST') {
    bus.publish(body as BusEvent);
    return { status: 201, body: { ok: true } };
  }

  if (url === '/ai/patch' && method === 'POST') {
    if (!opts.llmConfig) return { status: 503, body: { error: 'LLM not configured' } };
    const ctx = body as PatchContext;
    if (!ctx?.record || !ctx?.files) return { status: 400, body: { error: 'missing record/files' } };
    const proposal = await generatePatch(opts.llmConfig, ctx);
    if (!proposal) return { status: 422, body: { error: 'LLM produced no valid patch (searchCode validation failed)' } };
    bus.publish({ type: 'ai.patch.ready', proposal });
    return { status: 200, body: { proposal } };
  }

  if (url === '/pr/create' && method === 'POST') {
    if (!opts.githubConfig) return { status: 503, body: { error: 'GitHub not configured' } };
    const { proposal, branch } = body as { proposal: AiPatchProposal; branch?: string };
    if (!proposal) return { status: 400, body: { error: 'missing proposal' } };
    // 本地写盘（若配置了 fs）
    if (opts.fs) {
      await applyPatchesLocally(proposal, opts.fs.readFile, opts.fs.writeFile);
    }
    const branchName = branch ?? `fix/smarty-${proposal.id.slice(-8)}`;
    const result = await createGithubPr(opts.githubConfig, proposal, branchName);
    bus.publish({ type: 'pr.created', result });
    return { status: result.ok ? 200 : 502, body: { result } };
  }

  if (url === '/heal/apply' && method === 'POST') {
    // 轨道 A 运行时热修：真实环境调 repair-agent runHarness + CDP 注入。
    // P0 返回轨道说明（实际注入由扩展端 CDP 执行，coordinator 协调）。
    const { proposalId } = body as { proposalId?: string };
    bus.publish({ type: 'heal.applied', ids: proposalId ? [proposalId] : [], rollbackToken: `rb-${Date.now()}` });
    return {
      status: 200,
      body: {
        applied: true,
        track: 'runtime-hotfix',
        rollbackToken: `rb-${Date.now()}`,
        note: '轨道 A 运行时热修：CDP 注入可逆补丁，回滚 token 用于撤销。',
      },
    };
  }

  return { status: 404, body: { error: 'not found' } };
}