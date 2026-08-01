/**
 * @monit/pii - PII 脱敏
 *
 * 移植自 monitor-sdk/packages/pii（生产级实现）。
 * 默认规则：email / 中国手机号 / 身份证 / AWS·Google·Slack·Stripe·GitHub·OpenAI·Anthropic key / JWT。
 * 自定义：patterns(正则) / fields(字段路径强制脱敏) / fieldMatcher / replacement。
 */

export interface RedactOptions {
  patterns?: RegExp[]
  fields?: string[]
  replacement?: string
  disableDefaults?: boolean
  fieldMatcher?: (path: string, value: unknown) => boolean
}

/** 默认 PII 规则（顺序重要：JWT/token 在 email 前避免误匹配 base64 片段）。
 *  IPv4 默认【不启用】：`\d{1,3}(\.\d{1,3}){3}` 会误伤版本号(1.2.3.4)；如需可通过 patterns 显式追加。 */
export const DEFAULT_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abp]-[0-9A-Za-z-]{10,}\b/g,
  /\b[sp]k_(test_)?[a-z]+_[0-9A-Za-z]{20,}\b/g,
  /\bgh[opsu]_[0-9A-Za-z]{36,}\b/g,
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b1[3-9]\d{9}\b/g,
  /\b0\d{2,3}-?\d{7,8}\b/g, // 座机（010-87654321 / 01087654321）
  /\b\d{17}[\dXx]\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g, // 美国 SSN
  /\b62\d{14,17}\b/g, // 银联银行卡（62 开头 16-19 位）
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
]

export interface RedactReport {
  matched: Record<string, number>
  fields: Array<{ path: string; redacted: boolean }>
}

/** 脱敏任意 payload（递归 walk）。 */
export function redactPayload<T>(input: T, opts: RedactOptions = {}): T {
  const replacement = opts.replacement ?? '[REDACTED]'
  const patterns = opts.disableDefaults ? opts.patterns ?? [] : [...DEFAULT_PATTERNS, ...(opts.patterns ?? [])]
  const report: RedactReport = { matched: {}, fields: [] }
  const fieldSet = new Set(opts.fields ?? [])

  const walk = (value: unknown, path: string): unknown => {
    if (fieldSet.has(path) || (opts.fieldMatcher?.(path, value) ?? false)) {
      if (path !== '') report.fields.push({ path, redacted: true })
      return replacement
    }
    if (typeof value === 'string') return redactString(value, patterns, replacement, report)
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, path ? `${path}.${k}` : k)
      }
      return out
    }
    return value
  }
  return walk(input, '') as T
}

/** 带 report 的脱敏：返回脱敏后 payload + 命中详情。 */
export function redactPayloadWithReport<T>(input: T, opts: RedactOptions = {}): { payload: T; report: RedactReport } {
  const replacement = opts.replacement ?? '[REDACTED]'
  const patterns = opts.disableDefaults ? opts.patterns ?? [] : [...DEFAULT_PATTERNS, ...(opts.patterns ?? [])]
  const report: RedactReport = { matched: {}, fields: [] }
  const fieldSet = new Set(opts.fields ?? [])
  const walk = (value: unknown, path: string): unknown => {
    if (fieldSet.has(path) || (opts.fieldMatcher?.(path, value) ?? false)) {
      if (path !== '') report.fields.push({ path, redacted: true })
      return replacement
    }
    if (typeof value === 'string') return redactString(value, patterns, replacement, report)
    if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, path ? `${path}.${k}` : k)
      }
      return out
    }
    return value
  }
  return { payload: walk(input, '') as T, report }
}

function redactString(s: string, patterns: RegExp[], replacement: string, report: RedactReport): string {
  // 全角 ASCII（含数字/字母）→ 半角：堵 "１３８..." 全角绕过。
  // 脱敏 payload 供分析（非原始回显），全角转半角的轻微失真可接受。
  let out = s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
  for (const re of patterns) {
    const reCopy = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    const matches = out.match(reCopy)
    if (matches) {
      report.matched[re.source.slice(0, 30)] = (report.matched[re.source.slice(0, 30)] ?? 0) + matches.length
      out = out.replace(reCopy, replacement)
    }
  }
  return out
}

/** 判断字符串是否含 PII（不替换）。 */
export function containsPii(s: string, opts: Pick<RedactOptions, 'patterns' | 'disableDefaults'> = {}): boolean {
  const patterns = opts.disableDefaults ? opts.patterns ?? [] : [...DEFAULT_PATTERNS, ...(opts.patterns ?? [])]
  return patterns.some((re) => new RegExp(re.source).test(s))
}
