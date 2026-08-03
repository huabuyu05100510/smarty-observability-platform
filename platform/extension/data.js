// data.js · 数据适配层（local 优先：从 IndexedDB 真实计算；后端可选）
// 给各屏返回结构化 payload；集中处理"本地可得 vs 需后端"的诚实降级。
// 所有跨用户聚合指标（真·MTTR / CI / reviewer / 全站用户数）本地不可得 → 用本地代理或 '—'，
// 并在 UI 以 title 小字标注口径，保持"零后端、不夸大"基调。
(function (global) {
  const db = () => global.__inpDb;
  const DIAG = () => global.__inpDiagnose;
  const EDIAG = () => global.__inpErrorDiagnose;

  // 内存缓存:启动 getAll 一次,之后所有写入经 putEvent 同步维护 cache → 高频轮询(每 2s)读内存,不再全表扫。
  let _eventsCache = null;
  let _hostScope = null; // 域名隔离:非 null 时 allEvents/loadSessions 只返回该 host 数据,切域名不串
  function setHostScope(host) { _hostScope = host || null; }
  function getHostScope() { return _hostScope; }
  async function allEvents() {
    let evs = _eventsCache;
    if (!evs) { try { evs = (await db()?.getAll('events')) || []; _eventsCache = evs; } catch { evs = []; } }
    return _hostScope ? evs.filter((e) => e.host === _hostScope) : evs;
  }
  function putEvent(ev) {
    const dbApi = db();
    const p = (dbApi && dbApi.put) ? dbApi.put('events', ev) : Promise.resolve();
    if (_eventsCache) {
      const i = _eventsCache.findIndex((x) => x.eventId === ev.eventId);
      if (i >= 0) _eventsCache[i] = ev; else _eventsCache.push(ev);
    }
    return p;
  }
  function clearEventsCache() { _eventsCache = null; }
  // 保留窗口清理（默认 7 天 / 5000 条）：prune IndexedDB 后用 kept 快照重建内存缓存，避免 prune 后缓存脏。
  async function pruneOldEvents(maxAgeMs, maxCount) {
    const dbApi = db();
    if (!dbApi || !dbApi.pruneEvents) return { dropped: 0 };
    try {
      const { kept, dropped } = await dbApi.pruneEvents(maxAgeMs != null ? maxAgeMs : 7 * 86400e3, maxCount != null ? maxCount : 5000);
      _eventsCache = kept.slice();
      return { dropped };
    } catch { return { dropped: 0 }; }
  }
  // 归因置信度反馈(👍/👎):写入 attributions store,攒数据供离线校准规则置信度(Platt/isotonic)。
  // 当前规则 confidence 是作者拍的分段公式,未经数据校准;反馈闭环是校准的数据来源。
  async function recordFeedback(eventId, signal, kind, feedback) {
    const dbApi = db();
    if (!dbApi || !dbApi.put || !eventId) return;
    try { await dbApi.put('attributions', { eventId, signal, kind, feedback, timestamp: Date.now() }); } catch {}
  }
  async function getFeedback(eventId) {
    const dbApi = db();
    if (!dbApi || !eventId) return null;
    try { const all = await dbApi.getAll('attributions'); return all.find((a) => a.eventId === eventId) || null; } catch { return null; }
  }
  async function countFeedback() {
    const dbApi = db();
    if (!dbApi) return { up: 0, down: 0, total: 0 };
    try {
      const all = await dbApi.getAll('attributions');
      return { up: all.filter((a) => a.feedback === 'up').length, down: all.filter((a) => a.feedback === 'down').length, total: all.length };
    } catch { return { up: 0, down: 0, total: 0 }; }
  }
  // heals 审计日志:apply/rollback 写 heals store,可追溯(每条用 token@action@ts 唯一 eventId,不互相覆盖)。
  // 行业规范:自愈动作必须可审计(谁/何时/对哪个模板/做了什么)。
  async function recordHeal(token, templateId, action, summary) {
    const dbApi = db();
    if (!dbApi || !dbApi.put || !token) return;
    const ts = Date.now();
    try { await dbApi.put('heals', { eventId: token + '@' + action + '@' + ts, token, templateId, action, summary, timestamp: ts }); } catch {}
  }
  async function getHeals() {
    const dbApi = db();
    if (!dbApi) return [];
    try { return (await dbApi.getAll('heals')).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)); } catch { return []; }
  }
  // 自愈验证结果(根因的可证伪实验):patch 后因果显著改善→根因 verified;显著变差→falsified;未显著→weak。
  // 存 attributions store(与 feedback 同 eventId,可并存)。自愈 ⟷ 根因耦合的核心:验证结果反向写回根因置信度。
  async function recordVerification(eventId, verification) {
    const dbApi = db();
    if (!dbApi || !eventId) return;
    try {
      const all = await dbApi.getAll('attributions');
      const existing = all.find((a) => a.eventId === eventId) || { eventId };
      await dbApi.put('attributions', Object.assign({}, existing, { verification, verifiedAt: Date.now() }));
    } catch {}
  }
  async function getVerification(eventId) {
    const dbApi = db();
    if (!dbApi || !eventId) return null;
    try { const a = (await dbApi.getAll('attributions')).find((x) => x.eventId === eventId); return (a && a.verification) || null; } catch { return null; }
  }
  // AI 深诊结果持久化(③b②):ai-rca verdict 存 attributions store(与 verification 同 eventId 可并存)。
  // 切 tab/重渲染后根因视图仍能回显 AI 根因 + grounding,不必重跑 LLM。
  async function recordAiRca(eventId, verdict) {
    const dbApi = db();
    if (!dbApi || !dbApi.put || !eventId || !verdict) return;
    try {
      const all = await dbApi.getAll('attributions');
      const existing = all.find((a) => a.eventId === eventId) || { eventId };
      await dbApi.put('attributions', Object.assign({}, existing, { aiRca: verdict, aiRcaAt: Date.now() }));
    } catch {}
  }
  async function getAiRca(eventId) {
    const dbApi = db();
    if (!dbApi || !eventId) return null;
    try { const a = (await dbApi.getAll('attributions')).find((x) => x.eventId === eventId); return (a && a.aiRca) || null; } catch { return null; }
  }
  // 重放现场 session(P2 独立链路):录制的交互序列 + 现场快照点(堆/DOM),可回放/分享重现。
  async function saveSession(session) {
    const dbApi = db();
    if (!dbApi || !dbApi.put || !session) return null;
    session.eventId = session.eventId || ('session-' + (session.startTime || Date.now()) + '-' + Math.random().toString(36).slice(2, 6));
    session.type = 'replay'; session.savedAt = Date.now();
    try { await dbApi.put('replays', session); return session.eventId; } catch { return null; }
  }
  async function loadSessions() {
    const dbApi = db();
    if (!dbApi) return [];
    try {
      const all = await dbApi.getAll('replays');
      const scoped = _hostScope ? all.filter((s) => s.host === _hostScope) : all;
      return scoped.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    } catch { return []; }
  }
  // P3 跨信号因果链:聚焦当前根因信号,从全事件构建关联 trace(内存→GC→INP 等)。
  async function buildCrossSignalChain(focusSignal, focusEvent) {
    const C = globalThis.__correlate;
    if (!C) return null;
    const events = await allEvents();
    const r = C.buildChains(events, { focusSignal });
    return (r && r.chains && r.chains.length) ? { chains: r.chains, anomalyCount: r.anomalies.length, edgeCount: r.edges.length } : null;
  }
  // P4 分享重现:收集现场(根因+事件+session)供编码;导入现场还原。
  async function buildScene(rca, opts) {
    const events = await allEvents();
    const sessions = await loadSessions();
    return {
      host: (events[0] && events[0].host) || '', route: (events[0] && events[0].route) || '',
      rootCause: rca || null,
      events: events.slice(-200),
      sessions: sessions.slice(0, 5),
      heapSnapshot: (opts && opts.heapSnapshot) || null,
      config: (opts && opts.config) || null,
    };
  }
  async function importScene(scene) {
    let ec = 0, sc = 0;
    for (const e of (scene && scene.events || [])) {
      try { await putEvent(Object.assign({}, e, { eventId: e.eventId || ('imported-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)), imported: true })); ec++; } catch {}
    }
    for (const s of (scene && scene.sessions || [])) {
      try { await saveSession(Object.assign({}, s, { eventId: 'imported-' + (s.startTime || Date.now()) + '-' + Math.random().toString(36).slice(2, 6) })); sc++; } catch {}
    }
    clearEventsCache(); // 缓存失效,下次 allEvents 重读导入数据
    return { events: ec, sessions: sc };
  }

  const isInp = (e) => e && e.type !== 'error' && (e.subType === 'inp' || (e.value != null && e.inputDelay != null));
  const isErr = (e) => e && e.type === 'error';

  function pct(arr, p) {
    if (!arr || !arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
  }
  function rating(v) { return v <= 200 ? 'good' : v <= 500 ? 'warn' : 'bad'; }

  // 时间窗
  const now = () => Date.now();
  const within = (e, ms) => (e.timestamp || 0) >= now() - ms;

  // ================= 信号描述符（INP / LCP / FCP / CLS 共用实时面板） =================
  const SIGNALS = {
    inp: {
      label: 'INP', brand: 'INP COPILOT', unit: 'ms', decimals: 0, scale: 1,
      thr: { good: 200, poor: 500 }, budget: 500,
      heroLabel: '当前 INP · 最近 60s',
      verdict: (r) => r === 'good' ? 'GOOD · ≤200ms' : r === 'warn' ? 'NEEDS IMPROVEMENT' : 'POOR · >500ms',
      bdTitle: 'INP 三段构成 · 归因自 Event Timing API',
      segs: (e) => [
        { label: 'Input Delay 输入延迟', value: e.inputDelay || 0, color: 'info' },
        { label: 'Processing 事件处理', value: e.processingDuration || 0, color: 'bad' },
        { label: 'Presentation 渲染呈现', value: e.presentationDelay || 0, color: 'warn' },
      ],
      tgtTitle: '归因目标 · INTERACTION TARGET', tgtEntry: 'event: pointerdown',
      tgtSelector: (e) => e.interactionTarget || '', tgtComponent: (e) => proxyAttr(e.interactionTarget),
      kv: (e) => [['超阈值样本 / 60s', `${e.hits || 0}% · ${e.sampleCount || 0} 样本`, 'fg'], ['最长任务 Long Task', `${(e.longTask || 0).toFixed(0)}ms`, (e.longTask || 0) > 50 ? 'bad' : 'fg']],
      streamTitle: '交互流 · LIVE INTERACTION STREAM', streamMeta: '自动采样 100%',
      rule: (e) => ruleText('inp', 'R-03', e), ruleThreshold: 500,
      desc: '事件已写入 IndexedDB（状态：DETECTED），归因引擎正在采集 Long Task 与调用栈证据。',
    },
    lcp: {
      label: 'LCP', brand: 'LCP COPILOT', unit: 's', decimals: 1, scale: 0.001,
      thr: { good: 2500, poor: 4000 }, budget: 2500,
      heroLabel: '当前 LCP · 最近 60s',
      verdict: (r) => r === 'good' ? 'GOOD · ≤2.5s' : r === 'warn' ? 'NEEDS IMPROVEMENT' : 'POOR · >4.0s',
      bdTitle: 'LCP 时段构成 · TTFB·资源·渲染阻塞',
      segs: (e) => lcpSegs(e),
      tgtTitle: '归因目标 · LCP ELEMENT', tgtEntry: 'entry: largest-contentful-paint',
      tgtSelector: (e) => e.element || (e.url ? `resource · ${shortFile(e.url)}` : ''), tgtComponent: (e) => e.url ? `<LCP 资源> · ${shortFile(e.url)}` : '<LCP 元素>',
      kv: (e) => [['超阈值样本 / 60s', `${e.hits || 0}% · ${e.sampleCount || 0} 样本`, 'fg'], ['最慢资源 Slowest Resource', e.resLoad != null ? `${fmtSig('lcp', e.resLoad)}${e.url ? ' · ' + shortFile(e.url) : ''}` : '—', (e.resLoad || 0) > 1500 ? 'bad' : 'fg']],
      streamTitle: '页面加载流 · LIVE LOAD STREAM', streamMeta: '自动采样 100%',
      rule: (e) => ruleText('lcp', 'R-01', e), ruleThreshold: 4000,
      desc: '事件已写入 IndexedDB（状态：DETECTED），归因引擎正在采集资源时序与渲染阻塞证据。',
    },
    fcp: {
      label: 'FCP', brand: 'FCP COPILOT', unit: 's', decimals: 1, scale: 0.001,
      thr: { good: 1800, poor: 3000 }, budget: 1800,
      heroLabel: '当前 FCP · 最近 60s',
      verdict: (r) => r === 'good' ? 'GOOD · ≤1.8s' : r === 'warn' ? 'NEEDS IMPROVEMENT' : 'POOR · >3.0s',
      bdTitle: 'FCP 时段构成 · TTFB·渲染阻塞·解析',
      segs: (e) => fcpSegs(e),
      tgtTitle: '归因目标 · 首屏渲染阻塞源', tgtEntry: 'entry: first-contentful-paint',
      tgtSelector: () => '首屏渲染阻塞源(FCP 无单一元素锚点)', tgtComponent: () => '首屏 paint(无元素锚点)',
      kv: (e) => [['超阈值样本 / 60s', `${e.hits || 0}% · ${e.sampleCount || 0} 样本`, 'fg'], ['首字节 TTFB', e.ttfb != null ? `${fmtSig('fcp', e.ttfb)}${e.ttfb > 800 ? ' · 超阈值' : ''}` : '—', (e.ttfb || 0) > 800 ? 'bad' : 'fg']],
      streamTitle: '页面加载流 · LIVE LOAD STREAM', streamMeta: '自动采样 100%',
      rule: (e) => ruleText('fcp', 'R-04', e), ruleThreshold: 3000,
      desc: '事件已写入 IndexedDB（状态：DETECTED），归因引擎正在采集首字节时序与渲染阻塞资源证据。',
    },
    cls: {
      label: 'CLS', brand: 'CLS COPILOT', unit: '', decimals: 2, scale: 1,
      thr: { good: 0.10, poor: 0.25 }, budget: 0.15,
      heroLabel: '当前 CLS · 最近 60s',
      verdict: (r) => r === 'good' ? 'GOOD · ≤0.10' : r === 'warn' ? 'NEEDS IMPROVEMENT' : 'POOR · >0.25',
      bdTitle: 'CLS 位移来源 · 归因自 Layout Shift API',
      segs: (e) => clsSegs(e),
      tgtTitle: '归因目标 · CLS ELEMENT', tgtEntry: 'entry: layout-shift',
      tgtSelector: (e) => e.element || '(未捕获位移元素)', tgtComponent: (e) => e.element ? `位移元素 · ${e.element}` : '位移元素',
      kv: (e) => [['超阈值样本 / 60s', `${e.hits || 0}% · ${e.sampleCount || 0} 样本`, 'fg'], ['最大单次位移 Largest Shift', `${(e.largest || 0).toFixed(2)}${e.element ? ' · ' + e.element : ''}`, 'bad']],
      streamTitle: '位移流 · LIVE SHIFT STREAM', streamMeta: '自动采样 100%',
      rule: (e) => ruleText('cls', 'R-02', e), ruleThreshold: 0.2,
      desc: '事件已写入 IndexedDB（状态：DETECTED），归因引擎正在采集位移指纹与 sources[] 证据。',
    },
    memory: {
      label: '内存', brand: 'MEMORY COPILOT', unit: 'MB', decimals: 1, scale: 1 / 1048576,
      thr: { good: 0.5, poor: 0.8 }, budget: 0.7, // 注:memory rating 用 used/limit 比例(loadMemory 按 ratio 算),非 value 绝对值
      heroLabel: '当前堆使用 · JS Heap',
      verdict: (r) => r === 'good' ? 'GOOD · <50% limit' : r === 'warn' ? 'NEEDS IMPROVEMENT' : 'POOR · >80% limit',
      bdTitle: '堆占用构成 · used / free of limit',
      segs: (e) => memorySegs(e),
      tgtTitle: '归因目标 · 泄漏嫌疑类型', tgtEntry: 'sample: performance.memory @ 5s',
      tgtSelector: (e) => e.leakSuspect || '堆使用趋势', tgtComponent: (e) => e.domCount != null ? 'DOM ' + e.domCount : '—',
      kv: (e) => [['堆增长趋势', (e.heapSlopeMB || 0) > 0.05 ? '+' + (e.heapSlopeMB || 0).toFixed(1) + ' MB/min' : '平稳/回落', (e.heapSlopeMB || 0) > 0.5 ? 'bad' : 'fg'], ['DOM 节点 / 斜率', (e.domCount || 0) + ' · ' + ((e.domSlope || 0) > 0 ? '+' : '') + (e.domSlope || 0).toFixed(0) + '/min', (e.domCount || 0) > 5000 ? 'warn' : 'fg']],
      streamTitle: '堆采样流 · LIVE HEAP STREAM', streamMeta: '5s 采样',
      rule: (e) => ruleText('memory', 'R-05', e), ruleThreshold: 0.8,
      desc: '堆采样已写入 IndexedDB,泄漏检测引擎正在分析增长趋势 / 路由回落 / DOM 膨胀。',
    },
    fps: {
      label: 'FPS', brand: 'FPS COPILOT', unit: 'fps', decimals: 0, scale: 1,
      thr: { good: 50, poor: 30 }, budget: 60, // 注:fps rating 反向(高=good),rateSig 特殊处理
      heroLabel: '当前 FPS · 每秒帧数',
      verdict: (r) => r === 'good' ? 'GOOD · ≥50fps' : r === 'warn' ? 'NEEDS IMPROVEMENT' : 'POOR · <30fps',
      bdTitle: 'FPS · 渲染帧率',
      segs: (e) => [{ label: '当前 FPS', value: e.value || 0, color: (e.value || 0) >= 50 ? 'info' : (e.value || 0) >= 30 ? 'warn' : 'bad' }],
      tgtTitle: '归因目标 · 掉帧嫌疑', tgtEntry: 'rAF frame timing',
      tgtSelector: (e) => (e.value || 0) < 30 ? '严重掉帧(主线程/渲染阻塞)' : (e.value || 0) < 50 ? '偶发掉帧' : '流畅', tgtComponent: () => 'rAF 帧间隔',
      kv: (e) => [['当前 FPS', String(e.value || 0), (e.value || 0) < 30 ? 'bad' : (e.value || 0) < 50 ? 'warn' : 'good'], ['目标', '60 fps', 'fg']],
      streamTitle: 'FPS 流 · LIVE FPS STREAM', streamMeta: '1s 采样',
      rule: (e) => ruleText('fps', 'R-06', e), ruleThreshold: 30,
      desc: 'FPS 采样已写入 IndexedDB,掉帧分析引擎正在排查主线程长任务 / 渲染阻塞。',
    },
  };
  // ---- 真实拆解 / 规则 helper（字段缺失即降级，绝不伪造占比）----
  // 官方四段(web.dev/optimize-lcp):TTFB / Resource Load Delay / Resource Load Time / Element Render Delay。
  // 需 resStart/resEnd(新版采集);旧数据只有 resLoad → 降级三段(Delay/Time 未细分)。
  function lcpSegs(e) {
    const v = e.value || 0; const ttfb = e.ttfb;
    if (e.resStart != null && e.resEnd != null) {
      const loadDelay = Math.max(0, (e.resStart || 0) - (ttfb || 0));
      const loadTime = Math.max(0, (e.resEnd || 0) - (e.resStart || 0));
      const renderDelay = Math.max(0, v - (e.resEnd || 0));
      return [
        { label: 'TTFB 首字节', value: ttfb || 0, color: 'info' },
        { label: '资源加载延迟·可发现性', value: loadDelay, color: 'accent' },
        { label: '资源加载耗时·传输', value: loadTime, color: 'bad' },
        { label: '元素渲染延迟', value: renderDelay, color: 'warn' },
      ];
    }
    const res = e.resLoad;
    if (ttfb == null && res == null) return [{ label: 'LCP 总值(分段时序未采集)', value: v, color: 'fg-3' }];
    return [
      { label: 'TTFB 首字节', value: ttfb || 0, color: 'info' },
      { label: '资源加载(延迟/耗时未细分)', value: res || 0, color: 'bad' },
      { label: '其余(渲染/阻塞)', value: Math.max(0, v - (ttfb || 0) - (res || 0)), color: 'warn' },
    ];
  }
  function fcpSegs(e) {
    const v = e.value || 0; const ttfb = e.ttfb, parse = e.domParse;
    if (ttfb == null && parse == null) return [{ label: 'FCP 总值(分段时序未采集)', value: v, color: 'fg-3' }];
    return [
      { label: 'TTFB 首字节', value: ttfb || 0, color: 'info' },
      { label: 'HTML 解析执行', value: parse || 0, color: 'warn' },
      { label: '其余(渲染阻塞等)', value: Math.max(0, v - (ttfb || 0) - (parse || 0)), color: 'bad' },
    ];
  }
  function clsSegs(e) {
    const v = e.value || 0; const raw = e.sourceBreakdown || {};
    const sum = (raw.media || 0) + (raw.font || 0) + (raw.dom || 0);
    if (sum <= 0) return [{ label: 'CLS 总值(来源未细分)', value: v, color: 'fg-3' }];
    return [
      { label: '图片/嵌入', value: raw.media || 0, color: 'bad' },
      { label: 'Web Font FOUT', value: raw.font || 0, color: 'warn' },
      { label: '动态 DOM', value: raw.dom || 0, color: 'accent' },
    ];
  }
  // memory 段位:已用堆 vs 剩余 limit(占 limit 的构成,直观反映逼近上限程度)
  function memorySegs(e) {
    const used = e.value != null ? e.value : (e.used || 0);
    const limit = e.limit || 0;
    if (!limit) return [{ label: '堆使用(无 limit 数据)', value: used, color: 'fg-3' }];
    return [
      { label: '已用堆 used', value: used, color: 'bad' },
      { label: '剩余 limit', value: Math.max(0, limit - used), color: 'info' },
    ];
  }
  // 最小二乘线性回归斜率(ys 对索引);用于堆/DOM 节点趋势判定。
  function linearSlope(ys) {
    const n = ys.length;
    if (n < 2) return 0;
    const mx = (n - 1) / 2;
    const my = ys.reduce((s, y) => s + (y || 0), 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * ((ys[i] || 0) - my); den += (i - mx) ** 2; }
    return den === 0 ? 0 : num / den;
  }
  // 连续窗口判定:近 N 个 1 分钟窗里有多少窗出现超阈值样本 → 真实"连续 N 窗口"语义
  function checkRule(signal, mine, cfg, thresholdOverride) {
    const bins = 3, binMs = 60000, nowMs = now();
    const threshold = thresholdOverride != null ? thresholdOverride : cfg.ruleThreshold;
    const counts = new Array(bins).fill(0);
    for (const e of mine) {
      if ((e.value || 0) > threshold) {
        const ageBin = Math.floor((nowMs - (e.timestamp || 0)) / binMs);
        if (ageBin >= 0 && ageBin < bins) counts[ageBin]++;
      }
    }
    const consecutive = counts.filter((c) => c > 0).length;
    return { triggered: consecutive >= bins, consecutive, bins, threshold };
  }
  function ruleText(signal, code, e) {
    const cfg = SIGNALS[signal]; const rs = e && e.__rule; const v = fmtSig(signal, e.value);
    const thr = rs ? rs.threshold : cfg.ruleThreshold;
    if (rs && rs.triggered) return `已触发 ${code}：连续 ${rs.bins} 窗口 ${cfg.label} 超阈值(当前 ${v})`;
    if ((e.value || 0) > thr) return `观察中:当前 ${cfg.label} ${v} 超阈值(近 ${rs ? rs.consecutive : 0}/${rs ? rs.bins : 3} 窗)`;
    return '';
  }

  function fmtSig(signal, value) {
    const c = SIGNALS[signal]; if (!c || value == null) return '—';
    return (value * c.scale).toFixed(c.decimals) + c.unit;
  }
  function rateSig(signal, value) {
    const c = SIGNALS[signal]; if (!c) return 'good';
    if (signal === 'fps') return value >= c.thr.good ? 'good' : value >= c.thr.poor ? 'warn' : 'bad'; // fps 反向(高=good)
    return value <= c.thr.good ? 'good' : value <= c.thr.poor ? 'warn' : 'bad';
  }

  // ================= 通用 vital 实时（INP/LCP/FCP/CLS） =================
  async function loadVital(signal, live, opts) {
    const cfg = SIGNALS[signal];
    const events = await allEvents();
    const mine = events.filter((e) => signal === 'inp' ? isInp(e) : (e.type === 'vital' && e.subType === signal)).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const recent = mine.filter((e) => within(e, 60e3));
    const vals = (recent.length ? recent : mine).map((e) => e.value || 0).filter((v) => v > 0);
    const older = mine.filter((e) => !within(e, 5 * 60e3)).map((e) => e.value || 0).filter((v) => v > 0);
    const baseline = older.length ? pct(older, 0.5) : (vals.length ? pct(vals, 0.5) : 0);

    const cur = currentFor(signal, live, mine);
    const sampleCount = vals.length;
    const overThresholdPct = vals.length ? (vals.filter((v) => v > cfg.thr.good).length / vals.length * 100) : 0;
    // INP 告警阈值可由设置面板覆盖（settings.alertThresholdMs）；其余 signal 用描述符 ruleThreshold
    const alertThreshold = (signal === 'inp' && opts && opts.alertThreshold != null) ? opts.alertThreshold : null;
    if (cur) cur.__rule = checkRule(signal, mine, cfg, alertThreshold);

    const stream = streamFor(signal, live, mine, cfg);
    const target = cur ? { selector: cfg.tgtSelector(cur), component: cfg.tgtComponent(cur), hits: Math.round(overThresholdPct), kv: cfg.kv(Object.assign({}, cur, { hits: Math.round(overThresholdPct), sampleCount })), longTask: cur.longTask || 0 } : null;
    return { signal, cfg, cur, baseline, p75: pct(vals, 0.75), p50: pct(vals, 0.5), sampleCount, overThresholdPct, stream, target, hasData: !!cur };
  }
  // memory 是趋势信号(非单次事件):合并 live 趋势数组 + 落盘事件,算堆/DOM 斜率 + 路由后回落。
  async function loadMemory(live, opts) {
    const events = await allEvents();
    const memEv = events.filter((e) => e.type === 'vital' && e.subType === 'memory').sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const liveSamples = (live && live.vitals && live.vitals.memory) || [];
    const seen = new Set();
    const samples = [];
    const add = (s) => { const k = s.t + '-' + s.used; if (!seen.has(k)) { seen.add(k); samples.push(s); } };
    liveSamples.forEach(add);
    memEv.forEach((e) => add({ t: e.timestamp, used: e.value, total: e.total, limit: e.limit, domCount: e.domCount, nav: e.nav }));
    samples.sort((a, b) => (a.t || 0) - (b.t || 0));
    const recent = samples.slice(-40);
    const used = recent.map((s) => s.used || 0).filter((v) => v > 0);
    const domCounts = recent.map((s) => s.domCount || 0);
    const latest = recent[recent.length - 1] || {};
    const limit = latest.limit || 0;
    const ratio = limit ? (latest.used || 0) / limit : 0;
    const heapSlopeMB = linearSlope(recent.map((s) => s.used || 0)) * 12 / 1048576; // bytes/sample × 12 sample/min
    const domSlope = linearSlope(domCounts) * 12; // nodes/min
    // 路由后回落检测:最后一个 nav 标记,nav 前窗 max vs nav 后窗 min
    let noRelease = false;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].nav) {
        const before = recent.slice(0, i).map((s) => s.used || 0).filter((v) => v > 0);
        const after = recent.slice(i).map((s) => s.used || 0).filter((v) => v > 0);
        if (before.length >= 2 && after.length >= 2) noRelease = Math.min.apply(null, after) >= Math.max.apply(null, before) * 0.85;
        break;
      }
    }
    let leakSuspect = '堆平稳';
    if (ratio > 0.8) leakSuspect = '逼近 limit(紧急)';
    else if (heapSlopeMB > 0.5) leakSuspect = '堆单调增长 +' + heapSlopeMB.toFixed(1) + 'MB/min';
    else if (noRelease) leakSuspect = '路由切换后堆未回落';
    else if (domSlope > 50) leakSuspect = 'DOM 节点膨胀 +' + domSlope.toFixed(0) + '/min';
    const cfg = SIGNALS.memory;
    // CDP 精确计数(opts.metrics,attach 后):Nodes 含 detached DOM、JSEventListeners 监听器总数、heapUsed 实时堆
    // —— 这些 performance.memory 拿不到,是 advisory 模式无法触及的精确泄漏信号。
    const metrics = opts && opts.metrics;
    const cur = {
      value: (metrics && metrics.heapUsed) || latest.used || 0,
      used: (metrics && metrics.heapUsed) || latest.used || 0,
      total: (metrics && metrics.heapTotal) || latest.total || 0,
      limit,
      domCount: (metrics && metrics.nodes != null) ? metrics.nodes : (latest.domCount || 0),
      listeners: metrics ? metrics.listeners : undefined,
      ratio: (metrics && metrics.heapUsed && limit) ? metrics.heapUsed / limit : ratio,
      heapSlopeMB, domSlope, leakSuspect, noRelease,
    };
    return {
      signal: 'memory', cfg, cur, samples: recent,
      p75: pct(used, 0.75), p50: pct(used, 0.5), sampleCount: used.length,
      overThresholdPct: used.length ? (used.filter((v) => limit && v / limit > cfg.thr.good).length / used.length * 100) : 0,
      hasData: used.length >= 2, baseline: 0, heapSlopeMB, domSlope, ratio, leakSuspect, noRelease,
      stream: recent.slice(-6).map((s) => ({ time: s.t, type: s.nav ? 'nav' : 'heap', value: s.used, state: limit && s.used / limit > cfg.thr.poor ? '已升级为事件' : limit && s.used / limit > cfg.thr.good ? '观察中' : '正常' })),
      target: { selector: leakSuspect, component: cur.domCount != null ? 'DOM ' + cur.domCount : '', hits: Math.round(ratio * 100), kv: cfg.kv(cur), longTask: 0 },
    };
  }
  function currentFor(signal, live, mine) {
    const lv = live && live.vitals;
    const latest = mine[0];
    if (signal === 'inp') return live?.inp ? Object.assign({}, live.inp, { longTask: (live.loafScripts || []).reduce((m, s) => Math.max(m, s.duration || 0), 0) }) : (latest ? Object.assign({}, latest) : null);
    if (signal === 'lcp') return Object.assign({}, latest || {}, { value: (lv && lv.lcp != null) ? lv.lcp : (latest && latest.value), element: (lv && lv.lcpElement) || (latest && latest.element), url: (lv && lv.lcpUrl) || (latest && latest.url), ttfb: (lv && lv.ttfb) || (latest && latest.ttfb), resLoad: (lv && lv.resLoad != null) ? lv.resLoad : (latest && latest.resLoad) });
    if (signal === 'fcp') return Object.assign({}, latest || {}, { value: (lv && lv.fcp != null) ? lv.fcp : (latest && latest.value), ttfb: (lv && lv.ttfb) || (latest && latest.ttfb), domParse: (lv && lv.domParse != null) ? lv.domParse : (latest && latest.domParse) });
    if (signal === 'cls') {
      const shifts = (lv && lv.shifts) || (latest && latest.shifts) || [];
      const sb = clsBreakdown(shifts);
      return Object.assign({}, latest || {}, { value: (lv && lv.cls != null) ? lv.cls : (latest && latest.value), element: (shifts[0] && shifts[0].source) || (latest && latest.element), sourceBreakdown: sb, largest: (shifts.reduce((m, s) => Math.max(m, s.value), 0)) || (latest && latest.largest) || 0 });
    }
    if (signal === 'fps') {
      const arr = (lv && lv.fps) || (latest ? [latest] : []);
      const lastFps = arr.length ? arr[arr.length - 1].fps : (latest && latest.value);
      return Object.assign({}, latest || {}, { value: lastFps });
    }
    return latest || null;
  }
  function clsBreakdown(shifts) {
    const b = { media: 0, font: 0, dom: 0 };
    for (const s of shifts || []) {
      const k = (s.source || s.kind || '').toLowerCase();
      if (/img|image|embed|iframe|video/.test(k)) b.media += s.value;
      else if (/font|link|style/.test(k)) b.font += s.value;
      else b.dom += s.value;
    }
    return b;
  }
  function streamFor(signal, live, mine, cfg) {
    if (signal === 'inp') {
      const src = (live && live.interactions && live.interactions.length) ? live.interactions : mine.slice(0, 6).map((e) => ({ time: e.timestamp, type: e.interactionTarget || 'interaction', value: e.value }));
      return src.map((s) => ({ time: s.time, type: s.type, value: s.value, state: stateFor(signal, s.value, cfg) }));
    }
    if (signal === 'cls') {
      const shifts = (live && live.vitals && live.vitals.shifts) || (mine[0] && mine[0].shifts) || [];
      return shifts.slice(0, 6).map((s) => ({ time: s.time, type: s.source || s.kind || 'shift', value: s.value, state: stateFor(signal, s.value, cfg) }));
    }
    // lcp / fcp：最近加载事件（按 nav 类型）
    return mine.slice(0, 6).map((e) => ({ time: e.timestamp, type: e.navType || 'navigation', value: e.value, state: stateFor(signal, e.value, cfg) }));
  }
  function stateFor(signal, value, cfg) {
    const r = rateSig(signal, value);
    if (signal === 'cls') return r === 'bad' ? '已升级为事件' : r === 'warn' ? '观察中' : '正常';
    return r === 'bad' ? '已升级为事件' : r === 'warn' ? '观察中' : '正常';
  }


  async function loadRealtime(live) {
    const events = await allEvents();
    const inpEv = events.filter(isInp).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const recent60 = inpEv.filter((e) => within(e, 60e3));
    const values60 = recent60.map((e) => e.value || 0).filter((v) => v > 0);
    const valuesAll = inpEv.map((e) => e.value || 0).filter((v) => v > 0);
    // 基线：5 分钟前的 p50（本地代理）
    const older = inpEv.filter((e) => !within(e, 5 * 60e3)).map((e) => e.value || 0).filter((v) => v > 0);
    const baseline = older.length ? pct(older, 0.5) : (valuesAll.length ? pct(valuesAll, 0.5) : 0);
    const cur = live?.inp || (inpEv[0] ? { value: inpEv[0].value, inputDelay: inpEv[0].inputDelay, processingDuration: inpEv[0].processingDuration, presentationDelay: inpEv[0].presentationDelay, interactionTarget: inpEv[0].interactionTarget } : null);
    const sampleCount = values60.length || valuesAll.length;
    const overThresholdPct = values60.length ? (values60.filter((v) => v > 200).length / values60.length * 100) : 0;

    // 交互流：优先 live.interactions，否则用最近 inp 事件
    const streamSrc = (live && live.interactions && live.interactions.length) ? live.interactions : inpEv.slice(0, 6).map((e) => ({
      time: e.timestamp, type: e.interactionTarget || 'interaction', value: e.value, state: e.value > 500 ? '已升级为事件' : e.value > 200 ? '观察中' : '正常',
    }));

    // 归因目标（本地：interactionTarget；组件归属本地无法得 → 代理）
    const tgt = cur?.interactionTarget || inpEv[0]?.interactionTarget;
    const longTask = inpEv.reduce((m, e) => Math.max(m, (e.loafScripts || []).reduce((s, x) => Math.max(s, x.duration || 0), 0)), 0);

    return {
      cur, baseline,
      p75: pct(values60.length ? values60 : valuesAll, 0.75),
      p50: pct(values60.length ? values60 : valuesAll, 0.5),
      sampleCount, overThresholdPct,
      stream: streamSrc,
      target: tgt ? { selector: tgt, component: proxyAttr(tgt), hits: recent60.length, longTask } : null,
      hasData: !!cur,
    };
  }

  // ================= 错误总览 =================
  function deriveType(e) {
    const m = ((e.message || '') + ' ' + (e.sourceURL || '')).toLowerCase();
    if (/typeerror|cannot read|of undefined|of null|is not a function/.test(m)) return { type: 'TypeError', color: 'bad' };
    if (/referenceerror|is not defined/.test(m)) return { type: 'Reference', color: 'warn' };
    if (e.subType === 'promise') return { type: 'Promise', color: 'accent' };
    if (/chunk|chunkload/.test(m)) return { type: 'ChunkLoad', color: 'fg-3' };
    if (e.subType === 'resource') return { type: 'Network', color: 'info' };
    return { type: 'Other', color: 'fg-3' };
  }
  function severityOf(e) {
    if (e.subType === 'js' && e.stack) return 'p1';
    if (e.subType === 'js' || e.subType === 'promise') return 'p2';
    return 'p3';
  }
  // 权威指纹:委托 noise-gate(subType + 归一化 message + 栈顶 generated 帧;INP = target+主导段)。
  // 降级保兼容(noise-gate 未加载时回退旧逻辑)——源端/读端共享同一指纹,分组才一致。
  function fingerprint(e) {
    const NG = globalThis.__noiseGate;
    return (NG && NG.fingerprint) ? NG.fingerprint(e) : ((e.subType || 'x') + '::' + ((e.message || '').slice(0, 48)));
  }
  // INP 分组(同 interactionTarget+主导段 → ×N):委托 noise-gate.groupInp,输出与 groupErrors 同形。
  function groupInp(events) { const NG = globalThis.__noiseGate; return NG && NG.groupInp ? NG.groupInp(events) : []; }

  function groupErrors(errs) {
    const map = new Map();
    for (const e of errs) {
      const fp = fingerprint(e);
      if (!map.has(fp)) map.set(fp, { fp, sample: e, count: 0, first: e.timestamp, last: e.timestamp, type: deriveType(e), severity: severityOf(e), messages: new Set() });
      const g = map.get(fp);
      g.count++; g.messages.add((e.message || '').slice(0, 60));
      g.first = Math.min(g.first, e.timestamp); g.last = Math.max(g.last, e.timestamp);
      if (severityRank(severityOf(e)) < severityRank(g.severity)) g.severity = severityOf(e);
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }
  const severityRank = (s) => ({ p1: 0, p2: 1, p3: 2 }[s] ?? 3);

  async function loadErrorOverview() {
    const events = await allEvents();
    const errs = events.filter(isErr).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const win5 = errs.filter((e) => within(e, 5 * 60e3));
    const win1 = errs.filter((e) => within(e, 60e3));
    const total = events.length || 1;
    const errorRate = win1.length / Math.max(1, events.filter((e) => within(e, 60e3)).length) * 100;
    // 1h 前的 errorRate 做对比
    const prevWin = errs.filter((e) => within(e, 60e3) === false && (e.timestamp || 0) >= now() - 60 * 60e3);
    const prevRate = prevWin.length / Math.max(1, events.filter((e) => (e.timestamp || 0) >= now() - 60 * 60e3).length) * 100;
    const rateDelta = prevRate ? errorRate / prevRate : 0;

    const uncaptured = win5.filter((e) => !e.stack && e.subType !== 'resource');
    const sourcemapPct = win5.length ? (win5.filter((e) => e.filename || e.stack).length / win5.length * 100) : 0;
    // MTTR 本地代理：top 组 last-first 间隔均值（标注口径）
    const groups = groupErrors(win5);
    const mttrProxy = groups.length ? (groups.reduce((s, g) => s + Math.max(0, g.last - g.first), 0) / groups.length / 60000) : 0;

    // 类型分布
    const typeCount = {};
    for (const e of win5) { const t = deriveType(e); typeCount[t.type] = (typeCount[t.type] || 0) + 1; }
    const breakdown = Object.entries(typeCount).map(([type, count]) => ({ type, count, pct: count / Math.max(1, win5.length) * 100, color: deriveType({ message: type, subType: type === 'Promise' ? 'promise' : type === 'Network' ? 'resource' : 'js' }).color })).sort((a, b) => b.count - a.count);

    // 严重级
    const sev = { p1: 0, p2: 0, p3: 0 };
    for (const e of win5) sev[severityOf(e)]++;
    // 影响维度：route / release / device(本地无 → UA 代理)
    const routeGroups = topGroups(win5, (e) => e.route || '(unknown)');
    const verGroups = topGroups(win5, (e) => e.release || '(unknown)');
    const devGroups = topGroups(win5, (e) => (e.ua && parseUA(e.ua)) || 'This Device');

    // 实时流（分组，按 last 排序）
    const stream = groups.slice(0, 8).map((g) => ({
      id: g.sample.eventId || g.fp.slice(0, 8), time: g.last, sev: g.severity,
      type: g.type.type, color: g.type.color, msg: [...g.messages][0] || '(no message)', count: g.count, sample: g.sample,
    }));

    // 堆栈样本（取最严重组的 sample）
    const topSev = groups.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.count - a.count)[0];
    const stack = topSev ? buildStackView(topSev.sample) : null;

    // 趋势 30 桶 × 1min
    const trend = bucketize(errs.filter((e) => within(e, 30 * 60e3)), 30, 60e3);

    return {
      hasData: errs.length > 0,
      hero: {
        rate: errorRate || 0, rateDelta, count: win5.length, affectedSessions: new Set(win5.map((e) => e.sessionId)).size,
        uncaptured: uncaptured.length, sourcemapPct, mttr: mttrProxy,
      },
      breakdown, severity: sev, topRoute: routeGroups[0],
      impact: [
        routeGroups[0] && { ...routeGroups[0], icon: 'route', tone: 'bad' },
        verGroups[0] && { ...verGroups[0], icon: 'package', tone: 'warn' },
        devGroups[0] && { ...devGroups[0], icon: 'tablet-smartphone', tone: 'info' },
      ].filter(Boolean).map((x, i) => ({ rank: i + 1, ...x })),
      stream, stack, trend, total: errs.length,
    };
  }

  function topGroups(items, keyFn) {
    const m = new Map();
    for (const e of items) { const k = keyFn(e); m.set(k, (m.get(k) || 0) + 1); }
    const total = items.length || 1;
    return [...m.entries()].map(([label, count]) => ({ label, count, pct: count / total * 100 })).sort((a, b) => b.count - a.count);
  }
  function bucketize(items, bins, binMs) {
    const t = now();
    const start = t - bins * binMs;
    const arr = new Array(bins).fill(0);
    for (const e of items) { const idx = Math.floor(((e.timestamp || 0) - start) / binMs); if (idx >= 0 && idx < bins) arr[idx]++; }
    const max = Math.max(1, ...arr);
    return arr.map((c, i) => {
      const ratio = c / max;
      const color = i >= bins - 5 && ratio > 0.4 ? 'bad' : ratio > 0.25 ? 'warn' : 'info';
      return { h: 6 + ratio * 46, color };
    });
  }

  function buildStackView(sample) {
    const rf = sample.resolvedFrames;
    if (rf && rf.length) {
      const lines = rf.slice(0, 5).map((f, i) => ({
        tag: 'at', file: shortFile(f.source), meta: `${f.line || '?'}:${f.column || '?'}` + (f.name ? ` · ${f.name}` : '') + ` → ${f.generated}`,
        origin: i === 0, unmapped: false,
      }));
      return { lines, annotation: buildAnno(sample), resolvedPct: 100 };
    }
    const frames = EDIAG()?.parseFrames(sample) || [];
    const lines = frames.slice(0, 5).map((f, i) => ({
      tag: 'at', file: shortFile(f.url), meta: `${f.line}:${f.col}` + (i === 0 ? ` → ${shortFile(f.url)}` : ''),
      origin: i === 0, unmapped: false,
    }));
    if (!lines.length && sample.filename) lines.push({ tag: 'at', file: shortFile(sample.filename), meta: `${sample.lineno || '?'}:${sample.colno || '?'}`, origin: true, unmapped: false });
    if (!lines.length) lines.push({ tag: 'at', file: '(no stack)', meta: '未捕获堆栈', origin: false, unmapped: true });
    return { lines, annotation: buildAnno(sample), resolvedPct: frames.length ? 100 : (sample.filename ? 100 : 0) };
  }
  function buildAnno(sample) {
    const cands = EDIAG()?.analyzeErrorRootCauses(sample) || [];
    const top = cands[0];
    return top ? `${top.kind} · ${top.evidence[0] || ''}` : (sample.message || '').slice(0, 80);
  }

  // 自愈验证结果 → 根因置信度融合(自愈 ⟷ 根因耦合的核心)。
  // verified(patch 显著改善)→ 上调 + 标确证;falsified(显著变差)→ 下调 + 标证伪(根因可能错);weak(未显著)→ 维持。
  // 行业规范:根因不是「诊断完即止」,必须能被自愈实验证伪才算科学闭环(Karl Popper 可证伪性)。
  function fuseVerification(verdict, verification) {
    if (!verification) { verdict.verificationStatus = 'unverified'; verdict.fusedConfidence = verdict.confidence; return verdict; }
    verdict.verification = verification;
    if (verification.conclusion === 'accepted' && verification.significant) {
      verdict.verificationStatus = 'verified';
      verdict.fusedConfidence = Math.min(0.99, (verdict.confidence || 0.5) + 0.2);
    } else if (verification.conclusion === 'rejected') {
      verdict.verificationStatus = 'falsified';
      verdict.fusedConfidence = Math.max(0.1, (verdict.confidence || 0.5) * 0.4);
    } else {
      verdict.verificationStatus = 'weak';
      verdict.fusedConfidence = verdict.confidence;
    }
    return verdict;
  }

  // ================= 统一根因（INP / 错误 共用 RootCauseView） =================
  async function _analyzeRootCauseRaw(signal, event, opts) {
    if (!event) return null;
    const _v = opts && opts.verification;
    if (signal === 'error') {
      const cands = EDIAG()?.analyzeErrorRootCauses(event) || [];
      const top = cands[0] || { kind: 'error.unknown', confidence: 0.3, evidence: ['未匹配'], tags: [], suggestedHealIds: [] };
      const events = await allEvents();
      const sameKind = events.filter(isErr).filter((e) => fingerprint(e) === fingerprint(event));
      return {
        signal: 'error', eventId: event.eventId, sub: 'TypeError', time: event.timestamp, count: sameKind.length,
        verdict: fuseVerification({ title: '归因结论', confidence: top.confidence, body: (top.evidence.join('；')) + (event.message ? ` — ${event.message.slice(0, 60)}` : ''), tags: top.tags }, _v),
        evidenceSteps: buildErrSteps(event, top),
        code: buildErrCode(event),
        hypotheses: cands.map((c) => ({ label: c.kind.replace('error.', ''), prob: c.confidence })),
        impact: { users: new Set(sameKind.map((e) => e.sessionId)).size, events: sameKind.length, recurrence: '7d' },
        suggestedHealIds: top.suggestedHealIds,
      };
    }
    if (signal === 'lcp' || signal === 'fcp' || signal === 'cls') {
      const cands = vitalCandidates(signal, event);
      const top = cands[0] || { kind: signal + '.unknown', confidence: 0.3, evidence: ['未匹配已知模式'], tags: [], suggestedHealIds: [] };
      const cfg = SIGNALS[signal];
      const evs = await allEvents();
      const sameKind = evs.filter((e) => e.type === 'vital' && e.subType === signal);
      return {
        signal, eventId: event.eventId || (signal + '-live'), sub: cfg.label, time: event.timestamp, count: Math.max(1, sameKind.length),
        verdict: fuseVerification({ title: '根因判定', confidence: top.confidence, body: (top.evidence.join('；')) || `${cfg.label}=${fmtSig(signal, event.value)}`, tags: (top.tags && top.tags.length) ? top.tags : [{ label: top.kind, tone: 'bad' }] }, _v),
        evidenceSteps: buildVitalSteps(signal, event, top),
        code: buildVitalCode(signal, event),
        hypotheses: cands.map((c) => ({ label: c.kind.replace(signal + '.', ''), prob: c.confidence })),
        impact: { users: 1, events: sameKind.length, recurrence: '7d' },
        suggestedHealIds: top.suggestedHealIds,
      };
    }
    if (signal === 'memory') {
      const cands = memoryCandidates(event);
      const top = cands[0] || { kind: 'memory.stable', confidence: 0.3, evidence: ['未匹配泄漏模式'], tags: [], suggestedHealIds: [] };
      const cfg = SIGNALS.memory;
      const evs = await allEvents();
      const sameKind = evs.filter((e) => e.type === 'vital' && e.subType === 'memory');
      return {
        signal: 'memory', eventId: event.eventId || 'memory-live', sub: cfg.label, time: event.t || event.timestamp, count: Math.max(1, sameKind.length),
        verdict: fuseVerification({ title: '泄漏判定', confidence: top.confidence, body: (top.evidence.join('；')) || '堆 ' + ((event.value || 0) / 1048576) + 'MB', tags: (top.tags && top.tags.length) ? top.tags : [{ label: top.kind, tone: 'bad' }] }, _v),
        evidenceSteps: buildMemorySteps(event, top),
        code: buildMemoryCode(event),
        hypotheses: cands.map((c) => ({ label: c.kind.replace('memory.', ''), prob: c.confidence })),
        impact: { users: 1, events: sameKind.length, recurrence: '7d' },
        suggestedHealIds: top.suggestedHealIds,
      };
    }
    // INP
    const cands = DIAG()?.analyzeRootCauses(event) || [];
    const dom = DIAG()?.dominantInpPhase(event);
    const top = cands[0] || { kind: 'inp.unknown', confidence: 0.3, evidence: [], suggestedHealIds: [] };
    const events = await allEvents();
    const sameKind = events.filter(isInp);
    const sameFp = sameKind.filter((e) => fingerprint(e) === fingerprint(event)).length; // 同 target+主导段 次数(×N)
    return {
      signal: 'inp', eventId: event.eventId, sub: 'INP', time: event.timestamp, count: Math.max(1, sameFp),
      verdict: fuseVerification({ title: '根因判定', confidence: top.confidence, body: (top.evidence.join('；')) || `INP=${event.value?.toFixed(0)}ms`, tags: inpTags(top, dom) }, _v),
      evidenceSteps: buildInpSteps(event, top, dom),
      code: buildInpCode(event),
      hypotheses: cands.map((c) => ({ label: c.kind.replace('inp.', ''), prob: c.confidence })),
      impact: { users: 1, events: sameKind.length, recurrence: '—' },
      suggestedHealIds: top.suggestedHealIds,
    };
  }
  // ③b②:AI 深诊结果写回 —— 读持久化的 ai-rca verdict 挂到根因结果上(切 tab/重渲染后仍可回显,不必重跑 LLM);
  // grounding 未通过 → 轻降权 fusedConfidence(交叉分析信号,非硬否决)。
  async function analyzeRootCause(signal, event, opts) {
    const r = await _analyzeRootCauseRaw(signal, event, opts);
    if (!r) return r;
    const aiRca = (event && event.eventId) ? await getAiRca(event.eventId) : null;
    if (aiRca) {
      r.aiRca = aiRca;
      if (aiRca.grounding && !aiRca.grounding.ok && r.verdict) {
        r.verdict.fusedConfidence = (r.verdict.fusedConfidence != null ? r.verdict.fusedConfidence : r.verdict.confidence) * 0.9;
        r.verdict.aiGrounding = 'ungrounded';
      }
    }
    return r;
  }
  function buildErrSteps(ev, top) {
    const f = EDIAG()?.parseFrames(ev) || [];
    const rf = ev.resolvedFrames && ev.resolvedFrames[0];
    return [
      { text: `${ev.subType === 'promise' ? 'unhandledrejection' : 'window.onerror'} 捕获 ${ev.subType === 'js' ? 'uncaught ' + (ev.message || '').split(' ')[0] : (ev.message || '').slice(0, 40)}（stack ${f.length} 帧）` },
      { text: rf && rf.source ? `Source Map 还原 → ${rf.source}:${rf.line || '?'}` : (ev.filename ? `Source Map 解析 → ${shortFile(ev.filename)}:${ev.lineno || '?'}` : (f[0] ? `栈顶 → ${shortFile(f[0].url)}:${f[0].line}` : '无源映射（dev 未带 sourceMappingURL / 跨域被 CORS 拦截）')), good: !!(rf && rf.source) },
      { text: `Pattern 匹配 → ${top.kind}（confidence ${(top.confidence * 100).toFixed(0)}%）`, good: top.confidence >= 0.6 },
      { text: '同源指纹归并 · 按 message 指纹聚合(本地口径,非跨用户)', good: true },
    ];
  }
  function buildErrCode(ev) {
    const rf = ev.resolvedFrames && ev.resolvedFrames[0];
    if (rf && rf.source && rf.snippet && rf.snippet.rows) {
      return {
        file: rf.source, line: rf.line,
        lines: rf.snippet.rows.map((r) => ({ n: r.n, code: r.code, hl: r.n === rf.line })),
        annotation: `${rf.source}:${rf.line || '?'}:${rf.column || ''} ${rf.name ? '· ' + rf.name + ' ' : ''}← sourcemap 还原自 ${rf.generated}`,
      };
    }
    const f = EDIAG()?.parseFrames(ev) || [];
    const file = shortFile(ev.filename || (f[0] && f[0].url) || 'unknown');
    const line = ev.lineno || (f[0] && f[0].line) || 0;
    const col = ev.colno || (f[0] && f[0].col) || 0;
    const loc = `${file}${line ? ':' + line : ''}${col ? ':' + col : ''}`;
    const lines = [
      { n: 1, code: '// 未还原源码', hl: true },
      { n: 2, code: '// 生成位置:' + loc },
      { n: 3, code: '// dev 需 bundle 带 //# sourceMappingURL 才能还原到源文件:行:列' },
    ];
    return { file: '未还原源码', line: 1, lines, annotation: `${loc} 触发;未找到 sourcemap(dev 需 bundle 带 //# sourceMappingURL)。` };
  }
  function buildInpSteps(ev, top, dom) {
    return [
      { text: `Event Timing 捕获 INP=${(ev.value || 0).toFixed(0)}ms（dominant: ${dom?.phase || '-'}）` },
      { text: `LoAF 交叉锚点 ${(ev.loafScripts || []).length} 帧` + (ev.loafScripts?.[0] ? ` · ${shortFile(ev.loafScripts[0].sourceURL)}` : '') },
      { text: `三段判定 → ${dom?.phase || '-'} 占 ${(dom?.ratio * 100 || 0).toFixed(0)}%` },
      { text: `Pattern 匹配 → ${top.kind}（confidence ${(top.confidence * 100).toFixed(0)}%）`, good: top.confidence >= 0.6 },
    ];
  }
  function buildInpCode(ev) {
    const rs = ev.resolvedScript;
    if (rs && rs.snippet && rs.snippet.rows) {
      // 真实源码：sourcemap 还原自 LoAF 锚点的字符位置
      return {
        file: rs.source, line: rs.line,
        lines: rs.snippet.rows.map((r) => ({ n: r.n, code: r.code, hl: r.n === rs.line })),
        annotation: `${rs.source}:${rs.line || '?'}:${rs.column || ''} ${rs.name ? '· ' + rs.name + ' ' : ''}← sourcemap 还原自 ${rs.generated}`,
      };
    }
    // 未还原：无 source map / LoAF 未提供字符位置 → 占位，不造假源码
    const f = ev.loafScripts?.[0];
    const anchor = f ? `${shortFile(f.sourceURL)}${f.invoker ? ' · ' + f.invoker : ''}${f.sourceFunctionName ? ' · ' + f.sourceFunctionName : ''}` : (ev.interactionTarget || '未知目标');
    const lines = [
      { n: 1, code: '// 未还原源码', hl: true },
      { n: 2, code: '// LoAF 锚点：' + anchor },
      { n: 3, code: '// 需 bundle 带 //# sourceMappingURL 且 LoAF 提供 sourceCharPosition' },
    ];
    return { file: '未还原源码', line: 1, lines, annotation: `未能还原源码，LoAF 锚点：${anchor}。dev 需 bundle 带 sourceMappingURL；部分浏览器 LoAF 不提供 sourceCharPosition。` };
  }
  // ===== vital (LCP/FCP/CLS) 根因规则 =====
  function vitalCandidates(signal, ev) {
    const v = (ev && ev.value != null) ? ev.value : 0;
    const cfg = SIGNALS[signal];
    const out = [];
    const push = (kind, conf, evidence, tags, heal) => out.push({ kind: signal + '.' + kind, confidence: conf, evidence, tags, suggestedHealIds: heal });
    if (signal === 'lcp') {
      // 官方四段对齐:load delay(可发现性)/ load time(传输)/ render delay 分开,解法族不同。
      const hasTtfb = ev.ttfb != null;
      const hasFour = ev.resStart != null && ev.resEnd != null;
      const loadDelay = hasFour ? Math.max(0, ev.resStart - (ev.ttfb || 0)) : null;
      const loadTime = hasFour ? Math.max(0, ev.resEnd - ev.resStart) : (ev.resLoad != null ? ev.resLoad : null);
      const renderDelay = hasFour ? Math.max(0, v - ev.resEnd) : ((ev.ttfb != null || loadTime != null) ? Math.max(0, v - (ev.ttfb || 0) - (loadTime || 0)) : null);
      if (hasTtfb && ev.ttfb > 800) push('slow_ttfb', Math.min(0.8, 0.5 + ev.ttfb / 4000), [`TTFB ${fmtSig('lcp', ev.ttfb)} 偏长`, '边缘/源站响应慢(需排查 CDN/源站/重定向)'], [{ label: 'slow-ttfb', tone: 'warn' }], []);
      if (loadDelay != null && loadDelay > 300) push('resource_load_delay', Math.min(0.92, 0.55 + loadDelay / 2000), [`资源加载延迟 ${fmtSig('lcp', loadDelay)}(可发现性低)`, 'preload scanner 未发现 / JS 注入 / 误 lazy / 跨域', '<link rel=preload fetchpriority=high> + 首屏图勿 lazy + 同源'], [{ label: 'load-delay', tone: 'accent' }, { label: shortFile(ev.url), tone: 'info' }], ['preload_lcp']);
      if (loadTime != null && loadTime > 1500) push('slow_resource', Math.min(0.9, 0.5 + loadTime / 6000), [`资源传输 ${fmtSig('lcp', loadTime)} 偏长(大图/旧格式/未压缩/远)`, '现代格式 webp/avif + 压缩 + 图 CDN'], [{ label: 'slow-resource', tone: 'bad' }, { label: shortFile(ev.url), tone: 'info' }], []);
      if (renderDelay != null && renderDelay > 400) push('render_block', Math.min(0.7, 0.45 + renderDelay / 4000), [`元素渲染延迟 ${fmtSig('lcp', renderDelay)}`, '渲染阻塞 CSS/JS 或客户端渲染', '内联关键 CSS + 其余 defer + SSR'], [{ label: 'render-block', tone: 'warn' }], ['defer_css']);
    } else if (signal === 'fcp') {
      const hasTtfb = ev.ttfb != null, hasParse = ev.domParse != null;
      if (hasTtfb && ev.ttfb > 800) push('slow_ttfb', Math.min(0.9, 0.55 + ev.ttfb / 4000), [`首字节 TTFB ${fmtSig('fcp', ev.ttfb)} 偏长`, '首字节响应慢(需排查 CDN/源站)'], [{ label: 'slow-ttfb', tone: 'bad' }], []);
      if (hasTtfb || hasParse) {
        const block = Math.max(0, v - (ev.ttfb || 0) - (ev.domParse || 0));
        push('render_block', Math.min(0.88, 0.5 + block / 4000), [`渲染阻塞资源 ${fmtSig('fcp', block)}`, '首屏 link[rel=stylesheet] 阻塞首 paints', '关键 CSS 内联 + 非关键 async/defer'], [{ label: 'render-block', tone: 'bad' }, { label: 'css', tone: 'info' }], ['defer_css']);
      }
    } else if (signal === 'cls') {
      const sb = ev.sourceBreakdown || clsBreakdown(ev.shifts || []);
      const total = Math.max(0.0001, ev.value || (sb.media + sb.font + sb.dom));
      if (sb.media / total > 0.3) push('unsized_media', Math.min(0.92, 0.55 + sb.media / total * 0.4), [`无尺寸图片/嵌入贡献 ${(sb.media / total * 100).toFixed(0)}%`, ev.element ? `主移元素 ${ev.element}` : '', 'img/iframe 缺 width/height → 回流'], [{ label: 'unsized-media', tone: 'bad' }, { label: 'image', tone: 'info' }], ['size_attrs']);
      if (sb.font / total > 0.15) push('web_font', Math.min(0.8, 0.5 + sb.font / total * 0.4), [`Web Font FOUT 贡献 ${(sb.font / total * 100).toFixed(0)}%`, '字体回退触发位移', 'font-display: optional / size-adjust'], [{ label: 'web-font', tone: 'warn' }], ['font_display']);
      if (sb.dom / total > 0.15) push('dynamic_dom', Math.min(0.7, 0.45 + sb.dom / total * 0.3), [`动态注入 DOM 贡献 ${(sb.dom / total * 100).toFixed(0)}%`, 'banner/广告位/第三方异步插入', '为注入容器预留 min-height'], [{ label: 'dynamic-dom', tone: 'accent' }], ['size_attrs']);
    }
    if (!out.length) push('unknown', 0.3, [`${cfg.label}=${fmtSig(signal, v)} 暂未匹配已知模式`], [{ label: 'unknown', tone: 'fg-3' }], []);
    return out.sort((a, b) => b.confidence - a.confidence);
  }
  // memory 泄漏候选(对齐 vitalCandidates 结构):heap_growth / no_release_on_nav / dom_bloat / near_limit
  function memoryCandidates(ev) {
    const out = [];
    const push = (kind, conf, evidence, tags, heal) => out.push({ kind: 'memory.' + kind, confidence: conf, evidence, tags, suggestedHealIds: heal });
    const ratio = ev.ratio != null ? ev.ratio : 0;
    const heapSlopeMB = ev.heapSlopeMB || 0;
    const domSlope = ev.domSlope || 0;
    if (ratio > 0.8) push('near_limit', Math.min(0.95, 0.7 + ratio * 0.3), ['堆占 limit ' + Math.round(ratio * 100) + '% 逼近上限', '可能 OOM / 频繁 GC 降速,需立即排查泄漏'], [{ label: 'near-limit', tone: 'bad' }], ['inject_cleanup']);
    if (heapSlopeMB > 0.5) push('heap_growth', Math.min(0.92, 0.55 + heapSlopeMB / 10), ['堆单调增长 +' + heapSlopeMB.toFixed(1) + ' MB/min', '持续不回落 → 疑似 JS 堆泄漏(闭包/缓存/监听器累积)'], [{ label: 'heap-growth', tone: 'bad' }], ['inject_cleanup', 'clear_timers']);
    if (ev.noRelease) push('no_release_on_nav', 0.78, ['路由切换后堆未回落(< 导航前 85%)', 'SPA 跨路由泄漏:组件卸载未清理订阅/定时器/引用'], [{ label: 'cross-route-leak', tone: 'warn' }], ['inject_cleanup', 'clear_timers']);
    if (domSlope > 50 || ev.domCount > 5000) push('dom_bloat', Math.min(0.85, 0.5 + Math.min(domSlope, 200) / 300), ['DOM 节点 ' + (ev.domCount || 0) + '(+' + domSlope.toFixed(0) + '/min)', 'detached DOM 累积嫌疑:移除节点仍被 JS 引用'], [{ label: 'dom-bloat', tone: 'accent' }], ['weak_ref']);
    // listener_leak 仅在 attach 精确模式(ev.listeners 来自 CDP JSEventListeners)才判 —— advisory 拿不到监听器数
    if ((ev.listeners || 0) > 500) push('listener_leak', Math.min(0.85, 0.5 + Math.min(ev.listeners, 5000) / 10000), ['事件监听器 ' + ev.listeners + ' 个(CDP JSEventListeners 精确计数)', '累积未 removeEventListener / 组件卸载未清理 → 内存 + INP 双害'], [{ label: 'listener-leak', tone: 'warn' }], ['clear_timers', 'inject_cleanup']);
    if (!out.length) push('stable', 0.3, ['堆使用平稳(' + ((ev.value || 0) / 1048576).toFixed(1) + 'MB,斜率 ' + heapSlopeMB.toFixed(2) + 'MB/min)', '暂未匹配泄漏模式'], [{ label: 'stable', tone: 'fg-3' }], []);
    return out.sort((a, b) => b.confidence - a.confidence);
  }
  function buildVitalSteps(signal, ev, top) {
    const cfg = SIGNALS[signal];
    const segs = cfg.segs(ev);
    return [
      { text: `PerformanceObserver(${cfg.tgtEntry.replace('entry: ', '')}) 捕获 ${cfg.label}=${fmtSig(signal, ev.value)}` },
      { text: step2Anchor(signal, ev) },
      { text: `构成拆解 → ${segs.map((s) => `${s.label.split(' ')[0]} ${(s.value / Math.max(1, ev.value) * 100).toFixed(0)}%`).join(' · ')}` },
      { text: `Pattern 匹配 → ${top.kind}（confidence ${(top.confidence * 100).toFixed(0)}%）`, good: top.confidence >= 0.6 },
    ];
  }
  function step2Anchor(signal, ev) {
    if (signal === 'lcp') return ev.url ? `资源时序 → ${shortFile(ev.url)} 加载 ${fmtSig('lcp', ev.resLoad || 0)}` : 'LCP 元素锚点已记录';
    if (signal === 'fcp') return `Navigation Timing → TTFB ${fmtSig('fcp', ev.ttfb || 0)}`;
    return `Layout Shift sources[] → ${(ev.shifts || []).length} 次位移，主源 ${ev.element || '未知'}`;
  }
  function buildVitalCode(signal, ev) {
    // LCP/FCP/CLS 根因非 JS,不走 sourcemap → 改「真实锚点」卡,内容全部真实采集值,不造假代码帧。
    if (signal === 'lcp') {
      const rows = [
        `元素: ${ev.element || '(未捕获)'}`,
        `资源: ${ev.url ? shortFile(ev.url) : '(无资源 url)'}`,
        `资源加载耗时: ${ev.resLoad != null ? fmtSig('lcp', ev.resLoad) : '未采集'}`,
        ev.size != null ? `资源尺寸: ${ev.size}px²` : null,
      ].filter(Boolean);
      return { file: 'LCP 定位锚点', line: 1, lines: rows.map((c, i) => ({ n: i + 1, code: c, hl: i === 0 })), annotation: `LCP ${fmtSig('lcp', ev.value)}${ev.resLoad != null && ev.resLoad > 1500 ? ' · 主资源加载偏长,可考虑 <link rel=preload as=image>' : ''}` };
    }
    if (signal === 'fcp') {
      const rows = [
        `TTFB: ${ev.ttfb != null ? fmtSig('fcp', ev.ttfb) : '未采集'}`,
        `HTML 解析: ${ev.domParse != null ? fmtSig('fcp', ev.domParse) : '未采集'}`,
        `导航类型: ${ev.navType || '未采集'}`,
      ];
      return { file: 'FCP 定位锚点', line: 1, lines: rows.map((c, i) => ({ n: i + 1, code: c, hl: i === 0 })), annotation: `FCP ${fmtSig('fcp', ev.value)}${ev.ttfb != null && ev.ttfb > 800 ? ' · TTFB 偏长,排查 CDN/源站' : ''}` };
    }
    // cls
    const shifts = ev.shifts || [];
    const rows = [
      `位移元素: ${ev.element || '(未捕获)'}`,
      `最大单次位移: ${(ev.largest != null ? ev.largest : 0).toFixed(2)}`,
      `位移来源: ${shifts[0] ? (shifts[0].source || shifts[0].kind || '未知') : '未采集'}`,
    ];
    return { file: 'CLS 定位锚点', line: 1, lines: rows.map((c, i) => ({ n: i + 1, code: c, hl: i === 0 })), annotation: `CLS ${(ev.value || 0).toFixed(2)} · 位移元素宜声明 width/height 或预留 min-height` };
  }
  function buildMemorySteps(ev, top) {
    return [
      { text: 'performance.memory 采样:堆 ' + ((ev.value || 0) / 1048576).toFixed(1) + 'MB / limit ' + ((ev.limit || 0) / 1048576).toFixed(0) + 'MB(' + Math.round((ev.ratio || 0) * 100) + '%)' },
      { text: '趋势分析:堆 ' + ((ev.heapSlopeMB || 0) > 0.05 ? '+' : '') + (ev.heapSlopeMB || 0).toFixed(2) + 'MB/min · DOM ' + ((ev.domSlope || 0) > 0 ? '+' : '') + (ev.domSlope || 0).toFixed(0) + '/min' + (ev.noRelease ? ' · 路由后未回落' : '') },
      { text: '泄漏模式匹配 → ' + top.kind + '(confidence ' + (top.confidence * 100).toFixed(0) + '%)', good: top.confidence >= 0.6 },
      { text: '注:扩展拿不到 GC / 堆快照,结论基于采样趋势推断(advisory)' },
    ];
  }
  function buildMemoryCode(ev) {
    const rows = [
      '堆 used: ' + ((ev.value || 0) / 1048576).toFixed(1) + 'MB / limit ' + ((ev.limit || 0) / 1048576).toFixed(0) + 'MB',
      '堆斜率: ' + (ev.heapSlopeMB || 0).toFixed(2) + ' MB/min',
      'DOM 节点: ' + (ev.domCount || 0) + '(' + (ev.domSlope || 0).toFixed(0) + '/min)',
      '路由后回落: ' + (ev.noRelease ? '否(嫌疑)' : '是/无导航'),
    ];
    return { file: '内存泄漏锚点', line: 1, lines: rows.map((c, i) => ({ n: i + 1, code: c, hl: i === 0 })), annotation: (ev.leakSuspect || '平稳') + ' · 扩展无堆快照能力,精确引用链需 DevTools Memory panel 取堆快照 diff' };
  }

  function inpTags(top, dom) {
    const t = [{ label: top.kind.replace('inp.', ''), tone: 'bad' }];
    if (dom) t.push({ label: dom.phase, tone: 'warn' });
    return t;
  }

  // ================= 历史 =================
  async function loadHistory(filter) {
    const events = await allEvents();
    const cutoff = filter === 'today' ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })()
      : filter === '7d' ? now() - 7 * 86400e3 : 0;
    const filtered = events.filter((e) => (e.timestamp || 0) >= cutoff);
    const grouped = {};
    for (const e of filtered) { const h = e.host || 'unknown'; (grouped[h] = grouped[h] || []).push(e); }
    return Object.entries(grouped).map(([host, evs]) => {
      const inp = evs.filter(isInp); const vals = inp.map((e) => e.value || 0).filter((v) => v > 0);
      const errs = evs.filter(isErr);
      return {
        host, count: evs.length, inpCount: inp.length, errCount: errs.length,
        p75: pct(vals, 0.75), max: vals.length ? Math.max(...vals) : 0,
        events: evs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50),
      };
    }).sort((a, b) => b.count - a.count);
  }

  async function count() { try { return (await db()?.count('events')) || 0; } catch { return 0; } }

  // 工具
  function shortFile(u) { if (!u) return '(unknown)'; try { return decodeURIComponent(String(u)).split('/').pop().slice(0, 42); } catch { return String(u).slice(-42); } }
  function parseUA(ua) { if (/iphone|ipad|ios/i.test(ua)) return 'iOS Safari'; if (/android/i.test(ua)) return 'Android Chrome'; if (/mac/i.test(ua)) return 'macOS'; if (/win/i.test(ua)) return 'Windows'; return 'Desktop'; }
  function proxyAttr(t) { if (!t) return ''; const s = String(t); return /[.#\[]/.test(s) ? `<${s.split(/[.#\[]/)[0]}> · ${s}` : `<${s}>`; }

  global.__data = { loadRealtime, loadVital, loadMemory, loadErrorOverview, analyzeRootCause, loadHistory, count, allEvents, putEvent, pruneOldEvents, clearEventsCache, groupErrors, groupInp, fingerprint, rating, rateSig, fmtSig, pct, SIGNALS, vitalCandidates, memoryCandidates, linearSlope, recordFeedback, getFeedback, countFeedback, recordHeal, getHeals, recordVerification, getVerification, recordAiRca, getAiRca, fuseVerification, saveSession, loadSessions, buildCrossSignalChain, buildScene, importScene, setHostScope, getHostScope };
})(typeof globalThis !== 'undefined' ? globalThis : self);
