/**
 * @monit/collector/white-screen - 白屏检测 + 因果归因（白屏支柱）
 *
 * 业界范式（monitor-sdk / 阿里 ARMS / 字节 Slardar）：页面加载后采样 N 个视口点，
 * 用 elementsFromPoint 判断各点是否有真实内容（非 body/html 容器），validRatio 低于阈值即白屏。
 *
 * 本模块在此基础上做**白屏类型分类 + 因果归因**（多数工具只判"是否白屏"）：
 * - blank_dom：body 无有意义内容
 * - crashed_render：窗口内有 JS 渲染错误（按时序关联具体 error）
 * - critical_resource_blocked：关键 CSS/JS 404（按时序关联具体资源）
 * - route_404：SPA 路由切换后无内容
 *
 * 因果归因 = 按时序找白屏发生前最近的 error/resource，而非笼统 recentErrors。
 */

import type { WhiteScreenDetection, WhiteScreenType } from '@monit/contracts';

export interface WhiteScreenContext {
  /** 近期错误（用于因果归因；collector 喂入）*/
  recentErrors: () => Array<{ id?: string; message: string; source?: string; type?: string; timestamp: number }>;
  /** 近期失败资源（用于因果归因）*/
  failedResources: () => Array<{ url: string; tagName: string; timestamp: number }>;
}

export interface WhiteScreenCallbacks {
  onDetect: (d: WhiteScreenDetection) => void;
}

export interface WhiteScreenOptions {
  preset?: '9' | '17' | '33';
  /** 加载后延迟采样 ms，默认 1500（等首屏渲染）*/
  samplingDelayMs?: number;
  /** 因果归因时间窗 ms，默认 10s */
  causalWindowMs?: number;
  /** 重复检测最小间隔 ms，默认 30s（防抖）*/
  debounceMs?: number;
  context?: WhiteScreenContext;
}

const PRESET_POINTS: Record<'9' | '17' | '33', number> = { '9': 9, '17': 17, '33': 33 };
const PRESET_THRESHOLD: Record<'9' | '17' | '33', number> = { '9': 0.1, '17': 0.1, '33': 0.1 };

/** 生成视口内网格采样点（中心偏移，避开边缘）*/
function samplePoints(count: number): Array<{ x: number; y: number }> {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const h = typeof window !== 'undefined' ? window.innerHeight : 800;
  const cols = Math.ceil(Math.sqrt(count * (w / h)));
  const rows = Math.ceil(count / cols);
  const pts: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (pts.length >= count) break;
      pts.push({
        x: Math.round((w * (c + 0.5)) / cols),
        y: Math.round((h * (r + 0.5)) / rows),
      });
    }
  }
  return pts;
}

/** 某点是否有真实内容（top 元素非 body/html/document）*/
function pointHasContent(x: number, y: number): boolean {
  if (typeof document === 'undefined' || !document.elementsFromPoint) return true;
  const stack = document.elementsFromPoint(x, y);
  if (stack.length === 0) return false;
  const top = stack[0];
  const tag = top.tagName?.toLowerCase();
  // body/html/documentElement = 容器，无内容
  return tag !== 'body' && tag !== 'html';
}

/** body 是否完全空（无元素子节点 + 无文本）*/
function isBodyBlank(): boolean {
  if (typeof document === 'undefined') return true;
  const body = document.body;
  if (!body) return true;
  if (body.childElementCount === 0 && (body.textContent ?? '').trim().length === 0) return true;
  return false;
}

/**
 * 白屏分类 + 因果归因（纯函数，便于测试）。detectWhiteScreen 的核心。
 */
export function classifyWhiteScreen(
  validRatio: number,
  preset: '9' | '17' | '33',
  ctx: WhiteScreenContext,
  now: number,
  causalWindowMs = 10_000,
): WhiteScreenDetection {
  const threshold = PRESET_THRESHOLD[preset];
  const detected = validRatio < threshold;
  const windowStart = now - causalWindowMs;

  const recentErrors = ctx.recentErrors();
  const failedResources = ctx.failedResources();
  const errorsInWindow = recentErrors.filter(e => e.timestamp >= windowStart);
  const resourcesInWindow = failedResources.filter(r => r.timestamp >= windowStart);
  const lastError = errorsInWindow.sort((a, b) => b.timestamp - a.timestamp)[0];
  const lastResource = resourcesInWindow.sort((a, b) => b.timestamp - a.timestamp)[0];

  let type: WhiteScreenType = 'unknown';
  let rootCause: WhiteScreenDetection['rootCause'] = 'unknown';
  let causalErrorId: string | undefined;
  let causalResourceUrl: string | undefined;

  if (detected) {
    const criticalResource = lastResource && ['script', 'link'].includes(lastResource.tagName.toLowerCase());
    if (criticalResource) {
      type = 'critical_resource_blocked';
      rootCause = 'resource_404';
      causalResourceUrl = lastResource.url;
    } else if (lastError) {
      type = 'crashed_render';
      rootCause = 'js_error';
      causalErrorId = lastError.id;
    } else if (isBodyBlank()) {
      type = 'blank_dom';
      rootCause = 'unknown';
    } else {
      type = 'route_404';
      rootCause = 'unknown';
    }
  }

  return {
    detected,
    type,
    validRatio,
    threshold,
    preset,
    rootCause,
    causalErrorId,
    causalResourceUrl,
    recentErrors: errorsInWindow.slice(-5).map(e => ({ message: e.message, source: e.source, type: e.type })),
    failedResources: resourcesInWindow.slice(-5).map(r => ({ url: r.url, tagName: r.tagName })),
    timestamp: now,
  };
}

/**
 * 主动探测一次白屏。返回检测结果（detected=false 也返回，便于调试）。
 */
export function detectWhiteScreen(
  ctx: WhiteScreenContext,
  opts: WhiteScreenOptions = {},
  now = Date.now(),
): WhiteScreenDetection {
  const preset = opts.preset ?? '17';
  const causalWindowMs = opts.causalWindowMs ?? 10_000;
  const points = samplePoints(PRESET_POINTS[preset]);

  let valid = 0;
  for (const p of points) if (pointHasContent(p.x, p.y)) valid++;
  const validRatio = points.length > 0 ? valid / points.length : 0;

  return classifyWhiteScreen(validRatio, preset, ctx, now, causalWindowMs);
}

/**
 * 安装白屏检测：加载后延迟采样 + 可选 visibilitychange 复检。
 * 检测到白屏（且过 debounce）才回调 onDetect。
 */
export function installWhiteScreen(cb: WhiteScreenCallbacks, opts: WhiteScreenOptions = {}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const ctx: WhiteScreenContext = opts.context ?? {
    recentErrors: () => [],
    failedResources: () => [],
  };
  const debounceMs = opts.debounceMs ?? 30_000;
  let lastDetectTs = 0;

  const run = () => {
    const now = Date.now();
    if (now - lastDetectTs < debounceMs) return;
    const d = detectWhiteScreen(ctx, opts, now);
    if (d.detected) {
      lastDetectTs = now;
      cb.onDetect(d);
    }
  };

  const timer = setTimeout(run, opts.samplingDelayMs ?? 1500);
  const onVis = () => {
    if (document.visibilityState === 'visible') run();
  };
  document.addEventListener('visibilitychange', onVis);

  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVis);
  };
}
