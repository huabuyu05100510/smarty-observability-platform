/**
 * @monit/backend - 轻量 ingest + 存储 + 查询 + 内置面板
 *
 * 接收 @monit/collector 上报的 MonitorEvent，按指纹聚合 + vital p75/p99 + session。
 * 内置 HTML 面板（/），零构建可视化。
 */

export { EventStore, type ErrorGroup, type VitalAggregation, type SessionInfo } from './store';
export { SourcemapStore, parseStack, type StackFrame, type ResolvedFrame } from './sourcemap';
export { SqlitePersister } from './persist';
export { createBackendServer, type BackendOptions, type BackendHandle } from './server';