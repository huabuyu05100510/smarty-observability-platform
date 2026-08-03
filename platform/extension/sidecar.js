// sidecar.js · 把扩展端 AI 自愈结论 findings 推给本地 vc-mcp(Claude Code 桥)
// ----------------------------------------------------------------------------
// 动机:扩展无构建环境,无法把 source diff 灌进线上 bundle。把 verified 的补丁(根因 +
// search/replace + 目标文件)推给本地 vc-mcp,Claude Code 在真实仓库 apply+测试+开 MR。
//
// 纯 fire-and-forget:vc-mcp 未启动/端口不对 → 静默,绝不阻塞面板或自愈主流程。
// 触发门:仅当 AI 补丁 sourceMatched && Verifier accepted && 用户在设置开启 sidecar(error-panels.js 守门)。
(function (global) {
  // codeSlices[0].path 形如 "src/Foo.tsx · handleX"(见 ai-rca.buildCodeContext)→ 拆 file + symbol
  function splitPathSymbol(pathStr) {
    if (!pathStr) return { file: '', symbol: '' };
    const s = String(pathStr);
    const idx = s.indexOf(' · ');
    if (idx < 0) return { file: s, symbol: '' };
    return { file: s.slice(0, idx), symbol: s.slice(idx + 3) };
  }

  // 纯函数:把面板现场组装成 findings payload(对齐 vc-mcp 的 VcFinding schema)。无网络,可单测。
  // opts = { aiHeal, verification, aiDiag, codeSlices, event, signal }
  function buildFindings(opts) {
    const g = (opts && opts.aiHeal) || {};
    const v = (opts && opts.verification) || {};
    const diag = (opts && opts.aiDiag) || {};
    const slices = (opts && opts.codeSlices) || [];
    const ev = (opts && opts.event) || {};
    const diff = g.diff || {};
    const search = String(diff.search || '');
    const replace = String(diff.replace || '');

    // targets:主目标(codeSlices[0].path 拆出的 file)+ resolvedFrames/resolvedScript 的 source 兜底(去重,≤5)
    const targets = [];
    const seen = new Set();
    const add = (file, symbol) => {
      if (!file || seen.has(file) || targets.length >= 5) return;
      seen.add(file);
      targets.push({ file, symbol: symbol || '', search, replace });
    };
    if (slices[0]) { const h = splitPathSymbol(slices[0].path); add(h.file, slices[0].symbol || h.symbol); }
    const frames = ev.resolvedFrames || [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (f && f.source) add(f.source, (f.scope && f.scope.symbol) || f.name || '');
    }
    if (ev.resolvedScript && ev.resolvedScript.source) {
      add(ev.resolvedScript.source, (ev.resolvedScript.scope && ev.resolvedScript.scope.symbol) || ev.resolvedScript.name || '');
    }

    const riskMap = { low: 0.2, medium: 0.5, high: 0.8 };
    return {
      rootCause: diag.rootCause || '',
      confidence: typeof diag.confidence === 'number' ? diag.confidence : 0,
      evidence: (diag.evidence || []).slice(),
      diagnosis: diag.rootCause || '',
      riskScore: riskMap[diff.risk] != null ? riskMap[diff.risk] : 0.5,
      riskNotes: diff.riskReason ? [diff.riskReason] : [],
      diff: {
        search, replace,
        explanation: diff.explanation || '',
        risk: diff.risk || '',
        riskReason: diff.riskReason || '',
      },
      verification: { accepted: !!v.accepted, reason: v.reason || '', confidence: typeof v.confidence === 'number' ? v.confidence : 0 },
      targets,
      sourceHint: slices[0] ? splitPathSymbol(slices[0].path).file : '',
      host: ev.host, origin: ev.origin, route: ev.route, signal: opts && opts.signal, eventId: ev.eventId,
    };
  }

  async function pushFindings(payload, url) {
    const base = String(url || (global.__vcSidecarSettings && global.__vcSidecarSettings.sidecarUrl) || 'http://127.0.0.1:7777').replace(/\/+$/, '');
    try {
      await fetch(base + '/findings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (e) { /* fire-and-forget:vc-mcp 未启动/端口不对 → 静默 */ }
  }

  global.__vcSidecar = { buildFindings, pushFindings, splitPathSymbol };
})(typeof globalThis !== 'undefined' ? globalThis : self);
