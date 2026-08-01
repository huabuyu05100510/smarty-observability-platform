// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installBehavior } from '../src/behavior';
import type { FrustrationSignal } from '@monit/contracts';

describe('installBehavior（行为沮丧信号）', () => {
  let signals: FrustrationSignal[];
  let uninstall: () => void = () => {};

  beforeEach(() => {
    uninstall(); // 清上一个 test 的监听，避免堆叠
    document.body.innerHTML = '';
    signals = [];
    uninstall = installBehavior({ onFrustration: (s) => signals.push(s) }, {
      rageClickCount: 3,
      rageClickWindowMs: 1000,
    });
  });

  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  it('dead click：点击不可交互元素 -> dead_click', () => {
    const div = document.createElement('div');
    div.id = 'info';
    document.body.appendChild(div);
    click(div);
    expect(signals.some(s => s.kind === 'dead_click' && s.target.includes('div#info'))).toBe(true);
  });

  it('可交互元素（button）不报 dead_click', () => {
    const btn = document.createElement('button');
    btn.id = 'go';
    document.body.appendChild(btn);
    click(btn);
    expect(signals.some(s => s.kind === 'dead_click')).toBe(false);
  });

  it('rage click：同一元素 3 次快击 -> rage_click', () => {
    const btn = document.createElement('button');
    btn.id = 'go';
    document.body.appendChild(btn);
    click(btn); click(btn); click(btn);
    expect(signals.some(s => s.kind === 'rage_click' && s.count >= 3)).toBe(true);
  });

  it('rage click 后重置：再 3 次才再报', () => {
    const btn = document.createElement('button');
    btn.id = 'go';
    document.body.appendChild(btn);
    click(btn); click(btn); click(btn); // 触发一次
    const firstCount = signals.filter(s => s.kind === 'rage_click').length;
    click(btn); // 第 4 次不应立即再报（已重置）
    const afterOneMore = signals.filter(s => s.kind === 'rage_click').length;
    expect(afterOneMore).toBe(firstCount);
  });

  it('role=button 视为可交互（不报 dead_click）', () => {
    const div = document.createElement('div');
    div.id = 'x';
    div.setAttribute('role', 'button');
    document.body.appendChild(div);
    click(div);
    expect(signals.some(s => s.kind === 'dead_click')).toBe(false);
  });

  it('uninstall 移除监听', () => {
    uninstall();
    const div = document.createElement('div');
    document.body.appendChild(div);
    click(div);
    expect(signals.length).toBe(0);
  });
});
