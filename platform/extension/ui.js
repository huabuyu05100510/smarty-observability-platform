// ui.js · 共享 UI 原子（React.createElement，渲染到真实 HTML/CSS，变量来自 sidepanel.html :root）
// 用法：el / Row / Col / Txt / Icon / Card / Stat / Stacked / Legend / Pill / Gauge / Code / Actions / Tag ...
// 模式注意：原子组件以 Row({...}, child) 直接调用（非 el(Row, ...)）以省 reconciliation，故用 flatKids
// 手动剔 legacyContext。⚠️ 所有原子组件不得使用 hooks（useState/useEffect 等）——会绕过 React hook 校验、
// 破坏 Rules of Hooks。原子保持纯展示；需要状态请用 el(Component) 正规组件（如各 *Panel）。
(function (global) {
  const el = React.createElement;
  global.el = el;

  // tone → CSS 变量（good/warn/bad/info/accent/fg/fg-2/fg-3）
  const V = (t) => `var(--${t})`;
  const SOFT_TONES = new Set(['good', 'warn', 'bad', 'info', 'accent']);
  const SOFT = (t) => SOFT_TONES.has(t) ? `var(--${t}-soft)` : 'var(--surface-3)';
  global.__toneVar = V;
  global.__toneSoft = SOFT;

  // 把 children 规范成扁平数组。注意：React 渲染函数组件时会以 (props, legacyContext) 调用，
  // 那个 context 是裸对象 {}，必须剔除（否则当成 child 渲染 → React #31）。
  const isChild = (c) => c === null || c === false || c === true || typeof c === 'string' || typeof c === 'number' || Array.isArray(c) || (c && typeof c === 'object' && c.$$typeof !== undefined);
  function flatKids(children) {
    const out = [];
    const add = (c) => { if (c == null || c === false || c === true) return; if (Array.isArray(c)) { c.forEach(add); return; } if (typeof c === 'object' && c.$$typeof === undefined) return; out.push(c); };
    add(children);
    return out;
  }
  // 取子节点：优先 props.children（React 渲染路径），否则取直接调用时的位置参数（去掉 React context）
  const kidsOf = (p, rest) => flatKids(p.children !== undefined ? p.children : rest.filter(isChild));
  global.flatKids = flatKids;

  // ---------- 容器 ----------
  function Row(p = {}, ...rest) {
    const { gap, align, justify, fill, pad, bg, stroke, sw, radius, clip, style, onClick, className, title } = p;
    const children = kidsOf(p, rest);
    return el('div', {
      key: p.key,
      className,
      title,
      onClick,
      style: Object.assign({
        display: 'flex', flexDirection: 'row', alignItems: align, justifyContent: justify,
        gap, padding: pad, background: bg, border: stroke ? `${sw || 1}px solid ${stroke}` : undefined,
        borderRadius: radius, overflow: clip ? 'hidden' : undefined,
        flex: fill === true ? 1 : undefined, minWidth: fill === true ? 0 : undefined,
      }, style || {}),
    }, ...children);
  }
  function VCol(p = {}, ...rest) {
    const { gap, align, justify, fill, pad, bg, stroke, sw, radius, clip, style, onClick, className } = p;
    const children = kidsOf(p, rest);
    return el('div', {
      key: p.key,
      className, onClick,
      style: Object.assign({
        display: 'flex', flexDirection: 'column', alignItems: align, justifyContent: justify,
        gap, padding: pad, background: bg, border: stroke ? `${sw || 1}px solid ${stroke}` : undefined,
        borderRadius: radius, overflow: clip ? 'hidden' : undefined,
        flex: fill === true ? 1 : undefined, minHeight: fill === true ? 0 : undefined,
      }, style || {}),
    }, ...children);
  }
  global.Row = Row; global.Col = VCol;

  // 占位伸缩
  function Sep({ w, h }) {
    return el('div', { style: { flex: 1, height: h || 1, width: w || 1, minWidth: 0 } });
  }
  global.Sep = Sep;

  // ---------- 文本 ----------
  function Txt(p = {}) {
    const { content, mono, size = 11, weight = 'normal', fill = 'var(--fg-2)', ls, lh, wrap, grow, width, align, title, onClick, style } = p;
    const s = {
      fontFamily: mono ? "var(--font-mono)" : "var(--font-ui)",
      fontSize: size, fontWeight: weight, color: fill,
      letterSpacing: ls, lineHeight: lh,
      textAlign: align,
      flex: grow ? 1 : undefined, minWidth: grow ? 0 : undefined,
      cursor: onClick ? 'pointer' : undefined,
    };
    if (wrap) { s.whiteSpace = 'normal'; s.width = width || '100%'; s.overflowWrap = 'anywhere'; }
    else { s.whiteSpace = 'nowrap'; s.overflow = 'hidden'; s.textOverflow = 'ellipsis'; if (width) s.maxWidth = width; }
    return el('span', { title, onClick, style: Object.assign(s, style || {}) }, content);
  }
  global.Txt = Txt;

  // ---------- 小元素 ----------
  function Dot({ tone = 'fg-3', size = 7, style }) {
    return el('span', { style: Object.assign({ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: V(tone), flex: '0 0 auto' }, style || {}) });
  }
  global.Dot = Dot;

  function Pill(p = {}) {
    const { tone = 'accent', label, soft = true, border = false, weight = '600', size = 8.5, pad = '2px 6px', radius = 3, ls, style, onClick } = p;
    const fillC = border ? V(tone) : V(tone);
    return el('span', {
      onClick,
      style: Object.assign({
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: pad, borderRadius: radius,
        background: soft ? SOFT(tone) : V(tone),
        color: soft ? V(tone) : 'var(--bg)',
        border: border ? `1px solid ${V(tone)}` : undefined,
        fontFamily: 'var(--font-mono)', fontSize: size, fontWeight: weight, letterSpacing: ls,
        whiteSpace: 'nowrap', cursor: onClick ? 'pointer' : undefined,
      }, style || {}),
    }, label);
  }
  global.Pill = Pill;

  function Tag({ tone = 'fg-3', label }) {
    return el('span', {
      style: {
        display: 'inline-flex', padding: '2px 6px', borderRadius: 3,
        background: SOFT(tone), color: V(tone), border: `1px solid ${V(tone)}`,
        fontFamily: 'var(--font-mono)', fontSize: 8.5, fontWeight: 500, whiteSpace: 'nowrap',
      },
    }, label);
  }
  function Tags({ items = [], gap = 5 }) {
    return Row({ gap, fill: true, style: { flexWrap: 'wrap' } }, items.map((t, i) =>
      el(Tag, { key: i, tone: t.tone, label: t.label })));
  }
  global.Tag = Tag; global.Tags = Tags;

  // ---------- 卡片 ----------
  // variant: 'title'(font-ui 11.5/600 fg) | 'label'(font-mono 8.5 fg-3 letterspaced)
  function Head(p = {}) {
    const { icon, iconFill = 'var(--accent)', iconSize = 12, title, titleTone = 'fg', variant = 'title', meta, metaMono = true } = p;
    const titleNode = variant === 'label'
      ? el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-3)', letterSpacing: 0.6, textTransform: 'uppercase' } }, title)
      : el('span', { style: { fontFamily: 'var(--font-ui)', fontSize: 11.5, fontWeight: 600, color: V(titleTone) } }, title);
    return Row({ gap: 6, align: 'center', fill: true },
      icon && el(Icon, { name: icon, size: iconSize, fill: iconFill }),
      titleNode,
      el(Sep),
      meta && el('span', { style: { fontFamily: metaMono ? 'var(--font-mono)' : 'var(--font-ui)', fontSize: 9, color: 'var(--fg-3)', whiteSpace: 'nowrap' } }, meta),
    );
  }
  global.Head = Head;

  function Card(p = {}, ...rest) {
    const { icon, iconFill, title, variant, meta, head, stroke = 'var(--border)', bg = 'var(--surface)', pad = 10, gap = 8, radius = 5, headGap = 8, style, onClick } = p;
    const children = kidsOf(p, rest);
    const headEl = head || ((title || icon) ? el(Head, { icon, iconFill, title, variant, meta }) : null);
    return el('div', {
      onClick,
      style: Object.assign({
        display: 'flex', flexDirection: 'column', gap: headEl ? headGap : gap,
        padding: pad, background: bg, border: `1px solid ${stroke}`, borderRadius: radius,
        cursor: onClick ? 'pointer' : undefined,
      }, style || {}),
    },
      headEl,
      headEl && children.length ? el('div', { style: { display: 'flex', flexDirection: 'column', gap } }, ...children) : null,
      ...(!headEl ? children : []),
    );
  }
  global.Card = Card;

  // ---------- 统计 ----------
  function Stat(p = {}) {
    const { label, value, unit, meta, tone, size = 18, mono = true, pad = 8, bg = 'var(--surface)' } = p;
    return VCol({ gap: 3, pad, bg, fill: true, style: { borderRadius: 4 } },
      el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-3)', letterSpacing: 0.3 } }, label),
      Row({ gap: 4, align: 'end' },
        el('span', { style: { fontFamily: mono ? 'var(--font-mono)' : 'var(--font-ui)', fontSize: size, fontWeight: 600, color: tone ? V(tone) : 'var(--fg)', lineHeight: 1 } }, value),
        unit && el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: size * 0.55, color: 'var(--fg-3)', paddingBottom: 2 } }, unit),
      ),
      meta && el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8.5, color: 'var(--fg-3)' } }, meta),
    );
  }
  global.Stat = Stat;

  // 拼接 Stat 行（1px gap，border 背景模拟网格分割）
  function StatRow({ items, gap = 1, bg = 'var(--border)' }) {
    return Row({ gap, fill: true, style: { background: bg, borderRadius: 4, overflow: 'hidden' } },
      items.map((it, i) => {
        const node = el(Stat, Object.assign({ key: i }, it, { pad: it.pad || 8, bg: it.bg || 'var(--surface-2)' }));
        return node;
      }));
  }
  global.StatRow = StatRow;

  // ---------- 堆叠条 ----------
  function Stacked({ segs = [], height = 22, gap = 2, radius = 3 }) {
    const total = segs.reduce((s, x) => s + (x.value || 0), 0) || 1;
    return Row({ gap, style: { height, width: '100%', borderRadius: radius, overflow: 'hidden', background: 'var(--surface-3)' } },
      segs.filter(s => s.value > 0).map((s, i) => el('div', {
        key: i, style: { width: (s.value / total * 100) + '%', height: '100%', background: V(s.color), minWidth: s.value > 0 ? 2 : 0 },
      })));
  }
  global.Stacked = Stacked;

  function Legend(p = {}) {
    const { swatch = 'accent', label, value, pct, labelTone = 'fg-2', shape = 'rect' } = p;
    return Row({ gap: 7, align: 'center', fill: true },
      shape === 'dot'
        ? el(Dot, { tone: swatch, size: 7 })
        : el('span', { style: { width: 7, height: 7, background: V(swatch), borderRadius: 1, flex: '0 0 auto' } }),
      el(Txt, { content: label, size: 10, fill: V(labelTone), grow: true }),
      value != null && el(Txt, { content: value, mono: true, size: 10, weight: 600, fill: 'var(--fg)' }),
      pct != null && el(Txt, { content: pct, mono: true, size: 9, fill: 'var(--fg-3)', style: { width: 36, textAlign: 'right' } }),
    );
  }
  global.Legend = Legend;

  // ---------- 圆环 gauge ----------
  function Gauge(p = {}) {
    const { pct = 0, size = 74, stroke = 7, tone = 'bad', label, value } = p;
    const r = size / 2 - stroke / 2;
    const circ = 2 * Math.PI * r;
    const fillFrac = Math.max(0, Math.min(1, pct));
    return el('div', { style: { position: 'relative', width: size, height: size, flex: '0 0 auto' } },
      el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, style: { transform: 'rotate(-90deg)' } },
        el('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--surface-3)', strokeWidth: stroke }),
        el('circle', {
          cx: size / 2, cy: size / 2, r, fill: 'none', stroke: V(tone), strokeWidth: stroke, strokeLinecap: 'round',
          strokeDasharray: circ, strokeDashoffset: circ * (1 - fillFrac),
        }),
      ),
      el('div', { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 } },
        label && el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8, color: 'var(--fg-3)', letterSpacing: 0.3 } }, label),
        value != null && el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700, color: 'var(--fg)' } }, value),
      ),
    );
  }
  global.Gauge = Gauge;

  function ConfBar({ v = 0, width = 80, tone = 'good' }) {
    const w = Math.max(0, Math.min(1, v));
    return el('div', { style: { width, height: 4, background: 'var(--surface-3)', borderRadius: 2, overflow: 'hidden' } },
      el('div', { style: { width: (w * 100) + '%', height: '100%', background: V(w >= 0.7 ? 'good' : w >= 0.5 ? 'warn' : 'fg-3') } }));
  }
  global.ConfBar = ConfBar;

  // ---------- 代码块 ----------
  function CodeLine(p = {}) {
    const { n, code, hl, tone } = p;
    return Row({ gap: 10, align: 'center', pad: '3px 8px', bg: hl ? 'var(--bad-soft)' : undefined,
      style: Object.assign({ borderBottom: '1px solid var(--border-2, #15151a)' },
        hl ? { borderLeft: '2px solid var(--bad)', borderTop: '1px solid var(--bad)', borderBottom: '1px solid var(--bad)' } : {}) },
      el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 8.5, color: hl ? 'var(--bad)' : 'var(--fg-3)', fontWeight: hl ? 600 : 'normal', width: 18, flex: '0 0 auto', textAlign: 'right' } }, n),
      el('span', { style: { fontFamily: 'var(--font-mono)', fontSize: 9, color: hl ? 'var(--fg)' : 'var(--fg-2)', fontWeight: hl ? 600 : 'normal', whiteSpace: 'pre' } }, code),
    );
  }
  function CodeBlock({ lines = [], annotation, tone = 'bad' }) {
    return VCol({ gap: 0, style: { background: '#0D0D10', border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' } },
      el('div', { style: { display: 'flex', flexDirection: 'column' } },
        lines.map((l, i) => el(CodeLine, { key: i, n: l.n, code: l.code, hl: l.hl }))),
      annotation && Row({ gap: 7, pad: 8, align: 'flex-start',
        bg: SOFT(tone), style: { borderTop: `1px solid ${V(tone)}` } },
        el(Icon, { name: 'alert-circle', size: 11, fill: V(tone) }),
        el(Txt, { content: annotation, size: 9, fill: 'var(--fg-2)', wrap: true, width: '100%', lh: 1.55, grow: true }),
      ),
    );
  }
  global.CodeLine = CodeLine; global.CodeBlock = CodeBlock;

  // ---------- 操作按钮行 ----------
  function Btn(p = {}) {
    const { tone = 'accent', variant = 'primary', icon, label, onClick, disabled, fill, size = 11, weight = 600 } = p;
    const isGhost = variant === 'ghost';
    const bg = isGhost ? 'var(--surface-3)' : V(tone);
    const color = isGhost ? 'var(--fg-2)' : 'var(--bg)';
    return el('button', {
      onClick, disabled,
      style: {
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        flex: fill ? 1 : undefined, padding: '8px 10px', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer',
        background: bg, color, border: isGhost ? '1px solid var(--border-strong)' : 'none',
        fontFamily: 'var(--font-ui)', fontSize: size, fontWeight: weight, opacity: disabled ? 0.6 : 1,
      },
    },
      icon && el(Icon, { name: icon, size: 12, fill: color }),
      label,
    );
  }
  global.Btn = Btn;

  function Actions({ primary, primaryIcon, onPrimary, primaryDisabled, ghost, ghostIcon, onGhost, ghostDisabled, gap = 7 }) {
    return Row({ gap, fill: true },
      primary && el(Btn, { tone: 'accent', label: primary, icon: primaryIcon, onClick: onPrimary, disabled: primaryDisabled, fill: true }),
      ghost && el(Btn, { variant: 'ghost', label: ghost, icon: ghostIcon, onClick: onGhost, disabled: ghostDisabled, fill: !primary }),
    );
  }
  global.Actions = Actions;

  // ---------- 趋势柱 ----------
  function Bars({ items = [], height = 56, gap = 1, pad = '4px 0 6px' }) {
    return el('div', { style: { display: 'flex', alignItems: 'flex-end', gap, height, padding: pad, background: 'var(--surface-2)', borderRadius: 4 } },
      items.map((b, i) => el('div', { key: i, style: { flex: 1, height: Math.max(2, b.h), background: V(b.color || 'info'), borderRadius: '1px 1px 0 0' } })));
  }
  global.Bars = Bars;

  // mono 行（key/value 对）
  function KV({ k, v, vTone, gap = 8 }) {
    return Row({ gap, align: 'center', fill: true },
      el(Txt, { content: k, size: 10, fill: 'var(--fg-3)' }),
      el(Sep),
      el(Txt, { content: v, mono: true, size: 10, weight: 500, fill: vTone ? V(vTone) : 'var(--fg)' }),
    );
  }
  global.KV = KV;
})(typeof globalThis !== 'undefined' ? globalThis : self);
