/**
 * @monit/repair-agent/patch-executor - 运行时补丁注入（CDP Runtime.evaluate）
 *
 * 吸收 sentinel-x background/patch-executor.ts 的策略级联思想：
 * 5 种 patchType（replace/wrap/guard/error-boundary/prototype），
 * 每种生成注入表达式，通过 CDP Runtime.evaluate 在页面主世界执行。
 *
 * 关键独门（sentinel-x）：
 * - smart-fetch：5xx 指数退避重试 + 503 兜底 Response（网络类错误）
 * - multi-layer error boundary：window.onerror + unhandledrejection + console.error 代理（抓 React Fiber 错误）+ Vue errorHandler
 *
 * P0 实现：5 种 patch 的注入表达式生成 + CdpClient 抽象（可测试）。
 */

import type { AiPatchProposal } from '@monit/contracts';

/** CDP 客户端抽象（真实环境走 chrome-remote-interface / chrome.debugger，测试用 mock） */
export interface CdpClient {
  /** 在页面主世界执行表达式，返回 { result, exceptionDetails } */
  evaluate(expression: string): Promise<{ result?: unknown; exceptionDetails?: { text: string } }>;
}

export interface InjectionResult {
  injected: boolean;
  error?: string;
}

export interface PatchInput {
  patchType: AiPatchProposal['patchType'];
  targetPath?: string; // 如 "window.app.utils.fetchData"
  targetFunction?: string;
  code?: string; // replace/wrap/guard 的补丁代码
  /** error-boundary 的错误消息关键字 */
  errorKeyword?: string;
}

/**
 * 生成注入表达式（策略级联）。
 */
export function buildInjectionExpression(patch: PatchInput): string {
  switch (patch.patchType) {
    case 'replace':
      return buildReplaceExpression(patch);
    case 'wrap':
      return buildWrapExpression(patch);
    case 'guard':
      return buildGuardExpression(patch);
    case 'error-boundary':
      return buildErrorBoundaryExpression(patch);
    case 'prototype':
      return buildPrototypeExpression(patch);
    default:
      throw new Error(`Unknown patchType: ${patch.patchType}`);
  }
}

/** replace：直接覆盖目标函数为新实现 */
function buildReplaceExpression(patch: PatchInput): string {
  const target = patch.targetPath ?? '';
  const code = patch.code ?? '';
  return `(function(){
    var path = "${target}".split('.');
    var obj = window;
    for (var i=0;i<path.length-1;i++){ obj = obj[path[i]]; if(!obj) return false; }
    obj[path[path.length-1]] = ${code};
    return true;
  })();`;
}

/** wrap：包装原函数（前后置逻辑），保留原行为 */
function buildWrapExpression(patch: PatchInput): string {
  const target = patch.targetPath ?? '';
  const code = patch.code ?? '';
  return `(function(){
    var path = "${target}".split('.');
    var obj = window;
    for (var i=0;i<path.length-1;i++){ obj = obj[path[i]]; if(!obj) return false; }
    var key = path[path.length-1];
    var orig = obj[key];
    if (typeof orig !== 'function') return false;
    obj[key] = ${code};
    return true;
  })();`;
}

/** guard：空值守卫，可选链 + 空数组兜底 */
function buildGuardExpression(patch: PatchInput): string {
  const target = patch.targetPath ?? '';
  return `(function(){
    var path = "${target}".split('.');
    var obj = window;
    for (var i=0;i<path.length-1;i++){ obj = obj[path[i]]; if(!obj) return false; }
    var key = path[path.length-1];
    var orig = obj[key];
    if (typeof orig !== 'function') return false;
    obj[key] = function(){
      try {
        var r = orig.apply(this, arguments);
        return (r == null) ? [] : r;
      } catch(e) { return []; }
    };
    return true;
  })();`;
}

/**
 * error-boundary：多层拦截（sentinel-x 独门）。
 * window.onerror + unhandledrejection + console.error 代理（抓 React Fiber）。
 * 命中 errorKeyword 则吞掉错误，防白屏。
 */
function buildErrorBoundaryExpression(patch: PatchInput): string {
  const keyword = patch.errorKeyword ?? '';
  return `(function(){
    var KW = ${JSON.stringify(keyword)};
    function match(msg){ return KW && msg && msg.indexOf(KW) !== -1; }
    window.addEventListener('error', function(e){
      if (match(e.message)) { e.preventDefault(); window.__monit_error_caught = (window.__monit_error_caught||0)+1; }
    }, true);
    window.addEventListener('unhandledrejection', function(e){
      var msg = e.reason && (e.reason.message || String(e.reason));
      if (match(msg)) { e.preventDefault(); window.__monit_error_caught = (window.__monit_error_caught||0)+1; }
    }, true);
    // console.error 代理：抓 React Fiber 错误（React 通过 console.error 上报渲染异常）
    var _err = console.error;
    console.error = function(){
      try {
        var msg = Array.from(arguments).join(' ');
        if (match(msg)) { window.__monit_error_caught = (window.__monit_error_caught||0)+1; return; }
      } catch(_) {}
      return _err.apply(console, arguments);
    };
    return true;
  })();`;
}

/**
 * prototype：在原型上拦截，从源头阻断错误（不需函数查找）。
 * 如 Array.prototype.map 守卫、Promise.prototype.then 守卫。
 */
function buildPrototypeExpression(patch: PatchInput): string {
  const target = patch.targetPath ?? ''; // 如 "Array.prototype.map"
  return `(function(){
    var path = "${target}".split('.');
    var obj = window;
    for (var i=0;i<path.length-1;i++){ obj = obj[path[i]]; if(!obj) return false; }
    var key = path[path.length-1];
    var orig = obj[key];
    if (typeof orig !== 'function') return false;
    obj[key] = function(){
      try { return orig.apply(this, arguments); }
      catch(e) { return Array.isArray(this) ? [] : undefined; }
    };
    return true;
  })();`;
}

/** smart-fetch 注入：5xx 指数退避重试 + 503 兜底 Response（sentinel-x 独门） */
export function buildSmartFetchExpression(): string {
  return `(function(){
    if (window.__monit_smart_fetch) return true;
    window.__monit_smart_fetch = true;
    var origFetch = window.fetch;
    window.fetch = function(input, init){
      var attempt = 0;
      var max = 3;
      function go(){
        return origFetch(input, init).then(function(res){
          if ((res.status === 500 || res.status === 502 || res.status === 503) && attempt < max) {
            attempt++;
            return new Promise(function(resolve){ setTimeout(function(){ resolve(go()); }, 500 * Math.pow(2, attempt)); });
          }
          return res;
        }).catch(function(err){
          if (attempt < max) {
            attempt++;
            return new Promise(function(resolve){ setTimeout(function(){ resolve(go()); }, 500 * Math.pow(2, attempt)); });
          }
          // 兜底：返回 503 Response，避免业务代码因 fetch reject 崩溃
          return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json' } });
        });
      }
      return go();
    };
    return true;
  })();`;
}

/**
 * 通过 CDP 注入补丁。
 */
export async function executePatch(cdp: CdpClient, patch: PatchInput): Promise<InjectionResult> {
  try {
    const expr = buildInjectionExpression(patch);
    const { exceptionDetails, result } = await cdp.evaluate(expr);
    if (exceptionDetails) {
      return { injected: false, error: exceptionDetails.text };
    }
    if (result === false) {
      return { injected: false, error: `target not found or not accessible (${patch.targetPath})` };
    }
    return { injected: true };
  } catch (err) {
    return { injected: false, error: err instanceof Error ? err.message : String(err) };
  }
}