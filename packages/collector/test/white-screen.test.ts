import { describe, it, expect } from 'vitest';
import { classifyWhiteScreen, type WhiteScreenContext } from '../src/white-screen';

const ctx = (errors: any[] = [], resources: any[] = []): WhiteScreenContext => ({
  recentErrors: () => errors,
  failedResources: () => resources,
});

describe('classifyWhiteScreen（白屏分类 + 因果归因）', () => {
  it('validRatio 高 -> 不白屏', () => {
    const d = classifyWhiteScreen(0.9, '17', ctx(), 1000);
    expect(d.detected).toBe(false);
    expect(d.type).toBe('unknown');
  });

  it('白屏 + 窗口内关键资源 404 -> critical_resource_blocked + 因果资源', () => {
    const d = classifyWhiteScreen(0.0, '17', ctx([], [
      { url: 'https://x/app.js', tagName: 'script', timestamp: 900 },
    ]), 1000);
    expect(d.detected).toBe(true);
    expect(d.type).toBe('critical_resource_blocked');
    expect(d.rootCause).toBe('resource_404');
    expect(d.causalResourceUrl).toBe('https://x/app.js');
  });

  it('白屏 + 窗口内 JS 错误 -> crashed_render + 因果 errorId', () => {
    const d = classifyWhiteScreen(0.0, '17', ctx([
      { id: 'err-1', message: 'TypeError boom', type: 'js', timestamp: 950 },
    ]), 1000);
    expect(d.type).toBe('crashed_render');
    expect(d.rootCause).toBe('js_error');
    expect(d.causalErrorId).toBe('err-1');
  });

  it('关键资源优先于 JS 错误（CSS/JS 没加载更可能是根因）', () => {
    const d = classifyWhiteScreen(0.0, '17', ctx(
      [{ id: 'err-1', message: 'boom', type: 'js', timestamp: 950 }],
      [{ url: 'https://x/app.css', tagName: 'link', timestamp: 940 }],
    ), 1000);
    expect(d.type).toBe('critical_resource_blocked');
    expect(d.causalResourceUrl).toBe('https://x/app.css');
  });

  it('白屏 + 无 error/resource + body 空 -> blank_dom', () => {
    const d = classifyWhiteScreen(0.0, '17', ctx(), 1000);
    // jsdom 默认 body 可能空 -> blank_dom；若非空则 route_404。两者都算"无因果"
    expect(d.detected).toBe(true);
    expect(['blank_dom', 'route_404']).toContain(d.type);
    expect(d.causalErrorId).toBeUndefined();
  });

  it('窗口外的 error 不算因果（时序归因）', () => {
    const d = classifyWhiteScreen(0.0, '17', ctx([
      { id: 'old', message: 'old', type: 'js', timestamp: 100 },
    ]), 1000, 500); // 窗口 500ms，old@100 在窗口外
    expect(d.causalErrorId).toBeUndefined();
    // old 被过滤后无 error -> blank_dom 或 route_404
    expect(['blank_dom', 'route_404']).toContain(d.type);
  });

  it('non-critical 资源（img）不触发 critical_resource_blocked', () => {
    const d = classifyWhiteScreen(0.0, '17', ctx([], [
      { url: 'https://x/banner.png', tagName: 'img', timestamp: 950 },
    ]), 1000);
    expect(d.type).not.toBe('critical_resource_blocked');
    expect(d.causalResourceUrl).toBeUndefined();
  });

  it('recentErrors/failedResources 返回窗口内条目', () => {
    const d = classifyWhiteScreen(0.0, '17', ctx(
      [{ id: 'e1', message: 'a', type: 'js', timestamp: 950 }],
      [{ url: 'u', tagName: 'script', timestamp: 950 }],
    ), 1000);
    expect(d.recentErrors.length).toBe(1);
    expect(d.failedResources.length).toBe(1);
  });
});
