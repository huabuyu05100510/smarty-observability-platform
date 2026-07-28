/**
 * @monit/contracts — 统一 schema 层
 *
 * 全平台唯一事件信封 + 归因载体 + 修复提案 + 回归判定。
 * 种子来自 smarty-monitor/contracts + monitor-sdk core/types + 技术方案 §6。
 *
 * 确定性×AI 混合范式的契约基础：所有采集器、后端、面板、修复引擎
 * 都用这套 schema，消除"三套独立 trace、0 共享契约"的结构性断层。
 *
 * 对标：OpenTelemetry semantic conventions + Sentry Event schema + Datadog RUM events
 */

// ═══════════════════════════════════════════════════════════════════════
// 0. 基础枚举
// ═══════════════════════════════════════════════════════════════════════

export type Severity = 'info' | 'warning' | 'critical';

/** 确定性×AI 门禁：高信心 = 自动 MR 草稿，低信心 = 仅诊断转人工 */
export type ConfidenceTier = 'high' | 'low';

/** Patch 类型（sentinel-x 五类） */
export type PatchType = 'replace' | 'wrap' | 'guard' | 'error-boundary' | 'prototype';

/** 修复判定（脱离"pass/fail"二元，对标 SWE-bench 经验） */
export type PatchVerdict = 'fixed' | 'partial' | 'failed';

/** 自愈模式 */
export type HealMode = 'diagnose_only' | 'heal_safe' | 'ai_patch' | 'open_pr';

// ═══════════════════════════════════════════════════════════════════════
// 1. 原始信号（L1 采集层产出）
// ═══════════════════════════════════════════════════════════════════════

export interface ErrorSignal {
  id: string;
  type: 'js' | 'promise' | 'resource' | 'console' | 'react';
  message: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  timestamp: number;
  sourceURL?: string;
  componentStack?: string; // React error boundary
  handled?: boolean;
}

export interface VitalMetric {
  name: 'FCP' | 'LCP' | 'CLS' | 'INP' | 'TTFB';
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  attribution?: Record<string, unknown>;
}

export interface InpAttribution {
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  interactionTarget?: string;
  interactionType?: string;
  inputDelay: number;
  processingDuration: number;
  presentationDelay: number;
  loadState?: string;
  longAnimationFrameEntries?: LoafEntry[];
}

export interface LoafScriptFrame {
  id: string;
  name: string;
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  duration: number;
  startTime: number;
  forcedStyleAndLayoutDuration?: number;
  pauseDuration?: number;
}

export interface LoafEntry {
  id: string;
  startTime: number;
  duration: number;
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  firstUIEventTimestamp?: number;
  scripts: LoafScriptFrame[];
}

export interface LongTaskSignal {
  id: string;
  startTime: number;
  duration: number;
  name?: string;
  attribution?: Array<{
    name?: string;
    containerType?: string;
    containerSrc?: string;
  }>;
}

export interface WhiteScreenSignal {
  detected: boolean;
  validRatio: number;
  threshold: number;
  preset: '9' | '17' | '33';
  hitCount: number;
  totalPoints: number;
  rootCause: 'js_error' | 'resource_404' | 'unknown';
  recentErrors: Array<{ message: string; source?: string; type?: string }>;
  failedResources: Array<{ url: string; tagName: string }>;
  retryHits?: number;
  retryTotal?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. DiagnosticReport（L1 采集层聚合快照，对标 Chrome DevTools trace）
// ═══════════════════════════════════════════════════════════════════════

export interface DiagnosticReport {
  id: string;
  url: string;
  route?: string;
  createdAt: number;
  vitals: VitalMetric[];
  inp?: InpAttribution;
  errors: ErrorSignal[];
  longTasks: LongTaskSignal[];
  loafEntries: LoafEntry[];
  whiteScreen?: WhiteScreenSignal;
  summary: {
    issueCount: number;
    worstSeverity: Severity;
    headline: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 3. AttributionRecord（L4 产出，跨层归因载体）
// ═══════════════════════════════════════════════════════════════════════

export type AttributionKind =
  | 'inp.input_delay'
  | 'inp.processing'
  | 'inp.presentation'
  | 'lcp.resource'
  | 'lcp.element'
  | 'cls.shift'
  | 'error.js'
  | 'error.promise'
  | 'error.resource'
  | 'error.react'
  | 'white_screen'
  | 'long_task'
  | 'deployment'
  | 'traffic_spike'
  | 'infra_failure'
  | 'dependency'
  | 'code_hotspot'
  | 'llm_rca'
  | 'unknown';

/** 单个归因候选（按置信度排序） */
export interface AttributionCandidate {
  kind: AttributionKind;
  confidence: number; // 0–1
  evidence: string[];
  anchors: {
    scriptURL?: string;
    sourceFunctionName?: string;
    stackTop?: string;
    interactionTarget?: string;
    loafEntryId?: string;
    errorId?: string;
    traceSpanId?: string; // 指向后端慢 span
    commitSha?: string; // 变更关联
  };
  suggestedHealIds: string[];
  playbookId?: string;
}

/** 归因记录：症状 → 候选根因链（按置信度降序） */
export interface AttributionRecord {
  id: string;
  symptomId: string;
  symptom: {
    kind: 'error' | 'perf' | 'white-screen';
    metric?: string;
    observed: unknown;
  };
  candidates: AttributionCandidate[];
  severity: Severity;
  /** 关联 trace，可下钻后端 span */
  traceId?: string;
  /** 关联 tracesdk 溯源 DAG 节点 */
  provenanceNode?: string;
  createdAt: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 4. HealAction（L6 确定性自愈建议，safe 白名单）
// ═══════════════════════════════════════════════════════════════════════

export type HealActionId =
  | 'suggest_scheduler_yield'
  | 'suggest_quiet_wrap'
  | 'suggest_debounce'
  | 'inject_error_boundary_hint'
  | 'safe_null_guard_hint';

export interface HealAction {
  id: HealActionId;
  label: string;
  description: string;
  safe: boolean;
  basedOn: string; // 关联的 AttributionCandidate.id
  payload?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════
// 5. AiPatchProposal（L6 AI 修复提案，source-level）
// ═══════════════════════════════════════════════════════════════════════

export interface PatchHunk {
  filePath: string;
  searchCode: string;
  replaceCode: string;
}

export interface AiPatchProposal {
  id: string;
  basedOn: string; // AttributionRecord.id
  track: 'runtime-hotfix' | 'mr-draft';
  patchType: PatchType;
  diagnosis: string;
  patches: PatchHunk[];
  targetPath?: string;
  targetFunction?: string;
  code?: string; // runtime hotfix code
  riskNotes: string[];
  riskScore: number; // 0–1
  createdAt: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 6. PatchResult（L6 回归验证输出，3-replay 多数投票）
// ═══════════════════════════════════════════════════════════════════════

export interface PatchResult {
  proposalId: string;
  verdict: PatchVerdict;
  /** injected = CDP Runtime.evaluate 成功 */
  injected: boolean;
  injectionError?: string;
  /** regressionPassed = 3-replay ≥2 通过 */
  regressionPassed: boolean;
  replays: number;
  passes: number;
  appliedAt?: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 7. VerifierResult（L6 对抗式 Verifier agent 输出，★ 本轮升级）
// ═══════════════════════════════════════════════════════════════════════

export interface VerifierResult {
  /** 诊断是否被证伪 */
  refuted: boolean;
  /** 证伪理由（反事实推理） */
  reason: string;
  /** 若被证伪，给出替代假设 */
  alternativeHypothesis?: string;
  /** 验证置信度 0–1 */
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 8. PrResult（L6 MR 交付）
// ═══════════════════════════════════════════════════════════════════════

export interface PrResult {
  ok: boolean;
  branch?: string;
  prUrl?: string;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// 9. BusEvent（L2 统一上下文事件总线）
// ═══════════════════════════════════════════════════════════════════════

export type BusEvent =
  | { type: 'diag.started'; target: string }
  | { type: 'diag.finished'; report: DiagnosticReport }
  | { type: 'attr.finished'; records: AttributionRecord[] }
  | { type: 'heal.proposed'; actions: HealAction[] }
  | { type: 'heal.applied'; ids: string[]; rollbackToken: string }
  | { type: 'ai.patch.ready'; proposal: AiPatchProposal }
  | { type: 'pr.created'; result: PrResult }
  | { type: 'verifier.ruled'; result: VerifierResult }
  | { type: 'retest.requested' }
  | { type: 'retest.finished'; report: DiagnosticReport; beforeId: string };

// ═══════════════════════════════════════════════════════════════════════
// 10. 火焰图（L4 可视化，对标 Brendan Gregg 方法论）
// ═══════════════════════════════════════════════════════════════════════

export interface PerfFlameRow {
  id: string;
  name: string;
  kind: 'frame' | 'script' | 'task' | 'inp_phase';
  startMs: number;
  durationMs: number;
  depth: number;
  children: PerfFlameRow[];
  meta?: Record<string, unknown>;
  isHot?: boolean;
  /** 是否为合成回退帧（LoAF 数据不足时） */
  synthetic?: boolean;
}

export interface PerfFlamegraphData {
  roots: PerfFlameRow[];
  totalMs: number;
  p99: number;
}

// ═══════════════════════════════════════════════════════════════════════
// 11. MonitorEvent（全平台唯一事件信封，L2 统一上下文）
// ═══════════════════════════════════════════════════════════════════════

export type MonitorEventType =
  | 'error'
  | 'vital'
  | 'resource'
  | 'white-screen'
  | 'breadcrumb'
  | 'trace'
  | 'ai'
  | 'long-task'
  | 'request';

export type MonitorEventSubType =
  | 'js'
  | 'promise'
  | 'resource'
  | 'react'
  | 'console'
  | 'lcp'
  | 'inp'
  | 'cls'
  | 'fcp'
  | 'ttfb'
  | 'loaf'
  | 'fetch'
  | 'xhr'
  | 'slow';

export interface ErrorFingerprint {
  primary: string; // 栈指纹（FNV-1a + top-3 归一化栈帧）
  secondary?: string; // URL/类型指纹（djb2 + URL 去参泛化）
}

export interface MonitorEvent {
  // 身份与上下文
  id: string;
  type: MonitorEventType;
  subType: MonitorEventSubType;
  timestamp: number;

  // 统一上下文（L2 — W3C trace）
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId: string;
  release: string; // 版本/commit，变更归因用

  // 载荷（按 type/subType 分化）
  payload: unknown;

  // 治理
  piiSafe: boolean; // 已过 PII 脱敏
  sampled: boolean; // 经采样
  sampleRate?: number;

  // 错误专属（可空）
  fingerprint?: ErrorFingerprint;

  // 元数据
  tags?: Record<string, string>;
  user?: { id?: string; anonymousId?: string };
}