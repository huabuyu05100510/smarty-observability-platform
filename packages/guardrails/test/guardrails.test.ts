import { describe, it, expect } from 'vitest';
import {
  assessTestSufficiency,
  extractFunctionNames,
  findChangedFunctions,
} from '../src/test-sufficiency';
import { detectContamination } from '../src/contamination';
import type { AiPatchProposal } from '@monit/contracts';

function makeProposal(patches: Array<{ filePath: string; searchCode: string; replaceCode: string }>): AiPatchProposal {
  return {
    id: 'p1', basedOn: 'r1', track: 'mr-draft', patchType: 'replace',
    diagnosis: 'x', riskScore: 0.2, createdAt: 0, patches, riskNotes: [],
  };
}

describe('extractFunctionNames', () => {
  it('extracts function declarations and assignments', () => {
    const src = `
      function foo() {}
      const bar = () => {};
      function baz() { return 1; }
    `;
    const names = extractFunctionNames(src);
    expect(names).toContain('foo');
    expect(names).toContain('bar');
    expect(names).toContain('baz');
  });
});

describe('findChangedFunctions', () => {
  it('finds the function containing the search code', () => {
    const src = `
      function renderList(items) {
        return items.map(x => x);
      }
      function renderOther() {
        return null;
      }
    `;
    const fns = findChangedFunctions(src, 'items.map');
    expect(fns).toContain('renderList');
  });

  it('returns empty when search code absent', () => {
    expect(findChangedFunctions('function foo(){}', 'NOT HERE')).toEqual([]);
  });
});

describe('assessTestSufficiency', () => {
  it('high sufficiency when test file covers changed function', () => {
    const proposal = makeProposal([
      { filePath: 'src/renderList.ts', searchCode: 'items.map', replaceCode: '(items||[]).map' },
    ]);
    const result = assessTestSufficiency({
      proposal,
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){ return items.map(x=>x); }' }],
      testFiles: [{ path: 'src/renderList.test.ts', content: 'test("renderList", () => { renderList([1]); });' }],
    });
    expect(result.sufficiency).toBeGreaterThan(0.5);
    expect(result.sufficient).toBe(true);
    expect(result.uncoveredTargets).not.toContain('renderList');
  });

  it('low sufficiency when no test file exists', () => {
    const proposal = makeProposal([
      { filePath: 'src/renderList.ts', searchCode: 'items.map', replaceCode: '(items||[]).map' },
    ]);
    const result = assessTestSufficiency({
      proposal,
      sourceFiles: [{ path: 'src/renderList.ts', content: 'function renderList(items){ return items.map(x=>x); }' }],
      testFiles: [],
    });
    expect(result.sufficient).toBe(false);
    expect(result.reasons.some(r => r.includes('NO test file'))).toBe(true);
  });

  it('flags uncovered changed functions', () => {
    const proposal = makeProposal([
      { filePath: 'src/util.ts', searchCode: 'return null', replaceCode: 'return []' },
    ]);
    const result = assessTestSufficiency({
      proposal,
      sourceFiles: [{ path: 'src/util.ts', content: 'function secretFn(){ return null; }' }],
      testFiles: [{ path: 'src/util.test.ts', content: 'test("other", () => {})' }],
    });
    expect(result.uncoveredTargets).toContain('secretFn');
  });
});

describe('detectContamination', () => {
  it('detects verbatim reproduction', () => {
    const gold = 'function fix(){ return Array.isArray(x) ? x : []; }';
    const result = detectContamination({
      patchCode: gold,
      goldPatches: [gold],
    });
    expect(result.contaminated).toBe(true);
    expect(result.method).toBe('verbatim');
    expect(result.similarity).toBe(1);
  });

  it('detects verbatim when patch contains gold', () => {
    const gold = 'return Array.isArray(x) ? x : [];';
    const result = detectContamination({
      patchCode: `function fix(){ ${gold} }`,
      goldPatches: [gold],
    });
    expect(result.contaminated).toBe(true);
    expect(result.method).toBe('verbatim');
  });

  it('detects near-duplicate via token similarity', () => {
    const gold = 'function fixIt(arr) { return Array.isArray(arr) ? arr : []; }';
    const patch = 'function fixIt(arr) { return Array.isArray(arr) ? arr : []; }';
    const result = detectContamination({ patchCode: patch, goldPatches: [gold], threshold: 0.8 });
    expect(result.contaminated).toBe(true);
  });

  it('not contaminated for genuinely different patch', () => {
    const gold = 'function fixIt(arr) { return Array.isArray(arr) ? arr : []; }';
    const patch = 'const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };';
    const result = detectContamination({ patchCode: patch, goldPatches: [gold] });
    expect(result.contaminated).toBe(false);
    expect(result.method).toBe('none');
  });

  it('empty gold list -> not contaminated', () => {
    const result = detectContamination({ patchCode: 'function x(){}', goldPatches: [] });
    expect(result.contaminated).toBe(false);
  });
});