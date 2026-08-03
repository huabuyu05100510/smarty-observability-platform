# @monit/vc-mcp · Vitals Copilot 扩展 → Claude Code → 真实仓库 MR

把浏览器扩展(`platform/extension`)的 **AI 自愈结论**桥接到 coding agent(Claude Code),让 LLM 生成的 source 补丁真正落到代码仓库、被测试、开成 MR——补上扩展「无构建环境、无法 apply source diff」的缺口。

```
扩展(采集 + 真根因 + AI heal) ──fetch POST /findings(127.0.0.1:7777)──▶ vc-mcp 进程
  仅当 sourceMatched && Verifier accepted && 用户开启 sidecar            ├─ node:http 接收 + 持久化 findings
                                                                          └─ stdio MCP(Claude Code):
                                                                               vc_get_findings / vc_list_findings
                                                                               vc_apply_diff(dry-run: 写工作树 + unified diff + MR 草稿)
                                                                               vc_clear_findings
                                                                                 │
                                              Claude Code(有仓库 + git + gh): review git diff → pnpm test → (人确认) git commit + gh pr create
```

## M1 边界:dry-run,无 token、无 push

`vc_apply_diff` 把补丁**写到工作树**(让 agent 能跑 `pnpm test`/`tsc` 验证 patched 代码),但**不 `git add`/`commit`/`push`,不需 GitHub token**。commit/push/开 MR 由 agent 在人确认后用 `git`+`gh` 完成。这是把 charter「生成可提交源码 diff/MR」落地到 local-first 无构建环境的诚实做法。

- **幻觉守卫**:search 片段必须在文件中 verbatim 命中才写;不命中 → 入 `filesUnresolved`,文件不动(镜像 `@monit/coordinator` 的 `applyPatchesLocally` 守卫)。
- **路径归一**:扩展传的是 sourcemap `sources[]` 条目(`webpack:///./src/Foo.tsx`),vc-mcp 归一为仓库相对路径后定位真实文件。

## 安装

```bash
# 仓库根
pnpm install
pnpm --filter @monit/vc-mcp build      # 产物 packages/vc-mcp/dist/index.js
```

## 注册到 Claude Code

```bash
claude mcp add vc -- node /绝对路径/packages/vc-mcp/dist/index.js
```

之后 Claude Code 会话里即可调用 `vc_*` 工具。扩展端在「设置 → Claude Code 桥 · Sidecar」勾选「启用 sidecar 推送」,verified 的 AI 补丁即经 `http://127.0.0.1:7777/findings` 推到本进程。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VC_PORT` | `7777` | HTTP receiver 端口 |
| `VC_HOST` | `127.0.0.1` | 绑定地址(loopback only,拒绝非本机) |
| `VC_STORE` | `os.tmpdir()/vc-mcp-findings.json` | findings 持久化(环形缓冲 cap 50,跨 session) |
| `VC_SIDECAR_TOKEN` | (空) | 可选:配了则 POST/DELETE 需 `Authorization: Bearer <token>` |

## MCP 工具

| 工具 | 入参 | 返回(text=JSON) |
|---|---|---|
| `vc_get_findings` | `{ id? }`(缺省取最新) | 一条 `VcFinding`(根因 + diff + targets + 验证) |
| `vc_list_findings` | `{ limit?=10 }` | 最近 N 条 |
| `vc_apply_diff` | `{ id?, repoRoot?=cwd }` | `{ filesPatched[], filesUnresolved[], unifiedDiff, mrDraft{title,body}, notes[] }` |
| `vc_clear_findings` | `{}` | `{ cleared: true }` |

## Dry-run 流程(agent 视角)

1. `vc_get_findings` → 拿到扩展推来的根因 + search/replace + 目标文件。
2. `vc_apply_diff({ repoRoot })` → 补丁写入工作树,返回 per-file 状态 + unified diff + MR 草稿。`filesUnresolved` 里的文件(search 未命中/路径未解析)按 `symbol`+`candidates` 用 Grep 兜底定位。
3. `git diff` review → `pnpm test`/`tsc` 验证 patched 代码。
4. (人确认) `git checkout -b` → `git add`/`commit` → `gh pr create`。

## Findings schema(`VcFinding`)

```jsonc
{
  "id": "f-<ts>-<rand>",            // 服务端分配(不信任客户端)
  "createdAt": 1785...,             // 服务端分配
  "rootCause": "foo() 在 X 场景返回 null…",
  "confidence": 0.8,                // 0–0.9(AI 封顶)
  "evidence": ["…"],
  "diff": { "search": "…", "replace": "…", "explanation": "…", "risk": "low", "riskReason": "…" },
  "verification": { "accepted": true, "reason": "…", "confidence": 0.85 },
  "targets": [{ "file": "src/Foo.ts", "symbol": "foo", "search": "…", "replace": "…" }],
  "sourceHint": "src/Foo.ts",
  "host": "app.x.com", "signal": "inp", "eventId": "evt-…"
}
```

## 安全

- **M1 无凭证**:进程不持有 GitHub token,不碰 git。MR 由 agent 经 `gh` 开(人确认)。
- **loopback only**:HTTP 绑 `127.0.0.1` + 显式 peer 校验,非本机一律 403。可选 `VC_SIDECAR_TOKEN` 加 Bearer。
- **扩展侧 opt-in**:sidecar 推送默认关,需在设置手动开;且仅 `sourceMatched && Verifier accepted` 才推。fire-and-forget,失败静默。
- **数据**:只把根因 + 源码片段 + diff 发给本地进程,不发全量遥测;`findings.json` 落 `tmpdir`,重启清空。

## 复用(不重写)

- `@monit/contracts`:`PatchHunk` / `AiPatchProposal` / `PrResult` 类型。
- `@monit/server-kit`:`countChangedLines(search, replace)`。
- `@monit/coordinator/github-pr`:`applyPatchesLocally` 的 verbatim 幻觉守卫(M1 镜像其逻辑;`createGithubPr` 留作 M2 `vc_open_mr`)。

## 测试

```bash
pnpm --filter @monit/vc-mcp test    # vitest: normalize / store / apply / http(31 checks)
```
