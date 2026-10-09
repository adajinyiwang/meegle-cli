# 命令流程

解析命令时读本文件。团队约定（分支模板/仓库映射/节点映射/基线分支）见 [team-conventions.md](team-conventions.md)；文档上传细则见 [artifact-sync.md](artifact-sync.md)；拆任务与排期细则见 [task-breakdown.md](task-breakdown.md)。

## /sdlc-start [链接|ID]

### S1 需求解析与验证

- 输入含 URL → 按 meegle skill 的 `url decode` 流程解析（**禁止**自行截取路径段），得到 work_item_id / simple_name，再 `project search` 转权威 project_key
- 输入为 ≥6 位连续数字 → 视为工作项 ID；project_key 未知 → 询问用户空间名后 `project search`
- 验证并取概况：

```bash
meegle workitem get --work-item-id <ID> --project-key <key> --format json
meegle workflow get-node --work-item-id <ID> --node-id-list '["_all"]' --project-key <key> --format json
```

- 查无此项 / 无权限 → 如实报告报错，允许追问一次（请用户提供正确 ID 或链接）；仍无效 → 停止
- 验证通过后展示需求摘要卡片：

```
需求：<ID> <名称>
空间：<project_key>　类型：<work_item_type_key>
当前 doing 节点：<节点名>　推断阶段：<产品/研发/测试>
```

### S2 无参路径：新需求 vs 现有需求

1. `git branch --show-current`——在仓库中且分支名含 ≥6 位连续数字 → 候选现有需求，按 S1 验证后询问：「当前分支指向需求 <ID> <名称>，是继续这个需求，还是开启新需求？」
2. 不在仓库 / 分支无 ID → 询问：「请提供需求链接或编号。」用户给出后回到 S1

### S3 仓库与本地目录定位

按 team-conventions.md 的系统↔仓库映射解析：映射命中 → 用之；未命中 → 询问用户仓库地址（获得后建议写入映射节）。本地目录：先问用户项目路径；本地无 → 征得用户确认后 `git clone <url> <path>`，clone 后报告本地路径与目录名。

### S4 分支编排（拉取/创建前必须确认）

1. 按 team-conventions.md 的分支命名模板推导分支名；模板未确认 → 询问用户分支名或命名规则
2. `git ls-remote --heads origin <分支名>` 查远端是否已存在；同时 `git branch -a | grep <需求ID>` 列出既有候选，候选不唯一 → 请用户选择
3. 展示确认卡片：

```
即将执行分支操作：
  仓库：<url>（本地 <path>）
  需求：<ID> <名称>
  分支：<分支名>（远端已存在 → fetch 并切换 / 不存在 → 从 <基线分支> 新建）
确认执行？
```

4. 确认后：已存在 → `git fetch origin <分支名> && git checkout <分支名>`；不存在 → `git checkout -b <分支名> <基线分支>`（基线分支判定见 team-conventions.md）。随后询问是否立即推送远端；推送另出确认卡片（见 artifact-sync.md 的推送卡片格式）
5. 当前分支的需求 ID ≠ 目标需求 ID → **绝不**「就用当前分支」，按本流程处理

### S5 文档骨架

`mkdir -p docs/sdlc/<ID>/prd docs/sdlc/<ID>/cases docs/sdlc/<ID>/reports`，每个目录放一个 `.gitkeep`。本地操作无需确认，创建后报告。已存在 → 跳过并说明（幂等）。

### S6 登记会话状态

记录：需求 ID/名称、project_key、work_item_type_key、本地路径、分支名、推断阶段。最后提示后续命令（`/sdlc-next` 推进、`/sdlc-status` 查看状态）。

## /sdlc-next

### N1 状态重查（禁用会话快照）

`workflow get-node --node-id-list '["_all"]'` 重查 → doing 节点 → 按 ../meegle-sdlc/references/stage-mapping.md 关键词表推断阶段；用户此前显式指定阶段 → 以指定为准。无会话状态（本会话未跑过 start）→ 先按 S2 定位需求再继续。

### N2 定位下一个未完成动作

| 阶段 | 动作序列 | 完成判定（权威源） |
|---|---|---|
| 产品 | ①上传设计文档 ②流转【需求关键信息确认】 | ① `prd/` 有文件且已推送远端 ② doing 节点已越过该节点 |
| 研发 | ①拆任务+估分排期 ②流转【确认进入研发】 ③流转【测试环境部署】 | ① 需求下存在子任务 ②③ doing 节点位置 |
| 测试 | ①上传测试用例 ②上传测试结果 ③【测试】节点估分排期 ④流转【测试】 | ① `cases/` ② `reports/`（均需已推送） ③ 该节点排期字段非空 ④ doing 节点 |

按序检查，取第一个未完成项作为「下一个动作」；本阶段全部完成 → 报告并进入下一阶段判定或建议 `/sdlc-done`。

### N3 执行单个动作

- 文档上传 → 按 [artifact-sync.md](artifact-sync.md)
- 拆任务 / 估分排期 → 按 [task-breakdown.md](task-breakdown.md)
- 节点流转 → 遵循 ../meegle-sdlc/references/transition-flow.md：重查 doing 节点 → 阶段一致性校验 → 确认卡片 → 委派 meegle skill 的 sop-transition-node 执行 → `get-node` 回读 → 如实报告

一次只推进**一个动作**；完成后报告结果，提示可再次 `/sdlc-next`。

### N4 跨阶段防线

要流转的目标节点不是当前 doing 节点（前置节点未流转）→ 拒绝执行，列出当前 doing 节点与缺失的前置动作。

## /sdlc-done

1. 重查：`get-node ["_all"]`、`git ls-remote --heads origin <分支>`、`git status --porcelain`、`docs/sdlc/<ID>/` 三目录内容、需求子任务存在性
2. 输出收尾核对清单：

```
需求 <ID> <名称> 收尾核对：
  节点：需求关键信息确认 ✓/✗ ｜ 确认进入研发 ✓/✗ ｜ 测试环境部署 ✓/✗ ｜ 测试 ✓/✗
  文档：prd ✓/✗ ｜ cases ✓/✗ ｜ reports ✓/✗（✓ = 已推送远端）
  任务：子任务 N 个 / 无
  分支：已推送 / 仅本地；未提交改动：无 / N 个文件
```

3. 未完成项如实报告，**不代跳**；提示对应命令（`/sdlc-next` 或具体动作）
4. 全部完成 → 宣布需求收尾；不自动执行任何额外操作

## /sdlc-status

纯读命令，无需任何确认。执行 /sdlc-done 的第 1-2 步查询并展示清单，附当前阶段与「下一个动作」提示。
