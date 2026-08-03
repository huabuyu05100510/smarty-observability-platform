// sourcemap.js · 极简 source-map v3 消费器（零依赖，移植自 backend/sourcemap.ts 的还原思路）
// 提供 consumeMap(map) → { originalPositionFor({line,column}), snippet(source,line,radius) }
// 用于把压缩栈帧 (genLine:genCol) 还原到 (源文件:行:列) + sourcesContent 源码片段。
(function (global) {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64IDX = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) B64IDX[B64.charCodeAt(i)] = i;

  // 解码一段 VLQ（base64）→ 整数数组（每个 5+5+… bit 一组，最低位为符号）
  function decodeVlq(str) {
    const out = []; let val = 0, shift = 0;
    for (let k = 0; k < str.length; k++) {
      const idx = B64IDX[str.charCodeAt(k)];
      if (idx < 0) continue;
      const cont = idx & 32;
      let bits = idx & 31;
      val += bits << shift;
      if (cont) { shift += 5; }
      else { const sign = val & 1; val >>= 1; out.push(sign ? -val : val); val = 0; shift = 0; }
    }
    return out;
  }

  // ============ SourceContext 富化:enclosing 函数体 + 反模式 + 框架(advisory,非 AST)============
  // 给 ai-rca/ai-heal 看 enclosing 函数体而非 ±2 行。轻量 bracket-walk,状态机跳过串/注释/模板/正则里的 {}。
  // 对还原后的可读源 ~90% 准;maxScan 限窗口防大 minified 包卡顿。确定性、零依赖、可单测。
  // 判定开 '{' 前是否为函数上下文(function/method/arrow),用于挑"enclosing 函数"而非最内 block。
  function isFunctionContext(text, openIdx) {
    const look = text.slice(Math.max(0, openIdx - 80), openIdx);
    if (/function\s+[A-Za-z_$]/.test(look) || /function\s*\(/.test(look)) return true; // function 声明/表达式
    if (/=>\s*$/.test(look)) return true; // arrow body
    const m = look.match(/([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/); // method 形如 NAME(...) {
    if (m && !/^(if|for|while|switch|catch|with|do|else|try|finally|return|typeof|instanceof)$/.test(m[1])) return true;
    if (/[A-Za-z_$][\w$]*\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/.test(look)) return true;
    return false;
  }
  // 取 target 偏移所在的 enclosing 函数 { } 对(优先最近函数上下文;无则降级最内 block)。
  // state 机跳过串/注释/模板/正则里的 {}。返回 {open, close, symbol} 或 null。
  function enclosingPair(text, target, maxScan) {
    if (!text || target < 0 || target >= text.length) return null;
    const win = maxScan || 32000;
    const start = Math.max(0, target - win), end = Math.min(text.length, target + win);
    const stack = []; // {open, isFunc, symbol}
    let chosen = null, snap = false, closeIdx = -1, lastClose = -1, depthAtFunc = 0;
    let i = start, state = 0, strCh = ''; // 0 code 1 lineCmt 2 blockCmt 3 string 4 regex 5 regexClass
    while (i < end && closeIdx < 0) {
      // 快照:刚到/越过 target → 从栈顶往下找最近的函数上下文 '{'(找不到则降级最内 block)
      if (!snap && i >= target) {
        snap = true;
        for (let k = stack.length - 1; k >= 0; k--) { if (stack[k].isFunc) { chosen = stack[k]; depthAtFunc = k + 1; break; } }
        if (!chosen && stack.length) { chosen = stack[stack.length - 1]; depthAtFunc = stack.length; }
      }
      // 已快照且深度回落到 chosen 之下 → lastClose 即 chosen 的配对闭
      if (snap && chosen && stack.length < depthAtFunc) { closeIdx = lastClose; break; }
      const ch = text[i], prev = i > start ? text[i - 1] : '';
      if (state === 0) {
        if (ch === '/' && text[i + 1] === '/') { state = 1; i += 2; continue; }
        if (ch === '/' && text[i + 1] === '*') { state = 2; i += 2; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { state = 3; strCh = ch; i++; continue; }
        if (ch === '/' && /[=([,!&|:{; }?+\-*<>~]/.test(prev || '(')) { state = 4; i++; continue; } // '/' 在操作符上下文 → 正则
        if (ch === '{') stack.push({ open: i, isFunc: isFunctionContext(text, i), symbol: guessSymbol(text, i) });
        else if (ch === '}') { lastClose = i; if (stack.length) stack.pop(); }
        i++;
      } else if (state === 1) { if (ch === '\n') state = 0; i++; }
      else if (state === 2) { if (ch === '*' && text[i + 1] === '/') { state = 0; i += 2; } else i++; }
      else if (state === 3) { if (ch === '\\') { i += 2; continue; } if (ch === strCh) state = 0; i++; }
      else if (state === 4) { if (ch === '\\') { i += 2; continue; } if (ch === '[') state = 5; else if (ch === '/' || ch === '\n') state = 0; i++; }
      else if (state === 5) { if (ch === '\\') { i += 2; continue; } if (ch === ']') state = 4; i++; }
    }
    if (!chosen) return null;
    if (closeIdx < 0) closeIdx = end; // 窗口内未闭合 → 截到窗口尾(降级,advisory)
    return { open: chosen.open, close: closeIdx, symbol: chosen.symbol };
  }
  // 从开 '{' 前约 80 字符嗅探函数/组件/hook 名(取最近/最右匹配,避免嵌套时误取外层)
  function guessSymbol(text, openIdx) {
    const look = text.slice(Math.max(0, openIdx - 80), openIdx);
    const last = (re) => { const g = new RegExp(re, 'g'); let m, l = null; while ((m = g.exec(look))) { l = m; if (!m[0]) g.lastIndex++; } return l; };
    let m = last(/function\s+([A-Za-z_$][\w$]*)\s*\(/); if (m) return m[1];
    m = last(/([A-Za-z_$][\w$]*)\s*(?:[:=])\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/); if (m) return m[1];
    m = last(/(use[A-Z]\w*)\s*\(/); if (m) return m[1];
    m = last(/([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/); if (m) return m[1];
    return '';
  }
  // 反模式(advisory 提示给 LLM,非判定):"值得排查"信号,宁可多报不漏报。
  const ANTI_PATTERNS = [
    { id: 'loop_query_selector', test: (b) => /\b(for|while)\b/.test(b) && /querySelector/.test(b), hint: '循环内 querySelector → 强制同步布局(reflow)嫌疑' },
    { id: 'sync_xhr', test: (b) => /new\s+XMLHttpRequest/.test(b) && /\.open\s*\([^)]*,\s*false/.test(b), hint: '同步 XMLHttpRequest → 阻塞主线程' },
    { id: 'add_event_listener', test: (b) => /addEventListener/.test(b), hint: 'addEventListener 存在 → 排查对应 removeEventListener(cleanup)' },
    { id: 'inner_html', test: (b) => /innerHTML/.test(b), hint: 'innerHTML → 重排/XSS 嫌疑' },
    { id: 'render_map', test: (b) => /return\s*\(/.test(b) && /\.map\s*\(/.test(b), hint: 'render 内 .map → 排查未 memo 导致重渲染' },
    { id: 'large_sync_loop', test: (b) => /\b(for|while)\b/.test(b) && b.length > 800, hint: '大体量同步循环 → 主线程长任务嫌疑' },
  ];
  function scanAntiPatterns(body) {
    const out = [];
    for (const p of ANTI_PATTERNS) { try { if (p.test(body)) out.push({ id: p.id, hint: p.hint }); } catch {} }
    return out;
  }
  function sniffFramework(source, text) {
    const s = String(source || '') + '\n' + String(text || '').slice(0, 4000);
    if (/\buse(State|Effect|Memo|Callback|Ref)\b|\.jsx\b|\breact\b/i.test(s)) return 'react';
    if (/\.vue\b|createApp|defineComponent|<template/i.test(s)) return 'vue';
    if (/@Component|NgModule|\bangular\b/i.test(s)) return 'angular';
    if (/<script context|\bsvelte\b/i.test(s)) return 'svelte';
    return 'unknown';
  }

  function consumeMap(map) {
    const sources = map.sources || [];
    const contents = map.sourcesContent || [];
    const names = map.names || [];
    const lines = String(map.mappings || '').split(';');
    // 解析每条生成行的 segment（绝对值）。delta 跨整映射累积，genCol 每行重置。
    const parsed = [];
    let pSrc = 0, pLine = 0, pCol = 0, pName = 0;
    for (let li = 0; li < lines.length; li++) {
      let pGen = 0;
      const segs = [];
      const segStrs = lines[li] ? lines[li].split(',') : [];
      for (const s of segStrs) {
        if (!s) continue;
        const v = decodeVlq(s);
        let i = 0;
        pGen += v[i++] || 0;
        let src = null, line = null, col = null, name = null;
        if (v.length > 1) {
          pSrc += v[i++] || 0; src = pSrc;
          pLine += v[i++] || 0; line = pLine;
          pCol += v[i++] || 0; col = pCol;
          if (v.length > i) { pName += v[i] || 0; name = pName; }
        }
        segs.push({ genCol: pGen, src, line, col, name });
      }
      parsed.push(segs);
    }
    return {
      sources, contents,
      originalPositionFor({ line, column }) {
        const li = (line || 1) - 1;
        if (li < 0 || li >= parsed.length) return { source: null, line: null, column: null, name: null };
        let best = null;
        for (const s of parsed[li]) { if (s.genCol <= (column || 0)) best = s; else break; }
        if (!best || best.src == null) return { source: null, line: null, column: null, name: null };
        return {
          source: sources[best.src] != null ? sources[best.src] : null,
          line: best.line != null ? best.line + 1 : null,        // map 源行 0-based → 1-based
          column: best.col != null ? best.col + 1 : null,        // 源列 0-based → 1-based
          name: best.name != null ? names[best.name] || null : null,
        };
      },
      snippet(source, line, radius = 2) {
        const idx = sources.indexOf(source);
        if (idx < 0 || !contents[idx]) return null;
        const arr = contents[idx].split('\n');
        const center = (line || 1) - 1;
        const start = Math.max(0, center - radius);
        const end = Math.min(arr.length, center + radius + 1);
        const rows = [];
        for (let i = start; i < end; i++) rows.push({ n: i + 1, code: arr[i] });
        return { rows, hl: center - start };
      },
      // SourceContext 富化:enclosing 函数体 + 反模式 + 框架。RCA/heal 用 body 替代 ±2 行盲猜。
      enclose(source, line, opts) {
        const o = opts || {};
        const maxBody = o.maxBody || 2000;
        const maxScan = o.maxScan || 32000;
        const idx = sources.indexOf(source);
        if (idx < 0 || !contents[idx]) return null;
        const text = contents[idx];
        const arr = text.split('\n');
        const center = (line || 1) - 1;
        if (center < 0 || center >= arr.length) return null;
        let lineStart = 0;
        for (let k = 0; k < center; k++) lineStart += arr[k].length + 1;
        const pair = enclosingPair(text, lineStart, maxScan);
        let body = '', symbol = '';
        if (pair && pair.open >= 0 && pair.close > pair.open) {
          body = text.slice(pair.open + 1, pair.close);
          symbol = pair.symbol || guessSymbol(text, pair.open);
        }
        if (body.length > maxBody) body = body.slice(0, maxBody) + '\n…(truncated)';
        return { symbol, body, antiPatterns: scanAntiPatterns(body), framework: sniffFramework(source, text) };
      },
    };
  }

  global.__sourcemap = { consumeMap, decodeVlq, enclosingPair, isFunctionContext, guessSymbol, scanAntiPatterns, sniffFramework, ANTI_PATTERNS };
})(typeof globalThis !== 'undefined' ? globalThis : self);
