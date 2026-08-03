import { describe, it, expect } from 'vitest';
import { normalizeSourcePath, pathCandidates, resolveRepoFile } from '../src/normalize';

describe('normalizeSourcePath', () => {
  it('strips webpack:/// + leading ./', () => {
    expect(normalizeSourcePath('webpack:///./src/Foo.tsx')).toBe('src/Foo.tsx');
  });
  it('strips webpack:/// + leading ../', () => {
    expect(normalizeSourcePath('webpack:///../src/Foo.tsx')).toBe('src/Foo.tsx');
  });
  it('strips webpack-internal:///', () => {
    expect(normalizeSourcePath('webpack-internal:///./src/Foo.tsx')).toBe('src/Foo.tsx');
  });
  it('strips leading slash (in-repo absolute)', () => {
    expect(normalizeSourcePath('/src/Foo.tsx')).toBe('src/Foo.tsx');
  });
  it('keeps already-clean path', () => {
    expect(normalizeSourcePath('src/Foo.tsx')).toBe('src/Foo.tsx');
  });
  it('strips http(s) protocol to pathname', () => {
    expect(normalizeSourcePath('https://cdn.example.com/assets/Foo.js')).toBe('assets/Foo.js');
  });
  it('returns empty for webpack runtime internals', () => {
    expect(normalizeSourcePath('(webpack)/foo')).toBe('');
    expect(normalizeSourcePath('webpack-internal:///__webpack_require__')).toBe('');
  });
  it('strips node_modules/.cache bundler noise', () => {
    expect(normalizeSourcePath('node_modules/.cache/vite/Foo.tsx')).toBe('Foo.tsx');
  });
});

describe('pathCandidates', () => {
  it('normalized first, raw as fallback, deduped', () => {
    const c = pathCandidates('webpack:///./src/Foo.tsx');
    expect(c[0]).toBe('src/Foo.tsx');
    expect(c).toContain('webpack:///./src/Foo.tsx');
    expect(new Set(c).size).toBe(c.length);
  });
  it('clean path → single candidate', () => {
    expect(pathCandidates('src/Foo.tsx')).toEqual(['src/Foo.tsx']);
  });
});

describe('resolveRepoFile', () => {
  it('returns first existing candidate', () => {
    const fs = new Set(['src/Foo.tsx']);
    expect(resolveRepoFile(['src/Missing.tsx', 'src/Foo.tsx'], (c) => fs.has(c))).toEqual({ path: 'src/Foo.tsx' });
  });
  it('returns null when none exist', () => {
    expect(resolveRepoFile(['src/X.tsx'], () => false)).toBeNull();
  });
});
