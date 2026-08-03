// error-diagnose.js · 纯前端确定性「错误」根因分析（规则引擎，无 LLM，无后端）
// 输入: error event（type:'error', subType: js|resource|promise, message/stack/filename/lineno/colno/sourceURL）
// 输出: 候选链 [{kind, confidence, evidence[], anchors, suggestedHealIds[]}] 按 confidence 降序
// 结构对齐 diagnose.js；与 INP 根因共用 RootCauseView（见 data.js 的 analyzeRootCause 统一封装）。
(function (global) {
  const has = (s, kw) => !!(s && String(s).toLowerCase().includes(kw));

  // 从 stack 文本里粗解析帧（兼容一般 Error.stack 格式）
  function parseFrames(ev) {
    const stack = ev && ev.stack;
    if (!stack) return [];
    const frames = [];
    for (const line of String(stack).split('\n')) {
      const m = line.match(/(?:at\s+)?(.*?)\s*\(?(https?:\/\/[^\s)]+|[\w./-]+\.(?:js|ts|tsx|jsx|mjs)):(\d+):(\d+)\)?/);
      if (m) frames.push({ fn: (m[1] || '').trim() || '(anonymous)', url: m[2], line: +m[3], col: +m[4] });
    }
    return frames;
  }

  const RULES = [
    {
      kind: 'error.js.async_race',
      match: (ev) => ev.subType !== 'resource' && (has(ev.message, 'undefined') || has(ev.message, 'null') || ev.subType === 'promise')
        && /fetch|await|async|promise|then\(|resolve/i.test((ev.message || '') + ' ' + (ev.stack || '')),
      confidence: (ev, f) => Math.min(0.95, 0.62 + (f.length >= 3 ? 0.25 : 0.1) + (ev.stack ? 0.05 : 0)),
      evidence: (ev, f) => [
        `${labelSub(ev.subType)} 捕获: ${(ev.message || '').slice(0, 80)}`,
        `调用栈 ${f.length} 帧${f[0] ? ' · 顶帧 ' + frameLoc(f[0]) : ''}`,
        'async 路径关键词命中 → 疑似异步竞争（数据先于 await 被消费）',
      ],
      tags: () => [{ label: 'async-race', tone: 'bad' }, { label: 'null-access', tone: 'warn' }],
      suggestedHealIds: () => ['await_ordering', 'optional_chaining'],
    },
    {
      kind: 'error.js.null_access',
      match: (ev) => ev.subType !== 'resource' && /cannot read|of undefined|of null|is not a function|is null|is undefined/i.test(ev.message || ''),
      confidence: (ev, f) => Math.min(0.92, 0.55 + (f.length >= 2 ? 0.2 : 0.05) + (ev.filename ? 0.12 : 0)),
      evidence: (ev, f) => [
        `TypeError: ${(ev.message || '').slice(0, 80)}`,
        ev.filename ? `源位置 ${shortFile(ev.filename)}:${ev.lineno || '?'}:${ev.colno || '?'}` : '无 filename',
        f[0] ? `栈顶 ${frameLoc(f[0])}` : '无堆栈',
      ],
      tags: (ev) => [{ label: 'null-access', tone: 'bad' }, { label: shortFile(ev.filename), tone: 'info' }],
      suggestedHealIds: () => ['optional_chaining', 'null_guard'],
    },
    {
      kind: 'error.js.reference_undef',
      match: (ev) => ev.subType !== 'resource' && /referenceerror|is not defined/i.test(ev.message || ''),
      confidence: (ev) => Math.min(0.85, 0.6 + (ev.stack ? 0.15 : 0)),
      evidence: (ev) => [
        `ReferenceError: ${(ev.message || '').slice(0, 80)}`,
        '引用了未定义符号 → 疑似 import 缺失 / 变量笔误 / 模块加载顺序',
      ],
      tags: () => [{ label: 'reference-undef', tone: 'warn' }],
      suggestedHealIds: () => ['null_guard'],
    },
    {
      kind: 'error.promise.unhandled',
      match: (ev) => ev.subType === 'promise',
      confidence: (ev) => Math.min(0.8, 0.55 + (ev.stack ? 0.15 : 0)),
      evidence: (ev) => [
        `Uncaught (in promise): ${(ev.message || '').slice(0, 80)}`,
        'Promise rejection 未被 .catch / await try-catch 兜住',
      ],
      tags: () => [{ label: 'unhandled-promise', tone: 'warn' }],
      suggestedHealIds: () => ['await_ordering'],
    },
    {
      kind: 'error.resource.chunkload',
      // 收紧：仅含 chunk/chunkload 字样，或形如 name.<hash>.js 的分片命名（webpack/vite 动态分片特征）；
      // 普通 vendor.js/analytics.js 404 不再误判为 ChunkLoad（落到下方 resource.failed）
      match: (ev) => ev.subType === 'resource' && /chunk|chunkload|[\w./-]+\.[a-f0-9]{6,}\.js/i.test(ev.sourceURL || ev.message || ''),
      confidence: () => 0.7,
      evidence: (ev) => [
        `ChunkLoad 失败: ${shortFile(ev.sourceURL || '')}`,
        '动态分片加载失败 → 部署版本错配 / 网络中断，建议 chunk 重试装载',
      ],
      tags: () => [{ label: 'chunkload', tone: 'fg-3' }],
      suggestedHealIds: () => ['chunk_retry'],
    },
    {
      kind: 'error.resource.failed',
      match: (ev) => ev.subType === 'resource',
      confidence: () => 0.6,
      evidence: (ev) => [
        `资源加载失败: ${shortFile(ev.sourceURL || '')}`,
        ev.message ? `(${ev.message.slice(0, 60)})` : '可能是 404 / CORS / 断网',
      ],
      tags: () => [{ label: 'resource', tone: 'info' }],
      suggestedHealIds: () => [],
    },
    {
      kind: 'error.unknown',
      match: () => true,
      confidence: () => 0.3,
      evidence: (ev) => [`未匹配已知错误模式 · ${(ev.message || '').slice(0, 60)}`],
      tags: () => [{ label: 'unknown', tone: 'fg-3' }],
      suggestedHealIds: () => [],
    },
  ];

  function analyzeErrorRootCauses(ev) {
    if (!ev) return [];
    const frames = parseFrames(ev);
    const out = [];
    const seen = new Set();
    for (const rule of RULES) {
      if (seen.has(rule.kind)) continue;
      try {
        if (rule.match(ev)) {
          out.push({
            kind: rule.kind,
            confidence: rule.confidence(ev, frames),
            evidence: (rule.evidence(ev, frames) || []).filter(Boolean),
            anchors: {
              filename: ev.filename || (frames[0] && frames[0].url),
              lineno: ev.lineno || (frames[0] && frames[0].line),
              colno: ev.colno || (frames[0] && frames[0].col),
              topFrame: frames[0] ? frameLoc(frames[0]) : undefined,
              sourceURL: ev.sourceURL,
              stackFrames: frames.length,
            },
            tags: rule.tags(ev),
            suggestedHealIds: rule.suggestedHealIds(),
          });
          seen.add(rule.kind);
        }
      } catch { /* 规则异常跳过 */ }
    }
    // ③b①:源码核对 —— 顶帧有 scope 时,把函数名/反模式补进 top 候选 evidence(错误 RCA 也结合源码)
    const rf0 = ev.resolvedFrames && ev.resolvedFrames[0];
    if (out.length && rf0 && rf0.scope && rf0.scope.body) {
      const ap = (rf0.scope.antiPatterns || []).map((p) => p.id || p);
      const sym = rf0.scope.symbol ? `函数 ${rf0.scope.symbol}` : '该函数';
      out[0].evidence = (out[0].evidence || []).concat(['源码核对: ' + sym + (ap.length ? ' 反模式 ' + ap.join('/') : ' 未见明显反模式')]);
    }
    return out.sort((a, b) => b.confidence - a.confidence);
  }

  // 工具
  function labelSub(s) { return s === 'js' ? 'window.onerror' : s === 'promise' ? 'unhandledrejection' : s === 'resource' ? 'resource' : 'error'; }
  function shortFile(u) { if (!u) return '(unknown)'; try { return decodeURIComponent(String(u)).split('/').pop().slice(0, 42); } catch { return String(u).slice(-42); } }
  function frameLoc(f) { return `${shortFile(f.url)}:${f.line}:${f.col}`; }

  global.__inpErrorDiagnose = { analyzeErrorRootCauses, parseFrames };
})(typeof globalThis !== 'undefined' ? globalThis : self);
