// share.js · 分享重现(P4 新功能:用户给个链接/文件,他人能重现所有问题)
// ----------------------------------------------------------------------------
// 双模编码:
//   核心链接 = URL fragment base64(<schemaVersion, generatedAt, host, route, rootCause, events(时间窗), sessions(重放序列), config>)
//     几 KB~几十 KB,直接发链接即可还原主要问题(根因/数据/重放序列)。不含堆快照(MB 级装不下)。
//   完整文件 = .vc-repro JSON(核心现场 + heapSnapshot + 全 events),分享文件。
//
// 用法:encodeScene(scene) → {link, file};decodeLink/decodeFile → scene。
// 还原:解码 scene → putEvent 批量灌事件 + setRca(根因) + loadSessions(重放) → 各面板显示同样根因/数据。
//
// 诚实:链接是 base64 数据(无后端),不外发;他人需装本扩展,把链接粘到「导入重现」即还原。
(function (global) {
  const SCENE_VERSION = 1;
  const LINK_PREFIX = '#vc-repro=1&d=';

  // UTF-8 safe base64(btoa 不处理多字节;中文根因文本会乱码)
  function b64enc(str) {
    try { return global.btoa(unescape(encodeURIComponent(str))); }
    catch { return null; }
  }
  function b64dec(b64) {
    try { return decodeURIComponent(escape(global.atob(b64))); }
    catch { return null; }
  }

  // 编核心链接:scene → base64 URL fragment(可拼到 sidepanel.html 后)
  function encodeLink(scene) {
    const core = {
      v: SCENE_VERSION,
      generatedAt: Date.now(),
      host: scene.host || '', route: scene.route || '',
      rootCause: scene.rootCause || null,
      events: (scene.events || []).slice(-200), // 时间窗最近 200 条(控体积)
      sessions: (scene.sessions || []).slice(0, 5).map((s) => Object.assign({}, s, { meta: s.meta ? { heapEnd: s.meta.heapEnd, domEnd: s.meta.domEnd } : s.meta })), // 链接排除 domSnapshot/resources(大,留 .vc-repro 文件)
      config: scene.config || null,
    };
    const b64 = b64enc(JSON.stringify(core));
    return b64 ? LINK_PREFIX + b64 : null;
  }

  // 编完整文件:.vc-repro JSON(含 heapSnapshot + 全 events)
  function encodeFile(scene) {
    const full = {
      v: SCENE_VERSION, kind: 'vc-repro',
      generatedAt: Date.now(),
      host: scene.host || '', route: scene.route || '',
      rootCause: scene.rootCause || null,
      events: scene.events || [],
      sessions: scene.sessions || [],
      heapSnapshot: scene.heapSnapshot || null, // 堆快照 diff 结果(MB 级,仅文件)
      config: scene.config || null,
    };
    return JSON.stringify(full, null, 2);
  }

  // 端到端:scene → {link, file(文本), sizeLink, sizeFile}
  function encodeScene(scene) {
    const link = encodeLink(scene);
    const file = encodeFile(scene);
    return { link, file, sizeLink: link ? link.length : 0, sizeFile: file.length };
  }

  function decodeLink(link) {
    if (!link) return null;
    const i = link.indexOf('d=');
    if (i < 0) return null;
    const b64 = link.slice(i + 2).split('&')[0];
    const json = b64dec(b64);
    if (!json) return null;
    try { const s = JSON.parse(json); s._source = 'link'; s.hasHeap = false; return s; } catch { return null; }
  }

  function decodeFile(text) {
    try {
      const s = JSON.parse(text);
      if (!s || s.kind !== 'vc-repro') return null;
      s._source = 'file'; s.hasHeap = !!s.heapSnapshot; return s;
    } catch { return null; }
  }

  global.__share = { SCENE_VERSION, encodeLink, encodeFile, encodeScene, decodeLink, decodeFile, b64enc, b64dec };
})(typeof globalThis !== 'undefined' ? globalThis : self);
