/**
 * @monit/provenance - 数据溯源 DAG（L4 差异化卖点）
 *
 * 吸收 tracesdk 的数据溯源概念：把"屏幕上这个错值 ← 哪个接口字段 ← 哪个后端 span"
 * 串成 DAG。数据流方向：API(span) -> JS(函数) -> DOM(节点)。
 *
 * 溯源 = 反向追踪：从 DOM 节点回溯到 API/span 根，定位"错值的源头"。
 * 作为 AttributionRecord.provenanceNode 接入 L4 归因，是 tracesdk 独门能力。
 */

export type ProvenanceKind = 'span' | 'api' | 'js' | 'dom';

export interface ProvenanceNode {
  id: string;
  kind: ProvenanceKind;
  label: string;
  /** 关联的 traceSpanId（kind=span/api 时） */
  traceSpanId?: string;
  /** API 字段路径（kind=api 时，如 "data.users[0].name"） */
  fieldPath?: string;
  /** DOM 选择器或文本（kind=dom 时） */
  selector?: string;
  /** JS 函数名（kind=js 时） */
  functionName?: string;
  meta?: Record<string, unknown>;
}

export interface ProvenanceEdge {
  /** 产出方（上游，如 api） */
  from: string;
  /** 消费方（下游，如 js） */
  to: string;
}

export interface TracePath {
  /** 从目标节点回溯到根的路径（根在前，目标在后） */
  nodes: ProvenanceNode[];
  edges: ProvenanceEdge[];
}

export class ProvenanceGraph {
  private nodes = new Map<string, ProvenanceNode>();
  private edges: ProvenanceEdge[] = [];
  /** 反向邻接表：to -> [from]（用于溯源） */
  private reverseAdj = new Map<string, string[]>();

  addNode(node: ProvenanceNode): this {
    this.nodes.set(node.id, node);
    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.push({ from, to });
    const list = this.reverseAdj.get(to) ?? [];
    list.push(from);
    this.reverseAdj.set(to, list);
    return this;
  }

  getNode(id: string): ProvenanceNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * 从目标节点反向溯源到根（span/api）。
   * 返回所有可达路径中的最短一条（BFS）。
   */
  traceFrom(targetId: string): TracePath | null {
    const target = this.nodes.get(targetId);
    if (!target) return null;

    // BFS 反向找最近的根节点（kind=span/api 或无上游）
    const queue: Array<{ id: string; path: string[] }> = [{ id: targetId, path: [targetId] }];
    const visited = new Set<string>([targetId]);
    let bestPath: string[] | null = null;

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      const upstreams = this.reverseAdj.get(id) ?? [];
      if (upstreams.length === 0) {
        // 根节点
        bestPath = path;
        break;
      }
      for (const up of upstreams) {
        if (visited.has(up)) continue;
        visited.add(up);
        queue.push({ id: up, path: [up, ...path] });
      }
    }

    if (!bestPath) bestPath = [targetId];

    const pathNodes = bestPath.map(id => this.nodes.get(id)!).filter(Boolean);
    const pathEdges: ProvenanceEdge[] = [];
    for (let i = 0; i < bestPath.length - 1; i++) {
      const e = this.edges.find(e => e.from === bestPath![i] && e.to === bestPath![i + 1]);
      if (e) pathEdges.push(e);
    }

    return { nodes: pathNodes, edges: pathEdges };
  }

  /** 全部节点 */
  allNodes(): ProvenanceNode[] {
    return [...this.nodes.values()];
  }

  /** 全部边 */
  allEdges(): ProvenanceEdge[] {
    return [...this.edges];
  }

  toJSON(): { nodes: ProvenanceNode[]; edges: ProvenanceEdge[] } {
    return { nodes: this.allNodes(), edges: this.allEdges() };
  }
}

/**
 * 便捷构造：API 字段 -> JS 函数 -> DOM 节点 的溯源链。
 */
export function buildFieldToDomChain(
  apiField: { fieldPath: string; traceSpanId?: string },
  jsFn: { functionName: string },
  dom: { selector: string; label: string },
): ProvenanceGraph {
  const g = new ProvenanceGraph();
  const apiId = `api-${apiField.fieldPath}`;
  const jsId = `js-${jsFn.functionName}`;
  const domId = `dom-${dom.selector}`;
  g.addNode({ id: apiId, kind: 'api', label: apiField.fieldPath, fieldPath: apiField.fieldPath, traceSpanId: apiField.traceSpanId });
  g.addNode({ id: jsId, kind: 'js', label: jsFn.functionName, functionName: jsFn.functionName });
  g.addNode({ id: domId, kind: 'dom', label: dom.label, selector: dom.selector });
  g.addEdge(apiId, jsId);
  g.addEdge(jsId, domId);
  return g;
}