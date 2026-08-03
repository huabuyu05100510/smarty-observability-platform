// error-panels.js · 错误域 UI
//   ErrorStreamPanel —— 错误总览（设计稿 oBr4r：Hero/Breakdown/Impact/Stream/Stack/Trend/Actions）
//   RootCauseView(signal) —— 错误·根因 (orZvB) 与 INP 根因 (s3boU) 同构，共用
(function (global) {
  const el = global.el || React.createElement;
  const D = () => global.__data;
  const sevTone = { p1: 'bad', p2: 'warn', p3: 'info' };

  function fmtClock(ts) { if (!ts) return '--:--:--'; const d = new Date(ts); return d.toLocaleTimeString('zh-CN', { hour12: false }); }
  function fmtClockMs(ts) { if (!ts) return '--:--:--'; const d = new Date(ts); return fmtClock(ts) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 1); }

  // ================= Hero =================
  function ErrHero({ h, topType }) {
    const surge = h.count > 0 && h.rateDelta >= 1.5;
    const title = h.count === 0 ? '错误监控 · 平静' : surge ? `异常激增 · ${topType || '未捕获错误'}` : `错误监控 · ${topType || '运行中'}`;
    const sub = h.count === 0 ? '近 1 分钟无错误 · 链路健康'
      : `近 1 分钟错误率 ${h.rate.toFixed(2)}%${h.rateDelta ? `（${surge ? '↑' : '↓'} ${h.rateDelta.toFixed(1)}× vs 1h）` : ''} · 本地口径`;
    const pillTone = h.count === 0 ? 'good' : (h.severityP1 > 0 ? 'bad' : 'warn');
    const pillLabel = h.count === 0 ? '稳定' : (h.severityP1 > 0 ? 'P1 · 活跃' : 'P2 · 观察');
    return el(Card, { stroke: h.count === 0 ? 'var(--border)' : 'var(--bad)', bg: 'var(--surface)', pad: 12, gap: 10, style: { borderRadius: 6 } },
      Row({ gap: 12, align: 'flex-start', fill: true },
        Row({ gap: 6, align: 'center', pad: 7, bg: h.count === 0 ? 'var(--good-soft)' : 'var(--bad-soft)', radius: 4, style: { flex: '0 0 auto' } },
          el(Icon, { name: h.count === 0 ? 'circle-check' : 'triangle-alert', size: 14, fill: h.count === 0 ? 'var(--good)' : 'var(--bad)' }),
          el(Txt, { content: 'ERROR STREAM', mono: true, size: 8.5, ls: 0.6, fill: h.count === 0 ? 'var(--good)' : 'var(--bad)' }),
        ),
        Col({ gap: 2, fill: true },
          el(Txt, { content: title, size: 13.5, weight: 600, fill: 'var(--fg)' }),
          el(Txt, { content: sub, size: 10, fill: 'var(--fg-2)', wrap: true, width: '100%', grow: true }),
        ),
        el(Pill, { tone: pillTone, label: pillLabel, border: true, size: 9, pad: '3px 6px' }),
      ),
      el(StatRow, { items: [
        { label: '错误率 / 1m', value: h.rate.toFixed(2), unit: '%', tone: h.rate > 0.5 ? 'bad' : 'good', meta: h.rateDelta ? `${surge ? '↑' : '↓'} ${h.rateDelta.toFixed(1)}× vs 1h` : '本地口径' },
        { label: '错误数 / 5m', value: h.count, unit: '次', meta: `${h.affectedSessions} 用户受影响` },
        { label: '未捕获 / 5m', value: h.uncaptured, unit: '条', tone: h.uncaptured > 0 ? 'warn' : 'good', meta: `${h.sourcemapPct.toFixed(0)}% 可 Source Map` },
        { label: '存活跨度 / 5m', value: h.mttr ? h.mttr.toFixed(1) : '—', unit: h.mttr ? 'min' : '', tone: 'good', meta: '指纹首→末·本地代理' },
      ] }),
    );
  }

  // ================= Breakdown =================
  function LegendGrid({ items, total }) {
    const rows = [];
    for (let i = 0; i < items.length; i += 3) rows.push(items.slice(i, i + 3));
    return rows.map((r, ri) => Row({ key: ri, gap: 8, fill: true },
      r.map((b, i) => Row({ key: i, gap: 4, align: 'center', style: { flex: 1, minWidth: 0 } },
        el(Dot, { tone: b.color, size: 7 }),
        el(Txt, { content: b.type, size: 9, fill: 'var(--fg-2)' }),
        el(Txt, { content: b.pct.toFixed(0) + '%', mono: true, size: 9, fill: 'var(--fg-3)' }),
      )),
      ri === rows.length - 1 && total != null && el(Txt, { content: 'Σ ' + total, mono: true, size: 9, fill: 'var(--fg-3)' }),
    ));
  }
  function ErrBreakdown({ data }) {
    if (!data.breakdown.length) return null;
    const s = data.severity;
    return el(Card, { icon: 'chart-no-axes-column', title: '错误构成 · 类型 / 严重级 / 页面', meta: `近 5m · ${data.total} 条`, gap: 9 },
      el(Stacked, { segs: data.breakdown.map((b) => ({ value: b.count, color: b.color })), height: 22 }),
      el('div', null, el(LegendGrid, { items: data.breakdown, total: data.total })),
      Row({ gap: 5, align: 'center', fill: true, style: { paddingTop: 4 } },
        el(Txt, { content: '严重级', size: 9, fill: 'var(--fg-3)' }),
        el(Pill, { tone: 'bad', label: 'P1 ' + s.p1, border: true, size: 8.5, pad: '2px 6px' }),
        el(Pill, { tone: 'warn', label: 'P2 ' + s.p2, border: true, size: 8.5, pad: '2px 6px' }),
        el(Pill, { tone: 'info', label: 'P3 ' + s.p3, border: true, size: 8.5, pad: '2px 6px' }),
        el(Sep),
        data.topRoute && el(Txt, { content: `${data.topRoute.label} ${data.topRoute.pct.toFixed(0)}%`, mono: true, size: 9, fill: 'var(--fg-3)', title: '错误占比最高的路由' }),
      ),
    );
  }

  // ================= Impact =================
  function ErrImpact({ data }) {
    if (!data.impact.length) return null;
    return el(Card, { icon: 'users-round', title: '受影响用户 · 路径 / 版本 / 设备', meta: `Top ${data.impact.length}`, gap: 9 },
      data.impact.map((it) => Row({ key: it.rank, gap: 8, align: 'center', pad: '7px 8px', bg: 'var(--surface-2)', radius: 4, fill: true },
        el(Txt, { content: '#' + it.rank, mono: true, size: 9, weight: 600, fill: 'var(--fg-3)', style: { width: 18 } }),
        el(Icon, { name: it.icon, size: 11, fill: `var(--${it.tone})` }),
        el(Txt, { content: it.label, mono: true, size: 9.5, fill: 'var(--fg-2)', grow: true }),
        el(Txt, { content: it.count, mono: true, size: 10, weight: 600, fill: `var(--${it.tone})` }),
        el(Txt, { content: it.pct.toFixed(0) + '%', mono: true, size: 9, fill: 'var(--fg-3)', style: { width: 30, textAlign: 'right' } }),
      )),
    );
  }

  // ================= Stream =================
  function ErrStream({ data, onSelect }) {
    return el(Card, { icon: 'zap', iconFill: 'var(--warn)', title: '实时错误流 · 近 5m', variant: 'title',
      head: el(Head, { icon: 'zap', iconFill: 'var(--warn)', title: '实时错误流 · 近 5m',
        meta: data.stream.length ? `${data.stream.length} 组` : 'streaming' }), gap: 7 },
      data.stream.length === 0
        ? el(Txt, { content: '暂无错误 · 链路干净', size: 11, fill: 'var(--fg-3)' })
        : data.stream.map((r) => Row({ key: r.id, gap: 6, align: 'center', pad: '5px 6px', bg: 'var(--surface-2)',
          stroke: r.sev === 'p1' ? 'var(--bad)' : undefined, radius: 4, fill: true, onClick: () => onSelect && onSelect(r.sample) },
          el('span', { style: { width: 2, height: 16, background: `var(--${sevTone[r.sev]})`, flex: '0 0 auto', borderRadius: 1 } }),
          el(Txt, { content: fmtClock(r.time), mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          el(Pill, { tone: sevTone[r.sev], label: r.sev.toUpperCase(), soft: true, size: 8, pad: '1px 4px' }),
          el(Txt, { content: r.type, mono: true, size: 9, weight: 600, fill: `var(--${r.color})`, style: { flex: '0 0 auto' } }),
          el(Txt, { content: r.msg, mono: true, size: 8.5, fill: 'var(--fg-2)', grow: true }),
          el(Txt, { content: '×' + r.count, mono: true, size: 9, weight: 600, fill: 'var(--fg-3)' }),
        )),
    );
  }

  // ================= Stack =================
  function ErrStack({ data }) {
    if (!data.stack) return null;
    const st = data.stack;
    return el(Card, { icon: 'file-code', title: '堆栈还原 · Source Map', stroke: 'var(--border-strong)', gap: 8,
      head: el(Head, { icon: 'file-code', title: '堆栈还原 · Source Map',
        meta: el(Pill, { tone: 'good', label: `已解析 ${st.resolvedPct.toFixed(0)}%`, soft: true, size: 8.5, pad: '2px 5px' }) }) },
      el('div', { style: { background: '#0D0D10', border: '1px solid var(--border)', borderRadius: 4, padding: '6px 0' } },
        st.lines.map((l, i) => Row({ key: i, gap: 8, align: 'center', pad: '3px 8px', bg: l.origin ? 'var(--bad-soft)' : undefined, fill: true },
          el(Txt, { content: l.tag, mono: true, size: 8.5, weight: l.origin ? 600 : 'normal', fill: l.origin ? 'var(--bad)' : 'var(--fg-3)', style: { width: 14 } }),
          el(Txt, { content: l.file, mono: true, size: 9, weight: l.origin ? 600 : 'normal', fill: l.origin ? 'var(--fg)' : 'var(--fg-2)', style: { flex: '0 0 auto' } }),
          el(Txt, { content: l.meta, mono: true, size: 8.5, fill: l.unmapped ? 'var(--fg-3)' : (l.origin ? 'var(--bad)' : 'var(--fg-3)'), grow: true }),
        )),
      ),
      Row({ gap: 7, pad: 8, align: 'flex-start', bg: 'var(--bad-soft)', stroke: 'var(--bad)', radius: 4 },
        el(Icon, { name: 'alert-circle', size: 11, fill: 'var(--bad)' }),
        el(Txt, { content: st.annotation, size: 9, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.55, grow: true }),
      ),
    );
  }

  // ================= Trend =================
  function ErrTrend({ data }) {
    return el(Card, { icon: 'activity', title: '错误率趋势 · 30 分钟', meta: '阈值 0.5%', gap: 7 },
      el(Bars, { items: data.trend, height: 56 }),
      Row({ gap: 1, align: 'center', fill: true },
        el(Txt, { content: '-30m', mono: true, size: 8, fill: 'var(--fg-3)' }),
        el(Sep), el(Txt, { content: '-15m', mono: true, size: 8, fill: 'var(--fg-3)' }), el(Sep),
        el(Txt, { content: 'now', mono: true, size: 8, fill: 'var(--fg-3)' }),
      ),
    );
  }

  // ================= ErrorStreamPanel =================
  function ErrorStreamPanel({ onSelectError }) {
    const [data, setData] = (global.React && React.useState) ? React.useState(null) : [];
    const [, force] = React.useState(0);
    React.useEffect(() => {
      let alive = true;
      const load = async () => { const d = await D().loadErrorOverview(); if (alive) { setData(d); force((x) => x + 1); } };
      load(); const t = setInterval(load, 3000);
      return () => { alive = false; clearInterval(t); };
    }, []);
    if (!data) return el(Txt, { content: '加载中...', size: 11, fill: 'var(--fg-3)' });
    const h = Object.assign({ severityP1: data.severity.p1 }, data.hero);
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      el(ErrHero, { h, topType: data.breakdown[0] && data.breakdown[0].type }),
      el(ErrBreakdown, { data }),
      el(ErrImpact, { data }),
      el(ErrStream, { data, onSelect: onSelectError }),
      el(ErrStack, { data }),
      el(ErrTrend, { data }),
      el(Actions, { primary: '申请自愈', primaryIcon: 'wand-sparkles', ghost: '复制堆栈', ghostIcon: 'copy' }),
    );
  }

  // ================= RootCauseView（错误·根因 / INP 根因 共用） =================
  function RootCauseView({ signal, data, event, onHeal, onMr, onCopyStack, onFeedback, getLiveInteractions }) {
    // 置信度反馈(👍/👎):Hooks 必须在 early return 之前(Rules of Hooks)
    const [fb, setFb] = React.useState(null);
    const [aiDiag, setAiDiag] = React.useState(null);
    const [aiHeal, setAiHeal] = React.useState(null);
    const [proxyVal, setProxyVal] = React.useState(null);
    React.useEffect(() => {
      let alive = true;
      const id = data && data.eventId;
      if (id && globalThis.__data && globalThis.__data.getFeedback) {
        globalThis.__data.getFeedback(id).then((f) => { if (alive) setFb(f && f.feedback); }).catch(() => {});
      } else setFb(null);
      return () => { alive = false; };
    }, [data && data.eventId]);
    const doFb = (which) => {
      if (!data || !data.eventId || !onFeedback) return;
      const kind = (data.hypotheses && data.hypotheses[0] && data.hypotheses[0].label)
        || (data.verdict && data.verdict.tags && data.verdict.tags[0] && data.verdict.tags[0].label) || 'unknown';
      onFeedback(data.eventId, signal, kind, which); setFb(which);
    };
    // B1 AI 深诊:LLM 真根因(Navigator→Diagnoser→Verifier 对抗),替代规则启发式
    const runAiDiag = async () => {
      const R = globalThis.__aiRca;
      if (!R) { setAiDiag({ error: 'ai-rca.js 未加载' }); return; }
      setAiDiag({ running: true });
      // 源码可用性 gate:无 sourcemap 还原(resolvedScript/resolvedFrames)→ AI 诊断 ungrounded(LLM 看不到源码)。仍允许跑,但标注结论仅参考。
      const hasSource = !!(event && (event.resolvedScript || (event.resolvedFrames && event.resolvedFrames.length)));
      const candidates = [{ kind: (data.verdict && data.verdict.title) || signal, confidence: (data.verdict && (data.verdict.fusedConfidence != null ? data.verdict.fusedConfidence : data.verdict.confidence)) || 0.5, evidence: (data.evidenceSteps || []).map((s) => s.text) }];
      const r = await R.diagnose({ signal, event, candidates, predictor: globalThis.__vcPredictor === true });
      if (r && r.rootCause) {
        if (!hasSource) {
          r.evidence = (r.evidence || []).slice();
          r.evidence.unshift('⚠ 无源码(sourcemap 未还原:dev 未带 sourceMappingURL / 跨域 CORS)→ AI 诊断 ungrounded,结论仅参考');
        }
        setAiDiag(r);
        // ③b②:持久化 AI 深诊结果 → 切 tab/重渲染后根因视图仍可回显,且 grounding 写回 analyzeRootCause。
        if (event && event.eventId && globalThis.__data && globalThis.__data.recordAiRca) {
          try { await globalThis.__data.recordAiRca(event.eventId, r); } catch {}
        }
      } else {
        setAiDiag({ error: (r && r.error) || 'AI 诊断无结果' });
      }
    };
    // C1 AI 真自愈:基于 AI 根因,LLM 生成针对性 search/replace 补丁(替代模板白名单)→ 语法校验 → Verifier 对抗
    const runAiHeal = async () => {
      const HEAL = globalThis.__aiHeal;
      if (!HEAL || !aiDiag || !aiDiag.rootCause) { setAiHeal({ error: '需先点上方「AI 深诊」拿到根因' }); return; }
      setAiHeal({ running: true });
      const codeSlices = (globalThis.__aiRca && globalThis.__aiRca.buildCodeContext(event)) || [];
      const g = await HEAL.generate({ rootCause: aiDiag.rootCause, codeSlices });
      if (g.error) { setAiHeal(g); return; }
      const v = await HEAL.verify({ rootCause: aiDiag.rootCause, diff: g.diff, codeSlices });
      // 把 AI 源码补丁映射到「最接近的运行时代理」,供下方「验证补丁方向」用(机械类可近似验证,语义类不可)
      const proxy = HEAL.deriveProxyTemplate ? HEAL.deriveProxyTemplate(g.diff, aiDiag.rootCause) : null;
      setAiHeal(Object.assign({}, g, { verification: v, proxy }));
      setProxyVal(null); // 新补丁 → 清上一次方向验证结果
      // 推 findings 到本地 vc-mcp(Claude Code 桥)。仅 sourceMatched && Verifier accepted && 用户开启 sidecar。
      // fire-and-forget,失败静默(绝不影响面板/自愈主流程)。
      if (g.sourceMatched && v.accepted && globalThis.__vcSidecar && globalThis.__vcSidecarSettings && globalThis.__vcSidecarSettings.sidecarEnabled) {
        try { globalThis.__vcSidecar.pushFindings(globalThis.__vcSidecar.buildFindings({ aiHeal: g, verification: v, aiDiag, codeSlices, event, signal })); } catch {}
      }
    };
    // D2 代理方向验证:apply 最接近的机械代理 → 采集真实 INP → Welch t → rollback,验证「修这个根因能否改善指标」的方向。
    // 仅 INP 域有可轮询的真实交互流;语义类代理/非 INP → 诚实不测(不伪造无法实现的验证)。
    const runProxyVal = async () => {
      const HL = globalThis.__healLoop;
      const proxy = aiHeal && aiHeal.proxy;
      if (!HL || !HL.runLiveProxyValidation || !proxy || !proxy.runnable) { setProxyVal({ error: '无 runnable 运行时代理' }); return; }
      const baseline = ((getLiveInteractions && getLiveInteractions()) || []).map((i) => i.value).filter((v) => v > 0).slice(-8);
      setProxyVal({ running: true });
      const r = await HL.runLiveProxyValidation({ proxyTemplateId: proxy.templateId, baselineValues: baseline, getLiveInteractions, need: 6, treatedCap: 8 });
      setProxyVal(r);
    };
    // 代理方向验证子卡(aiHeal 生成 diff 后显示)。非 INP / 语义类 → 仅诚实提示,不渲染验证按钮。
    const proxyChild = !(aiHeal && aiHeal.diff) ? null : el(Card, { icon: 'shield-check', iconFill: 'var(--accent)', title: '补丁方向验证 · 运行时代理', meta: signal === 'inp' ? '可选' : '仅 INP 域', gap: 7 },
      el(Txt, { content: signal === 'inp'
        ? 'AI 补丁是源码级(扩展无构建环境,无法灌进线上 bundle)。点「验证方向」用最接近的运行时代理 apply → 采集真实 INP → Welch t → rollback,验证「修这个根因能否改善指标」的方向(advisory,非 diff 精确效果)。'
        : '运行时代理验证依赖可轮询的真实交互流,仅 INP 域支持。此信号请应用 diff 后在真实环境复测。', size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
      signal === 'inp'
        ? ((aiHeal.proxy && aiHeal.proxy.runnable)
            ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
                el(Txt, { content: '· 近似代理 ' + aiHeal.proxy.templateId + ' — ' + aiHeal.proxy.note, size: 9, fill: 'var(--fg-2)', wrap: true, width: '100%' }),
                el(Btn, { label: (proxyVal && proxyVal.running) ? '验证中…(请在页面操作)' : '验证补丁方向', icon: 'shield-check', onClick: runProxyVal, disabled: !!(proxyVal && proxyVal.running), fill: true, size: 10 }),
                proxyVal && proxyVal.error && el(Txt, { content: '✗ ' + proxyVal.error, size: 9.5, fill: 'var(--bad)', wrap: true, width: '100%' }),
                proxyVal && proxyVal.runnable === false && proxyVal.reason && el(Txt, { content: '· ' + proxyVal.reason, size: 9, fill: 'var(--warn)', wrap: true, width: '100%' }),
                proxyVal && proxyVal.verdict && el('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  Row({ gap: 6, align: 'center', pad: '5px 7px', bg: 'var(--surface-2)', radius: 4, stroke: (proxyVal.verdict.significant && proxyVal.verdict.conclusion === 'accepted') ? 'var(--good)' : 'var(--border)' },
                    el(Dot, { tone: (proxyVal.verdict.significant && proxyVal.verdict.conclusion === 'accepted') ? 'good' : 'fg-3', size: 6 }),
                    el(Txt, { content: proxyVal.verdict.conclusion === 'accepted' ? '方向成立(代理显著改善)' : proxyVal.verdict.conclusion === 'rejected' ? '方向相反(代理显著变差)' : '方向不定(未显著)', size: 9, weight: 600, fill: 'var(--fg)' }),
                    el(Sep),
                    el(Txt, { content: 'p=' + proxyVal.verdict.pValue.toFixed(3) + ' · Δ=' + Math.round(proxyVal.verdict.effectSize) + 'ms · n=' + proxyVal.treated.length, mono: true, size: 8.5, fill: 'var(--fg-3)' }),
                  ),
                  el(Txt, { content: proxyVal.caveat, size: 8.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.4 }),
                ),
              )
            : el(Txt, { content: aiHeal.proxy ? '· ' + aiHeal.proxy.note : '· 未识别到可近似的运行时代理模板 → 此 diff 为源码级,请应用后复测', size: 9, fill: aiHeal.proxy ? 'var(--warn)' : 'var(--fg-3)', wrap: true, width: '100%' }))
        : null,
    );
    if (!data) return el(Txt, { content: '等待事件 · 触发一次慢交互或错误即可分析', size: 11, fill: 'var(--fg-3)' });
    const isErr = signal === 'error';
    const v = data.verdict;
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      // Event Bar
      Row({ gap: 7, align: 'center', pad: '7px 9px', bg: 'var(--surface-2)', stroke: 'var(--border)', radius: 4, fill: true },
        el(Icon, { name: isErr ? 'file-search' : 'mouse-pointer-click', size: 12, fill: 'var(--accent)' }),
        el(Txt, { content: data.eventId || '(realtime)', mono: true, size: 10, weight: 600, fill: 'var(--fg)' }),
        el(Txt, { content: `${data.sub} · ${fmtClock(data.time)}${data.count > 1 ? ' · ×' + data.count : ''}`, mono: true, size: 9, fill: 'var(--fg-3)' }),
        el(Sep),
        el(Pill, { tone: 'accent', label: '归因完成', soft: true, size: 9, pad: '2px 5px' }),
      ),
      // Verdict(置信度 = 规则 × 自愈验证融合;verified/falsified/weak 三态)
      el(Card, { stroke: v.verificationStatus === 'verified' ? 'var(--good)' : v.verificationStatus === 'falsified' ? 'var(--bad)' : 'var(--border-strong)', gap: 9,
        head: el(Head, { icon: 'target', title: `${v.title} · confidence ${((v.fusedConfidence != null ? v.fusedConfidence : v.confidence) * 100).toFixed(0)}%`,
          meta: el(ConfBar, { v: (v.fusedConfidence != null ? v.fusedConfidence : v.confidence), width: 80 }) }) },
        Row({ gap: 6 },
          v.verificationStatus === 'verified' && el(Pill, { tone: 'good', label: '✓ 已自愈验证(根因确证)', soft: true, size: 8.5 }),
          v.verificationStatus === 'falsified' && el(Pill, { tone: 'bad', label: '✗ 自愈证伪(根因可能错)', soft: true, size: 8.5 }),
          v.verificationStatus === 'weak' && el(Pill, { tone: 'warn', label: '⚠ 自愈未显著(根因待证)', soft: true, size: 8.5 })
        ),
        el(Txt, { content: v.body, size: 10.5, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.6, grow: true }),
        v.tags && v.tags.length && el(Tags, { items: v.tags.map((t) => ({ label: t.label, tone: t.tone })) }),
        v.verificationStatus === 'falsified' && el(Txt, { content: '此根因未被自愈实验支持(显著变差或无效)→ 可能诊断不准。建议查看下方「假设评估」的其他候选,或换 patch 重测(可证伪性闭环)。', size: 9.5, fill: 'var(--bad)', wrap: true, width: '100%', lh: 1.5 }),
      ),
      // B1 AI 深诊(LLM 真根因,Navigator→Diagnoser→Verifier 对抗)
      el(Card, { icon: 'brain', iconFill: 'var(--accent)', title: 'AI 深诊 · LLM 真根因', meta: aiDiag && aiDiag.rootCause ? '已完成' : '可选', gap: 7 },
        el(Txt, { content: '规则根因是启发式。点「AI 深诊」用 LLM 多 agent(Navigator 选候选 → Diagnoser 深挖到源码 → Verifier 对抗否决)生成具体到源码的真根因。需先在设置配置 LLM。', size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        el(Btn, { label: (aiDiag && aiDiag.running) ? '深诊中…(3 次 LLM 调用)' : 'AI 深诊', icon: 'brain', onClick: runAiDiag, disabled: !!(aiDiag && aiDiag.running), fill: true, size: 10 }),
        aiDiag && aiDiag.error && el(Txt, { content: '✗ ' + aiDiag.error, size: 9.5, fill: 'var(--bad)', wrap: true, width: '100%' }),
        aiDiag && aiDiag.rootCause && el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          Row({ gap: 7, align: 'center', pad: '5px 7px', bg: 'var(--surface-2)', radius: 4, stroke: (aiDiag.verification && aiDiag.verification.refuted) ? 'var(--bad)' : 'var(--good)' },
            el(Dot, { tone: (aiDiag.verification && aiDiag.verification.refuted) ? 'bad' : 'good', size: 6 }),
            el(Txt, { content: '置信 ' + (aiDiag.confidence * 100).toFixed(0) + '%', mono: true, size: 9, weight: 600, fill: 'var(--fg)' }),
            aiDiag.verification && el(Txt, { content: aiDiag.verification.refuted ? '· Verifier 已否决⚠' : '· Verifier 未否决', size: 9, fill: aiDiag.verification.refuted ? 'var(--bad)' : 'var(--good)' }),
            el(Sep),
            el(Txt, { content: 'det ' + (aiDiag.detConf || 0).toFixed(2) + ' · llm ' + (aiDiag.llmConf || 0).toFixed(2) + ' · 残差 ' + (aiDiag.residual || 0).toFixed(2), mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          ),
          el(Txt, { content: aiDiag.rootCause, size: 10, fill: 'var(--fg)', wrap: true, width: '100%', lh: 1.5, grow: true }),
          (aiDiag.evidence || []).slice(0, 5).map((e, i) => el(Txt, { key: i, content: '· ' + e, size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%' })),
          aiDiag.alternativeRootCause && el(Txt, { content: '备选根因: ' + aiDiag.alternativeRootCause, size: 9, fill: 'var(--warn)', wrap: true, width: '100%' }),
        ),
      ),
      // C1 AI 真自愈(基于 AI 根因生成针对性补丁,替代模板白名单)
      aiDiag && aiDiag.rootCause && el(Card, { icon: 'wand-sparkles', iconFill: 'var(--accent)', title: 'AI 真自愈 · LLM 生成补丁', meta: aiHeal && aiHeal.diff ? '已生成' : '可选', gap: 7 },
        el(Txt, { content: '基于 AI 根因,LLM 生成针对性 search/replace 补丁(替代模板白名单)→ new Function 语法校验 → Verifier 对抗。复制 diff 后手动应用到源码。', size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        el(Btn, { label: (aiHeal && aiHeal.running) ? '生成中…(2 次 LLM)' : 'AI 生成修复补丁', icon: 'wand-sparkles', onClick: runAiHeal, disabled: !!(aiHeal && aiHeal.running), fill: true, size: 10 }),
        aiHeal && aiHeal.error && el(Txt, { content: '✗ ' + aiHeal.error, size: 9.5, fill: 'var(--bad)', wrap: true, width: '100%' }),
        aiHeal && aiHeal.diff && el('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          Row({ gap: 6, align: 'center' },
            el(Dot, { tone: aiHeal.sourceMatched === false ? 'bad' : (aiHeal.syntaxOk === false ? 'warn' : 'good'), size: 6 }),
            el(Txt, { content: aiHeal.sourceMatched === false ? '✗ patch 未命中源码片段' : (aiHeal.syntaxOk === false ? '⚠ patched 语法不合法' : '✓ 命中源码 + 语法合法'), size: 9, fill: aiHeal.sourceMatched === false ? 'var(--bad)' : (aiHeal.syntaxOk === false ? 'var(--warn)' : 'var(--good)'), grow: true }),
            aiHeal.verification && el(Txt, { content: 'Verifier ' + (aiHeal.verification.accepted ? '通过 ' + (aiHeal.verification.confidence * 100).toFixed(0) + '%' : '否决'), size: 9, fill: aiHeal.verification.accepted ? 'var(--good)' : 'var(--bad)' }),
          ),
          aiHeal.diff.explanation && el(Txt, { content: '修复说明:' + aiHeal.diff.explanation + (aiHeal.diff.risk ? ' · 风险 ' + aiHeal.diff.risk : ''), size: 9, fill: 'var(--fg-2)', wrap: true, width: '100%' }),
          el(Txt, { content: 'search:', mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          el('pre', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, padding: 5, fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', margin: 0, whiteSpace: 'pre-wrap', maxHeight: 70, overflow: 'auto' } }, aiHeal.diff.search),
          el(Txt, { content: 'replace:', mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          el('pre', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 3, padding: 5, fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', margin: 0, whiteSpace: 'pre-wrap', maxHeight: 70, overflow: 'auto' } }, aiHeal.diff.replace),
          aiHeal.verification && aiHeal.verification.reason && el(Txt, { content: 'Verifier: ' + aiHeal.verification.reason, size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%' }),
          el(Actions, { primary: '复制补丁 diff', primaryIcon: 'copy', onPrimary: () => { try { navigator.clipboard && navigator.clipboard.writeText('--- search\n' + aiHeal.diff.search + '\n+++ replace\n' + aiHeal.diff.replace); } catch {} } }),
        ),
      ),
      proxyChild,
      // Evidence Chain
      el(Card, { icon: 'link', title: `证据链 · ${data.evidenceSteps.length} 步`, gap: 6 },
        data.evidenceSteps.map((s, i) => Row({ key: i, gap: 8, align: 'center', pad: '6px 8px', bg: 'var(--surface-2)', radius: 4, fill: true,
          stroke: s.good ? 'var(--good)' : undefined },
          el(Dot, { tone: s.good ? 'good' : 'accent', size: 6 }),
          el(Txt, { content: s.text, size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%', grow: true }),
        )),
      ),
      // Code Frame / 定位锚点(文件名即说明:真实源码 / 未还原 / LCP·FCP·CLS 锚点)
      data.code && el(Card, { icon: 'target', title: data.code.file, gap: 8 },
        el(CodeBlock, { lines: data.code.lines, annotation: data.code.annotation }),
      ),
      // Hypotheses
      data.hypotheses.length > 0 && el(Card, { icon: 'brain', title: `假设评估 · ${data.hypotheses.length} 候选`, gap: 7 },
        data.hypotheses.map((hp, i) => Row({ key: i, gap: 8, align: 'center', pad: '6px 7px', bg: 'var(--surface-2)', radius: 4, fill: true,
          stroke: i === 0 && hp.prob >= 0.5 ? 'var(--good)' : 'var(--border)' },
          el(Dot, { tone: i === 0 && hp.prob >= 0.5 ? 'good' : 'fg-3', size: 6 }),
          el(Txt, { content: hp.label, size: 9.5, weight: 500, fill: 'var(--fg-2)', grow: true }),
          el(Txt, { content: hp.prob.toFixed(2), mono: true, size: 9.5, weight: 600, fill: i === 0 && hp.prob >= 0.5 ? 'var(--good)' : 'var(--fg-3)' }),
        )),
      ),
      // 跨信号因果链(P3:此根因可能与其他信号联动 —— 堆涨→GC→INP / 资源 404→LCP 等)
      data.crossSignalChain && data.crossSignalChain.chains && data.crossSignalChain.chains.length > 0 && el(Card, { icon: 'link', iconFill: 'var(--accent)', title: '跨信号因果链 · CROSS-SIGNAL', meta: data.crossSignalChain.chains.length + ' 关联', gap: 7 },
        el(Txt, { content: '同时间窗(5s)多信号异常 × 因果假设 → 关联(advisory,非真因果)。此根因可能与其他信号联动,需一并排查。', size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.4, grow: true }),
        data.crossSignalChain.chains.slice(0, 4).map((c, i) => Col({ key: i, gap: 4, pad: '6px 7px', bg: 'var(--surface-2)', radius: 4, fill: true },
          Row({ gap: 5, align: 'center', style: { flexWrap: 'wrap' } },
            c.trace.flatMap((n, k) => [
              el(Pill, { tone: n.signal === signal ? 'accent' : 'fg-3', label: n.label, soft: true, size: 8.5 }),
              k < c.trace.length - 1 ? el(Txt, { content: '→', size: 11, weight: 600, fill: 'var(--accent)' }) : null,
            ]).filter(Boolean)
          ),
          el(Txt, { content: c.label, size: 9, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.4 }),
          el(Txt, { content: '置信 ' + (c.confidence * 100).toFixed(0) + '%', mono: true, size: 8.5, fill: 'var(--fg-3)' }),
        )),
      ),
      // Impact
      el(Card, { icon: 'users-round', title: '影响范围 · 与同源事件合并', gap: 8,
        head: el(Head, { icon: 'users-round', title: '影响范围 · 与同源事件合并' }) },
        Row({ gap: 1, fill: true, style: { background: 'var(--border)', borderRadius: 4, overflow: 'hidden' } },
          [{ l: '受影响用户', val: data.impact.users, m: '本地 session' },
           { l: '同源事件', val: data.impact.events, m: '指纹合并' },
           { l: '已知复发', val: data.impact.recurrence, m: '窗口' }].map((x, i) =>
            el(Stat, { key: i, label: x.l, value: x.val, size: 14, pad: 8, bg: 'var(--surface)', meta: x.m })),
        ),
      ),
      // Actions
      el(Actions, { primary: isErr ? '生成自愈方案' : '开始自愈', primaryIcon: 'wand-sparkles', onPrimary: onHeal,
        ghost: isErr ? '建 MR' : '复制 diff', ghostIcon: isErr ? 'git-pull-request-arrow' : 'copy', onGhost: isErr ? onMr : onCopyStack }),
      // 置信度反馈(攒数据供离线校准规则 confidence):👍/👎 写 attributions store
      onFeedback && Row({ gap: 7, align: 'center', fill: true },
        el(Txt, { content: '这个归因准吗?', size: 9.5, fill: 'var(--fg-3)' }),
        el(Sep),
        el(Btn, { variant: 'ghost', icon: 'circle-check', label: fb === 'up' ? '✓ 已记「有用」' : '👍 有用', onClick: () => doFb('up'), size: 10 }),
        el(Btn, { variant: 'ghost', icon: 'triangle-alert', label: fb === 'down' ? '✗ 已记「不准」' : '👎 不准', onClick: () => doFb('down'), size: 10 }),
      ),
    );
  }

  global.ErrorStreamPanel = ErrorStreamPanel;
  global.RootCauseView = RootCauseView;
})(typeof globalThis !== 'undefined' ? globalThis : self);
