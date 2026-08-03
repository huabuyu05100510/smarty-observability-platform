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

  // ================= 内存泄漏 实时(趋势信号,非单值 → 专门面板:堆折线 + 泄漏嫌疑)=================
  function MemoryPanel({ data, onAnalyze }) {
    // 深度分析(chrome.debugger + CDP)状态:自包含,attach 后周期 getMetrics + 堆快照 diff
    const [attached, setAttached] = React.useState(false);
    const [metrics, setMetrics] = React.useState(null);
    const [deep, setDeep] = React.useState(null);
    const [sessions, setSessions] = React.useState([]);
    const [recBusy, setRecBusy] = React.useState(false);
    const [replayRes, setReplayRes] = React.useState(null);
    React.useEffect(() => {
      if (!attached) { setMetrics(null); return; }
      let alive = true;
      const tick = async () => { const HP = globalThis.__heapProfiler; if (!HP) return; const m = await HP.getMetrics(); if (m && !m.error && alive) setMetrics(m); };
      tick(); const t = setInterval(tick, 2000);
      return () => { alive = false; clearInterval(t); };
    }, [attached]);
    React.useEffect(() => {
      let alive = true;
      const load = async () => { if (globalThis.__data && globalThis.__data.loadSessions) { const s = await globalThis.__data.loadSessions(); if (alive) setSessions(s.slice(0, 6)); } };
      load(); const t = setInterval(load, 3000); return () => { alive = false; clearInterval(t); };
    }, []);
    const recFieldSession = (start) => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return;
      if (start) { chrome.runtime.sendMessage({ type: 'REPLAY_START_RECORD' }, () => setRecBusy(true)); }
      else { chrome.runtime.sendMessage({ type: 'REPLAY_STOP_RECORD' }, async (resp) => { setRecBusy(false); if (resp && resp.events && globalThis.__data && globalThis.__data.saveSession) { await globalThis.__data.saveSession(resp); } }); }
    };
    const replaySession = (sess) => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return;
      chrome.runtime.sendMessage({ type: 'REPLAY_RUN', record: sess, opts: {} }, (r) => setReplayRes(r));
    };
    const doAttach = async () => { const HP = globalThis.__heapProfiler; if (!HP) return; const r = await HP.attach(); setAttached(!!(r && r.ok)); };
    const doDetach = async () => { const HP = globalThis.__heapProfiler; if (!HP) return; await HP.detach(); setAttached(false); };
    const doDeep = async () => {
      const HP = globalThis.__heapProfiler; if (!HP) return;
      setDeep({ running: true });
      const r = await HP.takeDiffSnapshot({ between: () => new Promise((res) => setTimeout(res, 3000)), topN: 8, timeoutMs: 8000 });
      setDeep({ running: false, result: (r && r.topLeaks) ? r : null, error: r && r.error });
    };
    const cfg = (data && data.cfg) || (D().SIGNALS && D().SIGNALS.memory);
    if (!data || !data.hasData || !cfg) return el(Card, { pad: 24, style: { alignItems: 'center' } },
      el(Txt, { content: '等待堆采样 · 浏览页面 ~30s 即可采集趋势(Chrome performance.memory)', size: 11, fill: 'var(--fg-3)' }));
    const cur = data.cur;
    const ratio = cur.ratio || 0;
    const r = ratio <= cfg.thr.good ? 'good' : ratio <= cfg.thr.poor ? 'warn' : 'bad';
    const num = (v) => ((v || 0) * cfg.scale).toFixed(cfg.decimals);
    const segs = cfg.segs(cur);
    const segTotal = segs.reduce((s, x) => s + (x.value || 0), 0) || 1;
    const samples = data.samples || [];
    const used = samples.map((s) => s.used || 0);
    const w = 280, h = 46;
    const mx = Math.max(1, ...used), mn = Math.min(...used);
    const xAt = (i) => i / Math.max(1, used.length - 1) * w;
    const pts = used.map((v, i) => xAt(i) + ',' + (h - (v - mn) / Math.max(1, mx - mn) * (h - 6) - 3)).join(' ');
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      // Hero
      el(Card, { stroke: 'var(--' + r + ')', pad: 12, gap: 10, style: { borderRadius: 6 } },
        Row({ gap: 12, align: 'flex-start', fill: true },
          Col({ gap: 2, fill: true },
            el(Txt, { content: cfg.heroLabel, mono: true, size: 8.5, ls: 0.6, fill: 'var(--fg-3)' }),
            Row({ gap: 4, align: 'end' },
              el(Txt, { content: num(cur.value), mono: true, size: 40, weight: 700, fill: 'var(--' + r + ')', style: { lineHeight: 1 } }),
              cfg.unit && el(Txt, { content: cfg.unit, mono: true, size: 13, fill: 'var(--fg-2)' }),
            ),
            Row({ gap: 5, align: 'center', style: { paddingTop: 3 } },
              el(Pill, { tone: r, label: cfg.verdict(r), soft: true, size: 8.5, pad: '2px 5px' }),
              el(Txt, { content: 'limit ' + num(cur.limit) + cfg.unit + ' · ' + Math.round(ratio * 100) + '%', mono: true, size: 8.5, fill: 'var(--fg-3)' }),
            ),
          ),
          el(Sep),
          el(Gauge, { pct: ratio, tone: r, label: '占 limit', value: Math.round(ratio * 100) + '%' }),
        ),
        el(StatRow, { items: [
          { label: '堆增长', value: ((cur.heapSlopeMB || 0) > 0 ? '+' : '') + (cur.heapSlopeMB || 0).toFixed(1), unit: 'MB/min', tone: (cur.heapSlopeMB || 0) > 0.5 ? 'bad' : 'good' },
          { label: 'DOM 斜率', value: ((cur.domSlope || 0) > 0 ? '+' : '') + (cur.domSlope || 0).toFixed(0), unit: '/min', tone: (cur.domSlope || 0) > 50 ? 'warn' : 'fg' },
          { label: 'DOM 节点', value: String(cur.domCount || 0) },
          { label: '样本', value: String(data.sampleCount || 0) },
        ] }),
      ),
      // 趋势 SVG(堆折线 + nav 标记)
      samples.length >= 3 && el(Card, { head: el(Head, { variant: 'label', title: '堆使用趋势 · HEAP TREND', meta: cur.leakSuspect }), gap: 8 },
        el('svg', { width: '100%', height: h, viewBox: '0 0 ' + w + ' ' + h, preserveAspectRatio: 'none', style: { background: 'var(--surface-3)', borderRadius: 3 } },
          el('polyline', { points: pts, fill: 'none', stroke: 'var(--' + r + ')', strokeWidth: 1.5 }),
          samples.map((s, i) => s.nav ? el('line', { key: 'n' + i, x1: xAt(i), x2: xAt(i), y1: 0, y2: h, stroke: 'var(--accent)', strokeWidth: 0.5, strokeDasharray: '2 2' }) : null),
        ),
        Row({ gap: 6, align: 'center', fill: true },
          el(Txt, { content: 'min ' + num(mn) + cfg.unit, mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          el(Sep),
          el(Txt, { content: 'max ' + num(mx) + cfg.unit, mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          cur.noRelease && el(Pill, { tone: 'warn', label: '路由后未回落⚠', soft: true, size: 8 }),
        ),
      ),
      // Breakdown(used/free of limit)
      el(Card, { head: el(Head, { variant: 'label', title: cfg.bdTitle, meta: '占 limit ' + Math.round(ratio * 100) + '%' }), gap: 8 },
        el(Stacked, { segs: segs.map((s) => ({ value: s.value, color: s.color })), height: 22 }),
        segs.map((s, i) => el(Legend, { key: i, swatch: s.color, label: s.label, value: num(s.value) + cfg.unit, pct: (s.value / segTotal * 100).toFixed(1) + '%' })),
      ),
      // 泄漏嫌疑
      el(Card, { head: el(Head, { variant: 'label', title: cfg.tgtTitle, meta: cfg.tgtEntry }), gap: 8 },
        Row({ gap: 8, align: 'flex-start', pad: 8, bg: 'var(--surface-2)', stroke: r === 'bad' ? 'var(--bad)' : 'var(--border-strong)', radius: 4, fill: true },
          el(Icon, { name: 'database', size: 14, fill: 'var(--accent)' }),
          Col({ gap: 3, fill: true },
            el(Txt, { content: cur.leakSuspect || '堆平稳', mono: true, size: 9.5, fill: 'var(--fg)', wrap: true, width: '100%', grow: true }),
            el(Txt, { content: cur.noRelease ? '路由切换后堆未回落 → SPA 跨路由泄漏嫌疑(组件卸载未清理订阅/定时器/引用)' : ((cur.heapSlopeMB || 0) > 0.5 ? '堆单调增长不回落 → 疑似闭包/缓存/监听器累积' : '堆使用平稳,未匹配已知泄漏模式'), size: 8.5, fill: 'var(--fg-3)', wrap: true, width: '100%', grow: true }),
          ),
        ),
        (cfg.kv(cur) || []).map((row, i) => el(KV, { key: i, k: row[0], v: row[1], vTone: row[2] || 'fg' })),
      ),
      // Trigger
      (ratio > cfg.thr.good || (cur.heapSlopeMB || 0) > 0.5 || cur.noRelease) && el(Card, { stroke: 'var(--accent)', gap: 9,
        head: el(Head, { icon: 'zap', iconFill: 'var(--accent)', title: 'R-05 · 检测到内存泄漏嫌疑' }) },
        el(Txt, { content: cfg.desc, size: 10, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.55, grow: true }),
        el(Actions, { primary: '分析泄漏根因', primaryIcon: 'search-code', onPrimary: onAnalyze }),
      ),
      // 现场录制/回放(P2 独立链路):录交互+堆/DOM 快照点 → 存 session → 可回放重测/分享重现
      el(Card, { icon: 'loader-circle', iconFill: 'var(--accent)', title: '现场录制 · record-replay', meta: sessions.length + ' session', gap: 7 },
        el(Txt, { content: '录一段操作(交互 + 当时的堆/DOM 快照点)→ 存 session → 日后/他人可回放重测,判断泄漏是否复现。session 也可作为「分享重现」的现场。', size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        el(Btn, { label: recBusy ? '⏺ 录制中…点此停止' : '开始录制现场', icon: 'loader-circle', onClick: () => recFieldSession(!recBusy), fill: true, size: 10 }),
        recBusy && el(Txt, { content: '现在去页面真实操作(点击/输入),完成后回来停止。', size: 9, fill: 'var(--warn)', wrap: true, width: '100%' }),
        sessions.length > 0 && sessions.slice(0, 4).map((s) => Row({ key: s.eventId, gap: 7, align: 'center', pad: '5px 7px', bg: 'var(--surface-2)', radius: 4, fill: true },
          el(Txt, { content: (s.events || []).length + ' 事件 · ' + ((s.duration || 0) / 1000).toFixed(1) + 's', mono: true, size: 9, fill: 'var(--fg-2)', grow: true }),
          s.meta && s.meta.heapEnd && el(Txt, { content: '录时堆 ' + ((s.meta.heapEnd.used || 0) / 1048576).toFixed(0) + 'MB', mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          el(Btn, { label: '回放', onClick: () => replaySession(s), size: 9, fill: false }),
        )),
        replayRes && replayRes.samples && el(Txt, { content: '回放 ' + replayRes.samples.length + ' 事件 · 平均 handler ' + (replayRes.samples.reduce((a, b) => a + b, 0) / replayRes.samples.length).toFixed(1) + 'ms', mono: true, size: 9, fill: 'var(--fg-3)' }),
      ),
      // 深度分析(chrome.debugger + CDP):精确计数 + 堆快照 diff —— advisory 拿不到的能力
      el(Card, { icon: 'database', iconFill: 'var(--accent)', title: '深度分析 · CDP 堆检测', meta: attached ? 'attach 中' : '未启用', gap: 7 },
        el(Txt, { content: 'advisory 模式只有趋势推断。attach 启用 chrome.debugger → 拿精确 DOM 节点(含 detached)/监听器计数 + 堆快照 diff(定位泄漏对象类型)。代价:浏览器顶部显示「正在调试」提示条(CDP 强制)。', size: 9, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        Row({ gap: 7 },
          el(Btn, { label: attached ? 'detach(关闭提示条)' : 'attach 启用', icon: attached ? 'rotate-ccw' : 'database', onClick: attached ? doDetach : doAttach, fill: !attached, size: 10 }),
          attached && el(Btn, { label: (deep && deep.running) ? '拍快照中…' : '堆快照 diff', icon: 'search-code', onClick: doDeep, disabled: !!(deep && deep.running), fill: true, size: 10 }),
        ),
        attached && metrics && el(StatRow, { items: [
          { label: 'DOM 节点(含 detached)', value: String(metrics.nodes == null ? '?' : metrics.nodes), tone: metrics.nodes > 5000 ? 'warn' : 'fg' },
          { label: '事件监听器', value: String(metrics.listeners == null ? '?' : metrics.listeners), tone: metrics.listeners > 500 ? 'warn' : 'fg' },
          { label: 'JS 堆 used', value: ((metrics.heapUsed || 0) / 1048576).toFixed(1), unit: 'MB' },
          { label: 'JS 堆 total', value: ((metrics.heapTotal || 0) / 1048576).toFixed(1), unit: 'MB' },
        ] }),
        attached && metrics && metrics.listeners > 500 && el(Txt, { content: '⚠ 监听器 ' + metrics.listeners + ' 个偏多 → listener_leak 嫌疑(组件卸载未 removeEventListener / 重复注册)', size: 9, fill: 'var(--warn)', wrap: true, width: '100%' }),
        deep && deep.error && el(Txt, { content: '✗ ' + deep.error, size: 9, fill: 'var(--bad)', wrap: true, width: '100%' }),
        deep && deep.result && el('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          Row({ gap: 6, align: 'center' },
            el(Dot, { tone: 'bad', size: 6 }),
            el(Txt, { content: '净泄漏 ' + (deep.result.totalLeak / 1048576).toFixed(2) + 'MB · ' + deep.result.topLeaks.length + ' 类对象增长', size: 9.5, weight: 600, fill: 'var(--fg-2)', grow: true }),
          ),
          deep.result.topLeaks.map((l, i) => Row({ key: i, gap: 7, align: 'center', pad: '4px 6px', bg: 'var(--surface-2)', radius: 4, fill: true },
            el(Txt, { content: l.type + '/' + (l.name || '(anon)'), mono: true, size: 9, fill: 'var(--fg-2)', grow: true, wrap: true, width: '100%' }),
            el(Txt, { content: '+' + (l.selfSizeDelta / 1024).toFixed(1) + 'KB', mono: true, size: 9, weight: 600, fill: 'var(--bad)' }),
            el(Txt, { content: (l.pct * 100).toFixed(0) + '%', mono: true, size: 8.5, fill: 'var(--fg-3)' }),
          )),
        ),
      ),
    );
  }

  // ================= 概览(聚合 7 信号一览 + 跨信号联动) =================
  function OverviewPanel({ live, onDrill }) {
    const [snap, setSnap] = React.useState(null);
    React.useEffect(() => {
      let alive = true;
      const load = async () => {
        const D = globalThis.__data; if (!D) return;
        const events = await D.allEvents();
        const lv = (live && live.vitals) || {};
        const now = Date.now();
        const errs = events.filter((e) => e.type === 'error' && (e.timestamp || 0) > now - 5 * 60e3).length;
        const memArr = lv.memory || [];
        const fpsArr = lv.fps || [];
        const cards = [
          { signal: 'inp', label: 'INP', value: live && live.inp && live.inp.value, unit: 'ms', drill: 'inp' },
          { signal: 'lcp', label: 'LCP', value: lv.lcp, unit: 's', scale: 0.001, decimals: 1, drill: 'lcp' },
          { signal: 'fcp', label: 'FCP', value: lv.fcp, unit: 's', scale: 0.001, decimals: 1, drill: 'fcp' },
          { signal: 'cls', label: 'CLS', value: lv.cls, decimals: 2, drill: 'cls' },
          { signal: 'fps', label: 'FPS', value: fpsArr.length ? fpsArr[fpsArr.length - 1].fps : null, drill: 'fps' },
          { signal: 'memory', label: '内存', value: memArr.length ? Math.round(memArr[memArr.length - 1].used / 1048576) : null, unit: 'MB', drill: 'memory' },
          { signal: 'error', label: '错误', value: errs, unit: '/5m', drill: 'error' },
        ];
        cards.forEach((c) => {
          if (c.signal === 'error') c.rating = errs > 0 ? 'bad' : 'good';
          else if (c.value == null) c.rating = 'fg-3';
          else if (c.signal === 'fps') c.rating = c.value >= 50 ? 'good' : c.value >= 30 ? 'warn' : 'bad';
          else c.rating = D.rateSig(c.signal, c.value);
        });
        if (alive) setSnap({ cards });
      };
      load(); const t = setInterval(load, 2000);
      return () => { alive = false; clearInterval(t); };
    }, [live]);

    if (!snap) return el(Txt, { content: '加载概览...', size: 11, fill: 'var(--fg-3)' });
    const good = snap.cards.filter((c) => c.rating === 'good').length;
    const bad = snap.cards.filter((c) => c.rating === 'bad').length;
    const toneOf = (r) => r === 'good' ? 'good' : r === 'warn' ? 'warn' : r === 'bad' ? 'bad' : 'fg-3';
    return el('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
      // 总健康度
      el(Card, { stroke: bad > 0 ? 'var(--bad)' : good >= 6 ? 'var(--good)' : 'var(--warn)', pad: 12, gap: 8 },
        Row({ gap: 12, align: 'center', fill: true },
          el(Gauge, { pct: good / 7, tone: bad > 0 ? 'bad' : 'good', label: '健康', value: good + '/7' }),
          Col({ gap: 2, fill: true },
            el(Txt, { content: bad > 0 ? '有 ' + bad + ' 个信号异常' : good >= 6 ? '全部正常' : '部分待观察', size: 13, weight: 600, fill: bad > 0 ? 'var(--bad)' : 'var(--good)' }),
            el(Txt, { content: '7 信号域当前状态一览 · 点卡片下钻到对应域 · 按当前域名隔离', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%' }),
          ),
        ),
      ),
      // 信号卡片(点击下钻)
      el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 7 } },
        snap.cards.map((c) => el('div', { key: c.signal, onClick: () => onDrill && onDrill(c.drill), style: { flex: '1 1 40%', minWidth: 130, padding: 10, background: 'var(--surface)', border: '1px solid var(--' + toneOf(c.rating) + ')', borderRadius: 5, cursor: 'pointer' } },
          Row({ gap: 7, align: 'center' },
            el(Dot, { tone: toneOf(c.rating), size: 8 }),
            el(Txt, { content: c.label, mono: true, size: 10, weight: 600, fill: 'var(--fg-2)', grow: true }),
            c.drill && el(Icon, { name: 'arrow-right', size: 11, fill: 'var(--fg-3)' }),
          ),
          el(Txt, { content: c.value == null ? '—' : (c.value * (c.scale || 1)).toFixed(c.decimals || 0) + (c.unit || ''), mono: true, size: 18, weight: 700, fill: 'var(--' + toneOf(c.rating) + ')', style: { paddingTop: 5 } }),
        )),
      ),
      // 跨信号联动提示
      el(Card, { icon: 'link', iconFill: 'var(--accent)', title: '跨信号联动 · advisory', gap: 7 },
        el(Txt, { content: '同时间窗(5s)多信号异常会形成因果关联(内存涨→GC→INP 慢 / 资源 404→LCP 慢 等)。下钻到任一信号「根因」tab 看「跨信号因果链」详情。', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
      ),
    );
  }

  // ================= 自愈 =================
  function HealPanel({ domain, live, appliedTokens, setAppliedTokens }) {
    const [busy, setBusy] = React.useState(null);
    const [result, setResult] = React.useState(null);
    const [causal, setCausal] = React.useState(null);
    const [loop, setLoop] = React.useState(null); // { running, iter, current, result, error }
    const [record, setRecord] = React.useState(null); // record-replay 录制结果
    const [paired, setPaired] = React.useState(null); // 配对实验 {running, result, error}
    const [recing, setRecing] = React.useState(false);
    const [heals, setHeals] = React.useState([]); // heals 审计日志(apply/rollback 轨迹)
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
            if (globalThis.__data && globalThis.__data.recordHeal) globalThis.__data.recordHeal(resp.token, tplId, 'apply', resp.summary); // 审计
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
    const rollback = (token) => { if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return; chrome.runtime.sendMessage({ type: 'ROLLBACK_HEAL', token }, (resp) => { if (resp?.ok) { setAppliedTokens((p) => p.filter((t) => t.token !== token)); const t0 = appliedTokens.find((t) => t.token === token); if (globalThis.__data && globalThis.__data.recordHeal && t0) globalThis.__data.recordHeal(token, t0.templateId, 'rollback', ''); } }); };
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

    // 配对因果实验(record-replay):录制交互 → patch 前后重放同一序列 → 配对 t(功效高于独立 Welch)
    const toggleRecord = () => {
      if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) return;
      if (!recing) { chrome.runtime.sendMessage({ type: 'REPLAY_START_RECORD' }, () => { setRecing(true); setRecord(null); setPaired(null); }); }
      else { chrome.runtime.sendMessage({ type: 'REPLAY_STOP_RECORD' }, (resp) => { setRecing(false); setRecord(resp); }); }
    };
    const runPaired = async () => {
      const HL = globalThis.__healLoop;
      if (!HL || !record || !(record.events || []).length) { setPaired({ error: '先录制一段交互(开始录制后在页面真实操作)' }); return; }
      // 配对实验用机械类候选(debounce_handler):它 patch addEventListener,re放下可量到 handler 行为变化
      const entry = HL.CANDIDATE_MAP && Object.entries(HL.CANDIDATE_MAP).find(([id, m]) => !m.semantic && id === 'debounce_handler');
      const candidate = entry ? { id: entry[0], label: entry[1].label, semantic: false, proxy: { templateId: entry[0], opts: {} } } : null;
      if (!candidate) { setPaired({ error: '无可用机械类候选' }); return; }
      setPaired({ running: true });
      const adapter = HL.buildAdapter({ event: liveRef.current?.inp || {}, baselineValues: (liveRef.current?.interactions || []).map((i) => i.value).filter((v) => v > 0) });
      const r = await HL.runPairedExperiment({ candidate, record, applyProxy: adapter.applyProxy, rollback: adapter.rollback, replay: adapter.replayRecord });
      setPaired({ running: false, result: r });
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
        // P1 根因-自愈耦合:验证结果写回根因(该 tplId 的验证 → 根因 verified/falsified/weak)
        if (globalThis.__data && globalThis.__data.recordVerification && r) {
          globalThis.__data.recordVerification((live && live.host ? live.host + ':' : '') + 'tpl:' + causal.tplId, { conclusion: r.conclusion, significant: r.significant, effectSize: r.effectSize, pValue: r.pValue });
        }
      } else if (treated.length !== causal.treated.length) {
        setCausal({ ...causal, treated });
      }
    }, [live?.interactions]);
    // heals 审计日志:周期加载 apply/rollback 轨迹(自愈动作可审计)
    React.useEffect(() => {
      let alive = true;
      const load = async () => { if (globalThis.__data && globalThis.__data.getHeals) { const h = await globalThis.__data.getHeals(); if (alive) setHeals(h.slice(0, 10)); } };
      load(); const t = setInterval(load, 3000); return () => { alive = false; clearInterval(t); };
    }, []);

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
                el(Txt, { content: 'baseline ' + Math.round(loop.result.evidence.baselineMean) + 'ms → treated ' + Math.round(loop.result.evidence.treatedMean) + 'ms · effect ' + Math.round(loop.result.evidence.verdict.effectSize) + 'ms · p=' + loop.result.evidence.verdict.pValue.toFixed(3) + (loop.result.evidence.holm ? ' · Holm p=' + loop.result.evidence.holm.adjustedP.toFixed(3) + (loop.result.evidence.holm.rejected ? '(校正后仍显著)' : '(校正后不显著⚠)') : ''), mono: true, size: 9, fill: 'var(--fg-2)', wrap: true, width: '100%' }),
                el(Txt, { content: 'MR 由你决定(提交权属于人):', size: 9, fill: 'var(--fg-3)' }),
                loop.result.winner.sourceDiff
                  ? el('pre', { style: { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4, padding: 6, fontSize: 9.5, fontFamily: 'var(--font-mono)', color: 'var(--fg-2)', margin: '4px 0', whiteSpace: 'pre', overflow: 'auto', maxHeight: 120 } }, (loop.result.winner.sourceDiff.diff || []).join('\n'))
                  : el(Txt, { content: '(该候选无源码 diff 模板)', size: 9, fill: 'var(--fg-3)' }),
                el(Actions, { primary: '提 MR(复制 diff)', primaryIcon: 'git-pull-request-arrow', onPrimary: () => { try { navigator.clipboard && navigator.clipboard.writeText((loop.result.winner.sourceDiff && loop.result.winner.sourceDiff.diff || []).join('\n')); } catch {} }, ghost: '不提,关闭', ghostIcon: 'x', onGhost: () => setLoop(null) }),
              )
            : el(Txt, { content: '✗ 候选耗尽,未达优秀(可能需要语义类 patch/模型,或瓶颈不在模板覆盖范围)', size: 9.5, fill: 'var(--warn)', wrap: true, width: '100%' }),
        ),
      ),
      // 配对因果实验(record-replay):仅 INP 域,依赖录制 + 重放 handler 耗时代理
      domain === 'inp' && el(Card, { icon: 'loader-circle', iconFill: 'var(--accent)', title: '配对因果实验 · record-replay', meta: record ? (record.events || []).length + ' 事件' : '未录制', gap: 7 },
        el(Txt, { content: '录制交互 → 同一序列在 patch 前后各重放 → 配对 t(消除交互间固有差异,功效高于独立 Welch)。重放测的是 handler 同步耗时代理,非 Event Timing INP 真值。', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        Row({ gap: 7 },
          el(Btn, { label: recing ? '⏺ 录制中…点此停止' : (record ? '重新录制' : '开始录制'), onClick: toggleRecord, fill: !recing, size: 10 }),
          el(Btn, { label: paired?.running ? '运行中…' : '运行配对实验', icon: 'rotate-ccw', onClick: runPaired, disabled: !record || !!paired?.running, fill: true, size: 10 }),
        ),
        recing && el(Txt, { content: '现在去页面真实操作(点击/输入),录到 trusted 事件后回来停止。', size: 9, fill: 'var(--warn)', wrap: true, width: '100%' }),
        paired?.error && el(Txt, { content: '✗ ' + paired.error, size: 9.5, fill: 'var(--bad)', wrap: true, width: '100%' }),
        paired?.result && el('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          Row({ gap: 7, align: 'center', pad: '5px 7px', bg: 'var(--surface-2)', radius: 4, fill: true, stroke: paired.result.verdict.conclusion === 'accepted' ? 'var(--good)' : undefined },
            el(Dot, { tone: paired.result.verdict.conclusion === 'accepted' ? 'good' : 'fg-3', size: 6 }),
            el(Txt, { content: paired.result.candidate.label, size: 9.5, fill: 'var(--fg-2)', grow: true }),
            el(Txt, { content: 'n=' + paired.result.n + ' · effect ' + Math.round(paired.result.verdict.effectSize) + 'ms · p=' + paired.result.verdict.pValue.toFixed(3) + ' · ' + paired.result.verdict.conclusion, mono: true, size: 9, fill: paired.result.verdict.conclusion === 'accepted' ? 'var(--good)' : 'var(--fg-3)' }),
          ),
          el(Txt, { content: '⚠ ' + ((paired.result.verdict.caveats || []).join(' | ')), size: 8.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.4 }),
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
      // 审计日志(apply/rollback 写 heals store,可追溯 — 自愈动作必须可审计)
      heals.length > 0 && el(Card, { icon: 'git-branch', iconFill: 'var(--fg-3)', title: '自愈审计 · apply/rollback 轨迹', meta: heals.length + ' 条', gap: 5 },
        heals.slice(0, 6).map((h) => Row({ key: h.eventId, gap: 7, align: 'center', pad: '4px 6px', bg: 'var(--surface-2)', radius: 4, fill: true },
          el(Dot, { tone: h.action === 'apply' ? 'accent' : 'fg-3', size: 5 }),
          el(Txt, { content: h.templateId, mono: true, size: 9, fill: 'var(--fg-2)', grow: true }),
          el(Txt, { content: h.action, mono: true, size: 8.5, fill: h.action === 'apply' ? 'var(--accent)' : 'var(--fg-3)', style: { flex: '0 0 auto' } }),
          el(Txt, { content: fmtTime(h.timestamp), mono: true, size: 8.5, fill: 'var(--fg-3)' }),
        )),
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
        causal.phase === 'done' && causal.result && causal.result.caveats && el(Txt, { content: '⚠ advisory · ' + (causal.result.caveats[0] || ''), title: causal.result.caveats.join('\n'), size: 8.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.4 }),
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
  function SettingsPanel({ eventCount, settings, onSave, onClear, onGenerateShare, onImport, shareOut, importOut, llmConfig, onSaveLlm, onPreflight, preflightResult }) {
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
      el(Card, { icon: 'brain', iconFill: 'var(--accent)', title: 'AI 引擎 · LLM 配置(真根因+真自愈)', meta: llmConfig && llmConfig.apiKey ? '已配置' : '未配置', gap: 7 },
        el(Txt, { content: '配置 LLM 后,扩展用 AI 做「真根因诊断」(替代规则启发式)+「真自愈」(LLM 生成 AST 补丁,替代模板白名单)。local-first:只发源码片段+trace 给 LLM,全量数据仍在本地。', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        Row({ gap: 8, align: 'center' },
          el(Txt, { content: 'Provider', size: 10, fill: 'var(--fg-2)', style: { flex: '0 0 auto' } }),
          el('select', { value: (llmConfig && llmConfig.provider) || 'custom', onChange: (e) => onSaveLlm(globalThis.__llm.applyProvider(e.target.value, llmConfig)), style: { flex: 1, padding: '4px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontSize: 10 } },
            Object.entries(globalThis.__llm.PROVIDERS).map(([k, p]) => el('option', { key: k, value: k }, p.label)),
          ),
        ),
        Col({ gap: 4 },
          el(Txt, { content: 'API Key', size: 10, fill: 'var(--fg-2)' }),
          el('input', { type: 'password', value: (llmConfig && llmConfig.apiKey) || '', placeholder: 'sk-...', onChange: (e) => onSaveLlm(Object.assign({}, llmConfig || {}, { apiKey: e.target.value })), style: { padding: '5px 6px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 10, width: '100%' } }),
          el(Txt, { content: 'Base URL', size: 10, fill: 'var(--fg-2)' }),
          el('input', { value: (llmConfig && llmConfig.baseUrl) || '', placeholder: 'https://...', onChange: (e) => onSaveLlm(Object.assign({}, llmConfig || {}, { baseUrl: e.target.value })), style: { padding: '5px 6px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 9, width: '100%' } }),
          el(Txt, { content: 'Model', size: 10, fill: 'var(--fg-2)' }),
          el('input', { value: (llmConfig && llmConfig.model) || '', placeholder: 'model name', onChange: (e) => onSaveLlm(Object.assign({}, llmConfig || {}, { model: e.target.value })), style: { padding: '5px 6px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 10, width: '100%' } }),
        ),
        Row({ gap: 7 },
          el(Btn, { label: '测试连通', icon: 'zap', onClick: onPreflight, disabled: !llmConfig || !llmConfig.baseUrl, size: 10, fill: false }),
          preflightResult && el(Txt, { content: preflightResult.ok ? '✓ 连通成功' : ('✗ ' + (preflightResult.error || '').slice(0, 60)), size: 9.5, fill: preflightResult.ok ? 'var(--good)' : 'var(--bad)', grow: true, wrap: true, width: '100%' }),
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
      el(Card, { icon: 'link', iconFill: 'var(--accent)', title: 'Claude Code 桥 · Sidecar', meta: settings.sidecarEnabled ? '已开启' : '关闭', gap: 6 },
        el(Txt, { content: '把 verified 的 AI 自愈补丁(根因 + search/replace)推给本地 vc-mcp,由 Claude Code 在真实仓库 apply + 测试 + 开 MR。默认关闭。开启前先:claude mcp add vc -- node packages/vc-mcp/dist/index.js', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        Row({ gap: 8, align: 'center', pad: '8px 10px', bg: 'var(--surface-2)', stroke: 'var(--border)', radius: 5 },
          Col({ gap: 2, fill: true },
            el(Txt, { content: '启用 sidecar 推送', size: 11, fill: 'var(--fg)' }),
            el(Txt, { content: '仅当 AI 补丁 sourceMatched + Verifier accepted 时推送;fire-and-forget,失败静默', size: 9.5, fill: 'var(--fg-3)' }),
          ),
          el('label', { style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 10 } },
            el('input', { type: 'checkbox', checked: !!settings.sidecarEnabled, onChange: (e) => save(Object.assign({}, settings, { sidecarEnabled: e.target.checked })), style: { accentColor: 'var(--accent)' } }),
          ),
        ),
        Row({ gap: 8, align: 'center', pad: '8px 10px', bg: 'var(--surface-2)', stroke: 'var(--border)', radius: 5 },
          el(Txt, { content: 'URL', size: 10, fill: 'var(--fg-3)' }),
          el('input', { value: settings.sidecarUrl || '', onChange: (e) => save(Object.assign({}, settings, { sidecarUrl: e.target.value })), style: { flex: 1, background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 10, padding: '4px 6px' } }),
        ),
      ),
      el(Card, { icon: 'shield', iconFill: 'var(--info)', title: '隐私 · Privacy', meta: eventCount + ' events', gap: 6 },
        el(Txt, { content: '数据全本地 IndexedDB，不出浏览器，零后端。可随时导出或清空。', size: 9.5, fill: 'var(--fg-2)', wrap: true, width: '100%', grow: true }),
        el(Actions, { primary: '导出 JSON', primaryIcon: 'download', onPrimary: exportJson, ghost: '清空数据', ghostIcon: 'rotate-ccw', onGhost: onClear }),
      ),
      // P4 分享重现:给个链接/文件 → 他人还原所有问题
      el(Card, { icon: 'link', iconFill: 'var(--accent)', title: '分享重现 · 给个链接还原问题', gap: 7 },
        el(Txt, { content: '把当前问题现场(根因+事件+重放序列)编码成链接/文件,发他人即可还原。链接=base64(核心现场,直接发,无堆快照);文件=.vc-repro(完整,含堆快照)。', size: 9.5, fill: 'var(--fg-3)', wrap: true, width: '100%', lh: 1.5, grow: true }),
        el(Btn, { label: '生成重现链接 / 文件', icon: 'link', onClick: onGenerateShare, fill: true, size: 10 }),
        shareOut && !shareOut.error && el('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
          el(Txt, { content: '链接 · ' + (shareOut.sizeLink / 1024).toFixed(1) + 'KB(核心现场):', size: 9, fill: 'var(--fg-3)' }),
          el('textarea', { readOnly: true, value: shareOut.link, style: { background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg-2)', fontFamily: 'var(--font-mono)', fontSize: 8, height: 48, resize: 'vertical' } }),
          Row({ gap: 7 },
            el(Btn, { label: '复制链接', icon: 'copy', onClick: () => { try { navigator.clipboard && navigator.clipboard.writeText(shareOut.link); } catch {} }, size: 9, fill: false }),
            el(Btn, { label: '下载 .vc-repro(' + (shareOut.sizeFile / 1024).toFixed(1) + 'KB,含堆快照)', icon: 'download', onClick: () => { try { const blob = new Blob([shareOut.file], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'vc-repro-' + Date.now() + '.json'; a.click(); URL.revokeObjectURL(url); } catch {} }, size: 9, fill: false }),
          ),
        ),
        shareOut && shareOut.error && el(Txt, { content: '✗ ' + shareOut.error, size: 9, fill: 'var(--bad)' }),
        el(Txt, { content: '导入他人现场(粘链接或 .vc-repro 文件内容):', size: 9.5, fill: 'var(--fg-2)', style: { paddingTop: 4 } }),
        el('textarea', { id: 'vc-import-input', placeholder: '粘链接(#vc-repro=...)或 .vc-repro 文件 JSON', style: { background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--fg)', fontFamily: 'var(--font-mono)', fontSize: 9, height: 60, resize: 'vertical' } }),
        el(Btn, { label: '导入还原', icon: 'download', onClick: () => { const inp = document.getElementById('vc-import-input'); if (inp && inp.value && onImport) onImport(inp.value); }, fill: true, size: 10 }),
        importOut && el(Txt, { content: importOut.error ? ('✗ ' + importOut.error) : ('✓ 已还原 ' + importOut.events + ' 事件 + ' + importOut.sessions + ' 重放序列' + (importOut.hasHeap ? '(含堆快照)' : '') + ' · 切各 tab 查看同款根因/数据'), size: 9, fill: importOut.error ? 'var(--bad)' : 'var(--good)', wrap: true, width: '100%' }),
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
  global.MemoryPanel = MemoryPanel;
  global.OverviewPanel = OverviewPanel;
  global.HealPanel = HealPanel;
  global.MrPanel = MrPanel;
  global.HistoryPanel = HistoryPanel;
  global.SettingsPanel = SettingsPanel;
})(typeof globalThis !== 'undefined' ? globalThis : self);
