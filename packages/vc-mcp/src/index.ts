#!/usr/bin/env node
// index.ts · vc-mcp 入口
// ----------------------------------------------------------------------------
// 同进程跑两件事:
//   1) HTTP receiver(127.0.0.1):扩展 fetch POST 推 findings → 落盘
//   2) stdio MCP(Claude Code 启动):agent 调 tool 读 findings + dry-run apply 到真实仓库
// 注册:claude mcp add vc -- node <abs>/packages/vc-mcp/dist/index.js
// 日志走 stderr(stdout 留给 MCP 协议)。
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import os from 'node:os';
import path from 'node:path';
import { startHttpReceiver } from './http';
import { dryRunApply } from './apply';
import { loadFindings, latest, clearFindings } from './store';

const PORT = Number(process.env.VC_PORT ?? 7777);
const HOST = process.env.VC_HOST ?? '127.0.0.1';
const STORE_PATH = process.env.VC_STORE ?? path.join(os.tmpdir(), 'vc-mcp-findings.json');
const TOKEN = process.env.VC_SIDECAR_TOKEN;

const TOOL_LIST = [
  {
    name: 'vc_get_findings',
    description: '取扩展端最新一条 AI 自愈 findings(根因 + search/replace 补丁 + 目标文件 + 验证裁决)。传 id 取指定条。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '指定 findings id;缺省取最新' } }, additionalProperties: false },
  },
  {
    name: 'vc_list_findings',
    description: '列最近 N 条 findings(默认 10)。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 10 } }, additionalProperties: false },
  },
  {
    name: 'vc_apply_diff',
    description: 'DRY-RUN:把 findings 的 search/replace 补丁写到真实仓库工作树(归一路径 + 幻觉守卫),返回 per-file 状态 + unified diff + MR 草稿。不 commit/push,无 token。随后 agent 跑测试 + (人确认后)git commit + gh pr create。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '指定 findings id;缺省取最新' },
        repoRoot: { type: 'string', description: '仓库根(缺省 process.cwd())' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'vc_clear_findings',
    description: '清空 findings 缓冲。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function main() {
  const http = await startHttpReceiver({ port: PORT, host: HOST, storePath: STORE_PATH, token: TOKEN });
  console.error(`[vc-mcp] HTTP receiver on http://${HOST}:${http.port}/findings (store: ${STORE_PATH}${TOKEN ? ', token: on' : ''})`);

  const server = new Server({ name: 'vc-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_LIST }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      if (name === 'vc_get_findings') {
        const items = loadFindings(STORE_PATH);
        const f = typeof args.id === 'string' ? items.find((x) => x.id === args.id) ?? null : latest(items);
        if (!f) return err('no findings');
        return ok(f);
      }
      if (name === 'vc_list_findings') {
        const limit = typeof args.limit === 'number' ? args.limit : 10;
        return ok(loadFindings(STORE_PATH).slice(-limit));
      }
      if (name === 'vc_apply_diff') {
        const items = loadFindings(STORE_PATH);
        const f = typeof args.id === 'string' ? items.find((x) => x.id === args.id) ?? null : latest(items);
        if (!f) return err('no findings to apply (扩展尚未推送,或已清空)');
        const repoRoot = typeof args.repoRoot === 'string' ? args.repoRoot : process.cwd();
        const res = await dryRunApply(f, repoRoot);
        return ok(res);
      }
      if (name === 'vc_clear_findings') {
        clearFindings(STORE_PATH);
        return ok({ cleared: true });
      }
      return err(`unknown tool: ${name}`);
    } catch (e) {
      return err(String((e as Error).message || e));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio transport + http server 共同 hold 事件循环;客户端断开 stdio → transport 关 → 进程退出
}

function ok(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}
function err(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true };
}

main().catch((e) => {
  console.error('[vc-mcp] fatal:', e);
  process.exit(1);
});
