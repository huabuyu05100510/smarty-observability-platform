/**
 * @monit/coordinator/llm-patch - LLM 源码级补丁生成
 *
 * 吸收 smarty-monitor coordinator 的 /ai/patch 逻辑：
 * 收集相关源码上下文 -> LLM 生成 search/replace 补丁 -> 校验。
 *
 * 确定性×AI：LLM 生成补丁（AI），但补丁合入前必须过：
 * - searchCode 必须在目标文件真实存在（确定性校验，防幻觉）
 * - 修复范围限定（仅与错误栈帧相关的文件，±8 行重叠）
 * - 信心门禁 + 测试充分性护栏（@monit/repair-agent/confidence）
 */

import type { AiPatchProposal, PatchHunk, AttributionRecord } from '@monit/contracts';
import { chatJson, type LLMConfig } from '@monit/repair-agent';

export interface PatchContext {
  /** 错误栈帧关联的源文件（已读取） */
  files: Array<{ path: string; content: string }>;
  /** AttributionRecord（根因 + 锚点） */
  record: AttributionRecord;
}

const PATCH_SYSTEM_PROMPT = `You are a frontend repair agent. Given a root-cause attribution and the relevant source files, produce a MINIMAL source-level patch that fixes the issue.

Constraints:
- Only modify files provided in the context.
- Each patch hunk must have filePath + searchCode (exact existing substring) + replaceCode.
- searchCode MUST be a verbatim substring that currently exists in the file (no hallucination).
- Keep changes local and minimal. Prefer guards/null-checks over rewrites.
- Do NOT touch unrelated functions.

Respond ONLY with JSON:
{"diagnosis": string, "patches": [{"filePath": string, "searchCode": string, "replaceCode": string}], "riskNotes": [string], "riskScore": number}`;

/**
 * 生成源码级补丁提案。
 */
export async function generatePatch(
  config: LLMConfig,
  ctx: PatchContext,
): Promise<AiPatchProposal | null> {
  const userContent = buildPrompt(ctx);
  const result = await chatJson<{
    diagnosis: string;
    patches: PatchHunk[];
    riskNotes: string[];
    riskScore: number;
  }>(config, [
    { role: 'system', content: PATCH_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]);

  if (!result || !Array.isArray(result.patches)) return null;

  // 确定性校验：searchCode 必须在目标文件真实存在（防 LLM 幻觉）
  const validated = result.patches.filter(p => {
    if (!p.filePath || !p.searchCode) return false;
    const file = ctx.files.find(f => f.path === p.filePath);
    return file && file.content.includes(p.searchCode);
  });

  if (validated.length === 0) return null;

  return {
    id: `proposal-${Date.now()}`,
    basedOn: ctx.record.id,
    track: 'mr-draft',
    patchType: 'replace', // 源码级补丁默认 replace
    diagnosis: result.diagnosis,
    patches: validated,
    riskNotes: result.riskNotes ?? [],
    riskScore: typeof result.riskScore === 'number' ? result.riskScore : 0.5,
    createdAt: Date.now(),
  };
}

function buildPrompt(ctx: PatchContext): string {
  const lines: string[] = ['## Root Cause Attribution'];
  const cand = ctx.record.candidates[0];
  if (cand) {
    lines.push(`- kind: ${cand.kind} (confidence ${cand.confidence})`);
    lines.push(`- symptom: ${ctx.record.symptom.observed}`);
    for (const e of cand.evidence) lines.push(`  - ${e}`);
  }
  lines.push('', '## Relevant Source Files');
  for (const f of ctx.files) {
    lines.push(`### ${f.path}`, '```', f.content.slice(0, 8000), '```');
  }
  lines.push('', 'Produce a minimal patch. JSON only.');
  return lines.join('\n');
}