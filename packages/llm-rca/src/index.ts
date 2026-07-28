/**
 * @monit/llm-rca - 结构化上下文 LLM 根因分析（残差融合）
 *
 * 研究依据（2026-07 调研 §2.4/§4）：
 * - 原始遥测直喂 LLM 不可行（OpenRCA 半小时 ~2GB，超上下文容量；Simple LLM Call 仅 12 分）。
 * - 标杆架构（F1 88.4%）：anomaly fusion graph（确定性结构）+ Navigator/Diagnoser/Verifier
 *   多 agent 语义推理 + Verifier 反事实对抗验证。
 * - 关键：喂【结构化聚合上下文】（AttributionRecord 候选 + 证据 + 变更关联 + 代码片段），
 *   不喂原始海量遥测。
 *
 * 残差融合：最终置信度 = 确定性候选置信度 × LLM 置信度，分歧大（残差）则降信心。
 * 产出 kind='llm_rca' 候选，并入 AttributionRecord.candidates 链。
 */

import type { AttributionCandidate, AttributionRecord } from '@monit/contracts';
import { chatJson, type LLMConfig, type ChatMessage } from '@monit/repair-agent';
import { verifyAdversarially, type DiagnosisInput } from '@monit/repair-agent';

/** 喂给 LLM 的结构化上下文（非原始遥测） */
export interface StructuredContext {
  /** AttributionRecord：症状 + 确定性候选链 + 证据 */
  record: AttributionRecord;
  /** 相关源码片段（已切片，非全量） */
  codeSlices: Array<{ path: string; content: string }>;
  /** 近期变更（若有） */
  changes?: Array<{ kind: string; summary: string; at: number; release?: string }>;
  /** 错误堆栈（已 sourcemap 还原，非压缩） */
  resolvedStack?: string[];
}

export interface LlmRcaResult {
  /** LLM-RCA 候选（可并入 record.candidates） */
  candidate: AttributionCandidate;
  /** Verifier 对 LLM 诊断的对抗验证结果 */
  verification: { refuted: boolean; reason: string; confidence: number };
  /** 残差（确定性 top 候选置信度 与 LLM 置信度 的分歧） */
  residual: number;
  /** 融合后的最终置信度 */
  fusedConfidence: number;
}

const NAVIGATOR_PROMPT = `You are the Navigator in a multi-agent root-cause analysis system. Given a structured context (symptom + ranked candidate causes + evidence + changes + code), identify the SINGLE most promising candidate to focus deeper analysis on. If none of the deterministic candidates fit, say so and propose a new direction.

Respond ONLY with JSON: {"focusCandidateIndex": number, "rationale": string, "newDirection"?: string}
- focusCandidateIndex: 0-based index into the candidates array, or -1 if none fit.`;

const DIAGNOSER_PROMPT = `You are the Diagnoser in a multi-agent root-cause analysis system. Given a focused candidate + structured evidence + code slices, produce a precise root-cause hypothesis that EXPLAINS the observed symptom.

Constraints:
- Ground every claim in the provided evidence/code. Do NOT fabricate.
- Be specific: name the function, the data flow, the failing assumption.
- If the focused candidate is wrong, say so and propose an alternative.

Respond ONLY with JSON: {"rootCause": string, "confidence": number, "evidence": [string], "alternativeRootCause"?: string}
- confidence: 0-1, your confidence THIS is the true root cause.`;

/**
 * 运行 LLM-RCA 多 agent 流水线：Navigator -> Diagnoser -> Verifier -> 残差融合。
 */
export async function runLlmRca(
  config: LLMConfig,
  ctx: StructuredContext,
): Promise<LlmRcaResult | null> {
  // 1. Navigator：定位最有希望的候选
  const navResult = await chatJson<{ focusCandidateIndex: number; rationale: string; newDirection?: string }>(
    config,
    [{ role: 'system', content: NAVIGATOR_PROMPT }, { role: 'user', content: buildNavigatorPrompt(ctx) }],
  );
  const focusIdx = navResult?.focusCandidateIndex ?? 0;
  const focused = ctx.record.candidates[focusIdx] ?? ctx.record.candidates[0];

  // 2. Diagnoser：生成根因假设
  const diagResult = await chatJson<{ rootCause: string; confidence: number; evidence: string[]; alternativeRootCause?: string }>(
    config,
    [{ role: 'system', content: DIAGNOSER_PROMPT }, { role: 'user', content: buildDiagnoserPrompt(ctx, focused, navResult?.newDirection) }],
  );
  if (!diagResult || !diagResult.rootCause) return null;

  // 3. Verifier：反事实对抗验证（复用 repair-agent）
  const diagnosisInput: DiagnosisInput = {
    symptom: String(ctx.record.symptom.observed),
    stackTrace: ctx.resolvedStack?.join('\n'),
    rootCause: diagResult.rootCause,
    evidence: diagResult.evidence ?? [],
    codeSlice: ctx.codeSlices.map(c => c.content).join('\n\n'),
  };
  const verification = await verifyAdversarially(config, diagnosisInput);

  // 4. 残差融合
  const deterministicConf = focused?.confidence ?? 0.5;
  const llmConf = diagResult.confidence ?? 0.5;
  const residual = Math.abs(deterministicConf - llmConf);
  // 融合：几何平均 - 残差惩罚；Verifier 否决则大幅降权
  let fused = Math.sqrt(deterministicConf * llmConf) - 0.3 * residual;
  if (verification.refuted) fused *= 0.3;
  fused = Math.max(0, Math.min(0.9, fused)); // LLM-RCA 封顶 0.9（不100%信任）

  const candidate: AttributionCandidate = {
    kind: 'llm_rca',
    confidence: fused,
    evidence: [
      `LLM root cause: ${diagResult.rootCause}`,
      `deterministic conf=${deterministicConf.toFixed(2)}, llm conf=${llmConf.toFixed(2)}, residual=${residual.toFixed(2)}`,
      `verifier: ${verification.refuted ? 'REFUTED' : 'accepted'} (${verification.reason})`,
      ...(diagResult.evidence ?? []),
    ],
    anchors: focused?.anchors ?? {},
    suggestedHealIds: [],
  };

  return {
    candidate,
    verification: { refuted: verification.refuted, reason: verification.reason, confidence: verification.confidence },
    residual,
    fusedConfidence: fused,
  };
}

/**
 * 把 LLM-RCA 候选并入 AttributionRecord.candidates，按置信度重排。
 */
export function mergeLlmRca(record: AttributionRecord, result: LlmRcaResult): AttributionRecord {
  const candidates = [...record.candidates, result.candidate];
  candidates.sort((a, b) => b.confidence - a.confidence);
  return { ...record, candidates };
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildNavigatorPrompt(ctx: StructuredContext): string {
  const lines: string[] = ['## Symptom', `${ctx.record.symptom.kind}: ${ctx.record.symptom.observed}`];
  lines.push('', '## Ranked Candidate Causes (deterministic + change-correlation)');
  ctx.record.candidates.forEach((c, i) => {
    lines.push(`[${i}] kind=${c.kind} confidence=${c.confidence.toFixed(2)}`);
    c.evidence.forEach(e => lines.push(`    - ${e}`));
  });
  if (ctx.changes && ctx.changes.length > 0) {
    lines.push('', '## Recent Changes');
    ctx.changes.forEach(c => lines.push(`- ${c.kind}: ${c.summary} (release ${c.release ?? '?'})`));
  }
  lines.push('', 'Which candidate should Diagnoser focus on? JSON only.');
  return lines.join('\n');
}

function buildDiagnoserPrompt(ctx: StructuredContext, focused: AttributionCandidate | undefined, newDirection?: string): string {
  const lines: string[] = ['## Focused Candidate'];
  if (focused) {
    lines.push(`kind=${focused.kind}, confidence=${focused.confidence.toFixed(2)}`);
    focused.evidence.forEach(e => lines.push(`- ${e}`));
  }
  if (newDirection) lines.push('', '## Navigator New Direction', newDirection);
  if (ctx.resolvedStack && ctx.resolvedStack.length > 0) {
    lines.push('', '## Resolved Stack', '```', ctx.resolvedStack.join('\n'), '```');
  }
  if (ctx.codeSlices.length > 0) {
    lines.push('', '## Code Slices');
    ctx.codeSlices.forEach(c => lines.push(`### ${c.path}`, '```', c.content.slice(0, 4000), '```'));
  }
  lines.push('', 'Produce a precise root-cause hypothesis. JSON only.');
  return lines.join('\n');
}

export { buildNavigatorPrompt, buildDiagnoserPrompt };
export type { ChatMessage };