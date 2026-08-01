import { test, expect } from 'vitest';
import { renderList, renderCount } from './renderList.js';

// 现有测试（覆盖正常路径，但不覆盖 null 输入 -> 这正是"测试不足"的假阳性温床）
test('renderList 渲染列表项', () => {
  expect(renderList(['a', 'b'])).toEqual(['<li>a</li>', '<li>b</li>']);
});

test('renderCount 返回长度', () => {
  expect(renderCount(['a', 'b', 'c'])).toBe(3);
});
