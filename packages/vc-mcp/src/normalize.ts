// normalize.ts · sourcemap sources[] → 仓库相对路径(纯函数,零 fs/零依赖)
// ----------------------------------------------------------------------------
// 扩展还原的 source 字段是 sourcemap 的 sources[] 条目。它不保证是干净的仓库相对路径:
// 可能是 `webpack:///./src/Foo.tsx`、`/src/Foo.tsx`、`src/Foo.tsx`,甚至 `webpack-internal:///...`。
// apply 前必须归一,否则找不到真实文件。归一是 best-effort:解析不了就把候选原样交回,
// 让 agent 用 Grep 按 symbol/search 片段兜底 —— 这是设计的优雅降级,不是失败。

/** 剥 webpack/协议/前导点斜杠 → 仓库相对候选。不可解析(纯 webpack 内部)返回 ''。 */
export function normalizeSourcePath(raw: string): string {
  let s = String(raw || '').trim();
  // 1. webpack 协议前缀(含 webpack-internal:///)
  s = s.replace(/^webpack-internal:\/\/\/?/, '').replace(/^webpack:\/\/\/?/, '');
  // 2. webpack 内部运行时条目 → 不可解析(无对应源文件)
  if (s.startsWith('(webpack)') || s.includes('__webpack_require__') || s.includes('hot-loader')) return '';
  // 3. 通用协议(http(s)://host, file://)→ 仅留 pathname
  s = s.replace(/^(?:https?|file):\/\/[^/]*\//, '');
  // 4. 打包器缓存噪音(node_modules/.cache/...)
  s = s.replace(/^node_modules\/\.cache\/[^/]+\//, '');
  // 5. 前导 ./ ../ (反复剥)
  while (s.startsWith('./')) s = s.slice(2);
  while (s.startsWith('../')) s = s.slice(3);
  // 6. 前导 /(仓库内绝对惯例)
  if (s.startsWith('/')) s = s.slice(1);
  return s.trim();
}

/** 全部候选,优先级:归一值优先,原始值兜底。去重。 */
export function pathCandidates(raw: string): string[] {
  const out: string[] = [];
  const n = normalizeSourcePath(raw);
  if (n) out.push(n);
  const v = String(raw || '').trim();
  if (v && v !== n) out.push(v);
  return out;
}

/**
 * 在 exists 回调判定下挑首个命中的候选。
 * exists 由调用方(apply.ts)闭包 fs + path.join 提供,故本函数纯可测(注入 fake exists)。
 * 返回命中的「仓库相对路径」(用于 PatchHunk.filePath / unified diff),未命中 null。
 */
export function resolveRepoFile(
  candidates: string[],
  exists: (candidateRel: string) => boolean,
): { path: string } | null {
  for (const c of candidates) {
    if (c && exists(c)) return { path: c };
  }
  return null;
}
