/**
 * @monit/coordinator/heal-runner - 真实环境 heal pipeline 装配（代表作：把闭环从孤岛接进真链路）
 *
 * 把 repair-agent 的 runHealPipeline 单漏斗接到真实操作：
 * - diagnose：LLM（diagnoserConfig）出根因 + 补丁
 * - verify：独立模型 Verifier（verifierConfig，【强制】与 diagnoser 不同 model id，BP-2）
 * - generateReproTest：LLM 生成复现 bug 的失败测试
 * - runReproTest / runSuite：在 repoRoot 跑 vitest（结构化结果：区分 assertion 失败 vs 无关错误）
 * - applyPatch / revertPatch：fs 写盘 + 回滚（locality 用真实行 diff）
 * - typecheck：tsc --noEmit（有 tsconfig 时）
 * - contamination：detectContamination（真实 goldPatch 集）
 * - deliver：auto-mr -> createGithubPr；hotfix -> 返回 rollback 句柄
 *
 * 安全做实：
 * - 强制 verifier ≠ diagnoser model（独立对抗，运行时硬断言，不可绕过）。
 * - safeResolve 用 realpathSync 防 symlink 越界（monorepo/node_modules 软链常见）。
 * - 子进程一律 execFileSync（shell:false），消除命令注入；testFile 参数化不进 shell。
 * - locality(files/lines) 用真实 LCS 行 diff + distinct filePath，非自报。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, basename, join, resolve, relative, isAbsolute } from 'node:path';
import type { AiPatchProposal, HealDecision, PrResult, ReproTest } from '@monit/contracts';
import { runHealPipeline, type HealPipelineDeps, type ReproTestCode, type ApplyResult, type DeliveryResult, type ReproRunResult } from '@monit/repair-agent';
import { chatJson, type LLMConfig, type Diagnosis } from '@monit/repair-agent';
import { applyPatchesLocally, createGithubPr, type GithubConfig } from './github-pr';
import { detectContamination } from '@monit/guardrails';
import { countChangedLines } from '@monit/server-kit';

/**
 * 把仓库内相对路径解析为绝对路径，并拒绝越出 repoRoot 的 traversal（含 symlink 越界）。
 * join/resolve 本身不防越界 —— LLM 可控的 filePath 必须显式校验。
 * 用 realpathSync 解析已存在部分（新文件对其存在的最近父目录 realpath），防 symlink 逃逸。
 */
function safeResolve(repoRoot: string, rel: string): string | null {
  const abs = resolve(repoRoot, rel);
  let realRoot: string;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    return null;
  }
  // 上溯到已存在的最近祖先，对其 realpath（支持新建文件场景）
  let p = abs;
  const segs: string[] = [];
  while (p !== realRoot && !existsSync(p)) {
    segs.unshift(basename(p));
    p = dirname(p);
  }
  let realAncestor: string;
  try {
    realAncestor = realpathSync(p);
  } catch {
    return null;
  }
  const realAbs = segs.length ? resolve(realAncestor, ...segs) : realAncestor;
  const relToRoot = relative(realRoot, realAbs);
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot) || relToRoot === '') return null;
  return realAbs;
}

export interface HealRunnerOptions {
  /** 目标仓库根（写盘 + 跑测试 + git 回滚）*/
  repoRoot: string;
  /** Diagnoser LLM 配置 */
  diagnoserConfig: LLMConfig;
  /** Verifier LLM 配置（【强制】不同 model id，BP-2 独立对抗）*/
  verifierConfig: LLMConfig;
  /** 被诊断的错误/性能症状描述 */
  symptom: string;
  /** 错误栈（喂 diagnose + verifier）*/
  stack?: string;
  /** 改动锚点文件（diagnose 聚焦）*/
  focusFiles: Array<{ path: string; content: string }>;
  /** 自建回归集 gold patch（contamination 检测）*/
  goldPatches?: string[];
  /** GitHub 配置（auto-mr 开 PR）*/
  githubConfig?: GithubConfig;
  /** MR 轨（默认）vs 热修轨 */
  behaviorPreserving?: boolean;
  maxAttempts?: number;
  onLog?: (msg: string) => void;
}

const REPRO_SYSTEM_PROMPT = `You are a test-generation agent. Given a bug (symptom + stack + source), generate a MINIMAL vitest test that REPRODUCES the bug — i.e., the test MUST FAIL against the current (buggy) code and PASS once the bug is fixed.

Constraints:
- Output a single vitest test file (ESM). Import the function from the given relative path.
- The test must exercise the exact failure described (e.g., null input causing TypeError).
- The test MUST use an assertion (expect/toBe/...) that fails on the bug — do NOT rely on throwing or runtime errors that are unrelated to the bug.
- Do NOT modify the source under test; only produce the test.
- Keep it minimal and deterministic (no timers/network).

Respond ONLY with JSON: {"filePath": string, "testName": string, "code": string}`;

/** 解析 vitest --reporter=json 输出，判定失败性质。 */
function parseVitestJson(stdout: string): { hasAssertionFailure: boolean; firstFailure?: string } | 'parse-fail' {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return 'parse-fail';
  let data: { numFailedTests?: number; testResults?: Array<{ assertionResults?: Array<{ status?: string; failureMessages?: string[] }> }> };
  try {
    data = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return 'parse-fail';
  }
  const ASSERTION_RE = /AssertionError|Expected|Received|\.toBe|\.toEqual|\.toBeTruthy|\.toBeFalsy|\.toBeNull|expect\(|assert\s*\(/;
  let hasAssertion = false;
  let firstFailure: string | undefined;
  for (const tr of data.testResults ?? []) {
    for (const ar of tr.assertionResults ?? []) {
      if (ar.status === 'failed') {
        const msgs = (ar.failureMessages ?? []).join('\n');
        if (!firstFailure) firstFailure = msgs.slice(0, 200);
        if (ASSERTION_RE.test(msgs)) hasAssertion = true;
      }
    }
  }
  return { hasAssertionFailure: hasAssertion, firstFailure };
}

/**
 * 装配并运行真实 heal pipeline。返回 runHealPipeline 结果。
 */
export async function runRealHealPipeline(opts: HealRunnerOptions) {
  // ── BP-2 独立对抗硬断言：verifier 与 diagnoser 必须不同 model（不可绕过）────────
  if (!opts.verifierConfig || opts.verifierConfig.model === opts.diagnoserConfig.model) {
    throw new Error(
      `BP-2 violated: verifier model must differ from diagnoser model ` +
        `(diagnoser="${opts.diagnoserConfig.model}", verifier="${opts.verifierConfig?.model ?? '<none>'}"). ` +
        `Independent adversarial verification requires a different model id.`,
    );
  }

  const log = opts.onLog ?? (() => {});
  const repoRoot = resolve(opts.repoRoot);
  const originals = new Map<string, string>(); // 回滚用：path -> 原内容
  const reproFilePath = join(repoRoot, '__monit_repro__.test.js');
  let patchApplied = false;

  // ── diagnose：LLM 出根因 + search/replace 补丁 ──────────────────────────
  const diagnose = async (_retryCtx?: string): Promise<Diagnosis | null> => {
    const proposal = await generateDiagnosisProposal(opts.diagnoserConfig, opts.symptom, opts.stack, opts.focusFiles, _retryCtx);
    if (!proposal) return null;
    return {
      rootCause: proposal.diagnosis,
      evidence: proposal.evidence,
      patch: {
        patchType: 'replace',
        targetPath: proposal.patches[0]?.filePath,
        targetFunction: undefined,
      },
      __proposal: proposal,
    } as Diagnosis & { __proposal: AiPatchProposal };
  };

  // ── applyPatch：searchCode 校验 + 写盘 + 记录原内容 ─────────────────────
  const applyPatch = async (diag: Diagnosis): Promise<ApplyResult> => {
    const proposal = (diag as Diagnosis & { __proposal?: AiPatchProposal }).__proposal;
    if (!proposal) return { applied: false, filesChanged: 0, linesChanged: 0, error: 'no proposal attached' };
    for (const h of proposal.patches) {
      const abs = safeResolve(repoRoot, h.filePath);
      if (!abs) return { applied: false, filesChanged: 0, linesChanged: 0, error: `path traversal rejected: ${h.filePath}` };
      try { originals.set(abs, readFileSync(abs, 'utf-8')); } catch { /* 新文件 */ }
    }
    const res = await applyPatchesLocally(proposal,
      async (p) => { const a = safeResolve(repoRoot, p); if (!a) throw new Error('traversal'); return readFileSync(a, 'utf-8'); },
      async (p, c) => { const a = safeResolve(repoRoot, p); if (!a) throw new Error('traversal'); mkdirSync(dirname(a), { recursive: true }); writeFileSync(a, c); },
    );
    // locality 用真实行 diff（非 replaceCode 行数高估）+ distinct filePath（非 patches.length）
    const linesChanged = proposal.patches.reduce((s, h) => s + countChangedLines(h.searchCode, h.replaceCode), 0);
    const filesChanged = new Set(proposal.patches.map((h) => h.filePath)).size;
    if (res.applied === 0) return { applied: false, filesChanged: 0, linesChanged: 0, error: 'searchCode 不存在（防幻觉）' };
    const patchSource = proposal.patches.map((p) => p.replaceCode).join('\n');
    deps.contamination = detectContamination({ patchCode: patchSource, goldPatches: opts.goldPatches ?? [] }).contaminated
      ? 'detected' : 'clean';
    patchApplied = true;
    return { applied: true, filesChanged, linesChanged };
  };

  const revertPatch = async (): Promise<void> => {
    patchApplied = false;
    for (const [abs, content] of originals) {
      try { writeFileSync(abs, content); } catch { /* ignore */ }
    }
    try { if (existsSync(reproFilePath)) writeFileSync(reproFilePath, ''); } catch { /* ignore */ }
  };

  // ── generateReproTest：LLM 生成复现测试 ─────────────────────────────────
  const generateReproTest = async (diag: Diagnosis): Promise<ReproTestCode | null> => {
    const userContent = [
      '## Bug', `Symptom: ${opts.symptom}`,
      opts.stack ? `Stack:\n${opts.stack}` : '',
      '## Source under test',
      ...opts.focusFiles.map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 6000)}\`\`\``),
      `## Diagnosed root cause\n${diag.rootCause}`,
      '',
      `Generate a vitest test (filePath relative to repo root, must end with .test.js) that fails on the current buggy code via an assertion. JSON only.`,
    ].filter(Boolean).join('\n');
    const result = await chatJson<{ filePath: string; testName: string; code: string }>(opts.diagnoserConfig, [
      { role: 'system', content: REPRO_SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ]);
    if (!result || !result.code || !result.filePath) return null;
    // repro 文件名安全校验：仅允许 .test.js 结尾的安全字符
    if (!/^[\w./-]+\.test\.js$/.test(result.filePath)) return null;
    return { filePath: result.filePath, testName: result.testName || 'repro', code: result.code };
  };

  // ── runReproTest / runSuite：vitest 子进程（execFileSync shell:false）────
  const runVitestJson = (testFile: string): ReproRunResult => {
    let stdout = '';
    try {
      stdout = execFileSync('npx', ['--no-install', 'vitest', 'run', testFile, '--reporter=json'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        encoding: 'utf-8',
        env: { ...process.env, CI: '1' },
      });
      return { status: 'pass' }; // exit 0 = 全绿
    } catch (e) {
      const err = e as { stdout?: string; killed?: boolean; signal?: string | null; message?: string };
      if (err.killed || err.signal === 'SIGTERM' || /timed out|TIMEDOUT/i.test(err.message ?? '')) {
        return { status: 'timeout', message: 'vitest timeout' };
      }
      stdout = typeof err.stdout === 'string' ? err.stdout : '';
      const parsed = parseVitestJson(stdout);
      if (parsed === 'parse-fail') return { status: 'fail-error', message: 'vitest output unparseable' };
      return parsed.hasAssertionFailure
        ? { status: 'fail-assertion', message: parsed.firstFailure }
        : { status: 'fail-error', message: parsed.firstFailure ?? 'non-assertion failure' };
    }
  };
  const runReproTest = async (code: ReproTestCode, patched: boolean): Promise<ReproRunResult> => {
    if (patched !== patchApplied) {
      log(`[repro] 状态一致性警告：期望 patched=${patched}，实际 patchApplied=${patchApplied}`);
    }
    const abs = safeResolve(repoRoot, code.filePath);
    if (!abs) {
      log(`[repro] path traversal 拒绝: ${code.filePath}`);
      return { status: 'fail-error', message: 'path rejected' };
    }
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, code.code);
    } catch (e) {
      log(`[repro] 写测试文件失败: ${e}`);
      return { status: 'fail-error', message: 'write failed' };
    }
    return runVitestJson(abs);
  };
  const runSuite = async (): Promise<boolean> => {
    try {
      execFileSync('npx', ['--no-install', 'vitest', 'run', '--exclude=**/__monit_repro__*', '--reporter=default'], {
        cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, encoding: 'utf-8', env: { ...process.env, CI: '1' },
      });
      return true;
    } catch {
      return false;
    }
  };

  // ── typecheck：有 tsconfig 才跑 ─────────────────────────────────────────
  const typecheck = async (): Promise<boolean> => {
    if (!existsSync(join(repoRoot, 'tsconfig.json'))) return true; // 纯 JS repo 视为通过
    try {
      execFileSync('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  };

  // ── deliver：auto-mr -> PR；hotfix -> rollback 句柄 ─────────────────────
  const deliver = async (decision: HealDecision, _diag: Diagnosis, _repro: ReproTest | null): Promise<DeliveryResult> => {
    const proposal = (_diag as Diagnosis & { __proposal?: AiPatchProposal }).__proposal;
    if (!proposal) return null;
    if (decision.delivery === 'auto-mr' && opts.githubConfig) {
      const branch = `fix/smarty-${Date.now().toString(36)}`;
      log(`[deliver] 开 PR（auto-mr）-> branch ${branch}`);
      const pr: PrResult = await createGithubPr(opts.githubConfig, proposal, branch);
      return pr;
    }
    if (decision.delivery === 'hotfix') {
      return { applied: true, rollback: () => { void revertPatch(); } };
    }
    return null;
  };

  const deps: HealPipelineDeps = {
    diagnose,
    verifierConfig: opts.verifierConfig,
    generateReproTest,
    runReproTest,
    applyPatch,
    revertPatch,
    runSuite,
    typecheck,
    contamination: 'clean',
    behaviorPreserving: opts.behaviorPreserving ?? false,
    symptom: opts.symptom,
    deliver,
    maxAttempts: opts.maxAttempts ?? 3,
    onLog: log,
    models: {
      diagnoser: { model: opts.diagnoserConfig.model, provider: opts.diagnoserConfig.provider, temperature: opts.diagnoserConfig.temperature },
      verifier: { model: opts.verifierConfig.model, provider: opts.verifierConfig.provider, temperature: opts.verifierConfig.temperature },
    },
  };

  return runHealPipeline(deps);
}

// ── 内部：LLM 诊断提案（复用 coordinator/llm-patch 的 prompt 思路）─────────────

const DIAG_SYSTEM_PROMPT = `You are a frontend repair agent. Given a bug and the relevant source, produce a MINIMAL source-level patch (search/replace) that fixes it.

Constraints:
- Only modify files in the context.
- searchCode MUST be a verbatim substring currently in the file (copy char-by-char, same whitespace).
- Prefer minimal guards/null-checks over rewrites.
- SCOPE: Only fix what the STACK TRACE / error directly implicates. The stack cites a specific function/file/line — fix THAT. Do NOT modify other functions even if they look similar; a patch touching functions not on the stack will be rejected by the verifier as unsupported by evidence.
- Output EXACTLY ONE patch hunk for the single cited failure point. Multiple hunks / touching a second function will be rejected.

Respond ONLY with JSON:
{"diagnosis": string, "evidence": [string], "patches": [{"filePath": string, "searchCode": string, "replaceCode": string}]}`;

async function generateDiagnosisProposal(
  config: LLMConfig,
  symptom: string,
  stack: string | undefined,
  files: Array<{ path: string; content: string }>,
  retryCtx?: string,
): Promise<(AiPatchProposal & { evidence: string[] }) | null> {
  const userContent = [
    '## Bug', `Symptom: ${symptom}`,
    stack ? `Stack:\n${stack}` : '',
    '## Source',
    ...files.map(f => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 8000)}\`\`\``),
    retryCtx ? `\n## Previous attempt feedback\n${retryCtx}` : '',
    '',
    'Produce a minimal patch. JSON only.',
  ].filter(Boolean).join('\n');
  const result = await chatJson<{ diagnosis: string; evidence?: string[]; patches: Array<{ filePath: string; searchCode: string; replaceCode: string }> }>(config, [
    { role: 'system', content: DIAG_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]);
  if (!result || !Array.isArray(result.patches) || result.patches.length === 0) return null;
  const valid = result.patches.filter(p => {
    const f = files.find(x => x.path === p.filePath);
    return f && p.searchCode && f.content.includes(p.searchCode);
  });
  if (valid.length === 0) return null;
  return {
    id: `prop-${Date.now()}`,
    basedOn: '',
    track: 'mr-draft',
    patchType: 'replace',
    diagnosis: result.diagnosis,
    evidence: result.evidence ?? [],
    patches: valid,
    riskNotes: [],
    riskScore: 0.2,
    createdAt: Date.now(),
  };
}
