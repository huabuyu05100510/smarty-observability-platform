/**
 * @monit/backend/server - ingest + 查询 + 内置面板（生产级加固）
 *
 * 用 @monit/server-kit 的 HttpRouter：守卫（鉴权/Origin/限流/有界 body/审计）在 dispatch 层强制。
 * 写端点（ingest/spans/sourcemap）必经鉴权；CORS 按 Origin 白名单回显（不再 *）。
 *
 * 端点（policy）：
 * - GET  /                            (open)  dashboard
 * - GET  /api/health                  (open)
 * - POST /api/events                  (write) 批量 ingest（collector 上报）
 * - GET  /api/errors[/:fp|/trend|/stats|/new-by-release]  (read)
 * - GET  /api/releases /frustration /white-screen /vitals /sessions  (read)
 * - POST /api/sourcemaps/{upload,resolve}  (write)
 * - POST /api/spans                   (write)
 * - GET  /api/traces/:traceId/spans   (read)
 */

import http from 'node:http';
import type { MonitorEvent, SpanRecord, DiagnosticReport, InpAttribution, VitalMetric, AttributionRecord, HealAction, PerfFlamegraphData } from '@monit/contracts';
import { EventStore, type ErrorGroup, type VitalAnalysis } from './store';
import { SourcemapStore } from './sourcemap';
import { SqlitePersister } from './persist';
import { dashboardHtml } from './dashboard';
import { chat, type LLMConfig } from '@monit/repair-agent';
import { buildPerfFlamegraph, analyzeRootCauses, proposeHealActions } from '@monit/diagnose';
import { runDemoHeal } from './demo-heal';
import { parseTraceparent, generateSpanIdHex } from '@monit/trace';
import { HttpRouter, RateLimiter, consoleAudit, type GuardConfig, type RouteSpec, type AuditSink } from '@monit/server-kit';

export interface BackendOptions {
  port?: number;
  host?: string;
  /** ingest/写端点 bearer token；未配置时 loopback 放行、非 loopback 拒绝 */
  ingestToken?: string;
  /** 允许的跨源 Origin（默认 []；loopback origin 总是允许）*/
  allowOrigins?: string[];
  allowLoopbackOrigin?: boolean;
  /** 可选 GitHub raw 回退基址（sourcemap 远端获取） */
  githubRawBase?: string;
  /** 可选 JSONL 持久化路径（不传则纯内存）；:memory: 为内存模式 */
  dbPath?: string;
  /** 可选 React 面板 HTML 文件路径（设了则作为 / 主面板） */
  dashboardFile?: string;
  /** 可选 LLM 配置（设了则错误流入后自动调 AI 出诊断，fire-and-forget） */
  llmConfig?: LLMConfig;
  /** 可选自愈自动触发配置：AI 诊断后调 coordinator /auto-heal。 */
  autoHeal?: {
    coordinatorUrl: string;
    /** coordinator 的 authToken（POST /auto-heal 鉴权用）*/
    coordinatorToken?: string;
    sourceFiles: Array<{ path: string; content: string }>;
    testFiles?: Array<{ path: string; content: string }>;
    riskThreshold?: number;
    /** 触发开 PR 的最小受影响 session 数（默认 2，防单条伪造触发）*/
    minSessions?: number;
  };
  audit?: AuditSink;
}

export interface BackendHandle {
  server: http.Server;
  store: EventStore;
  close(): Promise<void>;
}

export function createBackendServer(opts: BackendOptions = {}): BackendHandle {
  const store = new EventStore(10000);
  const sourcemaps = new SourcemapStore({ githubRawBase: opts.githubRawBase });
  const persister = opts.dbPath ? new SqlitePersister({ dbPath: opts.dbPath }) : null;
  if (persister) {
    const historical = persister.loadAll();
    if (historical.length > 0) store.ingest(historical);
  }
  const port = opts.port ?? 3921;
  const host = opts.host ?? '127.0.0.1';

  const rl = (c: number, r: number) => new RateLimiter({ capacity: c, refillPerSec: r });
  const guard: GuardConfig = {
    authToken: opts.ingestToken,
    allowOrigins: opts.allowOrigins ?? [],
    allowLoopbackOrigin: opts.allowLoopbackOrigin ?? true,
    bodyMax: { write: 1_000_000, read: 1_000_000, sdk: 64_000, open: 8_000 },
    rateLimit: { write: rl(100, 20), read: rl(200, 40), sdk: rl(60, 10), open: rl(30, 5) },
    audit: opts.audit ?? consoleAudit,
  };

  // 跨层 trace join：为带 traceparent 的【业务】请求自动产 server span。
  // 排除遥测端点 /api/events、/api/spans（避免自我循环）。受 router 限流保护，防伪造 traceparent 灌伪 span。
  const setupSpan = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const tp = req.headers['traceparent'];
    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];
    if (!tp || pathOnly.startsWith('/api/events') || pathOnly.startsWith('/api/spans')) return;
    const tpStr = Array.isArray(tp) ? tp[0] : tp;
    const parsed = tpStr ? parseTraceparent(tpStr) : null;
    if (!parsed) return;
    const reqStart = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - reqStart;
      store.ingestSpans([{
        traceId: parsed.traceId,
        spanId: generateSpanIdHex(),
        parentSpanId: parsed.spanId,
        name: `${req.method ?? 'GET'} ${pathOnly}`,
        kind: 'server',
        serviceName: 'smarty-backend',
        startTime: reqStart,
        durationMs,
        status: res.statusCode >= 500 ? 'error' : 'ok',
        slow: durationMs >= 500,
        attributes: { status: res.statusCode },
      }]);
    });
  };

  const routes: RouteSpec[] = [
    // ── dashboard / health ──
    { method: 'GET', path: '/', policy: 'open', handler: async () => {
      if (opts.dashboardFile) {
        try {
          const fs = await import('node:fs');
          return { status: 200, body: fs.readFileSync(opts.dashboardFile, 'utf-8'), headers: { 'Content-Type': 'text/html; charset=utf-8' } };
        } catch { /* 降级内置 HTML */ }
      }
      return { status: 200, body: dashboardHtml, headers: { 'Content-Type': 'text/html; charset=utf-8' } };
    }},
    { method: 'GET', path: '/api/health', policy: 'open', handler: async () => ({
      status: 200, body: {
        ok: true, uptime: process.uptime(),
        events: store.size(), errorGroups: store.errorGroupsListSummary().length,
        sessions: store.sessionsList().length,
        aiPending: store.errorGroupsListSummary().filter((g) => g.aiDiagnosisPending).length,
        llmConfigured: !!opts.llmConfig,
        coordinatorUrl: opts.autoHeal?.coordinatorUrl ?? null,
      },
    })},

    // ── ingest ──
    { method: 'POST', path: '/api/events', policy: 'write', handler: async (ctx) => {
      const parsed = ctx.body;
      const events: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { events?: unknown[] })?.events) ? (parsed as { events: unknown[] }).events : [];
      const evs = events as MonitorEvent[];
      // 先落盘（持久化优先）后进内存（store.ingest 内部 schema 校验，畸形跳过计数）
      try { persister?.saveEvents(evs); } catch { /* 落盘失败不阻断响应（内存仍可用） */ }
      const { ingested, malformed } = store.ingest(evs);

      // 自动 AI 诊断（fire-and-forget）：新错误组触发 LLM 出诊断。
      if (opts.llmConfig) {
        for (const e of evs) {
          const fp = e.fingerprint?.primary;
          if (e.type !== 'error' || !fp) continue;
          if (!store.tryClaimAiDiagnosis(fp)) continue;
          const g = store.errorGroup(fp);
          if (!g) { store.clearAiDiagnosisPending(fp); continue; }
          void runAiDiagnosis(opts.llmConfig, g).then(async (diag) => {
            if (diag) store.setAiDiagnosis(fp, diag);
            store.clearAiDiagnosisPending(fp);
            // AI 诊断后：若配了 sourceFiles + coordinatorUrl，且该 fp 已被 ≥ minSessions 个 session 命中，
            // 才触发自愈闭环（防单条未鉴权... 实际已鉴权 + 防单点误触发开 PR）
            if (diag && diag.formatMatched && opts.autoHeal?.sourceFiles?.length && opts.autoHeal?.coordinatorUrl) {
              const minSessions = opts.autoHeal.minSessions ?? 2;
              const cur = store.errorGroup(fp);
              if ((cur?.sessionsAffected.size ?? 0) < minSessions) return;
              const errPayload = g.sample.payload as { message?: string; stack?: string };
              const autoRecord = {
                id: 'rec-' + fp, symptomId: fp,
                symptom: { kind: 'error' as const, observed: errPayload?.message ?? '' },
                candidates: [{ kind: 'error.js' as const, confidence: cur?.rootCause?.confidence ?? 0.8, evidence: cur?.rootCause?.evidence ?? [], anchors: { errorId: fp }, suggestedHealIds: cur?.rootCause?.suggestedHealIds ?? [] }],
                severity: 'critical' as const, createdAt: g.firstSeen,
              };
              fetch(`${opts.autoHeal.coordinatorUrl}/auto-heal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(opts.autoHeal.coordinatorToken ? { Authorization: `Bearer ${opts.autoHeal.coordinatorToken}` } : {}) },
                body: JSON.stringify({ record: autoRecord, sourceFiles: opts.autoHeal.sourceFiles, testFiles: opts.autoHeal.testFiles ?? [], riskThreshold: opts.autoHeal.riskThreshold, anomaly: { startedAt: g.firstSeen, spikeRatio: 1 } }),
              }).catch((e) => console.warn('[auto-heal] trigger failed:', e));
            }
          });
        }
      }

      return { status: 200, body: { ok: true, ingested, malformed } };
    }},

    // ── 错误查询 ──
    { method: 'GET', path: '/api/errors', policy: 'read', handler: async () => ({ status: 200, body: { groups: store.errorGroupsListSummary() } }) },
    { method: 'GET', path: '/api/errors/trend', policy: 'read', handler: async () => ({ status: 200, body: { trend: store.errorTrend() } }) },
    { method: 'GET', path: '/api/errors/stats', policy: 'read', handler: async () => ({ status: 200, body: { stats: store.errorStats() } }) },
    { method: 'GET', path: '/api/errors/new-by-release', policy: 'read', handler: async () => ({ status: 200, body: { newByRelease: store.newErrorsByRelease() } }) },
    { method: 'GET', path: '/api/errors/:fp', policy: 'read', handler: async (ctx) => {
      const fp = ctx.params.fp ?? '';
      return { status: 200, body: { group: store.errorGroup(fp), events: store.eventsForFingerprint(fp) } };
    }},
    // 错误详细根因分析（RCA）：栈 → sourcemap 还原源码 → 确定性根因 → findings → 每个问题的修复
    { method: 'GET', path: '/api/errors/:fp/rca', policy: 'read', handler: async (ctx) => {
      const fp = ctx.params.fp ?? '';
      const group = store.errorGroup(fp);
      if (!group) return { status: 404, body: { error: 'error group not found' } };
      const sample = (group.sample.payload as Record<string, unknown>) || {};
      const trace: Array<{ step: string; data: string; conclusion: string }> = [];
      const findings: Array<{ title: string; evidence: string; severity: string }> = [];
      const fixes: Array<{ problem: string; solution: string; code?: string }> = [];
      // ① 错误概览
      trace.push({ step: '① 错误', data: `${sample.type || 'error'}: ${sample.message || group.message}`, conclusion: `指纹 ${fp.slice(0, 16)}…；命中 ${group.count} 次，影响 ${group.sessionsAffected.size} 个 session；首发 release ${group.firstRelease || '?'}` });
      // ② 栈 → sourcemap 还原源码
      let sourceFrames: Array<{ source: string | null; line: number | null; column: number | null; resolved: boolean; sourceSnippet?: string }> = [];
      const stack = typeof sample.stack === 'string' ? sample.stack : '';
      if (stack) {
        sourceFrames = await sourcemaps.resolveStack('default', group.firstRelease || 'demo-1.0.0', stack);
        const top = sourceFrames.find((f) => f.resolved);
        const rawTop = stack.split('\n').slice(1, 2)[0]?.trim() || '(无栈帧)';
        trace.push({ step: '② 栈顶定位', data: top ? `${top.source}:${top.line}:${top.column}` : rawTop, conclusion: top ? 'sourcemap 已还原到源码行（见 ③ 片段）' : '未还原（需上传该 release 的 sourcemap + bundle）' });
        if (top?.sourceSnippet) trace.push({ step: '③ 源码片段', data: top.sourceSnippet.split('\n').find((l) => l.includes('▶')) || top.sourceSnippet.split('\n')[0], conclusion: '▶ 标记行为错误触发行，针对性检查此处空值/类型' });
      } else {
        trace.push({ step: '② 栈', data: '(无 stack)', conclusion: '该错误未携带堆栈（可能跨源脚本未配 crossorigin，或 ResourceError）' });
      }
      // ④ 确定性根因（diagnose）
      if (group.rootCause) trace.push({ step: '④ 确定性根因', data: `${group.rootCause.kind}`, conclusion: group.rootCause.evidence.join('；') });
      // findings + fixes（基于错误类型 + 源码）
      const msg = String(sample.message || group.message);
      findings.push({ title: `${sample.type || 'JS'} 错误：${msg.slice(0, 80)}`, evidence: `命中 ${group.count} 次 / ${group.sessionsAffected.size} session；首发 ${group.firstRelease || '?'}`, severity: 'critical' });
      if (msg.includes('null') || msg.includes('undefined') || msg.includes('reading')) {
        fixes.push({ problem: '空值解引用（null/undefined 访问属性）', solution: '访问前加可选链 ?. 与空值兜底；React 用 ErrorBoundary 防白屏', code: 'items?.map((x) => ...) ?? []\ndata?.field ?? defaultValue' });
      } else if (sample.type === 'resource' || msg.includes('load')) {
        fixes.push({ problem: '资源加载失败', solution: '检查资源 URL/CDN/CORS；加 onerror 兜底；<script crossorigin>', code: '<script src="..." crossorigin onerror="onErr(this)">' });
      } else if (sample.type === 'promise') {
        fixes.push({ problem: '未捕获的 Promise rejection', solution: '所有 async 加 try/catch；全局 unhandledrejection 兜底（已接入）', code: 'try { await api() } catch (e) { report(e) }' });
      } else {
        fixes.push({ problem: '运行时异常', solution: '根据 ③ 源码片段定位的具体行加防御性检查；ErrorBoundary 防白屏', code: '// ErrorBoundary 已接入（MonitorErrorBoundary）' });
      }
      if (group.aiDiagnosis) findings.push({ title: 'AI 诊断（补充）', evidence: group.aiDiagnosis.diagnosis + ' | 修复: ' + group.aiDiagnosis.suggestedFix, severity: 'info' });
      return { status: 200, body: { trace, sourceFrames, findings, fixes, rootCause: group.rootCause, aiDiagnosis: group.aiDiagnosis } };
    }},

    { method: 'GET', path: '/api/releases', policy: 'read', handler: async () => ({ status: 200, body: { releases: store.releaseBreakdown() } }) },
    { method: 'GET', path: '/api/frustration', policy: 'read', handler: async () => ({ status: 200, body: { stats: store.frustrationStats() } }) },
    { method: 'GET', path: '/api/white-screen', policy: 'read', handler: async () => ({ status: 200, body: { events: store.whiteScreenEvents() } }) },
    { method: 'GET', path: '/api/vitals', policy: 'read', handler: async () => ({ status: 200, body: { vitals: store.vitalsAggregation() } }) },
    // 详细根因分析（RCA）：自动 LoAF 还原到源码 + findings + 每个问题的具体修复方案
    { method: 'GET', path: '/api/vitals/:name/rca', policy: 'read', handler: async (ctx) => {
      const name = (ctx.params.name || '').toUpperCase();
      const agg = store.vitalsAggregation().find((v) => v.name === name);
      if (!agg || !agg.sample) return { status: 404, body: { error: 'no sample for ' + name } };
      const sample = agg.sample as Record<string, unknown>;
      const a: Partial<VitalAnalysis> = agg.analysis ?? {};
      const release = agg.release || 'demo-1.0.0';
      // ① 自动 LoAF 还原（sourceURL + charPosition → 源码行 + 片段，无需手点）
      let sourceLocation: { source: string | null; line: number | null; column: number | null; resolved: boolean; sourceSnippet?: string } | null = null;
      let loafScript: { sourceURL?: string; sourceFunctionName?: string; duration?: number } | null = null;
      const loafs = (Array.isArray(sample.longAnimationFrameEntries) ? sample.longAnimationFrameEntries : []) as Array<{ scripts?: Array<{ sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number; duration?: number }> }>;
      for (const e of loafs) {
        for (const sc of (e.scripts || [])) {
          if (sc.sourceURL && sc.sourceCharPosition != null) {
            sourceLocation = await sourcemaps.resolveGeneratedCharPosition('default', release, sc.sourceURL, sc.sourceCharPosition);
            loafScript = sc;
            break;
          }
        }
        if (sourceLocation?.resolved) break;
      }
      // ② findings + fixes（规则式，结合主导段 + 交互目标 + 源码，每个问题给具体修复）
      const findings: Array<{ title: string; evidence: string; severity: string }> = [];
      const fixes: Array<{ problem: string; solution: string; code?: string }> = [];
      // 一步步可解释推导链（从监控数据 → 结论，非黑箱）
      const trace: Array<{ step: string; data: string; conclusion: string }> = [];
      const dom = a.dominantCause || '';
      if (name === 'INP') {
        // INP 可解释推导：三段分解 → 主导段 → 交互目标 → LoAF 源码
        const idelay = typeof sample.inputDelay === 'number' ? sample.inputDelay : 0;
        const pdur = typeof sample.processingDuration === 'number' ? sample.processingDuration : 0;
        const ppres = typeof sample.presentationDelay === 'number' ? sample.presentationDelay : 0;
        const inpTotal = (typeof sample.value === 'number' ? sample.value : 0) || 1;
        trace.push({ step: '① INP 值', data: `${inpTotal.toFixed(0)}ms (${agg.worstRating})`, conclusion: '基线 good≤200 / poor>500' });
        trace.push({ step: '② 三段分解', data: `inputDelay ${idelay.toFixed(0)}ms + processing ${pdur.toFixed(0)}ms + presentation ${ppres.toFixed(0)}ms`, conclusion: `占比 ${(idelay / inpTotal * 100).toFixed(0)}% / ${(pdur / inpTotal * 100).toFixed(0)}% / ${(ppres / inpTotal * 100).toFixed(0)}%` });
        trace.push({ step: '③ 主导段判定', data: `${dom}`, conclusion: dom.includes('输入延迟') ? '主线程被占用，交互输入排队等待' : dom.includes('回调处理') ? '事件回调同步耗时过长' : '渲染/布局重排耗时' });
        if (typeof sample.interactionTarget === 'string') trace.push({ step: '④ 慢交互目标', data: sample.interactionTarget, conclusion: '该元素的事件处理是瓶颈，优先排查其 handler' });
        if (dom.includes('输入延迟')) {
          findings.push({ title: '主线程被长任务阻塞，交互输入无法及时响应', evidence: `inputDelay 主导（${dom}）；用户点击后浏览器须等主线程空闲才处理交互`, severity: 'high' });
          fixes.push({ problem: '交互时长任务占用主线程', solution: 'scheduler.yield() / setTimeout(0) 把长任务拆成 <50ms 片段让输入插队；重计算移到 Web Worker', code: 'async function onClick(){ heavyPart1(); await scheduler.yield(); heavyPart2(); }' });
        } else if (dom.includes('回调处理')) {
          findings.push({ title: '事件回调同步执行耗时过长', evidence: `processing 主导（${dom}）；${a.userStory || ''}`, severity: 'critical' });
          fixes.push({ problem: '回调内同步重计算 / 大文档解析', solution: '缓存/防抖重复计算；大文档解析改流式或 Web Worker；避免同步 DOM 读写（layout thrashing）', code: 'const w = new Worker("/heavy.worker.js"); w.postMessage(doc);' });
        } else if (dom.includes('渲染')) {
          findings.push({ title: '渲染/布局重排耗时', evidence: `presentation 主导（${dom}）；DOM 规模大或强制重排`, severity: 'high' });
          fixes.push({ problem: 'DOM 过大 / 强制同步重排', solution: '长列表 content-visibility:auto 懒渲染；读写分离防 layout thrashing；减少同时渲染节点', code: '.list-item { content-visibility: auto; contain-intrinsic-size: 0 40px; }' });
        }
      } else if (name === 'LCP') {
        // LCP 可解释推导：从 TTFB / 资源加载 / 元素渲染延迟 三段分解，一步步推出"哪个元素被什么阻塞"
        const attr = (sample.attribution && typeof sample.attribution === 'object' ? sample.attribution : {}) as { url?: string; element?: string; elementTag?: string; timeToFirstByte?: number; resourceLoadDuration?: number; elementRenderDelay?: number };
        const ttfb = attr.timeToFirstByte ?? 0;
        const rload = attr.resourceLoadDuration ?? 0;
        const erender = attr.elementRenderDelay ?? 0;
        const lcpVal = typeof sample.value === 'number' ? sample.value : 0;
        const total = lcpVal || (ttfb + rload + erender) || 1;
        trace.push({ step: '① LCP 值', data: `${lcpVal.toFixed(0)}ms (${agg.worstRating})`, conclusion: '基线 good≤2500 / poor>4000' });
        trace.push({ step: '② 时间分解', data: `TTFB ${ttfb.toFixed(0)}ms + 资源加载 ${rload.toFixed(0)}ms + 元素渲染延迟 ${erender.toFixed(0)}ms`, conclusion: `占比 ${(ttfb / total * 100).toFixed(0)}% / ${(rload / total * 100).toFixed(0)}% / ${(erender / total * 100).toFixed(0)}%` });
        const segs: Array<[string, number]> = [['TTFB(服务端)', ttfb], ['资源加载', rload], ['元素渲染延迟', erender]];
        const maxSeg = [...segs].sort((a, b) => b[1] - a[1])[0];
        const blockedEl = attr.element ? `${attr.elementTag || '元素'} (${attr.element})` : 'LCP 元素';
        trace.push({ step: '③ 主导段判定', data: `${maxSeg[0]} = ${maxSeg[1].toFixed(0)}ms（占 ${(maxSeg[1] / total * 100).toFixed(0)}%）`, conclusion: maxSeg[0] === '资源加载' ? `${blockedEl} 依赖的资源加载慢 → 元素被资源阻塞` : maxSeg[0] === '元素渲染延迟' ? '元素就绪后渲染被阻塞（渲染阻塞资源 JS/CSS）' : '服务端响应慢（TTFB）' });
        if (attr.element || attr.elementTag) trace.push({ step: '④ 阻塞元素定位', data: blockedEl + (attr.url ? `，资源 ${attr.url}` : ''), conclusion: '该元素是首屏最大内容，其渲染时机决定 LCP' });
        // finding + fix（基于推导结论）
        if (maxSeg[0] === '资源加载' && attr.url) {
          findings.push({ title: `${blockedEl} 被资源加载阻塞`, evidence: `LCP 资源 ${attr.url} 加载 ${rload.toFixed(0)}ms（占 ${(rload / total * 100).toFixed(0)}%），阻塞 ${blockedEl} 渲染`, severity: 'high' });
          fixes.push({ problem: `LCP 资源 ${attr.url} 未优先加载`, solution: `给该资源 fetchpriority="high" + <link rel=preload>；转 WebP/AVIF + 压缩；走 CDN；移除排在前面的渲染阻塞脚本`, code: `<link rel="preload" as="image" href="${attr.url}" fetchpriority="high">\n<img src="${attr.url}" fetchpriority="high" loading="eager">` });
        } else if (maxSeg[0] === '元素渲染延迟') {
          findings.push({ title: `${blockedEl} 渲染被阻塞`, evidence: `元素渲染延迟 ${erender.toFixed(0)}ms（占 ${(erender / total * 100).toFixed(0)}%）→ 渲染阻塞资源(JS/CSS)排在元素渲染前`, severity: 'high' });
          fixes.push({ problem: '渲染阻塞 JS/CSS 延迟元素渲染', solution: '关键 CSS 内联；非关键 JS defer/async；移除首屏不需要的脚本', code: '<script defer src="...">\n<style>/* 关键 CSS 内联 */</style>' });
        } else {
          findings.push({ title: '服务端响应慢（TTFB）', evidence: `TTFB ${ttfb.toFixed(0)}ms（占 ${(ttfb / total * 100).toFixed(0)}%）`, severity: 'medium' });
          fixes.push({ problem: 'TTFB 高', solution: 'CDN/边缘缓存 + HTTP/2 + SSR 缓存', code: 'Cache-Control: public, max-age=3600' });
        }
      } else if (name === 'CLS') {
        const clsVal = typeof sample.value === 'number' ? sample.value : 0;
        const attr = (sample.attribution && typeof sample.attribution === 'object' ? sample.attribution : {}) as { target?: string; shifts?: unknown[] };
        trace.push({ step: '① CLS 值', data: `${clsVal.toFixed(3)} (${agg.worstRating})`, conclusion: '基线 good≤0.1 / poor>0.25（累计布局偏移）' });
        trace.push({ step: '② 偏移源定位', data: attr.target ? `最大 shift 目标: ${attr.target}` : (Array.isArray(attr.shifts) ? `${attr.shifts.length} 次 shift` : '采集端仅上报累计值（未上报 shift 元素）'), conclusion: 'CLS 是累计值，需定位最大 shift 元素' });
        trace.push({ step: '③ 主因推断', data: attr.target || '图片/广告/字体/动态插入', conclusion: '元素未预留空间 → 渲染后尺寸变化 → 后续元素跳动' });
        findings.push({ title: '布局抖动', evidence: `CLS=${clsVal.toFixed(3)}；${attr.target ? '最大 shift: ' + attr.target : '元素未预留空间'}`, severity: clsVal > 0.25 ? 'high' : 'medium' });
        fixes.push({ problem: '元素未预留空间导致跳动', solution: '图片/视频/广告设 width/height 或 aspect-ratio；避免上方动态插入；字体 font-display:swap + size-adjust', code: 'img, video { aspect-ratio: 16/9; width: 100%; }\n.ad-slot { min-height: 90px; }' });
      } else if (name === 'TTFB') {
        const ttfbVal = typeof sample.value === 'number' ? sample.value : 0;
        trace.push({ step: '① TTFB 值', data: `${ttfbVal.toFixed(0)}ms (${agg.worstRating})`, conclusion: '基线 good≤800 / poor>1800（首字节时间）' });
        trace.push({ step: '② 主因', data: ttfbVal > 1800 ? '服务端响应慢' : ttfbVal > 800 ? '边缘缓存未命中 / 冷启动' : '正常', conclusion: 'TTFB = DNS + 连接 + 请求 + 服务端处理' });
        findings.push({ title: '服务端响应', evidence: `TTFB=${ttfbVal.toFixed(0)}ms`, severity: ttfbVal > 1800 ? 'high' : 'low' });
        fixes.push({ problem: 'TTFB 高', solution: 'CDN/边缘缓存 + HTTP/2+ + SSR 缓存 + dns-prefetch/preconnect', code: '<link rel="preconnect" href="https://api.example.com">\nCache-Control: public, max-age=3600' });
      } else if (name === 'FCP') {
        const fcpVal = typeof sample.value === 'number' ? sample.value : 0;
        trace.push({ step: '① FCP 值', data: `${fcpVal.toFixed(0)}ms (${agg.worstRating})`, conclusion: '基线 good≤1800 / poor>3000（首次内容绘制）' });
        trace.push({ step: '② 主因', data: fcpVal > 3000 ? '渲染阻塞资源(JS/CSS)或 TTFB 慢' : '正常', conclusion: 'FCP 受 TTFB + 渲染阻塞资源影响' });
        findings.push({ title: '首屏渲染', evidence: `FCP=${fcpVal.toFixed(0)}ms`, severity: fcpVal > 3000 ? 'high' : 'low' });
        fixes.push({ problem: '首屏渲染阻塞', solution: '关键 CSS 内联；非关键 JS defer/async；减少首屏阻塞资源', code: '<script defer src="...">\n<style>/* critical CSS */</style>' });
      }
      if (sourceLocation && sourceLocation.resolved) {
        findings.push({ title: `耗时定位到源码：${sourceLocation.source}:${sourceLocation.line}`, evidence: `LoAF 脚本 ${loafScript?.sourceFunctionName || '<anon>'}（${loafScript?.duration?.toFixed(0) || '?'}ms）→ ${sourceLocation.source}:${sourceLocation.line}:${sourceLocation.column}`, severity: 'critical' });
        fixes.push({ problem: `${loafScript?.sourceFunctionName || '该函数'} 耗时`, solution: '查看下方源码片段定位的具体行，针对性优化（拆分 / 缓存 / 异步化）', code: sourceLocation.sourceSnippet });
      }
      // 火焰图（INP）+ 归因候选链 + 确定性自愈建议（复用 @monit/diagnose，非黑箱）
      let flamegraph: PerfFlamegraphData | undefined;
      let attribution: AttributionRecord | undefined;
      let healActions: HealAction[] = [];
      try {
        const inp = name === 'INP' ? (sample as unknown as InpAttribution) : undefined;
        const report: DiagnosticReport = {
          id: 'rca-' + name, url: '', createdAt: Date.now(),
          vitals: name === 'INP' ? [] : [{ name: name as VitalMetric['name'], value: typeof sample.value === 'number' ? sample.value : 0, rating: agg.worstRating as VitalMetric['rating'] }],
          inp, errors: [], longTasks: [],
          loafEntries: inp?.longAnimationFrameEntries ?? [],
          summary: { issueCount: 1, worstSeverity: 'warning', headline: name },
        };
        if (name === 'INP') flamegraph = buildPerfFlamegraph(report);
        const records = analyzeRootCauses(report);
        attribution = records[0];
        healActions = proposeHealActions(records);
      } catch { /* 归因计算失败不影响主 RCA */ }
      return { status: 200, body: { metric: { name, value: agg.p75, rating: agg.worstRating, p75: agg.p75, p99: agg.p99, count: agg.count }, userStory: a.userStory, userActions: a.userActions, page: a.page, dominantCause: a.dominantCause, baseline: a.baseline, sourceLocation, loafScript, trace, findings, fixes, flamegraph, attribution, healActions } };
    }},
    { method: 'GET', path: '/api/vitals/:name/trend', policy: 'read', handler: async (ctx) => {
      const name = (ctx.params.name || '').toUpperCase();
      return { status: 200, body: { name, samples: store.vitalsSamples(name) } };
    }},
    // demo 自愈轨：无 LLM key 时跑 stub-LLM + 真实 gate（fs+vitest+assessGate）；coordinator strong-ready 时代理真 /auto-heal
    { method: 'POST', path: '/api/demo/heal', policy: 'write', handler: async () => {
      const logs: string[] = [];
      try {
        if (opts.autoHeal?.coordinatorUrl) {
          try {
            const h = await (await fetch(`${opts.autoHeal.coordinatorUrl}/health`)).json() as { strongReady?: boolean };
            if (h.strongReady) {
              const r = await fetch(`${opts.autoHeal.coordinatorUrl}/auto-heal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(opts.autoHeal.coordinatorToken ? { Authorization: `Bearer ${opts.autoHeal.coordinatorToken}` } : {}) },
                body: JSON.stringify({
                  mode: 'strong',
                  sourceFiles: opts.autoHeal.sourceFiles ?? [],
                  testFiles: opts.autoHeal.testFiles ?? [],
                  symptom: "TypeError: Cannot read properties of null (reading 'map') - renderList 在 API 返回 null 时崩溃",
                  stack: "TypeError: Cannot read properties of null (reading 'map')\n    at renderList (src/renderList.js:3:15)",
                  behaviorPreserving: false,
                }),
              });
              const data = await r.json() as Record<string, unknown>;
              return { status: 200, body: { track: 'strong', note: '真 LLM 跨 provider Verifier + 真 PR（coordinator strong 轨）', result: data, stages: [], logs } };
            }
          } catch { /* coordinator 不可用 -> 落 demo 轨 */ }
        }
        const demo = await runDemoHeal((m) => logs.push(m));
        return { status: 200, body: { ...demo, logs } };
      } catch (e) {
        return { status: 500, body: { error: e instanceof Error ? e.message : String(e), logs } };
      }
    }},
    { method: 'GET', path: '/api/sessions', policy: 'read', handler: async () => ({ status: 200, body: { sessions: store.sessionsList() } }) },

    // ── sourcemap ──
    { method: 'POST', path: '/api/sourcemaps/upload', policy: 'write', bodyMax: 16_000_000, handler: async (ctx) => {
      const appId = ctx.query.get('appId') ?? 'default';
      const version = ctx.query.get('version') ?? 'latest';
      const filename = ctx.query.get('filename') ?? 'bundle.js';
      try {
        const stored = sourcemaps.save(appId, version, filename, ctx.rawBody);
        return { status: 200, body: { ok: true, stored } };
      } catch (e) {
        return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
      }
    }},
    { method: 'POST', path: '/api/sourcemaps/resolve', policy: 'write', handler: async (ctx) => {
      const b = (ctx.body ?? {}) as { appId?: string; version?: string; stack?: string };
      const frames = await sourcemaps.resolveStack(b.appId ?? 'default', b.version ?? 'latest', b.stack ?? '');
      return { status: 200, body: { frames } };
    }},
    // LoAF 归因还原：sourceURL + sourceCharPosition → sourcemap 还原到源码行（INP 根因下钻源码）
    { method: 'POST', path: '/api/sourcemaps/resolve-loaf', policy: 'write', handler: async (ctx) => {
      const b = (ctx.body ?? {}) as { appId?: string; version?: string; url?: string; charPosition?: number };
      const url = b.url ?? '';
      const filename = url.split('?')[0].split('/').pop() ?? url;
      const frame = await sourcemaps.resolveGeneratedCharPosition(b.appId ?? 'default', b.version ?? 'latest', filename, Number(b.charPosition ?? 0));
      return { status: 200, body: { frame } };
    }},

    // ── spans（跨层 trace join）──
    { method: 'POST', path: '/api/spans', policy: 'write', handler: async (ctx) => {
      const parsed = ctx.body;
      const spans: SpanRecord[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { spans?: SpanRecord[] })?.spans) ? (parsed as { spans: SpanRecord[] }).spans : [];
      store.ingestSpans(spans);
      return { status: 200, body: { ok: true, ingested: spans.length } };
    }},
    { method: 'GET', path: '/api/traces/:traceId/spans', policy: 'read', handler: async (ctx) => {
      const traceId = ctx.params.traceId ?? '';
      return { status: 200, body: { traceId, spans: store.spansForTrace(traceId), slowSpans: store.slowSpansForTrace(traceId) } };
    }},
  ];

  const router = new HttpRouter(guard, routes);
  const server = http.createServer((req, res) => {
    setupSpan(req, res);
    void router.handle(req, res);
  });
  server.listen(port, host);

  return {
    server,
    store,
    close: () => new Promise((resolve) => { server.close(() => { persister?.close(); resolve(); }); }),
  };
}

/**
 * 自动 AI 诊断（后台触发）。fire-and-forget，错误流即用 @monit/repair-agent chat 调 LLM 出诊断+修复建议。
 * 鲁棒性：LLM 可能不严格遵循格式。优先结构化解析；不匹配时兜底用原始输出（低置信），不静默丢。
 */
async function runAiDiagnosis(
  llmConfig: LLMConfig,
  g: ErrorGroup,
): Promise<{ diagnosis: string; suggestedFix: string; confidence: number; ts: number; formatMatched: boolean } | null> {
  try {
    const payload = g.sample.payload as { message?: string; stack?: string };
    const userPrompt = `你是资深前端工程师。诊断以下错误并给出最小修复建议（2-3 句）。

错误: ${payload?.message ?? '未知'}
${payload?.stack ? `栈: ${payload.stack.slice(0, 600)}` : ''}

严格用以下格式输出（不要其他内容）：
===DIAGNOSIS===
<根因>
===FIX===
<最小修复>`;

    const res = await chat(llmConfig, [
      { role: 'system', content: '只输出 ===DIAGNOSIS=== 和 ===FIX=== 两段。基于堆栈，不复述问题。' },
      { role: 'user', content: userPrompt },
    ]);

    const d = res.content.match(/===DIAGNOSIS===\s*([\s\S]*?)(?:===FIX===|$)/i)?.[1]?.trim() ?? '';
    const f = res.content.match(/===FIX===\s*([\s\S]*?)$/i)?.[1]?.trim() ?? '';
    const formatMatched = d.length >= 8 && f.length >= 4;
    const diagnosis = formatMatched ? d : (res.content.trim().slice(0, 300) || '(LLM 无输出)');
    const suggestedFix = formatMatched ? f : '(未按格式输出，请人工审查)';
    return { diagnosis, suggestedFix, confidence: formatMatched ? 0.7 : 0.4, ts: Date.now(), formatMatched };
  } catch {
    return null;
  }
}
