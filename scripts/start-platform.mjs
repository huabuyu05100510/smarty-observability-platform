/**
 * 一键启动整个平台：backend（数据面/面板）+ coordinator（自愈，接 LLM）。
 * 用法：node scripts/start-platform.mjs
 * LLM 配置从 config/llm.config.json 读取（写死、gitignore）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createBackendServer } from '../packages/backend/dist/index.js';
import { createCoordinatorServer } from '../packages/coordinator/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(__dirname, '..', 'config', 'llm.config.json');

let llmCfg;
try {
  llmCfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
} catch {
  console.error(`\n✗ 读不到 ${cfgPath}\n  请确认 config/llm.config.json 存在（含 baseUrl/apiKey/model）。\n`);
  process.exit(1);
}

const llmConfig = {
  baseUrl: llmCfg.baseUrl,
  apiKey: llmCfg.apiKey,
  model: llmCfg.model,
  temperature: llmCfg.temperature ?? 0.2,
};

// 1. backend（数据面 + 面板 + JSONL 持久化）
const backend = createBackendServer({ port: 3921, dbPath: './data/events.jsonl' });
// 2. coordinator（自愈 HTTP 总线，接 LLM）
const coordinator = createCoordinatorServer({ port: 3920, llmConfig });

await Promise.all([
  new Promise(r => backend.server.once('listening', r)),
  new Promise(r => coordinator.server.once('listening', r)),
]);

// 3. LLM preflight（确认 key/endpoint/model 可达）
let llmOk = 'unknown';
try {
  const res = await fetch(`${llmConfig.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: llmConfig.apiKey ? { Authorization: `Bearer ${llmConfig.apiKey}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  llmOk = res.ok ? '✓ 可达' : `✗ HTTP ${res.status}`;
} catch (e) {
  llmOk = `✗ ${e.message}`;
}

console.log(`
╔════════════════════════════════════════════════════════════╗
║   smarty-observability-platform 已启动                       ║
╠════════════════════════════════════════════════════════════╣
║  面板 / 数据面      http://127.0.0.1:3921                    ║
║    POST /api/events        ingest（collector 上报）          ║
║    GET  /api/errors        错误分组                          ║
║    GET  /api/vitals        Web Vitals p75/p99                ║
║    GET  /                  内置面板                          ║
║                                                              ║
║  自愈 coordinator    http://127.0.0.1:3920                    ║
║    POST /ai/patch           LLM 源码补丁生成                 ║
║    POST /heal/apply         运行时热修（轨道 A）             ║
║    POST /pr/create          GitHub PR（需配 githubConfig）   ║
║    GET  /events             事件总线                         ║
║                                                              ║
║  LLM: ${llmCfg.provider} / ${llmCfg.model}  ${llmOk.padEnd(20)}║
║       ${llmConfig.baseUrl.slice(0, 38).padEnd(38)}║
╚════════════════════════════════════════════════════════════╝

  Ctrl+C 退出
`);

process.on('SIGINT', () => {
  Promise.all([backend.close(), coordinator.close()]).then(() => process.exit(0));
});
