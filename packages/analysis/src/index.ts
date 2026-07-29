/**
 * @monit/analysis - 5 节点 RCA 管线 + 本地 RAG
 *
 * resolve(sourcemap) → reindex(RAG) → retrieve(代码片段) → analyst(LLM 根因+修复) → review(LLM 审查)
 * 移植 monitor-sdk analysis.graph 结构（顺序执行器替代 LangGraph）+ code-rag 本地 embedding（免 ChromaDB）。
 */

export { AnalysisPipeline, type AnalysisInput, type AnalysisResult, type ResolvedFrame } from './pipeline';
export { CodeRag, extractSnippets, embed, cosine, type CodeSlice } from './rag';
