# 自愈 Loop 定位文档

> 本文件是 `platform/extension` 自愈能力的权威设计正本。所有实现以此为准,避免口头对齐漂移。
> 落盘于 2026-08-02,经多轮架构推演收敛。

## 一、Thesis(主打与引擎)

- **主打(无可替代的钩子)= 监控可视化**:任意页面开浮层,实时 INP / 错误 / LCP·FCP·CLS + 完整归因链一条龙呈现。这是 DevTools / coding 工具都不做的"策展级"全链路视图——零启动、即看、好看。**钩子已经立住(8 面板 / 5 信号 / overlay / RootCauseView 基本就绪),战略重注不在可视化,在它背后的引擎。**
- **引擎 = 自愈 loop**:根因定位 → 结合【运行时上下文 + sourcemap 真源码】生成候选 patch → apply → 测量验证 → 没到优秀就重新定位再来,直至优秀;loop 结束后人决定提不提 MR。

### 为什么扛得住 Playwright 质疑(不重开战,只记结论)
Playwright + coding 工具能在仓库侧做"看问题→patch→rebuild→再测",严格强于扩展的**仓库侧闭环**。但扩展的护城河不在"生成 patch",在两件 Playwright 做不到的紧耦合:
1. **零启动**:任意页面(含不是你的站、含第三方脚本)点图标即用,不用建仓库写脚本。
2. **patch 绑定到真实运行时症状**:生成的 patch 喂的是**真实 LoAF 锚点 + INP 三段 + 当前页面环境**,不是抽象的源码推理。

真·field 数据(真实用户/真实条件)的护城河在 `collector` RUM SDK(部署到生产),不在本 dev 扩展。本扩展是**这套方法论的浏览器现场版 + 零启动 triage + 活 demo**。

## 二、Loop 结构(定位在 loop 内,验证在生成之后)

```
┌── 自愈 loop ───────────────────────────────────────────────┐
│  ① 定位(哪段瓶颈 + 哪个源码位置)← 每轮可重跑              │
│  ② 生 patch(运行时上下文 + sourcemap 真源码 → 候选:        │
│             源码 diff + 运行时代理)                        │
│  ③ apply(代理)                                           │
│  ④ verify(causal / Welch t 测真实 delta)                 │
│  ⑤ 优秀? ─ 是 → 跳出(带证据:effect / p / 前后值)         │
│         └ 否 → 回 ①(重新定位:瓶颈可能已迁移)             │
│  (候选耗尽 → inconclusive / 降级 human)                    │
└────────────────────────────────────────────────────────────┘
   ↓ loop 结束
用户决定是否提 MR(human gate,不自动)
   ↓ 若提
MR = loop 验证过的那个 patch(loop 即验证;可选再过 build+replay 严验证)
```

**关键结构决策(经推演钉死)**:
- **定位(①)在 loop 内,不是一次性前置**:打了一针 patch 后瓶颈会迁移(原卡 processing,修完可能变 inputDelay),下一轮要重新定位再生成候选。
- **生 patch(②)是 loop 一环,在 verify(④)之前**:每次迭代"先生成候选 → 再验证",不是先生成完再 loop。
- **MR(输出)人决定,不自动**:loop 产出 winner + 证据,提不提 MR 由用户拍板(沿用"提交权属于人")。

## 三、诚实耦合点(必须记住)

④ verify 测的是③的**运行时代理**,而 MR 交付的是②的**源码 diff**——两者等价才有意义。
- **机械类 patch**(lazy_load / size_attrs / defer_css / font_display / preload_lcp / throttle_3p):代理 ≡ 源码修复的运行时效果,可确定性推导等价。✅
- **语义类 patch**(null_guard / await_ordering / optional_chaining / memo_wrap / inject_cleanup):要么 LLM 同时产出"源码 diff + 代理",要么代理只能近似(必须标注"代理近似,真效果以 build+replay 为准")。⚠️

故"提 MR 可在 loop 验证"严格说是**验证代理效果来推断源码 patch 效果**;想要真·源码 patch 验证,升级到 build+replay(coordinator / `@monit/scenario` 那条线,opt-in)。

## 四、阶段映射:已有 / 缺什么(对码核实)

| loop 阶段 | 现状 | 去向 |
|---|---|---|
| ① 定位 | ✅ `diagnose.js` analyzeRootCauses + dominantInpPhase(哪段 + LoAF 锚点) | 包成 loop 内可重跑 |
| feeder:整函数真源码 | ⚠️ `resolveByCharPos/resolveFrames` 只 ±2 行 snippet、CORS 易挂、无缓存、只展示不喂决策 | 扩整函数 + 缓存 + 喂② |
| ② 生 patch(上下文+sourcemap→候选) | ❌ `mr-draft.js` 是一次性模板 diff,不吃真源码 | 候选生成器:候选 = (源码 diff, 运行时代理) 对;机械类确定性,语义类标"需模型" |
| ③ apply | ⚠️ `heal-templates.js` 固定 prototype 代理,没和②的源码 patch 显式成对 | 成对声明 + loop 内 apply/rollback |
| ④ verify | ⚠️ `causal.js` 单次有,没接成"结果回灌 loop 控制" | 接 loop 控制 + treated 采集 |
| ⑤ 控制(直至优秀 / tournament / 终止→MR) | ❌ 没有 | **本次实现的核心**:loop 编排器 |

## 五、跟平台 `heal-runner` 的对齐(方法论复用)

本 loop 是平台 `heal-runner` 管线(diagnose → gen repro → apply → regression → gate → [auto-mr|hotfix|human])的 **local-first + human-gated 版**。差异两点:
1. 测量来自**真实页面交互**(非 scenario 重放);
2. gate 是 **human 决定 MR**(非 auto-mr)。

→ 扩展和平台不是两套东西,是同一套方法论的浏览器现场版。`@monit/causal` 的 Welch t + Tournament 方法论可直接借鉴/移植。

## 六、建设计划(本次落地范围)

**先搭 loop 骨架(控制流跑通),内容后填**:
1. **`heal-loop.js`**:纯核心 `runHealLoop(deps)`,deps 注入 `{ localize, generateCandidate, applyProxy, collectTreated, verify, isExcellent, maxIters }`;返回 `{ outcome: 'excellent'|'inconclusive', winner, iterations[], evidence }`。纯核心可单测/Playwright 验。
2. **sidepanel adapter**:把纯核心的 deps 接到真实件——localize=`diagnose.analyzeRootCauses`、applyProxy=`APPLY_HEAL`(background→MAIN)、collectTreated=live INP 推送、verify=`causal.runCausalValidation`、isExcellent=`显著下降 && 当前值进入 good 段`。
3. **HealPanel UI**:"运行自愈 loop" 按钮 → 迭代进度(①…⑤ 每轮)→ 收敛显示 winner + 证据 → 人工 MR gate(提则用 winner 源码 diff,调 `mr-draft` 出 MR 卡)。
4. **Playwright 验证**(`verify/`,独立 npm,不进 pnpm workspace):页面注入真实 `causal.js` + `heal-loop` 核心,喂合成 measure(baseline 高 / treated 显著降 → 收敛 excellent;treated 不降 → inconclusive),断言控制流正确。

**本次不做(标注为后续)**:
- feeder 整函数源码拉取 + 缓存(②内容做实的前置)。
- 语义类 patch 的 LLM 生成(coordinator opt-in)。
- tournament 多候选并行(先单候选串行迭代,跑通控制流)。
- build+replay 真·源码 patch 验证(coordinator/scenario 线)。
