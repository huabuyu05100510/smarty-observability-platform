/**
 * 行级 LCS diff —— 计算 searchCode 与 replaceCode 的真实变更行数（added + removed）。
 * 替代"replaceCode 行数"的高估，让门禁的 locality（≤50 行）判定准确。
 * 小 hunk（≤50 行）下 O(n*m) 可接受。
 */
export function countChangedLines(search: string, replace: string): number {
  const a = search.length === 0 ? [] : search.split('\n');
  const b = replace.length === 0 ? [] : replace.split('\n');
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  // dp[i][j] = a[i:] 与 b[j:] 的 LCS 长度（逆向填表，省一维则需保留两行）
  let prev = new Array<number>(m + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array<number>(m + 1).fill(0);
    for (let j = m - 1; j >= 0; j--) {
      cur[j] = a[i] === b[j] ? prev[j + 1] + 1 : Math.max(prev[j], cur[j + 1]);
    }
    prev = cur;
  }
  const lcs = prev[0];
  return (n - lcs) + (m - lcs); // 删除行 + 新增行
}
