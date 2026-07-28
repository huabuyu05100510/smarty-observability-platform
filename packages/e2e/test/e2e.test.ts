/**
 * @monit/e2e - 跨全部 11 包的端到端集成测试（收冠证明）
 *
 * 主链全量贯通：
 * collector(MonitorEvent) -> backend(ingest+聚合) -> buildReportFromEvents
 * -> diagnoseWithCorrelation(确定性+变更关联) -> runLlmRca(多agent+残差融合)
 * -> runMrDraftTrack(MR草稿闭环) ‖ runHarness(运行时热修+Verifier+信心门禁)
 *
 * LLM 全程 mock（按 system prompt 分流返回不同 agent 的响应），确定性可复现。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBackendServer } from '@monit/backend';
import { buildReportFromEvents, diagnoseWithCorrelation } from '@monit/diagnose';
import { runLlmRca, mergeLlmRca } from '@monit/llm-rca';
import { runMrDraftTrack } from '@monit/coordinator';
import { runHarness } from '@monit/repair-agent';
import { ProvenanceGraph } from '@monit/provenance';
import { computeFingerprint } from '@monit/fingerprint';
import { traceContext } from '@monit/trace';
import type { MonitorEvent } from '@monit/contracts';

const originalFetch = globalThis.fetch;
const handles: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  traceContext.reset();
  // 按 system prompt 分流 mock LLM；非 LLM 调用（打 backend）透传给真实 fetch
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (!u.includes('/chat/completions')) {
      // 真实 HTTP（backend ingest/query）
      return originalFetch(url as RequestInfo, init);
    }
    const body = init?.body ? JSON.parse(init.body as string) : { messages: [] };
    const sys = (body.messages ?? []).find((m: { role: string }) => m.role === 'system')?.content ?? '';
    let resp: object;
    if (sys.includes('Navigator')) {
      resp = { focusCandidateIndex: 0, rationale: 'error.js candidate strongest' };
    } else if (sys.includes('Diagnoser') && !sys.includes('SKEPTICAL')) {
      resp = { rootCause: 'renderList dereferences items without null guard; API returned null', confidence: 0.85, evidence: ['items is null', 'stack: renderList'] };
    } else if (sys.includes('SKEPTICAL')) {
      resp = { refuted: false, reason: 'evidence supports: items.map on null matches symptom', confidence: 0.8 };
    } else if (sys.includes('repair agent')) {
      resp = {
        diagnosis: 'add null guard before items.map',
        patches: [{ filePath: 'src/renderList.ts', searchCode: 'items.map', replaceCode: '(items||[]).map' }],
        riskNotes: ['low risk null guard'], riskScore: 0.2,
      };
    } else {
      resp = {};
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(resp) } }],
      usage: {},
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const h of handles.splice(0)) await h.close();
  traceContext.reset();
});

// 模拟 collector 产出的 MonitorEvent（带 traceId + 双维指纹）
function makeCollectorEvents(): MonitorEvent[] {
  traceContext.startView();
  const traceId = traceContext.traceId!;
  const span = traceContext.forRequest()!;
  const fp = computeFingerprint({
    message: "Cannot read properties of null (reading 'map')",
    stack: "TypeError: Cannot read properties of null\n    at renderList (src/renderList.ts:42:17)",
    sourceURL: 'src/renderList.ts',
    errorType: 'TypeError',
  });
  return [
    {
      id: 'e1', type: 'error', subType: 'js', timestamp: Date.now(),
      traceId, spanId: span.spanId, sessionId: 'sess-e2e', release: 'v1.2.3',
      payload: {
        id: 'e1', type: 'js', message: "Cannot read properties of null (reading 'map')",
        stack: 'TypeError: Cannot read properties of null\n    at renderList (src/renderList.ts:42:17)',
        filename: 'src/renderList.ts', lineno: 42, colno: 17, timestamp: Date.now(),
        sourceURL: 'src/renderList.ts', breadcrumbs: [{ type: 'click', message: 'button#load', timestamp: Date.now() }],
      },
      piiSafe: true, sampled: true, fingerprint: fp,
    },
    {
      id: 'v1', type: 'vital', subType: 'inp', timestamp: Date.now(),
      traceId, spanId: span.spanId, sessionId: 'sess-e2e', release: 'v1.2.3',
      payload: {
        value: 320, rating: 'poor', interactionTarget: 'button', inputDelay: 30,
        processingDuration: 250, presentationDelay: 40,
        longAnimationFrameEntries: [{
          id: 'loaf1', startTime: 0, duration: 240, scripts: [
            { id: 's1', name: 'compute', sourceURL: 'src/renderList.ts', sourceFunctionName: 'renderList', duration: 200, startTime: 0 },
          ],
        }],
      },
      piiSafe: true, sampled: true,
    },
  ];
}

describe('端到端主链：采集 -> backend -> 诊断 -> LLM-RCA -> MR 草稿', () => {
  it('collector 事件经 backend 聚合 -> 诊断报告 -> 多源归因', async () => {
    const h = createBackendServer({ port: 0 });
    handles.push(h);
    await new Promise(r => h.server.once('listening', r));
    const addr = h.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3921;
    const base = `http://127.0.0.1:${port}`;

    const events = makeCollectorEvents();
    // 1. collector -> backend ingest
    const r1 = await fetch(`${base}/api/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(events),
    });
    expect((await r1.json()).ok).toBe(true);

    // 2. backend 指纹分组查询
    const r2 = await fetch(`${base}/api/errors`);
    const e2 = await r2.json();
    expect(e2.groups.length).toBe(1);
    expect(e2.groups[0].count).toBe(1);

    // 3. backend store -> buildReportFromEvents -> DiagnosticReport
    const report = buildReportFromEvents(h.store.recentEvents(), { url: 'https://app.x/' });
    expect(report.errors.length).toBe(1);
    expect(report.errors[0].message).toContain('map');
    expect(report.inp?.value).toBe(320);
    expect(report.loafEntries.length).toBe(1);

    // 4. 多源归因：确定性 + 变更关联
    const records = diagnoseWithCorrelation({
      report,
      changes: [{ id: 'c1', kind: 'deployment', at: report.createdAt - 60_000, release: 'v1.2.3', summary: 'deploy v1.2.3', commitSha: 'abc123' }],
      anomaly: { startedAt: report.createdAt, spikeRatio: 4, release: 'v1.2.3', metric: 'error_rate' },
    });
    expect(records.length).toBeGreaterThanOrEqual(1);
    const top = records[0];
    // 候选链：确定性 error.js(0.8) + 变更关联 deployment
    expect(top.candidates.length).toBe(2);
    expect(top.candidates[0].kind).toBe('error.js');
    expect(top.candidates.some(c => c.kind === 'deployment')).toBe(true);
  });

  it('LLM-RCA 多 agent 增强根因（残差融合，并入候选链）', async () => {
    const events = makeCollectorEvents();
    const report = buildReportFromEvents(events);
    const records = diagnoseWithCorrelation({
      report,
      changes: [],
      anomaly: { startedAt: report.createdAt, spikeRatio: 3 },
    });
    const top = records[0];

    const rcaResult = await runLlmRca(
      { baseUrl: 'http://x', model: 'm' },
      {
        record: top,
        codeSlices: [{ path: 'src/renderList.ts', content: 'function renderList(items){return items.map(x=>x);}' }],
        resolvedStack: report.errors[0].stack?.split('\n'),
      },
    );
    expect(rcaResult).not.toBeNull();
    expect(rcaResult!.candidate.kind).toBe('llm_rca');
    expect(rcaResult!.verification.refuted).toBe(false);

    const merged = mergeLlmRca(top, rcaResult!);
    // 候选链现在含 llm_rca
    expect(merged.candidates.some(c => c.kind === 'llm_rca')).toBe(true);
    // 仍按置信度降序
    for (let i = 1; i < merged.candidates.length; i++) {
      expect(merged.candidates[i - 1].confidence).toBeGreaterThanOrEqual(merged.candidates[i].confidence);
    }
  });

  it('MR 草稿闭环（轨道 B）：diagnose -> patch -> guardrails -> 决策', async () => {
    const events = makeCollectorEvents();
    const report = buildReportFromEvents(events);

    const result = await runMrDraftTrack({
      report,
      changes: [{ id: 'c1', kind: 'deployment', at: report.createdAt - 60_000, release: 'v1.2.3', summary: 'deploy v1.2.3' }],
      anomaly: { startedAt: report.createdAt, spikeRatio: 4, release: 'v1.2.3' },
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){return items.map(x=>x);}' }],
      testFiles: [{ path: 'src/renderList.test.ts', content: 'test("renderList",()=>renderList([1]));' }],
      goldPatches: ['function totallyDifferent(){return 42;}'],
      llmConfig: { baseUrl: 'http://x', model: 'm' },
      // 不配 github -> 不实际开 PR
    });

    expect(result.proposal).not.toBeNull();
    expect(result.proposal!.patches[0].filePath).toBe('src/renderList.ts');
    // 测试充分 + 无污染 + 低风险 -> auto-pr
    expect(result.testSufficiency!.sufficient).toBe(true);
    expect(result.contamination!.contaminated).toBe(false);
    expect(result.decision).toBe('auto-pr');
  });

  it('运行时热修（轨道 A）：harness + Verifier + 信心门禁', async () => {
    let checkCalls = 0;
    const result = await runHarness({
      diagnose: vi.fn(async () => ({
        rootCause: 'null deref in renderList',
        evidence: ['stack: renderList'],
        patch: { patchType: 'replace' as const, targetFunction: 'renderList', targetPath: 'window.renderList', code: 'function(){return []}' },
      })),
      inject: vi.fn(async () => ({ injected: true })),
      check: vi.fn(async () => { checkCalls++; return false; }), // 错误不再触发
      reset: vi.fn(async () => {}),
      verifierConfig: { baseUrl: 'http://x', model: 'm' }, // 启用 Verifier
      locality: { filesChanged: 1, linesChanged: 8, hasTestCoverage: true, typecheckPasses: true },
      maxAttempts: 3,
    });

    expect(result.resolved).toBe(true);
    expect(result.tier).toBe('high');
    expect(result.confidence!.canAutoApply).toBe(true);
    // Verifier 被调用（mock 返回 accepted）
    expect(result.verifierResult?.refuted).toBe(false);
  });

  it('数据溯源 DAG：DOM 错值 <- JS <- API span', () => {
    const g = new ProvenanceGraph();
    g.addNode({ id: 'span1', kind: 'span', label: 'GET /api/users', traceSpanId: 'span1' });
    g.addNode({ id: 'api1', kind: 'api', label: 'data.users', fieldPath: 'data.users', traceSpanId: 'span1' });
    g.addNode({ id: 'js1', kind: 'js', label: 'renderList', functionName: 'renderList' });
    g.addNode({ id: 'dom1', kind: 'dom', label: 'user list', selector: '#user-list' });
    g.addEdge('span1', 'api1');
    g.addEdge('api1', 'js1');
    g.addEdge('js1', 'dom1');

    const path = g.traceFrom('dom1');
    expect(path).not.toBeNull();
    expect(path!.nodes.length).toBe(4);
    expect(path!.nodes[0].kind).toBe('span');
    expect(path!.nodes[0].traceSpanId).toBe('span1');
    expect(path!.nodes[3].kind).toBe('dom');
  });
});