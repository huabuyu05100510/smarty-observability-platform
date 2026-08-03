# Privacy Policy — Vitals Copilot

**Effective date: 2026-08-02 · Language: 中文 / English**

Vitals Copilot 是一个**纯本地**的前端可观测工具。它不收集、不上传、不外发任何用户数据。

## Data handling · 数据处理

- **采集**：扩展在你打开的页面里读取浏览器自带的性能/错误 API（PerformanceObserver：INP / LCP / FCP / CLS / LoAF；`window.onerror` / `unhandledrejection`；元素/资源选择器）。这些数据**只存在你的浏览器里**。
- **存储**：采集到的事件写入**本扩展自身 origin 的 IndexedDB**（`inp-copilot`）与 `chrome.storage.local`（少量缓冲）。**不写入任何远端服务器，不连接任何后端**（零后端）。
- **不外发**：扩展**不向任何第三方/统计/收集服务上报数据**（无 fetch/XHR/beacon 到第三方）。唯一例外:为还原错误栈,扩展会向**你正在浏览的页面自身 origin**拉取该页面的 JS bundle 及其 source map(`sourceMappingURL`)用于本地源码定位;**不发送任何数据出域**,拉取的源码仅存本地。MR 草稿、自愈模板均在你本机生成与执行。
- **可删除**：在「设置」面板一键清空全部本地数据，或通过 Chrome 「移除扩展」彻底删除。

## Permissions · 权限清单与理由

| 权限 | 理由 |
|---|---|
| `activeTab` / `host_permissions` (`http://*/*`, `https://*/*`) | 在你浏览的任意页面上注入采集脚本，读取该页面的性能/错误指标（页面级兜底采集，无需应用接入 SDK）。 |
| `scripting` | 在目标页执行自愈模板（`world: MAIN`，prototype patch）与采集自检；按需注入，非持续。 |
| `sidePanel` | 提供侧边栏调试面板 UI。 |
| `storage` | 在 service worker 里缓冲事件（抗 SW 终止），供侧栏打开时落盘到 IndexedDB。 |
| `debugger` | **仅「内存深度分析」按需 attach**(用户显式点 attach 才启用):经 Chrome DevTools Protocol 拿精确 DOM 节点(含 detached)/监听器计数 + 堆快照 diff。attach 时浏览器顶部显示「正在调试此标签页」提示条(CDP 强制);detach 即消失。日常 advisory 模式不 attach。详见下文「内存深度分析」。 |

**不申请**：`alarms`、`tabs` 历史、`cookies`、`webRequest` 拦截、`<all-sites>` 持久后台、身份/账密、付费 API 等任何敏感权限。

## Memory deep analysis · 内存深度分析(chrome.debugger)

内存域的「深度分析」是**可选、按需、用户显式触发**的功能,用于把内存泄漏检测从「趋势推断」升级到「精确堆数据」:

- 仅当你点「attach 启用」按钮时,扩展才经 `chrome.debugger` attach 到当前标签页,用 Chrome DevTools Protocol(CDP)读取精确的 DOM 节点数(含 detached DOM)、事件监听器数、JS 堆大小,以及(堆快照 diff)堆内对象类型分布与净增长。
- attach 期间浏览器顶部会显示**「Vitals Copilot 正在调试此标签页」提示条**——这是 Chromium 对所有 debugger attach 的强制安全提示(非本扩展特有,DevTools 调试也如此)。点「detach」或关闭标签页即解除。
- **CDP 数据全程本地**:扩展只读堆快照做本地 diff,不上传任何堆数据。attach 仅授予读取**当前标签页运行时堆**的能力,不涉及其他标签页/历史/cookie。
- 日常「advisory 趋势」模式(content.js `performance.memory`)**不 attach、无提示条**——只在用户主动需要精确泄漏定位时才付出 attach 代价。

## AI Engine · AI 引擎(LLM 数据外发说明)

「AI 深诊」(真根因)和「AI 生成修复」(真自愈)用 LLM 诊断/生成补丁。**默认关闭**,只有你在设置配置 LLM(provider + API key)后才启用。

- **发什么**:只发**与当前问题相关的最小上下文**给 LLM —— source map 还原的源码片段(出错/慢函数附近)、LoAF/trace 锚点、错误栈、确定性候选。**不发全量数据、不发用户隐私、不发其他页面内容。**
- **发给谁**:发给**你自己配置的 LLM provider**(ARK/MiniMax/智谱/OpenAI/Ollama 等)。扩展不经手任何中间服务器,**直连**你填的 endpoint。
- **本地控制**:不配置 LLM → 这两个功能不可用,**零外发**。`dev-llm-key.js` 的 key 存本地(`.gitignore`,不进 git)。
- **建议**:若担心源码外发,用 **Ollama 本地模型**(完全离线,源码不出本机)。

## Self-heal caveat · 自愈说明
「模板化自愈」会在**当前页面**以 `world: MAIN` 注入预编译的 prototype patch（如给事件 listener 加 debounce）。这些 patch **仅影响当前标签页的运行时**、刷新即失效，且不修改任何文件/网络。属于实验性功能，可能影响页面行为——可在设置中关闭/不使用。

## Contact
本扩展不收集任何数据，因此无数据可披露/转移。如发现越权行为请提 issue。
