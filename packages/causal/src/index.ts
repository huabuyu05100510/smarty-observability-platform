/**
 * @monit/causal · ⚠️ experimental
 * 自愈的科学验证地基:CausalGraph(因果图 schema)+ InterventionProtocol(Welch t 统计裁决)
 * + Tournament(多候选对抗锦标赛)+ PerfModel(世界模型接口)。
 *
 * 定位:把 agent 自愈从"试 patch 看一次"升级为"假设 → 干预 → 统计 → 因果"的科学闭环。
 * 确定性优先:无 LLM 依赖、纯 TS、可跨 Node/浏览器、可序列化、可审计。
 *
 * ⚠️ experimental:接口稳定中,实现为奠基/最小可用,非生产就绪。
 *   完整 do-calculus 概率推断、model-based RL、因果发现算法 是后续工作。
 */

export * from './causal-graph';
export * from './experiment';
export * from './model';
export * from './tournament';
export * from './patch-validation';
