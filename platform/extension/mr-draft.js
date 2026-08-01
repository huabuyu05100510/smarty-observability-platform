// mr-draft.js · MR 草稿生成（纯前端，零后端，不连 GitHub）
// 输入: 根因 candidate + 自愈模板结果
// 输出: 伪 unified diff + PR 卡片数据（branch / 文件 / +/-）
(function (global) {
  // TEMPLATE_DIFFS：每模板含 branch/file/hunks/diff/desc。
  // 展示只用 diff（formatDiff 只读 diff）；hunks(search/replace 草案) 为保留的 patch 元数据，
  // 当前未消费——预留给未来「真 patch 注入」场景，勿误删。
  const TEMPLATE_DIFFS = {
    debounce_handler: {
      branch: 'inp-copilot/debounce-handlers',
      file: 'src/handlers/[suggested].ts',
      hunks: [
        { search: 'const handleClick = (e) => {', replace: 'const handleClick = debounce((e) => {', label: 'add debounce wrapper' },
        { search: '};', replace: '}, 300);', label: 'close debounce' },
      ],
      diff: [
        '- const handleClick = (e) => {',
        '-   doWork(e);',
        '- };',
        '+ const handleClick = debounce((e) => {',
        '+   doWork(e);',
        '+ }, 300);',
      ],
      desc: '将高频 handler 包一层 debounce(300ms)，降低 processing 时间',
    },
    throttle_third_party: {
      branch: 'inp-copilot/throttle-3p-scripts',
      file: 'index.html',
      hunks: [
        { search: '<script src="https://www.googletagmanager.com/gtag/js?id=GA_ID"></script>', replace: '<script src="https://www.googletagmanager.com/gtag/js?id=GA_ID" async defer></script>', label: 'add async defer' },
      ],
      diff: [
        '- <script src="https://www.googletagmanager.com/gtag/js?id=GA_ID"></script>',
        '+ <script src="https://www.googletagmanager.com/gtag/js?id=GA_ID" async defer></script>',
      ],
      desc: '第三方分析脚本加 async + defer，释放主线程',
    },
    lazy_load: {
      branch: 'inp-copilot/lazy-load-images',
      file: 'src/components/[ImageComponent].tsx',
      hunks: [
        { search: '<img src={src} alt={alt} />', replace: '<img src={src} alt={alt} loading="lazy" decoding="async" />', label: 'add loading lazy' },
      ],
      diff: [
        '- <img src={src} alt={alt} />',
        '+ <img src={src} alt={alt} loading="lazy" decoding="async" />',
      ],
      desc: 'img/iframe 元素加 loading=lazy + decoding=async，降低 presentation 压力',
    },
    memo_wrap: {
      branch: 'inp-copilot/memo-heavy-component',
      file: 'src/components/[HeavyComponent].tsx',
      hunks: [
        { search: 'export default HeavyComponent;', replace: 'export default React.memo(HeavyComponent);', label: 'wrap with React.memo' },
      ],
      diff: [
        '- export default HeavyComponent;',
        '+ export default React.memo(HeavyComponent);',
      ],
      desc: '重渲染组件外层加 React.memo，减少 presentation 抖动',
    },
    inject_cleanup: {
      branch: 'inp-copilot/effect-cleanup',
      file: 'src/hooks/[useThing].ts',
      hunks: [
        { search: 'useEffect(() => {', replace: 'useEffect(() => {', label: 'existing effect' },
        { search: '}, [deps]);', replace: '  return () => {\n    clearTimeout(timer);\n    subscription.unsubscribe();\n  };\n}, [deps]);', label: 'add cleanup' },
      ],
      diff: [
        '  useEffect(() => {',
        '    const timer = setTimeout(doWork, 1000);',
        '-   const sub = subscribe(handler);',
        '- }, [deps]);',
        '+   const sub = subscribe(handler);',
        '+   return () => {',
        '+     clearTimeout(timer);',
        '+     sub.unsubscribe();',
        '+   };',
        '+ }, [deps]);',
      ],
      desc: 'useEffect 补 cleanup return，避免内存泄漏 + 持续长任务',
    },
    // === 错误域修复模板 ===
    optional_chaining: {
      branch: 'error-copilot/optional-chaining',
      file: 'src/cart/items.tsx',
      diff: [
        '-     price: item.price.toFixed(2),',
        '+     price: item?.price?.toFixed(2) ?? \'—\',',
      ],
      desc: '对 undefined 字段加可选链 + 空值兜底，消除 TypeError',
    },
    null_guard: {
      branch: 'error-copilot/null-guard',
      file: 'src/cart/items.tsx',
      diff: [
        '-   return items.map(item => ({',
        '+   if (!Array.isArray(items)) return [];',
        '+   return items.map(item => ({',
      ],
      desc: '对入参加 Array.isArray / 非空守卫，防止在异常数据上崩',
    },
    await_ordering: {
      branch: 'error-copilot/await-ordering',
      file: 'src/cart/CartView.tsx',
      diff: [
        '-   const items = getCache();',
        '-   recalcCart(items);',
        '+   const items = await fetchCart();',
        '+   recalcCart(items);',
      ],
      desc: '把 recalcCart 移到 await 之后，消除异步竞争（数据先于 fetch 被消费）',
    },
    chunk_retry: {
      branch: 'error-copilot/chunk-retry',
      file: 'src/runtime/chunkLoader.ts',
      diff: [
        '-   import(/* webpackChunkName: "cart" */ \'./cart\');',
        '+   retry(() => import(/* webpackChunkName: "cart" */ \'./cart\'), { retries: 3 });',
      ],
      desc: '动态 chunk 加失败重试 + 超时降级刷新，治理 ChunkLoadError',
    },
    // === vital (LCP/FCP/CLS) 修复模板 ===
    preload_lcp: {
      branch: 'perf-copilot/preload-lcp',
      file: 'src/app/layout.tsx',
      diff: [
        '- <head>',
        '+ <head>',
        '+   <link rel="preload" as="image" href="/assets/hero.webp" fetchpriority="high" />',
      ],
      desc: '为 LCP 主资源加 <link rel=preload as=image fetchpriority=high>，提前发起加载',
    },
    defer_css: {
      branch: 'perf-copilot/defer-non-critical-css',
      file: 'src/app/layout.tsx',
      diff: [
        '- <link rel="stylesheet" href="/assets/vendor-ui.css" />',
        '+ <link rel="stylesheet" href="/assets/vendor-ui.css" media="print" onload="this.media=\'all\'" />',
      ],
      desc: '非关键 CSS 异步加载（media 切换），关键 CSS 内联，消除首屏渲染阻塞',
    },
    font_display: {
      branch: 'perf-copilot/font-display-optional',
      file: 'src/app/fonts.ts',
      diff: [
        '- export const font = localFont({ src: "./font.woff2" });',
        '+ export const font = localFont({ src: "./font.woff2", display: "optional", adjustFontFallback: true });',
      ],
      desc: '字体 font-display: optional + metric override，消除 FOUT 回退位移',
    },
    size_attrs: {
      branch: 'perf-copilot/size-attributes',
      file: 'src/feed/MediaCard.tsx',
      diff: [
        '- <img src={media.url} />',
        '+ <img src={media.url} width={media.w} height={media.h} style={{ aspectRatio: `${media.w}/${media.h}` }} />',
      ],
      desc: 'img/iframe 声明 width/height + aspect-ratio，预留空间消除布局位移',
    },
  };

  // 主入口: 根据 candidates + applied tokens 生成 MR 草稿
  function generateMrDraft(candidates, appliedTokens) {
    const drafts = [];
    const seenTemplates = new Set();
    // file 字段标注:MR 草稿的 diff 是修复建议模板,路径多为占位 → 明确标"示例·需人工确认";
    // 若该候选带真实 filename(错误域),优先用真实文件。
    const markExample = (file) => file ? `${file} · (示例路径,需人工确认)` : '(示例路径,需人工确认)';

    // 优先从已注入的模板反推 MR
    for (const t of appliedTokens || []) {
      if (seenTemplates.has(t.templateId)) continue;
      const tmpl = TEMPLATE_DIFFS[t.templateId];
      if (tmpl) {
        drafts.push({
          ...tmpl,
          file: markExample(tmpl.file),
          templateId: t.templateId,
          status: 'draft',
          basedOn: 'applied at ' + new Date(t.appliedAt).toLocaleTimeString('zh-CN'),
        });
        seenTemplates.add(t.templateId);
      }
    }

    // 再从根因 candidates 推断可能的模板（未注入也给建议）
    for (const c of candidates || []) {
      for (const healId of c.suggestedHealIds || []) {
        if (seenTemplates.has(healId)) continue;
        const tmpl = TEMPLATE_DIFFS[healId];
        if (tmpl) {
          const realFile = c.anchors && c.anchors.filename;
          drafts.push({
            ...tmpl,
            file: realFile || markExample(tmpl.file),
            templateId: healId,
            status: 'suggested',
            basedOn: 'candidate #' + (candidates.indexOf(c) + 1) + ' · ' + c.kind + ' · ' + (c.confidence * 100).toFixed(0) + '%',
          });
          seenTemplates.add(healId);
        }
      }
    }

    return drafts;
  }

  function formatDiff(d) {
    return (d.diff || []).join('\n');
  }

  global.__inpMrDraft = { generate: generateMrDraft, format: formatDiff, TEMPLATE_DIFFS };
})(typeof globalThis !== 'undefined' ? globalThis : self);