/**
 * 代表作留痕：真实跑通极致闭环单漏斗（diagnose -> verify -> repro 红转绿 -> gate -> 真 PR）。
 *
 * 用法：node scripts/showcase-record.mjs
 * 消耗：少量 ARK 额度 + 向 config/github.config.json 的 repo 真开一个 PR。
 *
 * 诚实标注：
 * - Verifier 与 Diagnoser 用【跨 provider 不同模型】（ARK doubao-seed 作 Diagnoser，MiniMax 作 Verifier）=
 *   真·独立对抗验证（BP-2 最强形式，异 provider 独立性 > 同 provider 异模型 > 同模型）。
 * - repro 测试由 LLM 生成，须在 buggy 代码上 FAIL、补丁后 PASS（BP-3）。
 * - 交付由 GateVector 决定（BP-4）：auto-mr -> 真 PR；hotfix -> 可回滚句柄；human -> 不自动。
 *
 * Provider 配置（均 gitignore）：config/llm.config.json(ARK doubao) / llm.minimax.json / llm.zhipu.json
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runRealHealPipeline } from '../packages/coordinator/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const llm = JSON.parse(readFileSync(join(ROOT, 'config', 'llm.config.json'), 'utf-8'));
const gh = JSON.parse(readFileSync(join(ROOT, 'config', 'github.config.json'), 'utf-8'));
const repoRoot = join(ROOT, 'showcase', 'fixture-repo');
const srcPath = join(repoRoot, 'src', 'renderList.js');
const originalSrc = readFileSync(srcPath, 'utf-8');

const toCfg = (c) => ({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, temperature: c.temperature ?? 0.2, provider: c.provider ?? 'openai' });

const diagnoserConfig = toCfg(llm); // ARK doubao-seed（code 模型，擅长代码诊断+补丁）

// 跨 provider 独立 Verifier：优先 MiniMax，回退智谱，再回退同模型（honest downgrade）
let verifierConfig = diagnoserConfig;
let verifierLabel = `${diagnoserConfig.model}（同模型，诚实降级）`;
try {
  const mm = JSON.parse(readFileSync(join(ROOT, 'config', 'llm.minimax.json'), 'utf-8'));
  verifierConfig = toCfg(mm);
  verifierLabel = `${mm.model} @ MiniMax（跨 provider 独立）`;
} catch {
  try {
    const zp = JSON.parse(readFileSync(join(ROOT, 'config', 'llm.zhipu.json'), 'utf-8'));
    verifierConfig = toCfg(zp);
    verifierLabel = `${zp.model} @ 智谱（跨 provider 独立）`;
  } catch { /* 同模型降级 */ }
}

const symptom = "TypeError: Cannot read properties of null (reading 'map') — renderList 在 API 返回 null 时崩溃（src/renderList.js）";
const stack = "TypeError: Cannot read properties of null (reading 'map')\n    at renderList (src/renderList.js:5:16)\n    at onLoad (app.js:22:9)";

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║  代表作留痕：极致闭环单漏斗真实运行                              ║');
console.log('║  diagnose -> verify -> repro(红转绿) -> gate -> 真 PR          ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`diagnoser: ${diagnoserConfig.provider} / ${diagnoserConfig.model}`);
console.log(`verifier:  ${verifierLabel}`);
console.log(`github:    ${gh.repo}`);
console.log('');

const result = await runRealHealPipeline({
  repoRoot,
  diagnoserConfig,
  verifierConfig,
  symptom,
  stack,
  focusFiles: [{ path: 'src/renderList.js', content: originalSrc }],
  goldPatches: ['function totallyUnrelatedGoldPatch(){return 42;}'],
  githubConfig: { token: gh.token, repo: gh.repo },
  behaviorPreserving: false,
  maxAttempts: 3,
  onLog: (m) => console.log('  ' + m),
});

// 清理：恢复 fixture buggy 源（保证可重复），删 LLM 生成的 repro 测试文件
try { writeFileSync(srcPath, originalSrc); } catch {}
try {
  for (const f of readdirSync(join(repoRoot, 'src'))) {
    if (f.includes('repro') && f.endsWith('.test.js')) unlinkSync(join(repoRoot, 'src', f));
  }
  if (existsSync(join(repoRoot, '__monit_repro__.test.js'))) unlinkSync(join(repoRoot, '__monit_repro__.test.js'));
} catch {}

const summary = {
  resolved: result.resolved,
  attempts: result.attempts,
  delivery: result.decision?.delivery ?? null,
  gate: result.decision?.gate ?? null,
  reasons: result.decision?.reasons ?? [],
  repro: result.repro ? { testName: result.repro.testName, redBefore: result.repro.redBefore, greenAfter: result.repro.greenAfter, filePath: result.repro.filePath } : null,
  verifier: result.verifier ? { refuted: result.verifier.refuted, reason: result.verifier.reason, confidence: result.verifier.confidence } : null,
  pr: (result.delivery && result.delivery?.prUrl) ? result.delivery : (result.delivery?.ok ? result.delivery : null),
  diagnosis: result.diagnosis?.rootCause ?? null,
};

console.log('\n══════════════ 留痕结果 ══════════════');
console.log(JSON.stringify(summary, null, 2));

// 落盘留痕 markdown
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const mdPath = join(ROOT, 'showcase', `run-${ts}.md`);
const md = [
  `# 极致闭环留痕 · ${ts}`,
  '',
  `**交付**: ${summary.delivery}`,
  `**resolved**: ${summary.resolved}（attempts=${summary.attempts}）`,
  '',
  '## GateVector',
  '```json',
  JSON.stringify(summary.gate, null, 2),
  '```',
  '',
  '## Verifier（反事实验证）',
  '```json',
  JSON.stringify(summary.verifier, null, 2),
  '```',
  '> 诚实标注：Verifier 与 Diagnoser 同模型（ARK key /api/plan 仅 1 模型支持 agent-plan）。架构已就绪，换 verifierConfig.model 即真·独立对抗。',
  '',
  '## Repro 测试（红转绿）',
  '```json',
  JSON.stringify(summary.repro, null, 2),
  '```',
  '',
  '## 诊断根因',
  summary.diagnosis,
  '',
  '## PR / 交付',
  summary.pr ? ('```json\n' + JSON.stringify(summary.pr, null, 2) + '\n```') : '_无（delivery 非 auto-mr 或未配 github）_',
  '',
  '## 门禁理由',
  ...(summary.reasons.map(r => `- ${r}`)),
].join('\n');
writeFileSync(mdPath, md);
console.log(`\n留痕已写入: ${mdPath}`);
