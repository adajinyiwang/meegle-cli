# 交接简报 · {{req_id}} {{title}}

> 方案 v0.9 / schema_version 5。全文由 LLM 按用户意图和可核实事实起草，CLI 不自动填结构或编写正文。
> 放在接收方目录（dev/brief.md 或 test/brief.md）。返工重测后在本文件追加新轮次，不覆盖旧轮次。
> 日常开发尽量不改 product/test；用户明确交接授权起草 test/brief.md 是窄例外，不顺带改测试用例、报告或产品 AC。

## 本次交接 · {{from_stage}} → {{to_stage}} · {{requirement_version}}

- 交接方向：{{from_stage}} → {{to_stage}}
- 关联：test_round={{test_round}}；requirement_version={{requirement_version}}
- 代码/构建：code_ref={{code_ref}}；build_ref={{build_ref}}（可选）
    - <!-- 区分提交基线与实际部署/受测版本；无证据填“待确认”，不能用当前 HEAD 冒充部署版本。产品交接尚无测试轮次可注明未开始。 -->
- 接手人：<!-- CLI 回显的实际参与人候选，经用户确认；未知如实说明，不猜账号或权限 -->
- 阶段产物：
    - <!-- 列产物相对链接（接收方目录内），如 [tasks.md](./tasks.md) 或 [report.md](./report.md) -->
- AC 达成情况：
    - <!-- 逐条说明或指向 product/prd.md 的 AC 与 dev/tasks.md；区分已实现、已测试、未核实 -->
- 本轮验证与缺口：
    - <!-- 实际测试环境/结果、未测试内容、过期报告、未提交/未推送、待合并/接口待核对等；接受缺口不改变事实 -->
- 遗留问题：
    - <!-- 未决问题、技术债、已知风险；有条件通过可引用报告中的遗留/影响/接受人/后续，不另造审批 -->
- 下一步（接手人执行）：

```bash
git fetch
git checkout {{branch}}
sdlc start {{req_id}}    # 只读恢复现场；待合并归档也按 req_id 定位
```

<!-- 已 clone 且工作区可安全切换时使用上述 Git 示例；有本地变更/冲突先人工处理，不 force/reset/偷 stash。新机器由用户取得仓库，不自动 clone。 -->

> 未安装工具链？运行安装向导（一次装好 meegle+sdlc CLI、IDE 薄入口与共享规则）：
> `npx -y @didatravel-jinyi/meegle@latest install`
> 不猜发布 URL，不使用 curl 管道传错参数。首次登录：安装向导代跑 meegle 登录，或首次使用时 CLI 自动发起 meegle 登录交接（转出飞书授权链接，浏览器完成——凭据由 meegle keychain 托管，CLI 不持有）；不粘贴网页 token 或凭据。

### 可转交话术（草稿）

<!-- 本草稿不是事实源：正式话术以 apply 输出为准，事实内容存 journal `handoff_prepared` 事件 payload，status 从该事件补取；草稿与实际发布状态不一致时以事件为准。 -->
<!-- @实际接手人 + req_id/标题 + 本轮版本 + 已核实结果/缺口 + 下一步 + sdlc start <req_id>，保持简短。 -->
<!-- 业务产物提交推送 → 外部动作 → publish 本需求 journal/meta 成功后，才可输出“可接手”话术；失败只列实际结果与待续做。 -->
<!-- 话术产出事件叫 handoff_prepared，仅表示已备好待人转发，不是 sent；不声称通知已送达。status 可只读补取，不新建事件或重发动作。 -->
