# ① 早绑定：分支名 → 工作项

> 任务开始阶段（接到开发/测试/产品类任务时）读取本文件执行一次。绑定成功注册 todo；失败静默退出，**不打断、不拖延当前任务**。

## 1. 提取候选 ID

读取当前分支名（`git branch --show-current`），提取**首个 ≥6 位连续数字**作为候选工作项 ID。

| 分支示例 | 提取结果 |
|---|---|
| `feature/2025091234-user-login` | `2025091234` |
| `dev_2025091234` | `2025091234` |
| `fix/2025091234-hotfix` | `2025091234` |
| `feature/user-login` | 无 ID → 静默不启用 |
| `release/v2.3` | 无 ≥6 位数字 → 静默不启用 |

无候选 ID → **静默不启用本 skill**（不告知用户、不注册 todo）。**禁止**用任务内容、commit message 或名称搜索反查工作项来「凑一个」。

## 2. 验证 ID

```bash
meegle workitem get --work-item-id <候选ID> --format json
```

- 成功 → 记录 `id`、`name`、`project_key`、`work_item_type_key`
- 查无此项 / 无权限 / 报错 → 允许追问**一次**：「分支名解析出 <ID>，但在飞书项目中未找到。本任务是否关联飞书项目工作项？如有请提供工作项 ID 或链接。」用户未提供或仍无效 → 静默不启用
- 用户给了 URL → 按 meegle skill 的 `url decode` 流程解析，禁止自行截取路径段

## 3. 阶段预判

查全量节点找 doing 节点（不传 `field_key_list`，保持轻量）：

```bash
meegle workflow get-node --work-item-id <ID> --node-id-list '["_all"]' --project-key <project_key> --format json
```

- 取 `status == "doing"` 的节点，按 [stage-mapping.md](stage-mapping.md) 关键词表判定当前处于哪个阶段（产品/开发/测试）
- 多个 doing（并行节点）→ 全部记录，收尾时请用户指定本次任务对应哪个节点
- 关键词全部不命中 → 记录「阶段未知」，收尾时列出节点请用户确认
- ⚠️ 本步快照**仅用于预判**；流转前必须重查（SKILL.md 护栏 4）

## 4. 注册 todo

用平台的任务/todo 机制注册一条：

> 任务收尾时流转 Meegle 节点：工作项 <ID> <name>（<project_key>），预判阶段 <阶段>，doing 节点 <节点名>(<node_key>)

然后开始正常工作。工作期间不执行任何流转动作。

## 静默不启用清单

- 分支名无 ≥6 位连续数字
- ID 验证失败且追问一次未获得有效 ID
- 不在 git 仓库中
- 用户明确表示本任务不关联飞书项目

静默不启用时：不注册 todo，本会话不再提及本 skill。
