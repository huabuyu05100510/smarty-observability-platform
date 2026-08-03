// diagnose.js · 纯前端确定性根因分析（规则引擎，无 LLM，无后端）
// 输入: INP event (含三段 + loafScripts + host)
// 输出: AttributionCandidate[] 按 confidence 降序
// 思路沿用 smarty-observability-platform/packages/diagnose 的 dominantInpPhase + analyzeRootCauses
// 但搬到前端简化、纯 deterministic、零网络依赖。
(function (global) {
  const RULES = [
    {
      kind: 'inp.input_delay.long_task',
      threshold: 100,
      // inputDelay > threshold 且有 LoAF 帧跨窗
      match: (ev) => ev.inputDelay > 100 && ev.loafScripts && ev.loafScripts.length > 0,
      confidence: (ev) => Math.min(0.95, 0.6 + (ev.inputDelay - 100) / 500),
      evidence: (ev) => [
        `inputDelay=${ev.inputDelay.toFixed(1)}ms 超阈值 100ms`,
        `LoAF 帧跨窗 ${ev.loafScripts.length} 帧`,
      ],
      suggestedHealIds: () => ['inject_cleanup', 'throttle_third_party'],
    },
    {
      kind: 'inp.input_delay.third_party',
      threshold: 80,
      // inputDelay > threshold 且 LoAF scripts 包含跨域 sourceURL
      match: (ev) => {
        if (ev.inputDelay <= 80) return false;
        if (!ev.loafScripts || ev.loafScripts.length === 0) return false;
        const origin = ev.origin || '';
        if (!origin) return false; // 无页面 origin → 无法判定,不归因(好过用扩展自身 origin 把一方脚本误判成第三方)
        return ev.loafScripts.some(s => {
          const u = s.sourceURL || '';
          return u && !u.startsWith(origin);
        });
      },
      confidence: (ev) => Math.min(0.9, 0.5 + (ev.inputDelay - 80) / 400),
      evidence: (ev) => {
        const origin = ev.origin || '';
        const third = ev.loafScripts.filter(s => {
          const u = s.sourceURL || '';
          return u && !u.startsWith(origin);
        });
        const sample = third[0] || {};
        return [
          `inputDelay=${ev.inputDelay.toFixed(1)}ms 超阈值 80ms`,
          `LoAF 脚本 ${third.length}/${ev.loafScripts.length} 跨域(相对页面 ${origin || '未知'})`,
          sample.sourceFunctionName ? `怀疑: ${sample.sourceFunctionName}` : (sample.invoker || ''),
        ];
      },
      suggestedHealIds: () => ['throttle_third_party'],
    },
    {
      kind: 'inp.processing.heavy_handler',
      threshold: 50,
      match: (ev) => ev.processingDuration > 50,
      confidence: (ev) => { const base = Math.min(0.9, 0.5 + (ev.processingDuration - 50) / 200); const sh = scopeHeft(ev); return sh ? Math.max(0.1, Math.min(0.92, base + sh.boost)) : base; },
      evidence: (ev) => {
        const out = [`processingDuration=${ev.processingDuration.toFixed(1)}ms 超阈值 50ms`, `handler 同步逻辑偏重`];
        const sh = scopeHeft(ev); if (sh && sh.note) out.push('源码核对: ' + sh.note);
        return out;
      },
      suggestedHealIds: () => ['debounce_handler'],
    },
    {
      kind: 'inp.presentation.layout_thrash',
      threshold: 30,
      match: (ev) => ev.presentationDelay > 30,
      confidence: (ev) => { const base = Math.min(0.85, 0.5 + (ev.presentationDelay - 30) / 200); const sh = scopeHeft(ev); return (sh && sh.forcedReflow) ? Math.min(0.92, base + 0.12) : base; },
      evidence: (ev) => {
        const out = [`presentationDelay=${ev.presentationDelay.toFixed(1)}ms 超阈值 30ms`, '样式重算/布局抖动嫌疑'];
        const sh = scopeHeft(ev); if (sh && sh.forcedReflow) out.push('源码核对: 循环内 querySelector(强制同步布局)');
        return out;
      },
      suggestedHealIds: () => ['memo_wrap', 'debounce_handler'],
    },
    {
      kind: 'inp.unknown',
      threshold: 0,
      match: () => true,
      confidence: () => 0.3,
      evidence: (ev) => [`INP=${ev.value?.toFixed(0)}ms 暂未匹配已知模式`],
      suggestedHealIds: () => [],
    },
  ];

  // 源码核对(③b①:pre-AI 规则读源码,非纯阈值):读 resolvedScript.scope 的反模式 + 函数体,
  // 返回同步重活 boost / 强制布局标志 / 说明。无源码 → null(规则退回纯阈值,优雅降级)。
  function scopeHeft(ev) {
    const scope = ev && ev.resolvedScript && ev.resolvedScript.scope;
    if (!scope || !scope.body) return null;
    const ap = (scope.antiPatterns || []).map((p) => p.id || p);
    const has = (id) => ap.includes(id);
    const loopCount = (scope.body.match(/\b(for|while|do)\b/g) || []).length;
    const forcedReflow = has('loop_query_selector');
    let boost = 0, note = '';
    if (has('large_sync_loop') || has('sync_xhr') || forcedReflow) {
      boost = 0.15; note = '函数体含同步重活(' + ap.filter((id) => ['large_sync_loop', 'sync_xhr', 'loop_query_selector'].includes(id)).join('/') + ')';
    } else if (loopCount === 0 && scope.body.length < 300) {
      boost = -0.1; note = '函数体未见同步重活(可能归因错帧/测量噪声)';
    } else {
      note = '函数体结构未见明显异常';
    }
    return { boost, note, forcedReflow };
  }

  // 主入口: 跑所有规则,产出 candidate 链
  function analyzeRootCauses(ev) {
    if (!ev) return [];
    const candidates = [];
    const seen = new Set();
    for (const rule of RULES) {
      if (seen.has(rule.kind)) continue;
      try {
        if (rule.match(ev)) {
          candidates.push({
            kind: rule.kind,
            confidence: rule.confidence(ev),
            evidence: rule.evidence(ev).filter(Boolean),
            anchors: {
              scriptURL: ev.loafScripts?.[0]?.sourceURL,
              sourceFunctionName: ev.loafScripts?.[0]?.sourceFunctionName,
              invoker: ev.loafScripts?.[0]?.invoker,
              interactionTarget: ev.interactionTarget,
              loafEntryId: ev.loafScripts?.[0] ? `loaf-${ev.loafScripts[0].duration}` : undefined,
            },
            suggestedHealIds: rule.suggestedHealIds(ev),
          });
          seen.add(rule.kind);
        }
      } catch { /* 单条规则异常跳过，不阻断整条候选链（字段缺失等） */ }
    }
    return candidates.sort((a, b) => b.confidence - a.confidence);
  }

  // 段位判定: dominantInpPhase 的简化版
  function dominantInpPhase(ev) {
    if (!ev) return null;
    const { inputDelay, processingDuration, presentationDelay } = ev;
    const max = Math.max(inputDelay, processingDuration, presentationDelay);
    if (max === inputDelay) return { phase: 'inputDelay', value: inputDelay, ratio: inputDelay / (inputDelay + processingDuration + presentationDelay) };
    if (max === processingDuration) return { phase: 'processingDuration', value: processingDuration, ratio: processingDuration / (inputDelay + processingDuration + presentationDelay) };
    return { phase: 'presentationDelay', value: presentationDelay, ratio: presentationDelay / (inputDelay + processingDuration + presentationDelay) };
  }

  global.__inpDiagnose = { analyzeRootCauses, dominantInpPhase };
})(typeof globalThis !== 'undefined' ? globalThis : self);