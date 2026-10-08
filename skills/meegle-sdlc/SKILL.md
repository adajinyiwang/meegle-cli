---
name: meegle-sdlc
description: |
  SDLC 节点流转编排（飞书项目/Meegle，依赖 meegle skill）。Use when working on development,
  testing, or product tasks in a git repository whose branch name contains a Meegle work
  item ID, or when such work has just been merged/delivered and the requirement's workflow
  node status needs updating. 关键词：SDLC、节点流转、流转、开发完成、测试完成、评审通过、
  需求状态、分支绑定、meegle-sdlc。
---

# Meegle SDLC 节点流转编排

产品 / 开发 / 测试完成各自工作并交付后，编排飞书项目（Meegle）需求工作项的节点流转。本 skill 是**薄编排层**：只管「何时触发、流转哪个节点、如何确认」。

> **REQUIRED SUB-SKILL: meegle** — 一切流转执行（查节点、补必填字段、自愈、熔断、授权 auth-guard）委派 meegle skill 的 `references/sop-transition-node.md`，本 skill 不复制其逻辑。

## 触发条件

同时满足以下条件时，在**任务开始阶段**执行 ① 早绑定：

1. 处于 git 仓库中，正在进行开发 / 测试 / 产品类任务；
2. 分支名含候选工作项 ID（首个 ≥6 位连续数字，如 `feature/2025091234-user-login` → `2025091234`）；
3. `meegle workitem get` 验证该 ID 存在。

任一条件不满足 → **静默不启用**（不打断当前任务、不向用户提及）；仅 ID 验证失败时允许追问一次。规则详见 [references/branch-binding.md](references/branch-binding.md)。

## 五阶段流程

| 阶段 | 时机 | 动作 | 规则文件 |
|---|---|---|---|
| ① 早绑定 | 任务开始 | 分支名提取 ID → 验证 → 查 doing 节点 → 阶段预判 → 注册 todo「收尾时流转 Meegle 节点 <节点名>」 | [branch-binding.md](references/branch-binding.md) |
| ② 执行工作 | — | 正常开发/测试/产品工作，期间不做任何流转动作 | — |
| ③ 完成判定 | 任务收尾 | 开发=已合入/PR merged；测试=执行完毕且结果经确认；产品=交付物定稿经确认。不满足 → 不触发 | [transition-flow.md](references/transition-flow.md) |
| ④ 流转前校验 | 触发后 | **重新**查 doing 节点（禁用 ① 的快照），关键词校验其与本次完成阶段一致；不一致 → 拒绝流转并说明 | [stage-mapping.md](references/stage-mapping.md) |
| ⑤ 确认→执行→回读 | 校验通过后 | 确认卡片 → 用户同意 → 委派 meegle sop-transition-node 执行 → 回读验证 → 如实报告 | [transition-flow.md](references/transition-flow.md) |

## 护栏（不可协商）

1. **禁止猜测工作项**：分支解析不出 ID 时，不得回退用名称模糊搜索「凑一个」；追问一次无果即静默不启用。
2. **流转前必须确认，无例外**：用户未对本次流转明确同意前，不得调用 `workflow transition`。
3. **禁止跨阶段流转**：doing 节点不属于本次完成的阶段（如开发完成但节点还在「需求评审」）时绝不硬转，按 stage-mapping.md 的分支持提示。
4. **状态必须重查**：① 的节点快照仅用于预判；⑤ 之前必须重新执行 `workflow get-node`。
5. **每会话最多主动发起一次流转建议**；用户拒绝后不再纠缠。
6. **如实报告**：transition 返回 success ≠ 成功；必须回读节点状态验证，未变化按失败报告。
7. 重试与熔断遵循 meegle skill 总则：同类失败最多自动重试 2 次；硬拦截字段（实际工时、投票类等）立即转人工。

### 合理化对策表

| 借口 | 现实 |
|---|---|
| 「用户上次同意过自动流转」 | 上次同意 ≠ 本次同意，每次都确认 |
| 「只是个小改动」 | 小改动也走确认，卡片只有一屏 |
| 「用户很急，让我别问了」 | 急 ≠ 授权跳过；展示卡片只需几秒 |
| 「节点名看起来就是它」 | 看起来 ≠ 校验通过，重查 + 关键词匹配 |
| 「接口都返回 success 了」 | success ≠ 状态已变；回读不变就是失败 |
| 「搜出来的工作项名字挺像」 | 像 ≠ 是；候选不唯一必须问 |

## Red Flags — 出现以下念头立即停止

- 想不经用户确认直接执行 `workflow transition`
- 想用绑定时的旧快照代替重新查询 doing 节点
- doing 节点阶段与本次工作不符，却想「先转了再说」
- 分支无 ID，想按任务内容搜工作项「凑一个」
- 想凭接口 success 向用户报告「已流转」

**任一命中：停止，回到五阶段流程对应步骤。**
