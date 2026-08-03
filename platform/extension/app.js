// app.js · INP / 错误 Copilot 侧边栏主壳
// 一级域 [INP COPILOT | 错误] + 二级 tab 路由；shell 全 Icon 化（对标设计稿 TM7xV）。
const { useState: us, useEffect: ue } = React;
const { createRoot } = ReactDOM;
const el = globalThis.el || React.createElement;

// 版本号单源:从 manifest.json 读取(chrome.runtime.getManifest),避免 content/sidepanel/设置三处漂移。
const VERSION = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest?.().version) || '1.0.0';
const SETTINGS_KEY = 'inp_copilot_settings';
const DEFAULT_SETTINGS = { sampleRate: 1, loafThresholdMs: 50, alertThresholdMs: 500, tailSampleMs: 200, backend: '', sourceMapAuto: true, sidecarUrl: 'http://127.0.0.1:7777', sidecarEnabled: false };

const TABS = {
  overview: ['概览'],
  inp: ['实时', '根因', '自愈', 'MR', '历史', '设置'],
  error: ['错误流', '根因', '自愈', 'MR', '历史', '设置'],
  lcp: ['实时', '根因', '自愈', 'MR', '历史', '设置'],
  fcp: ['实时', '根因', '自愈', 'MR', '历史', '设置'],
  cls: ['实时', '根因', '自愈', 'MR', '历史', '设置'],
  memory: ['实时', '根因', '自愈', 'MR', '历史', '设置'],
  fps: ['实时', '根因', '自愈', 'MR', '历史', '设置'],
};
const VITALS = ['inp', 'lcp', 'fcp', 'cls', 'memory', 'fps'];
const DOMAINS = [['overview', '概览', 'activity'], ['inp', 'INP', 'activity'], ['error', '错误', 'triangle-alert'], ['lcp', 'LCP', 'image'], ['fcp', 'FCP', 'eye'], ['cls', 'CLS', 'move'], ['memory', '内存', 'database'], ['fps', 'FPS', 'zap']];
const BRAND = { overview: 'VITALS COPILOT', inp: 'INP COPILOT', error: 'ERROR COPILOT', lcp: 'LCP COPILOT', fcp: 'FCP COPILOT', cls: 'CLS COPILOT', memory: 'MEMORY COPILOT', fps: 'FPS COPILOT' };

const fmtHost = (h) => { if (!h) return '(no active tab)'; if (h === '127.0.0.1' || h === 'localhost' || h.startsWith('127.')) return '(localhost)'; return h; };

// ================= Domain Switch =================
function DomainSwitch({ domain, onChange }) {
  return el('div', { style: { display: 'flex', padding: '0 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' } },
    el('div', { style: { display: 'flex', gap: 0, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: 2, margin: '6px 0', flex: 1 } },
      DOMAINS.map(([d, lbl, ic]) => {
        const active = domain === d;
        return el('button', { key: d, title: ({ overview: '概览 · 全信号一览', inp: 'INP COPILOT', error: '错误 Error', lcp: 'LCP · Largest Contentful Paint', fcp: 'FCP · First Contentful Paint', cls: 'CLS · Cumulative Layout Shift', memory: '内存 · JS Heap / 泄漏检测', fps: 'FPS · 渲染帧率' })[d], onClick: () => onChange(d), style: {
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          padding: '5px 4px', borderRadius: 3, cursor: 'pointer',
          background: active ? 'var(--accent)' : 'transparent',
          color: active ? 'var(--bg)' : 'var(--fg-3)',
          border: 'none', fontFamily: 'var(--font-ui)', fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
          transition: 'all .15s',
        } },
          el(Icon, { name: ic, size: 12, fill: active ? 'var(--bg)' : 'var(--fg-3)' }),
          el('span', null, lbl),
        );
      }),
    ),
  );
}

// ================= Tab Bar =================
function TabBar({ tabs, active, onChange }) {
  return el('div', { style: { display: 'flex', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' } },
    tabs.map((t) => {
      const activeT = active === t;
      return el('div', { key: t, onClick: () => onChange(t), style: {
        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between',
        height: 34, padding: '9px 0 0', cursor: 'pointer',
      } },
        el('span', { style: { fontFamily: 'var(--font-ui)', fontSize: 11, fontWeight: activeT ? 600 : 500, color: activeT ? 'var(--fg)' : 'var(--fg-3)' } }, t),
        el('div', { style: { width: '100%', height: 2, background: activeT ? 'var(--accent)' : 'transparent' } }),
      );
    }),
  );
}

// ================= Shell =================
function Shell({ chromeOk, route, session, brand, domain, setDomain, tabs, tab, setTab, eventCount, children }) {
  return el('div', { style: { display: 'flex', flexDirection: 'column', height: '100vh' } },
    // Title bar
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--border)' } },
      el(Icon, { name: 'grip-vertical', size: 13, fill: 'var(--fg-3)' }),
      el(Icon, { name: 'activity', size: 14, fill: 'var(--accent)' }),
      el('span', { style: { fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, letterSpacing: 0.8, color: 'var(--fg)' } }, brand || 'INP COPILOT'),
      el('span', { style: { display: 'inline-flex', padding: '2px 5px', background: 'var(--surface-3)', border: '1px solid var(--border)', borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-3)' } }, 'v' + VERSION),
      el(Sep),
      el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 6px', borderRadius: 3, background: chromeOk ? 'var(--good-soft)' : 'var(--bad-soft)' } },
        el('span', { style: { width: 5, height: 5, borderRadius: '50%', background: chromeOk ? 'var(--good)' : 'var(--bad)' } }),
        el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8.5, letterSpacing: 0.4, color: chromeOk ? 'var(--good)' : 'var(--bad)' } }, chromeOk ? 'LIVE' : 'NO API'),
      ),
    ),
    // Context strip
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', background: 'var(--surface)', borderBottom: '1px solid var(--border)' } },
      el(Icon, { name: 'globe', size: 11, fill: 'var(--fg-3)' }),
      el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, route),
      el('span', { style: { padding: '1px 4px', background: 'var(--info-soft)', borderRadius: 2, fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--info)', letterSpacing: 0.3 } }, 'PROD'),
      el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--fg-3)' } }, session),
    ),
    // Domain switch
    el(DomainSwitch, { domain, onChange: setDomain }),
    // Tabs
    el(TabBar, { tabs, active: tab, onChange: setTab }),
    // Content
    el('div', { style: { flex: 1, overflow: 'auto', padding: 10, background: 'var(--bg)' } }, children),
    // Footer
    el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: 'var(--surface-2)', borderTop: '1px solid var(--border)' } },
      el(Icon, { name: 'database', size: 11, fill: 'var(--info)' }),
      el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-3)' } }, `inp-copilot@v${VERSION} · ${eventCount} events · 本地`),
      el(Sep),
      el('span', { style: { width: 5, height: 5, borderRadius: '50%', background: 'var(--good)' } }),
      el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-3)' } }, '归因引擎 在线'),
    ),
  );
}

// ================= App =================
function App() {
  const [domain, setDomain] = us('overview');
  const [tab, setTab] = us('概览');
  const [live, setLive] = us({ inp: null, loafScripts: [], interactions: [], vitals: null, route: '', host: '', sessionMeta: '' });
  const [eventCount, setEventCount] = us(0);
  const [realtime, setRealtime] = us(null);
  const [rca, setRca] = us(null);
  const [rcaEvent, setRcaEvent] = us(null);
  const [appliedTokens, setAppliedTokens] = us([]);
  const [settings, setSettings] = us(DEFAULT_SETTINGS);
  const [selectedError, setSelectedError] = us(null);
  const [chromeOk, setChromeOk] = us(false);
  const [shareOut, setShareOut] = us(null);
  const [importOut, setImportOut] = us(null);
  const [llmConfig, setLlmConfig] = us(null);
  const [preflightResult, setPreflightResult] = us(null);

  // live/settings 经 ref 读取，避免把它们放进下方 refresh effect 的依赖 →
  // 否则每次 INP_UPDATE 推送都会重建 setInterval，持续交互页会把 2s 兜底节拍不断重置。
  const liveRef = React.useRef(live); liveRef.current = live;
  const settingsRef = React.useRef(settings); settingsRef.current = settings;

  // chrome 守卫 + 消息。数据归属=扩展 origin：sidepanel 负责写 IndexedDB（持久页面，可靠）。
  ue(() => {
    const hasChrome = typeof chrome !== 'undefined' && chrome?.runtime?.onMessage;
    setChromeOk(!!hasChrome);
    if (!hasChrome) return;
    const handler = (msg) => {
      if (msg?.type === 'INP_UPDATE') setLive((p) => Object.assign({}, p, msg.payload));
      else if (msg?.type === 'EVENT_RELAY' && globalThis.__data) globalThis.__data.putEvent(msg.payload).catch(() => {});
    };
    chrome.runtime.onMessage.addListener(handler);
    chrome.runtime.sendMessage({ type: 'GET_LATEST' }, (resp) => { if (resp?.payload) setLive((p) => Object.assign({}, p, resp.payload)); });
    // 开屏：把 background 缓冲（sidepanel 关闭期间累积）flush 进 IndexedDB
    chrome.runtime.sendMessage({ type: 'FLUSH_BUFFER' }, (resp) => {
      if (resp?.events?.length && globalThis.__data) Promise.all(resp.events.map((ev) => globalThis.__data.putEvent(ev).catch(() => {})));
      // 开屏顺便清理过期事件（默认 7 天 / 5000 条），防止 IndexedDB 无限膨胀
      if (globalThis.__data?.pruneOldEvents) globalThis.__data.pruneOldEvents().catch(() => {});
    });
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // 设置载入
  ue(() => {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      chrome.storage.local.get(SETTINGS_KEY, (r) => { if (r[SETTINGS_KEY]) setSettings({ ...DEFAULT_SETTINGS, ...r[SETTINGS_KEY] }); });
    }
    if (globalThis.__llm && globalThis.__llm.getConfig) globalThis.__llm.getConfig().then(setLlmConfig);
  }, []);
  // sidecar 桥配置同步到全局(sidecar.js 的 pushFindings 读 __vcSidecarSettings)
  ue(() => { globalThis.__vcSidecarSettings = { sidecarUrl: settings.sidecarUrl, sidecarEnabled: !!settings.sidecarEnabled }; }, [settings]);
  const saveLlm = (cfg) => { setLlmConfig(cfg); setPreflightResult(null); if (globalThis.__llm && globalThis.__llm.setConfig) globalThis.__llm.setConfig(cfg); };
  const preflightLlm = async () => { if (!globalThis.__llm || !llmConfig) return; setPreflightResult({ ok: false, error: '测试中…' }); const r = await globalThis.__llm.preflight(llmConfig); setPreflightResult(r); };
  const saveSettings = (next) => { setSettings(next); if (typeof chrome !== 'undefined' && chrome?.storage?.local) chrome.storage.local.set({ [SETTINGS_KEY]: next }); };

  // 数据 refresh 闭包：读 ref 最新 live/settings（INP 告警阈值随设置生效）。
  const refreshRef = React.useRef(async () => {});
  refreshRef.current = async () => {
    if (!globalThis.__data) return;
    const c = await globalThis.__data.count().catch(() => 0);
    setEventCount(c);
    if (tab === '实时' && VITALS.includes(domain)) {
      const D2 = globalThis.__data;
      const rt = domain === 'memory'
        ? await D2.loadMemory(liveRef.current).catch(() => null)
        : await D2.loadVital(domain, liveRef.current, domain === 'inp' ? { alertThreshold: settingsRef.current.alertThresholdMs } : undefined).catch(() => null);
      setRealtime(rt);
    }
  };
  // 兜底轮询（2s），依赖仅 [domain,tab] → 不被 live 推送打断
  ue(() => {
    refreshRef.current();
    const t = setInterval(() => refreshRef.current(), 2000);
    return () => clearInterval(t);
  }, [domain, tab]);
  // live 推送到达时立即刷新一次（保持实时性，不重建 interval）
  ue(() => { refreshRef.current(); }, [live.inp, live.vitals]);

  // 不同域名隔离:跟随当前 tab host 设置 host scope → data 所有查询(allEvents/loadSessions/...)自动按 host 过滤
  ue(() => { if (globalThis.__data && globalThis.__data.setHostScope) globalThis.__data.setHostScope(live.host); }, [live.host]);

  // 根因 tab：计算 event + analyzeRootCause
  ue(() => {
    if (tab !== '根因') return;
    let alive = true;
    (async () => {
      if (!globalThis.__data) return;
      let event, sig;
      if (domain === 'error') {
        sig = 'error';
        event = selectedError;
        if (!event) {
          const all = await globalThis.__data.allEvents();
          const errs = all.filter((e) => e.type === 'error').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          event = errs[0];
        }
      } else if (domain === 'inp') {
        sig = 'inp';
        event = live.inp ? Object.assign({}, live.inp, { loafScripts: live.loafScripts }) : null;
        if (!event) {
          const all = await globalThis.__data.allEvents();
          event = all.filter((e) => e.subType === 'inp').sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
        }
      } else { // lcp / fcp / cls / memory
        sig = domain;
        if (domain === 'memory') {
          // memory 是趋势信号:根因用 loadMemory 的 cur(含 ratio/heapSlopeMB/domSlope/noRelease)
          const mem = await globalThis.__data.loadMemory(live);
          event = mem && mem.hasData ? Object.assign({ eventId: 'memory-live', timestamp: Date.now() }, mem.cur) : null;
        } else {
          const all = await globalThis.__data.allEvents();
          event = all.filter((e) => e.type === 'vital' && e.subType === domain).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
          const lv = live.vitals || {};
          if (domain === 'lcp' && lv.lcp != null) event = Object.assign({ value: lv.lcp, element: lv.lcpElement, url: lv.lcpUrl, ttfb: lv.ttfb }, event || {});
          else if (domain === 'fcp' && lv.fcp != null) event = Object.assign({ value: lv.fcp, ttfb: lv.ttfb }, event || {});
          else if (domain === 'cls' && lv.cls != null) event = Object.assign({ value: lv.cls, shifts: lv.shifts || [], element: lv.shifts && lv.shifts[0] && lv.shifts[0].source }, event || {});
          else if (!event) event = null;
        }
      }
      if (!event) { if (alive) setRca(null); setRcaEvent(null); return; }
      let data = await globalThis.__data.analyzeRootCause(sig, event);
      // P1 根因-自愈耦合:读该根因 top 候选 patch 的自愈验证结果 → 融合置信度(verified 确证 / falsified 证伪 / weak 待证)
      if (data && data.suggestedHealIds && data.suggestedHealIds.length && globalThis.__data.getVerification && globalThis.__data.fuseVerification) {
        for (const hid of data.suggestedHealIds) {
          const ver = await globalThis.__data.getVerification((live.host ? live.host + ':' : '') + 'tpl:' + hid);
          if (ver) { globalThis.__data.fuseVerification(data.verdict, ver); break; }
        }
      }
      // P3 跨信号因果链:聚焦当前信号,从全事件构建关联 trace(内存→GC→INP 等)
      if (data && globalThis.__data && globalThis.__data.buildCrossSignalChain) {
        data.crossSignalChain = await globalThis.__data.buildCrossSignalChain(sig, event);
      }
      if (alive) { setRca(data); setRcaEvent(event); }
    })();
    return () => { alive = false; };
  }, [domain, tab, selectedError, live.inp, live.vitals]);

  const switchDomain = (d) => { setDomain(d); setTab(d === 'error' ? '错误流' : d === 'overview' ? '概览' : '实时'); setSelectedError(null); setRca(null); setRcaEvent(null); };

  // MR 候选（按域）
  const candidatesForMr = (() => {
    if (domain === 'error') {
      const ev = selectedError;
      return ev && globalThis.__inpErrorDiagnose ? globalThis.__inpErrorDiagnose.analyzeErrorRootCauses(ev) : [];
    }
    if (domain === 'inp') {
      const ev = live.inp ? Object.assign({}, live.inp, { loafScripts: live.loafScripts }) : null;
      return ev && globalThis.__inpDiagnose ? globalThis.__inpDiagnose.analyzeRootCauses(ev) : [];
    }
    // lcp / fcp / cls
    if (domain === 'memory') return (rcaEvent && globalThis.__data && globalThis.__data.memoryCandidates) ? globalThis.__data.memoryCandidates(rcaEvent) : [];
    return (rcaEvent && globalThis.__data && globalThis.__data.vitalCandidates) ? globalThis.__data.vitalCandidates(domain, rcaEvent) : [];
  })();

  const onSelectError = (ev) => { setSelectedError(ev); setTab('根因'); };
  const onAnalyzeInp = () => setTab('根因');
  const onClear = async () => { if (!globalThis.__inpDb) return; if (!confirm('确认清空所有 IndexedDB 数据？此操作不可撤销。')) return; for (const s of globalThis.__inpDb.STORES) await globalThis.__inpDb.clear(s); if (globalThis.__data) globalThis.__data.clearEventsCache(); setEventCount(0); };
  // P4 分享重现:生成现场(根因+事件+重放)→ 链接/文件;导入还原
  const generateShare = async () => {
    const D = globalThis.__data, S = globalThis.__share;
    if (!D || !S) { setShareOut({ error: '引擎未就绪' }); return; }
    const scene = await D.buildScene(rca, {});
    setShareOut(S.encodeScene(scene));
  };
  const importRepro = async (text) => {
    const D = globalThis.__data, S = globalThis.__share;
    if (!D || !S) { setImportOut({ error: '引擎未就绪' }); return; }
    const scene = S.decodeLink(text) || S.decodeFile(text);
    if (!scene) { setImportOut({ error: '解析失败(非有效链接/文件)' }); return; }
    const r = await D.importScene(scene);
    setImportOut(Object.assign({ ok: true, hasHeap: !!scene.hasHeap }, r));
    const c = await globalThis.__data.count().catch(() => 0); setEventCount(c);
  };

  // 路由
  const tabs = TABS[domain];
  let panel;
  if (domain === 'overview') panel = el(OverviewPanel, { live, onDrill: switchDomain });
  else if (tab === '实时' && VITALS.includes(domain)) panel = domain === 'memory' ? el(MemoryPanel, { data: realtime, onAnalyze: onAnalyzeInp }) : el(VitalRealtimePanel, { signal: domain, data: realtime, onAnalyze: onAnalyzeInp });
  else if (tab === '错误流') panel = el(ErrorStreamPanel, { onSelectError });
  else if (tab === '根因') panel = el(RootCauseView, { signal: domain === 'error' ? 'error' : domain, data: rca, event: rcaEvent, getLiveInteractions: () => (liveRef.current?.interactions || []), onHeal: () => setTab('自愈'), onMr: () => setTab('MR'), onCopyStack: () => { try { navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(selectedError || live.inp || live.vitals || {}, null, 2)); } catch {} }, onFeedback: (eventId, sig, kind, which) => { if (globalThis.__data && globalThis.__data.recordFeedback) globalThis.__data.recordFeedback(eventId, sig, kind, which); } });
  else if (tab === '自愈') panel = el(HealPanel, { domain, live, appliedTokens, setAppliedTokens });
  else if (tab === 'MR') panel = el(MrPanel, { candidates: candidatesForMr, appliedTokens });
  else if (tab === '历史') panel = el(HistoryPanel, { onClear, eventCount });
  else if (tab === '设置') panel = el(SettingsPanel, { eventCount, settings, onSave: saveSettings, onClear, onGenerateShare: generateShare, onImport: importRepro, shareOut, importOut, llmConfig, onSaveLlm: saveLlm, onPreflight: preflightLlm, preflightResult });
  else panel = el(Txt, { content: tab, size: 11, fill: 'var(--fg-3)' });

  return el(Shell, { chromeOk, route: fmtHost(live.host) || live.route || '(no active tab)', session: live.sessionMeta || 'sess · 0m', brand: BRAND[domain], domain, setDomain: switchDomain, tabs, tab, setTab, eventCount }, panel);
}

createRoot(document.getElementById('root')).render(el(App));
