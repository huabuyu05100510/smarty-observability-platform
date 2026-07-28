/**
 * @monit/repair-agent/verifier - ★ 对抗式 Verifier agent（本轮核心升级）
 *
 * 研究依据（2026-07 调研 §2.3/§4）：
 * - LLM-RCA 头号失败模式是"幻觉类比/编造证据"（Waterloo 48K 故障注入实证 RF-01）。
 * - 确定性×AI 混合的标杆架构（F1 88.4%）核心机制 =
 *   "Verifier Agent enforces Adversarial Validation Protocol to mitigate hallucinations
 *    through rigorous counterfactual reasoning"（ScienceDirect S1546221826005011）。
 *
 * sentinel-x 当前只有"注入后回归投票"（经验式确认），抓不住注入前的逻辑幻觉。
 * 本 Verifier 在 diagnose 与 inject 之间插入【反事实验证】：主动证伪根因，
 * 证伪则把替代假设喂回 Diagnoser 重诊断，先不注入。
 *
 * 关键设计：
 * 1. 独立 prompt（怀疑者/证伪导向），与 Diagnoser（生成导向）分离。
 * 2. 反事实推理："若此为真因，症状是否会精确如此呈现？"
 * 3. 举证责任在诊断方：支持不强则默认 refuted=true。
 * 4. 温度低于 Diagnoser（0.1 vs 0.2），更确定性的判断。
 */

import type { VerifierResult } from '@monit/contracts';
import { chatJson, type LLMConfig, type ChatMessage } from './llm-client';

/** 待验证的诊断输入 */
export interface DiagnosisInput {
  /** 观察到的症状（错误信息/性能劣化） */
  symptom: string;
  /** 完整堆栈（若有） */
  stackTrace?: string;
  /** Diagnoser 提出的根因 */
  rootCause: string;
  /** Diagnoser 引用的证据 */
  evidence: string[];
  /** 提议的修复（patchType + 目标 + 代码） */
  patch?: {
    patchType: string;
    targetFunction?: string;
    targetPath?: string;
    code?: string;
  };
  /** 相关源码片段（增强反事实验证） */
  codeSlice?: string;
}

const VERIFIER_SYSTEM_PROMPT = `You are a SKEPTICAL Root-Cause Verifier. Your job is to REFUTE the proposed diagnosis, not confirm it.

Apply rigorous COUNTERFACTUAL reasoning:
1. If the proposed root cause were TRUE, would the observed symptom manifest EXACTLY as seen? Look for mismatches between cause and symptom.
2. Is every piece of cited evidence actually present in the provided stack/code? Flag any FABRICATED evidence or hallucinated analogies (the #1 failure mode of LLM RCA).
3. Does the proposed patch actually address the root cause, or does it only mask the symptom?
4. What ALTERNATIVE root causes fit the evidence at least as well?

Burden of proof is on the diagnosis. If you cannot find STRONG, DIRECT support, default to refuted=true.

Respond ONLY with JSON:
{"refuted": boolean, "reason": string, "alternativeHypothesis"?: string, "confidence": number}
- refuted: true if the diagnosis should be rejected or is too weak to act on.
- confidence: 0-1, your confidence in the refutation decision.
- alternativeHypothesis: if refuted, the most likely alternative root cause.`;

/**
 * 对抗式验证一条诊断。返回 VerifierResult。
 * 失败（LLM 不可用 / 解析失败）时保守返回 refuted=true（不放过弱诊断）。
 */
export async function verifyAdversarially(
  config: LLMConfig,
  diagnosis: DiagnosisInput,
): Promise<VerifierResult> {
  const userContent = buildUserPrompt(diagnosis);
  const messages: ChatMessage[] = [
    { role: 'system', content: VERIFIER_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  // Verifier 用更低温度，判断更确定
  const verifierConfig: LLMConfig = { ...config, temperature: 0.1 };

  try {
    const result = await chatJson<VerifierResult>(verifierConfig, messages);
    if (result && typeof result.refuted === 'boolean') {
      return {
        refuted: result.refuted,
        reason: result.reason ?? 'no reason given',
        alternativeHypothesis: result.alternativeHypothesis,
        confidence: typeof result.confidence === 'number' ? result.confidence : 0.5,
      };
    }
  } catch {
    // fall through to conservative default
  }

  // 保守默认：无法验证则视为被否（不放过弱诊断，符合"举证责任在诊断方"）
  return {
    refuted: true,
    reason: 'Verifier unavailable or returned unparseable output; conservatively rejecting to avoid acting on unverified diagnosis.',
    confidence: 0,
  };
}

function buildUserPrompt(d: DiagnosisInput): string {
  const lines: string[] = [
    '## Symptom',
    d.symptom,
  ];
  if (d.stackTrace) {
    lines.push('', '## Stack Trace', '```', d.stackTrace, '```');
  }
  if (d.codeSlice) {
    lines.push('', '## Relevant Code', '```', d.codeSlice.slice(0, 4000), '```');
  }
  lines.push('', '## Proposed Root Cause', d.rootCause);
  lines.push('', '## Cited Evidence');
  for (const e of d.evidence) lines.push(`- ${e}`);
  if (d.patch) {
    lines.push('', '## Proposed Patch');
    lines.push(`- patchType: ${d.patch.patchType}`);
    if (d.patch.targetFunction) lines.push(`- target: ${d.patch.targetFunction}`);
    if (d.patch.targetPath) lines.push(`- path: ${d.patch.targetPath}`);
    if (d.patch.code) lines.push('```', d.patch.code.slice(0, 2000), '```');
  }
  lines.push('', 'Refute or accept this diagnosis via counterfactual reasoning. JSON only.');
  return lines.join('\n');
}

/**
 * 多轮对抗验证（对标论文的 rigorous validation）。
 * N 个独立 Verifier 投票，多数 refuted 则否决（防单次误判）。
 */
export async function verifyAdversariallyPanel(
  config: LLMConfig,
  diagnosis: DiagnosisInput,
  panelSize = 3,
): Promise<VerifierResult> {
  const votes = await Promise.all(
    Array.from({ length: panelSize }, () => verifyAdversarially(config, diagnosis)),
  );
  const refutedCount = votes.filter(v => v.refuted).length;
  const majorityRefuted = refutedCount > panelSize / 2;

  // 取少数派/多数派中最有信心的理由
  const aligned = votes.filter(v => v.refuted === majorityRefuted);
  const best = aligned.reduce((b, v) => ((v.confidence ?? 0) > (b?.confidence ?? 0) ? v : b), aligned[0]);

  return {
    refuted: majorityRefuted,
    reason: best?.reason ?? `${refutedCount}/${panelSize} verifiers refuted`,
    alternativeHypothesis: best?.alternativeHypothesis,
    confidence: refutedCount / panelSize,
  };
}