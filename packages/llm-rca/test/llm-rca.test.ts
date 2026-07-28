import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runLlmRca, mergeLlmRca } from '../src/index';
import type { AttributionRecord } from '@monit/contracts';

const originalFetch = globalThis.fetch;

function makeRecord(): AttributionRecord {
  return {
    id: 'rec1',
    symptomId: 'e1',
    symptom: { kind: 'error', observed: 'TypeError: Cannot read map of null' },
    candidates: [
      {
        kind: 'error.js',
        confidence: 0.8,
        evidence: ['stack-top: at renderList (app.js:42)'],
        anchors: { errorId: 'e1', stackTop: 'at renderList' },
        suggestedHealIds: ['safe_null_guard_hint'],
      },
    ],
    severity: 'critical',
    createdAt: 1_700_000_000_000,
  };
}

function mockSequentialCalls(responses: object[]) {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    const resp = responses[i] ?? responses[responses.length - 1];
    i++;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(resp) } }],
      usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

beforeEach(() => {
  mockSequentialCalls([
    { focusCandidateIndex: 0, rationale: 'error.js candidate' }, // Navigator
    { rootCause: 'renderList accesses items.map without null guard', confidence: 0.85, evidence: ['items is null from API'] }, // Diagnoser
    { refuted: false, reason: 'evidence supports', confidence: 0.7 }, // Verifier
  ]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('runLlmRca (multi-agent structured RCA)', () => {
  it('produces llm_rca candidate with fused confidence', async () => {
    const result = await runLlmRca(
      { baseUrl: 'http://x', model: 'm' },
      { record: makeRecord(), codeSlices: [{ path: 'app.js', content: 'function renderList(items){return items.map(x=>x);}' }] },
    );
    expect(result).not.toBeNull();
    expect(result!.candidate.kind).toBe('llm_rca');
    expect(result!.candidate.confidence).toBeGreaterThan(0);
    expect(result!.candidate.confidence).toBeLessThanOrEqual(0.9);
    expect(result!.verification.refuted).toBe(false);
  });

  it('residual = |deterministic - llm| confidence', async () => {
    const result = await runLlmRca(
      { baseUrl: 'http://x', model: 'm' },
      { record: makeRecord(), codeSlices: [] },
    );
    // deterministic 0.8, llm 0.85 -> residual 0.05
    expect(result!.residual).toBeCloseTo(0.05, 1);
  });

  it('Verifier refuted heavily discounts fused confidence', async () => {
    mockSequentialCalls([
      { focusCandidateIndex: 0, rationale: 'x' },
      { rootCause: 'hallucinated cause', confidence: 0.9, evidence: ['fake'] },
      { refuted: true, reason: 'evidence fabricated', confidence: 0.9 }, // Verifier 否决
    ]);
    const result = await runLlmRca(
      { baseUrl: 'http://x', model: 'm' },
      { record: makeRecord(), codeSlices: [] },
    );
    expect(result!.verification.refuted).toBe(true);
    // 否决 -> 融合值 *= 0.3，应明显低于不否决的场景
    expect(result!.fusedConfidence).toBeLessThan(0.4);
  });

  it('caps LLM-RCA confidence at 0.9 (never 100%)', async () => {
    mockSequentialCalls([
      { focusCandidateIndex: 0, rationale: 'x' },
      { rootCause: 'x', confidence: 1.0, evidence: [] },
      { refuted: false, reason: 'x', confidence: 1.0 },
    ]);
    const result = await runLlmRca(
      { baseUrl: 'http://x', model: 'm' },
      { record: makeRecord(), codeSlices: [] },
    );
    expect(result!.candidate.confidence).toBeLessThanOrEqual(0.9);
  });
});

describe('mergeLlmRca', () => {
  it('appends llm_rca candidate and re-sorts by confidence', async () => {
    const record = makeRecord();
    const result = await runLlmRca(
      { baseUrl: 'http://x', model: 'm' },
      { record, codeSlices: [] },
    );
    const merged = mergeLlmRca(record, result!);
    expect(merged.candidates.length).toBe(2);
    expect(merged.candidates.some(c => c.kind === 'llm_rca')).toBe(true);
    // 按置信度降序
    for (let i = 1; i < merged.candidates.length; i++) {
      expect(merged.candidates[i - 1].confidence).toBeGreaterThanOrEqual(merged.candidates[i].confidence);
    }
  });
});