# sdlc（Qoder 薄入口 · schema_version 5）
> 实现进度：v0.1.0-I5（install/update 维护本入口手动放置；init/start/status/doctor/next save·handoff/done/回退/兜底全链 + update 分发自更新均已落地，mock 模式联调，见 docs/plan.md）。

读取**用户主目录下 `.sdlc/skill-core.md`**（安装时生成、`sdlc update` 维护的共享规则），完整遵循对话输出规范（§0）、触发映射、plan/apply、软 DoD、写作范围、恢复与事实话术。不要在薄入口复制核心规则。

Qoder 与 Claude Code 同为 P0，共享这份核心；CLI tool token 分别为 `qoder`、`claude`。两种 IDE 的发现/触发、非交互调用、确认中继、恢复与升级均需 M1 实测，不以一个通过替代另一个。Codex 为 P1；卡片、需求搜索与自动 clone 为 P2。

工具注记：经终端工具调用 CLI，非交互场景使用 plan/apply，确认按本 plan 集中一次；转述计划用自然语言动作，CLI 命令与 plan_id 对用户透明（用户说「继续」即由你执行 apply——skill-core §0）；用户说“保存”只做 `next --intent save`，说“开发完成提测/交接”才做 `next --intent handoff`；登录无需显式操作（需要飞书时 CLI 转出飞书授权链接，转述给用户点击后自动续跑原命令；凭据由 meegle keychain 托管，不经手 token）；收尾走 `done`，没有独立 archive 命令。无 MCP 不等于物理隔离，无 `--yes` 不证明人工已经确认。

若共享核心不存在：提示从公司发布源取得安装脚本后，Qoder 使用 `bash install.sh --tool qoder`，Claude Code 使用 `bash install.sh --tool claude`。不猜发布 URL，不用 curl 管道拼错参数，不凭记忆模仿流程；安装/登录/维护同样先展示计划并确认。本次方案修订不执行这些动作，也不写仓库真实 AGENTS、IDE 配置或权限设置。
