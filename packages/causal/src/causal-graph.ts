/**
 * @monit/causal/causal-graph · ⚠️ experimental
 * 因果图 schema（可序列化）+ do-intervention（Pearl do 的图操作简化）。
 * 把"X 与 Y 相关"升级为"X 致 Y"的可表示、可审计结构。可 JSON.stringify 跨进程传输。
 *
 * 注:这是因果图的【数据结构 + 图操作】奠基,不含完整 do-calculus 概率推断(那是
 * 后续工作)。当前支持:构建图、查父子、do 干预(切入边 backdoor)。
 */

export type CausalNodeKind = 'metric' | 'factor' | 'intervention';

export interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  label: string;
  meta?: Record<string, unknown>;
}

export interface CausalEdge {
  /** cause node id */
  from: string;
  /** effect node id */
  to: string;
  /** 影响强度 -1..1(可选;正=促进,负=抑制)*/
  weight?: number;
  /** 支持该因果边的证据(实验 id / 文献 / 观测),用于可审计 */
  evidence?: string[];
}

export interface CausalGraph {
  schema: 'causal-graph';
  version: 1;
  nodes: CausalNode[];
  edges: CausalEdge[];
}

export function emptyGraph(): CausalGraph {
  return { schema: 'causal-graph', version: 1, nodes: [], edges: [] };
}

export function addNode(graph: CausalGraph, node: CausalNode): CausalGraph {
  if (graph.nodes.some((n) => n.id === node.id)) return graph;
  return { ...graph, nodes: [...graph.nodes, node] };
}

export function addEdge(graph: CausalGraph, edge: CausalEdge): CausalGraph {
  return { ...graph, edges: [...graph.edges, edge] };
}

export function parents(graph: CausalGraph, nodeId: string): CausalNode[] {
  const parentIds = new Set(graph.edges.filter((e) => e.to === nodeId).map((e) => e.from));
  return graph.nodes.filter((n) => parentIds.has(n.id));
}

export function children(graph: CausalGraph, nodeId: string): CausalNode[] {
  const childIds = new Set(graph.edges.filter((e) => e.from === nodeId).map((e) => e.to));
  return graph.nodes.filter((n) => childIds.has(n.id));
}

/**
 * do-intervention（Pearl do 算子的图操作）:
 * 设定 node 为干预值 → 切断其所有入边(backdoor)，标记为 intervention。
 * 返回 post-intervention 图，用于推断下游节点的预期分布变化。
 * 这是"主动实验"的因果基础:从观察 P(Y|X) 转向干预 P(Y|do(X))。
 */
export function doIntervention(graph: CausalGraph, nodeId: string, value?: number): CausalGraph {
  if (!graph.nodes.some((n) => n.id === nodeId)) return graph;
  const edges = graph.edges.filter((e) => e.to !== nodeId); // 切入边(backdoor)
  const nodes = graph.nodes.map((n) =>
    n.id === nodeId
      ? { ...n, kind: 'intervention' as CausalNodeKind, meta: { ...n.meta, doValue: value } }
      : n,
  );
  return { ...graph, nodes, edges };
}
