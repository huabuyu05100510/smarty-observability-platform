/**
 * @monit/collector/replay - rrweb 风格会话回放录制
 *
 * 移植自 monitor-sdk/packages/session-replay/recorder.ts（手写最简，不引 rrweb）。
 * snapshot 全 DOM → MutationObserver 增量 → input（默认 mask value，PII 安全）→ 30s 环形缓冲。
 * 错误触发时 getSnapshot() 塞入错误事件 payload.sessionReplay，供回放还原用户操作路径。
 *
 * 本轮加固（体积治理 + PII）：
 * - getSnapshot 字节预算（默认 32KB）：超限从最老 mutation/input 裁剪（保留 snapshot + 最近窗口），
 *   仍超则截断 snapshot 深度；置 truncated 标记。根治"sessionReplay 无上限拖垮整批上报"。
 * - serialize 深度上限（默认 32）：防深嵌套 DOM 栈溢出/巨型序列化。
 * - 属性 PII 白名单：不录 value/placeholder/title/alt/data-monit-record（仅结构相关）。
 */

export interface SerializedNode {
  nodeType: number
  tagName?: string
  attributes?: Record<string, string>
  children?: SerializedNode[]
  textContent?: string
  id: number
}

export interface InputEventData {
  id: number
  valueLength: number
  masked: boolean
  value?: string
  selector?: string
}

export interface MutationEventData {
  adds: Array<{ parentId: number; node: SerializedNode }>
  removes: Array<{ parentId: number; id: number }>
  attrs: Array<{ id: number; name: string; newValue: string }>
  texts: Array<{ id: number; newValue: string }>
}

export type ReplayEvent =
  | { type: 'snapshot'; timestamp: number; data: SerializedNode }
  | { type: 'mutation'; timestamp: number; data: MutationEventData }
  | { type: 'input'; timestamp: number; data: InputEventData }

export interface ReplayData {
  startedAt: number
  endedAt: number
  events: ReplayEvent[]
  nodeCount: number
  /** 是否因字节预算裁剪过 */
  truncated?: boolean
  truncatedReason?: string
}

export interface RecorderOptions {
  /** 缓冲窗口 ms，默认 30000 */
  windowMs?: number
  /** input value 是否默认 mask，默认 true（PII 安全） */
  maskInputs?: boolean
  recordInputs?: boolean
  /** getSnapshot 字节预算，默认 32768（32KB）。超限裁剪 + truncated 标记 */
  maxBytes?: number
  /** DOM 序列化深度上限，默认 32（防栈溢出/巨型） */
  maxDepth?: number
}

const DEFAULT_WINDOW_MS = 30_000
const DEFAULT_MAX_BYTES = 32_768
const DEFAULT_MAX_DEPTH = 32
const MASK_VALUE = '***'

const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])
/** 不录的 PII 属性（value/placeholder/title/alt 等可能含个人信息）—— 仅录结构相关 */
const PII_ATTRIBUTES = new Set(['value', 'placeholder', 'title', 'alt', 'data-monit-record'])

export class Recorder {
  private events: ReplayEvent[] = []
  private startedAt = 0
  private endedAt = 0
  private observer: MutationObserver | null = null
  private nodeIds = new WeakMap<Node, number>()
  private nextId = 1
  private inputHandler: ((e: Event) => void) | null = null
  private readonly opts: Required<RecorderOptions>
  private installed = false

  constructor(opts: RecorderOptions = {}) {
    this.opts = {
      windowMs: opts.windowMs ?? DEFAULT_WINDOW_MS,
      maskInputs: opts.maskInputs ?? true,
      recordInputs: opts.recordInputs ?? true,
      maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    }
  }

  install(): void {
    if (this.installed || typeof document === 'undefined') return
    this.installed = true
    this.startedAt = Date.now()

    // 1. 全量 snapshot
    this.events.push({ type: 'snapshot', timestamp: this.startedAt, data: this.serialize(document.documentElement) })

    // 2. MutationObserver 增量
    this.observer = new MutationObserver((mutations) => this.handleMutations(mutations))
    this.observer.observe(document, { childList: true, attributes: true, characterData: true, subtree: true })

    // 3. input（mask value，PII 安全）
    if (this.opts.recordInputs) {
      this.inputHandler = (e: Event) => this.handleInput(e)
      document.addEventListener('input', this.inputHandler, true)
    }
  }

  private idOf(node: Node): number {
    let id = this.nodeIds.get(node)
    if (id === undefined) { id = this.nextId++; this.nodeIds.set(node, id) }
    return id
  }

  private serialize(node: Node, depth = 0): SerializedNode {
    const id = this.idOf(node)
    if (node.nodeType === 3) return { nodeType: 3, id, textContent: (node.textContent ?? '').slice(0, 500) }
    if (node.nodeType === 8) return { nodeType: 8, id, textContent: node.textContent ?? '' }
    if (node.nodeType !== 1) return { nodeType: node.nodeType, id }

    const el = node as Element
    const tagName = el.tagName
    if (IGNORE_TAGS.has(tagName)) return { nodeType: 1, id, tagName: tagName.toLowerCase(), attributes: {} }
    // 深度上限：防深嵌套 DOM 栈溢出/巨型序列化
    if (depth >= this.opts.maxDepth) return { nodeType: 1, id, tagName: tagName.toLowerCase(), attributes: { 'data-monit-truncated': 'depth' } }

    const attributes: Record<string, string> = {}
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i]
      // 不录 PII 属性（value/placeholder/title/alt 等）—— 仅录结构相关
      if (!PII_ATTRIBUTES.has(a.name)) attributes[a.name] = a.value
    }
    const children: SerializedNode[] = []
    for (let i = 0; i < el.childNodes.length; i++) children.push(this.serialize(el.childNodes[i]!, depth + 1))
    return { nodeType: 1, id, tagName: tagName.toLowerCase(), attributes, children }
  }

  private handleMutations(mutations: MutationRecord[]): void {
    const ts = Date.now()
    this.endedAt = ts
    const data: MutationEventData = { adds: [], removes: [], attrs: [], texts: [] }
    for (const m of mutations) {
      const parentId = this.idOf(m.target)
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => data.adds.push({ parentId, node: this.serialize(n) }))
        m.removedNodes.forEach((n) => data.removes.push({ parentId, id: this.idOf(n) }))
      } else if (m.type === 'attributes' && m.attributeName) {
        const el = m.target as Element
        data.attrs.push({ id: parentId, name: m.attributeName, newValue: el.getAttribute(m.attributeName) ?? '' })
      } else if (m.type === 'characterData') {
        data.texts.push({ id: parentId, newValue: (m.target.textContent ?? '').slice(0, 500) })
      }
    }
    if (data.adds.length || data.removes.length || data.attrs.length || data.texts.length) {
      this.events.push({ type: 'mutation', timestamp: ts, data })
      this.trim()
    }
  }

  private handleInput(e: Event): void {
    const target = e.target as Element | null
    if (!target || !('value' in target)) return
    const ts = Date.now()
    const explicit = target.getAttribute?.('data-monit-record') === 'value'
    const masked = this.opts.maskInputs && !explicit
    this.events.push({
      type: 'input',
      timestamp: ts,
      data: {
        id: this.idOf(target),
        valueLength: String((target as HTMLInputElement).value ?? '').length,
        masked,
        ...(explicit ? { value: String((target as HTMLInputElement).value ?? '') } : {}),
        selector: describeSelector(target),
      },
    })
    this.trim()
  }

  /** 裁剪到 windowMs 窗口（保最近 N 秒）；snapshot 若被裁掉则补一条新 snapshot */
  private trim(): void {
    const cutoff = Date.now() - this.opts.windowMs
    const firstKept = this.events.findIndex((e) => e.timestamp >= cutoff)
    if (firstKept > 0) {
      const dropped = this.events.slice(0, firstKept)
      this.events = this.events.slice(firstKept)
      if (dropped.some((e) => e.type === 'snapshot') && typeof document !== 'undefined') {
        this.events.unshift({ type: 'snapshot', timestamp: this.events[0]?.timestamp ?? Date.now(), data: this.serialize(document.documentElement) })
      }
    }
  }

  /**
   * 取当前窗口内的回放数据（错误触发时塞 payload.sessionReplay）。
   * 字节预算治理：超 maxBytes 时从最老 mutation/input 裁剪（保留 snapshot + 最近窗口），
   * 仍超则截断 snapshot 深度；置 truncated 标记。
   */
  getSnapshot(): ReplayData {
    const budget = this.opts.maxBytes
    const enc = new TextEncoder()
    const sizeOf = (evs: ReplayEvent[]): number => enc.encode(JSON.stringify(evs)).byteLength

    let events = [...this.events]
    let truncated = false
    let truncatedReason: string | undefined

    if (events.length > 0 && sizeOf(events) > budget) {
      const snap = events.find((e) => e.type === 'snapshot') as Extract<ReplayEvent, { type: 'snapshot' }> | undefined
      const rest = events.filter((e) => e.type !== 'snapshot')
      while (rest.length > 0 && sizeOf([...(snap ? [snap] : []), ...rest]) > budget) {
        rest.shift()
      }
      events = [...(snap ? [snap] : []), ...rest]
      truncated = true
      truncatedReason = 'trimmed-to-byte-budget'
      if (snap && sizeOf(events) > budget) {
        snap.data = truncateNode(snap.data, this.opts.maxDepth)
        truncatedReason = 'snapshot-depth-truncated'
      }
    }

    return {
      startedAt: this.startedAt,
      endedAt: this.endedAt || Date.now(),
      events,
      nodeCount: this.nextId - 1,
      truncated,
      truncatedReason,
    }
  }

  clear(): void { this.events = []; this.startedAt = Date.now(); this.endedAt = 0 }

  uninstall(): void {
    this.observer?.disconnect()
    this.observer = null
    if (this.inputHandler && typeof document !== 'undefined') {
      document.removeEventListener('input', this.inputHandler, true)
    }
    this.inputHandler = null
    this.events = []
    this.installed = false
  }
}

/** 截断 SerializedNode 到指定深度（巨型 snapshot 兜底）。返回新对象（不改原引用）。 */
function truncateNode(node: SerializedNode, maxDepth: number, depth = 0): SerializedNode {
  if (depth >= maxDepth || !node.children || node.children.length === 0) {
    return node.children && node.children.length > 0 ? { ...node, children: [] } : node
  }
  return { ...node, children: node.children.map((c) => truncateNode(c, maxDepth, depth + 1)) }
}

function describeSelector(el: Element): string {
  const tag = el.tagName?.toLowerCase() ?? 'unknown'
  const id = el.id ? `#${el.id}` : ''
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : ''
  return `${tag}${id}${cls}`
}
