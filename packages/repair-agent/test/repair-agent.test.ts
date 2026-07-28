import { describe, it, expect, vi } from 'vitest';
import { runHarness, type HarnessDeps, type Diagnosis } from '../src/harness';
import { assessConfidence } from '../src/confidence';
import { runRegression } from '../src/regression-runner';
import { buildInjectionExpression, buildSmartFetchExpression, executePatch, type CdpClient } from '../src/patch-executor';
import { extractJson, normalizeBaseUrl } from '../src/llm-client';

// ─── LLM client ──────────────────────────────────────────────────────────────

describe('llm-client', () => {
  it('normalizes Ollama base url to /v1', () => {
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1');
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1');
  });

  it('extractJson from fenced/noisy text', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('noise {"refuted":true,"reason":"x"} trailing')).toEqual({ refuted: true, reason: 'x' });
    expect(extractJson('no json here')).toBeNull();
  });
});

// ─── Confidence gate ─────────────────────────────────────────────────────────

describe('assessConfidence (determinism×AI gate)', () => {
  it('high tier when all signals pass', () => {
    const out = assessConfidence({
      verifier: { refuted: false, reason: 'ok', confidence: 0.9 },
      regression: { proposalId: 'p', verdict: 'fixed', injected: true, regressionPassed: true, replays: 3, passes: 3 },
      locality: { filesChanged: 1, linesChanged: 20, hasTestCoverage: true, typecheckPasses: true },
    });
    expect(out.tier).toBe('high');
    expect(out.canAutoApply).toBe(true);
    expect(out.score).toBeGreaterThanOrEqual(0.9);
  });

  it('low tier when Verifier refuted', () => {
    const out = assessConfidence({
      verifier: { refuted: true, reason: 'hallucinated', confidence: 0.8 },
      regression: { proposalId: 'p', verdict: 'fixed', injected: true, regressionPassed: true, replays: 3, passes: 3 },
      locality: { filesChanged: 1, linesChanged: 20, hasTestCoverage: true, typecheckPasses: true },
    });
    expect(out.tier).toBe('low');
    expect(out.canAutoApply).toBe(false);
  });

  it('cannot auto-apply when change is non-local even if everything else passes', () => {
    const out = assessConfidence({
      verifier: { refuted: false, reason: 'ok', confidence: 0.9 },
      regression: { proposalId: 'p', verdict: 'fixed', injected: true, regressionPassed: true, replays: 3, passes: 3 },
      locality: { filesChanged: 3, linesChanged: 200, hasTestCoverage: true, typecheckPasses: true },
    });
    expect(out.canAutoApply).toBe(false);
  });

  it('low tier when regression failed', () => {
    const out = assessConfidence({
      verifier: { refuted: false, reason: 'ok', confidence: 0.9 },
      regression: { proposalId: 'p', verdict: 'failed', injected: true, regressionPassed: false, replays: 3, passes: 1 },
      locality: { filesChanged: 1, linesChanged: 20, hasTestCoverage: true, typecheckPasses: true },
    });
    expect(out.tier).toBe('low');
  });
});

// ─── Regression runner ─────────────────────────────────────────────────────────

describe('runRegression (3-replay majority vote)', () => {
  it('fixed when all replays pass', async () => {
    const r = await runRegression('p', async () => false, async () => {}, { replays: 3 });
    expect(r.verdict).toBe('fixed');
    expect(r.regressionPassed).toBe(true);
    expect(r.passes).toBe(3);
  });

  it('partial when majority pass but not all', async () => {
    let i = 0;
    const r = await runRegression(
      'p',
      async () => { i++; return i === 2; }, // 第2次仍触发错误
      async () => {},
      { replays: 3 },
    );
    expect(r.verdict).toBe('partial');
    expect(r.passes).toBe(2);
    expect(r.regressionPassed).toBe(true);
  });

  it('failed when minority pass', async () => {
    const r = await runRegression('p', async () => true, async () => {}, { replays: 3 });
    expect(r.verdict).toBe('failed');
    expect(r.regressionPassed).toBe(false);
  });
});

// ─── Patch executor ────────────────────────────────────────────────────────────

describe('patch-executor', () => {
  it('builds replace expression targeting a path', () => {
    const expr = buildInjectionExpression({ patchType: 'replace', targetPath: 'window.app.fn', code: 'function(){return 1}' });
    expect(expr).toContain('window.app.fn');
    expect(expr).toContain('function(){return 1}');
  });

  it('builds error-boundary with keyword matching', () => {
    const expr = buildInjectionExpression({ patchType: 'error-boundary', errorKeyword: 'Cannot read' });
    expect(expr).toContain('Cannot read');
    expect(expr).toContain('addEventListener');
    expect(expr).toContain('console.error');
  });

  it('builds smart-fetch with retry', () => {
    const expr = buildSmartFetchExpression();
    expect(expr).toContain('500 * Math.pow(2, attempt)');
    expect(expr).toContain('503');
  });

  it('executePatch reports injection success via CDP', async () => {
    const cdp: CdpClient = { evaluate: vi.fn(async () => ({ result: true })) };
    const r = await executePatch(cdp, { patchType: 'replace', targetPath: 'window.x', code: 'function(){}' });
    expect(r.injected).toBe(true);
  });

  it('executePatch reports failure when target not found', async () => {
    const cdp: CdpClient = { evaluate: vi.fn(async () => ({ result: false })) };
    const r = await executePatch(cdp, { patchType: 'replace', targetPath: 'window.missing', code: 'function(){}' });
    expect(r.injected).toBe(false);
    expect(r.error).toContain('not found');
  });
});

// ─── Harness (the upgraded loop) ──────────────────────────────────────────────

describe('runHarness (Verifier-upgraded loop)', () => {
  function makeDeps(over: Partial<HarnessDeps> = {}): HarnessDeps {
    return {
      diagnose: vi.fn(async () => ({
        rootCause: 'null deref in renderList',
        evidence: ['stack: at renderList (app.js:42)'],
        patch: { patchType: 'replace' as const, targetFunction: 'renderList', targetPath: 'window.app.renderList', code: 'function(){return []}' },
      })),
      inject: vi.fn(async () => ({ injected: true })),
      check: vi.fn(async () => false), // error no longer fires
      reset: vi.fn(async () => {}),
      locality: { filesChanged: 1, linesChanged: 10, hasTestCoverage: true, typecheckPasses: true },
      ...over,
    };
  }

  it('resolves on first attempt when Verifier accepts + regression passes', async () => {
    const deps = makeDeps({
      verifierConfig: { baseUrl: 'http://x', model: 'm' },
    });
    // mock verifyAdversarially by injecting a fake diagnose that we control;
    // here verifierConfig is set but fetch will fail -> Verifier conservatively refutes
    // so we expect re-diagnosis. To test the happy path, omit verifierConfig.
    deps.verifierConfig = undefined;
    const r = await runHarness(deps);
    expect(r.resolved).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.tier).toBe('high');
    expect(r.confidence?.canAutoApply).toBe(true);
  });

  it('re-diagnoses when Verifier refutes (does NOT inject)', async () => {
    // mock fetch 立即 reject -> Verifier 保守 refute（确定性，不依赖真实 DNS 失败时序）
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    let diagnoseCalls = 0;
    const deps = makeDeps({
      diagnose: vi.fn(async () => {
        diagnoseCalls++;
        return {
          rootCause: diagnoseCalls === 1 ? 'weak hallucinated cause' : 'real cause: null deref',
          evidence: ['stack: at fn (app.js:1)'],
          patch: { patchType: 'replace' as const, targetPath: 'window.fn', code: 'function(){return 1}' },
        };
      }),
      verifierConfig: { baseUrl: 'http://x', model: 'm', maxRetries: 0 },
      inject: vi.fn(async () => ({ injected: true })),
      check: vi.fn(async () => false),
      reset: vi.fn(async () => {}),
      maxAttempts: 3,
    });
    const r = await runHarness(deps);
    // Verifier fetch 失败 -> 保守 refute -> 每次都重诊断，不注入
    expect(diagnoseCalls).toBe(3);
    expect(deps.inject).not.toHaveBeenCalled();
    expect(r.resolved).toBe(false);
    fetchSpy.mockRestore();
  });

  it('escalates patch strategy when injection fails', async () => {
    let diagnoseCalls = 0;
    const deps = makeDeps({
      diagnose: vi.fn(async () => {
        diagnoseCalls++;
        const types: Diagnosis['patch']['patchType'][] = ['replace', 'error-boundary', 'prototype'];
        return {
          rootCause: 'cause',
          evidence: [],
          patch: { patchType: types[diagnoseCalls - 1], targetPath: 'window.fn', code: 'function(){}' },
        };
      }),
      inject: vi.fn(async (patch) => {
        // replace 失败（not found），error-boundary 成功
        return patch.patchType === 'replace' ? { injected: false, error: 'target not found' } : { injected: true };
      }),
      check: vi.fn(async () => false),
      reset: vi.fn(async () => {}),
      verifierConfig: undefined,
      maxAttempts: 3,
    });
    const r = await runHarness(deps);
    expect(r.resolved).toBe(true);
    expect(r.attempts).toBe(2); // 1st replace fails inject, 2nd error-boundary succeeds
  });

  it('retries when regression fails', async () => {
    let checkCalls = 0;
    const deps = makeDeps({
      diagnose: vi.fn(async () => ({
        rootCause: 'cause',
        evidence: [],
        patch: { patchType: 'replace' as const, targetPath: 'window.fn', code: 'function(){return 1}' },
      })),
      inject: vi.fn(async () => ({ injected: true })),
      check: vi.fn(async () => {
        checkCalls++;
        return checkCalls <= 3; // 前3次错误仍触发（第1次回归全失败），之后不再触发
      }),
      reset: vi.fn(async () => {}),
      verifierConfig: undefined,
      maxAttempts: 3,
    });
    const r = await runHarness(deps);
    // 第1次回归3次全失败 -> 重试；第2次回归时 checkCalls 4,5,6 -> 不触发 -> 通过
    expect(r.resolved).toBe(true);
    expect(r.attempts).toBe(2);
  });
});