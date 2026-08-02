// checklist.js · 各领域专家 Checklist（知识层）
// 用途:"自愈"tab 不是扁平"模板白名单",而是每个领域(INP/LCP/FCP/CLS/错误)自己的
//       常见根因 → 为什么 → 专业解法方向 的清单。运行时模板(heal-templates.js 的 5 个)
//       与 MR 草稿模板(mr-draft.js 的 TEMPLATE_DIFFS)只是 checklist 里"能落地"那几条的
//       可选动作,挂在对应条目上。
//
// item 字段:
//   id        稳定 slug
//   title     常见问题(一句话)
//   why       为什么发生 / 怎么识别
//   fix       专业解法方向(具名技术)
//   evidence? 面板里指向它的信号(接 diagnose / vitalCandidates 口径)
//   healId?   仅运行时可注入模板(debounce_handler / throttle_third_party / lazy_load /
//             memo_wrap / inject_cleanup) → 该行显示「试用 patch」,复用 HealPanel.apply()
//   mrId?     MR 草稿模板 id(preload_lcp / defer_css / font_display / size_attrs /
//             optional_chaining / null_guard / await_ordering / chunk_retry) → 显示「MR 草稿」chip
//   kind      'runtime'(可试运行时 patch) | 'code'(改源码) | 'infra'(架构/后端/CDN)
(function (global) {
  const CHECKLIST = {
    inp: [
      { id: 'inp.long_handler', title: '同步长任务霸占主线程', why: 'click/input/keydown handler 里跑重计算或大循环,Event Timing processingDuration 偏高', fix: 'scheduler.yield()/rAF 分片;纯计算搬 Web Worker;读写分离防强制 reflow', evidence: 'processingDuration>50ms + LoAF 指向 handler', healId: 'debounce_handler', kind: 'runtime' },
      { id: 'inp.third_party', title: '第三方脚本抢主线程', why: 'GA/Tag Manager/嵌入 widget 在交互窗内跑长任务,inputDelay 高', fix: 'async/defer + requestIdleCallback 调度;partytown 隔离到 worker;审查哪些 tag 必须在交互前加载', evidence: 'inputDelay 高 + LoAF 脚本跨域', healId: 'throttle_third_party', kind: 'runtime' },
      { id: 'inp.rerender', title: 'React 不必要重渲染', why: '父组件 state 变化导致大子树重 render,presentation/processing 抖动', fix: 'React.memo + useCallback/useMemo 比较 Props;稳定 key;列虚拟化;把状态下沉到叶子', evidence: 'presentationDelay 抖动 + 同目标多次 render', healId: 'memo_wrap', kind: 'code' },
      { id: 'inp.layout_thrash', title: '布局抖动 (layout thrash)', why: 'handler 内先读 offsetWidth 再写 DOM,强制同步回流', fix: '读写批量分离(先读后写);rAF 合并写;改 transform/opacity 而非几何属性', evidence: 'presentationDelay 高 + 同帧多次 reflow', kind: 'code' },
      { id: 'inp.no_yield', title: '长任务不让出 (no yielding)', why: '单任务 >50ms 不切分,INP 直接劣化', fix: '长任务内插 yield 点;scheduler.yield()(Chromium)让出后续再续', evidence: 'LoAF 单帧 duration>50ms', kind: 'code' },
      { id: 'inp.leaked_effects', title: 'Effect / 监听未清理', why: '旧 listener/setInterval/订阅堆积,每次交互叠加处理', fix: 'useEffect return cleanup;removeEventListener;clearInterval/clearTimeout', evidence: '交互越多 processing 越涨(疑似泄漏)', healId: 'inject_cleanup', kind: 'code' },
    ],
    lcp: [
      { id: 'lcp.load_delay', title: '资源加载延迟·可发现性低', why: 'TTFB 后浏览器迟迟没开始拉 LCP 资源:preload scanner 没发现(JS 注入 / CSS-only ref / 误 lazy / 跨域)', fix: '<link rel=preload as=image fetchpriority=high>;首屏图写在初始 HTML;绝不 lazy;同源复用连接', evidence: 'resStart - ttfb > 300ms(load delay 段主导)', mrId: 'preload_lcp', phase: 'resourceLoadDelay', kind: 'code' },
      { id: 'lcp.load_time', title: '资源加载耗时·传输慢', why: '大图/旧格式/未压缩/源站远,拉取耗时占比大', fix: '现代格式 webp/avif;responsive srcset;压缩;图 CDN + cache', evidence: 'resEnd - resStart > 1.5s(load time 段主导)', kind: 'infra', phase: 'resourceLoadTime' },
      { id: 'lcp.slow_ttfb', title: 'TTFB 慢', why: '源站/CDN 响应慢、冷启动、重定向链', fix: '边缘缓存/CDN;SSR/ISR;preconnect;源站调优;减重定向', evidence: 'ttfb>800ms', kind: 'infra', phase: 'ttfb' },
      { id: 'lcp.render_block', title: '元素渲染延迟·渲染阻塞', why: '资源就绪后仍迟迟绘制:渲染阻塞 CSS/JS 或 CSR', fix: '关键 CSS 内联;非关键 media=print onload 异步;JS defer/async;SSR/SSG', evidence: 'value - resEnd > 400ms(render delay 段主导)', mrId: 'defer_css', phase: 'elementRenderDelay', kind: 'code' },
      { id: 'lcp.csr', title: 'LCP 元素客户端渲染', why: 'CSR 要等 JS bundle 执行才画 LCP', fix: 'LCP 区域 SSR/SSG/预渲染;骨架屏避免布局跳', evidence: 'LCP 元素在 hydration 后才出现', kind: 'infra', phase: 'elementRenderDelay' },
      { id: 'lcp.font', title: '字体阻塞文本', why: 'web font 未就绪前文字不绘制或回退闪烁', fix: 'font-display: swap/optional;预加载 woff2;fallback metric 对齐(size-adjust)', evidence: 'LCP 文本元素 + 自定义字体', mrId: 'font_display', phase: 'elementRenderDelay', kind: 'code' },
      { id: 'lcp.mislazy', title: 'LCP 图被误 lazy 加载', why: '首屏图设了 loading=lazy 反而推迟发现与加载', fix: '首屏/LCP 图绝不 lazy;给 fetchpriority=high', evidence: 'LCP 元素是 <img loading=lazy>', phase: 'resourceLoadDelay', kind: 'code' },
    ],
    fcp: [
      { id: 'fcp.slow_ttfb', title: 'TTFB 慢', why: '源站/CDN 响应慢、重定向链长', fix: 'CDN/边缘缓存;SSR;减少重定向链', evidence: 'ttfb 高', kind: 'infra' },
      { id: 'fcp.render_block', title: '渲染阻塞资源', why: '首屏 CSS / 同步 JS 阻塞首次 paint', fix: '内联关键 CSS;defer/async JS;删除未用 CSS/JS', evidence: '首屏有阻塞 link/script', mrId: 'defer_css', kind: 'code' },
      { id: 'fcp.heavy_html', title: 'HTML 过大 / 解析阻塞', why: '首屏 HTML 体积大,解析耗时长', fix: '精简首屏 HTML;预加载关键资源;减少内联大 base64', evidence: 'domParse 高', kind: 'code' },
      { id: 'fcp.third_party', title: '同步第三方 / 广告脚本', why: '首屏前加载同步第三方脚本', fix: 'async/defer;延迟到首次 paint 之后', evidence: '首屏前同步第三方 script', kind: 'code' },
      { id: 'fcp.cold_redirect', title: '冷启动 / 重定向', why: '服务端冷启动或多跳重定向拖慢首字节', fix: '预热实例;减少跳转;关键资源 preload', evidence: 'navType=redirect 或冷启动', kind: 'infra' },
    ],
    cls: [
      { id: 'cls.unsized_media', title: '图片 / iframe 无尺寸', why: '缺 width/height,资源加载后回流挤压内容', fix: '声明 width/height + aspect-ratio;CSS 占位', evidence: 'media 位移占比高', mrId: 'size_attrs', kind: 'code' },
      { id: 'cls.web_font', title: 'Web Font FOUT / FOIT', why: '字体回退或加载触发位移', fix: 'font-display: optional(零位移);fallback size-adjust 对齐', evidence: 'font 位移占比高', mrId: 'font_display', kind: 'code' },
      { id: 'cls.dynamic_dom', title: '动态注入 DOM', why: 'banner/广告/晚 hydrate 异步插入挤压已有内容', fix: '为容器预留 min-height;广告位 reserve space', evidence: 'dom 位移占比高', mrId: 'size_attrs', kind: 'code' },
      { id: 'cls.geometric_anim', title: '动画用几何属性', why: 'animate top/left/width 触发 layout', fix: '改 transform/opacity(compositor-only,不触发 layout)', evidence: '位移与动画同步出现', kind: 'code' },
      { id: 'cls.late_embed', title: '嵌入 / 第三方 widget 延迟撑开', why: 'tweet/video/评论等 widget 延迟撑开容器', fix: '预留容器尺寸 + loading skeleton', evidence: '位移源是第三方 embed', kind: 'code' },
    ],
    error: [
      { id: 'err.typeerror', title: 'TypeError: 读 undefined / null', why: '异步数据/可选字段未守卫就访问', fix: '可选链 ?. + 空值兜底 ??;入参校验;TypeScript', evidence: 'message 含 cannot read / of undefined', mrId: 'optional_chaining', kind: 'code' },
      { id: 'err.chunkload', title: 'ChunkLoadError', why: '部署后旧 hash chunk 404,旧页面仍引用', fix: '动态 import 包 retry + 失败刷新;长缓存 + 内容哈希;版本探测', evidence: 'message 含 ChunkLoad / chunk', mrId: 'chunk_retry', kind: 'code' },
      { id: 'err.async_race', title: 'unhandledrejection / 异步竞争', why: 'await 前消费数据,或未 catch 的 Promise', fix: 'await 顺序修正;try/catch 包 await;全局 rejection 兜底', evidence: 'subType=promise 或数据未就绪即消费', mrId: 'await_ordering', kind: 'code' },
      { id: 'err.resource', title: '资源加载失败 (img/script/css)', why: '跨域/CORS/网络导致资源 404 或被拦', fix: '资源 onerror 兜底;CORS 头;fallback 资源;错误边界', evidence: 'subType=resource', kind: 'code' },
      { id: 'err.render_uncaught', title: '渲染期异常未兜底', why: 'React render 抛错导致整树白屏', fix: 'ErrorBoundary 包关键路由;上报 + 降级 UI', evidence: 'render 期同步错误', kind: 'code' },
      { id: 'err.reference', title: 'ReferenceError: not defined', why: '死代码引用或构建产物缺导出', fix: '检查 import/export;tree-shaking 边界;CI 构建校验', evidence: 'message 含 is not defined', kind: 'code' },
    ],
  };

  // kind → { label, tone } 用于 UI chip
  const KIND_META = {
    runtime: { label: '运行时', tone: 'accent' }, // 可试运行时 patch
    code: { label: '源码', tone: 'info' },        // 改源码 / MR
    infra: { label: '架构', tone: 'warn' },        // CDN / 后端 / 架构
  };

  global.__checklist = { CHECKLIST, KIND_META };
})(typeof globalThis !== 'undefined' ? globalThis : self);
