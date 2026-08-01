/**
 * @monit/backend/demo-heal - 自愈闭环【demo 轨】（stub LLM + 真实 gate 逻辑）
 *
 * 不调真 LLM：diagnose / verify / generateReproTest 注入确定性 canned 值；
 * 但 applyPatch / runReproTest / runSuite / assessGate 全走真实 fs + vitest + 真门禁。
 *  -> 演示的是"确定性门禁真在跑"（repro 红转绿、套件不破、GateVector 分流都是真的），
 *     只有 LLM 语义部分是 stub。清晰标注 demo · stub LLM。
 *
 * 目标 bug：showcase/fixture-repo/src/renderList.js（items 为 null 时 .map 抛 TypeError）。
 * 运行后【总是恢复】fixture 原状（可重复演示），auto-mr 不真开 PR（返 demo prUrl）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  runHealPipeline,
  type Diagnosis,
  type HealPipelineResult,
  type ReproRunResult,
  type ReproTestCode,
  type ApplyResult,
  type DeliveryResult,
  type DiagnosisInput,
} from '@monit/repair-agent';
import type { VerifierResult, HealDecision, ReproTest, PrResult } from '@monit/contracts';

function fixtureRoot(): string {
  // 后端从仓库根启动（scripts/start-platform.mjs / start-backend.mjs）
  const cwd = resolve(process.cwd(), 'showcase', 'fixture-repo');
  if (existsSync(join(cwd, 'src', 'renderList.js'))) return cwd;
  // 兜底：相对本模块（dist/demo-heal.js -> ../../../showcase/fixture-repo）
  return resolve(new URL('../../../showcase/fixture-repo', import.meta.url).pathname);
}

const REPRO_FILE = '__monit_repro__.test.js';
const SEARCH = 'items.map((x) =>';
const REPLACE = '(items || []).map((x) =>';

const REPRO_CODE = `import { test, expect } from 'vitest';
import { renderList } from './src/renderList.js';
// 须【断言失败】而非抛错（redBefore=fail-assertion 才算有效复现）-> catch 后断言结果
test('renderList handles null without throwing', () => {
  let result;
  try { result = renderList(null); } catch (e) { result = 'THREW: ' + e.message; }
  expect(result).toEqual([]);
});
`;

const ASSERTION_RE = /AssertionError|Expected|Received|\.toBe|\.toEqual|\.toBeTruthy|\.toBeFalsy|\.toBeNull|expect\(|assert\s*\(/;

interface DemoDiagnosis {
  rootCause: string;
  evidence: string[];
  patch: { patchType: string; targetPath: string };
  __demoPatch: { filePath: string; searchCode: string; replaceCode: string };
}

/** 解析 vitest --reporter=json：区分断言失败 vs 无关错误。*/
function parseVitest(stdout: string): { status: ReproRunResult['status']; msg?: string } {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return { status: 'fail-error', msg: 'unparseable' };
  let data: { testResults?: Array<{ assertionResults?: Array<{ status?: string; failureMessages?: string[] }> }> };
  try { data = JSON.parse(stdout.slice(start, end + 1)); } catch { return { status: 'fail-error', msg: 'parse-fail' }; }
  for (const tr of data.testResults ?? []) {
    for (const ar of tr.assertionResults ?? []) {
      if (ar.status === 'failed') {
        const msgs = (ar.failureMessages ?? []).join('\n');
        return ASSERTION_RE.test(msgs) ? { status: 'fail-assertion', msg: msgs.slice(0, 200) } : { status: 'fail-error', msg: msgs.slice(0, 200) };
      }
    }
  }
  return { status: 'pass' };
}

function runVitest(args: string[], timeoutMs: number): { ok: boolean; stdout: string; timedOut: boolean } {
  try {
    const stdout = execFileSync('npx', ['--no-install', 'vitest', ...args], {
      cwd: fixtureRoot(), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf-8', env: { ...process.env, CI: '1' },
    });
    return { ok: true, stdout, timedOut: false };
  } catch (e) {
    const err = e as { stdout?: string; killed?: boolean; signal?: string | null; message?: string };
    if (err.killed || err.signal === 'SIGTERM' || /timed out|TIMEDOUT/i.test(err.message ?? '')) return { ok: false, stdout: '', timedOut: true };
    return { ok: false, stdout: typeof err.stdout === 'string' ? err.stdout : '', timedOut: false };
  }
}

export interface DemoHealResult {
  track: 'demo';
  note: string;
  result: HealPipelineResult;
  stages: Array<{ stage: string; status: string; detail?: string }>;
}

/**
 * 跑 demo 自愈漏斗。onLog 收集阶段日志（供 UI 逐步展示）。
 */
export async function runDemoHeal(onLog?: (m: string) => void): Promise<DemoHealResult> {
  const log = onLog ?? (() => {});
  const root = fixtureRoot();
  const srcPath = join(root, 'src', 'renderList.js');
  const reproPath = join(root, REPRO_FILE);
  const original = readFileSync(srcPath, 'utf-8');
  let patchApplied = false;
  const stages: DemoHealResult['stages'] = [];

  const revert = async (): Promise<void> => {
    if (patchApplied) { try { writeFileSync(srcPath, original); } catch { /* ignore */ } patchApplied = false; }
    try { if (existsSync(reproPath)) unlinkSync(reproPath); } catch { /* ignore */ }
  };

  try {
    const result = await runHealPipeline({
      symptom: "TypeError: Cannot read properties of null (reading 'map') - renderList 在 API 返回 null 时崩溃",
      behaviorPreserving: false,
      contamination: 'clean',
      maxAttempts: 2,
      regressionReplays: 2,
      onLog: log,

      // 1. diagnose（stub）：canned 空值守卫补丁
      diagnose: async (): Promise<Diagnosis | null> => {
        const d: DemoDiagnosis = {
          rootCause: 'renderList 在 items 为 null 时调用 .map 抛 TypeError；缺少空值守卫。需在 .map 前加 (items || []) 兜底。',
          evidence: ['stack: renderList (src/renderList.js:3)', 'items.map 在 null 上解引用', '症状：API 返回 null 时崩溃'],
          patch: { patchType: 'replace', targetPath: 'src/renderList.js' },
          __demoPatch: { filePath: 'src/renderList.js', searchCode: SEARCH, replaceCode: REPLACE },
        };
        return d as unknown as Diagnosis;
      },

      // 2. verify（stub）：反事实接受（null deref @ .map 已确认；守卫加在 cited frame 合法）
      verify: async (_input: DiagnosisInput): Promise<VerifierResult> => ({
        refuted: false,
        reason: '反事实：若 items 为 null 是真因，renderList(null) 必抛 TypeError（已证）。补丁在 cited frame（.map 调用处）加空值守卫，非异地 masking，接受。',
        confidence: 0.9,
      }),

      // 3. generateReproTest（stub）：canned 复现测试（null 输入须返回 []）
      generateReproTest: async (): Promise<ReproTestCode | null> => ({
        filePath: REPRO_FILE, testName: 'renderList handles null without throwing', code: REPRO_CODE,
      }),

      // 4. runReproTest（真实 vitest）：patched=false 须 fail-assertion，patched=true 须 pass
      runReproTest: async (_code: ReproTestCode, patched: boolean): Promise<ReproRunResult> => {
        try { writeFileSync(reproPath, REPRO_CODE); } catch { return { status: 'fail-error', message: 'write failed' }; }
        const r = runVitest(['run', reproPath, '--reporter=json'], 60_000);
        if (r.timedOut) return { status: 'timeout', message: 'vitest timeout' };
        if (r.ok) return { status: 'pass' };
        const p = parseVitest(r.stdout);
        return patched ? { status: 'fail-error', message: p.msg ?? 'unexpected fail after patch' } : p;
      },

      // applyPatch（真实 fs）：searchCode 校验 + 写盘
      applyPatch: async (diag): Promise<ApplyResult> => {
        const d = (diag as unknown as { __demoPatch?: { searchCode: string; replaceCode: string } }).__demoPatch;
        if (!d) return { applied: false, filesChanged: 0, linesChanged: 0, error: 'no demo patch' };
        const src = readFileSync(srcPath, 'utf-8');
        if (!src.includes(d.searchCode)) return { applied: false, filesChanged: 0, linesChanged: 0, error: 'searchCode 不存在（防幻觉）' };
        writeFileSync(srcPath, src.replace(d.searchCode, d.replaceCode));
        patchApplied = true;
        return { applied: true, filesChanged: 1, linesChanged: 3 };
      },

      revertPatch: async () => { await revert(); },

      // 5. runSuite（真实 vitest）：现有套件不破（排除 repro 文件）
      runSuite: async (): Promise<boolean> => {
        const r = runVitest(['run', '--exclude=**/__monit_repro__*', '--reporter=default'], 120_000);
        return r.ok;
      },

      // 6. typecheck（JS repo 无 tsconfig -> 视为通过）
      typecheck: async (): Promise<boolean> => true,

      // 8. deliver：auto-mr -> 返 demo prUrl（不真开 PR，避免每次演示刷 PR）
      deliver: async (decision: HealDecision): Promise<DeliveryResult> => {
        if (decision.delivery === 'auto-mr') {
          const pr: PrResult = { ok: true, branch: 'fix/smarty-demo-' + Date.now().toString(36), prUrl: 'https://github.com/huabuyu05100510/monit-self-heal-test/pull/3 (demo · 未真开)' };
          return pr;
        }
        return null;
      },
    });

    // 构造阶段摘要（供 UI 逐步展示）
    stages.push(
      { stage: '1. Diagnose', status: result.diagnosis ? 'done' : 'fail', detail: result.diagnosis?.rootCause.slice(0, 120) },
      { stage: '2. Verifier（反事实）', status: result.verifier ? (result.verifier.refuted ? 'refuted' : 'accepted') : 'skipped', detail: result.verifier ? `conf ${(result.verifier.confidence * 100) | 0}%` : undefined },
      { stage: '3. Repro（红转绿）', status: result.repro ? (result.repro.redBefore && result.repro.greenAfter ? 'red→green' : 'invalid') : 'fail', detail: result.repro ? `red=${result.repro.redBefore} green=${result.repro.greenAfter}` : undefined },
      { stage: '4. 回归投票', status: result.regressionVotes ? 'done' : 'skip', detail: result.regressionVotes ? `repro ${result.regressionVotes.reproPasses}/${result.regressionVotes.replays}, suite ${result.regressionVotes.suitePasses}/${result.regressionVotes.replays}` : undefined },
      { stage: '5. GateVector', status: result.decision?.delivery ?? 'human', detail: result.decision?.reasons[0]?.slice(0, 120) },
    );

    return { track: 'demo', note: 'demo · stub LLM（diagnose/verify/repro 为 canned；applyPatch/回归/GateVector 走真实 fs+vitest+门禁）', result, stages };
  } finally {
    await revert(); // 总是恢复 fixture，保证可重复演示
  }
}
