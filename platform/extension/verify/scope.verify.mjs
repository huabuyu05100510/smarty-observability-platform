// scope.verify.mjs · sourcemap.js `enclose` 富化的「已知答案」测试(纯 Node)
// 验证 enclosing 函数体提取 + 串/注释/模板/正则里的 {} 不破坏边界 + 反模式 + 框架嗅探 + cap。
// enclose 是 ai-rca/ai-heal 拿到"函数体而非两行"的承重件,bracket-walk 必须钉死。
// 运行:node scope.verify.mjs
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
function loadModule(file) { vm.runInThisContext(readFileSync(path.join(EXT, file), 'utf8'), { filename: file }); }
loadModule('sourcemap.js');
const sm = globalThis.__sourcemap;

const results = [];
const ok = (n, c, d) => { results.push({ name: n, pass: !!c }); console.log(`${c ? '✓ PASS' : '✗ FAIL'}: ${n}${d ? ' — ' + d : ''}`); };

// fixture:可读源 —— 含对象字面量(串里有 })、行注释 }、块注释 { }、正则 [{ }]、嵌套 for 块、反模式
const SRC = [
  "import React, { useEffect } from 'react';",                    // 1 顶层
  "const cfg = { a: 1, b: \"}\" }; // object + brace-in-string + } line cmt", // 2 ← } 在串+注释里(必须跳过)
  "",                                                              // 3
  "function Parent() {",                                           // 4
  "  const x = '}';",                                              // 5 串里的 }
  "  return <div>{children}</div>;",                              // 6
  "}",                                                             // 7
  "",                                                              // 8
  "export function handleSubmit(event) {",                        // 9 ← enclosing fn open
  "  const re = /[{ }]/g;",                                        // 10 正则里的 { } (必须跳过)
  "  for (let i = 0; i < items.length; i++) {",                   // 11 for 块(非函数)
  "    const node = document.querySelector('.x');",               // 12 ← target(在 for 块 + handleSubmit 内)
  "    node.innerHTML = '<a href=\"}\">x</a>';",                   // 13 innerHTML + 串里的 }
  "  }",                                                           // 14 for 块闭
  "  console.log(\"done {\");",                                    // 15 串里的 {
  "  /* block { } comment */",                                     // 16 块注释里的 { }
  "  return event;",                                               // 17 ← 函数尾
  "}",                                                             // 18 ← enclosing fn close
].join('\n');

const c = sm.consumeMap({ version: 3, sources: ['app.jsx'], sourcesContent: [SRC], names: [], mappings: '' });

// ============ enclosing 函数(target=12,在 for 块内,应取最近的函数 handleSubmit 而非 for 块)============
{
  const e = c.enclose('app.jsx', 12);
  ok('enclose 返回非 null', !!e, JSON.stringify(e));
  ok('enclose 取 enclosing 函数 handleSubmit(非最内 for 块)', e && e.symbol === 'handleSubmit', 'sym=' + (e && e.symbol));
  ok('enclose body 含 querySelector(target 行)', !!(e && /querySelector/.test(e.body)));
  ok('enclose body 含 return event(横跨到函数尾)', !!(e && /return event/.test(e.body)), 'body tail=' + JSON.stringify((e && e.body || '').slice(-60)));
  ok('enclose body 不含 import(函数外)', !!(e && !/import React/.test(e.body)));
}

// ============ 串/注释/正则里的 {} 不破坏边界(承重正确性)============
// 行2 cfg 的 "}" 和 // } 、行10 正则 [{ }]、行5/13/15 串里的 } —— 若状态机漏跳,栈会错位,
// handleSubmit 边界会提前/错后闭合。证明:body 同时含 querySelector(行12)与 return event(行17)。
{
  const e = c.enclose('app.jsx', 12);
  ok('串/注释/正则 {} 全跳过 → handleSubmit 边界正确(12..17 都在 body)', !!(e && /querySelector/.test(e.body) && /return event/.test(e.body)));
}
// 直接测 enclosingPair:串里的 } 不算闭
{
  const t = 'a = "{ x }"; function f() { b; }';
  const p = sm.enclosingPair(t, t.indexOf('b'), 1000);
  ok('enclosingPair:串里 } 被跳过 → open 落在 function f 的 {', !!p && t.slice(p.open).startsWith('{ b; }'), JSON.stringify(p));
}

// ============ 反模式命中(advisory)============
{
  const e = c.enclose('app.jsx', 12);
  const ids = ((e && e.antiPatterns) || []).map((p) => p.id);
  ok('反模式命中 loop_query_selector', ids.includes('loop_query_selector'), JSON.stringify(ids));
  ok('反模式命中 inner_html', ids.includes('inner_html'), JSON.stringify(ids));
}

// ============ 框架嗅探 ============
{
  const e = c.enclose('app.jsx', 12);
  ok('framework=react(.jsx + react import)', e && e.framework === 'react', 'fw=' + (e && e.framework));
}

// ============ 顶层(无 enclosing 函数)============
{
  const e = c.enclose('app.jsx', 1); // import 行,顶层
  ok('顶层无 enclosing 函数 → body 空', !!e && e.body === '', 'body=' + JSON.stringify(e && e.body));
}

// ============ cap:大输入不卡顿 + body 截断 ============
{
  const big = 'function big(){\n' + '  var x = 1;\n'.repeat(2000) + '}\n'; // ~26KB
  const lines = big.split('\n');
  const idx = lines.findIndex((l) => /var x/.test(l));
  const cc = sm.consumeMap({ version: 3, sources: ['big.js'], sourcesContent: [big], names: [], mappings: '' });
  const t0 = Date.now();
  const e = cc.enclose('big.js', idx + 1);
  const dt = Date.now() - t0;
  ok('cap:~26KB 输入 enclose < 50ms', dt < 50, 'dt=' + dt + 'ms');
  ok('cap:body 截断到 ≤ maxBody+余量', !!(e && e.body.length <= 2020), 'len=' + (e && e.body.length));
  ok('cap:截断标记 …(truncated)', !!(e && /truncated/.test(e.body)));
}

// ============ 嵌套函数:取最近外层函数(非更外层)============
{
  const NEST = [
    'function outer() {',      // 1
    '  function inner() {',    // 2
    '    return querySelector;',// 3 ← target
    '  }',                     // 4
    '}',                       // 5
  ].join('\n');
  const cc = sm.consumeMap({ version: 3, sources: ['n.js'], sourcesContent: [NEST], names: [], mappings: '' });
  const e = cc.enclose('n.js', 3);
  ok('嵌套函数:取最近外层 inner(非 outer)', e && e.symbol === 'inner', 'sym=' + (e && e.symbol));
  ok('嵌套 inner body 不含 outer 的 function 头', !!(e && !/function outer/.test(e.body)));
}

// ============ 汇总 ============
const failed = results.filter((r) => !r.pass);
console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length} checks) ====`);
process.exit(failed.length ? 1 : 0);
