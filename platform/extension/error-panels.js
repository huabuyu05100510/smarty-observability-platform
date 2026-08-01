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
  function RootCauseView({ signal, data, onHeal, onMr, onCopyStack }) {
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
      // Verdict
      el(Card, { stroke: 'var(--border-strong)', gap: 9,
        head: el(Head, { icon: 'target', title: `${v.title} · confidence ${(v.confidence * 100).toFixed(0)}%`,
          meta: el(ConfBar, { v: v.confidence, width: 80 }) }) },
        el(Txt, { content: v.body, size: 10.5, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.6, grow: true }),
        v.tags && v.tags.length && el(Tags, { items: v.tags.map((t) => ({ label: t.label, tone: t.tone })) }),
      ),
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
    );
  }

  global.ErrorStreamPanel = ErrorStreamPanel;
  global.RootCauseView = RootCauseView;
})(typeof globalThis !== 'undefined' ? globalThis : self);
