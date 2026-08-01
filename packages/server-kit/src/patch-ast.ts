/**
 * 热修代码【严格】AST 白名单校验（服务端，acorn）。
 *
 * 服务端登记 patch 时强制校验 —— 恶意/危险代码根本进不了注册表，是"不可绕过"的主防线。
 * 浏览器侧 validatePatchCodeLight（token 黑名单）是第二层兜底。
 *
 * 校验语义对齐运行时：SDK 执行 `new Function('return ' + code)()`，故这里把 code 作为
 * return 表达式包进函数体来 parse，遍历整棵 AST：
 *  1. 仅允许白名单节点类型（禁 NewExpression/循环/Yield/Await/Import 等）；
 *  2. 标识符黑名单（网络/全局/DOM/原型链/反射）；
 *  3. 字符串字面量禁协议子串；
 *  4. ★禁止一切 computed member 访问（防 Function 构造器逃逸，见下）。
 *
 * ★ RCE 防线（曾漏洞，已修）：`new Function` 体系下，允许函数表达式 + computed 属性即可拿到
 *  Function 构造器：`(()=>{})["con"+"structor"]` ≡ eval。原"computed 字面量属性禁黑名单"只拦
 *  Literal 属性，拼字符串（BinaryExpression）/变量（Identifier）属性的 computed 访问直接滑过，
 *  形成签名背书的 RCE。修法：禁止一切 computed member —— 合法热修只用静态属性（obj.foo /
 *  orig.apply），无需 computed。所有危险全局（constructor/__proto__/process/fetch…）均在标识符
 *  黑名单，只能经静态成员（被规则 2 拦）或 computed（现被规则 4 全拦）到达，故 Function 逃逸链闭合。
 */
import { parse } from 'acorn';
import type { PatchCodeValidation } from '@monit/crypto-kit';

interface AcornNode {
  type: string;
  [key: string]: unknown;
}

const ALLOWED_NODE_TYPES = new Set<string>([
  'Program', 'ExpressionStatement', 'BlockStatement', 'EmptyStatement',
  'ReturnStatement', 'IfStatement',
  'FunctionExpression', 'ArrowFunctionExpression',
  'VariableDeclaration', 'VariableDeclarator',
  'BinaryExpression', 'LogicalExpression', 'UnaryExpression', 'UpdateExpression', 'AssignmentExpression',
  'MemberExpression', 'CallExpression', 'SpreadElement', 'RestElement',
  'ArrayExpression', 'ObjectExpression', 'Property', 'ObjectPattern', 'ArrayPattern', 'AssignmentPattern',
  'ConditionalExpression', 'SequenceExpression', 'ChainExpression',
  'Identifier', 'Literal', 'ThisExpression',
  'TryStatement', 'CatchClause', 'ThrowStatement',
  'TemplateLiteral', 'TemplateElement',
]);

const FORBIDDEN_IDENTIFIERS = new Set<string>([
  // 动态代码执行
  'eval', 'Function', 'importScripts', 'require', 'import',
  // 网络
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'navigator',
  // 全局破坏 / BOM
  'globalThis', 'process', 'window', 'self', 'top', 'parent', 'frames', 'opener',
  'location', 'navigate', 'open', 'close', 'alert', 'confirm', 'prompt',
  'postMessage', 'addEventListener', 'removeEventListener',
  // 存储
  'localStorage', 'sessionStorage', 'indexedDB', 'cookie',
  // 原型链污染
  'constructor', 'prototype', '__proto__',
  // 底层/反射
  'WebAssembly', 'SharedArrayBuffer', 'Atomics', 'Proxy', 'Reflect',
  'queueMicrotask', 'structuredClone', 'exports', 'module', 'document', 'script',
  // 计时器（防 covert channel / 定时外泄；热修用同步逻辑）
  'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame', 'requestIdleCallback',
]);

const FORBIDDEN_LITERAL_SUBSTRINGS = ['://', 'data:', 'blob:', 'javascript:', 'vbscript:', 'file:'];

function walk(node: unknown, cb: (n: AcornNode) => boolean | void): void {
  if (!node || typeof node !== 'object') return;
  const n = node as AcornNode;
  if (typeof n.type !== 'string') return;
  if (cb(n) === false) return;
  for (const key in n) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc' || key === 'range' || key === 'sourceType') continue;
    const v = n[key] as unknown;
    if (Array.isArray(v)) {
      for (const c of v) walk(c, cb);
    } else if (v && typeof v === 'object' && typeof (v as AcornNode).type === 'string') {
      walk(v, cb);
    }
  }
}

export function validatePatchCodeStrict(code: string): PatchCodeValidation {
  if (typeof code !== 'string' || code.length === 0) return { ok: false, reason: 'empty code' };
  if (code.length > 4096) return { ok: false, reason: 'code too long (>4096)' };

  let ast: unknown;
  try {
    // 对齐运行时 new Function('return ' + code)：把 code 作为 return 表达式包进函数体
    ast = parse(`(function(){return(${code});})`, { ecmaVersion: 'latest' });
  } catch {
    return { ok: false, reason: 'parse error (invalid JS)' };
  }

  let issue: string | undefined;
  walk(ast, (n) => {
    if (issue) return false;
    if (!ALLOWED_NODE_TYPES.has(n.type)) {
      issue = `disallowed node type: ${n.type}`;
      return false;
    }
    if (n.type === 'Identifier') {
      const name = n.name as string;
      if (typeof name === 'string' && FORBIDDEN_IDENTIFIERS.has(name)) {
        issue = `forbidden identifier: ${name}`;
        return false;
      }
    }
    if (n.type === 'Literal' && typeof n.value === 'string') {
      const v = n.value.toLowerCase();
      if (FORBIDDEN_LITERAL_SUBSTRINGS.some((s) => v.includes(s))) {
        issue = 'forbidden literal substring (protocol/url)';
        return false;
      }
    }
    // ★ 禁止一切 computed member 访问（无论属性是 Literal/BinaryExpression/Identifier）。
    // 只允许静态属性 obj.foo（其 property 是 Identifier，由上面的标识符黑名单兜底）。
    // 理由：拼字符串 computed（["con"+"structor"]）可绕过字面量检查拿到 Function 构造器 → RCE。
    if (n.type === 'MemberExpression' && n.computed) {
      issue = 'computed member access forbidden (hotfix code must use static property access only)';
      return false;
    }
    if (n.type === 'TemplateElement') {
      const raw = (n.value as { raw?: string; cooked?: string })?.cooked ?? '';
      if (typeof raw === 'string' && FORBIDDEN_LITERAL_SUBSTRINGS.some((s) => raw.toLowerCase().includes(s))) {
        issue = 'forbidden template literal substring (protocol/url)';
        return false;
      }
    }
    return true;
  });

  return issue ? { ok: false, reason: issue } : { ok: true };
}
