/**
 * @monit/coordinator/mr-draft-track - MR 草稿闭环编排（轨道 B）
 *
 * 串起：diagnoseWithCorrelation -> generatePatch -> guardrails(测试充分性+污染)
 * -> 决策 -> applyPatchesLocally -> createGithubPr。
 *
 * 研究原则：企业全自动 MR <18% -> 半自动 + 人审。轨道 B 永远开 PR 供人审，
 * guardrails 决定 PR 标记（auto-ready vs needs-tests-first）而非是否合入。
 *
 * 与轨道 A（运行时热修，Verifier+回归）互补：B 治本（源码 PR），A 治标（CDP 可逆注入）。
 */

import type {
  AiPatchProposal,
  AttributionRecord,
  DiagnosticReport,
  PrResult,
} from '@monit/contracts';
import { diagnoseWithCorrelation, type ChangeEvent, type AnomalySignal } from '@monit/diagnose';
import { assessTestSufficiency, detectContamination } from '@monit/guardrails';
import { generatePatch } from './llm-patch';
import { applyPatchesLocally, createGithubPr, type GithubConfig } from './github-pr';
import type { LLMConfig } from '@monit/repair-agent';

export interface MrDraftTrackOptions {
  report: DiagnosticReport;
  changes: ChangeEvent[];
  anomaly: AnomalySignal;
  /** 错误栈帧关联的源文件（已读取） */
  sourceFiles: Array<{ path: string; content: string }>;
  /** 仓库内测试文件（测试充分性护栏用） */
  testFiles: Array<{ path: string; content: string }>;
  /** 自建回归集 gold patch（污染检测用） */
  goldPatches: string[];
  llmConfig: LLMConfig;
  githubConfig?: GithubConfig;
  /** 文件读写抽象（本地 fs 或 mock） */
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  /** 自动开 PR 的 riskScore 阈值，默认 0.4 */
  riskThreshold?: number;
}

export type MrDraftDecision =
  | 'auto-pr' // guardrails 通过 + 低风险 -> 开 PR 标记 ready
  | 'draft-with-warnings' // guardrails 未通过 -> 开 draft PR 标记需补测试/疑似污染
  | 'diagnosis-only'; // 补丁生成失败 -> 仅诊断转人工

export interface MrDraftTrackResult {
  records: AttributionRecord[];
  topRecord: AttributionRecord | null;
  proposal: AiPatchProposal | null;
  testSufficiency: ReturnType<typeof assessTestSufficiency> | null;
  contamination: ReturnType<typeof detectContamination> | null;
  decision: MrDraftDecision;
  prResult: PrResult | null;
  reasons: string[];
}

/**
 * 运行 MR 草稿闭环。
 */
export async function runMrDraftTrack(opts: MrDraftTrackOptions): Promise<MrDraftTrackResult> {
  const reasons: string[] = [];

  // 1. 多源归因（确定性 + 变更关联）
  const records = diagnoseWithCorrelation({
    report: opts.report,
    changes: opts.changes,
    anomaly: opts.anomaly,
  });
  const topRecord = records[0] ?? null;
  if (!topRecord) {
    return { records, topRecord: null, proposal: null, testSufficiency: null, contamination: null, decision: 'diagnosis-only', prResult: null, reasons: ['no attribution produced'] };
  }
  reasons.push(`top candidate: ${topRecord.candidates[0]?.kind} (conf ${topRecord.candidates[0]?.confidence.toFixed(2)})`);

  // 2. LLM 生成源码补丁
  const proposal = await generatePatch(opts.llmConfig, { record: topRecord, files: opts.sourceFiles });
  if (!proposal) {
    return { records, topRecord, proposal: null, testSufficiency: null, contamination: null, decision: 'diagnosis-only', prResult: null, reasons: [...reasons, 'LLM produced no valid patch (searchCode validation failed)'] };
  }

  // 3. 护栏：测试充分性 + 污染检测
  const testSufficiency = assessTestSufficiency({
    proposal,
    testFiles: opts.testFiles,
    sourceFiles: opts.sourceFiles,
  });
  const contamination = detectContamination({
    patchCode: proposal.patches.map(p => p.replaceCode).join('\n'),
    goldPatches: opts.goldPatches,
  });
  reasons.push(`test sufficiency: ${testSufficiency.sufficiency.toFixed(2)} (${testSufficiency.sufficient ? 'sufficient' : 'insufficient'})`);
  reasons.push(`contamination: ${contamination.contaminated ? `DETECTED (${contamination.method}, sim=${contamination.similarity.toFixed(2)})` : 'clean'}`);

  // 4. 决策
  const riskThreshold = opts.riskThreshold ?? 0.4;
  let decision: MrDraftDecision;
  if (testSufficiency.sufficient && !contamination.contaminated && proposal.riskScore <= riskThreshold) {
    decision = 'auto-pr';
    reasons.push('guardrails passed + low risk -> auto-pr (still human-reviewed)');
  } else {
    decision = 'draft-with-warnings';
    if (!testSufficiency.sufficient) reasons.push('WARNING: tests insufficient - PR marked draft, augment tests first');
    if (contamination.contaminated) reasons.push('WARNING: contamination detected - PR marked draft, verify not gold-patch reproduction');
    if (proposal.riskScore > riskThreshold) reasons.push(`WARNING: riskScore ${proposal.riskScore} > ${riskThreshold} - PR marked draft`);
  }

  // 5. 开 PR（auto-pr 或 draft-with-warnings 都开，均人审）
  let prResult: PrResult | null = null;
  if (opts.githubConfig) {
    // 可选本地写盘（轨道 B 的本地侧）；createGithubPr 走 GitHub Contents API，无需本地 fs
    if (opts.fs) {
      await applyPatchesLocally(proposal, opts.fs.readFile, opts.fs.writeFile);
    }
    const branch = `fix/smarty-${proposal.id.slice(-8)}`;
    prResult = await createGithubPr(opts.githubConfig, proposal, branch);
  } else {
    reasons.push('GitHub/fs not configured - skipping actual PR creation');
  }

  return { records, topRecord, proposal, testSufficiency, contamination, decision, prResult, reasons };
}