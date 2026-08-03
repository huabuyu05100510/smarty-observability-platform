// ai-heal.verify.mjs · 真自愈 AI 引擎测试(applyPatch/validateSyntax 已知答案 + generate/verify LLM 桩)
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
vm.runInThisContext(readFileSync(path.join(EXT, 'ai-heal.js'), 'utf8'));
const H = globalThis.__aiHeal;
const results = [];
const ok = (n, c, d) => { results.push({ name: n, pass: !!c }); console.log(`${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

// applyPatch(精确匹配)
ok('applyPatch 精确匹配替换', H.applyPatch('const x = 1;', { search: '1', replace: '2' }) === 'const x = 2;');
ok('applyPatch 不匹配 → null', H.applyPatch('abc', { search: 'xyz', replace: 'y' }) === null);
ok('applyPatch 多匹配取第一个', H.applyPatch('a a a', { search: 'a', replace: 'b' }) === 'b a a');
ok('applyPatch 空输入 → null', H.applyPatch('', { search: 'a', replace: 'b' }) === null);
ok('applyPatch replace 为空(删除)', H.applyPatch('const x = 1;', { search: ' = 1', replace: '' }) === 'const x;');

// validateSyntax(new Function 零依赖)
ok('validateSyntax 合法代码 → true', H.validateSyntax('const x = 1; function f(){return 1;}'));
ok('validateSyntax 非法代码 → false', H.validateSyntax('const = 1 {{{') === false);
ok('validateSyntax 空 → false', H.validateSyntax('') === false);

// generate + verify(LLM 桩)
let calls = 0;
globalThis.__llm = {
  getConfig: async () => ({ apiKey: 'k', baseUrl: 'http://x', model: 'm' }),
  chatJson: async (cfg, msgs) => {
    calls++;
    const s = msgs[0].content;
    if (s.includes('repair agent')) return { search: '() => { doWork(); }', replace: 'debounce(() => { doWork(); }, 300)', explanation: 'handler 包 debounce 降 processing', risk: 'low', riskReason: '逻辑等价仅延迟' };
    if (s.includes('Verifier')) return { accepted: true, reason: 'patch 命中且修根因', confidence: 0.85 };
    return null;
  },
};

(async () => {
  const source = 'const handleClick = () => { doWork(); };';
  const r = await H.generate({ rootCause: 'click handler 同步跑 doWork 致 processing 高', codeSlices: [{ path: 'handlers.ts', content: source }] });
  ok('generate 产出 diff(search/replace)', !!r.diff && r.diff.search && r.diff.replace);
  ok('generate sourceMatched=true(patch 命中源码)', r.sourceMatched === true);
  ok('generate syntaxOk=true(patched 语法合法)', r.syntaxOk === true, 'patched=' + r.patched);
  ok('generate patched 含 replace', r.patched && r.patched.includes('debounce'));

  // generate: source 不匹配
  const r2 = await H.generate({ rootCause: 'x', codeSlices: [{ path: 'b.js', content: 'totally different code here' }] });
  ok('generate source 不匹配 → sourceMatched=false', r2.sourceMatched === false);

  // verify(对抗)
  const v = await H.verify({ rootCause: 'x', diff: { search: 'a', replace: 'b', explanation: 'e' }, codeSlices: [] });
  ok('verify 产出 accepted/reason/confidence', v.accepted === true && v.confidence === 0.85, JSON.stringify(v));
  ok('generate+verify 共 2 次 LLM', calls === 3, 'calls=' + calls); // generate(1)+r2 generate(1)+verify(1)

  // 无 config → error 降级
  globalThis.__llm.getConfig = async () => null;
  const r3 = await H.generate({ rootCause: 'x', codeSlices: [] });
  ok('generate 无 config → error 降级(不抛)', !!r3.error);

  const failed = results.filter((x) => !x.pass);
  console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length}) ====`);
  process.exit(failed.length ? 1 : 0);
})();
