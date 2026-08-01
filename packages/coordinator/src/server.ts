/**
 * @monit/coordinator/server - 本地 HTTP 协调总线（生产级加固）
 *
 * 用 @monit/server-kit 的 HttpRouter：守卫（鉴权/Origin/限流/有界 body/审计）在 dispatch 层
 * 强制 —— 每个写端点必经中间件，无旁路。CORS 不再用 '*'，按 Origin 白名单回显。
 *
 * 端点（policy）：
 * - GET  /health                 (open)
 * - GET  /heal/public-key        (open)  下发 Ed25519 公钥（SDK 验签用）
 * - GET  /events                 (read)
 * - POST /events                 (write)
 * - POST /ai/patch               (write) LLM 源码补丁（轨道 B）
 * - POST /pr/create              (write) GitHub PR（轨道 B）
 * - POST /auto-heal              (write) 自愈闭环（strong/draft）
 * - POST /heal/apply             (write) 运行时热修登记（轨道 A，Ed25519 签名 + AST 校验）
 * - GET  /heal/patches           (sdk)   SDK 拉取活跃签名 patch（独立 sdkToken）
 * - POST /heal/revoke            (write) 吊销 patch
 */

import http from 'node:http';
import type { BusEvent, AiPatchProposal, DiagnosticReport, PrResult, AttributionRecord } from '@monit/contracts';
import {
  HttpRouter, RateLimiter, generateSigningKeyPair, publicKeyToSpkiBase64, consoleAudit,
  type GuardConfig, type RouteSpec, type AuditSink,
} from '@monit/server-kit';
import type { KeyObject } from 'node:crypto';
import { EventBus } from './event-bus';
import { generatePatch, type PatchContext } from './llm-patch';
import { runMrDraftTrack } from './mr-draft-track';
import { runRealHealPipeline } from './heal-runner';
import { createGithubPr, applyPatchesLocally, type GithubConfig } from './github-pr';
import { PatchRegistry, type HotfixPatchType } from './patch-registry';
import type { ChangeEvent, AnomalySignal } from '@monit/diagnose';
import type { LLMConfig } from '@monit/repair-agent';

export interface SigningKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface CoordinatorOptions {
  port?: number;
  host?: string;
  /** 写端点 bearer token；未配置时 loopback 放行、非 loopback 拒绝。strong 自愈轨要求已配置。*/
  authToken?: string;
  /** /heal/patches 等只读 SDK 端点的独立 token；未配置则回退 authToken */
  sdkToken?: string;
  allowOrigins?: string[];
  allowLoopbackOrigin?: boolean;
  llmConfig?: LLMConfig;
  /** 独立模型 Verifier 配置（强门禁路径 BP-2；须与 llmConfig 不同 model id）*/
  verifierConfig?: LLMConfig;
  githubConfig?: GithubConfig;
  /** 目标仓库根（强门禁路径：写盘 + 跑 vitest/tsc + git 回滚需要）*/
  repoRoot?: string;
  /** Ed25519 签名密钥对（不传则启动时生成；公钥经 /heal/public-key 下发 SDK）*/
  signingKeyPair?: SigningKeyPair;
  patchTtlMs?: number;
  audit?: AuditSink;
  /** 文件读写抽象（本地 fs 或 mock） */
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
}

export interface CoordinatorHandle {
  server: http.Server;
  bus: EventBus;
  patchRegistry: PatchRegistry;
  /** Ed25519 公钥 base64（下发给 SDK 用于验签）*/
  publicKeyBase64: string;
  close(): Promise<void>;
}

export function createCoordinatorServer(opts: CoordinatorOptions = {}): CoordinatorHandle {
  const bus = new EventBus(50);
  const kp = opts.signingKeyPair ?? generateSigningKeyPair();
  const patchRegistry = new PatchRegistry(kp.privateKey, kp.publicKey, opts.patchTtlMs);
  const publicKeyBase64 = publicKeyToSpkiBase64(kp.publicKey);
  const port = opts.port ?? 3920;
  const host = opts.host ?? '127.0.0.1';

  const rl = (c: number, r: number) => new RateLimiter({ capacity: c, refillPerSec: r });
  const guard: GuardConfig = {
    authToken: opts.authToken,
    sdkToken: opts.sdkToken,
    allowOrigins: opts.allowOrigins ?? [],
    allowLoopbackOrigin: opts.allowLoopbackOrigin ?? true,
    bodyMax: { write: 4_000_000, read: 1_000_000, sdk: 64_000, open: 8_000 },
    rateLimit: { write: rl(20, 5), read: rl(100, 20), sdk: rl(60, 10), open: rl(30, 5) },
    audit: opts.audit ?? consoleAudit,
  };

  const routes: RouteSpec[] = [
    { method: 'GET', path: '/health', policy: 'open', handler: async () => ({ status: 200, body: {
      ok: true, uptime: process.uptime(),
      llmConfigured: !!opts.llmConfig,
      githubConfigured: !!opts.githubConfig,
      verifierConfigured: !!opts.verifierConfig,
      repoRootConfigured: !!opts.repoRoot,
      /** strong 自愈轨就绪：repo + 独立 verifier + GitHub + authToken 齐备 -> 可跑真跨 provider Verifier + 真 PR */
      strongReady: !!opts.repoRoot && !!opts.verifierConfig && !!opts.githubConfig && !!opts.authToken,
    } }) },
    { method: 'GET', path: '/heal/public-key', policy: 'open', handler: async () => ({ status: 200, body: { publicKey: publicKeyBase64 } }) },

    { method: 'GET', path: '/events', policy: 'read', handler: async () => ({ status: 200, body: { events: bus.recent() } }) },
    { method: 'POST', path: '/events', policy: 'write', handler: async (ctx) => { bus.publish(ctx.body as BusEvent); return { status: 201, body: { ok: true } }; } },

    { method: 'POST', path: '/ai/patch', policy: 'write', handler: async (ctx) => {
      if (!opts.llmConfig) return { status: 503, body: { error: 'LLM not configured' } };
      const c = ctx.body as PatchContext;
      if (!c?.record || !c?.files) return { status: 400, body: { error: 'missing record/files' } };
      const proposal = await generatePatch(opts.llmConfig, c);
      if (!proposal) return { status: 422, body: { error: 'LLM produced no valid patch (searchCode validation failed)' } };
      bus.publish({ type: 'ai.patch.ready', proposal });
      return { status: 200, body: { proposal } };
    }},

    { method: 'POST', path: '/pr/create', policy: 'write', handler: async (ctx) => {
      if (!opts.githubConfig) return { status: 503, body: { error: 'GitHub not configured' } };
      const { proposal, branch } = (ctx.body ?? {}) as { proposal: AiPatchProposal; branch?: string };
      if (!proposal) return { status: 400, body: { error: 'missing proposal' } };
      if (opts.fs) await applyPatchesLocally(proposal, opts.fs.readFile, opts.fs.writeFile);
      const branchName = branch ?? `fix/smarty-${proposal.id.slice(-8)}`;
      const result = await createGithubPr(opts.githubConfig, proposal, branchName);
      bus.publish({ type: 'pr.created', result });
      return { status: result.ok ? 200 : 502, body: { result } };
    }},

    // POST /auto-heal：strong（README headline）= runRealHealPipeline（Verifier + repro + gate）；
    // draft（无 repo）= runMrDraftTrack（仅 guardrails）。strong 轨额外要求 authToken 已配（不允许无鉴权下写盘+开PR）。
    { method: 'POST', path: '/auto-heal', policy: 'write', handler: async (ctx) => {
      if (!opts.llmConfig) return { status: 503, body: { error: 'LLM not configured' } };
      if (!opts.githubConfig) return { status: 503, body: { error: 'GitHub not configured' } };
      const b = (ctx.body ?? {}) as {
        record?: AttributionRecord; sourceFiles?: Array<{ path: string; content: string }>;
        testFiles?: Array<{ path: string; content: string }>; riskThreshold?: number;
        changes?: ChangeEvent[]; anomaly?: AnomalySignal;
        mode?: 'strong' | 'draft'; repoRoot?: string; verifierConfig?: LLMConfig;
        symptom?: string; stack?: string; goldPatches?: string[]; behaviorPreserving?: boolean; maxAttempts?: number;
      };
      if (!b.record && !b.sourceFiles) return { status: 400, body: { error: 'missing record/sourceFiles' } };

      const verifierConfig = b.verifierConfig ?? opts.verifierConfig;
      const repoRoot = b.repoRoot ?? opts.repoRoot;
      const wantStrong = b.mode === 'strong' || (b.mode !== 'draft' && !!repoRoot && !!verifierConfig);

      if (wantStrong) {
        if (!opts.authToken) return { status: 400, body: { error: 'strong heal track requires authToken configured (no unauthed write/PR)' } };
        if (!repoRoot) return { status: 400, body: { error: 'strong mode requires repoRoot (to run vitest/tsc on disk)' } };
        if (!verifierConfig) return { status: 400, body: { error: 'strong mode requires verifierConfig (independent model, BP-2)' } };
        const symptom = b.symptom ?? (typeof b.record?.symptom?.observed === 'string' ? b.record.symptom.observed : 'auto-heal');
        const heal = await runRealHealPipeline({
          repoRoot, diagnoserConfig: opts.llmConfig, verifierConfig, symptom, stack: b.stack,
          focusFiles: b.sourceFiles ?? [], goldPatches: b.goldPatches ?? [], githubConfig: opts.githubConfig,
          behaviorPreserving: b.behaviorPreserving ?? false, maxAttempts: b.maxAttempts,
        });
        const delivery = heal.delivery as PrResult | { applied?: boolean; rollback?: () => void } | null;
        if (heal.decision?.delivery === 'auto-mr' && delivery && typeof (delivery as PrResult).prUrl === 'string') {
          bus.publish({ type: 'pr.created', result: delivery as PrResult });
        }
        return { status: 200, body: { track: 'strong', decision: heal.decision, resolved: heal.resolved, verifier: heal.verifier, repro: heal.repro, regressionVotes: heal.regressionVotes, delivery: heal.delivery } };
      }

      // 草稿轨（无 repo 跑测试）：仅 guardrails，不含 Verifier/回归/门禁（诚实降级）
      if (!b.record || !b.sourceFiles) return { status: 400, body: { error: 'draft track requires record + sourceFiles' } };
      const report: DiagnosticReport = {
        id: 'rep-' + (b.record.symptomId || 'auto'), url: '', createdAt: Date.now(),
        vitals: [], inp: undefined, errors: [{ id: b.record.symptomId || 'auto', type: 'js', message: typeof b.record.symptom.observed === 'string' ? b.record.symptom.observed : '', timestamp: Date.now() }],
        longTasks: [], loafEntries: [], summary: { issueCount: 1, worstSeverity: 'critical', headline: 'auto-heal' },
      };
      const result = await runMrDraftTrack({
        report, sourceFiles: b.sourceFiles, changes: b.changes ?? [],
        anomaly: b.anomaly ?? { startedAt: Date.now(), spikeRatio: 1 }, testFiles: b.testFiles ?? [],
        goldPatches: b.goldPatches ?? [], llmConfig: opts.llmConfig, githubConfig: opts.githubConfig,
        ...(opts.fs ? { fs: opts.fs } : {}), ...(b.riskThreshold !== undefined ? { riskThreshold: b.riskThreshold } : {}),
      });
      bus.publish({ type: 'ai.patch.ready', proposal: result.proposal || ({ id: '', basedOn: '', track: 'mr-draft', patchType: 'replace', diagnosis: '', patches: [], riskNotes: [], riskScore: 0, createdAt: 0 } as never) });
      if (result.prResult) bus.publish({ type: 'pr.created', result: result.prResult });
      return { status: 200, body: { track: 'draft', ...result } };
    }},

    // POST /heal/apply - 轨道 A 运行时热修：登记 Ed25519 签名 patch（含 AST 严格校验）
    { method: 'POST', path: '/heal/apply', policy: 'write', handler: async (ctx) => {
      const b = (ctx.body ?? {}) as { fingerprint?: string; patchType?: HotfixPatchType; targetPath?: string; code?: string };
      if (!b.fingerprint || !b.patchType) return { status: 400, body: { error: 'missing fingerprint/patchType' } };
      if (!['replace', 'wrap', 'guard'].includes(b.patchType)) {
        return { status: 400, body: { error: `patchType must be replace|wrap|guard (behavior-preserving; no masking/prototype)` } };
      }
      let reg;
      try {
        reg = patchRegistry.register({ fingerprint: b.fingerprint, patchType: b.patchType, targetPath: b.targetPath, code: b.code });
      } catch (e) {
        return { status: 400, body: { error: e instanceof Error ? e.message : String(e) } };
      }
      bus.publish({ type: 'heal.applied', ids: [reg.patchId], rollbackToken: reg.rollbackToken });
      return { status: 200, body: { applied: true, track: 'runtime-hotfix', patchId: reg.patchId, rollbackToken: reg.rollbackToken, signature: reg.signature, nonce: reg.nonce, expiresAt: reg.expiresAt, note: '轨道 A：Ed25519 签名 patch 已入注册表（AST 校验通过）。SDK 拉取 /heal/patches 按指纹应用（行为保留，可回滚）。' } };
    }},

    // GET /heal/patches - SDK 拉取活跃签名 patch（独立 sdkToken）
    { method: 'GET', path: '/heal/patches', policy: 'sdk', handler: async () => ({ status: 200, body: { patches: patchRegistry.active(), publicKey: publicKeyBase64 } }) },

    // POST /heal/revoke - 吊销（回滚）一个 patch
    { method: 'POST', path: '/heal/revoke', policy: 'write', handler: async (ctx) => {
      const b = (ctx.body ?? {}) as { patchId?: string; rollbackToken?: string };
      const ok = b.patchId ? patchRegistry.revoke(b.patchId) : b.rollbackToken ? patchRegistry.revokeByToken(b.rollbackToken) : false;
      return { status: ok ? 200 : 404, body: { ok, revoked: ok } };
    }},
  ];

  const router = new HttpRouter(guard, routes);
  const server = http.createServer((req, res) => void router.handle(req, res));
  server.listen(port, host);

  return {
    server, bus, patchRegistry, publicKeyBase64,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
