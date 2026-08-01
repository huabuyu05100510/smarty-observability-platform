/**
 * @monit/repair-agent/pipeline - ★ 极致闭环单漏斗自愈管线（代表作核心）
 *
 * 合并旧 runHarness + runMrDraftTrack 为【单漏斗】：所有补丁必经同一组门禁，
 * hotfix/MR/human 是漏斗末端的【交付路由】，不再各拿一半护栏（解掉方案 #1）。
 *
 * 漏斗（BP-1..4）：
 *   diagnose(runLlmRca) -> verify(独立模型, BP-2) -> genReproTest -> [repro 须先红, BP-3]
 *   -> applyLocal(searchCode 校验) -> regression(repro 红转绿 + 套件不破 + 3-replay 防抖)
 *   -> guardrails(contamination) -> gateVector(assessGate, BP-4) -> [auto-mr | hotfix | human]
 *
 * 关键创新（本轮做实，消灭"门禁输入失真"）：
 * - repro 须在未打补丁代码上先【断言失败】（redBefore = fail-assertion），证明复现有效；
 *   抛无关异常(fail-error)/超时(timeout)不算有效复现 → 回炉重生成。
 *   这根治"窄测试/伪复现"假阳性（SWE-bench 通过测试≠真修复）。
 * - gateVector 是确定性布尔向量门禁，替加权 score（消灭伪精度）；AI 不持有门禁。
 * - Verifier 三态如实进 gate（pass/refuted/skipped），不再硬编码 'pass'；
 *   Verifier 置信度经 VERIFIER_MIN_CONFIDENCE 转布尔 verifierConfident 进门禁（低置信 = 弱验证，不放行）。
 * - Verifier 独立模型（调用方传 verifierConfig，应与 diagnoser 不同 model id；heal-runner 强制断言）。
 *
 * 可测试：每个阶段为可注入函数，真实环境用 LLM + fs + test runner，测试用 mock。
 */

import type {
  VerifierResult,
  GateVector,
  HealDecision,
  ReproTest,
  PrResult,
} from '@monit/contracts';
import { verifyAdversarially, type DiagnosisInput } from './verifier';
import { assessGate } from './gate';
import type { LLMConfig } from './llm-client';
import type { Diagnosis } from './harness';

/** Verifier 高置信阈值（pass 但 confidence 低于此 = 弱验证，不放行自动交付）。 */
export const VERIFIER_MIN_CONFIDENCE = 0.5;

/** repro 测试运行结果（结构化）：区分"有效复现失败"与"无关错误/超时"。 */
export type ReproStatus = 'pass' | 'fail-assertion' | 'fail-error' | 'timeout';
export interface ReproRunResult {
  status: ReproStatus;
  message?: string;
}

/** LLM 生成的复现测试代码 */
export interface ReproTestCode {
  filePath: string;
  testName: string;
  code: string;
}

export interface ApplyResult {
  applied: boolean;
  filesChanged: number;
  linesChanged: number;
  error?: string;
}

export type DeliveryResult = PrResult | { applied: boolean; rollback: () => void } | null;

export interface HealPipelineDeps {
  /** 1. Diagnose：产根因 + 补丁（LLM 多 agent 或 mock）*/
  diagnose: (retryContext?: string) => Promise<Diagnosis | null>;
  /** 2. 独立模型 Verifier 配置（须与 diagnoser 不同 model id，BP-2）。不传 = skipped（诚实降级，落 human）*/
  verifierConfig?: LLMConfig;
  /** 自定义 verify 函数（默认用 verifyAdversarially(verifierConfig)）。
   *  demo / 确定性测试可注入 stub verifier，跑真实 gate 逻辑而无需 LLM key。
   *  提供此函数即视为 verifier 已启用（verifierRan=true），不再要求 verifierConfig。*/
  verify?: (input: DiagnosisInput) => Promise<VerifierResult>;
  /** 3. 生成复现 bug 的测试（LLM）。返回 null = 生成失败 */
  generateReproTest: (diagnosis: Diagnosis) => Promise<ReproTestCode | null>;
  /** 运行 repro。patched=false 须 fail-assertion（证明复现有效），patched=true 须 pass。结构化结果区分有效失败与无关错误。*/
  runReproTest: (code: ReproTestCode, patched: boolean) => Promise<ReproRunResult>;
  /** 4. 应用补丁到源码（含 searchCode 校验 + replacer 防注入）*/
  applyPatch: (diagnosis: Diagnosis) => Promise<ApplyResult>;
  /** 回滚补丁（回归失败 / human 时清理）*/
  revertPatch: () => Promise<void>;
  /** 5. 运行现有测试套件，true=全绿 */
  runSuite: () => Promise<boolean>;
  /** typecheck */
  typecheck: () => Promise<boolean>;
  /** 6. 数据污染检测结果（真实 goldPatch 集）*/
  contamination: 'clean' | 'detected';
  /** 热修轨：补丁是否行为保留（非 masking 吞错）。MR 轨传 false */
  behaviorPreserving: boolean;
  /** 症状描述（喂 Verifier）*/
  symptom: string;
  /** 8. 交付路由：按 decision 执行 hotfix/MR/human。可选 */
  deliver?: (decision: HealDecision, diagnosis: Diagnosis, repro: ReproTest | null) => Promise<DeliveryResult>;
  maxAttempts?: number;
  /** 回归重放次数（多数投票，默认 3 取 ≥2）。设 1 关闭多 replay（仅单测/确定性 mock 用）*/
  regressionReplays?: number;
  onLog?: (msg: string) => void;
}

export interface HealPipelineResult {
  diagnosis: Diagnosis | null;
  verifier: VerifierResult | null;
  repro: ReproTest | null;
  applied: boolean;
  suiteGreen: boolean;
  decision: HealDecision | null;
  delivery: DeliveryResult;
  attempts: number;
  /** 回归多数投票明细（repro/suite 各 replays 次，需 ≥ majority）*/
  regressionVotes: { replays: number; reproPasses: number; suitePasses: number } | null;
  /** delivery != human（补丁通过门禁并交付）*/
  resolved: boolean;
}

/**
 * 极致闭环单漏斗。
 */
export async function runHealPipeline(deps: HealPipelineDeps): Promise<HealPipelineResult> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const log = deps.onLog ?? (() => {});

  let lastDiagnosis: Diagnosis | null = null;
  let lastVerifier: VerifierResult | null = null;
  let lastRepro: ReproTest | null = null;
  let lastApplied = false;
  let lastSuiteGreen = false;
  let lastDecision: HealDecision | null = null;
  let lastDelivery: DeliveryResult = null;
  let lastRegressionVotes: { replays: number; reproPasses: number; suitePasses: number } | null = null;
  let retryContext: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`[HealPipeline] attempt ${attempt}/${maxAttempts}`);
    let verifierRan = false;

    // ── 1. Diagnose ──────────────────────────────────────────────────────
    const diagnosis = await deps.diagnose(retryContext);
    if (!diagnosis) { log('[HealPipeline] diagnose 产出空，终止'); break; }
    lastDiagnosis = diagnosis;
    log(`[HealPipeline] diagnosed: ${diagnosis.rootCause.slice(0, 80)}`);

    // ── 2. Verify（独立模型对抗，BP-2）──────────────────────────────────
    const verifyFn = deps.verify ?? ((input: DiagnosisInput) => verifyAdversarially(deps.verifierConfig!, input));
    if (deps.verifierConfig || deps.verify) {
      const vInput: DiagnosisInput = {
        symptom: deps.symptom,
        rootCause: diagnosis.rootCause,
        evidence: diagnosis.evidence,
        patch: diagnosis.patch,
      };
      lastVerifier = await verifyFn(vInput);
      verifierRan = true;
      log(`[HealPipeline] verifier: refuted=${lastVerifier.refuted} conf=${lastVerifier.confidence.toFixed(2)}`);
      if (lastVerifier.refuted) {
        retryContext = `Verifier REFUTED 上次诊断（反事实）。理由: ${lastVerifier.reason}。` +
          (lastVerifier.alternativeHypothesis ? `替代假设: ${lastVerifier.alternativeHypothesis}。` : '') +
          '须给出不同诊断，不要复述同一根因。';
        continue;
      }
    } else {
      log('[HealPipeline] verifier skipped（未配 verifierConfig，诚实降级）');
    }

    // ── 3. Generate repro test（BP-3）────────────────────────────────────
    const reproCode = await deps.generateReproTest(diagnosis);
    if (!reproCode) { log('[HealPipeline] repro 生成失败，重试'); retryContext = '上次未生成有效复现测试。须生成一个能在未修复代码上失败的测试。'; continue; }

    // repro 须先红：在未打补丁代码上须【断言失败】（fail-assertion），证明复现有效。
    // 抛无关异常(fail-error)/超时(timeout)不算有效复现 —— 防伪复现绕过红转绿门禁。
    const redResult = await deps.runReproTest(reproCode, false);
    const redBefore = redResult.status === 'fail-assertion';
    log(`[HealPipeline] repro redBefore=${redBefore} (status=${redResult.status})`);
    if (!redBefore) {
      retryContext = redResult.status === 'pass'
        ? '上次 repro 测试在未打补丁代码上【通过】= 没在测这个 bug。须生成一个真正复现 bug 的失败测试。'
        : `上次 repro 在未打补丁代码上【${redResult.status}】而非断言失败 = 复现无效（无关异常或超时）。须生成针对该 bug 的断言失败测试。`;
      continue;
    }

    // ── 4. Apply patch（searchCode 校验 + replacer）──────────────────────
    const applyRes = await deps.applyPatch(diagnosis);
    if (!applyRes.applied) {
      log(`[HealPipeline] apply 失败: ${applyRes.error}`);
      await deps.revertPatch().catch(() => {});
      retryContext = `补丁应用失败: ${applyRes.error ?? '未知'}。检查 searchCode 是否真实存在、targetPath 是否正确。`;
      continue;
    }
    lastApplied = true;
    log(`[HealPipeline] applied (${applyRes.filesChanged} 文件 / ${applyRes.linesChanged} 行)`);

    // ── 5. Regression：repro 红转绿 + 套件不破 + 多 replay 多数投票（防抖）─────────
    const replays = deps.regressionReplays ?? 3;
    const need = Math.floor(replays / 2) + 1; // 严格多数：3→2, 1→1
    const reproPasses = await votePasses(async () => (await deps.runReproTest(reproCode, true)).status === 'pass', replays);
    const suitePasses = await votePasses(() => deps.runSuite(), replays);
    const greenAfter = reproPasses >= need;
    const suiteGreen = suitePasses >= need;
    lastSuiteGreen = suiteGreen;
    lastRegressionVotes = { replays, reproPasses, suitePasses };
    log(`[HealPipeline] repro greenAfter=${greenAfter}(${reproPasses}/${replays}) suiteGreen=${suiteGreen}(${suitePasses}/${replays})`);
    if (!greenAfter || !suiteGreen) {
      await deps.revertPatch().catch(() => {});
      lastApplied = false;
      retryContext = `回归失败（${replays} 次重放：repro ${reproPasses}/${replays}、suite ${suitePasses}/${replays}，需 ≥${need}）。补丁未真正修复或破坏现有测试。重审根因。`;
      continue;
    }

    // ── 6. typecheck ─────────────────────────────────────────────────────
    const typecheckOk = await deps.typecheck();

    // ── 7. GateVector（确定性向量门禁，BP-4）─────────────────────────────
    // verifier 三态如实：refuted 已 continue 不会到此；verifierRan 决定 pass/skipped。
    const gate: GateVector = {
      verifier: !verifierRan ? 'skipped' : (lastVerifier!.refuted ? 'refuted' : 'pass'),
      verifierConfident:
        verifierRan &&
        !lastVerifier!.refuted &&
        (lastVerifier!.confidence ?? 0) >= VERIFIER_MIN_CONFIDENCE,
      reproRedBefore: redBefore,
      reproGreenAfter: greenAfter,
      suiteGreen,
      typecheck: typecheckOk,
      locality: { files: applyRes.filesChanged, lines: applyRes.linesChanged },
      contamination: deps.contamination,
      behaviorPreserving: deps.behaviorPreserving,
    };
    lastDecision = assessGate(gate);
    log(`[HealPipeline] gate: delivery=${lastDecision.delivery} (verifierConfident=${gate.verifierConfident})`);

    lastRepro = { filePath: reproCode.filePath, testName: reproCode.testName, code: reproCode.code, redBefore, greenAfter };

    // ── 8. Delivery 路由 ─────────────────────────────────────────────────
    if (lastDecision.delivery === 'human') {
      // 补丁虽通过回归，但门禁未全过（非局部/污染/低置信）-> 回滚，转人工
      await deps.revertPatch().catch(() => {});
      lastApplied = false;
    }
    if (deps.deliver) {
      lastDelivery = await deps.deliver(lastDecision, diagnosis, lastRepro);
    }

    return {
      diagnosis: lastDiagnosis,
      verifier: lastVerifier,
      repro: lastRepro,
      applied: lastApplied,
      suiteGreen,
      decision: lastDecision,
      delivery: lastDelivery,
      attempts: attempt,
      regressionVotes: lastRegressionVotes,
      resolved: lastDecision.delivery !== 'human',
    };
  }

  return {
    diagnosis: lastDiagnosis,
    verifier: lastVerifier,
    repro: lastRepro,
    applied: lastApplied,
    suiteGreen: lastSuiteGreen,
    decision: lastDecision,
    delivery: lastDelivery,
    attempts: maxAttempts,
    regressionVotes: lastRegressionVotes,
    resolved: false,
  };
}

/** 多数投票：运行 n 次，返回通过次数（单次抛错计为不通过）。 */
async function votePasses(fn: () => Promise<boolean>, n: number): Promise<number> {
  let passes = 0;
  for (let i = 0; i < n; i++) {
    try { if (await fn()) passes++; } catch { /* 单次失败计为不通过 */ }
  }
  return passes;
}
