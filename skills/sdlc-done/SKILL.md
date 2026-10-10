---
name: sdlc-done
description: 需求收尾（sdlc done）：归档准备、待人工合并提醒、PR 合并后核验收尾。用户说「测试完成要收尾」「完结需求」「归档需求」时使用。提前调用也展示缺口与可选动作，不要求先全绿；没有独立 archive 命令。
---

# sdlc-done（收尾，两段）

读取用户主目录下 **`.sdlc/skill-core.md`** 并完整遵循——特别是触发映射、plan/apply 协作（§3）、同分支 PR 与 done（§7）与对话输出规范（§0）。

本命令：`sdlc done [<req_id>]`。两段：

- 第一段（PR open）：归档准备——`git mv` 进 `.sdlc/archive/` + 提交推送，停「待人工合并」（不宣称已交付）。
- 第二段（PR merged）：核验后记录收尾（verified / with_gaps，飞书终态回读 + journal 留痕）；PR 未核实时 `--manual-confirm pr_merged` 人工确认。

PR 合并是人工动作：只核验与提醒，不代合并不伪称已合并。

转述时用自然语言描述当前状态与下一步选择，用户确认后由你执行 apply；命令、flag 与 plan_id 不出现在给用户的文字里。
