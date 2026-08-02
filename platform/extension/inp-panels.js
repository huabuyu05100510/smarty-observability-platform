// inp-panels.js · INP 域六屏：实时 / 自愈 / MR / 历史 / 设置（根因由 app 经 RootCauseView 渲染）
// 卡片结构对标设计稿 svCXD / N2Q8t / n75UD / eGkCs / eDv8L，数据来自 __data / __inpHeal / __inpMrDraft。
(function (global) {
  const el = global.el || React.createElement;
  const D = () => global.__data;
  const tone = (v) => v <= 200 ? 'good' : v <= 500 ? 'warn' : 'bad';
  function fmtClock(ts) { if (!ts) return '--:--:--'; return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }); }
  function fmtClockMs(ts) { if (!ts) return '--:--:--'; const d = new Date(ts); return fmtClock(ts) + '.' + String(d.getMilliseconds()).padStart(3, '0').slice(0, 1); }
  function fmtHost(h) { if (!h) return '(unknown)'; if (h === '127.0.0.1' || h === 'localhost' || h.startsWith('127.')) return '(localhost)'; return h; }
  function fmtTime(ts) { if (!ts) return '-'; const d = new Date(ts); const t = new Date(); t.setHours(0, 0, 0, 0); return d >= t ? d.toLocaleTimeString('zh-CN', { hour12: false }) : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); }

  // ================= 实时 =================
  function VitalRealtimePanel({ signal, data, onAnalyze }) {
    const cfg = (data && data.cfg) || (D().SIGNALS && D().SIGNALS[signal]);
    if (!data || !data.hasData || !cfg) return el(Card, { pad: 24, style: { alignItems: 'center' } },
      el(Txt, { content: { inp: '等待交互 · 在页面点点戳戳' }[signal] || `等待 ${cfg ? cfg.label : signal} 数据 · 浏览页面即可采集`, size: 11, fill: 'var(--fg-3)' }));

    const cur = data.cur;
    const r = D().rateSig(signal, cur.value);
    const num = (v) => (v * cfg.scale).toFixed(cfg.decimals);
    const segs = cfg.segs(cur);
    const total = segs.reduce((s, x) => s + (x.value || 0), 0) || 1;
    const delta = data.baseline ? (cur.value - data.baseline) : 0;
    const gaugePct = cur.value / cfg.budget;
    const trendUp = delta > 0;

    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      // Hero
      el(Card, { stroke: `var(--${r})`, pad: 12, gap: 10, style: { borderRadius: 6 } },
        Row({ gap: 12, align: 'flex-start', fill: true },
          Col({ gap: 2, fill: true },
            el(Txt, { content: cfg.heroLabel, mono: true, size: 8.5, ls: 0.6, fill: 'var(--fg-3)' }),
            Row({ gap: 4, align: 'end' },
              el(Txt, { content: num(cur.value), mono: true, size: 40, weight: 700, fill: `var(--${r})`, style: { lineHeight: 1 } }),
              cfg.unit && el(Txt, { content: cfg.unit, mono: true, size: 13, fill: 'var(--fg-2)' }),
            ),
            Row({ gap: 5, align: 'center', style: { paddingTop: 3 } },
              el(Pill, { tone: r, label: cfg.verdict(r), soft: true, size: 8.5, pad: '2px 5px' }),
              el(Icon, { name: trendUp ? 'trending-up' : 'trending-down', size: 10, fill: `var(--${trendUp ? 'bad' : 'good'})` }),
              el(Txt, { content: (trendUp ? '+' : '') + num(delta) + cfg.unit + ' vs 基线 ' + num(data.baseline) + cfg.unit, mono: true, size: 8.5, fill: `var(--${trendUp ? 'bad' : 'good'})` }),
            ),
          ),
          el(Sep),
          el(Gauge, { pct: gaugePct, tone: r, label: '预算占用', value: (gaugePct * 100).toFixed(0) + '%' }),
        ),
        el(StatRow, { items: [
          { label: 'P75', value: num(data.p75) + cfg.unit, tone: D().rateSig(signal, data.p75) },
          { label: 'P50', value: num(data.p50) + cfg.unit, tone: D().rateSig(signal, data.p50) },
          { label: '样本', value: String(data.sampleCount) },
          { label: '超阈值', value: data.overThresholdPct.toFixed(1) + '%', tone: data.overThresholdPct > 20 ? 'bad' : 'warn' },
        ] }),
      ),
      // Breakdown
      el(Card, { head: el(Head, { variant: 'label', title: cfg.bdTitle, meta: `总计 ${D().fmtSig(signal, cur.value)}` }), gap: 8 },
        el(Stacked, { segs: segs.map((s) => ({ value: s.value, color: s.color })), height: 22 }),
        segs.map((s, i) => el(Legend, { key: i, swatch: s.color, label: s.label, value: D().fmtSig(signal, s.value), pct: (s.value / total * 100).toFixed(1) + '%' })),
      ),
      // Target
      data.target && el(Card, { head: el(Head, { variant: 'label', title: cfg.tgtTitle, meta: cfg.tgtEntry }), gap: 8 },
        Row({ gap: 8, align: 'flex-start', pad: 8, bg: 'var(--surface-2)', stroke: 'var(--border-strong)', radius: 4, fill: true },
          el(Icon, { name: signal === 'inp' ? 'mouse-pointer-click' : signal === 'lcp' ? 'image' : signal === 'cls' ? 'move' : 'eye', size: 14, fill: 'var(--accent)' }),
          Col({ gap: 3, fill: true },
            el(Txt, { content: data.target.selector || '(未捕获)', mono: true, size: 9.5, fill: 'var(--fg)', wrap: true, width: '100%', grow: true }),
            el(Txt, { content: data.target.component || '', mono: true, size: 8.5, fill: 'var(--fg-3)', wrap: true, width: '100%', grow: true }),
          ),
        ),
        (data.target.kv || []).map((row, i) => el(KV, { key: i, k: row[0], v: row[1], vTone: row[2] || 'fg' })),
      ),
      // Stream
      el(Card, { head: el(Head, { variant: 'label', title: cfg.streamTitle, meta: cfg.streamMeta }), gap: 7 },
        (!data.stream || data.stream.length === 0)
          ? el(Txt, { content: '尚无样本', size: 11, fill: 'var(--fg-3)' })
          : data.stream.slice(0, 6).map((s, i) => Row({ key: i, gap: 7, align: 'center', pad: '5px 6px', bg: 'var(--surface-2)', radius: 4, fill: true },
              el('span', { style: { width: 2, height: 16, background: `var(--${D().rateSig(signal, s.value)})`, flex: '0 0 auto', borderRadius: 1 } }),
              el(Txt, { content: fmtClockMs(s.time), mono: true, size: 9, fill: 'var(--fg-3)' }),
              el(Txt, { content: s.type, mono: true, size: 9, fill: 'var(--fg-2)', style: { flex: '0 0 auto' } }),
              el(Sep),
              el(Txt, { content: s.state, size: 9, fill: 'var(--fg-3)' }),
              el(Pill, { tone: D().rateSig(signal, s.value), label: num(s.value) + cfg.unit, soft: true, size: 9, pad: '2px 5px', style: { width: 52, justifyContent: 'flex-end' } }),
            )),
      ),
      // Trigger
      cur.value > cfg.ruleThreshold && el(Card, { stroke: 'var(--accent)', gap: 9,
        head: el(Head, { icon: 'zap', iconFill: 'var(--accent)', title: cfg.rule(cur) }) },
        el(Txt, { content: cfg.desc, size: 10, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.55, grow: true }),
        el(Actions, { primary: '开始根因分析', primaryIcon: 'search-code', onPrimary: onAnalyze, ghost: '静音 30m', ghostIcon: 'bell-off' }),
      ),
    );
  }
  // 别名（向后兼容）
  const RealtimePanel = (props) => VitalRealtimePanel(Object.assign({ signal: 'inp' }, props));

  // ================= 自愈 =================
  function HealPanel({ domain, live, appliedTokens, setAppliedTokens }) {
    const [busy, setBusy] = React.useState(null);
    const [result, setResult] = React.useState(null);
    const [causal, setCausal] = React.useState(null);
    const [loop, setLoop] = React.useState(null); // { running, iter, current, result, error }
    const liveRef = React.useRef(live); liveRef.current = live; // loop 异步运行期间读最新 live(用户继续浏览产生 treated)
    const meanOf = (xs) => xs && xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
    const baseline = live?.inp?.value;
    // 领域专家 checklist(本 tab 核心:常见根因 → 解法;运行时模板/MR 草稿挂在对应条目上)
    const CL = (global.__checklist && global.__checklist.CHECKLIST) || {};
    const KIND_META = (global.__checklist && global.__checklist.KIND_META) || {};
    const items = CL[domain] || [];
    const domainLabel = ({ inp: 'INP', lcp: 'LCP', fcp: 'FCP', cls: 'CLS', error: '错误' })[domain] || '—';

    const apply = (tplId) => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) { setResult({ ok: false, reason: 'chrome.runtime 不可用' }); setTimeout(() => setResult(null), 3000); return; }
      setBusy(tplId);
      chrome.runtime.sendMessage({ type: 'APPLY_HEAL', templateId: tplId, opts: {} }, (resp) => {
        setBusy(null);
        if (chrome.runtime.lastError || !resp) setResult({ ok: false, reason: '消息失败' });
        else if (resp.ok) {
          // hint 类模板(memo/cleanup)仅 console.info，不占 patch 槽 → 不入 appliedTokens，可重复触发查看提示
          const hintLess = tplId === 'memo_wrap' || tplId === 'inject_cleanup';
          if (!hintLess) {
            setAppliedTokens((p) => [...p, { token: resp.token, templateId: tplId, appliedAt: Date.now(), summary: resp.summary }]);
            // 因果统计验证:baseline = apply 时最近交互的 INP;treated = apply 后新交互(用户继续浏览)
            const baseVals = (live?.interactions || []).map((i) => i.value).filter((v) => v > 0).slice(-8);
            if (baseVals.length >= 4 && globalThis.__causal) {
              setCausal({ phase: 'collecting', baseline: baseVals, treated: [], need: 6, applyTime: Date.now(), tplId, result: null });
            }
          }
          setResult({ ok: true, msg: '已' + (hintLess ? '提示' : '注入') + ': ' + resp.summary });
        }
        else setResult({ ok: false, reason: resp.reason });
        setTimeout(() => setResult(null), 4000);
      });
    };
    const rollback = (token) => { if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return; chrome.runtime.sendMessage({ type: 'ROLLBACK_HEAL', token }, (resp) => { if (resp?.ok) setAppliedTokens((p) => p.filter((t) => t.token !== token)); }); };
    const rollbackAll = () => appliedTokens.forEach((t) => rollback(t.token));

    // 自愈 loop:①定位→②生候选(源码diff+代理)→③apply→④Welch t 验证→⑤优秀?没到则重新定位再来,直至优秀/候选耗尽。
    // loop 结束后人决定提不提 MR(提交权属于人)。详见 docs/heal-loop.md。
    const runLoop = async () => {
      const HL = globalThis.__healLoop;
      if (!HL) { setLoop({ running: false, error: 'heal-loop.js 未加载' }); return; }
      const baseVals = (liveRef.current?.interactions || []).map((i) => i.value).filter((v) => v > 0).slice(-8);
      const event = liveRef.current?.inp ? Object.assign({}, liveRef.current.inp, { loafScripts: liveRef.current.loafScripts }) : null;
      if (baseVals.length < 4) { setLoop({ running: false, error: 'baseline 不足(需 ≥4 个交互)——先在页面产生几次交互' }); return; }
      if (!event) { setLoop({ running: false, error: '未采到 INP 事件——触发一次慢交互再运行' }); return; }
      setLoop({ running: true, iter: 0, current: null, result: null, error: null });
      const adapter = HL.buildAdapter({ event, baselineValues: baseVals, getLiveInteractions: () => (liveRef.current?.interactions || []), maxIters: 5 });
      const result = await HL.runHealLoop(Object.assign({}, adapter, {
        onProgress: (it) => setLoop((p) => (p && p.running) ? { ...p, iter: it.i + 1, current: it } : p),
      }));
      setLoop({ running: false, iter: result.iterations.length, result, baseline: baseVals });
    };

    // 因果统计验证:patch apply 后用 content.js 采集的真实 INP 裁决。treated 攒够 need → Welch t;
    // patch 默认保留(会话内有效);裁决仅作证据展示,由用户决定「保留」或「撤回」。local-first,无 Node/Playwright。
    React.useEffect(() => {
      if (!causal || causal.phase !== 'collecting') return;
      const treated = (live?.interactions || []).filter((i) => (i.time || 0) > causal.applyTime).map((i) => i.value).filter((v) => v > 0);
      if (treated.length >= causal.need) {
        const use = treated.slice(0, causal.need);
        const r = (globalThis.__causal && globalThis.__causal.runCausalValidation(causal.baseline, use, { direction: 'decrease', alpha: 0.05 })) || null;
        // 不自动回滚:展示测量证据 + 解决方案 + 建议 MR,由用户决定保留/撤回(human-in-the-loop)
        setCausal({ ...causal, treated: use, result: r, phase: 'done' });
      } else if (treated.length !== causal.treated.length) {
        setCausal({ ...causal, treated });
      }
    }, [live?.interactions]);

    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      // Banner
      el(Card, { stroke: 'var(--good)', bg: 'var(--good-soft)', pad: 10, gap: 6,
        head: el(Head, { icon: 'shield-check', iconFill: 'var(--good)', title: '自愈 · 领域专家 Checklist + 可逆 patch' }) },
        el(Txt, { content: '本领域常见根因 → 专业解法清单。带「试用」= 会话内可逆运行时 patch(刷新失效,仅 INP 域);带「MR 草稿」= 源码方案;其余为改源码/架构方向。点「撤回」即时还原。', size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.5, grow: true }),
      ),
      // Proof(仅 INP 域:依赖 INP 三段 + causal 验证)
      domain === 'inp' && el(Card, { icon: 'chart-line', title: '证明 Proof · 注入前后对比', meta: baseline ? '基线 ' + baseline.toFixed(0) + 'ms' : '未采到', gap: 8 },
        Row({ gap: 1, fill: true, style: { background: 'var(--border)', borderRadius: 4, overflow: 'hidden' } },
          el(Stat, { label: '当前 INP', value: baseline ? baseline.toFixed(0) : '—', unit: baseline ? 'ms' : '', tone: baseline ? tone(baseline) : 'fg', meta: '实时' }),
          el(Stat, { label: '已注入', value: appliedTokens.length, unit: '个', tone: 'accent', meta: '活跃模板' }),
          el(Stat, { label: '撤回方式', value: '手动', unit: '', tone: 'good', meta: '会话内有效' }),
        ),
      ),
      // 自愈 Loop(主引擎,仅 INP 域——测真实 INP treated):定位→生→apply→测→优秀?迭代收敛;loop 结束人决定 MR
      domain === 'inp' && el(Card, { icon: 'loader-circle', iconFill: 'var(--accent)', title: '自愈 Loop · 定位→生→apply→测→优秀?',
        meta: loop?.running ? '迭代 ' + loop.iter + '/5' : (loop?.result ? (loop.result.outcome === 'excellent' ? '已收敛' : '未收敛') : '待运行'), gap: 7 },
        el(Txt, { content: '①定位瓶颈 →②生成候选 patch(源码diff+运行时代理) →③apply →④Welch t 验证 →⑤优秀?没到则重新定位再来,直至优秀或候选耗尽。loop 结束后人决定提 MR。', size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        el(Btn, { label: loop?.running ? '运行中…(' + loop.iter + '/5 · 请继续浏览产生交互)' : '运行自愈 Loop', icon: 'loader-circle', onClick: runLoop, disabled: !!loop?.running, fill: true, size: 10, weight: 600 }),
        loop?.error && el(Txt, { content: '✗ ' + loop.error, size: 9.5, fill: 'var(--bad)', wrap: true, width: '100%' }),
        loop?.running && loop?.current && el(Txt, { content: '当前候选: ' + loop.current.candidate.label + ' · 采 treated ' + (loop.current.treated?.length || 0) + '/6', size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%' }),
        loop?.result && el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          (loop.result.iterations || []).filter((it) => it.phase === 'iterated').map((it, idx) =>
            Row({ key: idx, gap: 7, align: 'center', pad: '5px 7px', bg: 'var(--surface-2)', radius: 4, fill: true, stroke: it.excellent ? 'var(--good)' : undefined },
              el(Dot, { tone: it.excellent ? 'good' : 'fg-3', size: 6 }),
              el(Txt, { content: '#' + (it.i + 1) + ' ' + it.candidate.label, size: 9.5, fill: 'var(--fg-2)', grow: true }),
              el(Txt, { content: it.verdict && it.treated.length ? Math.round(meanOf(it.treated)) + 'ms · p=' + it.verdict.pValue.toFixed(2) : (it.error || '样本不足'), mono: true, size: 9, fill: it.excellent ? 'var(--good)' : 'var(--fg-3)' }),
            )),
          loop.result.outcome === 'excellent' && loop.result.winner
            ? el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 7, background: 'var(--good-soft)', border: '1px solid var(--good)', borderRadius: 4 } },
                el(Txt, { content: '✓ 收敛到优秀 · winner: ' + loop.result.winner.label + (loop.result.winner.semantic ? '(语义类·代理近似,真 patch 需模型确认)' : '(机械类·代理≡源码效果)'), size: 10, weight: 600, fill: 'var(--good)', wrap: true, width: '100%' }),
                el(Txt, { content: 'baseline ' + Math.round(loop.result.evidence.baselineMean) + 'ms → treated ' + Math.round(loop.result.evidence.treatedMean) + 'ms · effect ' + Math.round(loop.result.evidence.verdict.effectSize) + 'ms · p=' + loop.result.evidence.verdict.pValue.toFixed(3), mono: true, size: 9, fill: 'var(--fg-2)', wrap: true, width: '100%' }),
                el(Txt, { content: 'MR 由你决定(提交权属于人):', size: 9, fill: 'var(--fg-3)' }),
                loop.result.winner.sourceDiff
                  ? el('pre', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', margin: '4px 0', whiteSpace: 'pre', overflow: 'auto', maxHeight: 120 } }, (loop.result.winner.sourceDiff.diff || []).join('\n'))
                  : el(Txt, { content: '(该候选无源码 diff 模板)', size: 9, fill: 'var(--fg-3)' }),
                el(Actions, { primary: '提 MR(复制 diff)', primaryIcon: 'git-pull-request-arrow', onPrimary: () => { try { navigator.clipboard && navigator.clipboard.writeText((loop.result.winner.sourceDiff && loop.result.winner.sourceDiff.diff || []).join('\n')); } catch {} }, ghost: '不提,关闭', ghostIcon: 'x', onGhost: () => setLoop(null) }),
              )
            : el(Txt, { content: '✗ 候选耗尽,未达优秀(可能需要语义类 patch/模型,或瓶颈不在模板覆盖范围)', size: 9.5, fill: 'var(--warn)', wrap: true, width: '100%' }),
        ),
      ),
      // 专家 Checklist(本领域常见根因 → 解法;运行时模板/MR 草稿只是其中可落地的动作)
      el(Card, { icon: 'search-code', iconFill: 'var(--accent)', title: `${domainLabel} 专家 Checklist · 常见问题 → 解法`, meta: `${items.length} 条`, gap: 7 },
        el(Txt, { content: '每条 = 常见问题 → 为什么 → 专业解法。带「试用」= 会话内可逆运行时 patch;带「MR 草稿」= 有源码方案。', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        items.map((it) => {
          const km = KIND_META[it.kind] || { label: it.kind, tone: 'fg-3' };
          const applied = !!it.healId && appliedTokens.some((a) => a.templateId === it.healId);
          return Row({ key: it.id, gap: 8, align: 'flex-start', pad: 8, bg: 'var(--surface-2)', radius: 4, fill: true, stroke: applied ? 'var(--good)' : undefined },
            Col({ gap: 2, fill: true },
              Row({ gap: 6, align: 'center' },
                el(Pill, { tone: km.tone, label: km.label, size: 8 }),
                el(Txt, { content: it.title, size: 11, weight: 600, fill: 'var(--fg)', grow: true, wrap: true, width: '100%' }),
              ),
              el(Txt, { content: it.why, size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.45 }),
              el(Txt, { content: '→ ' + it.fix, size: 9.5, fill: 'var(--accent)', wrap: true, width: '100%', lh: 1.45 }),
              it.evidence && el(Txt, { content: '证据 · ' + it.evidence, mono: true, size: 8.5, fill: 'var(--info)' }),
            ),
            // 右侧动作:运行时可注入 → 试用;否则 MR 草稿 chip;纯知识条无按钮
            it.healId
              ? el(Btn, { label: busy === it.healId ? '注入中...' : applied ? '已注入' : '试用', icon: applied ? 'circle-check' : 'wand-sparkles', onClick: () => apply(it.healId), disabled: busy === it.healId || applied, fill: false, size: 10, weight: 600 })
              : it.mrId
                ? el(Pill, { tone: 'info', label: 'MR 草稿', size: 8.5 })
                : null,
          );
        }),
      ),
      // Timeline
      appliedTokens.length > 0 && el(Card, { icon: 'git-branch', title: `注入时间线 · ${appliedTokens.length} 个`, gap: 6 },
        appliedTokens.map((t) => Row({ key: t.token, gap: 8, align: 'center', pad: '6px 8px', bg: 'var(--accent-soft)', stroke: 'var(--accent)', radius: 4, fill: true },
          el(Dot, { tone: 'accent', size: 6 }),
          el(Txt, { content: t.templateId, mono: true, size: 10, weight: 600, fill: 'var(--accent)', grow: true }),
          el(Txt, { content: fmtTime(t.appliedAt), mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          el('button', { onClick: () => rollback(t.token), style: { background: 'transparent', border: 'none', color: 'var(--bad)', cursor: 'pointer', fontSize: 10, fontFamily: 'inherit' } }, '回滚'),
        )),
        el(Btn, { variant: 'ghost', label: '全部回滚', icon: 'rotate-ccw', onClick: rollbackAll, fill: true, size: 10 }),
      ),
      result && el(Card, { stroke: result.ok ? 'var(--good)' : 'var(--bad)', pad: 8,
        head: el(Head, { icon: result.ok ? 'circle-check' : 'triangle-alert', iconFill: result.ok ? 'var(--good)' : 'var(--bad)',
          title: (result.ok ? '✓ ' + result.msg : '✗ ' + (result.reason || 'failed')) }) }),
      causal && el(Card, { stroke: causal.phase === 'done' ? (causal.result && causal.result.conclusion === 'accepted' ? 'var(--good)' : 'var(--warn)') : 'var(--accent)', pad: 8, gap: 7,
        head: el(Head, { icon: causal.phase === 'done' ? 'circle-check' : 'loader-circle',
          iconFill: causal.phase === 'done' ? (causal.result && causal.result.conclusion === 'accepted' ? 'var(--good)' : 'var(--warn)') : 'var(--accent)',
          title: causal.phase === 'collecting'
            ? '因果统计验证 · 采集中 ' + causal.treated.length + '/' + causal.need + '(继续浏览产生交互)'
            : '验证完成 · effect ' + (causal.result && causal.result.effectSize.toFixed(0)) + 'ms, p=' + (causal.result && causal.result.pValue.toFixed(3)) + '(' + (causal.result && causal.result.conclusion === 'accepted' ? '显著改善' : '未达显著') + ')' }) },
        causal.phase === 'done' && el(Txt, { content: 'baseline ' + (causal.result && causal.result.baseline.mean.toFixed(0)) + 'ms → treated ' + (causal.result && causal.result.treated.mean.toFixed(0)) + 'ms · 请你决定是否保留', size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%' }),
        causal.phase === 'done' && (globalThis.__inpMrDraft && globalThis.__inpMrDraft.TEMPLATE_DIFFS && globalThis.__inpMrDraft.TEMPLATE_DIFFS[causal.tplId]) && el('div', null,
          el(Txt, { content: '建议 MR · 源码永久修复(占位,需人工确认):', size: 9, fill: 'var(--fg-3)' }),
          el('pre', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', margin: '4px 0', whiteSpace: 'pre', overflow: 'auto', maxHeight: 120 } }, (globalThis.__inpMrDraft.TEMPLATE_DIFFS[causal.tplId].diff || []).join('\n'))),
        causal.phase === 'done' && el(Actions, { primary: '保留 patch', primaryIcon: 'circle-check', onPrimary: () => setCausal(null), ghost: '撤回 patch', ghostIcon: 'rotate-ccw', onGhost: () => { const tok = appliedTokens.find((t) => t.templateId === causal.tplId); if (tok) rollback(tok.token); setCausal(null); } })
      ),
    );
  }

  // ================= MR =================
  function MrPanel({ candidates, appliedTokens }) {
    if (!global.__inpMrDraft) return el(Txt, { content: 'MR 引擎未加载', size: 11, fill: 'var(--fg-3)' });
    const drafts = global.__inpMrDraft.generate(candidates, appliedTokens);
    const copy = (text) => { try { navigator.clipboard && navigator.clipboard.writeText(text); } catch {} };

    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      // Header
      el(Card, { stroke: 'var(--info)', bg: 'var(--info-soft)', pad: 10,
        head: el(Head, { icon: 'git-pull-request-arrow', iconFill: 'var(--info)', title: 'MR 草稿 · 零后端模式' }) },
        el(Txt, { content: '仅生成 unified diff，不连 GitHub。复制后手动开 PR。提交权属于人。', size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%', grow: true }),
      ),
      drafts.length === 0
        ? el(Card, { pad: 24, style: { alignItems: 'center' } }, el(Txt, { content: '暂无 MR 建议 · 先去根因/自愈 tab', size: 11, fill: 'var(--fg-3)' }))
        : drafts.map((d, i) => {
          const diffText = global.__inpMrDraft.format(d);
          const added = (d.diff || []).filter((l) => l.startsWith('+')).length;
          const removed = (d.diff || []).filter((l) => l.startsWith('-')).length;
          const isDraft = d.status === 'draft';
          return el(Card, { key: i, stroke: isDraft ? 'var(--accent)' : 'var(--border)', gap: 7,
            head: el(Head, { icon: 'file-code', title: d.branch, meta: `+${added} / -${removed}` }) },
            Row({ gap: 6, align: 'center', fill: true },
              el(Pill, { tone: isDraft ? 'accent' : 'info', label: isDraft ? '● DRAFT' : '○ SUGGESTED', soft: true, border: true, size: 9, pad: '2px 6px' }),
              el(Txt, { content: d.file, mono: true, size: 9.5, fill: 'var(--fg-3)', grow: true }),
            ),
            el(Txt, { content: d.desc, size: 10, fill: 'var(--fg-2)', wrap: true, width: '100%', grow: true }),
            el('pre', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: 8, fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', margin: 0, overflow: 'auto', maxHeight: 180, whiteSpace: 'pre' } }, diffText),
            // CI
            Row({ gap: 8, align: 'center', pad: '6px 8px', bg: 'var(--surface-2)', radius: 4, fill: true },
              el(Icon, { name: 'circle-dashed', size: 12, fill: 'var(--fg-3)' }),
              el(Txt, { content: 'CI · 预检', size: 10, weight: 600, fill: 'var(--fg)' }),
              el(Sep),
              el(Txt, { content: '本地草稿 · 未运行 CI（lint/test/build）', mono: true, size: 9, fill: 'var(--fg-3)' }),
            ),
            // Evidence + Reviewer
            Row({ gap: 7, align: 'center', fill: true },
              Row({ gap: 6, align: 'center', pad: '6px 8px', bg: 'var(--surface-2)', radius: 4, style: { flex: 1 } },
                el(Icon, { name: 'link', size: 11, fill: 'var(--accent)' }), el(Txt, { content: '证据 · ' + (d.basedOn || '—'), mono: true, size: 9, fill: 'var(--fg-2)', wrap: true, grow: true })),
              Row({ gap: 6, align: 'center', pad: '6px 8px', bg: 'var(--surface-2)', radius: 4, style: { flex: 1 } },
                el(Icon, { name: 'user-check', size: 11, fill: 'var(--fg-3)' }), el(Txt, { content: '审核人 · 待分配', mono: true, size: 9, fill: 'var(--fg-2)' })),
            ),
            el(Actions, { primary: '复制 diff', primaryIcon: 'copy', onPrimary: () => copy(diffText), ghost: '复制全文', ghostIcon: 'corner-down-right', onGhost: () => copy(d.branch + '\n' + d.file + '\n' + diffText) }),
          );
        }),
    );
  }

  // ================= 历史 =================
  function HistoryPanel({ onClear, eventCount }) {
    const [filter, setFilter] = React.useState('today');
    const [query, setQuery] = React.useState('');
    const [hosts, setHosts] = React.useState([]);
    const [expanded, setExpanded] = React.useState(null);
    const [loading, setLoading] = React.useState(true);

    React.useEffect(() => {
      const load = async () => {
        const list = await D().loadHistory(filter);
        const q = query.trim().toLowerCase();
        setHosts(q ? list.filter((h) => fmtHost(h.host).toLowerCase().includes(q) || h.events.some((e) => (e.route || '').toLowerCase().includes(q) || (e.message || '').toLowerCase().includes(q))) : list);
        setLoading(false);
      };
      load(); const t = setInterval(load, 3000); return () => clearInterval(t);
    }, [filter, query]);

    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      // Search
      Row({ gap: 6, pad: '6px 8px', bg: 'var(--surface)', stroke: 'var(--border)', radius: 5, fill: true, style: { alignItems: 'center' } },
        el(Icon, { name: 'search', size: 12, fill: 'var(--fg-3)' }),
        el('input', { value: query, onChange: (e) => setQuery(e.target.value), placeholder: '搜索 host / route / message',
          style: { flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 10 } }),
      ),
      // Filter chips
      Row({ gap: 6, fill: true },
        [['today', '今天'], ['7d', '7 天'], ['all', '全部']].map(([f, lbl]) =>
          el(Pill, { key: f, tone: filter === f ? 'accent' : 'fg-3', label: lbl, soft: filter !== f, border: filter === f, size: 10, pad: '4px 8px', onClick: () => setFilter(f) })),
      ),
      // DB card
      el(Card, { icon: 'database', iconFill: 'var(--info)', title: '持久化 · IndexedDB "inp-copilot"', meta: eventCount + ' 条', gap: 6 },
        el(KV, { k: 'events', v: '原始采集 · INP + 错误' }),
        el(KV, { k: 'attributions', v: '归因候选链' }),
        el(KV, { k: 'heals', v: '模板注入 + 回滚 token' }),
        el(KV, { k: 'mrs', v: 'MR 草稿 + 状态' }),
      ),
      // Event list
      el(Card, { icon: 'file-search', title: `事件列表 · ${hosts.length} host`, gap: 6 },
        loading ? el(Txt, { content: '加载中...', size: 11, fill: 'var(--fg-3)' })
        : hosts.length === 0 ? el(Txt, { content: '暂无数据 · 去其他页面点点戳戳', size: 11, fill: 'var(--fg-3)' })
        : hosts.map((h) => el('div', { key: h.host },
            Row({ gap: 8, align: 'center', pad: '7px 8px', bg: 'var(--surface-2)', stroke: 'var(--border)', radius: 5, fill: true, onClick: () => setExpanded(expanded === h.host ? null : h.host) },
              el(Txt, { content: fmtHost(h.host), mono: true, size: 11, fill: 'var(--fg)', grow: true }),
              h.errCount > 0 && el(Pill, { tone: 'bad', label: h.errCount + ' err', soft: true, size: 9, pad: '2px 5px' }),
              el(Pill, { tone: tone(h.p75), label: 'p75 ' + h.p75.toFixed(0) + 'ms', soft: true, size: 9, pad: '2px 5px' }),
              el(Txt, { content: h.count + ' ev', mono: true, size: 9, fill: 'var(--fg-3)' }),
            ),
            expanded === h.host && el('div', { style: { marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 } },
              h.events.slice(0, 30).map((e) => {
                const isErr = e.type === 'error'; const r = !isErr && e.value ? tone(e.value) : '';
                return Row({ key: e.eventId, gap: 6, align: 'center', pad: '5px 6px', bg: 'var(--surface)', radius: 4, fill: true },
                  el(Txt, { content: fmtTime(e.timestamp), mono: true, size: 8.5, fill: 'var(--fg-3)', style: { flex: '0 0 auto' } }),
                  el(Txt, { content: isErr ? (e.subType || 'err') : 'inp', mono: true, size: 9, weight: 600, fill: isErr ? 'var(--bad)' : `var(--${r})`, style: { flex: '0 0 auto' } }),
                  el(Txt, { content: isErr ? ((e.message || '').slice(0, 48)) : (e.value.toFixed(0) + 'ms'), mono: true, size: 9, fill: isErr ? 'var(--fg-2)' : `var(--${r})`, grow: true }),
                );
              }),
            ),
          )),
      ),
      // Footer actions
      el(Actions, { primary: '导出 JSON', primaryIcon: 'download', onPrimary: exportJson, ghost: '清空数据', ghostIcon: 'trash' in global.ICONS ? 'trash' : 'triangle-alert', onGhost: onClear }),
    );
  }
  async function exportJson() { try { if (!global.__inpDb) return; const all = await global.__inpDb.getAll('events'); const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `inp-copilot-export-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url); } catch {} }

  // ================= 设置 =================
  function SettingsPanel({ eventCount, settings, onSave, onClear }) {
    const [saved, setSaved] = React.useState(false);
    const ver = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1.0.0';
    const save = (next) => { onSave(next); setSaved(true); setTimeout(() => setSaved(false), 1200); };
    const Num = (label, desc, key, min, max, step) => el('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 10px', background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 5, marginBottom: 5 } },
      Col({ gap: 2, fill: true }, el(Txt, { content: label, size: 11, fill: 'var(--fg)' }), el(Txt, { content: desc, size: 9.5, fill: 'var(--fg-3)' })),
      el('input', { type: 'number', min, max, step, value: settings[key], onChange: (e) => { const v = parseFloat(e.target.value) || 0; save(Object.assign({}, settings, { [key]: Math.min(Math.max(min, v), max) })); }, style: { width: 64, padding: '3px 6px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 11, textAlign: 'right' } }),
    );

    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      el(Card, { icon: 'sliders-horizontal', title: '阈值 · Threshold', gap: 6 },
        Num('采样率', 'INP 取最差值需全采，此项暂不生效', 'sampleRate', 0, 1, 0.1),
        Num('LoAF 阈值 (ms)', '单帧 ≥ 此值才入 LoAF buffer', 'loafThresholdMs', 16, 200, 1),
        Num('告警阈值 INP (ms)', '超过即触发 R-03 规则', 'alertThresholdMs', 200, 2000, 10),
        saved && el(Txt, { content: '已保存', size: 10, fill: 'var(--good)', style: { textAlign: 'center' } }),
      ),
      el(Card, { icon: 'brain', iconFill: 'var(--accent)', title: 'AI 诊断 · 可选后端', meta: '路线图 · 暂不生效', gap: 6 },
        el(Txt, { content: '当前为纯前端确定性归因(规则引擎,无 LLM)。后端端点字段为路线图占位——零后端模式下不读取、不外发；待配套 collector/coordinator 就绪后接线。', size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        Row({ gap: 8, align: 'center', pad: '8px 10px', bg: 'var(--surface-2)', stroke: 'var(--border)', radius: 5 },
          Col({ gap: 2, fill: true }, el(Txt, { content: '后端端点', size: 11, fill: 'var(--fg)' }), el(Txt, { content: '留空 = 纯本地', size: 9.5, fill: 'var(--fg-3)' })),
          el('input', { value: settings.backend || '', placeholder: 'http://127.0.0.1:3920', onChange: (e) => save(Object.assign({}, settings, { backend: e.target.value })),
            style: { flex: 1, padding: '3px 6px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 10 } }),
        ),
      ),
      el(Card, { icon: 'shield-check', iconFill: 'var(--good)', title: '自愈策略 · Heal Policy', gap: 6 },
        el(Txt, { content: '注入后默认保留至页面卸载，点「撤回」即时还原；仅白名单预编译模板生效，禁止任意 eval / 动态代码执行。', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', grow: true }),
      ),
      el(Card, { icon: 'file-code', iconFill: 'var(--accent)', title: 'Source Map · 根因源码还原', gap: 6 },
        Row({ gap: 8, align: 'center', pad: '8px 10px', bg: 'var(--surface-2)', stroke: 'var(--border)', radius: 5 },
          Col({ gap: 2, fill: true },
            el(Txt, { content: '自动还原（dev）', size: 11, fill: 'var(--fg)' }),
            el(Txt, { content: '错误栈自动拉取 //# sourceMappingURL 还原源码行', size: 9.5, fill: 'var(--fg-3)' })),
          el('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10 } },
            el('input', { type: 'checkbox', checked: !!settings.sourceMapAuto, onChange: (e) => save(Object.assign({}, settings, { sourceMapAuto: e.target.checked })), style: { accentColor: 'var(--accent)' } }),
          ),
        ),
        el(Txt, { content: '开发阶段：bundle 带 sourceMappingURL 即自动还原（同源；跨域 CDN 可能被 CORS 拦截）。生产：把 .map 与 bundle 同源可访问，或关闭以省请求。', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', grow: true }),
      ),
      el(Card, { icon: 'shield', iconFill: 'var(--info)', title: '隐私 · Privacy', meta: eventCount + ' events', gap: 6 },
        el(Txt, { content: '数据全本地 IndexedDB，不出浏览器，零后端。可随时导出或清空。', size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%', grow: true }),
        el(Actions, { primary: '导出 JSON', primaryIcon: 'download', onPrimary: exportJson, ghost: '清空数据', ghostIcon: 'rotate-ccw', onGhost: onClear }),
      ),
      el(Card, { icon: 'file-code', title: '关于', gap: 4,
        head: el(Head, { icon: 'file-code', title: '关于' }) },
        el(KV, { k: 'version', v: 'v' + ver + ' · MV3' }),
        el(KV, { k: 'storage', v: 'IndexedDB 4 stores' }),
        el(KV, { k: 'backend', v: 'none (零后端)' }),
        el(KV, { k: 'license', v: 'MIT' }),
      ),
    );
  }

  global.RealtimePanel = RealtimePanel;
  global.VitalRealtimePanel = VitalRealtimePanel;
  global.HealPanel = HealPanel;
  global.MrPanel = MrPanel;
  global.HistoryPanel = HistoryPanel;
  global.SettingsPanel = SettingsPanel;
})(typeof globalThis !== 'undefined' ? globalThis : self);
