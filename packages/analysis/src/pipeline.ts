/**
 * @monit/analysis/pipeline - 5 节点 RCA 管线（resolve→reindex→retrieve→analyst→review）
 *
 * 移植 monitor-sdk analysis.graph.ts 的图结构（去 @langchain 依赖，用顺序执行器）。
 * 节点：resolve(sourcemap) → reindex(RAG 索引) → retrieve(代码片段) → analyst(LLM 根因+修复) → review(LLM 审查)。
 * review 节点对标 monitor-sdk 的二次 LLM 批判（防 analyst 幻觉）。
 */

import type { LLMConfig } from '@monit/repair-agent';
import { chat, type ChatMessage } from '@monit/repair-agent';
import { CodeRag, extractSnippets, type CodeSlice } from './rag';

export interface ResolvedFrame {
  source: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
  resolved: boolean;
}

export interface AnalysisInput {
  appId: string;
  version: string;
  /** 原始错误（message + 压缩栈） */
  rawError: { message: string; stack?: string };
  /** 源码根（用于直接读代码片段；不传则退化到 RAG） */
  sourceRoot?: string;
  /** sourcemap 还原器（resolve 节点用） */
  resolveStack: (appId: string, version: string, stack: string) => ResolvedFrame[];
  /** 文件读取（retrieve 节点直接读源码用） */
  readFile: (path: string) => string | null;
  /** RAG 索引的源码（可选；sourceRoot 有时直接读更精确） */
  indexSources?: Array<{ path: string; content: string }>;
}

export interface AnalysisResult {
  resolvedStack: ResolvedFrame[];
  relatedCode: CodeSlice[];
  diagnosis: string;
  fix: string;
  review: string;
  warnings: string[];
}

export class AnalysisPipeline {
  private rag = new CodeRag();
  private indexed = false;

  constructor(private llmConfig: LLMConfig) {}

  /** 索引源码到 RAG（reindex 节点） */
  reindex(sources: Array<{ path: string; content: string }>): { files: number; slices: number } {
    let slices = 0;
    for (const s of sources) slices += this.rag.indexFile(s.path, s.content);
    this.indexed = true;
    return { files: sources.length, slices };
  }

  /** 运行 5 节点管线 */
  async run(input: AnalysisInput): Promise<AnalysisResult> {
    const warnings: string[] = [];

    // ── 1. resolve：sourcemap 还原压缩栈 ──
    let resolvedStack: ResolvedFrame[] = [];
    if (input.rawError.stack) {
      try {
        resolvedStack = input.resolveStack(input.appId, input.version, input.rawError.stack);
        resolvedStack = resolvedStack.filter((f) => f.source && !f.source.includes('node_modules'));
      } catch (e) {
        warnings.push(`sourcemap resolve failed: ${(e as Error).message}`);
      }
    } else {
      warnings.push('no stack trace');
    }

    // ── 2. reindex：若提供 indexSources 则索引（一次性） ──
    if (!this.indexed && input.indexSources && input.indexSources.length > 0) {
      const r = this.reindex(input.indexSources);
      warnings.push(`RAG indexed ${r.slices} slices from ${r.files} files`);
    }

    // ── 3. retrieve：优先直接读栈帧源码，否则 RAG ──
    let relatedCode: CodeSlice[] = [];
    if (input.sourceRoot || resolvedStack.some((f) => f.source)) {
      relatedCode = extractSnippets(resolvedStack, input.readFile);
    }
    if (relatedCode.length === 0) {
      const query = `${input.rawError.message} ${resolvedStack.map((f) => f.source).join(' ')}`;
      relatedCode = this.rag.retrieve(query, 3);
    }

    // ── 4. analyst：LLM 根因 + 修复 ──
    const analystPrompt = buildAnalystPrompt(input.rawError, resolvedStack, relatedCode);
    const analystRes = await chat(this.llmConfig, [
      { role: 'system', content: '你是一名资深前端工程师，擅长根因分析和 TypeScript/React 代码审查。基于堆栈和相关源码给出根因与修复。' },
      { role: 'user', content: analystPrompt },
    ]);
    const { diagnosis, fix } = parseAnalyst(analystRes.content);

    // ── 5. review：LLM 二次审查（防 analyst 幻觉） ──
    const reviewRes = await chat(this.llmConfig, [
      { role: 'system', content: '你是代码审查者，批判性检查根因分析与修复是否准确、可行、符合最佳实践。1-2 句。' },
      { role: 'user', content: buildReviewPrompt(diagnosis, fix) },
    ]);

    return { resolvedStack, relatedCode, diagnosis, fix, review: reviewRes.content.trim(), warnings };
  }
}

function buildAnalystPrompt(
  rawError: { message: string; stack?: string },
  resolvedStack: ResolvedFrame[],
  relatedCode: CodeSlice[],
): string {
  const stackText = resolvedStack
    .filter((f) => f.source)
    .map((f) => `  ${f.source}:${f.line}:${f.column}  ${f.name ?? ''}`)
    .join('\n');
  const codeText = relatedCode.length > 0
    ? relatedCode.map((c) => `// ${c.filePath}\n${c.code}`).join('\n\n---\n\n')
    : '（未检索到相关源码，仅根据堆栈分析）';
  return `## 错误\n${rawError.message}\n\n## 还原栈\n${stackText || '（未还原）'}\n\n## 相关源码\n${codeText}\n\n用 ===DIAGNOSIS=== 和 ===FIX=== 两段输出根因与修复（每段纯文本）。`;
}

function buildReviewPrompt(diagnosis: string, fix: string): string {
  return `检查以下根因与修复是否合理（1-2 句）：\n===DIAGNOSIS===\n${diagnosis}\n\n===FIX===\n${fix}`;
}

function parseAnalyst(text: string): { diagnosis: string; fix: string } {
  const dMatch = text.match(/===DIAGNOSIS===\s*([\s\S]*?)(?:===FIX===|$)/);
  const fMatch = text.match(/===FIX===\s*([\s\S]*?)$/);
  return { diagnosis: (dMatch?.[1] ?? text).trim(), fix: (fMatch?.[1] ?? '').trim() };
}

export { chat, type ChatMessage };
