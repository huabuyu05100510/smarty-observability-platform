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
    };
  }

  global.__sourcemap = { consumeMap, decodeVlq };
})(typeof globalThis !== 'undefined' ? globalThis : self);
