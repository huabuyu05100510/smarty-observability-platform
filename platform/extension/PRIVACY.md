# Privacy Policy — Vitals Copilot

**Effective date: 2026-07-31 · Language: 中文 / English**

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
| `alarms` | 调度自愈 patch 的定时自动回滚（`chrome.alarms`，抗 SW 终止；到点对注入时的 tab rollback，失败即随页面卸载自然失效）。 |

**不申请**：`tabs` 历史、`cookies`、`webRequest` 拦截、`<all-sites>` 持久后台、身份/账密、付费 API 等任何敏感权限。

## Self-heal caveat · 自愈说明
「模板化自愈」会在**当前页面**以 `world: MAIN` 注入预编译的 prototype patch（如给事件 listener 加 debounce）。这些 patch **仅影响当前标签页的运行时**、刷新即失效，且不修改任何文件/网络。属于实验性功能，可能影响页面行为——可在设置中关闭/不使用。

## Contact
本扩展不收集任何数据，因此无数据可披露/转移。如发现越权行为请提 issue。
