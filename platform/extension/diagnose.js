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
      confidence: (ev) => Math.min(0.9, 0.5 + (ev.processingDuration - 50) / 200),
      evidence: (ev) => [
        `processingDuration=${ev.processingDuration.toFixed(1)}ms 超阈值 50ms`,
        `handler 同步逻辑偏重`,
      ],
      suggestedHealIds: () => ['debounce_handler'],
    },
    {
      kind: 'inp.presentation.layout_thrash',
      threshold: 30,
      match: (ev) => ev.presentationDelay > 30,
      confidence: (ev) => Math.min(0.85, 0.5 + (ev.presentationDelay - 30) / 200),
      evidence: (ev) => [
        `presentationDelay=${ev.presentationDelay.toFixed(1)}ms 超阈值 30ms`,
        '样式重算/布局抖动嫌疑',
      ],
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