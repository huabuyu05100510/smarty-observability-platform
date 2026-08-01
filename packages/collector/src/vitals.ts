/**
 * @monit/collector/vitals - Web Vitals 采集（LCP/CLS/INP/FCP/TTFB + LoAF 归因）
 *
 * 对标 web-vitals v4 + Chrome LoAF（123+）。INP 归因交叉 LoAF，
 * 拆解 inputDelay / processingDuration / presentationDelay。
 * 研究依据：INP 是 2024-03 起唯一稳态响应性 CWV（good≤200ms / poor>500ms）。
 */

import type { VitalMetric, InpAttribution, LoafEntry, LoafScriptFrame } from '@monit/contracts';

export interface VitalsCallbacks {
  onVital: (metric: VitalMetric) => void;
  onInp: (attribution: InpAttribution) => void;
}

interface LoafBufferEntry {
  startTime: number;
  duration: number;
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  firstUIEventTimestamp?: number;
  scripts: unknown[]; // PerformanceScriptTiming 形状，由 PerformanceObserver 提供
}

function ratingForInp(value: number): VitalMetric['rating'] {
  return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor';
}
function ratingForLcp(value: number): VitalMetric['rating'] {
  return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor';
}
function ratingForCls(value: number): VitalMetric['rating'] {
  return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor';
}
function ratingForTtfb(value: number): VitalMetric['rating'] {
  // CWV TTFB 阈值与 LCP 不同：good ≤800ms / NI ≤1800ms / poor >1800ms。
  // 之前误用 ratingForLcp（≤2500 good），会把 2000ms 的 TTFB 误判成 good。
  return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor';
}

/** LCP 元素描述（选择器，便于归因定位）*/
function describeElement(el: Element): string {
  const tag = el.tagName?.toLowerCase() ?? 'unknown';
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string'
    ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}`
    : '';
  return `${tag}${id}${cls}`;
}

/**
 * 安装 Web Vitals 采集。返回 uninstall。
 * 所有 PerformanceObserver 调用做存在性检查，无 API 时静默降级。
 */
export function installVitals(cb: VitalsCallbacks): () => void {
  const cleanups: Array<() => void> = [];

  // FCP / LCP
  try {
    const po = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'paint' && entry.name === 'first-contentful-paint') {
          cb.onVital({ name: 'FCP', value: entry.startTime, rating: ratingForLcp(entry.startTime) });
        } else if (entry.entryType === 'largest-contentful-paint') {
          // LCP 归因：element + url + TTFB/资源加载/渲染拆解（不只给值，给"为什么慢"）
          const lcp = entry as PerformanceEntry & {
            element?: Element;
            url?: string;
            loadTime?: number;
            renderTime?: number;
            responseStart?: number;
          };
          const value = entry.startTime;
          const attribution: Record<string, unknown> = {};
          if (lcp.element) {
            attribution.element = describeElement(lcp.element);
            attribution.elementTag = lcp.element.tagName?.toLowerCase();
          }
          if (lcp.url) attribution.url = lcp.url;
          // LCP 拆解：TTFB 段 / 资源加载段 / 元素渲染段
          const ttfb = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.responseStart ?? 0;
          const resourceLoad = (lcp.loadTime ?? 0) - ttfb;
          const elementRender = value - (lcp.loadTime ?? value);
          attribution.timeToFirstByte = Math.max(0, ttfb);
          attribution.resourceLoadDuration = Math.max(0, resourceLoad);
          attribution.elementRenderDelay = Math.max(0, elementRender);
          cb.onVital({ name: 'LCP', value, rating: ratingForLcp(value), attribution });
        }
      }
    });
    po.observe({ type: 'paint', buffered: true });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
    cleanups.push(() => po.disconnect());
  } catch { /* unsupported */ }

  // 共享终态：标签页隐藏/卸载时一次性上报终态指标（CLS 终值、最差 INP）。
  // 监听 visibilitychange(hidden) + pagehide（关闭/崩溃也兜底），避免长会话或被杀页面永不报。
  let clsValue = 0;
  let clsReported = false;
  let worstInp = 0;
  let worstEntry: PerformanceEventTiming | null = null;
  let inpReported = false;
  const loafBuffer: LoafBufferEntry[] = [];
  const reportOnHide = (): void => {
    if (document.visibilityState !== 'hidden') return;
    if (!clsReported) {
      clsReported = true;
      cb.onVital({ name: 'CLS', value: clsValue, rating: ratingForCls(clsValue) });
    }
    if (!inpReported && worstEntry) {
      inpReported = true;
      const attribution = buildInpAttribution(worstEntry, loafBuffer);
      cb.onInp(attribution);
      cb.onVital({ name: 'INP', value: attribution.value, rating: attribution.rating });
    }
  };

  // CLS（累积 layout-shift）—— 仅累加，终值在隐藏时上报。
  // 之前每次 layout-shift 都上报一次，会刷屏 + 抬高后端 p75（web-vitals 实为终值上报）。
  try {
    const po = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const ls = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!ls.hadRecentInput && typeof ls.value === 'number') {
          clsValue += ls.value;
        }
      }
    });
    po.observe({ type: 'layout-shift', buffered: true });
    cleanups.push(() => po.disconnect());
  } catch { /* unsupported */ }

  // TTFB（navigation）
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      cb.onVital({ name: 'TTFB', value: nav.responseStart, rating: ratingForTtfb(nav.responseStart) });
    }
  } catch { /* unsupported */ }

  // LoAF buffer（与 INP 交叉）
  try {
    const po = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const loaf = entry as unknown as LoafBufferEntry;
        loafBuffer.push(loaf);
        // 仅保留最近 10 条
        if (loafBuffer.length > 10) loafBuffer.shift();
      }
    });
    po.observe({ type: 'long-animation-frame', buffered: true });
    cleanups.push(() => po.disconnect());
  } catch { /* LoAF unsupported on FF/Safari */ }

  // INP（event，取最差交互，含 LoAF 归因）—— 仅记录最差，终值在隐藏时上报
  try {
    const po = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const et = entry as unknown as PerformanceEventTiming;
        const duration = et.duration;
        if (duration > worstInp) {
          worstInp = duration;
          worstEntry = et;
        }
      }
    });
    po.observe({ type: 'event', buffered: true });
    document.addEventListener('visibilitychange', reportOnHide);
    document.addEventListener('pagehide', reportOnHide);
    cleanups.push(() => {
      po.disconnect();
      document.removeEventListener('visibilitychange', reportOnHide);
      document.removeEventListener('pagehide', reportOnHide);
    });
  } catch { /* unsupported */ }

  return () => cleanups.forEach(fn => fn());
}

interface PerformanceEventTiming {
  processingStart: number;
  processingEnd: number;
  startTime: number;
  duration: number;
  target?: Element;
  name?: string;
}

function buildInpAttribution(
  entry: PerformanceEventTiming,
  loafBuffer: LoafBufferEntry[],
): InpAttribution {
  const inputDelay = entry.processingStart - entry.startTime;
  const processingDuration = entry.processingEnd - entry.processingStart;
  const presentationDelay = entry.duration - (entry.processingEnd - entry.startTime);
  const value = entry.duration;

  // 交叉时间窗内的 LoAF
  const intersecting: LoafEntry[] = loafBuffer
    .filter(loaf => loaf.startTime <= entry.startTime + entry.duration && loaf.startTime + loaf.duration >= entry.startTime)
    .map(loaf => ({
      id: `loaf-${loaf.startTime}`,
      startTime: loaf.startTime,
      duration: loaf.duration,
      blockingDuration: loaf.blockingDuration,
      renderStart: loaf.renderStart,
      styleAndLayoutStart: loaf.styleAndLayoutStart,
      firstUIEventTimestamp: loaf.firstUIEventTimestamp,
      scripts: (loaf.scripts ?? []).map((s, i): LoafScriptFrame => ({
        id: `script-${i}`,
        name: (s as { name?: string }).name ?? (s as { invoker?: string }).invoker ?? '<script>',
        invoker: (s as { invoker?: string }).invoker,
        invokerType: (s as { invokerType?: string }).invokerType,
        sourceURL: (s as { sourceURL?: string }).sourceURL,
        sourceFunctionName: (s as { sourceFunctionName?: string }).sourceFunctionName,
        sourceCharPosition: (s as { sourceCharPosition?: number }).sourceCharPosition,
        duration: (s as { duration?: number }).duration ?? 0,
        startTime: (s as { startTime?: number }).startTime ?? 0,
        forcedStyleAndLayoutDuration: (s as { forcedStyleAndLayoutDuration?: number }).forcedStyleAndLayoutDuration,
        pauseDuration: (s as { pauseDuration?: number }).pauseDuration,
      })),
    }));

  return {
    value,
    rating: ratingForInp(value),
    interactionTarget: entry.target ? (entry.target as Element).tagName?.toLowerCase() : entry.name,
    inputDelay,
    processingDuration,
    presentationDelay,
    longAnimationFrameEntries: intersecting,
  };
}