#!/usr/bin/env node
/**
 * 一键打通真实项目：build demo-app → 上传 bundle JS + sourcemap 到 backend。
 * 之后访问 demo 触发错误/慢交互，面板即可 sourcemap 还原源码 + INP LoAF 根因下钻。
 *
 * 前置：backend 已启动（pnpm start）。用法：node scripts/run-demo.mjs
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const DEMO = join(ROOT, 'examples', 'demo-app');
const BE = 'http://127.0.0.1:3921';
const APP = 'default';
const VER = 'demo-1.0.0';

console.log('1. build demo-app（产出 bundle + sourcemap）');
execSync('npx vite build', { cwd: DEMO, stdio: 'inherit' });

console.log('\n2. 上传 bundle JS + sourcemap 到 backend（供错误栈 + LoAF 还原源码）');
const assets = join(DEMO, 'dist', 'assets');
let uploaded = 0;
for (const f of readdirSync(assets)) {
  if (!f.endsWith('.js') && !f.endsWith('.js.map')) continue;
  const url = `${BE}/api/sourcemaps/upload?appId=${APP}&version=${VER}&filename=${encodeURIComponent(f)}`;
  const res = await fetch(url, { method: 'POST', body: readFileSync(join(assets, f), 'utf-8') });
  console.log('  ', f, res.ok ? '✓' : `✗ ${res.status}`);
  if (res.ok) uploaded++;
}

console.log(`\n✓ 上传 ${uploaded} 个文件。`);
console.log('  demo 面板: http://localhost:5179  （需另开: cd examples/demo-app && npx vite preview --port 5179）');
console.log('  监控面板: http://127.0.0.1:3921');
console.log('  操作: 访问 demo → 点「直接触发 null.map」/ 滚动点击产生慢交互 → 回面板看:');
console.log('    - 错误收件箱 → sourcemap 还原 → Demo.tsx 源码');
console.log('    - Web Vitals → INP 展开 → LoAF 根因还原源码');
