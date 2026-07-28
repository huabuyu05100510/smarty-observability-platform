/**
 * @monit/repair-agent - 端侧 AI 自愈引擎（确定性×AI 混合）
 *
 * 升级版循环：diagnose -> ★ verifyAdversarially -> inject -> regression-verify -> ★ assessConfidence
 *
 * 研究依据（2026-07 调研）：
 * - Verifier 反事实对抗验证：对标 F1 88.4% 论文的 Adversarial Validation Protocol
 * - 信心门禁：AI 不做确定性门禁，高信心自动 MR / 低信心转人工
 * - 回归投票：3-replay 多数投票，不信任 LLM 置信度
 *
 * 吸收 sentinel-x v2.2 的 ReAct + 5 patch + 回归 + sourcemap + gravity-tracer，
 * 升级点为 Verifier 与信心门禁。
 */

export { chat, chatJson, preflight, extractJson, normalizeBaseUrl, type LLMConfig, type ChatMessage, type ChatResult } from './llm-client';
export { verifyAdversarially, verifyAdversariallyPanel, type DiagnosisInput } from './verifier';
export { runRegression, type RegressionOptions } from './regression-runner';
export { assessConfidence, type LocalitySignals, type ConfidenceGateInput, type ConfidenceGateOutput } from './confidence';
export { runHarness, type HarnessDeps, type HarnessResult, type Diagnosis } from './harness';
export {
  buildInjectionExpression,
  buildSmartFetchExpression,
  executePatch,
  type CdpClient,
  type PatchInput,
  type InjectionResult,
} from './patch-executor';
export { SourceMapResolver, type SourceMapLoader, type PersistentCache, type RawFrame, type ResolvedFrame } from './source-map-resolver';