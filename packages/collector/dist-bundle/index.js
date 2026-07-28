// ../trace/dist/index.js
var TRACEPARENT_HEADER = "traceparent";
var TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
var ZERO_TRACE = "0".repeat(32);
var ZERO_SPAN = "0".repeat(16);
var DEFAULT_FLAGS = "01";
function randomHex(byteLen) {
  const bytes = new Uint8Array(byteLen);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < byteLen; i++)
      bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = "";
  for (let i = 0; i < byteLen; i++)
    out += bytes[i].toString(16).padStart(2, "0");
  return out;
}
function generateTraceIdHex() {
  let id = randomHex(16);
  if (id === ZERO_TRACE)
    id = randomHex(16);
  return id;
}
function generateSpanIdHex() {
  let id = randomHex(8);
  if (id === ZERO_SPAN)
    id = randomHex(8);
  return id;
}
function encodeTraceparent(parts) {
  return `00-${parts.traceId}-${parts.spanId}-${parts.flags}`;
}
function parseTraceparent(input) {
  if (!input)
    return null;
  const m = input.trim().match(TRACEPARENT_RE);
  if (!m)
    return null;
  const [, version, traceId, spanId, flags] = m;
  if (version !== "00")
    return null;
  if (traceId === ZERO_TRACE)
    return null;
  if (spanId === ZERO_SPAN)
    return null;
  return { version, traceId, spanId, flags };
}
function readMetaContent(name) {
  if (typeof document === "undefined")
    return null;
  const metas = document.getElementsByTagName("meta");
  for (let i = 0; i < metas.length; i++) {
    if (metas[i].getAttribute("name") === name) {
      return metas[i].getAttribute("content");
    }
  }
  return null;
}
function readCookie(name) {
  if (typeof document === "undefined" || !document.cookie)
    return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp("(?:^|; )" + escaped + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : null;
}
var TraceContextManager = class {
  _options = { enabled: true, traceFlags: DEFAULT_FLAGS };
  _view = null;
  configure(opts) {
    this._options = {
      enabled: opts.enabled ?? true,
      inheritFromMeta: opts.inheritFromMeta,
      inheritFromCookie: opts.inheritFromCookie,
      traceFlags: opts.traceFlags ?? DEFAULT_FLAGS
    };
  }
  reset() {
    this._options = { enabled: true, traceFlags: DEFAULT_FLAGS };
    this._view = null;
  }
  get inherited() {
    return this._view?.inherited ?? false;
  }
  get current() {
    return this._view;
  }
  /** 当前 traceId（无 view 时 null） */
  get traceId() {
    return this._view?.traceId ?? null;
  }
  /**
   * (Re)initialize view trace。有入站 traceparent（meta/cookie）则继承 traceId
   * 并生成新 view root spanId；否则起新 trace。
   */
  startView() {
    const flags = this._options.traceFlags;
    const inbound = this._readInbound();
    if (inbound) {
      this._view = {
        traceId: inbound.traceId,
        spanId: generateSpanIdHex(),
        flags,
        inherited: true
      };
    } else {
      this._view = {
        traceId: generateTraceIdHex(),
        spanId: generateSpanIdHex(),
        flags,
        inherited: false
      };
    }
    return this._view;
  }
  /**
   * 为单个出站请求生成 span context。传播关闭时返回 null。无 view 时懒启动。
   */
  forRequest() {
    if (!this._options.enabled)
      return null;
    const view = this._view ?? this.startView();
    return {
      traceId: view.traceId,
      spanId: generateSpanIdHex(),
      flags: view.flags
    };
  }
  _readInbound() {
    const metaName = this._options.inheritFromMeta;
    if (metaName) {
      const parsed = parseTraceparent(readMetaContent(metaName));
      if (parsed)
        return parsed;
    }
    const cookieName = this._options.inheritFromCookie;
    if (cookieName) {
      const parsed = parseTraceparent(readCookie(cookieName));
      if (parsed)
        return parsed;
    }
    return null;
  }
};
var traceContext = new TraceContextManager();

// src/vitals.ts
function ratingForInp(value) {
  return value <= 200 ? "good" : value <= 500 ? "needs-improvement" : "poor";
}
function ratingForLcp(value) {
  return value <= 2500 ? "good" : value <= 4e3 ? "needs-improvement" : "poor";
}
function ratingForCls(value) {
  return value <= 0.1 ? "good" : value <= 0.25 ? "needs-improvement" : "poor";
}
function installVitals(cb) {
  const cleanups = [];
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "paint" && entry.name === "first-contentful-paint") {
          cb.onVital({ name: "FCP", value: entry.startTime, rating: ratingForLcp(entry.startTime) });
        } else if (entry.entryType === "largest-contentful-paint") {
          cb.onVital({ name: "LCP", value: entry.startTime, rating: ratingForLcp(entry.startTime) });
        }
      }
    });
    po.observe({ type: "paint", buffered: true });
    po.observe({ type: "largest-contentful-paint", buffered: true });
    cleanups.push(() => po.disconnect());
  } catch {
  }
  try {
    let clsValue = 0;
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ls = entry;
        if (!ls.hadRecentInput && typeof ls.value === "number") {
          clsValue += ls.value;
        }
      }
      cb.onVital({ name: "CLS", value: clsValue, rating: ratingForCls(clsValue) });
    });
    po.observe({ type: "layout-shift", buffered: true });
    cleanups.push(() => po.disconnect());
  } catch {
  }
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) {
      cb.onVital({ name: "TTFB", value: nav.responseStart, rating: ratingForLcp(nav.responseStart) });
    }
  } catch {
  }
  const loafBuffer = [];
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const loaf = entry;
        loafBuffer.push(loaf);
        if (loafBuffer.length > 10)
          loafBuffer.shift();
      }
    });
    po.observe({ type: "long-animation-frame", buffered: true });
    cleanups.push(() => po.disconnect());
  } catch {
  }
  try {
    let worstInp = 0;
    let worstEntry = null;
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const et = entry;
        const duration = et.duration;
        if (duration > worstInp) {
          worstInp = duration;
          worstEntry = et;
        }
      }
    });
    po.observe({ type: "event", buffered: true });
    const onHidden = () => {
      if (document.visibilityState === "hidden" && worstEntry) {
        const attribution = buildInpAttribution(worstEntry, loafBuffer);
        cb.onInp(attribution);
        cb.onVital({ name: "INP", value: attribution.value, rating: attribution.rating });
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    cleanups.push(() => {
      po.disconnect();
      document.removeEventListener("visibilitychange", onHidden);
    });
  } catch {
  }
  return () => cleanups.forEach((fn) => fn());
}
function buildInpAttribution(entry, loafBuffer) {
  const inputDelay = entry.processingStart - entry.startTime;
  const processingDuration = entry.processingEnd - entry.processingStart;
  const presentationDelay = entry.duration - (entry.processingEnd - entry.startTime);
  const value = entry.duration;
  const intersecting = loafBuffer.filter((loaf) => loaf.startTime <= entry.startTime + entry.duration && loaf.startTime + loaf.duration >= entry.startTime).map((loaf) => ({
    id: `loaf-${loaf.startTime}`,
    startTime: loaf.startTime,
    duration: loaf.duration,
    blockingDuration: loaf.blockingDuration,
    renderStart: loaf.renderStart,
    styleAndLayoutStart: loaf.styleAndLayoutStart,
    firstUIEventTimestamp: loaf.firstUIEventTimestamp,
    scripts: (loaf.scripts ?? []).map((s, i) => ({
      id: `script-${i}`,
      name: s.name ?? s.invoker ?? "<script>",
      invoker: s.invoker,
      invokerType: s.invokerType,
      sourceURL: s.sourceURL,
      sourceFunctionName: s.sourceFunctionName,
      sourceCharPosition: s.sourceCharPosition,
      duration: s.duration ?? 0,
      startTime: s.startTime ?? 0,
      forcedStyleAndLayoutDuration: s.forcedStyleAndLayoutDuration,
      pauseDuration: s.pauseDuration
    }))
  }));
  return {
    value,
    rating: ratingForInp(value),
    interactionTarget: entry.target ? entry.target.tagName?.toLowerCase() : entry.name,
    inputDelay,
    processingDuration,
    presentationDelay,
    longAnimationFrameEntries: intersecting
  };
}

// ../fingerprint/dist/index.js
function fnv1a(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = hash * 33 ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function normalizeStackFrame(frame) {
  return frame.trim().replace(/\?[^:\s]*/g, "").replace(/:\d+:\d+\)?$/g, ")").replace(/:\d+:\d+/g, "").replace(/-[0-9a-f]{8,}\.(js|mjs|cjs|ts|jsx|tsx)/gi, "-[hash].$1").replace(/^(file|https?):\/\/[^/)]+/i, "").trim();
}
function fingerprintStack(stack, topN = 3) {
  if (!stack)
    return fnv1a("no-stack");
  const frames = stack.split("\n").map(normalizeStackFrame).filter((f) => f.length > 0).slice(0, topN);
  if (frames.length === 0)
    return fnv1a("empty-stack");
  return fnv1a(frames.join("|"));
}
var UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
var NUM_RE = /\b\d+\b/g;
var URL_RE = /https?:\/\/[^\s)'"]+/gi;
var QUOTED_RE = /'[^']*'|"[^"]*"/g;
function normalizeMessage(message) {
  return message.replace(URL_RE, "<url>").replace(UUID_RE, "<uuid>").replace(QUOTED_RE, "<str>").replace(NUM_RE, "<n>").trim();
}
function normalizeUrl(url) {
  if (!url)
    return "<unknown>";
  return url.replace(/[?#].*$/, "").replace(/-[0-9a-f]{8,}\.(js|mjs|cjs|ts|jsx|tsx)/gi, "-[hash].$1").replace(/\/\d+(?=\/|$)/g, "/<n>").trim();
}
function objectOrder(value) {
  if (value === null || typeof value !== "object")
    return String(value);
  if (Array.isArray(value))
    return "[" + value.map(objectOrder).join(",") + "]";
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${objectOrder(v)}`);
  return "{" + entries.join(",") + "}";
}
function fingerprintUrlType(message, url, errorType) {
  const parts = [
    normalizeMessage(message),
    normalizeUrl(url),
    errorType ?? "Error"
  ];
  return djb2(parts.join("||"));
}
function computeFingerprint(input) {
  const primary = fingerprintStack(input.stack);
  const messageForSecondary = input.reason !== void 0 && typeof input.reason === "object" ? `${input.errorType ?? "Error"}:${objectOrder(input.reason)}` : input.message;
  const secondary = fingerprintUrlType(
    messageForSecondary,
    input.sourceURL ?? input.filename,
    input.errorType
  );
  return { primary, secondary };
}

// src/errors.ts
var installed = false;
function installErrors(cb) {
  if (installed)
    return () => {
    };
  installed = true;
  const cleanups = [];
  const onError = (event) => {
    const isCrossOrigin = event.message === "Script error." && !event.filename;
    const signal = {
      id: `err-${event.timeStamp}`,
      type: "js",
      message: event.message,
      stack: event.error?.stack,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      timestamp: Date.now(),
      sourceURL: event.filename,
      handled: false
    };
    const fp = computeFingerprint({
      message: event.message,
      stack: event.error?.stack,
      filename: event.filename,
      errorType: event.error?.name ?? "Error"
    });
    cb.onError(signal, fp);
    if (isCrossOrigin)
      injectCrossorigin();
  };
  window.addEventListener("error", onError, true);
  cleanups.push(() => window.removeEventListener("error", onError, true));
  const onRejection = (event) => {
    const reason = event.reason;
    const message = reason?.message ?? String(reason);
    const signal = {
      id: `prom-${event.timeStamp}`,
      type: "promise",
      message,
      stack: reason?.stack,
      timestamp: Date.now(),
      handled: false
    };
    const fp = computeFingerprint({
      message,
      stack: reason?.stack,
      errorType: reason?.name ?? "PromiseRejection",
      reason
    });
    cb.onError(signal, fp);
  };
  window.addEventListener("unhandledrejection", onRejection);
  cleanups.push(() => window.removeEventListener("unhandledrejection", onRejection));
  const onResourceError = (event) => {
    const target = event.target;
    if (!target)
      return;
    const tag = target.tagName?.toLowerCase();
    if (!["img", "script", "link", "iframe", "audio", "video"].includes(tag ?? ""))
      return;
    const url = target.src ?? target.href ?? "";
    const signal = {
      id: `res-${Date.now()}`,
      type: "resource",
      message: `Failed to load ${tag}: ${url}`,
      timestamp: Date.now(),
      sourceURL: url,
      handled: false
    };
    const fp = computeFingerprint({
      message: signal.message,
      sourceURL: url,
      errorType: "ResourceError"
    });
    cb.onError(signal, fp);
  };
  window.addEventListener("error", onResourceError, true);
  cleanups.push(() => window.removeEventListener("error", onResourceError, true));
  return () => {
    cleanups.forEach((fn) => fn());
    installed = false;
  };
}
function injectCrossorigin() {
  try {
    const scripts = document.getElementsByTagName("script");
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i];
      if (s.src && !s.crossOrigin) {
        s.crossOrigin = "anonymous";
      }
    }
  } catch {
  }
}
function reportReactError(error, componentStack, cb) {
  const signal = {
    id: `react-${Date.now()}`,
    type: "react",
    message: error.message,
    stack: error.stack,
    componentStack,
    timestamp: Date.now(),
    sourceURL: error.stack?.match(/at .* \((.*?):\d+:\d+\)/)?.[1],
    handled: true
  };
  const fp = computeFingerprint({
    message: error.message,
    stack: error.stack,
    errorType: error.name
  });
  cb.onError(signal, fp);
}

// src/breadcrumbs.ts
var BreadcrumbCollector = class {
  buffer = [];
  capacity;
  cleanups = [];
  constructor(capacity = 50) {
    this.capacity = capacity;
  }
  install() {
    const onClick = (e) => {
      const target = e.target;
      this.push({
        type: "click",
        message: target ? describeElement(target) : "click",
        timestamp: Date.now(),
        data: { x: e.clientX, y: e.clientY }
      });
    };
    document.addEventListener("click", onClick, true);
    this.cleanups.push(() => document.removeEventListener("click", onClick, true));
    let inputTimer = null;
    const onInput = (e) => {
      const target = e.target;
      if (!target)
        return;
      if (inputTimer)
        clearTimeout(inputTimer);
      inputTimer = setTimeout(() => {
        this.push({
          type: "input",
          message: `input on ${describeElement(target)}`,
          timestamp: Date.now()
        });
      }, 500);
    };
    document.addEventListener("input", onInput, true);
    this.cleanups.push(() => {
      document.removeEventListener("input", onInput, true);
      if (inputTimer)
        clearTimeout(inputTimer);
    });
    const pushState = history.pushState.bind(history);
    const replaceState = history.replaceState.bind(history);
    const onRoute = (kind) => {
      this.push({
        type: "route",
        message: `${kind} -> ${location.pathname}`,
        timestamp: Date.now()
      });
    };
    history.pushState = (...args) => {
      const r = pushState(...args);
      onRoute("push");
      return r;
    };
    history.replaceState = (...args) => {
      const r = replaceState(...args);
      onRoute("replace");
      return r;
    };
    const onPop = () => onRoute("pop");
    window.addEventListener("popstate", onPop);
    this.cleanups.push(() => {
      history.pushState = pushState;
      history.replaceState = replaceState;
      window.removeEventListener("popstate", onPop);
    });
  }
  push(b) {
    this.buffer.push(b);
    if (this.buffer.length > this.capacity)
      this.buffer.shift();
  }
  recent() {
    return [...this.buffer];
  }
  clear() {
    this.buffer = [];
  }
  uninstall() {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.buffer = [];
  }
};
function describeElement(el) {
  const tag = el.tagName?.toLowerCase() ?? "unknown";
  const id = el.id ? `#${el.id}` : "";
  const cls = el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/).slice(0, 2).join(".")}` : "";
  return `${tag}${id}${cls}`;
}

// src/reporter.ts
var Reporter = class {
  queue = [];
  timer = null;
  onlineHandler = null;
  opts;
  constructor(opts) {
    this.opts = {
      endpoint: opts.endpoint,
      batchSize: opts.batchSize ?? 10,
      flushInterval: opts.flushInterval ?? 5e3,
      maxAttempts: opts.maxAttempts ?? 5,
      release: opts.release,
      offlineStore: opts.offlineStore,
      compress: opts.compress
    };
  }
  start() {
    if (this.timer)
      return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushInterval);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    if (typeof window !== "undefined") {
      this.onlineHandler = () => void this.flushOffline();
      window.addEventListener("online", this.onlineHandler);
    }
    void this.flushOffline();
  }
  enqueue(event) {
    this.queue.push(event);
    if (this.queue.length >= this.opts.batchSize)
      void this.flush();
  }
  onVisibilityChange = () => {
    if (document.visibilityState === "hidden")
      void this.flush();
  };
  async flush() {
    if (this.queue.length === 0)
      return;
    const batch = this.queue.splice(0, this.queue.length);
    await this.sendWithRetry(batch);
  }
  /** 单批发送：成功即止；失败入离线队列（若有）。 */
  async sendWithRetry(events) {
    const ok = await sendOnce(this.opts.endpoint, events, { compress: this.opts.compress });
    if (ok)
      return;
    if (!this.opts.offlineStore)
      return;
    try {
      await this.opts.offlineStore.add({
        payload: events,
        attempts: 0,
        lastAttemptAt: Date.now(),
        dsn: this.opts.endpoint
      });
    } catch {
    }
    void this.flushOffline();
  }
  /** 重发离线队列：成功删、失败 attempts+1、达 maxAttempts 丢弃。 */
  async flushOffline() {
    const store = this.opts.offlineStore;
    if (!store)
      return;
    let items;
    try {
      items = await store.all();
    } catch {
      return;
    }
    for (const item of items) {
      if (item.dsn !== this.opts.endpoint || item.id === void 0)
        continue;
      if (item.attempts >= this.opts.maxAttempts) {
        try {
          await store.remove(item.id);
        } catch {
        }
        continue;
      }
      const ok = await sendOnce(item.dsn, item.payload, { compress: this.opts.compress });
      if (ok) {
        try {
          await store.remove(item.id);
        } catch {
        }
      } else {
        try {
          await store.update({ ...item, attempts: item.attempts + 1, lastAttemptAt: Date.now() });
        } catch {
        }
      }
    }
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    if (this.onlineHandler && typeof window !== "undefined") {
      window.removeEventListener("online", this.onlineHandler);
    }
    void this.flush();
  }
  /** 异步挂载离线存储（IDB 打开完成后注入，不阻塞 init）。 */
  attachOfflineWhenReady(storePromise) {
    storePromise.then((store) => {
      if (store) {
        this.opts.offlineStore = store;
        void this.flushOffline();
      }
    }).catch(() => {
    });
  }
};
async function sendOnce(dsn, events, opts) {
  const body = JSON.stringify({ events });
  if (opts.compress) {
    try {
      const { gzip } = await import('pako');
      const gz = gzip(body);
      try {
        const resp = await fetch(dsn, {
          method: "POST",
          headers: { "Content-Type": "text/plain", "Content-Encoding": "gzip-base64" },
          body: uint8ToBase64(gz),
          keepalive: true
        });
        if (resp.ok)
          return true;
      } catch {
      }
    } catch {
    }
  }
  if (typeof fetch === "function") {
    try {
      const resp = await fetch(dsn, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true
      });
      if (resp.ok)
        return true;
    } catch {
    }
  }
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      const blob = new Blob([body], { type: "text/plain" });
      if (navigator.sendBeacon(dsn, blob))
        return true;
    } catch {
    }
  }
  return false;
}
function uint8ToBase64(bytes) {
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 32768;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
  const Buf = globalThis.Buffer;
  if (Buf)
    return Buf.from(bytes).toString("base64");
  let out = "";
  for (let i = 0; i < bytes.length; i++)
    out += String.fromCharCode(bytes[i]);
  return out;
}

// src/offline-store.ts
var DB_NAME = "monit";
var STORE_NAME = "offline_queue";
var DB_VERSION = 1;
var dbInstance = null;
function openDb() {
  if (dbInstance)
    return dbInstance;
  dbInstance = new Promise((resolve) => {
    if (typeof indexedDB === "undefined" || typeof window === "undefined") {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbInstance;
}
function tx(db, mode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function createIdbOfflineStore() {
  const db = await openDb();
  if (!db)
    return null;
  return {
    async add(item) {
      try {
        reqToPromise(tx(db, "readwrite").add(item)).catch(() => {
        });
      } catch {
      }
    },
    async all() {
      try {
        return await reqToPromise(tx(db, "readonly").getAll());
      } catch {
        return [];
      }
    },
    async remove(id) {
      try {
        reqToPromise(tx(db, "readwrite").delete(id)).catch(() => {
        });
      } catch {
      }
    },
    async update(item) {
      try {
        reqToPromise(tx(db, "readwrite").put(item)).catch(() => {
        });
      } catch {
      }
    }
  };
}

// src/request.ts
function isSameOrigin(url) {
  if (typeof location === "undefined")
    return true;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
function extractGraphQL(body) {
  if (typeof body !== "string")
    return null;
  if (!body.includes('"query"') && !body.includes('"operationName"'))
    return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Array.isArray(parsed) && parsed.length > 0)
    parsed = parsed[0];
  if (!parsed || typeof parsed !== "object")
    return null;
  const obj = parsed;
  const query = typeof obj.query === "string" ? obj.query : "";
  if (!query)
    return null;
  const lines = query.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
  const opLine = lines.find((l) => /^(query|mutation|subscription|fragment)\b/i.test(l)) ?? lines[0] ?? "";
  const summary = opLine.slice(0, 100);
  const operationName = typeof obj.operationName === "string" && obj.operationName || (summary.match(/^(?:query|mutation|subscription|fragment)\s+([A-Za-z_]\w*)/i)?.[1] ?? "");
  return { operationName, summary };
}
function classifyZeroStatus(response) {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    return "offline";
  return "network-unknown";
}
function installRequestMonitor(opts, cb) {
  const slowThresholdMs = opts.slowThresholdMs ?? 3e3;
  const inject = opts.injectTraceparent ?? true;
  const ignore = opts.ignore ?? (() => false);
  const cleanups = [];
  const injectHeader = (url, headers) => {
    if (!inject || !isSameOrigin(url))
      return;
    const span = traceContext.forRequest();
    if (span && !headers.has(TRACEPARENT_HEADER)) {
      headers.set(TRACEPARENT_HEADER, encodeTraceparent(span));
    }
  };
  if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    const mark = `__monit_req_fetch`;
    if (!originalFetch[mark]) {
      const patched = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        if (ignore(url))
          return originalFetch(input, init);
        const newInit = init ? { ...init } : {};
        if (inject) {
          newInit.headers = new Headers(init?.headers);
          injectHeader(url, newInit.headers);
        }
        const requestBody = typeof init?.body === "string" ? init.body.slice(0, 500) : "";
        const graphql = extractGraphQL(init?.body);
        const start = Date.now();
        try {
          const response = await originalFetch(input, newInit);
          const duration = Date.now() - start;
          if (!response.ok) {
            const cloned = response.clone();
            const responseText = await cloned.text().catch(() => "");
            cb.onEvent("fetch", {
              method,
              url,
              status: response.status,
              duration,
              requestBody,
              responseText: responseText.slice(0, 500),
              ...graphql ? { graphqlOperation: graphql.operationName, graphqlSummary: graphql.summary } : {}
            });
          }
          if (slowThresholdMs > 0 && duration > slowThresholdMs) {
            cb.onEvent("slow", { method, url, status: response.status, duration, threshold: slowThresholdMs });
          }
          return response;
        } catch (error) {
          const duration = Date.now() - start;
          cb.onEvent("fetch", {
            method,
            url,
            status: 0,
            duration,
            requestBody,
            responseText: error instanceof Error ? error.message : String(error),
            failReason: classifyZeroStatus(),
            ...graphql ? { graphqlOperation: graphql.operationName, graphqlSummary: graphql.summary } : {}
          });
          throw error;
        }
      };
      patched[mark] = true;
      globalThis.fetch = patched;
      cleanups.push(() => {
        if (globalThis.fetch === patched)
          globalThis.fetch = originalFetch;
      });
    }
  }
  if (typeof XMLHttpRequest === "function") {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
    const mark = "__monit_req_xhr";
    if (!XMLHttpRequest.prototype[mark]) {
      const urlKey = mark + ":url";
      const methodKey = mark + ":method";
      const startKey = mark + ":start";
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this[urlKey] = url;
        this[methodKey] = method;
        return originalOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function(body) {
        const url = this[urlKey] ?? "";
        const method = (this[methodKey] ?? "GET").toUpperCase();
        this[startKey] = Date.now();
        if (!ignore(url)) {
          this.addEventListener("loadend", () => {
            const start = this[startKey] ?? Date.now();
            const duration = Date.now() - start;
            const status = this.status;
            if (status === 0 || status >= 400) {
              cb.onEvent("xhr", { method, url, status, duration, responseText: (this.responseText ?? "").slice(0, 500) });
            } else if (slowThresholdMs > 0 && duration > slowThresholdMs) {
              cb.onEvent("slow", { method, url, status, duration, threshold: slowThresholdMs });
            }
          });
        }
        return originalSend.call(this, body);
      };
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        const url = this[urlKey] ?? "";
        if (inject && isSameOrigin(url) && name.toLowerCase() === TRACEPARENT_HEADER) {
          this[mark + ":tp"] = true;
        }
        return originalSetHeader.call(this, name, value);
      };
      const origOpen2 = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        const r = origOpen2.call(this, method, url, ...rest);
        if (inject && isSameOrigin(url)) {
          const span = traceContext.forRequest();
          if (span) {
            try {
              originalSetHeader.call(this, TRACEPARENT_HEADER, encodeTraceparent(span));
            } catch {
            }
          }
        }
        return r;
      };
      XMLHttpRequest.prototype[mark] = true;
      cleanups.push(() => {
        XMLHttpRequest.prototype.open = originalOpen;
        XMLHttpRequest.prototype.send = originalSend;
        XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
      });
    }
  }
  return { uninstall() {
    cleanups.forEach((fn) => fn());
  } };
}

// src/index.ts
var sessionIdCounter = 0;
function initCollector(opts) {
  const sessionId = opts.sessionId ?? `sess-${Date.now()}-${sessionIdCounter++}`;
  const sampleRate = opts.sampleRate ?? 1;
  traceContext.configure({
    enabled: opts.trace?.enabled ?? true,
    inheritFromMeta: opts.trace?.inheritFromMeta,
    inheritFromCookie: opts.trace?.inheritFromCookie,
    traceFlags: "01"
  });
  traceContext.startView();
  const reporter = new Reporter({
    endpoint: opts.endpoint,
    release: opts.release,
    batchSize: opts.batchSize,
    flushInterval: opts.flushInterval,
    offlineStore: opts.offlineStore,
    compress: opts.compress
  });
  reporter.start();
  if (!opts.offlineStore) {
    reporter.attachOfflineWhenReady(createIdbOfflineStore());
  }
  const breadcrumbs = new BreadcrumbCollector(50);
  breadcrumbs.install();
  const traceId = traceContext.traceId ?? "";
  const makeEvent = (type, subType, payload, fingerprint, extraTags) => {
    const sampled = Math.random() < sampleRate;
    return {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      subType,
      timestamp: Date.now(),
      traceId,
      spanId: generateSpanIdHex(),
      sessionId,
      release: opts.release ?? "unknown",
      payload,
      piiSafe: true,
      sampled,
      sampleRate,
      fingerprint,
      tags: extraTags
    };
  };
  const uninstallVitals = installVitals({
    onVital: (metric) => {
      reporter.enqueue(makeEvent("vital", metric.name.toLowerCase(), metric));
    },
    onInp: (attribution) => {
      reporter.enqueue(makeEvent("vital", "inp", attribution, void 0, { rating: attribution.rating }));
    }
  });
  const uninstallErrors = installErrors({
    onError: (signal, fingerprint) => {
      const event = makeEvent("error", signal.type, {
        ...signal,
        breadcrumbs: breadcrumbs.recent()
      }, fingerprint);
      reporter.enqueue(event);
    }
  });
  const requestHandle = installRequestMonitor(
    { slowThresholdMs: opts.slowThresholdMs, ignore: (u) => u === opts.endpoint },
    {
      onEvent: (subType, payload) => {
        reporter.enqueue(makeEvent("request", subType, payload, void 0, payload.failReason ? { failReason: payload.failReason } : void 0));
      }
    }
  );
  return {
    report(event) {
      reporter.enqueue(event);
    },
    reportReactError(error, componentStack) {
      reportReactError(error, componentStack, {
        onError: (signal, fingerprint) => {
          reporter.enqueue(makeEvent("error", "react", { ...signal, breadcrumbs: breadcrumbs.recent() }, fingerprint));
        }
      });
    },
    async flush() {
      await reporter.flush();
    },
    uninstall() {
      uninstallVitals();
      uninstallErrors();
      requestHandle.uninstall();
      breadcrumbs.uninstall();
      reporter.stop();
      traceContext.reset();
    },
    breadcrumbs() {
      return breadcrumbs.recent();
    }
  };
}

export { initCollector };
