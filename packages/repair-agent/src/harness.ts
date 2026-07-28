/**
 * @monit/repair-agent/harness - ★ 升级版自愈循环
 *
 * sentinel-x 原循环：diagnose -> inject -> regression-verify -> retry
 * 本轮升级：diagnose -> ★ verifyAdversarially -> inject -> regression-verify -> ★ assessConfidence -> retry
 *
 * 升级点（研究 §2.3/§4）：
 * 1. 注入前插入 Verifier 反事实对抗验证（抓 LLM 幻觉，对标 88.4% F1 论文）
 * 2. 注入后回归 + 信心门禁（确定性×AI 分层，AI 不做门禁）
 * 3. Verifier 否决时把 alternativeHypothesis 喂回 Diagnoser 重诊断（先不注入）
 *
 * harness 可测试：diagnose/verify/inject/check 均为可注入函数，
 * 真实环境用 LLM + CDP，测试用 mock。
 */

import type {
  AiPatchProposal,
  ConfidenceTier,
  PatchResult,
  VerifierResult,
} from '@monit/contracts';
import { verifyAdversarially, type DiagnosisInput } from './verifier';
import { runRegression } from './regression-runner';
import { assessConfidence, type LocalitySignals, type ConfidenceGateOutput } from './confidence';
import type { LLMConfig } from './llm-client';

/** Diagnoser 产出 */
export interface Diagnosis {
  rootCause: string;
  evidence: string[];
  patch: {
    patchType: AiPatchProposal['patchType'];
    targetFunction?: string;
    targetPath?: string;
    code?: string;
  };
  /** Diagnoser 自报置信度 0-100（不信任，仅参考） */
  selfConfidence?: number;
}

export interface HarnessDeps {
  /** Diagnoser：产出根因 + 补丁（LLM 或 mock） */
  diagnose: (retryContext?: string) => Promise<Diagnosis | null>;
  /** 注入补丁（CDP Runtime.evaluate 或 mock）。返回 injected + error */
  inject: (patch: Diagnosis['patch']) => Promise<{ injected: boolean; error?: string }>;
  /** 回放一次后检查错误是否仍触发（true=仍存在） */
  check: () => Promise<boolean>;
  /** 每次回放前重置错误计数 */
  reset: () => Promise<void>;
  /** Verifier 配置；不传则跳过对抗验证 */
  verifierConfig?: LLMConfig;
  /** 改动局部性信号（信心门禁用） */
  locality: LocalitySignals;
  /** 最大尝试次数，默认 3 */
  maxAttempts?: number;
  /** Verifier 面板大小（多轮投票），默认 1（单次） */
  verifierPanel?: number;
  onLog?: (msg: string) => void;
}

export interface HarnessResult {
  diagnosis: Diagnosis | null;
  verifierResult: VerifierResult | null;
  regressionResult: PatchResult | null;
  confidence: ConfidenceGateOutput | null;
  attempts: number;
  resolved: boolean;
  tier: ConfidenceTier | null;
}

const ALL_PATCH_TYPES: AiPatchProposal['patchType'][] = [
  'replace',
  'wrap',
  'guard',
  'error-boundary',
  'prototype',
];

/**
 * 升级版自愈循环。
 */
export async function runHarness(deps: HarnessDeps): Promise<HarnessResult> {
  const { diagnose, inject, check, reset, locality, verifierConfig } = deps;
  const maxAttempts = deps.maxAttempts ?? 3;
  const log = deps.onLog ?? (() => {});

  let lastDiagnosis: Diagnosis | null = null;
  let lastVerifier: VerifierResult | null = null;
  let lastRegression: PatchResult | null = null;
  let lastConfidence: ConfidenceGateOutput | null = null;
  let lastTier: ConfidenceTier | null = null;
  let retryContext: string | undefined;
  const triedPatchTypes: AiPatchProposal['patchType'][] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`[Harness] attempt ${attempt}/${maxAttempts}`);

    // ── Phase 1: Diagnose ──────────────────────────────────────────────
    const diagnosis = await diagnose(retryContext);
    if (!diagnosis) {
      log('[Harness] diagnosis failed - no RCA produced');
      break;
    }
    lastDiagnosis = diagnosis;
    triedPatchTypes.push(diagnosis.patch.patchType);
    log(`[Harness] diagnosed: ${diagnosis.rootCause.slice(0, 80)} (patch=${diagnosis.patch.patchType})`);

    // ── Phase 2: ★ Verifier adversarial validation ────────────────────
    if (verifierConfig) {
      const input: DiagnosisInput = {
        symptom: retryContext ?? 'observed error',
        rootCause: diagnosis.rootCause,
        evidence: diagnosis.evidence,
        patch: diagnosis.patch,
      };
      lastVerifier = await verifyAdversarially(verifierConfig, input);
      log(`[Harness] verifier: refuted=${lastVerifier.refuted} (conf=${lastVerifier.confidence.toFixed(2)})`);

      if (lastVerifier.refuted) {
        // 证伪 -> 把替代假设喂回 Diagnoser，先不注入
        retryContext = buildVerifierFailureContext(diagnosis, lastVerifier, triedPatchTypes);
        continue;
      }
    }

    // ── Phase 3: Inject ────────────────────────────────────────────────
    const injectResult = await inject(diagnosis.patch);
    if (!injectResult.injected) {
      log(`[Harness] injection failed: ${injectResult.error}`);
      retryContext = buildInjectionFailureContext(diagnosis, injectResult.error ?? 'unknown', triedPatchTypes);
      continue;
    }

    // ── Phase 4: Regression verify (empirical) ─────────────────────────
    lastRegression = await runRegression(
      `attempt-${attempt}`,
      check,
      reset,
    );
    log(`[Harness] regression: ${lastRegression.verdict} (${lastRegression.passes}/${lastRegression.replays})`);

    if (lastRegression.regressionPassed) {
      // ── Phase 5: ★ Confidence gate (determinism×AI) ──────────────────
      lastConfidence = assessConfidence({
        verifier: lastVerifier ?? { refuted: false, reason: 'verifier skipped', confidence: 0.5 },
        regression: lastRegression,
        locality,
      });
      log(`[Harness] confidence: tier=${lastConfidence.tier} score=${lastConfidence.score.toFixed(2)} auto=${lastConfidence.canAutoApply}`);
      lastTier = lastConfidence.tier;
      return {
        diagnosis: lastDiagnosis,
        verifierResult: lastVerifier,
        regressionResult: lastRegression,
        confidence: lastConfidence,
        attempts: attempt,
        resolved: true,
        tier: lastTier,
      };
    }

    retryContext = buildRegressionFailureContext(diagnosis, triedPatchTypes);
  }

  return {
    diagnosis: lastDiagnosis,
    verifierResult: lastVerifier,
    regressionResult: lastRegression,
    confidence: lastConfidence,
    attempts: maxAttempts,
    resolved: false,
    tier: lastTier,
  };
}

// ─── Retry context builders ───────────────────────────────────────────────────

function buildVerifierFailureContext(
  d: Diagnosis,
  v: VerifierResult,
  tried: AiPatchProposal['patchType'][],
): string {
  return [
    '**Verifier REFUTED your previous diagnosis** (counterfactual reasoning).',
    `- Your root cause: ${d.rootCause}`,
    `- Verifier reason: ${v.reason}`,
    v.alternativeHypothesis ? `- Verifier alternative hypothesis: ${v.alternativeHypothesis}` : '',
    '',
    'REQUIRED: Re-examine the stack trace. The alternative hypothesis above (if any) is a stronger candidate.',
    'Do NOT re-propose the same root cause. Provide a DIFFERENT diagnosis grounded in concrete stack evidence.',
    '',
    `Tried patchTypes: ${tried.join(', ')}`,
    `Untried: ${ALL_PATCH_TYPES.filter(t => !tried.includes(t)).join(', ') || 'none'}`,
  ].filter(Boolean).join('\n');
}

function buildInjectionFailureContext(
  d: Diagnosis,
  error: string,
  tried: AiPatchProposal['patchType'][],
): string {
  const notTried = ALL_PATCH_TYPES.filter(t => !tried.includes(t));
  let advice: string;
  if (error.includes('not found') || error.includes('not accessible')) {
    advice = `Function "${d.patch.targetFunction}" not found on path "${d.patch.targetPath}". Typical in minified bundles. REQUIRED: switch to "error-boundary" or "prototype" (no function lookup needed).`;
  } else if (error.includes('All injection strategies failed')) {
    advice = 'Function completely inaccessible. REQUIRED: use "error-boundary" with a precise error message keyword.';
  } else {
    advice = `Injection threw: ${error}. Check patch code is valid JS.`;
  }
  return [
    '**Injection FAILED**.',
    `- patchType: ${d.patch.patchType}, target: ${d.patch.targetFunction}`,
    `- Error: ${error}`,
    '',
    advice,
    '',
    `Untried: ${notTried.join(', ') || 'none'}`,
  ].filter(Boolean).join('\n');
}

function buildRegressionFailureContext(
  d: Diagnosis,
  tried: AiPatchProposal['patchType'][],
): string {
  const notTried = ALL_PATCH_TYPES.filter(t => !tried.includes(t));
  let escalation: string;
  if (tried.includes('error-boundary')) {
    escalation = 'Error-boundary installed but error still fires - keyword matching too broad. Use a MORE SPECIFIC substring, or try "prototype" patching.';
  } else if (tried.includes('replace') || tried.includes('wrap')) {
    escalation = 'Replace/wrap injected but error still fires - wrong call site or another code path. Switch to "error-boundary" to intercept at error-event level.';
  } else {
    escalation = 'Patch injected but regression failed - root cause may be wrong. Re-examine the stack.';
  }
  return [
    '**Regression FAILED** - error still fires after patch.',
    `- Tried: ${tried.join(', ')}`,
    `- Your root cause was: ${d.rootCause}`,
    '',
    escalation,
    '',
    `Untried: ${notTried.join(', ') || 'none'}`,
  ].filter(Boolean).join('\n');
}