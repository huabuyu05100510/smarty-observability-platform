/**
 * @monit/guardrails/contamination - 数据污染检测（前瞻护栏）
 *
 * 研究依据（2026-07 调研 §2.2）：
 * - SWE-bench Verified 全前沿模型（GPT-5.2-Chat / Claude Opus 4.5 / Gemini 3 Flash）
 *   数据污染 -- 逐字复现 gold patch，分数膨胀不再反映真实自主修复能力。
 * - OpenAI 因此弃用 Verified；新基准（SWE-bench Pro / MorphLLM）采用 contamination auditor agent。
 *
 * 本护栏：补丁生成后，对照自建回归集的 gold patch，检测是否逐字/近似复现。
 * 命中则标记 contaminated，降信心分（污染 patch 通过测试不代表真实修复能力）。
 */

export interface ContaminationInput {
  /** 补丁的 replaceCode */
  patchCode: string;
  /** 自建回归集的 gold patch 列表 */
  goldPatches: string[];
  /** 相似度阈值（0-1），默认 0.85 */
  threshold?: number;
}

export interface ContaminationResult {
  contaminated: boolean;
  /** 最高相似度 0-1 */
  similarity: number;
  /** 命中的 gold patch 索引（-1 = 无） */
  matchedIndex: number;
  /** 检测方式 */
  method: 'verbatim' | 'near-duplicate' | 'none';
}

/** tokenize：按非单词字符切分，小写，过滤短 token */
function tokenize(code: string): string[] {
  return code
    .toLowerCase()
    .split(/[^a-z0-9_$]+/i)
    .filter(t => t.length > 1);
}

/** Jaccard token 相似度 */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return inter / union;
}

/** 规范化（去空白/注释）用于 verbatim 检测 */
function normalize(code: string): string {
  return code
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 检测补丁是否污染（复现 gold patch）。
 * 两级检测：verbatim（规范化后包含/相等）+ near-duplicate（Jaccard）。
 */
export function detectContamination(input: ContaminationInput): ContaminationResult {
  const threshold = input.threshold ?? 0.85;
  const patchNorm = normalize(input.patchCode);
  const patchTokens = tokenize(input.patchCode);

  let bestSim = 0;
  let bestIdx = -1;
  let method: ContaminationResult['method'] = 'none';

  for (let i = 0; i < input.goldPatches.length; i++) {
    const gold = input.goldPatches[i];

    // 1. verbatim：规范化后相等或包含
    const goldNorm = normalize(gold);
    if (patchNorm.length > 20 && (patchNorm === goldNorm || patchNorm.includes(goldNorm) || goldNorm.includes(patchNorm))) {
      return {
        contaminated: true,
        similarity: 1,
        matchedIndex: i,
        method: 'verbatim',
      };
    }

    // 2. near-duplicate：token Jaccard
    const sim = jaccard(patchTokens, tokenize(gold));
    if (sim > bestSim) {
      bestSim = sim;
      bestIdx = i;
      method = 'near-duplicate';
    }
  }

  return {
    contaminated: bestSim >= threshold,
    similarity: bestSim,
    matchedIndex: bestSim >= threshold ? bestIdx : -1,
    method: bestSim >= threshold ? method : 'none',
  };
}