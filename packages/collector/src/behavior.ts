/**
 * @monit/collector/behavior - 行为沮丧信号采集（行为支柱）
 *
 * 业界范式（LogRocket / FullStory / Hotjar）：用户沮丧信号是行为可观测的核心，
 * 比"录了什么"更进一步回答"用户是否受挫"。经典三件套：
 * - rage_click：短时间内在同一元素连续点击 N 次（按钮没反应/报错，用户狂点）
 * - dead_click：点击了不可交互区域（无 handler 的元素），UI 无响应
 * - erratic_mouse：鼠标频繁变向（焦躁来回移动）
 *
 * 产出 FrustrationSignal（type='behavior' 事件）。repeated_error / frustrated_nav
 * 由后端从事件流聚合（同一指纹短时多次 / 快速来回路由）。
 */

import type { FrustrationSignal, FrustrationKind } from '@monit/contracts';

export interface BehaviorCallbacks {
  onFrustration: (signal: FrustrationSignal) => void;
}

export interface BehaviorOptions {
  /** rage click 触发次数，默认 3 */
  rageClickCount?: number;
  /** rage click 时间窗 ms，默认 1000 */
  rageClickWindowMs?: number;
  /** erratic mouse 变向次数阈值，默认 8 */
  erraticThreshold?: number;
  /** erratic mouse 时间窗 ms，默认 1500 */
  erraticWindowMs?: number;
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'summary']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'combobox']);

function describeSelector(el: Element): string {
  const tag = el.tagName?.toLowerCase() ?? 'unknown';
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}` : '';
  return `${tag}${id}${cls}`;
}

function isInteractive(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  if (tag && INTERACTIVE_TAGS.has(tag)) return true;
  const role = el.getAttribute?.('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  if (el.getAttribute?.('onclick')) return true;
  return false;
}

export function installBehavior(cb: BehaviorCallbacks, opts: BehaviorOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const rageCount = opts.rageClickCount ?? 3;
  const rageWindowMs = opts.rageClickWindowMs ?? 1000;
  const erraticThreshold = opts.erraticThreshold ?? 8;
  const erraticWindowMs = opts.erraticWindowMs ?? 1500;

  // rage click：每选择器维护时间戳队列
  const rageMap = new Map<string, number[]>();
  // dead click 防抖：同选择器短时间内只报一次
  const deadDebounce = new Map<string, number>();

  const emit = (kind: FrustrationKind, target: string, count: number, meta?: Record<string, unknown>) => {
    cb.onFrustration({ kind, target, count, timestamp: Date.now(), ...(meta ? { meta } : {}) });
  };

  const onClick = (e: MouseEvent) => {
    const el = e.target as Element | null;
    if (!el) return;
    const sel = describeSelector(el);
    const now = Date.now();

    // rage click 检测
    const times = (rageMap.get(sel) ?? []).filter(t => now - t < rageWindowMs);
    times.push(now);
    rageMap.set(sel, times);
    if (times.length >= rageCount) {
      emit('rage_click', sel, times.length, { windowMs: rageWindowMs });
      rageMap.set(sel, []); // 重置，避免每次点击都报
    }

    // dead click 检测：点击不可交互元素
    if (!isInteractive(el)) {
      const last = deadDebounce.get(sel) ?? 0;
      if (now - last > rageWindowMs) {
        deadDebounce.set(sel, now);
        emit('dead_click', sel, 1, { tag: el.tagName?.toLowerCase() });
      }
    }
  };

  // erratic mouse：记录近期移动方向，统计变向次数。
  // 限频 + 定长上限：mousemove 高频触发，若每次都 O(n) 扫描且数组无界增长，
  // 会在被监控页主线程造成卡顿（采集器反而拖垮宿主）。采样到 ~25Hz、最多保留 200 样本。
  const MOVE_SAMPLE_MS = 40;
  const MAX_MOVE_SAMPLES = 200;
  const moveDeltas: Array<{ t: number; dx: number; dy: number }> = [];
  let lastX = 0;
  let lastY = 0;
  let lastEmit = 0;
  let lastProcess = 0;
  const onMouseMove = (e: MouseEvent) => {
    const now = Date.now();
    if (lastX === 0 && lastY === 0) { lastX = e.clientX; lastY = e.clientY; lastProcess = now; return; }
    // 限频：未到采样间隔则只更新基准坐标、跳过累加+扫描
    if (now - lastProcess < MOVE_SAMPLE_MS) { lastX = e.clientX; lastY = e.clientY; return; }
    lastProcess = now;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (dx === 0 && dy === 0) return;
    // 裁剪到窗口 + 定长上限
    while (moveDeltas.length > 0 && now - moveDeltas[0].t > erraticWindowMs) moveDeltas.shift();
    moveDeltas.push({ t: now, dx, dy });
    if (moveDeltas.length > MAX_MOVE_SAMPLES) moveDeltas.splice(0, moveDeltas.length - MAX_MOVE_SAMPLES);
    // 统计变向（dx 或 dy 符号反转）
    let reversals = 0;
    for (let i = 1; i < moveDeltas.length; i++) {
      const a = moveDeltas[i - 1], b = moveDeltas[i];
      if ((a.dx > 0 && b.dx < 0) || (a.dx < 0 && b.dx > 0)) reversals++;
      else if ((a.dy > 0 && b.dy < 0) || (a.dy < 0 && b.dy > 0)) reversals++;
    }
    if (reversals >= erraticThreshold && now - lastEmit > erraticWindowMs) {
      lastEmit = now;
      emit('erratic_mouse', 'window', reversals, { windowMs: erraticWindowMs });
      moveDeltas.length = 0;
    }
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('mousemove', onMouseMove, { passive: true } as AddEventListenerOptions);

  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousemove', onMouseMove);
  };
}
