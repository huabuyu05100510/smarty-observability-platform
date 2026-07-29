/**
 * @monit/collector/replay - rrweb 风格会话回放录制
 *
 * 移植自 monitor-sdk/packages/session-replay/recorder.ts（手写最简，不引 rrweb）。
 * snapshot 全 DOM → MutationObserver 增量 → input（默认 mask value，PII 安全）→ 30s 环形缓冲。
 * 错误触发时 getSnapshot() 塞入错误事件 payload.sessionReplay，供回放还原用户操作路径。
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
}

export interface RecorderOptions {
  /** 缓冲窗口 ms，默认 30000 */
  windowMs?: number
  /** input value 是否默认 mask，默认 true（PII 安全） */
  maskInputs?: boolean
  recordInputs?: boolean
}

const DEFAULT_WINDOW_MS = 30_000
const MASK_VALUE = '***'

const IGNORE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

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

  private serialize(node: Node): SerializedNode {
    const id = this.idOf(node)
    if (node.nodeType === 3) return { nodeType: 3, id, textContent: (node.textContent ?? '').slice(0, 5000) }
    if (node.nodeType === 8) return { nodeType: 8, id, textContent: node.textContent ?? '' }
    if (node.nodeType !== 1) return { nodeType: node.nodeType, id }

    const el = node as Element
    const tagName = el.tagName
    if (IGNORE_TAGS.has(tagName)) return { nodeType: 1, id, tagName: tagName.toLowerCase(), attributes: {} }

    const attributes: Record<string, string> = {}
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i]
      // 不录潜在 PII 属性（value/placeholder 等）—— 仅录结构相关
      if (!['value', 'data-monit-record'].includes(a.name)) attributes[a.name] = a.value
    }
    const children: SerializedNode[] = []
    for (let i = 0; i < el.childNodes.length; i++) children.push(this.serialize(el.childNodes[i]!))
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
        data.texts.push({ id: parentId, newValue: (m.target.textContent ?? '').slice(0, 5000) })
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
      // 若丢掉了 snapshot，补一条当前 DOM snapshot
      if (dropped.some((e) => e.type === 'snapshot') && typeof document !== 'undefined') {
        this.events.unshift({ type: 'snapshot', timestamp: this.events[0]?.timestamp ?? Date.now(), data: this.serialize(document.documentElement) })
      }
    }
  }

  /** 取当前窗口内的回放数据（错误触发时塞 payload.sessionReplay） */
  getSnapshot(): ReplayData {
    return {
      startedAt: this.startedAt,
      endedAt: this.endedAt || Date.now(),
      events: [...this.events],
      nodeCount: this.nextId - 1,
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

function describeSelector(el: Element): string {
  const tag = el.tagName?.toLowerCase() ?? 'unknown'
  const id = el.id ? `#${el.id}` : ''
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 2).join('.')}` : ''
  return `${tag}${id}${cls}`
}
