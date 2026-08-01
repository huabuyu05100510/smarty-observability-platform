// overlay.js · 页面内悬浮面板：注入 Shadow DOM 外壳 + iframe 载入 sidepanel.html（复用整套 UI + 真实数据 + sourcemap）。
// fixed 高 z-index 压在页面之上；可拖拽 / 缩放 / 最小化为 chip；位置与开关持久（chrome.storage）。
// 由 toolbar 图标 toggle（background → TOGGLE_OVERLAY），或记忆上次开关状态自动恢复（「一直存在」）。
(function () {
  if (window.__vcOverlayInit) return; window.__vcOverlayInit = true;
  const W = 420, H = 600;
  const PANEL_URL = (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('sidepanel.html') : '';
  const css = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .shell { width: 100%; background: #0A0A0A; border: 1px solid #3F3F46; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.6); overflow: hidden; font-family: 'Geist', -apple-system, system-ui, sans-serif; color: #fff; z-index: 0; }
    .resize { resize: both; overflow: hidden; min-width: 320px; max-width: 92vw; max-height: 92vh; }
    .bar { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: #17171A; border-bottom: 1px solid #27272A; cursor: move; user-select: none; }
    .grip { color: #71717A; font-size: 13px; letter-spacing: -2px; } .logo { color: #A855F7; font-size: 13px; }
    .title { font-size: 11.5px; font-weight: 600; letter-spacing: .8px; } .spacer { flex: 1; }
    .btn { background: #1F1F23; border: 1px solid #27272A; color: #A1A1AA; width: 20px; height: 20px; border-radius: 4px; cursor: pointer; font-size: 12px; line-height: 1; display: flex; align-items: center; justify-content: center; padding: 0; }
    .btn:hover { border-color: #3F3F46; color: #fff; }
    .frame-wrap { width: 100%; height: ${H}px; background: #0A0A0A; }
    .frame { width: 100%; height: 100%; border: 0; display: block; }
    .chip { display: none; align-items: center; gap: 6px; padding: 8px 12px; background: #17171A; border: 1px solid #A855F7; border-radius: 20px; color: #A855F7; cursor: pointer; font-size: 11px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,.5); }
    .shell.collapsed .resize { display: none; } .shell.collapsed .chip { display: inline-flex; }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: #22C55E; }
  `;

  let host = null, shell = null, frame = null;
  const KEY = 'overlayState';

  async function getState() { try { const r = await chrome.storage.local.get(KEY); return r[KEY] || {}; } catch { return {}; } }
  async function setState(patch) { try { const cur = await getState(); await chrome.storage.local.set({ [KEY]: Object.assign({}, cur, patch) }); } catch {} }

  function mount() {
    if (host) { host.style.display = ''; return; }
    host = document.createElement('div');
    // host 是定位容器(给宽高、被拖拽移动);shell 改填满 host → 移动/缩放 host 即移动面板。
    host.style.cssText = `all: initial; position: fixed; top: 80px; right: 16px; width: ${W}px; z-index: 2147483647;`;
    const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    shadow.innerHTML = `
      <style>${css}</style>
      <div class="shell" part="shell">
        <div class="resize">
          <div class="bar" id="bar">
            <span class="grip">⋮⋮</span><span class="logo">◆</span><span class="title">VITALS COPILOT</span>
            <span class="live-dot"></span><span class="spacer"></span>
            <button class="btn" id="min" title="最小化">—</button>
            <button class="btn" id="x" title="关闭">✕</button>
          </div>
          <div class="frame-wrap"><iframe class="frame" id="frame" src="${PANEL_URL}" title="Vitals Copilot"></iframe></div>
        </div>
        <div class="chip" id="chip"><span class="logo">◆</span> COPILOT</div>
      </div>`;
    (document.body || document.documentElement).appendChild(host);
    shell = shadow.querySelector('.shell');
    frame = shadow.querySelector('#frame');
    const bar = shadow.querySelector('#bar');
    const min = shadow.querySelector('#min');
    const x = shadow.querySelector('#x');
    const chip = shadow.querySelector('#chip');
    getState().then((st) => {
      if (st.top != null) host.style.top = st.top + 'px'; else host.style.top = '80px';
      if (st.left != null) { host.style.left = st.left + 'px'; host.style.right = 'auto'; } else { host.style.left = 'auto'; }
      if (st.right != null && st.left == null) host.style.right = st.right + 'px';
      if (st.collapsed) shell.classList.add('collapsed');
    });
    // 拖拽：仅拖拽期间挂全局 mousemove/mouseup，松手即解绑（避免常驻全局 mousemove 监听的开销）
    let ox = 0, oy = 0;
    const onMove = (e) => {
      const top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - oy));
      const left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox));
      host.style.top = top + 'px'; host.style.left = left + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const r = host.getBoundingClientRect(); setState({ top: r.top, left: r.left, right: null });
    };
    bar.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = host.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top;
      host.style.right = 'auto'; e.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    // 最小化 / chip 展开
    const setCollapsed = (c) => { shell.classList.toggle('collapsed', c); setState({ collapsed: c }); };
    min.addEventListener('click', () => setCollapsed(true));
    chip.addEventListener('click', () => setCollapsed(false));
    x.addEventListener('click', () => { host.style.display = 'none'; setState({ open: false }); });
  }

  function toggle() {
    if (host && host.style.display !== 'none') { host.style.display = 'none'; setState({ open: false }); }
    else { mount(); setState({ open: true }); }
  }

  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'TOGGLE_OVERLAY') toggle(); return false; });
  // 记忆：上次开着则本页自动恢复（「一直存在」）
  getState().then((st) => { if (st.open) mount(); });
})();
