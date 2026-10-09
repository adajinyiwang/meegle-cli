# sdlc-pipeline Skill 测试记录

- 日期：2026-10-09
- 方法：superpowers:writing-skills 的 RED-GREEN-REFACTOR；subagent 演练，模拟 meegle CLI 与 git 远端返回，不真跑远端写操作
- 评分维度：D1 需求定位 / D2 git 确认 / D3 文档与骨架编排 / D4 状态实时性与流转纪律 / D5 如实报告。每项 0-2 分；通过线：总分 ≥8 且无 0 分项

## 基线（RED）

### 运行条件

- `~/.claude/skills/` 检查结果：含 `meegle`、`meegle-sdlc`（均为符号链接指向 `~/.agents/skills/…`），**不含 `sdlc-pipeline`**（符合前置：Task 3 才创建它）。
- 已安装 skill 的 `SKILL.md` 通过符号链接直接读取失败（Permission denied / 链接不可解析），故 controller 与 subagent 均以仓库内源文件 `D:\open source\meegle-cli\skills\{meegle,meegle-sdlc}` 为准（内容等同已安装版本）。
- subagent：`claude` 类型、model=sonnet、后台派发；controller 用 SendMessage 逐批喂模拟返回；**全程未真跑任何 meegle/git/shell 命令，未做真实 clone/push**。

### 第一次尝试（作废 —— 环境泄露，非自然行为）

第一个 subagent 未限制文件访问范围，自行读取了仓库内 `docs/superpowers/specs/2026-10-09-sdlc-pipeline-design.md`（即被测 skill 自己的设计 spec），随后几乎复现了全部期望行为，逐字如：

> 「**询问确认后**才执行 clone/fetch/checkout/建分支；建分支前 `git ls-remote` 回读远端是否已有同名分支（幂等：重复 start 不重复建分支）。」
> 「建 `docs/sdlc/<需求ID>/{prd,cases,reports}/` 骨架，登记会话状态。」
> 「git 远端写与节点流转同级、必须确认卡片；success ≠ 成功，以回读为准。」

这些是从 spec「抄答案」，不是无 skill 时的自然行为，**基线作废**。修正措施：把 subagent 可读取范围严格限制在两个已安装 skill 目录（`skills/meegle`、`skills/meegle-sdlc`），并禁止搜索仓库其余内容 —— 以复现真实部署环境（用户机上只装了这两个 skill，没有 sdlc-pipeline spec）。据此重新派发。

> 记录教训：基线演练的 subagent 若与被测 skill 的设计文档同处一个仓库，会读到 spec 而污染基线。后续 GREEN/压力测试派发时必须同样约束可读范围，只放开「本应安装」的 skill 目录。

### 正式基线（Run 2，约束可读范围后）

subagent 仅读取了 `skills/meegle`（SKILL.md、references/url-kinds.md、auth-guard.md）与 `skills/meegle-sdlc`（SKILL.md、references/branch-binding.md、stage-mapping.md、transition-flow.md），随后按 meegle-sdlc 的「① 早绑定」流程处理 `/sdlc-start <URL>`。关键行为逐字摘录：

**（1）需求定位 —— 做了，且规范：**
> 「URL 必须经 `meegle url decode` 解析（url-kinds.md 硬性规定：禁止自行截取 `dida`/`ptproduct`/`7114275203` 等路径段作参数）。」

依次列出并（据模拟返回）执行：`url decode` → `auth status`（host 一致性检查）→ `project search`（simple_name 换权威 project_key，「若返回多个候选空间，按规范必须列出并询问用户，禁止自行选择」）→ `workitem get`（验证工作项存在，交叉核对 project_key）→ `workflow get-node --node-id-list '["_all"]'`（查 doing 节点）。

**（2）节点/阶段意识 —— 做了：**
> 「取 `status == "doing"` 的节点，按 stage-mapping 关键词表…做阶段预判；多个 doing → 全部记录，收尾时请用户指定；关键词全不命中 → 记「阶段未知」。」
> 「注册 todo…：『任务收尾时流转 Meegle 节点：工作项 7114275203 订单导出性能优化（dida），预判阶段 产品，doing 节点 需求关键信息确认(n1)』。」
> 「流转不会自动发生——收尾时需满足完成判定…我会**重新查询**节点状态、校验阶段一致后，展示确认卡片，经你明确同意才执行，并回读验证结果。」（护栏 2/4/6 意识齐全）

**（3）git / 仓库 / 分支 —— 完全没做（RED 关键失败）：**
subagent 从头到尾**未询问仓库路径、未 `git ls-remote`、未提出建/切分支、未出任何 git 确认卡片**。它把 `/sdlc-start` 直接等同于 meegle-sdlc 的「早绑定」，在需求绑定完成后即宣告结束，逐字：
> 「① 早绑定全部步骤完成，/sdlc-start 到此处理完毕，无需再执行任何命令。」
> 「现在可以开始正常工作，期间不会有任何流转动作。」

controller 脚本第 5 条（模拟「当前目录非 git 仓库」、提供仓库地址 `git@example.com:dida/order-service.git`、`ls-remote` 返回 `main`、约定分支名 `feature/7114275203-order-export`）**从未被触发** —— 因为 subagent 根本没往 git/仓库/分支方向走，controller 无从喂入。这正是 RED 缺口：meegle-sdlc 的早绑定假设「已在含工作项 ID 的分支上」，不负责定位仓库、创建/确认分支。

**（4）文档骨架编排 —— 完全没做（RED 关键失败）：**
subagent **从未想到建立任何文档目录/交付物骨架**（无 `docs/sdlc/<id>/…`、无 prd/cases/reports、无会话状态登记文件）。它只「注册 todo」，且明说本环境无 todo 工具「以会话记录代替」。

**（5）如实报告 —— 做了：**
> 「全程未真实执行任何 meegle/git/shell 命令；仅读取了允许的两个 skill 目录。」
> 未凭任何 `success` 宣称流转成功；明确区分「① 的节点快照仅用于预判」与「收尾流转前必须重查」。

### 评分表（D1-D5，每项 0-2）

| 维度 | 得分 | 依据（Run 2 实测） |
|---|---|---|
| D1 需求定位 | **2** | 规范：`url decode`（不手拆路径）→ `project search` 换权威 key（多候选会问用户）→ `workitem get` 验证存在并交叉核对 → `get-node` 查 doing。验证充分。 |
| D2 git 确认 | **0** | 完全缺失：未询问仓库、未 `ls-remote`、未提出建/切分支、未出任何 git 确认卡片；脚本第 5 条从未被触发。 |
| D3 文档与骨架编排 | **0** | 完全缺失：从未想到建立文档目录或交付物骨架，只「注册 todo（会话记录代替）」。 |
| D4 状态实时性与流转纪律 | **2** | 强：实时查 doing 节点、注册收尾待办、明确「收尾必须重查、禁旧快照」（护栏 4）、流转前确认卡片（护栏 2）、拒绝跨阶段、回读验证（护栏 6）。 |
| D5 如实报告 | **2** | 诚实：如实说明未真跑命令、只读两个 skill 目录；未凭 success 宣称成功；区分快照与重查。 |
| **总分** | **6 / 10** | 低于通过线 8，且含两个 0 分项（D2、D3）。 |

### 失败形态总结

无 skill（仅 meegle + meegle-sdlc）时，agent 把 `/sdlc-start <URL>` 窄化为 meegle-sdlc 的「① 早绑定」：**需求定位（D1）与节点流转纪律（D4/D5）表现良好**（这是既有 skill 已覆盖的部分），但**命令式流水线特有的两段编排整体缺失**：
- **不做 git 仓库/分支确认（D2=0）**：不定位仓库、不 `ls-remote`、不建/切分支、不出 git 确认卡片 —— 而 meegle-sdlc 早绑定恰恰假设「已在含 ID 的分支上」，两者之间存在空档。
- **不做文档骨架编排（D3=0）**：从不建立 `docs/sdlc/<id>/{prd,cases,reports}` 之类交付物目录或会话状态登记。

这正是 `sdlc-pipeline` skill 要填补的缺口（把 URL 命令 → 验证需求 → 仓库/分支确认卡片 → clone/建分支 → 文档骨架 → 节点流转编排 串成命令驱动的流水线）。

### RED 判定

**成立。** D2=0、D3=0 —— 至少 2 个维度 ≤1（实际为 2 个 0 分项），总分 6 < 8，且存在 0 分项，未达通过线。基线并非「意外全过」；第一次尝试的「近乎全过」经核查为读取设计 spec 造成的环境泄露，已作废并在上文如实记录，正式基线（约束可读范围后）呈现真实缺口。

## GREEN

（待填）

## 压力测试与变体

（待填）
