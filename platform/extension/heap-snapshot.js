// heap-snapshot.js · V8 heap snapshot 解析 + diff(纯函数,零依赖)
// ----------------------------------------------------------------------------
// V8 profiler 格式(JSON):
//   { snapshot:{ meta:{ node_fields, node_types, edge_fields, edge_types }, node_count, edge_count },
//     nodes:[扁平整数], edges:[扁平整数], strings:[...] }
// nodes 扁平:每 node_fields.length 个整数一个 node;type/name 字段是 strings 数组的索引
//   (meta.node_types[0] 是 type 枚举名数组,如 ['hidden','array','string','object','code','closure',...])。
// self_size 是 node 自身大小;精确 retained size 需 dominator 树(此处用 self_size 聚合,定位类型足够)。
//
// 用途:两次快照(基线 → 操作 → GC → 二次)按 (type,name) 聚合 diff,净增长(分配未释放)= 泄漏嫌疑。
// 对应 DevTools Memory "Comparison" 视图的核心。供扩展 chrome.debugger + CDP HeapProfiler 链路用。
(function (global) {
  // 解析 V8 snapshot JSON(字符串或对象)→ 提取扁平 nodes/edges/strings + meta 字段索引。
  function parse(input) {
    const snap = typeof input === 'string' ? JSON.parse(input) : input;
    const meta = (snap && snap.snapshot && snap.snapshot.meta) || {};
    const nf = meta.node_fields || [];
    return {
      meta,
      nodes: snap.nodes || [],
      edges: snap.edges || [],
      strings: snap.strings || [],
      nodeCount: (snap.snapshot && snap.snapshot.node_count) || 0,
      nf, nfLen: nf.length,
      typeFieldIdx: nf.indexOf('type'),
      nameFieldIdx: nf.indexOf('name'),
      selfSizeFieldIdx: nf.indexOf('self_size'),
      nodeTypeEnums: (meta.node_types && meta.node_types[0]) || [],
    };
  }

  // 按 (type枚举名 :: name字符串) 聚合 count + self_size 总和。返回 Map<key, {type,name,count,selfSize}>。
  function aggregateByType(s) {
    const step = s.nfLen;
    const agg = new Map();
    if (!step || s.typeFieldIdx < 0) return agg;
    for (let i = 0; i + step <= s.nodes.length; i += step) {
      const typeIdx = s.nodes[i + s.typeFieldIdx];
      const typeEnum = s.nodeTypeEnums[typeIdx] || ('type' + typeIdx);
      const name = s.strings[s.nodes[i + s.nameFieldIdx]] || '';
      const selfSize = s.nodes[i + s.selfSizeFieldIdx] || 0;
      const key = typeEnum + '::' + name;
      const e = agg.get(key);
      if (e) { e.count++; e.selfSize += selfSize; }
      else agg.set(key, { type: typeEnum, name, count: 1, selfSize });
    }
    return agg;
  }

  // b - a 聚合差:只返回 selfSizeDelta > 0(净增长 = 泄漏嫌疑),按 selfSizeDelta 降序。
  function diffByType(aAgg, bAgg) {
    const out = [];
    for (const [, b] of bAgg) {
      const a = aAgg.get(b.type + '::' + b.name);
      const countDelta = b.count - (a ? a.count : 0);
      const selfSizeDelta = b.selfSize - (a ? a.selfSize : 0);
      if (selfSizeDelta > 0) out.push({ type: b.type, name: b.name, countDelta, selfSizeDelta });
    }
    return out.sort((x, y) => y.selfSizeDelta - x.selfSizeDelta);
  }

  // top N 泄漏(供 UI)。附加累计占比,便于判断主犯。
  function topLeaks(aAgg, bAgg, n) {
    const d = diffByType(aAgg, bAgg);
    const total = d.reduce((s, x) => s + x.selfSizeDelta, 0) || 1;
    return d.slice(0, n || 10).map((x) => Object.assign(x, { pct: x.selfSizeDelta / total }));
  }

  global.__heapSnapshot = { parse, aggregateByType, diffByType, topLeaks };
})(typeof globalThis !== 'undefined' ? globalThis : self);
