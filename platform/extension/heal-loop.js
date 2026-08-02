// heal-loop.js · 自愈 loop 编排器(纯核心 runHealLoop + sidepanel adapter)
// 设计正本见 docs/heal-loop.md。结构决策:定位(①)在 loop 内、生 patch(②)在 verify(④)前、MR 人决定。
// 纯核心 runHealLoop(deps) 注入所有副作用 → 可独立单测/Playwright 验证控制流;adapter 把 deps 接到真实件。
// 诚实耦合:④ 测的是③运行时代理,MR 交付的是②源码 diff——机械类代理≡源码效果,语义类代理近似(已标注)。
(function (global) {
  function mean(xs) { return xs && xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }

  // ---- 候选映射:templateId → { label, semantic, fit(适配的 INP 段) } ----
  // proxy 走 heal-templates.js(templateId);sourceDiff 取自 mr-draft.js TEMPLATE_DIFFS。
  // semantic=true 的候选:运行时代理只能近似真 patch 效果,真源码 patch 需模型确认。
  const CANDIDATE_MAP = {
    debounce_handler:     { label: 'Handler 防抖',         semantic: false, fit: ['processingDuration'] },
    throttle_third_party: { label: '第三方脚本节流',       semantic: false, fit: ['inputDelay'] },
    lazy_load:            { label: '图片/iframe 懒加载',   semantic: false, fit: ['presentationDelay'] },
    memo_wrap:            { label: 'Memo 包裹',            semantic: true,  fit: ['presentationDelay'] },
    inject_cleanup:       { label: 'Effect cleanup',       semantic: true,  fit: ['processingDuration'] },
  };

  // ============ 纯核心:迭代收敛控制 ============
  // deps: {
  //   baselineValues:number[], initialContext:obj,
  //   localize(ctx) → { phase, candidateIds[] },                       // ① 每轮可重跑
  //   generateCandidate(loc, triedSet) → cand | null,                  // ② 生候选(源码diff+代理)
  //   applyProxy(cand) → Promise<{token, applyTime}>,                  // ③ apply 代理
  //   collectTreated(cand, applied) → Promise<number[]>,               // 采集 treated(代理 active 期间)
  //   rollback(token) → Promise<void>,                                 // 测完即撤
  //   verify(baseline, treated) → verdict,                             // ④ causal Welch t
  //   isExcellent(verdict, treated) → bool,                            // ⑤ 优秀?
  //   maxIters:int, onProgress(iter) → void,
  // }
  // 返回 { outcome:'excellent'|'inconclusive', winner|null, iterations[], evidence|null }
  async function runHealLoop(deps) {
    const maxIters = deps.maxIters || 5;
    const tried = new Set();
    const iterations = [];
    let loc = deps.localize(deps.initialContext || {});
    for (let i = 0; i < maxIters; i++) {
      // ② 生 patch:挑下一个未试候选;耗尽 → inconclusive
      const cand = deps.generateCandidate(loc, tried);
      if (!cand) { iterations.push({ i, phase: 'exhausted' }); break; }
      tried.add(cand.id);

      // ③ apply → 采集 treated → ④ verify → ⑤ 判定(任一步失败记 error,不中断 loop)
      const applied = await deps.applyProxy(cand);
      let treated = [], verdict = null, excellent = false, err = null;
      try {
        treated = await deps.collectTreated(cand, applied);
        verdict = deps.verify(deps.baselineValues, treated);
        excellent = deps.isExcellent(verdict, treated);
      } catch (e) { err = String((e && e.message) || e); }
      // 测完即撤:代理只供测量,MR 交付的是源码 diff(见诚实耦合)
      await deps.rollback(applied && applied.token);

      const iter = { i, phase: 'iterated', candidate: cand, treated, verdict, excellent, error: err };
      iterations.push(iter);
      if (deps.onProgress) { try { deps.onProgress(iter); } catch {} }

      if (excellent && !err) {
        return { outcome: 'excellent', winner: cand, iterations, evidence: { verdict, baselineMean: mean(deps.baselineValues), treatedMean: mean(treated) } };
      }
      // 没到优秀 → ① 重新定位(瓶颈可能已迁移;至少推进到下一个候选)
      loc = deps.localize(Object.assign({}, deps.initialContext || {}, { lastVerdict: verdict, lastCandidate: cand }));
    }
    return { outcome: 'inconclusive', winner: null, iterations, evidence: null };
  }

  // ============ adapter:把纯核心 deps 接到扩展真实件 ============
  // opts: { event, baselineValues:number[], getLiveInteractions:()=>[{time,value}],
  //         goodThresholdMs=200, need=6, collectTimeoutMs=20000, maxIters=5 }
  function buildAdapter(opts) {
    opts = opts || {};
    const good = opts.goodThresholdMs || 200;
    const need = opts.need || 6;
    const collectTimeoutMs = opts.collectTimeoutMs || 20000;
    const DIAG = () => global.__inpDiagnose;
    const CAUSAL = () => global.__causal;
    const MR = () => global.__inpMrDraft;

    return {
      baselineValues: opts.baselineValues || [],
      initialContext: { event: opts.event },
      maxIters: opts.maxIters || 5,

      // ① 定位:走域通用 __localize.inp(对齐官方三段);候选 id = family ∩ 可用模板,段位兜底
      localize(ctx) {
        const ev = (ctx && ctx.event) || opts.event || {};
        const L = global.__localize;
        const loc = (L && L.inp(ev)) || null;
        const phase = loc ? loc.dominant : ((DIAG() && DIAG().dominantInpPhase(ev) || {}).phase);
        const ids = [];
        (loc ? loc.family : []).forEach(id => { if (CANDIDATE_MAP[id] && !ids.includes(id)) ids.push(id); });
        if (!ids.length && phase) Object.entries(CANDIDATE_MAP).forEach(([id, m]) => { if (m.fit.includes(phase)) ids.push(id); });
        if (!ids.length) ids.push('debounce_handler'); // 最后兜底
        return { phase: phase || 'unknown', candidateIds: ids };
      },

      // ② 生 patch:挑未试候选 → 映射成 (proxy + sourceDiff) 对
      generateCandidate(loc, tried) {
        for (const id of (loc.candidateIds || [])) {
          if (tried.has(id)) continue;
          const m = CANDIDATE_MAP[id]; if (!m) continue;
          const diff = (MR() && MR().TEMPLATE_DIFFS && MR().TEMPLATE_DIFFS[id]) || null;
          return {
            id, label: m.label, semantic: m.semantic,
            proxy: { templateId: id, opts: {} },
            sourceDiff: diff,
            summary: m.label + (m.semantic ? '(语义类·代理近似,真 patch 需模型确认)' : '(机械类·代理≡源码效果)'),
          };
        }
        return null;
      },

      // ③ apply:background APPLY_HEAL(→ MAIN world __inpHeal.apply)
      applyProxy(cand) {
        return new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage({ type: 'APPLY_HEAL', templateId: cand.proxy.templateId, opts: cand.proxy.opts || {} }, (resp) => {
              resolve({ token: (resp && resp.token) || null, applyTime: Date.now() });
            });
          } catch { resolve({ token: null, applyTime: Date.now() }); }
        });
      },

      // 采集 treated:轮询 live interactions,取 applyTime 后 need 个真实 INP
      collectTreated(_cand, applied) {
        const applyTime = (applied && applied.applyTime) || Date.now();
        return new Promise((resolve) => {
          const t0 = Date.now();
          const poll = () => {
            const inter = (opts.getLiveInteractions && opts.getLiveInteractions()) || [];
            const treated = inter.filter(x => (x.time || 0) > applyTime && (x.value || 0) > 0).map(x => x.value).slice(0, need);
            if (treated.length >= need) return resolve(treated);
            if (Date.now() - t0 > collectTimeoutMs) return resolve(treated); // 超时给已有(< need → verify 会判 inconclusive)
            setTimeout(poll, 400);
          };
          poll();
        });
      },

      rollback(token) {
        if (!token) return Promise.resolve();
        return new Promise((resolve) => {
          try { chrome.runtime.sendMessage({ type: 'ROLLBACK_HEAL', token }, () => resolve()); } catch { resolve(); }
        });
      },

      // ④ verify:causal Welch t(direction=decrease);无 causal → 安全降级 inconclusive
      verify(baseline, treated) {
        return (CAUSAL() && CAUSAL().runCausalValidation(baseline, treated, { direction: 'decrease', alpha: 0.05 }))
          || { conclusion: 'inconclusive', significant: false, effectSize: 0, pValue: 1 };
      },

      // ⑤ 优秀:treated 进入 good 段 且 有显著下降(accepted)
      isExcellent(verdict, treated) {
        const m = mean(treated);
        return m > 0 && m <= good && !!verdict && !!verdict.significant && verdict.conclusion === 'accepted';
      },
    };
  }

  global.__healLoop = { runHealLoop, buildAdapter, CANDIDATE_MAP, mean };
})(typeof globalThis !== 'undefined' ? globalThis : self);
