/**
 * @monit/collector/offline-store - IndexedDB 离线队列存储
 *
 * 移植自 monitor-sdk/packages/core/src/offline-store.ts（生产级实现）。
 * 上报失败时入队，定时 + online 事件触发 flushOffline 重试，达 maxAttempts 丢弃。
 * IndexedDB 不可用（隐私模式/SSR/老浏览器）时返回 null，降级为失败即丢。
 */

import type { OfflineQueueItem, OfflineStore } from './reporter'

const DB_NAME = 'monit'
const STORE_NAME = 'offline_queue'
const DB_VERSION = 1

let dbInstance: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbInstance) return dbInstance
  dbInstance = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined' || typeof window === 'undefined') {
      resolve(null)
      return
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbInstance
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** 创建 IndexedDB 离线存储；环境不支持返回 null。 */
export async function createIdbOfflineStore(): Promise<OfflineStore | null> {
  const db = await openDb()
  if (!db) return null
  return {
    async add(item: Omit<OfflineQueueItem, 'id'>): Promise<void> {
      try {
        reqToPromise(tx(db, 'readwrite').add(item as OfflineQueueItem)).catch(() => {})
      } catch { /* ignore */ }
    },
    async all(): Promise<OfflineQueueItem[]> {
      try {
        return await reqToPromise<OfflineQueueItem[]>(tx(db, 'readonly').getAll())
      } catch {
        return []
      }
    },
    async remove(id: number): Promise<void> {
      try {
        reqToPromise(tx(db, 'readwrite').delete(id)).catch(() => {})
      } catch { /* ignore */ }
    },
    async update(item: OfflineQueueItem): Promise<void> {
      try {
        reqToPromise(tx(db, 'readwrite').put(item)).catch(() => {})
      } catch { /* ignore */ }
    },
  }
}

/** 内存版离线存储（测试 / SSR 降级）。不持久化。 */
export function createMemoryOfflineStore(): OfflineStore {
  const items: OfflineQueueItem[] = []
  let nextId = 1
  return {
    async add(item) { items.push({ ...item, id: nextId++ }) },
    async all() { return items.slice() },
    async remove(id) {
      const i = items.findIndex((it) => it.id === id)
      if (i >= 0) items.splice(i, 1)
    },
    async update(item) {
      const i = items.findIndex((it) => it.id === item.id)
      if (i >= 0) items[i] = item
    },
  }
}
