// correlation.js · 跨信号因果链(P3:打破 6 信号域孤立)
// ----------------------------------------------------------------------------
// 监控数据不孤立:一个根因常跨多信号。本模块把所有信号事件做时间窗 join + 已知因果假设,
// 构建跨信号因果图 → trace 串联(如 堆涨 → GC 停顿 → INP 慢;资源 404 → LCP 慢)。
// 对齐 observability-platform 的 joinTraceSpans 思路,搬到扩展端(纯前端、零依赖、确定性规则)。
//
// 三步:① detectAnomalies(events) → 超阈值的信号异常点;
//      ② buildEdges(anomalies) → 时间窗(5s)join × 因果规则 → 因果边;
//      ③ buildChains(events, {focusSignal}) → 聚焦信号参与的因果链(trace)。
// 诚实边界:基于时间邻近 + 规则假设的「关联」,非真因果(无 do-intervention)。advisory。
(function (global) {
  const THRESH = { inp: 500, lcp: 4000, cls: 0.25, fcp: 3000, memoryRatio: 0.8 };

  // 已知因果假设(行业:web.dev/optimize-inp + 经验):from 信号 → to 信号
  const CAUSAL_RULES = [
    { from: 'memory', to: 'inp', label: 'GC 停顿嫌疑(堆持续涨→频繁 GC→主线程被占→INP 慢)', confidence: 0.6 },
    { from: 'error', to: 'lcp', label: '资源加载失败连锁(404/CORS→LCP 主资源缺失→LCP 慢)', confidence: 0.65 },
    { from: 'error', to: 'inp', label: '错误重试/降级逻辑拖慢交互处理', confidence: 0.45 },
    { from: 'cls', to: 'lcp', label: '布局抖动推迟 LCP 元素稳定绘制', confidence: 0.4 },
    { from: 'memory', to: 'cls', label: '堆压力下渲染节流→布局位移堆积', confidence: 0.35 },
  ];

  // 检测异常信号点(超阈值的 INP/LCP/CLS/堆/错误)
  function detectAnomalies(events, opts) {
    const out = [];
    for (const e of (events || [])) {
      const t = e.timestamp || e.t || 0;
      if (!t) continue;
      if (e.type === 'vital' && e.subType === 'inp' && (e.value || 0) > THRESH.inp) out.push({ signal: 'inp', time: t, value: e.value, severity: Math.min(1, e.value / 1000), label: 'INP ' + Math.round(e.value) + 'ms' });
      else if (e.type === 'vital' && e.subType === 'lcp' && (e.value || 0) > THRESH.lcp) out.push({ signal: 'lcp', time: t, value: e.value, severity: 0.7, label: 'LCP ' + (e.value / 1000).toFixed(1) + 's' });
      else if (e.type === 'vital' && e.subType === 'cls' && (e.value || 0) > THRESH.cls) out.push({ signal: 'cls', time: t, value: e.value, severity: 0.6, label: 'CLS ' + e.value.toFixed(2) });
      else if (e.type === 'vital' && e.subType === 'fcp' && (e.value || 0) > THRESH.fcp) out.push({ signal: 'fcp', time: t, value: e.value, severity: 0.6, label: 'FCP ' + (e.value / 1000).toFixed(1) + 's' });
      else if (e.type === 'vital' && e.subType === 'memory' && e.limit && (e.value / e.limit) > THRESH.memoryRatio) out.push({ signal: 'memory', time: t, value: e.value, severity: 0.8, label: '堆 ' + Math.round(e.value / 1048576) + 'MB(占' + Math.round(e.value / e.limit * 100) + '%)' });
      else if (e.type === 'error') out.push({ signal: 'error', time: t, value: 1, severity: e.subType === 'resource' ? 0.6 : 0.8, label: (e.subType || 'err') + ': ' + (e.message || '').slice(0, 32) });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  // 时间窗(默认 5s)join × 因果规则 → 因果边。同 from→to 对取最高 confidence(去重)。
  function buildEdges(anomalies, opts) {
    const win = (opts && opts.windowMs) || 5000;
    const best = new Map();
    for (let i = 0; i < anomalies.length; i++) {
      for (let j = 0; j < anomalies.length; j++) {
        if (i === j) continue;
        const a = anomalies[i], b = anomalies[j];
        if (a.signal === b.signal) continue;
        if (Math.abs(a.time - b.time) > win) continue;
        const rule = CAUSAL_RULES.find((r) => r.from === a.signal && r.to === b.signal);
        if (!rule) continue;
        const k = a.signal + '→' + b.signal;
        const e = { from: a, to: b, label: rule.label, confidence: rule.confidence, dt: b.time - a.time };
        if (!best.has(k) || best.get(k).confidence < e.confidence) best.set(k, e);
      }
    }
    return [...best.values()].sort((x, y) => y.confidence - x.confidence);
  }

  // 构因果链:聚焦信号参与的边 → trace 串联(A→B)。返回 {anomalies, edges, chains[]}。
  function buildChains(events, opts) {
    const anomalies = detectAnomalies(events, opts);
    const edges = buildEdges(anomalies, opts);
    const focus = opts && opts.focusSignal;
    const chains = [];
    if (focus) {
      const related = edges.filter((e) => e.from.signal === focus || e.to.signal === focus);
      for (const e of related) {
        // trace 方向:把 focus 放链头(若是 to,则反过来展示因果上游)
        const trace = e.to.signal === focus ? [e.from, e.to] : [e.from, e.to];
        chains.push({ trace, label: e.label, confidence: e.confidence });
      }
    } else {
      for (const e of edges.slice(0, 5)) chains.push({ trace: [e.from, e.to], label: e.label, confidence: e.confidence });
    }
    return { anomalies, edges, chains };
  }

  global.__correlate = { detectAnomalies, buildEdges, buildChains, CAUSAL_RULES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
