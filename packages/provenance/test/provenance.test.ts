import { describe, it, expect } from 'vitest';
import { ProvenanceGraph, buildFieldToDomChain } from '../src/index';

describe('ProvenanceGraph', () => {
  it('builds api -> js -> dom chain via helper', () => {
    const g = buildFieldToDomChain(
      { fieldPath: 'data.users[0].name', traceSpanId: 'span-123' },
      { functionName: 'renderName' },
      { selector: '#user-name', label: 'User Name' },
    );
    expect(g.allNodes().length).toBe(3);
    expect(g.allEdges().length).toBe(2);
  });

  it('traces from dom back to api root (reverse BFS)', () => {
    const g = buildFieldToDomChain(
      { fieldPath: 'data.user.email', traceSpanId: 'span-9' },
      { functionName: 'renderEmail' },
      { selector: '.email', label: 'Email' },
    );
    const domId = 'dom-.email';
    const path = g.traceFrom(domId);
    expect(path).not.toBeNull();
    expect(path!.nodes.length).toBe(3);
    // 根（api）在前，目标（dom）在后
    expect(path!.nodes[0].kind).toBe('api');
    expect(path!.nodes[0].fieldPath).toBe('data.user.email');
    expect(path!.nodes[0].traceSpanId).toBe('span-9');
    expect(path!.nodes[2].kind).toBe('dom');
  });

  it('returns single-node path when target has no upstream', () => {
    const g = new ProvenanceGraph();
    g.addNode({ id: 's1', kind: 'span', label: 'root span', traceSpanId: 's1' });
    const path = g.traceFrom('s1');
    expect(path!.nodes.length).toBe(1);
  });

  it('handles multi-hop chain (span -> api -> js -> dom)', () => {
    const g = new ProvenanceGraph();
    g.addNode({ id: 'span1', kind: 'span', label: 'GET /users', traceSpanId: 'span1' });
    g.addNode({ id: 'api1', kind: 'api', label: 'data.name', fieldPath: 'data.name' });
    g.addNode({ id: 'js1', kind: 'js', label: 'render', functionName: 'render' });
    g.addNode({ id: 'dom1', kind: 'dom', label: 'Name', selector: '#name' });
    g.addEdge('span1', 'api1');
    g.addEdge('api1', 'js1');
    g.addEdge('js1', 'dom1');
    const path = g.traceFrom('dom1');
    expect(path!.nodes.length).toBe(4);
    expect(path!.nodes[0].kind).toBe('span');
    expect(path!.nodes[3].kind).toBe('dom');
  });

  it('returns null for unknown node', () => {
    const g = new ProvenanceGraph();
    expect(g.traceFrom('nonexistent')).toBeNull();
  });

  it('toJSON serializes graph', () => {
    const g = buildFieldToDomChain(
      { fieldPath: 'data.x' },
      { functionName: 'fn' },
      { selector: '.x', label: 'X' },
    );
    const json = g.toJSON();
    expect(json.nodes.length).toBe(3);
    expect(json.edges.length).toBe(2);
  });
});