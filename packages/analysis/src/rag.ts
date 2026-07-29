/**
 * @monit/analysis/rag - 本地 hash 向量 RAG（djb2 词袋余弦，免 ChromaDB 服务）
 *
 * 移植 monitor-sdk code-rag 的本地 embedding 思路（不依赖外部向量库）：
 * - AST/正则函数级切片 -> djb2 hash 词袋向量（512 维）
 * - 余弦相似度检索相关函数
 * 用于 LLM-RCA/analysis 的 retrieve 节点：给 LLM 喂相关代码片段，而非全仓库。
 */

export interface CodeSlice {
  filePath: string;
  functionName: string;
  code: string;
  startLine: number;
}

const DIM = 512;

/** djb2 -> [0, DIM) 桶 */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return Math.abs(h) % DIM;
}

/** tokenize -> 词袋 hash 向量（归一化） */
export function embed(text: string): Float32Array {
  const vec = new Float32Array(DIM);
  const tokens = text.toLowerCase().split(/[^a-z0-9_$]+/i).filter((t) => t.length > 1);
  for (const t of tokens) vec[hash(t)] += 1;
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += a[i] * b[i];
  return dot; // 已归一化，dot = cosine
}

export class CodeRag {
  private slices: CodeSlice[] = [];
  private vectors: Float32Array[] = [];

  /** 按函数切片索引一个源文件（正则，轻量；不引 ts-morph） */
  indexFile(filePath: string, source: string): number {
    const count = this.sliceFunctions(source);
    for (const fn of count) {
      this.slices.push({ filePath, functionName: fn.name, code: fn.body, startLine: fn.line });
      this.vectors.push(embed(`${fn.name} ${fn.body}`));
    }
    return count.length;
  }

  private sliceFunctions(source: string): Array<{ name: string; body: string; line: number }> {
    const out: Array<{ name: string; body: string; line: number }> = [];
    const lines = source.split('\n');
    const re = /(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?\(?|\s*\()/;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (!m) continue;
      // 取到下一个同等缩进或文件尾为函数体（粗略 ±20 行）
      const body = lines.slice(i, Math.min(i + 25, lines.length)).join('\n');
      out.push({ name: m[1], body, line: i + 1 });
    }
    return out;
  }

  /** 检索 top-k 相关函数 */
  retrieve(query: string, k = 3): CodeSlice[] {
    if (this.vectors.length === 0) return [];
    const qv = embed(query);
    const scored = this.vectors.map((v, i) => ({ i, score: cosine(qv, v) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).filter((s) => s.score > 0.05).map((s) => this.slices[s.i]);
  }

  size(): number { return this.slices.length; }

  clear(): void { this.slices = []; this.vectors = []; }
}

/** 按还原后的栈帧直接读源码片段（比 RAG 更精确，知道确切文件+行） */
export function extractSnippets(
  frames: Array<{ source: string | null; line: number | null }>,
  readFile: (path: string) => string | null,
  contextLines = 10,
): CodeSlice[] {
  const out: CodeSlice[] = [];
  const seen = new Set<string>();
  for (const f of frames) {
    if (!f.source || !f.line) continue;
    if (f.source.includes('node_modules')) continue;
    const content = readFile(f.source);
    if (content === null) continue;
    const key = `${f.source}:${f.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = content.split('\n');
    const start = Math.max(0, f.line - contextLines);
    const end = Math.min(lines.length, f.line + contextLines);
    out.push({ filePath: f.source, functionName: `<frame@${f.line}>`, code: lines.slice(start, end).join('\n'), startLine: start + 1 });
  }
  return out;
}
