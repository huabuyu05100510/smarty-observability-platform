// FUTURE: 单 host 事件量 > 10k 或需存 sourcemap 大文件 (>50MB) 时,评估迁移到 OPFS。
//   注意 OPFS 仅 Chromium 系(Chrome/Edge/Opera),Safari 16.4+ 实验性、Firefox 111+ 实验性,
//   迁移会丢失 Safari/Firefox 用户的旧数据,需权衡后再决策。
// 当前 MVP: IndexedDB 4 store (events/attributions/heals/mrs),以 eventId 主键串联。
(function (global) {
  const DB_NAME = 'inp-copilot';
  const DB_VERSION = 1;
  const STORES = ['events', 'attributions', 'heals', 'mrs'];

  // 复用单条连接:put/getAll/count/clear 每次都调 openDb,若每次新建会大量开连接(flush 时并发数百)。
  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          STORES.forEach((s) => {
            if (!db.objectStoreNames.contains(s)) {
              db.createObjectStore(s, { keyPath: 'eventId' });
            }
          });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbPromise = null; reject(req.error); }; // 失败清缓存,允许下次重试
      });
    }
    return dbPromise;
  }

  async function put(store, record) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(record);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  async function getAll(store) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
  }

  async function count(store) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).count();
      req.onsuccess = () => res(req.result || 0);
      req.onerror = () => rej(req.error);
    });
  }

  async function clear(store) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // 保留窗口清理：删除超过 maxAgeMs 的事件，并仅保留最近 maxCount 条（按 timestamp 降序）。
  // 返回 { kept, dropped }；kept 为保留快照，供调用方（data.js）重建内存缓存，避免 prune 后缓存脏。
  async function pruneEvents(maxAgeMs, maxCount) {
    const db = await openDb();
    return new Promise((res, rej) => {
      const tx = db.transaction('events', 'readwrite');
      const store = tx.objectStore('events');
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        const now = Date.now();
        let keep = all.filter((e) => (e.timestamp || 0) >= now - (maxAgeMs != null ? maxAgeMs : Infinity));
        keep.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        if (maxCount != null && keep.length > maxCount) keep = keep.slice(0, maxCount);
        const keepIds = new Set(keep.map((e) => e.eventId));
        for (const e of all) if (!keepIds.has(e.eventId)) store.delete(e.eventId);
        tx.oncomplete = () => res({ kept: keep, dropped: all.length - keep.length });
        tx.onerror = () => rej(tx.error);
      };
      req.onerror = () => rej(req.error);
    });
  }

  global.__inpDb = { put, getAll, count, clear, pruneEvents, STORES };
})(typeof globalThis !== 'undefined' ? globalThis : self);