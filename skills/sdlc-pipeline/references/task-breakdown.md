# 拆任务 + 估分排期

触发：研发阶段动作①、测试阶段动作③（commands.md N2/N3）。执行委派 meegle skill（创建工作项走其 sop-create-workitem；节点排期走 `workflow update-node`）。

## 拆任务（研发阶段）

1. 读需求 description（`workitem get`）→ 生成任务拆分建议表：每项含任务名、一句话职责、建议估分（points）、建议起止日期
2. 展示建议表 → 用户确认/修改/增删；**必须获得明确确认后才创建**，禁止直接建
3. 确认后按 meegle skill 的 sop-create-workitem 创建任务（`workitem create`，类型=任务，空间=需求所在空间）。关联父需求的字段：先 `workitem meta-fields` 查关联字段 key（如 workitem_related_select 类型）；查不到或不确定 → 询问用户，禁止猜
4. 回读：`workitem get` / `workitem query` 验证任务已创建且关联正确，报告任务 ID 清单；失败的逐个如实报告

## 估分排期（节点 schedule）

排期/估分写入节点（研发【确认进入研发】、测试【测试】等，按 commands.md N2 的动作定义）：

```bash
meegle workflow update-node --work-item-id <ID> --node-id <node_key> \
  --node-schedule '{"estimate_start_date":<起ms>,"estimate_end_date":<止ms>,"owners":["<userkey>"],"points":<估分>}' \
  --project-key <key> --format json
```

1. 先用确认卡片向用户确认排期/估分/负责人（一次确认）
2. owners 默认当前用户（`user me`）；他人 → `user search` 转 userkey，结果不唯一 → 询问
3. 排期/差异化排期/负责人不同时改（CLI 约束），拆多次调用
4. 回读：`workflow get-node --node-id-list '["<node_key>"]'` 验证 schedule 已写入；未变化 → 按失败报告
