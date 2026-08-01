/**
 * @monit/fingerprint - 错误指纹/分组（双维合并）
 *
 * 合并两套成熟算法：
 * - sentinel-x `fnv1a` + `fingerprintStack(topN=3)`：栈指纹（同一崩溃点）
 * - encode-monitor `djb2` + URL 归一化 + objectOrder：URL/类型指纹（同一接口错误）
 *
 * 双维 {primary, secondary} 兼顾"同一崩溃点"与"同一接口错误"两种聚合需求。
 * 对标：Sentry grouping（栈帧+异常类型+消息模板）/ Bugsnag / Datadog Error Tracking。
 */

import type { ErrorFingerprint } from '@monit/contracts';

// ─── 哈希原语 ─────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit（sentinel-x） */
export function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** djb2（encode-monitor） */
export function djb2(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─── 栈帧归一化（primary 维度） ───────────────────────────────────────────────

/**
 * 剥离栈帧中的动态/易变部分，使"同一根因"落到同一指纹：
 * - 行列号（:line:col）
 * - query string（?xxx）
 * - content-hash（/assets/index-a1b2c3d4.js -> /assets/index-[hash].js）
 * - 绝对路径前缀（保留相对结构）
 */
export function normalizeStackFrame(frame: string): string {
  return frame
    .trim()
    // 去 query string
    .replace(/\?[^:\s]*/g, '')
    // 去 line:col：V8/Chrome 形如 at fn (url:line:col)，Safari/Firefox 形如 fn@url:line:col（无尾括号）。
    // 必须捕获原尾括号并按原样保留——否则会给无括号帧凭空补 ')'，
    // 导致同一崩溃点在 Chrome 与 Firefox/Safari 下落到不同 primary 指纹。
    .replace(/:\d+:\d+(\)?)$/g, '$1')
    .replace(/:\d+:\d+/g, '')
    // content-hash 泛化（8+ hex 段）
    .replace(/-[0-9a-f]{8,}\.(js|mjs|cjs|ts|jsx|tsx)/gi, '-[hash].$1')
    // 绝对路径前缀归一
    .replace(/^(file|https?):\/\/[^/)]+/i, '')
    .trim();
}

/**
 * 栈指纹：取 topN 归一化栈帧，join 后 FNV-1a。
 * topN=3（sentinel-x 默认）：top3 足以区分根因，又忽略深层栈的无关变化。
 */
export function fingerprintStack(stack: string | undefined, topN = 3): string {
  if (!stack) return fnv1a('no-stack');
  const frames = stack
    .split('\n')
    .map(normalizeStackFrame)
    .filter(f => f.length > 0)
    .slice(0, topN);
  if (frames.length === 0) return fnv1a('empty-stack');
  return fnv1a(frames.join('|'));
}

// ─── 消息/URL 归一化（secondary 维度） ─────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUM_RE = /\b\d+\b/g;
const URL_RE = /https?:\/\/[^\s)'"]+/gi;
const QUOTED_RE = /'[^']*'|"[^"]*"/g;

/**
 * 消息归一化：把数字/UUID/URL/引号串泛化为占位符，
 * 使 "Cannot read property 'foo' of null" 与 "...'bar'..." 在同类型下聚合。
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(URL_RE, '<url>')
    .replace(UUID_RE, '<uuid>')
    .replace(QUOTED_RE, '<str>')
    .replace(NUM_RE, '<n>')
    .trim();
}

/**
 * URL/路径归一化：去 query、数字段泛化、content-hash 泛化。
 * /api/users/123/posts?a=1 -> /api/users/<n>/posts
 */
export function normalizeUrl(url: string | undefined): string {
  if (!url) return '<unknown>';
  return url
    // 去 query/hash
    .replace(/[?#].*$/, '')
    // content-hash
    .replace(/-[0-9a-f]{8,}\.(js|mjs|cjs|ts|jsx|tsx)/gi, '-[hash].$1')
    // 数字路径段泛化
    .replace(/\/\d+(?=\/|$)/g, '/<n>')
    .trim();
}

/** object 键排序归一（encode objectOrder）：promise rejection 对象键序无关化 */
export function objectOrder(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return '[' + value.map(objectOrder).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${objectOrder(v)}`);
  return '{' + entries.join(',') + '}';
}

/**
 * URL/类型指纹（secondary）。
 * 组合：归一化消息 + 归一化 URL + errorType，djb2 哈希。
 */
export function fingerprintUrlType(
  message: string,
  url?: string,
  errorType?: string,
): string {
  const parts = [
    normalizeMessage(message),
    normalizeUrl(url),
    errorType ?? 'Error',
  ];
  return djb2(parts.join('||'));
}

// ─── 统一入口 ─────────────────────────────────────────────────────────────────

export interface FingerprintInput {
  message: string;
  stack?: string;
  filename?: string;
  sourceURL?: string;
  errorType?: string;
  /** promise rejection reason（对象时走 objectOrder） */
  reason?: unknown;
}

/**
 * 计算双维错误指纹。
 * primary  = 栈指纹（FNV-1a + top-3 归一化栈帧）-> 同一崩溃点
 * secondary = URL/类型指纹（djb2 + 归一化消息/URL）-> 同一接口/类型错误
 */
export function computeFingerprint(input: FingerprintInput): ErrorFingerprint {
  const primary = fingerprintStack(input.stack);

  // promise rejection 对象走 objectOrder 归一
  const messageForSecondary =
    input.reason !== undefined && typeof input.reason === 'object'
      ? `${input.errorType ?? 'Error'}:${objectOrder(input.reason)}`
      : input.message;

  const secondary = fingerprintUrlType(
    messageForSecondary,
    input.sourceURL ?? input.filename,
    input.errorType,
  );

  return { primary, secondary };
}