// BUG（真实可复现）：items 可能为 null -> 调用 .map 抛 TypeError
// 这是代表作留痕的目标 bug：runRealHealPipeline 应诊断出空值守卫缺失，
// Verifier 反事实验证，生成 repro 测试（null 输入须返回 []），补丁加 (items||[]) 守卫。
export function renderList(items) {
  return items.map((x) => `<li>${x}</li>`);
}

export function renderCount(items) {
  return items.length;
}
