// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Recorder } from '../src/replay';

describe('Recorder (session replay)', () => {
  it('snapshots full DOM on install', () => {
    document.body.innerHTML = '<div id="a"><p>hello</p></div>';
    const r = new Recorder();
    r.install();
    const snap = r.getSnapshot();
    expect(snap.events.length).toBeGreaterThanOrEqual(1);
    const snapshot = snap.events.find(e => e.type === 'snapshot');
    expect(snapshot).toBeDefined();
    expect(snapshot!.data.nodeType).toBe(1); // html element
    expect(snap.nodeCount).toBeGreaterThan(0);
    r.uninstall();
  });

  it('records DOM mutations', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const r = new Recorder();
    r.install();
    document.getElementById('root')!.innerHTML = '<span>new</span>';
    // 等 MutationObserver 回调（微任务 + 小延时）
    await new Promise(res => setTimeout(res, 30));
    const snap = r.getSnapshot();
    const mutations = snap.events.filter(e => e.type === 'mutation');
    expect(mutations.length).toBeGreaterThanOrEqual(1);
    r.uninstall();
  });

  it('records input with masked value by default (PII safe)', () => {
    document.body.innerHTML = '<input id="i" />';
    const r = new Recorder();
    r.install();
    const input = document.getElementById('i') as HTMLInputElement;
    input.value = 'secret password';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const snap = r.getSnapshot();
    const inputEvt = snap.events.find(e => e.type === 'input') as { data: { masked: boolean; value?: string; valueLength: number } } | undefined;
    expect(inputEvt).toBeDefined();
    expect(inputEvt!.data.masked).toBe(true);
    expect(inputEvt!.data.value).toBeUndefined(); // 明文不上报
    expect(inputEvt!.data.valueLength).toBe('secret password'.length);
    r.uninstall();
  });

  it('records real value when data-monit-record="value"', () => {
    document.body.innerHTML = '<input id="i" data-monit-record="value" />';
    const r = new Recorder();
    r.install();
    const input = document.getElementById('i') as HTMLInputElement;
    input.value = 'visible';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const inputEvt = r.getSnapshot().events.find(e => e.type === 'input') as { data: { masked: boolean; value?: string } };
    expect(inputEvt.data.masked).toBe(false);
    expect(inputEvt.data.value).toBe('visible');
    r.uninstall();
  });

  it('skips SCRIPT/STYLE content', () => {
    document.body.innerHTML = '<script>var x="secret"</script><style>.a{color:red}</style><p>ok</p>';
    const r = new Recorder();
    r.install();
    const snap = r.getSnapshot();
    const json = JSON.stringify(snap);
    expect(json).not.toContain('secret');
    r.uninstall();
  });
});
