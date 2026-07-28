/**
 * @monit/backend/sourcemap - sourcemap 还原（压缩栈 -> 源码行列号）
 *
 * 移植自 monitor-sdk platform/backend/src/sourcemaps/sourcemaps.service.ts（生产级实现），
 * 去掉 TypeORM（本后端内存版），保留核心还原逻辑：
 * - Vite/Rollup content-hash bundle 检测；dev 源文件直通
 * - 磁盘查找（多路径 + latest 版本回退）
 * - 可选 GitHub raw 远端回退 + 本地缓存
 * - source-map originalPositionFor + 源码路径归一（过滤 node_modules）
 * - Chrome + Firefox 栈解析
 *
 * 安全：生产不部署 sourcemap，上报原始压缩栈，在隔离后端还原（本模块）。
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
}

export interface SourcemapStoreOptions {
  /** 磁盘根目录，默认 ./uploads/sourcemaps */
  baseDir?: string;
  /** 可选 GitHub raw 回退基址（CI 提交的 sourcemap）：https://raw.githubusercontent.com/<owner>/<repo>/<branch> */
  githubRawBase?: string;
}

export class SourcemapStore {
  private readonly baseDir: string;
  private readonly githubRawBase: string | null;

  constructor(opts: SourcemapStoreOptions = {}) {
    this.baseDir = path.resolve(opts.baseDir ?? './uploads/sourcemaps');
    fs.mkdirSync(this.baseDir, { recursive: true });
    this.githubRawBase = opts.githubRawBase ? opts.githubRawBase.replace(/\/$/, '') : null;
  }

  /** 保存上传的 .map 文件：<baseDir>/<appId>/<version>/<filename>.map */
  save(appId: string, version: string, filename: string, content: string): string {
    const dir = path.join(this.baseDir, appId, version);
    fs.mkdirSync(dir, { recursive: true });
    const storagePath = path.join(dir, filename.endsWith('.map') ? filename : `${filename}.map`);
    fs.writeFileSync(storagePath, content, 'utf-8');
    return storagePath;
  }

  /** 还原单帧 */
  resolveFrame(appId: string, version: string, frame: StackFrame): ResolvedFrame {
    const basename = path.basename(frame.filename).split('?')[0];
    // Vite/Rollup content-hash bundle 检测：index-f_wB0Uxy.js / main-Ab3xYZ12.js
    const isBundle = /[-_][a-zA-Z0-9_-]{6,}\.(js|mjs|cjs)$/.test(basename);
    // dev 源文件（http://localhost:5188/src/App.tsx）已指向源码，无需 sourcemap
    const isDevSourceFile = !isBundle && /\.(tsx?|jsx?)$/.test(frame.filename);
    if (isDevSourceFile) {
      const cleanSource = frame.filename.replace(/^https?:\/\/[^/]+/, '');
      return { source: cleanSource, line: frame.line, column: frame.column, name: null, resolved: true };
    }

    // 磁盘查找：version + latest 回退
    const candidates = [
      path.join(this.baseDir, appId, version, `${basename}.map`),
      path.join(this.baseDir, appId, version, basename),
      path.join(this.baseDir, appId, 'latest', `${basename}.map`),
      path.join(this.baseDir, appId, 'latest', basename),
    ];
    let mapPath = candidates.find(p => fs.existsSync(p));

    // GitHub raw 远端回退 + 本地缓存
    if (!mapPath && this.githubRawBase) {
      const repoSubPath = `platform/backend/uploads/sourcemaps/${appId}`;
      const urls = [
        `${repoSubPath}/${version}/${basename}.map`,
        `${repoSubPath}/${version}/${basename}`,
        `${repoSubPath}/latest/${basename}.map`,
        `${repoSubPath}/latest/${basename}`,
      ];
      for (const u of urls) {
        const content = fetchTextSync(`${this.githubRawBase}/${u}`);
        if (content) {
          const cacheDir = path.join(this.baseDir, appId, u.includes('/latest/') ? 'latest' : version);
          fs.mkdirSync(cacheDir, { recursive: true });
          mapPath = path.join(cacheDir, `${basename}.map`);
          fs.writeFileSync(mapPath, content, 'utf-8');
          break;
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
      return { source: resolvedSource, line: pos.line, column: pos.column, name: pos.name ?? null, resolved: true };
    } catch {
      return { source: frame.filename, line: frame.line, column: frame.column, name: null, resolved: false };
    }
  }

  /** 还原整条错误栈 */
  resolveStack(appId: string, version: string, stack: string): ResolvedFrame[] {
    const frames = parseStack(stack);
    return frames.map(f => this.resolveFrame(appId, version, f));
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
    if (!filename.includes('.js') && !filename.includes('.ts')) continue;
    if (filename.startsWith('node:') || filename === '<anonymous>') continue;
    if (filename.includes('/node_modules/')) continue;
    frames.push({ filename, line: Number(m[2]), column: Number(m[3]) });
  }
  return frames;
}

/** 同步 fetch 文本（GitHub raw 回退用，失败返 null） */
function fetchTextSync(url: string): string | null {
  // node 22+ 无同步 fetch；用 XmlHttpRequest 不可用。这里用一次性子进程同步 curl 兜底，
  // 避免把 resolveFrame 改成 async（侵入大）。无 curl 则返 null。
  try {
    const { execSync } = require('node:child_process');
    const buf = execSync(`curl -sS -m 10 ${JSON.stringify(url)}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return buf && !buf.includes('404: Not Found') ? buf : null;
  } catch {
    return null;
  }
}
