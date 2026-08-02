# 自愈 Tournament 设计正本

> 本文件是 `platform/extension` 自愈引擎「定位 → 并行候选生成 → 对抗审查 → 测量/验证 → 选优」的权威设计正本,
> 与 [`heal-loop.md`](./heal-loop.md)(串行收敛 loop)配套。所有实现以此为准,避免口头对齐漂移。
> 落盘于 2026-08-02,结论经行业规范调研(依据见文末引用)。

## 一、Thesis(两条路径,一套原理)

自愈有两条交付路径,共享同一套"定位 → 生成 → 验证"原理,但**并行性边界不同**:

| 路径 | 触发 | 候选生成 | 验证 | 并行性 |
|---|---|---|---|---|
| **运行时代理**(机械类) | INP triage(本扩展现场) | 确定性模板(5 个预编译 prototype patch) | apply → 采真实 INP → Welch t | **生成无需并行(确定性);测量必须串行** |
| **MR / 源码**(语义类) | 所有域(LCP/FCP/CLS/错误 + INP 深修) | LLM/subagent 起草 N 个源码 diff | build + replay(coordinator / `@monit/scenario`) | **生成 + 对抗审查全并行;build/replay 可批量** |

**本文档管的是跨两条路径的架构原理**:(a) 定位如何对齐行业归因模型;(b) 候选何时并行、何时串行;(c) 选优信号。
配套的 `heal-loop.js`(runHealLoop)是**运行时代理路径的串行收敛 loop**,已落地;本文件把它升级/对齐到更通用的 tournament 框架,并为 MR/源码路径(未来)立规。

## 二、测量隔离原理(为什么运行时 patch 必须串行测量)

**这不是工程难度,是实验设计的认知论约束。**

一次只改一个变量(OFAT, One-Factor-At-A-Time)的 A/B 测试**测不出交互效应**(interaction effects);但同时改多个变量又**无法把效果归因到单个变量**。要同时归因多个变量,得用**析因设计(factorial / 多变量 MVT)**——测所有组合,样本量随变量数指数膨胀。

> 同时 apply patchA + patchB,treated = 两者叠加。Welch t 只能告诉你"叠加后 vs baseline",**无法分离 A、B 各自的贡献**。这不是"难",是逻辑上不成立。

对运行时 patch,每次测量要 N 个真实页面交互样本(扩展靠用户继续浏览产生 treated)。析因设计下样本量翻倍翻倍再翻倍,local-first 场景根本攒不齐。**故运行时测量必须串行**:apply 一个 → 测 → rollback → 下一个,每个 patch 拿到干净的因果归因。

**那交互效应怎么办?**——LCP 官方洞察给出正解:*"优化单一相位可能只是把时间挪到另一相位"*。即 patch 后瓶颈会**迁移**(修完 processing 可能变 inputDelay)。处理方式不是 factorial,而是**每轮重新定位**(localize ① 每轮重跑)——`heal-loop.js` 已是这个结构:测完一轮没到优秀就回 ① 重新定位再来。串行测量(干净归因)+ 每轮重定位(追迁移)= 用得起、又正确地处理了交互。

依据:[John D. Cook – interaction effects](https://www.johndcook.com/blog/2022/10/31/interaction-effects/)、[Optimizely – interaction effects](https://www.optimizely.com/field-notes/articles/leveraging-interaction-effects-a-b-multivariate-testing)、[Statsig – overlapping experiments](https://blog.statsig.com/embracing-overlapping-a-b-tests-and-the-danger-of-isolating-experiments-cb0a69e09d3)。

## 三、并行生成 → 选优范式(LLM 修复 SOTA)

**"生成 N 个候选 → 选最优"是 LLM 代码修复的主流范式**,这正是 MR/源码路径该用的:

| 方法 | 选优信号 | 出处 |
|---|---|---|
| 生成 N + 测试通过率筛 top-k | 测试执行 | [Fan et al. ICSE'23](https://abhikrc.com/pdf/ICSE23.pdf)(生成 50 选 top-5) |
| AlphaCode 聚类 | 按测试 IO 行为聚类选代表 | DeepMind |
| CodeT | 测试一致性(test agreement)矩阵排序 | Xiao et al. |
| Self-consistency | 多采样投票取最一致 | Wang et al. |
| 成对锦标赛 | 两两比较精确选优 | [ExPairT-LLM AAAI'24](https://ojs.aaai.org/index.php/AAAI/article/view/40755/44716) |
| 迭代 test-and-repair | 失败测试回灌当修复 prompt | [AlphaCodium NeurIPS'24](https://neurips.cc/virtual/2024/poster/93642) |

→ **生成全并行 → 静态选优(对抗审查)→ 实测/验证(串行 or 批量)→ 锦标赛裁决**。选优信号在源码路径 = build + replay 通过率(+ 聚类/一致性去重);在运行时路径 = Welch t 显著下降且进入 good 段。

## 四、Tournament 架构(定位 → 族内并行 → 审查 → 验证 → 选优)

```
localize(signal, event) → { dimension, dominant, segments[], family[] }   ← ① 官方归因(见五)
        │
        ▼  ② 并行生成(每 family member 一个 subagent)
   family.map(解 => subagent 起草 { diff, rationale, predictedEffect })
        │  ── 运行时代理路径:family = 确定性模板,无需 subagent,直接枚举
        ▼  ③ 并行对抗审查(judge panel,apply 前静态验证)
   adversarialReview(candidates) → 过滤"不治根因/会 break/不地道"的
        │
        ├── 运行时代理(机械类)→ ④ 串行 apply→measure(treated INP)→rollback→Welch t
        │                           └ 测完一个,⑤ 重新 localize(追相位迁移),直至优秀 or 族尽
        └── MR / 源码(语义类)  → ④' build + replay gate(可批量并行)
                                    └ 按 通过率+聚类/一致性 锦标赛选优
        ▼  ⑤ 锦标赛裁决
   winner(+ 证据:effect / p / 前后值 / replay 通过)→ 人决定提不提 MR
```

**关键结构决策(经调研钉死)**:
- **扇出沿"局部化维度 → 解法族"**:不是随机生成 N 个解,而是 `localize` 先定位主导维度,在其**解法族内**扇出。这是有原则的并行,不是盲目 fan-out。
- **生成可并行,测量不可并行**(见二)。两条路径在此分叉:运行时走串行测量,MR 走批量 build/replay。
- **每轮重新定位**(① 重跑):处理"修一处、瓶颈迁移"的交互效应(见二),无需 factorial。
- **MR 仍人决定**(沿用 heal-loop.md"提交权属于人"):tournament 产出 winner + 证据,提不提 MR 用户拍板。

## 五、localize 路由器契约(对齐官方归因模型)

`localize.js` 暴露 `__localize`,纯函数、零副作用(可单测,见 `verify/units.verify.mjs`)。每个信号对齐其官方归因模型:

| 信号 | dimension | 分解(主导维度=元凶) | 族(family)来源 | 依据 |
|---|---|---|---|---|
| **INP** | `phase` | 三段:Input Delay / Processing / Presentation | diagnose 规则 suggestedHealIds | [web.dev/optimize-inp](https://web.dev/articles/optimize-inp) |
| **LCP** | `phase` | **四段**:TTFB / Resource Load **Delay** / Resource Load **Time** / Element Render Delay | 各相位 mrId(preload_lcp/defer_css…) | [web.dev/optimize-lcp](https://web.dev/articles/optimize-lcp) |
| **FCP** | `phase` | 经验三段:TTFB / HTML 解析 / 渲染阻塞 | blocking→defer_css | (无权威多段,TTFB 主导共识) |
| **CLS** | `source` | 来源类:media / font / dom(无加性相位) | size_attrs/font_display | [Chrome cls-culprit](https://developer.chrome.com/docs/performance/insights/cls-culprit) |
| **错误** | `class` | 分类(async_race/null_access/chunkload…)+ 栈锚点 | 各 class mrId | error-diagnose |

**严密度分档**:INP/LCP/FCP 是**可加 MECE 时间分解**(主导段唯一确定,最严谨);CLS 是**可加来源分解**(同样 MECE,只是按来源不按时间);错误是**分类判别**(靠置信度,非守恒分解)。

**LCP 四段是行业规范硬要求**:Load **Delay**(可发现性:preload scanner 没发现 / JS 注入 / 误 lazy / 跨域)与 Load **Time**(传输:大图/旧格式/远)解法族完全不同(Delay→preload/fetchpriority;Time→压缩/CDN),**必须分开**。研究数据:Load Time 仅占 LCP ~10%,Delay + Render Delay 才是主因。扩展 `content.js` 已补采 `resStart/resEnd` 以算出四段;旧数据(只有 `resLoad`)自动降级三段。

## 六、诚实耦合(必须记住)

承接 `heal-loop.md` 的诚实耦合点,在 tournament 下更显重要:

- **机械类 patch**(lazy_load / size_attrs / defer_css / font_display / preload_lcp / throttle_3p):运行时代理 ≡ 源码 patch 的运行时效果,可确定性推导等价 → 串行 apply-measure 的 Welch t 结果可推断源码效果。✅
- **语义类 patch**(null_guard / await_ordering / optional_chaining / memo_wrap / inject_cleanup):运行时代理只能近似 → 这类走 **MR/源码路径**,验证靠 **build + replay**(不是运行时 proxy 测量)。tournament 的并行生成 + 对抗审查在此路径全开。

**故**:运行时代理路径(tournament 的左分支)只覆盖机械类、只测 INP;MR/源码路径(右分支)覆盖所有域、靠 build/replay 验证。两条路径不混。

## 七、阶段映射:已有 / 缺什么(对码核实)

| 环节 | 现状 | 去向 |
|---|---|---|
| ① localize(官方归因) | ✅ `localize.js`(5 域,本批落地)+ `heal-loop` adapter 已接 INP | 接 checklist 高亮主导条目;非-INP 域接进 loop(待运行时测量泛化) |
| ② 并行候选生成 | ⚠️ 运行时路径:模板枚举(确定性,无需并行);MR 路径:❌ 无 subagent 生成器 | MR 路径 subagent 生成器(需模型) |
| ③ 对抗审查 | ❌ 无 judge panel | 静态审查:diff 是否治根因 / 会否 break / 是否地道 |
| ④ 验证 | ⚠️ 运行时:✅ causal Welch t(已接 loop);MR:❌ 无 build+replay | MR 路径接 `@monit/scenario` replay;build gate |
| ⑤ 锦标赛裁决 | ⚠️ 运行时:✅「优秀?」门控(已接 loop);MR:❌ 无多候选排序 | 通过率 + 聚类/一致性选优 |
| ⑥ MR 人决定 | ✅(heal-loop 已有) | 复用 |

**本批(2026-08-02)落地**:① localize 路由器(5 域官方归因)+ LCP 升四段(采集/显示/候选/checklist 全链对齐)+ heal-loop adapter 接 localize(行为不变)+ 单测覆盖。
**后续**:②③ MR 路径的 subagent 生成 + 对抗审查 + build/replay 锦标赛(opt-in,需模型与 scenario 线)。

## 八、引用清单

**RCA 归因模型**:
- [web.dev – Optimize INP](https://web.dev/articles/optimize-inp) · [Chrome – INP breakdown](https://developer.chrome.com/docs/performance/insights/inp-breakdown)
- [web.dev – Optimize LCP](https://web.dev/articles/optimize-lcp)(四段:TTFB + Resource Load Delay + Resource Load Time + Element Render Delay)
- [Chrome – Layout shift culprits](https://developer.chrome.com/docs/performance/insights/cls-culprit) · [web.dev – Optimize CLS](https://web.dev/articles/optimize-cls)

**并行生成 → 选优**:
- [Fan et al. – Automated Repair of Programs from LLMs (ICSE'23)](https://abhikrc.com/pdf/ICSE23.pdf)
- [ExPairT-LLM (AAAI'24)](https://ojs.aaai.org/index.php/AAAI/article/view/40755/44716) · [AlphaCodium (NeurIPS'24)](https://neurips.cc/virtual/2024/poster/93642)

**测量隔离 / 因果归因**:
- [John D. Cook – A/B testing doesn't find interaction effects](https://www.johndcook.com/blog/2022/10/31/interaction-effects/)
- [Optimizely – interaction effects](https://www.optimizely.com/field-notes/articles/leveraging-interaction-effects-a-b-multivariate-testing) · [Statsig – overlapping experiments](https://blog.statsig.com/embracing-overlapping-a-b-tests-and-the-danger-of-isolating-experiments-cb0a69e09d3)
