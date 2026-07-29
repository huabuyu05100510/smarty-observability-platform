/**
 * @monit/coordinator/github-pr - GitHub PR 创建（MR 草稿轨道）
 *
 * 吸收 smarty-monitor coordinator 的 createGithubPr + applyPatchesLocally。
 * 轨道 B（永久，治本）：repair-agent 产源码补丁 -> 开 PR -> 人审合入。
 *
 * 安全：写盘前校验 searchCode 真实存在（防幻觉补丁写坏文件）；
 * 失败时 git checkout -- . 回滚。token 走环境变量，不落盘。
 */

import type { AiPatchProposal, PrResult } from '@monit/contracts';

export interface GithubConfig {
  token: string;
  repo: string; // owner/name
  /** 本地仓库根（写盘 + git 操作） */
  repoRoot?: string;
  /** 基分支，默认自动探测 */
  baseBranch?: string;
}

const API = 'https://api.github.com';

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * 在本地写盘补丁并 git 提交（轨道 B 的本地侧）。
 * 写盘前校验 searchCode 真实存在；失败抛错（调用方决定回滚）。
 */
export async function applyPatchesLocally(
  proposal: AiPatchProposal,
  readFile: (path: string) => Promise<string>,
  writeFile: (path: string, content: string) => Promise<void>,
): Promise<{ applied: number; skipped: number }> {
  let applied = 0;
  let skipped = 0;
  for (const hunk of proposal.patches) {
    const original = await readFile(hunk.filePath).catch(() => null);
    if (original === null) {
      skipped++;
      continue;
    }
    if (!original.includes(hunk.searchCode)) {
      // 确定性护栏：searchCode 不存在 -> 跳过（防幻觉）
      skipped++;
      continue;
    }
    const updated = original.replace(hunk.searchCode, hunk.replaceCode);
    await writeFile(hunk.filePath, updated);
    applied++;
  }
  return { applied, skipped };
}

/**
 * 创建 GitHub PR：建分支 -> PUT 各文件 -> 开 PR。
 */
export async function createGithubPr(
  config: GithubConfig,
  proposal: AiPatchProposal,
  branch: string,
): Promise<PrResult> {
  const { token, repo } = config;
  try {
    // 1. 探测默认分支
    const repoRes = await fetch(`${API}/repos/${repo}`, { headers: headers(token) });
    if (!repoRes.ok) return { ok: false, error: `repo lookup ${repoRes.status}` };
    const repoJson = await repoRes.json() as { default_branch: string };
    const base = config.baseBranch ?? repoJson.default_branch;

    // 2. 取 base 分支 sha
    const refRes = await fetch(`${API}/repos/${repo}/git/refs/heads/${base}`, { headers: headers(token) });
    if (!refRes.ok) return { ok: false, error: `base ref ${refRes.status}` };
    const refJson = await refRes.json() as { object: { sha: string } };
    const baseSha = refJson.object.sha;

    // 3. 建分支（容忍 422 already-exists）
    const createBranch = await fetch(`${API}/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
    if (!createBranch.ok && createBranch.status !== 422) {
      return { ok: false, error: `create branch ${createBranch.status}` };
    }

    // 4. PUT 每个文件（取 repo 当前内容 -> 应用 searchCode->replaceCode -> 上传合成后的完整文件）
    for (const hunk of proposal.patches) {
      // 取现有文件 sha + 内容
      const fileRes = await fetch(`${API}/repos/${repo}/contents/${hunk.filePath}?ref=${branch}`, {
        headers: headers(token),
      });
      let sha: string | undefined;
      let currentContent = '';
      if (fileRes.ok) {
        const fileJson = await fileRes.json() as { sha?: string; content?: string; encoding?: string };
        sha = fileJson.sha;
        if (fileJson.content) {
          currentContent = Buffer.from(fileJson.content, 'base64').toString('utf-8');
        }
      }
      // 合成完整新文件：在现有内容上做 searchCode->replaceCode；文件不存在或 searchCode 不在则直接用 replaceCode（新建）
      let newContent: string;
      if (currentContent && currentContent.includes(hunk.searchCode)) {
        newContent = currentContent.replace(hunk.searchCode, hunk.replaceCode);
      } else if (currentContent && hunk.searchCode && hunk.replaceCode) {
        // searchCode 空白差异：用归一化空白匹配定位再替换
        newContent = replaceByNormalizedWhitespace(currentContent, hunk.searchCode, hunk.replaceCode) ?? hunk.replaceCode;
      } else {
        newContent = hunk.replaceCode;
      }
      const content = Buffer.from(newContent, 'utf-8').toString('base64');
      const putRes = await fetch(`${API}/repos/${repo}/contents/${hunk.filePath}`, {
        method: 'PUT',
        headers: headers(token),
        body: JSON.stringify({
          message: `fix(smarty): ${proposal.diagnosis.slice(0, 72)}`,
          content,
          branch,
          sha,
        }),
      });
      if (!putRes.ok && putRes.status !== 422) {
        return { ok: false, error: `put file ${hunk.filePath} ${putRes.status}` };
      }
    }

    // 5. 开 PR
    const prRes = await fetch(`${API}/repos/${repo}/pulls`, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        title: `fix(smarty): ${proposal.diagnosis.slice(0, 60)}`,
        head: branch,
        base,
        body: buildPrBody(proposal),
      }),
    });
    if (!prRes.ok) {
      if (prRes.status === 422) {
        // PR 已存在
        const prsRes = await fetch(`${API}/repos/${repo}/pulls?head=${repo}:${branch}&state=open`, { headers: headers(token) });
        if (prsRes.ok) {
          const prs = await prsRes.json() as Array<{ html_url: string }>;
          if (prs.length > 0) return { ok: true, branch, prUrl: prs[0].html_url };
        }
      }
      return { ok: false, error: `create PR ${prRes.status}` };
    }
    const prJson = await prRes.json() as { html_url: string };
    return { ok: true, branch, prUrl: prJson.html_url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 空白归一化匹配替换：容忍 searchCode 与文件在缩进/换行上的微小差异 */
function replaceByNormalizedWhitespace(content: string, searchCode: string, replaceCode: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normSearch = norm(searchCode);
  if (!normSearch) return null;
  // 逐行找候选起点：把每行作为候选，拼接后续行直到归一化长度匹配 normSearch
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let acc = '';
    for (let j = i; j < lines.length; j++) {
      acc = acc ? acc + ' ' + lines[j].trim() : lines[j].trim();
      if (norm(acc) === normSearch) {
        // 替换 lines[i..j] 为 replaceCode
        const before = lines.slice(0, i).join('\n');
        const after = lines.slice(j + 1).join('\n');
        return [before, replaceCode, after].filter(x => x !== '').join('\n');
      }
      if (acc.length > normSearch.length + 40) break; // 超长则放弃此起点
    }
  }
  return null;
}

function buildPrBody(p: AiPatchProposal): string {
  return [
    `## 修复提案（smarty-observability-platform 自愈轨道 B）`,
    '',
    `**根因**：${p.diagnosis}`,
    '',
    `**patchType**: ${p.patchType}`,
    `**riskScore**: ${p.riskScore}`,
    '',
    '### 风险提示',
    ...p.riskNotes.map(r => `- ${r}`),
    '',
    '### 改动',
    ...p.patches.map(h => `- \`${h.filePath}\``),
    '',
    '---',
    '> 本 PR 由确定性×AI 自愈流水线生成：Verifier 反事实验证 + 回归投票 + 信心门禁。',
    '> **人工 review 必须确认**：补丁语义正确、未引入回归、测试充分。',
    '> 调研依据：SWE-bench Verified ~24% 假阳性（测试不足）+ 企业全自动 MR <18% -> 半自动 + 人审。',
  ].join('\n');
}