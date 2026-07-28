/**
 * @monit/coordinator - 本地协调总线 + LLM 补丁 + GitHub PR
 *
 * 轨道 A（运行时热修，可逆，治标）+ 轨道 B（MR 草稿，永久，治本），
 * 均人工 review 兜底（调研：企业全自动 MR <18%，半自动 + 人审是现实范式）。
 */

export { EventBus } from './event-bus';
export { generatePatch, type PatchContext } from './llm-patch';
export { createGithubPr, applyPatchesLocally, type GithubConfig } from './github-pr';
export { createCoordinatorServer, type CoordinatorOptions, type CoordinatorHandle } from './server';