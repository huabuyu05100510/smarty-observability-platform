/**
 * @monit/guardrails/test-sufficiency - 测试充分性护栏
 *
 * 研究依据（2026-07 调研 §1a/§2.2）：
 * - SWE-bench Verified ~24% 假阳性的根因 = 测试不足（UTBoost 15.7% 通过原测试的补丁
 *   在增强测试上失败）+ OpenAI 审计 59.4% 测试设计缺陷（narrow/wide）。
 * - "通过测试 ≠ 真正修复"。本护栏在补丁合入前评估测试是否充分覆盖被改代码，
 *   不足则降信心分、转人工（不阻断合入，但触发"测试增强"建议）。
 *
 * 启发式（不引入 AST 依赖，P1 轻量版）：
 * 1. 是否存在对应测试文件（同名 .test/.spec）
 * 2. 改动的函数名是否被测试引用
 * 3. 改动行数 vs 测试行数比
 * 真实环境可替换为 AST 精确覆盖（ts-morph）。
 */

import type { AiPatchProposal } from '@monit/contracts';

export interface TestSufficiencyInput {
  proposal: AiPatchProposal;
  /** 仓库内所有测试文件路径 + 内容（轻量：仅取相关） */
  testFiles: Array<{ path: string; content: string }>;
  /** 改动前的源码（用于提取被改函数名） */
  sourceFiles: Array<{ path: string; content: string }>;
}

export interface TestSufficiencyResult {
  /** 测试充分性 0-1（0=无覆盖，1=充分覆盖） */
  sufficiency: number;
  /** 是否充分（>= 阈值） */
  sufficient: boolean;
  reasons: string[];
  /** 建议增强的测试目标（函数名） */
  uncoveredTargets: string[];
}

const SUFFICIENCY_THRESHOLD = 0.5;

/** 从源码中提取函数名（轻量正则，P1 不引入 AST） */
export function extractFunctionNames(source: string): string[] {
  const names = new Set<string>();
  // function foo( / const foo = ( / foo( / class Foo { foo(
  const patterns = [
    /function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?/g,
    /([A-Za-z_$][\w$]*)\s*\(.*\)\s*\{/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1];
      if (name && !['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(name)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/** 找到包含 searchCode 片段的函数名（被改动的函数） */
export function findChangedFunctions(source: string, searchCode: string): string[] {
  if (!source.includes(searchCode)) return [];
  // 取 searchCode 所在位置前最近的函数定义
  const idx = source.indexOf(searchCode);
  const before = source.slice(0, idx);
  const funcNames = extractFunctionNames(before);
  return funcNames.slice(-3); // 最近 3 个候选
}

/**
 * 评估测试充分性。
 */
export function assessTestSufficiency(input: TestSufficiencyInput): TestSufficiencyResult {
  const reasons: string[] = [];
  const uncovered: string[] = [];
  let score = 0;

  const changedFuncs = new Set<string>();
  for (const hunk of input.proposal.patches) {
    const src = input.sourceFiles.find(f => f.path === hunk.filePath);
    if (!src) continue;
    for (const fn of findChangedFunctions(src.content, hunk.searchCode)) {
      changedFuncs.add(fn);
    }
  }

  // 1. 是否存在对应测试文件（按文件基名匹配）
  const relevantTests = input.testFiles.filter(t =>
    input.proposal.patches.some(h => {
      const base = hunkBaseName(h.filePath).replace(/\.(ts|tsx|js|jsx)$/, '');
      return t.path.includes(base);
    }),
  );

  if (relevantTests.length > 0) {
    score += 0.3;
    reasons.push(`found ${relevantTests.length} test file(s) for changed code`);
  } else {
    reasons.push('NO test file covers the changed code');
  }

  // 2. 改动函数是否被测试引用
  if (changedFuncs.size === 0) {
    // 改动不在命名函数内（顶层/模块级），降权
    reasons.push('change is not inside a named function (module-level) - harder to test');
  } else {
    const testContent = relevantTests.map(t => t.content).join('\n');
    let coveredCount = 0;
    for (const fn of changedFuncs) {
      if (testContent.includes(fn)) {
        coveredCount++;
      } else {
        uncovered.push(fn);
      }
    }
    const coverage = changedFuncs.size > 0 ? coveredCount / changedFuncs.size : 0;
    score += 0.5 * coverage;
    reasons.push(`changed functions tested: ${coveredCount}/${changedFuncs.size}`);
  }

  // 3. 改动行数 vs 测试存在性（改动越大越需要测试）
  const changedLines = input.proposal.patches.reduce(
    (sum, h) => sum + h.replaceCode.split('\n').length,
    0,
  );
  if (changedLines <= 20 && relevantTests.length > 0) {
    score += 0.2;
    reasons.push(`small change (${changedLines} lines) with tests`);
  } else if (changedLines > 50 && relevantTests.length === 0) {
    reasons.push(`LARGE change (${changedLines} lines) with NO tests - high false-positive risk`);
  }

  const sufficiency = Math.min(1, score);
  return {
    sufficiency,
    sufficient: sufficiency >= SUFFICIENCY_THRESHOLD,
    reasons,
    uncoveredTargets: uncovered,
  };
}

function hunkBaseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}