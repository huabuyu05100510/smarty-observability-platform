# smarty-observability-platform

> 端到端前端可观测 + 诊断 + 自愈统一平台 · 确定性 × AI 混合
>
> 14 年前端专家"代表作"之一 · 基于 2026-07 行业最佳实践深度调研构建

一套「采集 → trace → 根因 → 自愈 → MR」贯通的平台，核心创新是 **确定性 × AI 混合的自愈闭环**：在 AI 诊断与行动之间插入**对抗式 Verifier**（反事实验证）+ **确定性信心门禁**，对标 2026 年图 + LLM + 对抗验证 SOTA（F1 88.4%），并针对 SWE-bench 的"通过测试 ≠ 真正修复"假阳性问题设计多层护栏。

调研依据见 `monitors/docs/前端可观测自愈平台-最佳实践校验报告-2026-07-28.md`。

---

## 为什么造这个

业界现状（经 102-agent deep-research、23 条对抗验证结论证实）：

1. **主链断裂**：前端采集、后端 trace、根因、修复散落在不同工具，"前端慢 → 定位到后端 → 生成修复 → 验证回写"断在每个工具之间。
2. **AI 修复危险**：SWE-bench Verified ~24% 假阳性源于测试不足（UTBoost 15.7% / OpenAI 59.4% 困难子集审计），OpenAI 已于 2026-06 弃用该基准；企业全自动 MR 闭环真实采用 <18%。
3. **LLM-RCA 幻觉**：原始遥测直喂 LLM 不可行（半小时 ~2GB），头号失败模式是"幻觉类比/编造证据"（Waterloo RF-01）。
4. **生产 RCA 偏关联**：Datadog Watchdog / Dynatrace Davis 实为"拓扑感知关联"，非 SCM/do-calculus。

本平台的回答：

- **统一契约**（`@monit/contracts`）+ **W3C traceparent 注入**（`@monit/trace`）打通主链；
- **确定性规则引擎**（`@monit/diagnose`）做可解释归因，LLM 只做规则做不到的；
- **对抗式 Verifier + 信心门禁**（`@monit/repair-agent`）防 AI 幻觉、防"通过测试但未修复"；
- **双轨交付**（`@monit/coordinator`）：运行时热修（可逆，治标）+ MR 草稿（永久，治本），均人审兜底。

---

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│ L6 修复闭环  @monit/repair-agent + @monit/coordinator + guardrails │
│   diagnose → ★ verifyAdversarially → inject → regression-vote      │
│   → ★ assessGate(GateVector) → 轨道A 热修 / 轨道B MR草稿            │
├──────────────────────────────────────────────────────────────────┤
│ L4 根因     @monit/diagnose（确定性规则 + 火焰图 + 变更关联全量） │
├──────────────────────────────────────────────────────────────────┤
│ L2 统一上下文 @monit/contracts（MonitorEvent 信封）                  │
│              @monit/trace（W3C traceparent 注入）+ @monit/fingerprint│
├──────────────────────────────────────────────────────────────────┤
│ L1 采集     @monit/collector（Web Vitals+LoAF / error+指纹 / 面包屑 /  │
│              reporter，产出带 traceId 的 MonitorEvent）              │
└──────────────────────────────────────────────────────────────────┘
```

## 能力矩阵（如实标注实现度）

代表作级 = 每条主张都有真实跑通的路径支撑。下表四列：**设计 / 单测 / 端到端接线 / 真实外部联调**。
孤岛能力（只到单测、没接进真链路）会显式标出，不混为一谈。随重构进度更新。

| 能力 | 设计 | 单测 | 端到端接线 | 真实外部联调 |
|---|---|---|---|---|
| contracts / W3C traceparent / 双维指纹 | ✓ | ✓ | ✓ | ✓ |
| 采集 SDK（vitals+LoAF+LCP归因 / 6 类错误 / 请求 / replay / PII / 采样 / 离线 / 白屏检测 / 行为沮丧） | ✓ | ✓ | ✓ | ✓ |
| 确定性 RCA + 变更关联（关联型，否决 SCM） | ✓ | ✓ | ✓ | - |
| **跨层 trace join（性能皇冠）**：前端 report.traceId ↔ 后端 span | ✓ | ✓ | ✓ | - |
| 后端 ingest + 指纹聚合 + vital p75/p99 + span store + 白屏/行为聚合 + 面板 | ✓ | ✓ | ✓ | ✓ |
| sourcemap 还原（真实 source-map） | ✓ | ✓ | ✓ | - |
| **Verifier 对抗验证（跨 provider 独立模型）** | ✓ | ✓ | ✓ | ✓ 真实联调 |
| **repro-test 回归（红转绿 + 套件不破）** | ✓ | ✓ | ✓ | ✓ 真实联调 |
| **信心门禁（GateVector 向量，替加权 score）** | ✓ | ✓ | ✓ | ✓ 真实联调 |
| 测试充分性（repro 替代字符串启发式）/ 污染检测（真实 goldPatch） | ✓ | ✓ | ✓ | - |
| 白屏检测 + 因果归因（按 error/resource 时序定位） | ✓ | ✓ | ✓ | - |
| 行为沮丧信号（rage/dead click / erratic mouse） | ✓ | ✓ | ✓ | - |
| 运行时热修（轨道 A：patch-registry-over-SDK + HMAC 签名 + 真 rollback，非 CDP） | ✓ | ✓ | ✓ | - |
| **极致闭环单漏斗 runHealPipeline**（diagnose→verify→repro→gate→PR） | ✓ | ✓ | ✓ | ✓ 真开 PR |
| 真实端到端留痕（真 LLM 跨 provider + 真 PR） | - | - | - | ✓ 见下 |

> **代表作留痕（真实联调，非 demo）**：`node scripts/showcase-record.mjs` 真实跑通单漏斗 ——
> ARK doubao 诊断 + **MiniMax 跨 provider 独立 Verifier** + LLM 生成 repro 测试（红转绿）+ GateVector →
> 真实开出 GitHub PR。独立 Verifier 实测拦截了诊断的"过度泛化"（同模型 Verifier 放行、跨 provider Verifier 否决），
> 正是 BP-2 独立对抗的价值实证。详见 `docs/代表作留痕.md` 与 `showcase/run-*.md`。

## 自愈循环（核心创新）

```
Diagnoser(LLM) 生成根因 + 补丁
   │
   ▼
★ Verifier(LLM, 怀疑者 prompt) ── 反事实推理：主动证伪根因
   ├─ refuted → alternativeHypothesis 喂回 Diagnoser 重诊断（先不注入）
   └─ accepted ↓
注入补丁（CDP Runtime.evaluate, 5 种 patchType）
   │
   ▼
回归投票（3-replay ≥2 多数，不信任 LLM 置信度）
   │
   ▼
★ 信心门禁（确定性）：Verifier✓ + 回归✓ + 改动局部 + 类型✓ → 高信心自动 MR
                    任一不满足 → 低信心转人工（AI 不做确定性门禁）
```

**vs 传统**：传统只有"注入后回归确认"（经验式，抓不住注入前的逻辑幻觉）。本平台在注入**前**加 Verifier 反事实验证，对标 88.4% F1 论文的 Adversarial Validation Protocol。

---

## 包

| 包 | 职责 | 关键能力 |
|---|---|---|
| `@monit/contracts` | 统一 schema | MonitorEvent 信封 / AttributionCandidate 候选链 / PatchResult / ConfidenceTier |
| `@monit/trace` | W3C trace 传播 | traceparent 编解码 + meta/cookie 继承 + fetch/XHR 注入 |
| `@monit/fingerprint` | 错误指纹 | FNV-1a 栈指纹 × djb2 URL/类型指纹 双维合并 |
| `@monit/diagnose` | 确定性 RCA | INP/error/long-task 归因 + 火焰图 + 变更关联全量（多源候选链） |
| `@monit/repair-agent` | 自愈引擎 | ★Verifier 对抗验证 + 回归投票 + 信心门禁 + 5 patch + sourcemap |
| `@monit/coordinator` | MR 交付 | HTTP bus + LLM 补丁 + GitHub PR + ★MR 草稿闭环（轨道 B）+ 运行时热修 |
| `@monit/guardrails` | 自愈护栏 | 测试充分性评估 + contamination 污染检测（防 SWE-bench 假阳性） |
| `@monit/collector` | 浏览器采集 | Web Vitals+LoAF / error+指纹 / 面包屑 / reporter，产出 MonitorEvent |
| `@monit/llm-rca` | LLM 根因 | ★Navigator/Diagnoser/Verifier 多 agent + 残差融合（对标 F1 88.4%，喂结构化上下文）|
| `@monit/backend` | ingest + 面板 | 指纹分组聚合 + vital p75/p99 + session + 内置 HTML 面板 |
| `@monit/provenance` | 数据溯源 DAG（**实验/未接线**） | 屏幕值 ← 接口字段 ← 后端 span 反向溯源。当前为孤儿包：仅算法自测，未接进采集/后端链路，`AttributionRecord` 亦无 `provenanceNode` 字段 |
| `@monit/diagnose`（含差异火焰图） | 性能回归 | buildDiffFlamegraph：红=回归/蓝=改善，对标 Brendan Gregg |

## 用法

**30 秒体验**（启动后端 + 面板 + 灌示例数据）：

```bash
pnpm install && pnpm build
pnpm backend       # 启动后端 + 面板 http://127.0.0.1:3921
pnpm seed          # 另开终端，灌入示例错误 + Web Vitals
```

完整使用指南（接入前端项目、跑自愈闭环、单独用各包、LLM/GitHub 配置）见 **[docs/USAGE.md](docs/USAGE.md)**。

开发命令：

```bash
pnpm test          # 全量测试（vitest，详见 `pnpm test` 输出）
pnpm typecheck     # 类型检查
pnpm build         # 构建所有包
```

### 跑自愈循环（示例）

headline API 是 `runHealPipeline`（单漏斗）+ `assessGate`（确定性 GateVector 门禁），
由 `@monit/coordinator` 的 `runRealHealPipeline` 装配到真实 fs/vitest/git/PR。
（`assessConfidence` 是遗留加权 score 门禁，未校准且不查 reproRedBefore/contamination，已弃用。）

```ts
import { runRealHealPipeline } from '@monit/coordinator';

// diagnose(LLM) → 独立模型 Verifier(BP-2) → repro 红转绿(BP-3) → 3-replay 回归投票
// → assessGate(GateVector, BP-4) → auto-mr / hotfix / human
const result = await runRealHealPipeline({
  repoRoot,
  diagnoserConfig: llmConfig,
  verifierConfig: independentLlmConfig, // 须与 diagnoser 不同 model id（BP-2 独立对抗）
  symptom, stack,
  focusFiles,                  // 错误栈帧关联的源文件
  githubConfig,                // auto-mr 时开 PR（人审兜底）
  behaviorPreserving: false,   // MR 轨（治本）；热修轨传 true
});

if (result.resolved && result.decision?.delivery === 'auto-mr') {
  // 高信心 → 已自动开 MR 草稿（Verifier✓ + repro 红转绿 + 回归投票✓ + 局部 + 无污染 + 类型✓）
} else {
  // 低信心 → 转人工（AI 不持有确定性门禁；回归失败 / Verifier 否决 = 永不自动）
}
```

HTTP 入口：`POST /auto-heal`（coordinator）—— 齐备 `repoRoot` + `verifierConfig` 时自动走 strong 轨
（完整门禁），否则回退 draft 轨（仅 guardrails），响应体 `track` 字段显式标注走了哪条。

---

## 确定性 × AI 分工（研究原则）

| 维度 | 确定性（规则） | AI（LLM） |
|---|---|---|
| 归因 | INP/error/long-task 规则、变更关联、火焰图 | LLM-RCA（喂结构化上下文，P2） |
| 验证 | 回归投票、searchCode 校验、信心门禁 | ★ Verifier 反事实对抗 |
| 修复 | 5 patch 白名单、sourcemap 还原 | 补丁代码生成 |
| 门禁 | **AI 不做确定性门禁**（幻觉风险） | — |

## 护栏（针对 SWE-bench 假阳性）

1. **Verifier 反事实验证**（注入前，逻辑层防幻觉）
2. **回归投票 3-replay ≥2**（注入后，经验层防偶发）
3. **searchCode 真实存在校验**（防 LLM 编造补丁）
4. **测试充分性护栏**（`@monit/guardrails`：被改代码是否被测试覆盖，UTBoost 思路）
5. **contamination 检测**（`@monit/guardrails`：补丁是否逐字/近似复现 gold patch，防数据污染）
6. **信心门禁**（改动局部 + 类型通过才自动 MR；回归失败/Verifier 否决 = 永不自动）
7. **人审兜底**（全自动 MR <18%，半自动是现实范式）

## 安全加固（生产级重写 · 不可绕过）

本轮针对 code review 发现的三类系统性结构问题做实，准则"不可绕过任何逻辑"：

**鉴权链**（新增 `@monit/server-kit`，backend + coordinator 共享 `HttpRouter`）：
- 所有写端点强制过中间件（鉴权 / Origin 白名单 / 限流 / 有界 body / 审计），dispatch 层强制、非 opt-in；
- bearer token 常量时间比较；未配 token 时 loopback 放行、非 loopback 拒绝；
- CORS 不再用 `*`，按 Origin 白名单回显 + `Vary: Origin`（堵任意网页 CSRF 触发开 PR）；
- readBody 字节上限 + `req.destroy()`（堵 OOM）；per-IP 令牌桶限流；
- `pnpm security-check`（`node scripts/security-check.mjs`）自检 8 项：错 token 401 / 跨源 403 / body 超限 413 / 路径穿越 400 / AST 拒绝 / 公钥下发。

**Ed25519 非对称签名**（运行时热修，替对称 HMAC —— 密钥不分发）：
- 服务端私钥签名，SDK 持公钥验签（`GET /heal/public-key` 下发）→ 不可伪造；
- payload 含 nonce + expiresAt → 防重放 + 防 TTL 绕过；SDK nonce LRU 去重；
- 登记时 acorn AST 严格白名单（禁网络/全局/DOM/原型链/循环/NewExpression）→ 恶意 code 进不了注册表。

**门禁输入做实**（确定性门禁，AI 不持有）：
- verifier 三态如实进 gate（pass/refuted/skipped，消灭硬编码 `pass`）+ 置信度经阈值转 `verifierConfident` 进门禁；
- verifier 与 diagnoser 强制不同 model（BP-2 运行时硬断言）；
- `redBefore` 只认断言失败（vitest json 解析 fail-assertion/fail-error/timeout）→ 防伪复现绕过红转绿；
- `locality` 用真实 LCS 行 diff（非 replaceCode 行数高估）；contamination 全档位阻断（auto-mr 与 hotfix 均不放行污染补丁）。

**其余工程加固**：sourcemap 路径白名单 + realpath（防 symlink 越界）；删 `execSync(curl)` 改异步 fetch；子进程一律 `execFileSync`（shell:false）消除命令注入；持久化逐事件 append（缩小崩溃窗口）+ 先落盘后内存；ingest 每条 schema 校验（畸形不致整批 500 + store 半一致）；sessionReplay 字节预算裁剪 + truncated；PII 补座机/SSN/银行卡 + 全角归一化（堵 `１３８…` 绕过）+ `report()` 补脱敏；diagnose 补 LCP/CLS/白屏归因。

## 路线图

- **P0（已完成）**：契约 + trace + 指纹 + 诊断 + 自愈（Verifier 升级）+ coordinator，主链贯通 ✅
- **P1（已完成）**：变更关联 RCA 全量 + MR 草稿闭环 + 测试充分性护栏 + contamination 检测 + 浏览器采集 SDK ✅
- **P2（已完成）**：LLM-RCA 残差融合（对标 88.4%）+ 后端 ingest + 内置面板 + 差异火焰图 + 数据溯源 DAG ✅

## 后续可扩展

- LoAF 逐脚本 charPosition 归因增强（collector 已采 LoAF，diagnose 已归因到脚本）
- 后端持久化（内存 -> ClickHouse/Postgres，schema 不变）
- React 面板（替代内置 HTML，更丰富的下钻/溯源 DAG 可视化）
- 真实 CDP 注入 + GitHub PR 端到端联调（接口已就绪）

## 致敬与借鉴

本平台借鉴但不盲从既有代码（`monitors/` 下 sentinel-x v2.2、tracesdk、smarty-monitor、monitor-sdk），逐文件评审后取其精华、补其缺口。原项目保留不动。

调研与校验：`monitors/docs/前端可观测自愈平台-最佳实践校验报告-2026-07-28.md`、`monitors/docs/性能与AI修复体系建设调研报告.md`、`monitors/docs/技术方案-端到端可观测与诊断修复体系.md`。