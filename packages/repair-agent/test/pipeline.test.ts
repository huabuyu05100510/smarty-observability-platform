// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHealPipeline } from '../src/pipeline';
import type { ReproStatus } from '../src/pipeline';
import type { Diagnosis } from '../src/harness';

const originalFetch = globalThis.fetch;

function mockVerifierFetch(refuted: boolean, opts: { confidence?: number; reason?: string } = {}) {
  const confidence = opts.confidence ?? (refuted ? 0.8 : 0.7);
  const reason = opts.reason ?? 'evidence supports';
  globalThis.fetch = vi.fn(async () => {
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ refuted, reason, confidence }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const diag: Diagnosis = {
  rootCause: 'renderList dereferences items without null guard',
  evidence: ['items is null', 'stack: renderList'],
  patch: { patchType: 'replace', targetFunction: 'renderList', targetPath: 'src/renderList.ts', code: '(items||[]).map' },
};

/** 结构化 repro mock：未补丁返回 red，补丁后返回 green。 */
function reproMock(red: ReproStatus, green: ReproStatus, onCall?: () => void) {
  return vi.fn(async (_c: unknown, patched: boolean) => {
    onCall?.();
    return { status: patched ? green : red };
  });
}

beforeEach(() => {});
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('runHealPipeline（极致闭环单漏斗）', () => {
  it('happy path：verify pass + repro 红转绿 + 套件绿 + 局部 -> auto-mr', async () => {
    mockVerifierFetch(false);
    let reproPatchCalls = 0;
    const result = await runHealPipeline({
      symptom: 'Cannot read map of null',
      verifierConfig: { baseUrl: 'http://x', model: 'verifier-m' },
      behaviorPreserving: false,
      contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 'repro', code: 'it("repro",()=>{expect(renderList(null)).toEqual([])})' })),
      runReproTest: reproMock('fail-assertion', 'pass', () => reproPatchCalls++),
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 })),
      revertPatch: vi.fn(async () => {}),
      runSuite: vi.fn(async () => true),
      typecheck: vi.fn(async () => true),
      deliver: vi.fn(async () => ({ ok: true, branch: 'fix', prUrl: 'https://x' })),
    });
    expect(result.resolved).toBe(true);
    expect(result.decision?.delivery).toBe('auto-mr');
    expect(result.repro?.redBefore).toBe(true);
    expect(result.repro?.greenAfter).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.delivery).toMatchObject({ ok: true });
    expect(reproPatchCalls).toBe(4); // redBefore(1) + greenAfter 3-replay(3)
    expect(result.regressionVotes).toMatchObject({ replays: 3, reproPasses: 3, suitePasses: 3 });
  });

  it('flaky 回归：3-replay 中 2 次通过 -> 多数判定绿；仅 1 次通过 -> 红', async () => {
    mockVerifierFetch(false);
    let greenCall = 0;
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: false, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'c' })),
      runReproTest: vi.fn(async (_c, patched) => {
        if (!patched) return { status: 'fail-assertion' };
        greenCall++;
        return { status: greenCall !== 1 ? 'pass' : 'fail-assertion' }; // fail,pass,pass -> 2/3
      }),
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 })),
      revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
    });
    expect(result.repro?.greenAfter).toBe(true);
    expect(result.regressionVotes?.reproPasses).toBe(2);
  });

  it('Verifier refuted -> 重诊断（不注入）', async () => {
    mockVerifierFetch(true, { reason: 'wrong root cause' });
    const diagnose = vi.fn(async () => diag);
    const applyPatch = vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 }));
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: false, contamination: 'clean',
      diagnose,
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: '' })),
      runReproTest: reproMock('fail-assertion', 'pass'),
      applyPatch, revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
      maxAttempts: 2,
    });
    expect(result.resolved).toBe(false);
    expect(applyPatch).not.toHaveBeenCalled();
    expect(diagnose).toHaveBeenCalledTimes(2);
  });

  it('repro 未在打补丁前失败（复现无效）-> 重试，不 apply', async () => {
    mockVerifierFetch(false);
    const applyPatch = vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 }));
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: false, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'bad' })),
      runReproTest: reproMock('pass', 'pass'), // 未补丁也 pass = 复现无效
      applyPatch, revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
      maxAttempts: 2,
    });
    expect(result.resolved).toBe(false);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it('repro 抛无关异常（fail-error）-> 仍判复现无效（不绕过红转绿门禁）', async () => {
    mockVerifierFetch(false);
    const applyPatch = vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 }));
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: false, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'bad' })),
      runReproTest: reproMock('fail-error', 'pass'), // 未补丁 fail-error（非断言）= 复现无效
      applyPatch, revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
      maxAttempts: 2,
    });
    expect(result.resolved).toBe(false);
    expect(applyPatch).not.toHaveBeenCalled();
  });

  it('回归失败（greenAfter=false）-> 回滚 + 重试', async () => {
    mockVerifierFetch(false);
    const revertPatch = vi.fn(async () => {});
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: false, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'c' })),
      runReproTest: reproMock('fail-assertion', 'fail-assertion'), // 补丁后仍 fail
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 })),
      revertPatch, runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
      maxAttempts: 2,
    });
    expect(result.resolved).toBe(false);
    expect(revertPatch).toHaveBeenCalled();
  });

  it('非局部改动 -> gate human -> 回滚 + 不 auto', async () => {
    mockVerifierFetch(false);
    const revertPatch = vi.fn(async () => {});
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: false, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'c' })),
      runReproTest: reproMock('fail-assertion', 'pass'),
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 5, linesChanged: 200 })),
      revertPatch, runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
    });
    expect(result.decision?.delivery).toBe('human');
    expect(result.resolved).toBe(false);
    expect(revertPatch).toHaveBeenCalled();
  });

  it('行为保留 + verifier pass + repro 转绿 -> hotfix（可逆治标）', async () => {
    mockVerifierFetch(false);
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: true, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'c' })),
      runReproTest: reproMock('fail-assertion', 'pass'),
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 3, linesChanged: 60 })),
      revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
      deliver: vi.fn(async () => ({ applied: true, rollback: () => {} })),
    });
    expect(result.decision?.delivery).toBe('hotfix');
    expect(result.resolved).toBe(true);
  });

  it('contamination=detected -> hotfix 也转 human（污染全档位阻断）', async () => {
    mockVerifierFetch(false);
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: true, contamination: 'detected',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'c' })),
      runReproTest: reproMock('fail-assertion', 'pass'),
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 5 })),
      revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
    });
    expect(result.decision?.delivery).toBe('human');
  });

  it('verifier pass 但低置信（<0.5）-> verifierConfident=false -> human', async () => {
    mockVerifierFetch(false, { confidence: 0.3 });
    const result = await runHealPipeline({
      symptom: 'x', verifierConfig: { baseUrl: 'http://x', model: 'm' },
      behaviorPreserving: false, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'c' })),
      runReproTest: reproMock('fail-assertion', 'pass'),
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 })),
      revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
    });
    expect(result.decision?.gate.verifierConfident).toBe(false);
    expect(result.decision?.delivery).toBe('human');
  });

  it('未配 verifierConfig -> skipped -> human（强制配独立模型才能自动）', async () => {
    const result = await runHealPipeline({
      symptom: 'x',
      behaviorPreserving: false, contamination: 'clean',
      diagnose: vi.fn(async () => diag),
      generateReproTest: vi.fn(async () => ({ filePath: 'a.test.ts', testName: 't', code: 'c' })),
      runReproTest: reproMock('fail-assertion', 'pass'),
      applyPatch: vi.fn(async () => ({ applied: true, filesChanged: 1, linesChanged: 8 })),
      revertPatch: vi.fn(async () => {}), runSuite: vi.fn(async () => true), typecheck: vi.fn(async () => true),
    });
    expect(result.decision?.gate.verifier).toBe('skipped');
    expect(result.decision?.delivery).toBe('human');
  });
});
