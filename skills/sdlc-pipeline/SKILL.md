---
name: sdlc-pipeline
description: |
  AI SDLC 命令式研发流水线（飞书项目/Meegle，依赖 meegle 与 meegle-sdlc skill）。Use when the
  user issues /sdlc-start, /sdlc-next, /sdlc-done, or /sdlc-status (also written as sdlc
  start / next / done / status, or natural-language equivalents like 开启某个需求、下一步、
  完成需求、检查当前状态) to drive a Feishu Project (Meegle) requirement through branch
  checkout, document upload, task breakdown, and workflow node transitions. 关键词：SDLC、
  sdlc-start、研发流水线、开启需求、拉取分支、上传设计文档、测试用例、测试结果、拆任务、估分排期。
---

# AI SDLC 研发流水线

命令式正向流水线：从飞书项目需求出发，驱动「拉分支 → 传文档 → 拆任务 → 转节点」直至收尾。本 skill 是**薄编排层**：只决定「何时、对哪个对象、做什么」，执行全部委派。

> **REQUIRED SUB-SKILL: meegle** — 一切流转/查询执行（get-node、transition、补必填字段、自愈、熔断、授权 auth-guard）委派 meegle skill 的 `references/sop-transition-node.md` 等 SOP，本 skill 不复制其逻辑。
> **纪律单源**：确认卡片、回读验证、重试与熔断纪律遵循 [../meegle-sdlc/references/transition-flow.md](../meegle-sdlc/references/transition-flow.md)，本 skill 不复制其文本。
> **阶段推断**：复用 [../meegle-sdlc/references/stage-mapping.md](../meegle-sdlc/references/stage-mapping.md) 的阶段关键词表。

## 命令分派

| 触发词 | 语义 | 流程 |
|---|---|---|
| `/sdlc-start [链接\|ID]` | 开启需求：验证 → 摘要卡片 → 仓库/分支 → 文档骨架 | [commands.md §start](references/commands.md) |
| `/sdlc-next` | 推进当前阶段的下一个未完成动作（一次一个） | [commands.md §next](references/commands.md) |
| `/sdlc-done` | 收尾核对，如实报告完成/未完成 | [commands.md §done](references/commands.md) |
| `/sdlc-status` | 实时状态展示（纯读，重查飞书 + git，无需确认） | [commands.md §status](references/commands.md) |
| update（更新 skill） | 不由本 skill 处理：提示用户运行 `npm i -g @didatravel-jinyi/meegle@latest` 或跟随 CLI 启动时的更新提示 | — |

自然语言等价表达（「开启这个需求」「下一步」「需求什么状态了」）同样触发。团队约定（分支模板/仓库映射/节点映射）见 [team-conventions.md](references/team-conventions.md)。

## 状态机总览

角色阶段由 doing 节点按 stage-mapping 关键词表推断（用户显式指定优先）：

```
产品：上传设计文档 → 流转【需求关键信息确认】
研发：拆任务+估分排期 → 流转【确认进入研发】 →（编码/部署，非本 skill）→ 流转【测试环境部署】
测试：上传测试用例 → 上传测试结果 → 【测试】节点估分排期 → 流转【测试】
```

所有动作的完成度以**权威源实时重查**（飞书 `workflow get-node` / git `ls-remote`）判定；命令幂等——已完成项跳过并说明，不重复执行。

## 护栏（不可协商）

1. **禁止猜测四对象**：需求、仓库、分支、节点——定位不到就问用户一次，仍无 → 停止；禁止模糊搜索「凑一个」。
2. **git 远端写与节点流转同级**：push、建远端分支、流转，都必须先出确认卡片，无例外。
3. **流转纪律**：遵循 ../meegle-sdlc/references/transition-flow.md（确认 → 委派执行 → 回读 → 如实报告）。
4. **幂等**：执行动作前重查状态，已完成的跳过并说明。
5. **如实报告**：push/流转返回 success ≠ 成功；以回读验证为准，未变化按失败报告。
6. **不代用户做主**：不扫目录找文档（询问用户传哪些）；不代为 stash/commit 用户的未提交改动；`git add` 只加本次动作相关文件。

### 合理化对策表

| 借口 | 现实 |
|---|---|
| 「用户很急，直接 push 吧」 | 急 ≠ 授权；确认卡片只有一屏 |
| 「分支名八成是这个」 | 八成 ≠ 确定；模板推导不出就问 |
| 「文档在目录里扫一下就行」 | 传哪些由用户指定；扫目录 ≠ 询问 |
| 「接口都返回 success 了」 | success ≠ 已生效；回读验证后才报告 |
| 「这个节点显然对应这个阶段」 | 显然 ≠ 校验；get-node 重查 + 关键词匹配 |
| 「刚才 start 过了，直接再建一次分支」 | 状态实时重查权威源；已存在即跳过 |

## Red Flags — 出现以下念头立即停止

- 想不经确认卡片直接 push / 建远端分支 / 流转节点
- 用户没给文档名，想扫目录「找看起来像的」
- 需求 ID 与当前分支不一致，想「就用当前分支凑合」
- 想凭接口 success 宣布「已推送 / 已流转」
- next 时发现前置动作未完成，想直接执行后面阶段的动作
- 想按名称搜索「凑」一个定位不到的需求 ID

**任一命中：停止，回到 commands.md 对应命令流程。**
