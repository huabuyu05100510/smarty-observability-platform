import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { dryRunApply } from '../src/apply';
import { makeFinding } from '../src/store';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vc-app-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FOO_SRC = 'export function foo() {\n  return null;\n}\n';
const writeFoo = () => writeFileSync(path.join(dir, 'src', 'Foo.ts'), FOO_SRC, 'utf8');

function finding(file: string, search: string, replace: string) {
  return makeFinding({
    rootCause: 'foo() 返回 null 导致渲染崩溃',
    diff: { search, replace, explanation: '改返回安全兜底', risk: 'low' },
    verification: { accepted: true, reason: 'patch 命中根因', confidence: 0.85 },
    targets: [{ file, symbol: 'foo', search, replace }],
  });
}

describe('dryRunApply', () => {
  it('patches resolved file (webpack path normalized) + writes + returns diff + mrDraft', async () => {
    writeFoo();
    const r = await dryRunApply(finding('webpack:///./src/Foo.ts', 'return null;', 'return bar ?? 0;'), dir);
    expect(r.filesPatched).toHaveLength(1);
    expect(r.filesPatched[0].path).toBe('src/Foo.ts');
    expect(r.filesPatched[0].linesChanged).toBeGreaterThanOrEqual(1);
    expect(readFileSync(path.join(dir, 'src', 'Foo.ts'), 'utf8')).toContain('return bar ?? 0;');
    expect(r.unifiedDiff).toContain('--- a/src/Foo.ts');
    expect(r.unifiedDiff).toContain('+++ b/src/Foo.ts');
    expect(r.unifiedDiff).toContain('-return null;');
    expect(r.unifiedDiff).toContain('+return bar ?? 0;');
    expect(r.mrDraft.title).toMatch(/^fix\(smarty\):/);
    expect(r.mrDraft.body).toContain('foo()');
  });

  it('hallucination guard: search absent → unresolved, file untouched', async () => {
    writeFoo();
    const r = await dryRunApply(finding('src/Foo.ts', 'return GONE;', 'return 1;'), dir);
    expect(r.filesPatched).toHaveLength(0);
    expect(r.filesUnresolved).toHaveLength(1);
    expect(r.filesUnresolved[0].reason).toContain('not found');
    expect(readFileSync(path.join(dir, 'src', 'Foo.ts'), 'utf8')).toBe(FOO_SRC);
  });

  it('file not found → unresolved with candidates for grep fallback', async () => {
    const r = await dryRunApply(finding('src/Missing.ts', 'x', 'y'), dir);
    expect(r.filesPatched).toHaveLength(0);
    expect(r.filesUnresolved[0].reason).toContain('not found');
    expect(r.filesUnresolved[0].candidates.length).toBeGreaterThan(0);
  });

  it('empty search → unresolved', async () => {
    writeFoo();
    const r = await dryRunApply(finding('src/Foo.ts', '', 'x'), dir);
    expect(r.filesUnresolved[0].reason).toContain('empty search');
  });

  it('notes state dry-run (no commit/push)', async () => {
    writeFoo();
    const r = await dryRunApply(finding('src/Foo.ts', 'return null;', 'return 0;'), dir);
    expect(r.notes.join(' ')).toMatch(/NOT committed/i);
  });
});
