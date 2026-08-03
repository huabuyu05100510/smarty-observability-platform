# Vitals Copilot · 前端可观测 + 诊断 + 自愈（Chrome MV3 扩展）

> 任意页面**零集成**采集 **INP / LCP / FCP / CLS + JS 错误**，三段归因 → 模板化自愈 → MR 草稿的端到端闭环。**数据全本地 IndexedDB，零后端，不外发**。

一个浏览器扩展（Chrome MV3 / Edge / 其他 Chromium）。打开侧边栏即可看到当前页面的真实性能与错误指标，一键钻取根因、试用模板自愈、生成 MR 草稿。无需被测应用接入任何 SDK。

![INP 实时](screenshots/inp-realtime.png)

---

## 为什么

前端性能/错误问题大多在**真实用户环境**才暴露，而现有工具要么需要应用接入 SDK（改代码、发版），要么是纯在线 SaaS（数据出域、要账号）。Vitals Copilot 走第三条路：**浏览器扩展级兜底采集 + 纯本地分析**——任何页面、零改代码、数据不出浏览器。

覆盖 5 个信号的完整闭环（监控 → 归因 → 自愈 → MR → 回写历史）：

| 信号 | 采集 | 实时 | 根因 | 自愈模板 | MR 草稿 |
|---|---|---|---|---|---|
| **INP** | Event Timing + LoAF | ✓ | ✓ 三段判定 | debounce / memo / cleanup | ✓ |
| **LCP** | largest-contentful-paint + 资源时序 | ✓ | ✓ TTFB·资源·渲染阻塞 | preload / defer CSS | ✓ |
| **FCP** | first-contentful-paint + Navigation Timing | ✓ | ✓ TTFB·阻塞·解析 | defer CSS | ✓ |
| **CLS** | layout-shift + sources[] | ✓ | ✓ 无尺寸/字体/动态 DOM | size attrs / font-display | ✓ |
| **错误** | window.onerror / unhandledrejection / 资源 | ✓ 错误流 | ✓ 栈还原 + 候选链 | 可选链 / await 守卫 | ✓ |

![错误流](screenshots/error-stream.png) ![LCP 实时](screenshots/lcp-realtime.png)

---

## 安装（Load Unpacked）

1. 下载/克隆本目录 `platform/extension/`。
2. 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选中 `extension/` 目录。
4. 打开任意网页，点工具栏的 Vitals Copilot 图标（或用 Chrome 侧边栏面板）。

> 也支持 Edge / 任意 Chromium 浏览器。无需账号、无需联网。

**快速预览（不装扩展）**：浏览器直接打开 `preview.html`（内置样本数据，用于看 UI/布局）。

---

## 架构（真实跨上下文数据流）

```
  页面 (任意 origin)                         扩展 (chrome-extension://<id>)
 ┌─────────────────────────┐              ┌───────────────────────────────────┐
 │ content.js (isolated)   │  INP_UPDATE  │ background.js (service worker)    │
 │  PerformanceObserver ──┼─────────────►│  latest live 缓存 ──► sidepanel   │
 │  (INP/LCP/FCP/CLS/错误) │  EVENT       │  事件缓冲 (chrome.storage, 抗 SW  │
 │                         │─────────────►│   终止, cap 500) ──转发──► sidepanel│
 │ heal-templates.js       │              │                                   │
 │  (world: MAIN) ◄────────┼──────────────┼  scripting.executeScript(MAIN)    │
 └─────────────────────────┘   apply      │           ▲                       │
                                        ┌─┴───────────────────────────────────┐
                                        │ sidepanel.html (React, vendored)    │
                                        │  写 IndexedDB(扩展 origin) ◄ flush  │
                                        │  读 IndexedDB → 实时/历史/根因/MR UI │
                                        └─────────────────────────────────────┘
```

**关键点**：事件统一落到**扩展 origin 的 IndexedDB**（`db.js`，background 与 sidepanel 共享同一库）。
- `content.js` **不写存储**（页面 origin 与扩展 origin 的存储不共享），只把事件消息发给 background。
- `background.js` 缓冲到 `chrome.storage.local`（抗 service worker 终止）并转发 sidepanel。
- `sidepanel`（持久页面）负责写入 IndexedDB；开屏时先 flush background 缓冲，把关闭期间累积的事件补齐。

## 自愈（两档：模板 loop + AI 真自愈）

扩展自愈分两档，互补：

1. **模板自愈 loop**（`heal-loop.js` + `heal-templates.js`）：在**当前页面 MAIN world** 注入预编译 prototype patch（debounce / 第三方脚本 async / 懒加载…）。loop 自动「定位 → 生候选 → apply 代理 → 采集真实 INP → Welch t 验证 → 没到优秀则换候选重定位」，统计显著改善才判「优秀」。patch **仅影响当前标签页运行时、刷新即失效、不改文件/网络**，带 rollback token 可即时撤回。详见 [PRIVACY.md](PRIVACY.md)。
   - ⚠ 诚实局限：debounce 类 prototype patch 只包装 **apply 之后新注册** 的 listener，已注册 handler 不会被重包（多数页面 handler 在 init 期就绑完）→ 对当前页面即时效果有限。**真修请用下方「AI 真自愈」生成源码 diff**。

2. **AI 真自愈**（`ai-heal.js`）：基于具体根因 + 源码，LLM 生成针对性 `search/replace` diff（非固定模板）→ 语法校验 → Verifier 对抗 → **补丁方向验证**（见下「AI 引擎」）。复制 diff 手动应用到源码。

> 真·可回滚的热修（patch-registry-over-SDK + HMAC 签名）在配套的 `packages/collector` + `coordinator`，扩展侧为轻量试验场。

## Source Map · 真实源码还原（根因分析）

错误捕获后，`content.js` 自动按 `//# sourceMappingURL=`（或 `bundle.js.map`）拉取 source map，用内置极简消费器（`sourcemap.js`，零依赖，VLQ+mappings，与官方 `source-map` 库对齐验证）把压缩栈还原到**源文件:行:列 + sourcesContent 实际代码**。根因视图的「代码定位」卡直接展示真实源码并高亮出错行。

- **dev**：bundle 带 `sourceMappingURL` 即自动还原（同源；跨域 CDN 可能被 CORS 拦截 → 自动跳过）。
- **prod**：把 `.map` 与 bundle 同源可访问；或设置卡里关闭「自动还原」省请求。
- 设置卡：**Source Map · 根因源码还原** 开关（默认开）。

## AI 引擎 · 真根因 + 真自愈（local-first，可选）

规则引擎（`diagnose.js` / `error-diagnose.js`）是**启发式分类**，模板自愈是**固定白名单**——快，但不到源码级。配置 LLM 后，扩展用 **AI 引擎**升级为「真根因 + 真自愈」：

- **真根因**（`ai-rca.js`）：多 agent —— Navigator（选最有望候选）→ Diagnoser（结合 sourcemap 还原源码 + trace，生成「X 函数在 Y 场景因为 Z」级根因）→ Verifier（反事实对抗否决）→ 残差融合（确定性 × LLM；Verifier 否决 / grounding 失败降权）。封顶 0.9（不 100% 信任 LLM）。经共享 `RootCauseView` 对 **所有信号**（INP / 错误 / LCP / FCP / CLS…）可达，不限错误域。
- **真自愈**（`ai-heal.js`）：LLM 生成针对性 `search/replace` diff → `new Function` 语法校验 → Verifier 对抗。
- **补丁方向验证**（`heal-loop.js · runLiveProxyValidation`）：AI 补丁是**源码级**（扩展无构建环境，无法灌进线上 bundle）。若补丁能映射到最接近的**机械运行时代理**（debounce / lazy / throttle），则 apply 代理 → 采集真实 INP → Welch t → rollback，验证「修这个根因能否改善指标」的**方向**（advisory，非 diff 精确效果）。语义类补丁（memo / cleanup）诚实标注「无法运行时近似，请应用 diff 后复测」。
- **统计裁决**（`causal.js`）：Welch t / 配对 t / CUPED / Holm-Bonferroni，诚实标注「时序前后对照非 RCT，p 值 advisory」。

**local-first**：用户自带 key 存 `chrome.storage`，**只把源码片段 + trace + 现象发给 LLM 推理**，全量数据仍在本地。预设 OpenAI / ARK doubao / MiniMax / 智谱 / DeepSeek / Ollama（本地）。

> 配置：侧边栏「设置 → AI 引擎」选 provider + 填 key + model，「测试连通」预检。`dev-llm-key.js`（`.gitignore`，不进仓库）可作 storage 无配置时的兜底默认；**用户在「设置」填的 key 优先**，dev key 不再静默覆盖 UI。

## 分享重现 · 链接复现

`share.js` 双模编码现场：**核心链接**（base64 URL fragment，含根因 + 时间窗事件 + 重放序列，几 KB~几十 KB，发链接即还原主要问题）与 **完整文件** `.vc-repro`（含堆快照 + 全事件）。`replay.js` record-replay 录制真实交互序列，patch 前/后重放同一序列 → 配对 t（消除交互间固有差异）。导入：粘链接/文件 → 「导入重现」批量灌事件 + 还原根因/重放。

## 悬浮浮层 · 压在页面之上

点工具栏图标 → 在**当前页面**注入一个 fixed 高 z-index 浮层（content script + Shadow DOM 外壳 + iframe 载入 `sidepanel.html`）。
- **可拖拽**（按标题栏移动）、**可缩放**（右下角拖拽）、**可最小化**为「◆ COPILOT」小 chip，再点展开。
- **一直存在**：开关与位置记在 `chrome.storage`，跨页面导航自动恢复（mac 上不像独立弹窗会跑到浏览器后面）。
- 浮层内的 iframe 在**扩展 origin** 运行 → 自动有 chrome API + 真实 IndexedDB + sourcemap 还原，UI 与侧边栏完全一致、零重复。
- 部分严格 CSP 页面可能拒绝嵌入 `chrome-extension://` iframe（浮层不显示）—— 属浏览器安全限制。

> 也仍提供 `chrome.sidePanel`（manifest 声明），供偏好原生侧栏的用户使用。

---

## 项目结构

```
extension/
├── manifest.json          # MV3：content_scripts(采集+MAIN-heal) / background(SW) / side_panel
├── sidepanel.html         # 面板入口（加载 vendored React + 各模块）
├── background.js          # SW：消息中转 / latest 缓存 / 事件缓冲 / self-test / 自愈调度
├── content.js             # 采集：INP/LoAF/FCP/LCP/CLS/错误 → 消息发给 background
├── heal-templates.js      # 5 模板（MAIN world prototype patch + rollback）
├── db.js                  # IndexedDB 4-store 封装（events/attributions/heals/mrs）
├── diagnose.js            # INP 确定性根因规则引擎（启发式）
├── error-diagnose.js      # 错误根因规则引擎（null_access / async_race / chunkload …）
├── localize.js            # 域通用定位路由器（INP 三段 / LCP 四段 / CLS 来源类，对齐官方）
├── ai-rca.js              # AI 真根因：Navigator→Diagnoser→Verifier 多 agent + 残差融合
├── ai-heal.js             # AI 真自愈：LLM 生成 search/replace diff + Verifier + 代理映射
├── llm-client.js          # LLM 客户端（OpenAI 兼容 + Anthropic，local-first，自带 key）
├── causal.js              # 统计裁决（Welch t / 配对 t / CUPED / Holm-Bonferroni）
├── share.js  replay.js    # 链接/文件现场编码 + record-replay（配对因果用）
├── data.js                # SIGNALS 描述符 + loadVital + 统一根因封装（local 优先）
├── mr-draft.js            # MR 草稿（unified diff，跨 INP/错误/vital 模板）
├── icons.js  ui.js        # lucide 内联图标 / 共享 UI 原子
├── inp-panels.js  error-panels.js  app.js   # INP 域 / 错误域 / 主壳路由
├── icons/  fonts/  vendor/           # 图标 / Geist 字体 / React UMD
├── preview.html  preview-data.js     # 开发预览（样本数据，不入 manifest）
├── LICENSE  PRIVACY.md  README.md    # MIT / 隐私 / 本文件
└── screenshots/                      # README 截图
```

## 开发

- 纯静态、**无构建**：改完 JS 直接在 `chrome://extensions` 点扩展卡上的「刷新」即可。
- **本地开发 LLM key**（可选）：`dev-llm-key.js`（已 `.gitignore`，**不进仓库**）可写死一个 key 作「storage 无配置时」的兜底默认，省去每次配置。**用户在「设置」填的 key 优先**——dev-llm-key 仅在 storage 无 apiKey 时生效，不静默覆盖 UI 配置。⚠ 若曾误提交请立即轮换该 key。
- UI 全 `React.createElement`（vendored UMD，无打包），样式用 `:root` CSS 变量。
- 图标：应用图标 `icons/icon-{16,32,48,128}.png` 已预生成入库；UI 内联图标见 `icons.js`（lucide，MV3 CSP 合规不连 CDN）。
- 字体：自托管 Geist / Geist Mono（`fonts/`，fontsource）。

## 已知限制

- **零后端**：跨用户聚合（真·MTTR / CI / Reviewer / 全站错误率）本地不可得，面板用本地口径代理或 `—` 并标注。可选后端接线在路线图。
- 自愈为**试验性** MAIN-world patch，可能影响页面行为（刷新即恢复）。
- 仅 Chromium 系（MV3 service worker / PerformanceObserver LoAF / sidePanel）。

## 许可证

[MIT](LICENSE) © Vitals Copilot contributors.
