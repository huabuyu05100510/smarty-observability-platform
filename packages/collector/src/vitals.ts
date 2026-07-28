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
          cb.onVital({ name: 'LCP', value: entry.startTime, rating: ratingForLcp(entry.startTime) });
        }
      }
    });
    po.observe({ type: 'paint', buffered: true });
    po.observe({ type: 'largest-contentful-paint', buffered: true });
    cleanups.push(() => po.disconnect());
  } catch { /* unsupported */ }

  // CLS（累积 layout-shift）
  try {
    let clsValue = 0;
    const po = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const ls = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!ls.hadRecentInput && typeof ls.value === 'number') {
          clsValue += ls.value;
        }
      }
      cb.onVital({ name: 'CLS', value: clsValue, rating: ratingForCls(clsValue) });
    });
    po.observe({ type: 'layout-shift', buffered: true });
    cleanups.push(() => po.disconnect());
  } catch { /* unsupported */ }

  // TTFB（navigation）
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    if (nav) {
      cb.onVital({ name: 'TTFB', value: nav.responseStart, rating: ratingForLcp(nav.responseStart) });
    }
  } catch { /* unsupported */ }

  // LoAF buffer（与 INP 交叉）
  const loafBuffer: LoafBufferEntry[] = [];
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

  // INP（event，取最差交互，含 LoAF 归因）
  try {
    let worstInp = 0;
    let worstEntry: PerformanceEventTiming | null = null;
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

    // 在 visibilitychange hidden 时上报最差 INP（web-vitals 范式）
    const onHidden = () => {
      if (document.visibilityState === 'hidden' && worstEntry) {
        const attribution = buildInpAttribution(worstEntry, loafBuffer);
        cb.onInp(attribution);
        cb.onVital({ name: 'INP', value: attribution.value, rating: attribution.rating });
      }
    };
    document.addEventListener('visibilitychange', onHidden);
    cleanups.push(() => {
      po.disconnect();
      document.removeEventListener('visibilitychange', onHidden);
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