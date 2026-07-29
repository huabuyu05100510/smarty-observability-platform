import { describe, it, expect } from 'vitest';
import { CodeRag, extractSnippets, embed, cosine } from '../src/rag';

describe('embed + cosine', () => {
  it('identical text -> cosine 1', () => {
    const a = embed('render list items map');
    expect(cosine(a, a)).toBeCloseTo(1, 5);
  });

  it('similar text > dissimilar', () => {
    const q = embed('render list');
    const sim = embed('render list items');
    const diff = embed('completely different unrelated words');
    expect(cosine(q, sim)).toBeGreaterThan(cosine(q, diff));
  });

  it('orthogonal-ish text -> low cosine', () => {
    expect(cosine(embed('aaa bbb'), embed('zzz yyy'))).toBeLessThanOrEqual(0.3);
  });
});

describe('CodeRag', () => {
  it('indexes functions and retrieves relevant', () => {
    const rag = new CodeRag();
    rag.indexFile('a.ts', 'function renderList(items){ return items.map(x=>x); }\nfunction fetchUser(){ return fetch("/user"); }');
    expect(rag.size()).toBeGreaterThanOrEqual(2);
    const r = rag.retrieve('render list items', 2);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].functionName).toBe('renderList');
  });

  it('returns empty when nothing indexed', () => {
    expect(new CodeRag().retrieve('x', 3)).toEqual([]);
  });
});

describe('extractSnippets', () => {
  it('reads code around resolved frame lines', () => {
    const files = new Map([['src/App.tsx', 'a\nb\nc\nconst x = renderList();\ne\nf']]);
    const snippets = extractSnippets(
      [{ source: 'src/App.tsx', line: 4, column: 5, name: null, resolved: true }],
      (p) => files.get(p) ?? null,
      1,
    );
    expect(snippets.length).toBe(1);
    expect(snippets[0].filePath).toBe('src/App.tsx');
    expect(snippets[0].code).toContain('const x = renderList()');
  });

  it('skips node_modules frames', () => {
    const snippets = extractSnippets(
      [{ source: 'node_modules/react/index.js', line: 1, column: 1, name: null, resolved: true }],
      () => 'x',
    );
    expect(snippets.length).toBe(0);
  });

  it('returns empty when file unreadable', () => {
    const snippets = extractSnippets(
      [{ source: 'missing.ts', line: 1, column: 1, name: null, resolved: true }],
      () => null,
    );
    expect(snippets.length).toBe(0);
  });
});
