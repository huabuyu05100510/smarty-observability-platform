/**
 * @monit/guardrails - 自愈护栏（防 SWE-bench 式假阳性）
 *
 * 研究依据：SWE-bench Verified ~24% 假阳性源于测试不足 + 数据污染；
 * OpenAI 已弃用 Verified。本包提供两个护栏，喂入信心门禁：
 * - test-sufficiency：补丁合入前评估测试是否覆盖被改代码
 * - contamination：检测补丁是否逐字/近似复现 gold patch（数据污染）
 */

export {
  assessTestSufficiency,
  extractFunctionNames,
  findChangedFunctions,
  type TestSufficiencyInput,
  type TestSufficiencyResult,
} from './test-sufficiency';

export {
  detectContamination,
  type ContaminationInput,
  type ContaminationResult,
} from './contamination';