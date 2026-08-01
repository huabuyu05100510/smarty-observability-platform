/**
 * @monit/backend/sourcemap - sourcemap 还原（压缩栈 -> 源码行列号）
 *
 * 移植自 monitor-sdk platform/backend/src/sourcemaps/sourcemaps.service.ts（生产级实现），
 * 去掉 TypeORM（本后端内存版），保留核心还原逻辑：
 * - Vite/Rollup content-hash bundle 检测；dev 源文件直通
 * - 磁盘查找（多路径 + latest 版本回退）
 * - 可选 GitHub raw 远端回退（异步 fetch）+ 本地缓存
 * - source-map originalPositionFor + 源码路径归一（过滤 node_modules）
 * - Chrome + Firefox 栈解析
 *
 * 安全（本轮加固）：
 * - appId/version/filename 过白名单 `/^[\w][\w.\-]{0,63}$/`，filename 取 basename —— 防路径穿越。
 * - 磁盘路径用 realpathSync 校验仍在 baseDir 内 —— 防 symlink 越界。
 * - 删除 execSync(curl)：改异步 fetch（Node 18+ 全局），消除事件循环阻塞 + ESM require 报错 + 命令注入面。
 */

import fs from 'node:fs';
import path from 'node:path';
// source-map-js 同步 SourceMapConsumer
import { SourceMapConsumer } from 'source-map-js';

export interface StackFrame {
  filename: string;
  line: number;
  column: number;
}

export interface ResolvedFrame {
  source: string | null;
  line: number | null;
  column: number | null;
  name: string | null;
  resolved: boolean;
  /** 还原点附近的源码片段（来自 sourcemap sourcesContent，供面板直接展示）*/
  sourceSnippet?: string;
}

export interface SourcemapStoreOptions {
  /** 磁盘根目录，默认 ./uploads/sourcemaps */
  baseDir?: string;
  /** 可选 GitHub raw 回退基址（CI 提交的 sourcemap）：https://raw.githubusercontent.com/<owner>/<repo>/<branch> */
  githubRawBase?: string;
}

/** 安全名白名单（appId/version/filename 片段）：防路径穿越/特殊字符。 */
const SAFE_NAME = /^[\w][\w.\-]{0,63}$/;

export class SourcemapStore {
  private readonly baseDir: string;
  private readonly githubRawBase: string | null;

  constructor(opts: SourcemapStoreOptions = {}) {
    this.baseDir = path.resolve(opts.baseDir ?? './uploads/sourcemaps');
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.githubRawBase = opts.githubRawBase ? opts.githubRawBase.replace(/\/$/, '') : null;
  }

  private safeName(s: string): string | null {
    return typeof s === 'string' && SAFE_NAME.test(s) ? s : null;
  }

  /** 解析 baseDir 内的相对段路径，realpath 校验未越界（防 symlink）。新文件对其存在祖先 realpath。 */
  private resolveInside(segs: string[]): string | null {
    const target = path.resolve(this.baseDir, ...segs);
    let realRoot: string;
    try { realRoot = fs.realpathSync(this.baseDir); } catch { return null; }
    let p = target;
    const tail: string[] = [];
    while (p !== realRoot && !fs.existsSync(p)) { tail.unshift(path.basename(p)); p = path.dirname(p); }
    let realAncestor: string;
    try { realAncestor = fs.realpathSync(p); } catch { return null; }
    const realTarget = tail.length ? path.resolve(realAncestor, ...tail) : realAncestor;
    const relToRoot = path.relative(realRoot, realTarget);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot) || relToRoot === '') return null;
    return realTarget;
  }

  /** 保存上传文件（.map 或 bundle .js），存原 basename（白名单 + realpath 校验） */
  save(appId: string, version: string, filename: string, content: string): string {
    const a = this.safeName(appId);
    const v = this.safeName(version);
    const f = this.safeName(path.basename(filename));
    if (!a || !v || !f) throw new Error(`invalid appId/version/filename (path traversal rejected)`);
    const dir = this.resolveInside([a, v]);
    if (!dir) throw new Error('path traversal rejected');
    fs.mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, f);
    fs.writeFileSync(storagePath, content, 'utf-8');
    return storagePath;
  }

  /**
   * LoAF 归因还原：bundle 内 charPosition（字符偏移）→ bundle line:col → sourcemap 还原到源码。
   * 最佳实践：LoAF 上报 sourceURL + sourceCharPosition，后端用 sourcemap 还原到源码行。
   * 需事先上传对应 bundle .js + .map。
   */
  async resolveGeneratedCharPosition(appId: string, version: string, filename: string, charPosition: number): Promise<ResolvedFrame> {
    const a = this.safeName(appId);
    const v = this.safeName(version);
    const base = this.safeName(path.basename(filename).split('?')[0]);
    if (!a || !v || !base) return { source: filename, line: null, column: null, name: null, resolved: false };
    // bundle JS：尝试 base 本身（.js）或去 .map
    const bundleName = base.endsWith('.map') ? base.slice(0, -4) : base;
    const bundlePath = this.resolveInside([a, v, bundleName]);
    const mapPath = this.resolveInside([a, v, `${bundleName}.map`]);
    if (!bundlePath || !fs.existsSync(bundlePath) || !mapPath || !fs.existsSync(mapPath)) {
      return { source: filename, line: null, column: null, name: null, resolved: false };
    }
    // charPosition（0-based 字符偏移）→ 1-based line + 0-based column
    const bundle = fs.readFileSync(bundlePath, 'utf-8');
    let line = 1;
    let col = 0;
    const limit = Math.min(charPosition, bundle.length);
    for (let i = 0; i < limit; i++) {
      if (bundle[i] === '\n') { line++; col = 0; } else { col++; }
    }
    try {
      const consumer = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapPath, 'utf-8')));
      const pos = consumer.originalPositionFor({ line, column: col });
      if (!pos.source) return { source: filename, line, column: col, name: null, resolved: false };
      let resolvedSource = pos.source as string;
      if (resolvedSource.startsWith('../') || resolvedSource.startsWith('./')) {
        resolvedSource = path.posix.normalize(path.posix.join('/dist/assets', resolvedSource));
      }
      let sourceSnippet: string | undefined;
      try {
        const full = consumer.sourceContentFor(pos.source as string, true);
        if (full && typeof pos.line === 'number') {
          const ls = full.split('\n');
          const lo = Math.max(0, pos.line - 4);
          const hi = Math.min(ls.length, pos.line + 3);
          sourceSnippet = ls.slice(lo, hi).map((l, i) => `${lo + i + 1}${lo + i + 1 === pos.line ? '▶' : ' '} ${l}`).join('\n');
        }
      } catch { /* sourcesContent 不可用 */ }
      return { source: resolvedSource, line: pos.line, column: pos.column, name: pos.name ?? null, resolved: true, sourceSnippet };
    } catch {
      return { source: filename, line, column: col, name: null, resolved: false };
    }
  }

  /** 还原单帧（async：GitHub raw 回退走异步 fetch） */
  async resolveFrame(appId: string, version: string, frame: StackFrame): Promise<ResolvedFrame> {
    const a = this.safeName(appId);
    const v = this.safeName(version);
    const basename = path.basename(frame.filename).split('?')[0];
    const baseSafe = this.safeName(basename);
    // appId/version 不合法 → 不解析（防穿越/投毒）
    if (!a || !v || !baseSafe) {
      return { source: frame.filename, line: frame.line, column: frame.column, name: null, resolved: false };
    }

    // Vite/Rollup content-hash bundle 检测
    const isBundle = /[-_][a-zA-Z0-9_-]{6,}\.(js|mjs|cjs)$/.test(basename);
    // dev 源文件（http://localhost:5188/src/App.tsx）已指向源码，无需 sourcemap
    const isDevSourceFile = !isBundle && /\.(tsx?|jsx?)$/.test(frame.filename);
    if (isDevSourceFile) {
      const cleanSource = frame.filename.replace(/^https?:\/\/[^/]+/, '');
      return { source: cleanSource, line: frame.line, column: frame.column, name: null, resolved: true };
    }

    // 磁盘查找：version + latest 回退（每条 realpath 校验）
    const trySegs = [
      [a, v, `${baseSafe}.map`],
      [a, v, baseSafe],
      [a, 'latest', `${baseSafe}.map`],
      [a, 'latest', baseSafe],
    ];
    let mapPath: string | null = null;
    for (const segs of trySegs) {
      const resolved = this.resolveInside(segs);
      if (resolved && fs.existsSync(resolved)) { mapPath = resolved; break; }
    }

    // GitHub raw 远端回退 + 本地缓存（异步 fetch）
    if (!mapPath && this.githubRawBase) {
      const repoSubPath = `platform/backend/uploads/sourcemaps/${a}`;
      const urls = [
        `${repoSubPath}/${v}/${baseSafe}.map`,
        `${repoSubPath}/${v}/${baseSafe}`,
        `${repoSubPath}/latest/${baseSafe}.map`,
        `${repoSubPath}/latest/${baseSafe}`,
      ];
      for (const u of urls) {
        const content = await fetchText(`${this.githubRawBase}/${u}`);
        if (content) {
          const cacheDir = this.resolveInside([a, u.includes('/latest/') ? 'latest' : v]);
          if (cacheDir) {
            fs.mkdirSync(cacheDir, { recursive: true });
            mapPath = path.join(cacheDir, `${baseSafe}.map`);
            fs.writeFileSync(mapPath, content, 'utf-8');
            break;
          }
        }
      }
    }

    if (!mapPath) {
      return { source: frame.filename, line: frame.line, column: frame.column, name: null, resolved: false };
    }

    try {
      const rawMap = fs.readFileSync(mapPath, 'utf-8');
      const consumer = new SourceMapConsumer(JSON.parse(rawMap));
      const pos = consumer.originalPositionFor({ line: frame.line, column: frame.column });
      if (!pos.source) {
        return { source: frame.filename, line: frame.line, column: frame.column, name: null, resolved: false };
      }
      let resolvedSource = pos.source as string;
      if (resolvedSource.startsWith('../') || resolvedSource.startsWith('./')) {
        resolvedSource = path.posix.normalize(path.posix.join('/dist/assets', resolvedSource));
      }
      if (resolvedSource.includes('node_modules')) {
        return { source: frame.filename, line: frame.line, column: frame.column, name: null, resolved: false };
      }
      // 还原点附近源码片段（来自 sourcemap sourcesContent，供面板直接展示源码）
      let sourceSnippet: string | undefined;
      try {
        const full = consumer.sourceContentFor(pos.source as string, true);
        if (full && typeof pos.line === 'number') {
          const ls = full.split('\n');
          const lo = Math.max(0, pos.line - 4);
          const hi = Math.min(ls.length, pos.line + 3);
          sourceSnippet = ls.slice(lo, hi).map((l, i) => `${lo + i + 1}${lo + i + 1 === pos.line ? '▶' : ' '} ${l}`).join('\n');
        }
      } catch { /* sourcesContent 不可用 */ }
      return { source: resolvedSource, line: pos.line, column: pos.column, name: pos.name ?? null, resolved: true, sourceSnippet };
    } catch {
      return { source: frame.filename, line: frame.line, column: frame.column, name: null, resolved: false };
    }
  }

  /** 还原整条错误栈（async） */
  async resolveStack(appId: string, version: string, stack: string): Promise<ResolvedFrame[]> {
    const frames = parseStack(stack);
    return Promise.all(frames.map((f) => this.resolveFrame(appId, version, f)));
  }
}

/** Chrome/Node + Firefox 栈解析 */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  const chromeRe = /^\s+at (?:.+? \()?(.+?):(\d+):(\d+)\)?$/;
  const firefoxRe = /^(?:.*@)?(.+?):(\d+):(\d+)$/;
  for (const line of stack.split('\n')) {
    const m = chromeRe.exec(line) ?? firefoxRe.exec(line);
    if (!m) continue;
    const filename = m[1].replace(/\?[^:]*$/, '');
    if (!/\.(mjs|cjs|js|ts)x?$/.test(filename)) continue;
    if (filename.startsWith('node:') || filename === '<anonymous>') continue;
    if (filename.includes('/node_modules/')) continue;
    frames.push({ filename, line: Number(m[2]), column: Number(m[3]) });
  }
  return frames;
}

/** 异步 fetch 文本（GitHub raw 回退用，10s 超时，失败返 null）—— 替代阻塞的 execSync(curl)。 */
async function fetchText(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      const text = await res.text();
      return text && !text.includes('404: Not Found') ? text : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
