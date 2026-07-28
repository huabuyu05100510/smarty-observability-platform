# 使用指南

> smarty-observability-platform · 端到端前端可观测 + 自愈平台

---

## 0. 环境准备

```bash
cd smarty-observability-platform
pnpm install        # 安装依赖
pnpm build          # 构建所有包（生成 dist/，运行时脚本依赖它）
pnpm test           # 123 个测试全过
```

> 需要 Node ≥ 18、pnpm ≥ 8。

---

## 1. 最快看到东西（30 秒）

```bash
pnpm backend        # 启动后端 + 面板（http://127.0.0.1:3921）
# 另开一个终端：
pnpm seed           # 灌入示例数据（错误 + Web Vitals + session）
```

浏览器打开 http://127.0.0.1:3921 ，能看到：
- **错误收件箱**：按指纹聚合的错误分组（count、影响 session 数、最后发生时间）
- **Web Vitals**：INP/LCP/CLS 的 p75/p99 + good/NI/poor 评级
- **Sessions**：每个会话的事件/错误计数
- 点错误分组可下钻看 sample 事件 payload（含 stack、breadcrumbs）

---

## 2. 接入你自己的前端项目（采集 SDK）

`@monit/collector` 是浏览器 SDK，在你的应用里初始化即可自动采集 Web Vitals + 错误 + 面包屑，上报到后端。

### Vite / Webpack / ESM 项目

```ts
import { initCollector } from '@monit/collector';

const monitor = initCollector({
  endpoint: 'http://127.0.0.1:3921/api/events',  // 后端 ingest 地址
  release: process.env.APP_VERSION ?? '1.0.0',    // 版本号，变更归因用
  sampleRate: 1,                                   // 采样率 0-1
  trace: { enabled: true },                        // 注入 W3C traceparent 到出站请求
  batchSize: 10,
  flushInterval: 5000,
});

// React 错误边界里调用，上报渲染异常 + componentStack
class ErrorBoundary extends React.Component {
  componentDidCatch(error, info) {
    monitor.reportReactError(error, info.componentStack);
  }
}

// 卸载时清理
// monitor.uninstall();
```

接入后会自动：
- 采集 CLS/LCP/FCP/TTFB/INP（INP 含 LoAF 逐脚本归因，Chrome 123+）
- 捕获 JS 错误、Promise rejection、资源加载错误（带双维指纹）
- 记录点击/输入/路由面包屑，附在错误事件上
- 给同源 fetch/XHR 注入 `traceparent` header（前后端 trace 串联）
- 批量上报（sendBeacon + fetch keepalive，可见性切换时 flush）

---

## 3. 跑自愈闭环

平台有两条修复轨道（均人工 review 兜底）。

### 轨道 B：MR 草稿闭环（源码 PR，治本）

```ts
import { runMrDraftTrack } from '@monit/coordinator';

const result = await runMrDraftTrack({
  report,                    // DiagnosticReport（由 buildReportFromEvents 从事件聚合）
  changes: [{ kind: 'deployment', at: Date.now()-60000, release: 'v1.2.3', summary: 'deploy v1.2.3', commitSha: 'abc' }],
  anomaly: { startedAt: Date.now(), spikeRatio: 4, release: 'v1.2.3', metric: 'error_rate' },
  sourceFiles: [{ path: 'src/renderList.ts', content: '...' }],
  testFiles: [{ path: 'src/renderList.test.ts', content: '...' }],
  goldPatches: [],           // 自建回归集（contamination 检测用）
  llmConfig: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder', apiKey: process.env.LLM_KEY },
  githubConfig: { token: process.env.GITHUB_TOKEN, repo: 'owner/repo', repoRoot: '/path/to/repo' },
  fs: { readFile, writeFile },
});

// result.decision: 'auto-pr' | 'draft-with-warnings' | 'diagnosis-only'
//   auto-pr          = 测试充分 + 无污染 + 低风险（仍人审）
//   draft-with-warnings = 护栏未过，PR 标记需补测试/疑似污染
//   diagnosis-only   = LLM 没产出有效补丁，仅诊断转人工
```

### 轨道 A：运行时热修（CDP 注入，可逆，治标）

```ts
import { runHarness } from '@monit/repair-agent';

const result = await runHarness({
  diagnose: myDiagnoser,                    // LLM ReAct agent 产根因+补丁
  verifierConfig: llmConfig,                // ★ 启用 Verifier 反事实对抗验证（注入前防幻觉）
  inject: cdpInject,                        // CDP Runtime.evaluate 注入 5 种 patch
  check: errorStillFires,                   // 回放一次检查错误是否仍在
  reset: resetErrorCount,
  locality: { filesChanged: 1, linesChanged: 8, hasTestCoverage: true, typecheckPasses: true },
  maxAttempts: 3,
});

// result.resolved + result.tier('high'/'low') + result.confidence.canAutoApply
//   high = Verifier 不否 + 回归通过 + 改动局部 + 类型通过 -> 可自动 MR
//   回归失败 / Verifier 否决 = 永不自动应用（AI 不做确定性门禁）
```

### LLM-RCA 多 agent 根因增强

```ts
import { runLlmRca, mergeLlmRca } from '@monit/llm-rca';

const rca = await runLlmRca(llmConfig, {
  record,                   // AttributionRecord（喂结构化上下文，非原始遥测）
  codeSlices: [...],        // 相关源码片段
  resolvedStack: [...],     // 已 sourcemap 还原的栈
});
const enhanced = mergeLlmRca(record, rca);   // 把 llm_rca 候选并入候选链
```

---

## 4. 单独使用各包

| 包 | 典型用法 |
|---|---|
| `@monit/fingerprint` | `computeFingerprint({ message, stack, errorType })` -> `{primary, secondary}` |
| `@monit/trace` | `installTracePropagation()` 给 fetch/XHR 注入 traceparent |
| `@monit/diagnose` | `analyzeRootCauses(report)` / `diagnoseWithCorrelation({report,changes,anomaly})` / `buildDiffFlamegraph(before,after)` |
| `@monit/guardrails` | `assessTestSufficiency({proposal, testFiles, sourceFiles})` / `detectContamination({patchCode, goldPatches})` |
| `@monit/provenance` | `buildFieldToDomChain(apiField, jsFn, dom)` -> 溯源 DAG，`graph.traceFrom(domId)` 反向溯源 |
| `@monit/backend` | `createBackendServer({port})` |

---

## 5. 后端 API 速查

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/events` | 批量 ingest（collector 上报，body 是 MonitorEvent 数组）|
| GET | `/api/errors` | 错误分组列表（按指纹聚合，count 降序）|
| GET | `/api/errors/:fingerprint` | 错误分组详情 + 该指纹的所有事件 |
| GET | `/api/vitals` | Web Vitals 聚合（p75/p99/worstRating）|
| GET | `/api/sessions` | session 列表（事件/错误计数）|
| GET | `/` | 内置面板 HTML |

CORS 默认 `*`（本地开发友好）。

---

## 6. 常用命令

```bash
pnpm build          # 构建所有包
pnpm test           # 全部测试（123）
pnpm typecheck      # 类型检查
pnpm backend        # 启动后端 + 面板（:3921）
pnpm seed           # 灌示例数据
pnpm demo           # 启动 demo HTML 页（:5179，含 traceparent 注入演示）
```

---

## 7. 配置 LLM（自愈/RCA 需要）

自愈闭环和 LLM-RCA 需要一个 OpenAI 兼容端点。支持云（OpenAI / DeepSeek / Moonshot）和本地（Ollama）：

```bash
# 本地 Ollama（推荐，免费、源码不出本地）
ollama serve
ollama pull qwen2.5-coder

# 传给 llmConfig:
# { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' }
# （无需 apiKey；@monit/repair-agent 会自动把 :11434 归一为 /v1）
```

> GitHub PR 需要 `GITHUB_TOKEN`（写仓库权限）+ `repo: owner/name`。token 走环境变量，**不要写进文件**。

---

## 8. 安全提醒

- **API key 泄漏**：`monitors/Agent.md` 里硬编码了一个 `sk-cp-...`（在原 monitors 目录），请轮换删除，用环境变量。
- **sourcemap**：生产绝不部署 sourcemap 到 CDN（泄露源码）；上报原始压缩栈，在隔离环境还原（`@monit/repair-agent/source-map-resolver`）。
- **PII**：collector 默认 `piiSafe: true`；面包屑只记字段名不记值；`@monit/fingerprint` 哈希前可叠加脱敏。
