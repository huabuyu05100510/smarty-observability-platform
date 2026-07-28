import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runMrDraftTrack } from '../src/mr-draft-track';
import type { DiagnosticReport } from '@monit/contracts';

const originalFetch = globalThis.fetch;

function mockLlmFetch(patchJson: object) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.includes('/chat/completions')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(patchJson) } }],
        usage: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

beforeEach(() => {
  // 默认 mock 一个合法补丁
  mockLlmFetch({
    diagnosis: 'null deref in renderList',
    patches: [{ filePath: 'src/renderList.ts', searchCode: 'items.map', replaceCode: '(items||[]).map' }],
    riskNotes: ['low risk'],
    riskScore: 0.2,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function makeReport(): DiagnosticReport {
  return {
    id: 'r1', url: 'https://app.x/', createdAt: 1_700_000_000_000,
    vitals: [],
    errors: [{ id: 'e1', type: 'js', message: 'TypeError: Cannot read map of null', stack: 'TypeError\n    at renderList (src/renderList.ts:10:5)', timestamp: 1, sourceURL: 'src/renderList.ts' }],
    longTasks: [], loafEntries: [],
    summary: { issueCount: 0, worstSeverity: 'info', headline: '' },
  };
}

describe('runMrDraftTrack (MR 草稿闭环)', () => {
  it('diagnosis-only when LLM produces no valid patch', async () => {
    // searchCode 不在源文件 -> generatePatch 校验失败 -> null
    mockLlmFetch({
      diagnosis: 'x',
      patches: [{ filePath: 'src/renderList.ts', searchCode: 'NONEXISTENT', replaceCode: 'x' }],
      riskNotes: [], riskScore: 0.1,
    });
    const result = await runMrDraftTrack({
      report: makeReport(),
      changes: [], anomaly: { startedAt: 1_700_000_000_000, spikeRatio: 3 },
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){ return items.map(x=>x); }' }],
      testFiles: [], goldPatches: [],
      llmConfig: { baseUrl: 'http://x', model: 'm' },
    });
    expect(result.decision).toBe('diagnosis-only');
    expect(result.proposal).toBeNull();
  });

  it('auto-pr when guardrails pass + low risk', async () => {
    const result = await runMrDraftTrack({
      report: makeReport(),
      changes: [], anomaly: { startedAt: 1_700_000_000_000, spikeRatio: 3 },
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){ return items.map(x=>x); }' }],
      testFiles: [{ path: 'src/renderList.test.ts', content: 'test("renderList", () => renderList([1]));' }],
      goldPatches: ['function totallyDifferent(){ return 42; }'],
      llmConfig: { baseUrl: 'http://x', model: 'm' },
    });
    expect(result.proposal).not.toBeNull();
    expect(result.testSufficiency?.sufficient).toBe(true);
    expect(result.contamination?.contaminated).toBe(false);
    expect(result.decision).toBe('auto-pr');
    // 未配置 github -> 不实际开 PR
    expect(result.prResult).toBeNull();
  });

  it('draft-with-warnings when tests insufficient', async () => {
    const result = await runMrDraftTrack({
      report: makeReport(),
      changes: [], anomaly: { startedAt: 1_700_000_000_000, spikeRatio: 3 },
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){ return items.map(x=>x); }' }],
      testFiles: [], // 无测试 -> 不充分
      goldPatches: ['function totallyDifferent(){ return 42; }'],
      llmConfig: { baseUrl: 'http://x', model: 'm' },
    });
    expect(result.testSufficiency?.sufficient).toBe(false);
    expect(result.decision).toBe('draft-with-warnings');
    expect(result.reasons.some(r => r.includes('tests insufficient'))).toBe(true);
  });

  it('draft-with-warnings when contamination detected', async () => {
    const goldPatch = 'function renderList(items){ return (items||[]).map(x=>x); }';
    mockLlmFetch({
      diagnosis: 'x',
      patches: [{ filePath: 'src/renderList.ts', searchCode: 'items.map', replaceCode: goldPatch }],
      riskNotes: [], riskScore: 0.1,
    });
    const result = await runMrDraftTrack({
      report: makeReport(),
      changes: [], anomaly: { startedAt: 1_700_000_000_000, spikeRatio: 3 },
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){ return items.map(x=>x); }' }],
      testFiles: [{ path: 'src/renderList.test.ts', content: 'test("renderList", () => renderList([1]));' }],
      goldPatches: [goldPatch], // 与补丁 verbatim 一致 -> 污染
      llmConfig: { baseUrl: 'http://x', model: 'm' },
    });
    expect(result.contamination?.contaminated).toBe(true);
    expect(result.decision).toBe('draft-with-warnings');
    expect(result.reasons.some(r => r.includes('contamination'))).toBe(true);
  });

  it('draft-with-warnings when riskScore exceeds threshold', async () => {
    mockLlmFetch({
      diagnosis: 'risky rewrite',
      patches: [{ filePath: 'src/renderList.ts', searchCode: 'items.map', replaceCode: '(items||[]).map' }],
      riskNotes: ['high risk'], riskScore: 0.9,
    });
    const result = await runMrDraftTrack({
      report: makeReport(),
      changes: [], anomaly: { startedAt: 1_700_000_000_000, spikeRatio: 3 },
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){ return items.map(x=>x); }' }],
      testFiles: [{ path: 'src/renderList.test.ts', content: 'test("renderList", () => renderList([1]));' }],
      goldPatches: ['function different(){ return 1; }'],
      llmConfig: { baseUrl: 'http://x', model: 'm' },
      riskThreshold: 0.4,
    });
    expect(result.decision).toBe('draft-with-warnings');
  });
});