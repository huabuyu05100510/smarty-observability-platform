/**
 * @monit/collector/errors - 错误采集（js / promise / resource / react）
 *
 * 对标 Sentry / monitor-sdk @monit/error。每个错误经 @monit/fingerprint 计算
 * 双维指纹，便于后端聚合（同一崩溃点 + 同一接口错误）。
 *
 * 安全：跨域 'Script error.' 检测 + 自动注入 crossorigin="anonymous"（CORS 处理）。
 */

import type { ErrorSignal } from '@monit/contracts';
import { computeFingerprint } from '@monit/fingerprint';

export interface ErrorCallbacks {
  onError: (signal: ErrorSignal, fingerprint: { primary: string; secondary?: string }) => void;
}

let installed = false;

export function installErrors(cb: ErrorCallbacks): () => void {
  if (installed) return () => {};
  installed = true;
  const cleanups: Array<() => void> = [];

  // JS 错误（window.onerror）
  const onError = (event: ErrorEvent) => {
    // 资源加载错误（img/script/link 等失败）在 capture 阶段也会先到这里，其 target 是 Element。
    // 交给 onResourceError 处理，避免【重复上报】+ 把空 message 的资源错误【误判成 js 错误】。
    const target = event.target as Element | null;
    if (target && (target as Element).tagName) return;
    const isCrossOrigin = event.message === 'Script error.' && !event.filename;
    const signal: ErrorSignal = {
      id: `err-${event.timeStamp}`,
      type: 'js',
      message: event.message,
      stack: event.error?.stack,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      timestamp: Date.now(),
      sourceURL: event.filename,
      handled: false,
    };
    const fp = computeFingerprint({
      message: event.message,
      stack: event.error?.stack,
      filename: event.filename,
      errorType: event.error?.name ?? 'Error',
    });
    cb.onError(signal, fp);
    // 跨域脚本自动注入 crossorigin（避免后续 'Script error.'）
    if (isCrossOrigin) injectCrossorigin();
  };
  window.addEventListener('error', onError, true);
  cleanups.push(() => window.removeEventListener('error', onError, true));

  // Promise rejection
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    const message = reason?.message ?? String(reason);
    const signal: ErrorSignal = {
      id: `prom-${event.timeStamp}`,
      type: 'promise',
      message,
      stack: reason?.stack,
      timestamp: Date.now(),
      handled: false,
    };
    const fp = computeFingerprint({
      message,
      stack: reason?.stack,
      errorType: reason?.name ?? 'PromiseRejection',
      reason,
    });
    cb.onError(signal, fp);
  };
  window.addEventListener('unhandledrejection', onRejection);
  cleanups.push(() => window.removeEventListener('unhandledrejection', onRejection));

  // 资源加载错误（capture 阶段，target = Element）
  const onResourceError = (event: Event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const tag = target.tagName?.toLowerCase();
    if (!['img', 'script', 'link', 'iframe', 'audio', 'video'].includes(tag ?? '')) return;
    const url = (target as HTMLImageElement).src ?? (target as HTMLLinkElement).href ?? '';
    const signal: ErrorSignal = {
      id: `res-${Date.now()}`,
      type: 'resource',
      message: `Failed to load ${tag}: ${url}`,
      timestamp: Date.now(),
      sourceURL: url,
      handled: false,
    };
    const fp = computeFingerprint({
      message: signal.message,
      sourceURL: url,
      errorType: 'ResourceError',
    });
    cb.onError(signal, fp);
  };
  window.addEventListener('error', onResourceError, true); // capture
  cleanups.push(() => window.removeEventListener('error', onResourceError, true));

  // console.error 捕获（移植 monitor-sdk consoleError 插件）
  // 第一个参数是 Error 实例时上报 subType='console'（未抛出的业务错误值得感知）
  if (typeof console !== 'undefined' && typeof console.error === 'function') {
    const rawConsoleError = console.error;
    const patchedConsoleError = (...args: unknown[]) => {
      try {
        const first = args[0];
        if (first instanceof Error) {
          const signal: ErrorSignal = {
            id: `console-${Date.now()}`,
            type: 'console',
            message: first.message,
            stack: first.stack,
            timestamp: Date.now(),
            handled: true,
          };
          const fp = computeFingerprint({
            message: first.message, stack: first.stack, errorType: first.name,
          });
          cb.onError(signal, fp);
        }
      } catch { /* 不影响业务 console.error */ }
      rawConsoleError.apply(console, args);
    };
    console.error = patchedConsoleError;
    cleanups.push(() => { console.error = rawConsoleError; });
  }

  // Worker / SharedWorker 错误捕获（移植 monitor-sdk workerError 插件核心）
  const patchWorker = (Ctor: 'Worker' | 'SharedWorker'): void => {
    const w = typeof window !== 'undefined' ? window : undefined;
    const Orig = (w as unknown as Record<string, unknown> | undefined)?.[Ctor] as
      abstract new (scriptURL: string | URL, options?: WorkerOptions) => { addEventListener(type: string, listener: (e: Event) => void): void } | undefined;
    if (typeof Orig !== 'function') return;
    const Patched = function (this: unknown, scriptURL: string | URL, options?: WorkerOptions) {
      // @ts-expect-error construct original
      const worker = new Orig(scriptURL, options);
      try {
        worker.addEventListener('error', (e: Event) => {
          const ev = e as ErrorEvent;
          const signal: ErrorSignal = {
            id: `worker-${Date.now()}`,
            type: 'worker',
            message: ev.message || 'Script error.',
            filename: ev.filename,
            lineno: ev.lineno,
            colno: ev.colno,
            timestamp: Date.now(),
            sourceURL: String(scriptURL),
            handled: false,
          };
          cb.onError(signal, computeFingerprint({ message: signal.message, sourceURL: String(scriptURL), errorType: 'WorkerError' }));
        });
      } catch { /* ignore */ }
      return worker;
    } as unknown as typeof Orig;
    (w as unknown as Record<string, unknown>)[Ctor] = Patched;
    cleanups.push(() => { (w as unknown as Record<string, unknown>)[Ctor] = Orig; });
  };
  patchWorker('Worker');
  patchWorker('SharedWorker');

  return () => {
    cleanups.forEach(fn => fn());
    installed = false;
  };
}

/** 跨域脚本自动注入 crossorigin=anonymous（避免 'Script error.' 信息丢失） */
function injectCrossorigin(): void {
  try {
    const scripts = document.getElementsByTagName('script');
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i];
      if (s.src && !s.crossOrigin) {
        s.crossOrigin = 'anonymous';
      }
    }
  } catch { /* noop */ }
}

/**
 * React 错误边界适配：业务侧 ErrorBoundary.componentDidCatch 调用此函数上报。
 * componentStack 是 React 特有的组件树栈。
 */
export function reportReactError(
  error: Error,
  componentStack: string,
  cb: ErrorCallbacks,
): void {
  const signal: ErrorSignal = {
    id: `react-${Date.now()}`,
    type: 'react',
    message: error.message,
    stack: error.stack,
    componentStack,
    timestamp: Date.now(),
    sourceURL: error.stack?.match(/at .* \((.*?):\d+:\d+\)/)?.[1],
    handled: true,
  };
  const fp = computeFingerprint({
    message: error.message,
    stack: error.stack,
    errorType: error.name,
  });
  cb.onError(signal, fp);
}