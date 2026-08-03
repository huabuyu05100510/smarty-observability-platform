// ai-rca.verify.mjs · 真根因 AI 引擎控制流测试(LLM 桩,不真调 LLM)
// Navigator→Diagnoser→Verifier→残差融合:3 次 LLM 调用 + 融合公式 + Verifier 否决 ×0.3 + 无 config 降级 + buildCodeContext。
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import vm from 'vm';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, '..');
vm.runInThisContext(readFileSync(path.join(EXT, 'ai-rca.js'), 'utf8'));
const R = globalThis.__aiRca;
const results = [];
const ok = (n, c, d) => { results.push({ name: n, pass: !!c }); console.log(`${c ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

let calls = 0;
globalThis.__llm = {
  getConfig: async () => ({ apiKey: 'k', baseUrl: 'http://x', model: 'm' }),
  chatJson: async (cfg, msgs) => {
    calls++;
    const s = msgs[0].content;
    if (s.includes('Navigator')) return { focusCandidateIndex: 0, rationale: 'r' };
    if (s.includes('Diagnoser')) return { rootCause: 'foo() O(n²) 且 N=1000', confidence: 0.85, evidence: ['evidence1'] };
    if (s.includes('Verifier')) return { refuted: false, reason: 'no counter', confidence: 0.8 };
    return null;
  },
};

(async () => {
  const r = await R.diagnose({ signal: 'inp', event: { value: 600 }, candidates: [{ kind: 'inp.heavy', confidence: 0.7, evidence: ['processingDuration 高'] }] });
  ok('diagnose 产出 rootCause(具体到函数)', !!r.rootCause && r.rootCause === 'foo() O(n²) 且 N=1000', r.rootCause);
  ok('调 3 次 LLM(Navigator/Diagnoser/Verifier)', calls === 3, 'calls=' + calls);
  const expect = Math.sqrt(0.7 * 0.85) - 0.3 * Math.abs(0.7 - 0.85);
  ok('残差融合 confidence ≈ ' + expect.toFixed(3), Math.abs(r.confidence - expect) < 0.01, 'got=' + r.confidence.toFixed(3));
  ok('Verifier 未否决', r.verification.refuted === false);
  ok('evidence 含融合 + Verifier 标注', r.evidence.some((e) => /确定性 conf/.test(e)) && r.evidence.some((e) => /Verifier/.test(e)));
  ok('置信封顶 0.9(LLM-RCA 不 100% 信任)', r.confidence <= 0.9);

  // Verifier 否决 → ×0.3
  calls = 0;
  globalThis.__llm.chatJson = async (cfg, m) => { const s = m[0].content; if (s.includes('Navigator')) return { focusCandidateIndex: 0 }; if (s.includes('Diagnoser')) return { rootCause: 'x', confidence: 0.9, evidence: [] }; return { refuted: true, reason: '反驳' }; };
  const r2 = await R.diagnose({ signal: 'inp', event: {}, candidates: [{ kind: 'x', confidence: 0.5, evidence: [] }] });
  const exp2 = Math.min(0.9, (Math.sqrt(0.5 * 0.9) - 0.3 * 0.4) * 0.3);
  ok('Verifier 否决 → confidence×0.3', Math.abs(r2.confidence - exp2) < 0.01, 'got=' + r2.confidence.toFixed(3) + ' exp=' + exp2.toFixed(3));

  // 无 config → error 降级(不抛)
  globalThis.__llm.getConfig = async () => null;
  const r3 = await R.diagnose({ signal: 'inp', event: {} });
  ok('无 LLM config → error 降级(不抛)', !!r3.error);

  // buildCodeContext 从 resolvedScript / resolvedFrames 取源码
  const cc = R.buildCodeContext({ resolvedScript: { source: 'a.js', snippet: { rows: [{ code: 'line1' }, { code: 'line2' }] } }, resolvedFrames: [{ source: 'b.js', snippet: { rows: [{ code: 'f1' }] } }] });
  ok('buildCodeContext 取源码片段', cc.length === 2 && cc[0].content.includes('line1') && cc[1].content.includes('f1'), JSON.stringify(cc.map((c) => c.path)));

  // buildCodeContext 优先 scope.body(函数体)而非 ±2 行 snippet
  const cc2 = R.buildCodeContext({ resolvedScript: { source: 'a.js', scope: { symbol: 'foo', body: 'function foo full body line', antiPatterns: [], framework: 'react' }, snippet: { rows: [{ code: 'only-snippet-line' }] } } });
  ok('buildCodeContext 优先 scope.body(非 snippet)', cc2.length === 1 && cc2[0].content === 'function foo full body line' && cc2[0].symbol === 'foo', JSON.stringify(cc2[0] && cc2[0].path));

  // grounding 核对(确定性,0 额外 LLM)
  const gs = [{ path: 'a.js · foo', content: 'function foo() { for (let i = 0; i < n; i++) document.querySelector(".x"); }' }];
  const g1 = R.groundingCheck('foo() 里循环调 querySelector', gs);
  ok('grounding:引用均在源码 → ok=true', g1.ok === true, JSON.stringify(g1));
  const g2 = R.groundingCheck('bar() in PaymentForm.tsx 导致问题', gs);
  ok('grounding:文件 PaymentForm.tsx 未在源码 → ok=false + missingFiles', g2.ok === false && g2.missingFiles.includes('PaymentForm.tsx'), JSON.stringify(g2));

  // grounding 集成:Diagnoser 引用不存在的文件 → confidence ×0.5
  globalThis.__llm.getConfig = async () => ({ apiKey: 'k', baseUrl: 'http://x', model: 'm' });
  globalThis.__llm.chatJson = async (cfg, m) => { const s = m[0].content; if (s.includes('Navigator')) return { focusCandidateIndex: 0 }; if (s.includes('Diagnoser')) return { rootCause: 'bar() in Missing.tsx 问题', confidence: 0.9, evidence: [] }; return { refuted: false, reason: 'no counter', confidence: 0.8 }; };
  const ev = { resolvedScript: { source: 'app.js', scope: { symbol: 'foo', body: 'function foo() { return 1; }', antiPatterns: [], framework: 'react' } } };
  const r4 = await R.diagnose({ signal: 'inp', event: ev, candidates: [{ kind: 'x', confidence: 0.6, evidence: [] }] });
  const baseFused = Math.min(0.9, Math.sqrt(0.6 * 0.9) - 0.3 * Math.abs(0.6 - 0.9));
  ok('grounding 失败 → confidence ×0.5', Math.abs(r4.confidence - baseFused * 0.5) < 0.01, 'got=' + r4.confidence.toFixed(3) + ' exp=' + (baseFused * 0.5).toFixed(3));
  ok('grounding 挂在 verdict(Missing.tsx missingFiles)', r4.grounding && r4.grounding.ok === false && r4.grounding.missingFiles.includes('Missing.tsx'), JSON.stringify(r4.grounding));
  ok('evidence 含 grounding 标注', r4.evidence.some((e) => /grounding/.test(e)), JSON.stringify(r4.evidence));

  // ③b③ opt-in 独立 Predictor(默认关):opts.predictor → 第 4 次 LLM 调用 + signalsAbsent 额外降权
  calls = 0;
  globalThis.__llm.getConfig = async () => ({ apiKey: 'k', baseUrl: 'http://x', model: 'm' });
  globalThis.__llm.chatJson = async (cfg, m) => { const s = m[0].content; calls++; if (s.includes('Navigator')) return { focusCandidateIndex: 0 }; if (s.includes('Diagnoser')) return { rootCause: 'foo loops', confidence: 0.8, evidence: [] }; if (s.includes('Verifier')) return { refuted: false, reason: 'ok', confidence: 0.7 }; if (s.includes('Predictor')) return { signals: [{ expected: 'x', observed: false }], signalsAbsent: true, summary: '缺信号' }; return null; };
  const rp = await R.diagnose({ signal: 'inp', event: { resolvedScript: { source: 'a.js', scope: { body: 'function foo(){ for(...) x; }', antiPatterns: [], framework: 'react' } } }, candidates: [{ kind: 'x', confidence: 0.6, evidence: [] }], predictor: true });
  ok('opt-in Predictor → 4 次 LLM 调用', calls === 4, 'calls=' + calls);
  ok('Predictor 结果挂 verdict(prediction.signalsAbsent)', rp.prediction && rp.prediction.signalsAbsent === true, JSON.stringify(rp.prediction));
  // 默认(不传 predictor)→ 仍 3 次(Verifier 内置预测检验)
  calls = 0;
  const rp2 = await R.diagnose({ signal: 'inp', event: { resolvedScript: { source: 'a.js', scope: { body: 'function foo(){}', antiPatterns: [], framework: 'react' } } }, candidates: [{ kind: 'x', confidence: 0.6, evidence: [] }] });
  ok('默认(无 predictor)→ 仍 3 次 LLM(折叠 Verifier 不增调用)', calls === 3, 'calls=' + calls);

  const failed = results.filter((x) => !x.pass);
  console.log(`\n==== ${failed.length ? 'FAILED ' + failed.length : 'ALL PASSED'} (${results.length}) ====`);
  process.exit(failed.length ? 1 : 0);
})();
