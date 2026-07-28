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
│ L6 修复闭环  @monit/repair-agent + @monit/coordinator              │
│   diagnose → ★ verifyAdversarially → inject → regression-vote      │
│   → ★ assessConfidence → 轨道A 热修 / 轨道B MR草稿                  │
├──────────────────────────────────────────────────────────────────┤
│ L4 根因     @monit/diagnose（确定性规则 + 火焰图 + 变更关联）         │
├──────────────────────────────────────────────────────────────────┤
│ L2 统一上下文 @monit/contracts（MonitorEvent 信封）                  │
│              @monit/trace（W3C traceparent 注入）+ @monit/fingerprint│
└──────────────────────────────────────────────────────────────────┘
```

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
| `@monit/diagnose` | 确定性 RCA | INP/error/long-task 归因 + 火焰图 + 变更关联（P1） |
| `@monit/repair-agent` | 自愈引擎 | ★Verifier 对抗验证 + 回归投票 + 信心门禁 + 5 patch + sourcemap |
| `@monit/coordinator` | MR 交付 | HTTP bus + LLM 补丁 + GitHub PR + 运行时热修 |

## 用法

```bash
pnpm install
pnpm test          # 全部单测
pnpm typecheck     # 类型检查
pnpm build         # 构建所有包
```

### 跑自愈循环（示例）

```ts
import { runHarness, verifyAdversarially, assessConfidence } from '@monit/repair-agent';

const result = await runHarness({
  diagnose: myDiagnoser,        // LLM 或 mock
  verifierConfig: llmConfig,    // 启用 Verifier 对抗验证
  inject: cdpInject,            // CDP Runtime.evaluate
  check: errorStillFires,       // 回放检查
  reset: resetErrorCount,
  locality: { filesChanged: 1, linesChanged: 12, hasTestCoverage: true, typecheckPasses: true },
  maxAttempts: 3,
});

if (result.resolved && result.confidence?.canAutoApply) {
  // 高信心 → 自动开 MR 草稿（人审）
  await createGithubPr(githubConfig, proposal, branch);
} else {
  // 低信心 → 仅诊断转人工
}
```

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
4. **信心门禁**（改动局部 + 类型通过才自动 MR）
5. **人审兜底**（全自动 MR <18%，半自动是现实范式）

## 路线图

- **P0（本仓库）**：契约 + trace + 指纹 + 诊断 + 自愈（Verifier 升级）+ coordinator，主链贯通 ✅
- **P1（后续）**：变更关联 RCA 全量 + MR 草稿闭环 + 测试充分性护栏 + contamination 检测
- **P2（后续）**：LoAF 逐脚本归因 + 数据溯源 DAG + 差异火焰图 + LLM-RCA 残差融合对标 88.4%

## 致敬与借鉴

本平台借鉴但不盲从既有代码（`monitors/` 下 sentinel-x v2.2、tracesdk、smarty-monitor、monitor-sdk），逐文件评审后取其精华、补其缺口。原项目保留不动。

调研与校验：`monitors/docs/前端可观测自愈平台-最佳实践校验报告-2026-07-28.md`、`monitors/docs/性能与AI修复体系建设调研报告.md`、`monitors/docs/技术方案-端到端可观测与诊断修复体系.md`。