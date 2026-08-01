import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// @ts-expect-error source-map-js generator
import { SourceMapGenerator } from 'source-map-js';
import { SourcemapStore, parseStack } from '../src/index';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monit-sm-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('parseStack', () => {
  it('parses Chrome format', () => {
    const frames = parseStack('TypeError: x\n    at foo (https://h/assets/index-abc123.js:1:234)');
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual({ filename: 'https://h/assets/index-abc123.js', line: 1, column: 234 });
  });

  it('parses Firefox format', () => {
    const frames = parseStack('foo@https://h/assets/index-abc.js:10:20');
    expect(frames[0]).toEqual({ filename: 'https://h/assets/index-abc.js', line: 10, column: 20 });
  });

  it('skips node_modules and non-JS frames', () => {
    const frames = parseStack('    at x (/node_modules/y.js:1:1)\n    at z (http://h/x.css:1:1)');
    expect(frames.length).toBe(0);
  });
});

describe('SourcemapStore', () => {
  it('passes through dev source files (no map needed)', async () => {
    const s = new SourcemapStore({ baseDir: tmpDir });
    const r = await s.resolveFrame('app', 'v1', { filename: 'http://localhost:5188/src/App.tsx', line: 10, column: 5 });
    expect(r.resolved).toBe(true);
    expect(r.source).toBe('/src/App.tsx');
  });

  it('returns unresolved when no map available for bundle', async () => {
    const s = new SourcemapStore({ baseDir: tmpDir });
    const r = await s.resolveFrame('app', 'v1', { filename: 'https://h/assets/index-Abcd1234.js', line: 1, column: 100 });
    expect(r.resolved).toBe(false);
  });

  it('resolves a frame via uploaded sourcemap', async () => {
    const gen = new SourceMapGenerator({ file: 'index-Abcd1234.js', sourceRoot: '' });
    gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 42, column: 7 }, source: '../src/foo.ts' });
    gen.setSourceContent('../src/foo.ts', 'export const x = 1;');
    const mapJson = gen.toString();

    const s = new SourcemapStore({ baseDir: tmpDir });
    s.save('app', 'v1', 'index-Abcd1234.js', mapJson);
    const r = await s.resolveFrame('app', 'v1', { filename: 'https://h/assets/index-Abcd1234.js', line: 1, column: 0 });
    expect(r.resolved).toBe(true);
    expect(r.source).toContain('foo.ts');
    expect(r.line).toBe(42);
    expect(r.column).toBe(7);
  });

  it('falls back to "latest" version', async () => {
    const gen = new SourceMapGenerator({ file: 'bundle-a1b2c3d4.js' });
    gen.addMapping({ generated: { line: 1, column: 0 }, original: { line: 5, column: 0 }, source: 'src.ts' });
    const s = new SourcemapStore({ baseDir: tmpDir });
    s.save('app', 'latest', 'bundle-a1b2c3d4.js', gen.toString());
    const r = await s.resolveFrame('app', 'v9.9', { filename: 'https://h/bundle-a1b2c3d4.js', line: 1, column: 0 });
    expect(r.resolved).toBe(true);
    expect(r.line).toBe(5);
  });

  it('resolveStack resolves a full stack string', async () => {
    const gen = new SourceMapGenerator({ file: 'index-Xy9z8w7t.js' });
    gen.addMapping({ generated: { line: 1, column: 100 }, original: { line: 20, column: 3 }, source: 'src/App.tsx' });
    const s = new SourcemapStore({ baseDir: tmpDir });
    s.save('app', 'v1', 'index-Xy9z8w7t.js', gen.toString());
    const frames = await s.resolveStack('app', 'v1', '    at foo (https://h/assets/index-Xy9z8w7t.js:1:100)');
    expect(frames.length).toBe(1);
    expect(frames[0].resolved).toBe(true);
  });

  it('save 拒绝路径穿越（appId/version 含 .. 或特殊字符）', () => {
    const s = new SourcemapStore({ baseDir: tmpDir });
    expect(() => s.save('../etc', 'v1', 'x.js', '{}')).toThrow(); // appId 穿越
    expect(() => s.save('app', '../etc', 'x.js', '{}')).toThrow(); // version 穿越
    expect(() => s.save('app', 'v1', 'a b.js', '{}')).toThrow(); // filename 空格不合法
    // filename 含目录穿越 -> basename 收敛到 baseDir 内（安全，不 throw，但路径受限）
    const stored = s.save('app', 'v1', '../../etc/passwd', '{}');
    expect(stored.startsWith(fs.realpathSync(tmpDir))).toBe(true);
    // 正常名仍可存
    expect(() => s.save('app', 'v1', 'index-Abcd1234.js', '{}')).not.toThrow();
  });
});
