import { describe, it, expect } from 'vitest';
import { InterventionProtocol, welchTStatistic, tDistributionPValueTwoSided } from '../src/experiment';
import { emptyGraph, addNode, addEdge, doIntervention, parents } from '../src/causal-graph';
import { LinearPerfModel } from '../src/model';
import { Tournament } from '../src/tournament';
import { runCausalValidationOnPatch } from '../src/patch-validation';

describe('causal-graph', () => {
  it('doIntervention 切入边(backdoor)并标记 intervention', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'analytics', kind: 'factor', label: '3rd-party script' });
    g = addNode(g, { id: 'inp', kind: 'metric', label: 'INP' });
    g = addEdge(g, { from: 'analytics', to: 'inp', weight: 0.7 });
    expect(parents(g, 'inp').map((n) => n.id)).toEqual(['analytics']);
    const intervened = doIntervention(g, 'inp', 200);
    expect(parents(intervened, 'inp')).toEqual([]);
    expect(intervened.nodes.find((n) => n.id === 'inp')?.kind).toBe('intervention');
  });

  it('可序列化往返(JSON)', () => {
    let g = emptyGraph();
    g = addNode(g, { id: 'a', kind: 'factor', label: 'A' });
    const back = JSON.parse(JSON.stringify(g));
    expect(back.schema).toBe('causal-graph');
    expect(back.version).toBe(1);
    expect(back.nodes[0].id).toBe('a');
  });
});

describe('experiment · Welch t 统计裁决', () => {
  it('treated 显著低于 baseline → accepted(decrease)', async () => {
    const norm = (m: number, sd: number) => () =>
      Promise.resolve({ value: m + (Math.random() - 0.5) * 2 * sd });
    const proto = new InterventionProtocol({ alpha: 0.05, minSamples: 8 });
    const r = await proto.run(
      { claim: '降 INP', intervention: 'patch', expectedDirection: 'decrease', metric: 'INP' },
      norm(600, 10), norm(400, 10), 12,
    );
    expect(r.conclusion).toBe('accepted');
    expect(r.significant).toBe(true);
    expect(r.effectSize).toBeLessThan(0);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('两组无差异(方差 0)→ inconclusive', async () => {
    const norm = (m: number) => () => Promise.resolve({ value: m });
    const proto = new InterventionProtocol({ alpha: 0.05 });
    const r = await proto.run(
      { claim: '无效果', intervention: 'x', expectedDirection: 'decrease', metric: 'INP' },
      norm(500), norm(500), 10,
    );
    expect(r.conclusion).toBe('inconclusive');
  });

  it('welch t 与 p 值数学合理', () => {
    const a = { mean: 600, variance: 100, n: 12, samples: [] as { value: number }[] };
    const b = { mean: 400, variance: 100, n: 12, samples: [] as { value: number }[] };
    const t = welchTStatistic(a, b);
    expect(t).toBeLessThan(-10);
    const p = tDistributionPValueTwoSided(t, 22);
    expect(p).toBeLessThan(0.001);
  });
});

describe('model · LinearPerfModel', () => {
  it('update 数值稳定（无 NaN）+ serialize 往返', () => {
    const m = new LinearPerfModel('INP', ['x']);
    expect(m.residual()).toEqual({ mae: 0, n: 0 });
    const m2 = new LinearPerfModel('INP', ['x'], { learningRate: 0.05 });
    for (let i = 0; i < 50; i++) m2.update({ x: 0.5 }, 1.0);
    const w = m2.serialize().weights.x;
    expect(Number.isFinite(w)).toBe(true);
    expect(m2.residual().n).toBe(50);
    const m3 = new LinearPerfModel('INP', ['x'], { initial: m2.serialize() });
    expect(m3.serialize().weights.x).toBe(w);
  });

  it('serialize 往返保持权重', () => {
    const m = new LinearPerfModel('LCP', ['ttfb', 'resLoad']);
    m.update({ ttfb: 800, resLoad: 1200 }, 2500);
    const s = m.serialize();
    const m2 = new LinearPerfModel('LCP', ['ttfb', 'resLoad'], { initial: s });
    expect(m2.serialize().weights).toEqual(s.weights);
  });
});

describe('tournament · 多候选科学选拔', () => {
  it('按统计显著 effect 排名;winner=最强候选;无效候选进 inconclusive', async () => {
    let boost = 0;
    const cand1 = { id: 'c1', label: 'no-effect', apply: async () => { boost = 0; }, revert: async () => { boost = 0; } };
    const cand2 = { id: 'c2', label: 'big-improve', apply: async () => { boost = -200; }, revert: async () => { boost = 0; } };
    const t = new Tournament({
      metric: 'INP', direction: 'decrease',
      controlMeasure: async () => 600 + boost, // 固定(零方差):c2 完全分离→accepted,c1 无差异→inconclusive
      samplesPerCandidate: 8,
    });
    const res = await t.run([cand1, cand2], 8);
    expect(res.winner?.candidate.id).toBe('c2');
    expect(res.inconclusive.map((c) => c.id)).toContain('c1');
  });
});

describe('patch-validation · patch 统计验证', () => {
  it('treated 显著优于 baseline → accepted(交付放行)', async () => {
    let state: 'baseline' | 'treated' = 'baseline';
    const r = await runCausalValidationOnPatch({
      measure: async () => (state === 'treated' ? 400 : 600),
      applyPatch: async () => { state = 'treated'; },
      revertPatch: async () => { state = 'baseline'; },
      direction: 'decrease', samples: 8,
    });
    expect(r.conclusion).toBe('accepted');
    expect(r.treated.mean).toBeLessThan(r.baseline.mean);
  });

  it('无差异 → inconclusive(调用方据此降级 human)', async () => {
    const r = await runCausalValidationOnPatch({
      measure: async () => 500,
      applyPatch: async () => {},
      revertPatch: async () => {},
      samples: 8,
    });
    expect(r.conclusion).toBe('inconclusive');
  });

  it('方向相反(treated 更差)→ rejected(降级)', async () => {
    let state: 'baseline' | 'treated' = 'baseline';
    const r = await runCausalValidationOnPatch({
      measure: async () => (state === 'treated' ? 600 : 400),
      applyPatch: async () => { state = 'treated'; },
      revertPatch: async () => { state = 'baseline'; },
      direction: 'decrease', samples: 8,
    });
    expect(r.conclusion).toBe('rejected');
  });
});
