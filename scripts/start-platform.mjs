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

// 可选 GitHub 配置（自愈 PR 真打通用，gitignore 不入 git）
let ghCfg = null;
const ghPath = join(__dirname, '..', 'config', 'github.config.json');
try {
  const gh = JSON.parse(readFileSync(ghPath, 'utf-8'));
  if (gh.token && gh.repo && !gh.repo.startsWith('REPLACE')) ghCfg = gh;
} catch { /* github config 可选 */ }

const llmConfig = {
  baseUrl: llmCfg.baseUrl,
  apiKey: llmCfg.apiKey,
  model: llmCfg.model,
  temperature: llmCfg.temperature ?? 0.2,
  provider: llmCfg.provider ?? 'openai',
};

// 1. backend（数据面 + React 面板 + JSONL 持久化 + 自动 AI 诊断 + 自愈 demo/strong 轨）
// 自愈配置：coordinator strong 轨需 repoRoot + 独立 verifierConfig + GitHub + authToken 齐备。
// 有 config/llm.minimax.json(+zhipu 回退) + github.config.json 才 strong-ready（真跨 provider Verifier + 真 PR）；
// 否则面板 /api/demo/heal 自动落 demo 轨（stub LLM + 真实 gate），不强求 key。
const fixtureRepo = join(__dirname, '..', 'showcase', 'fixture-repo');
let fixtureSource = '';
let fixtureTest = '';
try {
  fixtureSource = readFileSync(join(fixtureRepo, 'src', 'renderList.js'), 'utf-8');
  fixtureTest = readFileSync(join(fixtureRepo, 'src', 'renderList.test.js'), 'utf-8');
} catch { /* fixture 缺失不影响启动，仅 demo 轨无法跑 fs */ }

// 独立 verifier（跨 provider，BP-2）：优先 MiniMax，回退智谱
let verifierCfg = null;
try {
  const mm = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'llm.minimax.json'), 'utf-8'));
  verifierCfg = { baseUrl: mm.baseUrl, apiKey: mm.apiKey, model: mm.model, temperature: mm.temperature ?? 0.1, provider: mm.provider ?? 'openai' };
} catch {
  try {
    const zp = JSON.parse(readFileSync(join(__dirname, '..', 'config', 'llm.zhipu.json'), 'utf-8'));
    verifierCfg = { baseUrl: zp.baseUrl, apiKey: zp.apiKey, model: zp.model, temperature: zp.temperature ?? 0.1, provider: zp.provider ?? 'openai' };
  } catch { /* 无独立 verifier -> 非 strong-ready，走 demo 轨 */ }
}

const STRONG_TOKEN = process.env.MONIT_STRONG_TOKEN || 'monit-strong-demo';
const strongReady = !!verifierCfg && !!ghCfg && !!fixtureSource;

const autoHeal = {
  coordinatorUrl: 'http://127.0.0.1:3920',
  sourceFiles: [{ path: 'src/renderList.js', content: fixtureSource }],
  testFiles: [{ path: 'src/renderList.test.js', content: fixtureTest }],
  ...(strongReady ? { coordinatorToken: STRONG_TOKEN } : {}),
};
const backend = createBackendServer({
  port: 3921,
  dbPath: './data/events.jsonl',
  dashboardFile: join(__dirname, '..', 'platform', 'frontend', 'index.html'),
  llmConfig,
  autoHeal,
});
// 2. coordinator（自愈 HTTP 总线，接 LLM + 可选 GitHub + 独立 verifier + repoRoot）
const coordinator = createCoordinatorServer({
  port: 3920,
  llmConfig,
  verifierConfig: verifierCfg ?? undefined,
  repoRoot: strongReady ? fixtureRepo : undefined,
  githubConfig: ghCfg ?? undefined,
  authToken: strongReady ? STRONG_TOKEN : undefined,
});

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
