// apply.ts · dry-run apply:把 finding 的 search/replace 写进真实仓库工作树
// ----------------------------------------------------------------------------
// 这是 M1 的核心。扩展无构建环境无法把 source diff 灌进线上 bundle → 把 diff 交给 vc-mcp,
// 在 agent 的真实仓库(有源码 + 工具链)里 apply。M1 严格 dry-run:
//   - 写工作树(让 agent 能 `pnpm test`/`tsc` 跑 patched 代码)
//   - 不 git add / commit / push,不需 GitHub token
//   agent review `git diff` + 跑测试 + (人确认后) commit/push/gh pr create。
//
// 幻觉守卫(镜像 @monit/coordinator/github-pr.applyPatchesLocally):search 必须在文件中
// verbatim 命中才写;不命中 → 入 filesUnresolved,文件不动(绝不写半截/错位补丁)。
// replace 用 replacer 函数形式,避免 replaceCode 里的 $&/$1 被当特殊模式(JS 代码常含 $)。
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathCandidates, resolveRepoFile } from './normalize';
import { countChangedLines } from '@monit/server-kit';
import type { VcFinding, VcTarget } from './store';

export interface PatchedFile {
  path: string; // 仓库相对路径(已归一)
  searchFound: true;
  linesChanged: number;
}
export interface UnresolvedFile {
  path: string; // 原始 target.file
  candidates: string[];
  symbol?: string;
  reason: string;
}
export interface ApplyResult {
  filesPatched: PatchedFile[];
  filesUnresolved: UnresolvedFile[];
  unifiedDiff: string;
  mrDraft: { title: string; body: string };
  notes: string[];
}

function hunkDiff(relPath: string, original: string, search: string, replace: string): string {
  // 找 search 首次命中的 1-based 起始行(用于 @@ 头);未命中(理论不会到此)兜底 1。
  const before = original.indexOf(search);
  const startLine = before >= 0 ? original.slice(0, before).split('\n').length : 1;
  const sLines = search.split('\n');
  const rLines = replace.split('\n');
  const lines = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${startLine},${sLines.length} +${startLine},${rLines.length} @@`,
    ...sLines.map((l) => `-${l}`),
    ...rLines.map((l) => `+${l}`),
  ];
  return lines.join('\n');
}

export async function dryRunApply(finding: VcFinding, repoRoot: string): Promise<ApplyResult> {
  const filesPatched: PatchedFile[] = [];
  const filesUnresolved: UnresolvedFile[] = [];
  const diffParts: string[] = [];
  const notes: string[] = [
    'DRY-RUN: files written to working tree; NOT committed/pushed. Run `pnpm test`/`tsc`, then `git add`/`git commit`/`gh pr create`.',
    '幻觉守卫:search 未 verbatim 命中的文件未改动(见 filesUnresolved)。',
  ];

  for (const t of finding.targets) {
    const result = await applyOne(repoRoot, t);
    if (result.kind === 'patched') {
      filesPatched.push({ path: result.relPath, searchFound: true, linesChanged: result.linesChanged });
      diffParts.push(result.diff);
    } else {
      filesUnresolved.push(result.unresolved);
    }
  }

  const title = `fix(smarty): ${String(finding.rootCause || 'AI 自愈补丁').split('\n')[0].slice(0, 60)}`;
  const mrDraft = { title, body: buildMrBody(finding, filesPatched, filesUnresolved) };

  return { filesPatched, filesUnresolved, unifiedDiff: diffParts.join('\n\n'), mrDraft, notes };
}

type ApplyOutcome =
  | { kind: 'patched'; relPath: string; linesChanged: number; diff: string }
  | { kind: 'unresolved'; unresolved: UnresolvedFile };

async function applyOne(repoRoot: string, t: VcTarget): Promise<ApplyOutcome> {
  const candidates = pathCandidates(t.file);
  const unresolvedBase = (reason: string): UnresolvedFile => ({ path: t.file, candidates, symbol: t.symbol, reason });

  if (!t.search) return { kind: 'unresolved', unresolved: unresolvedBase('empty search snippet') };

  const hit = resolveRepoFile(candidates, (c) => existsSync(path.join(repoRoot, c)));
  if (!hit) return { kind: 'unresolved', unresolved: unresolvedBase('file not found under repoRoot(归一/原始候选均不存在;用 symbol/search 片段 grep 兜底)') };

  const full = path.join(repoRoot, hit.path);
  let original: string;
  try {
    original = await fs.readFile(full, 'utf8');
  } catch {
    return { kind: 'unresolved', unresolved: unresolvedBase('read file failed') };
  }
  if (!original.includes(t.search)) {
    return { kind: 'unresolved', unresolved: unresolvedBase('search snippet not found in file(幻觉守卫,未写)') };
  }
  // replacer 函数:避免 replace 中的 $&/$1/$' 特殊语义(JS 代码常含 $)
  const updated = original.replace(t.search, () => t.replace);
  await fs.writeFile(full, updated, 'utf8');
  return {
    kind: 'patched',
    relPath: hit.path,
    linesChanged: countChangedLines(t.search, t.replace),
    diff: hunkDiff(hit.path, original, t.search, t.replace),
  };
}

function buildMrBody(f: VcFinding, patched: PatchedFile[], unresolved: UnresolvedFile[]): string {
  const L: string[] = [];
  L.push('## 根因', f.rootCause || '(未提供)');
  if (f.diff?.explanation) L.push('', '## 修复说明', f.diff.explanation);
  if (f.diff?.risk) L.push('', `**风险**: ${f.diff.risk}${f.diff.riskReason ? ' — ' + f.diff.riskReason : ''}`);
  L.push('', '## 验证(扩展端)', `- Verifier: ${f.verification?.accepted ? '✓ accepted' : '✗ 未接受'} (conf ${(f.verification?.confidence ?? 0)})`);
  L.push('', '## 改动文件');
  if (patched.length) patched.forEach((p) => L.push(`- \`${p.path}\` (${p.linesChanged} 行变化)`));
  else L.push('- (无文件被 patch)');
  if (unresolved.length) {
    L.push('', '## 未解析(需人工定位)', ...unresolved.map((u) => `- \`${u.path}\`${u.symbol ? ' · ' + u.symbol : ''} — ${u.reason}`));
  }
  L.push('', '---', '> 由 Vitals Copilot 扩展 AI 自愈生成,经 vc-mcp dry-run apply 落到工作树。**未 commit/push**;请 review `git diff` + 跑测试后决定是否提交。');
  return L.join('\n');
}
