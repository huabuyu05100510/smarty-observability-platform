import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadFindings, saveFindings, appendFinding, clearFindings, latest, makeFinding } from '../src/store';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vc-'));
  file = path.join(dir, 'f.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const f = (id: string) => makeFinding({ id, createdAt: Number(id), rootCause: id });

describe('store', () => {
  it('loadFindings missing file → []', () => {
    expect(loadFindings(file)).toEqual([]);
  });
  it('append + load round-trip preserves order', () => {
    appendFinding(file, f('1'));
    appendFinding(file, f('2'));
    expect(loadFindings(file).map((i) => i.id)).toEqual(['1', '2']);
  });
  it('cap evicts oldest (FIFO)', () => {
    for (let i = 1; i <= 5; i++) appendFinding(file, f(String(i)), 3);
    expect(loadFindings(file).map((i) => i.id)).toEqual(['3', '4', '5']);
  });
  it('clear empties', () => {
    appendFinding(file, f('1'));
    clearFindings(file);
    expect(loadFindings(file)).toEqual([]);
  });
  it('latest returns last appended', () => {
    appendFinding(file, f('1'));
    appendFinding(file, f('2'));
    expect(latest(loadFindings(file))?.id).toBe('2');
  });
  it('latest of empty → null', () => {
    expect(latest([])).toBeNull();
  });
  it('corrupt file → [] (no throw)', () => {
    saveFindings(file, [f('1')]);
    writeFileSync(file, '{not valid json', 'utf8');
    expect(loadFindings(file)).toEqual([]);
  });
  it('makeFinding assigns server id + defaults', () => {
    const m = makeFinding({ rootCause: 'x' });
    expect(m.id).toMatch(/^f-\d+-/);
    expect(m.rootCause).toBe('x');
    expect(m.targets).toEqual([]);
    expect(m.diff).toEqual({ search: '', replace: '' });
  });
});
