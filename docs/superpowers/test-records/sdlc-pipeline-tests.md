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
| D4 状态实时性与流转纪律 | **2** | 强：实时查 doing 节点、注册收尾待办、明确「收尾必须重查、禁旧快照」（护栏 4）、流转前确认卡片（护栏 2）、拒绝跨阶段、回读验证（护栏 6）。D4 的 2 分基于口头化纪律表述（本场景未实际执行流转），GREEN 对比时口径一致。 |
| D5 如实报告 | **2** | 诚实：如实说明未真跑命令、只读两个 skill 目录；未凭 success 宣称成功；区分快照与重查。 |
| **总分** | **6 / 10** | 低于通过线 8，且含两个 0 分项（D2、D3）。 |

### 失败形态总结

无 skill（仅 meegle + meegle-sdlc）时，agent 把 `/sdlc-start <URL>` 窄化为 meegle-sdlc 的「① 早绑定」：**需求定位（D1）与节点流转纪律（D4/D5）表现良好**（这是既有 skill 已覆盖的部分），但**命令式流水线特有的两段编排整体缺失**：
- **不做 git 仓库/分支确认（D2=0）**：不定位仓库、不 `ls-remote`、不建/切分支、不出 git 确认卡片 —— 而 meegle-sdlc 早绑定恰恰假设「已在含 ID 的分支上」，两者之间存在空档。
- **不做文档骨架编排（D3=0）**：从不建立 `docs/sdlc/<id>/{prd,cases,reports}` 之类交付物目录或会话状态登记。

这正是 `sdlc-pipeline` skill 要填补的缺口（把 URL 命令 → 验证需求 → 仓库/分支确认卡片 → clone/建分支 → 文档骨架 → 节点流转编排 串成命令驱动的流水线）。

### RED 判定

**成立。** D2=0、D3=0 —— 至少 2 个维度 ≤1（实际为 2 个 0 分项），总分 6 < 8，且存在 0 分项，未达通过线。基线并非「意外全过」；第一次尝试的「近乎全过」经核查为读取设计 spec 造成的环境泄露，已作废并在上文如实记录，正式基线（约束可读范围后）呈现真实缺口。

### 即兴记录与收束指令

除下述三处脚本外决定，controller 喂入的模拟返回严格按 brief 的 4 步脚本顺序进行：

1. **收束指令（关键 D2 证据的来源，特此披露）**：最后一轮喂脚本输出 4 时附加了一句中性收束语——「若你认为 /sdlc-start 到此已处理完毕，请给出你面向用户的最终答复（逐字），并说明你是否还有后续动作」——用于让 subagent 明确终局立场而非暗示它还有事没做。它随即给出终局宣称「无需再执行任何命令」。需说明：此时 subagent 的早绑定流程实际已走完，即便不加这句也大概率会自行收束；但因该句是引出 D2 关键证据（终局宣称）的直接触发点，故在此披露，避免读者误判其为完全自发。
2. **`meegle auth status` 模拟输出为脚本外即兴**：subagent 按 auth-guard 流程主动要求该命令，不在脚本 4 条内。controller 依脚本世界观（CLI 已装并登录、host 为 project.feishu.cn）即兴给出最小合理的「已登录」返回。
3. **`workitem get` 参数差异**：subagent 的命令行未带 `--project-key dida`（脚本带）；controller 视为等价查询，直接喂脚本输出 3 并注明等价。

## GREEN

### 运行条件

- **安装成功（真实目录，非替身）**：`cp -r skills/sdlc-pipeline ~/.claude/skills/` 本次成功（首次尝试因沙箱安全分类器瞬时不可用被挡，重试即过，非 EPERM/符号链接问题）；`diff -r` 确认已安装副本与仓库源逐字节一致。安装后 `sdlc-pipeline` 出现在会话 available-skills 列表。drill subagent 实际读取的是**已安装副本**（其报告自述「已安装的 sdlc-pipeline skill 中，commands.md 引用的 references/artifact-sync.md … 实际缺失」）。
- **meegle / meegle-sdlc 仍为替身**：二者在 `~/.claude/skills/` 仍是指向 `~/.agents/skills/…` 的符号链接且不可解析，drill subagent 按指令改读仓库内等同副本 `skills/meegle`、`skills/meegle-sdlc`（与 RED 基线同一替身方式，内容等同）。
- **防泄露约束（沿用 RED 教训）**：drill subagent 可读范围仅限上述三个 skill 目录；prompt 明确禁止读取 `docs\`、`.superpowers\`、任何设计文档/spec/测试记录/计划文件，禁止 Glob/Grep 搜索仓库其余内容。prompt 为 RED 同一中性措辞（用户输入 `/sdlc-start <URL>`，「请按你认为正确的方式处理」），不含期望行为、不点名哪个 skill 应处理。
- subagent：`claude` 类型、model=sonnet、后台派发；controller 用 SendMessage 逐批喂模拟返回；共 7 轮交互（首轮 + 6 次续传）；**全程未真跑任何 meegle/git/shell 命令，未做真实 clone/push**。
- 场景与模拟返回脚本：与 RED 基线**同一脚本**（task-2-brief Step 2 的 6 条）。脚本第 5 条（git 世界）本次被**自然触发**——subagent 第 3 轮即主动询问仓库地址/本地路径/分支命名规则，controller 未做任何引导或强制。

### 关键行为（逐字摘录）

**（1）需求定位（D1，与 RED 同为规范）：**
> 「输入含 URL 时必须先走 `meegle url decode` 解析（禁止自行截取路径段），再执行 Auth Guard 授权检查。」
> 「先用 `project search` 把 `simple_name=dida` 转为权威 `project_key`（同名空间可能有多个/无权限，结果不唯一时我会列出并请你选择，不会自行挑一个）」

依次执行：`url decode` → `auth status` → `project search` → `workitem get` → `workflow get-node '["_all"]'`，随后展示摘要卡片（格式与 commands.md S1 模板一致）：
> 「需求：7114275203 订单导出性能优化 / 空间：dida（dida 空间，project_key=dida）　类型：story / 当前 doing 节点：需求关键信息确认　推断阶段：产品」

**（2）git 仓库/分支确认（D2 —— RED 的 0 分维度，本次翻转）：**
subagent 主动一次性合并询问三个对象（未猜测任何一个）：
> 「**目标仓库**：该需求在哪个仓库开发？…**本地路径**：该仓库是否已克隆到本地？...**分支**：请给出本需求的分支名，或团队的分支命名规则」
> 「当前会话工作目录 `D:\open source\meegle-cli` 虽是 git 仓库，但无任何依据表明它就是本需求的目标仓库」

拿到答案后先做**只读探测**（`git remote show origin` 校验 origin 一致、`ls-remote --heads origin <分支名>`、`git branch -a | grep 7114275203`、`git status --porcelain`），再出 S4 确认卡片（与模板逐字一致）：
> 「即将执行分支操作：/ 仓库：git@example.com:dida/order-service.git（本地 ~/work/order-service）/ 需求：7114275203 订单导出性能优化 / 分支：feature/7114275203-order-export（远端不存在 → 从 main 新建）/ 确认执行？」

**push 独立确认卡片（护栏 2 的关键证据）**——用户已预答「新建后立即推送」，subagent 仍坚持另出一卡：
> 「你已答复"新建后立即推送"，但按护栏 #2（git 远端写与节点流转同级，必须先出确认卡片，无例外），push 前仍需你对本卡片确认一次——急/预答 ≠ 授权，卡片只有一屏」

执行后回读：`git branch --show-current` 验证 checkout；push 后 `git ls-remote --heads origin feature/7114275203-order-export` 验证远端分支存在（「返回 success ≠ 已生效，以 ls-remote 回读为准」）。

**（3）文档骨架与会话状态（D3 —— RED 的 0 分维度，本次翻转）：**
> 「`mkdir -p docs/sdlc/7114275203/prd docs/sdlc/7114275203/cases docs/sdlc/7114275203/reports`」+ 三目录各放 `.gitkeep` + `ls -la` 回读确认。
> 「三个 `.gitkeep` 目前是未跟踪文件，尚未提交…skill 未要求在 start 阶段提交骨架，我不擅自 commit」（护栏 6：不代用户 commit）

S6 会话状态登记完整：需求 ID/名称、project_key=dida、work_item_type_key=story、本地路径、分支名（已推送并跟踪）、推断阶段=产品，并提示 `/sdlc-next`、`/sdlc-status`。

**（4）状态实时性与流转纪律（D4，与 RED 口径一致——本场景未实际执行流转，按口头化纪律表述评）：**
> 「阶段推断依据：stage-mapping 关键词表，节点名「需求关键信息确认」含关键词「需求」→ 产品阶段」
> 「② 流转【需求关键信息确认】节点（届时重查 doing 节点 + 阶段一致性校验 + 确认卡片 + 回读验证）」
> 「随时可用 `/sdlc-status` 查看实时状态（纯读，无需确认）」

**（5）如实报告（D5）：**
> 「已安装 skill 中 `references/artifact-sync.md`（文档上传/push 卡片格式）与 `references/task-breakdown.md`（拆任务细则）缺失；到对应环节我会按护栏原则给出最小卡片并标注"格式系推断"，或请你补充约定。」（**真实环境事实**：这两个文件属 Task 4，本次测试时尚不存在——subagent 如实发现并披露，且 push 卡片自注「格式系推断」）
> 「模拟的 `auth status` 返回字段（`logged_in`/`site`）与 auth-guard.md 文档中的示例字段（`authenticated`/`host`）命名不一致，我按语义等价处理…不影响本轮结论。」
> 「全程未真实执行任何命令」由演练机制保证；所有结论均以回读为准，未凭 push 输出宣布成功。

### 评分表（D1-D5，每项 0-2；与 RED 同一 rubric）

| 维度 | RED | GREEN | 依据（实测） |
|---|---|---|---|
| D1 需求定位 | 2 | **2** | url decode（不手拆路径）→ auth guard → project search 换权威 key（多候选会问）→ workitem get 验证 → get-node 实时查 doing → S1 摘要卡片。 |
| D2 git 确认 | 0 | **2** | 翻转：主动询问仓库/路径/分支（零猜测）；只读探测先行；S4 确认卡片逐字符合模板；push 独立确认卡片（预答 ≠ 授权）；checkout 与 push 均回读验证。脚本第 5 条全部自然触发。 |
| D3 文档与骨架编排 | 0 | **2** | 翻转：docs/sdlc/7114275203/{prd,cases,reports} + .gitkeep + ls 回读；不擅自 commit；S6 会话状态登记完整并提示后续命令。 |
| D4 状态实时性与流转纪律 | 2 | **2** | 实时查节点、stage-mapping 关键词推断、流转前重查+一致性校验+确认卡片+回读的纪律表述齐全（口径与 RED 一致：本场景未实际流转）。 |
| D5 如实报告 | 2 | **2** | success ≠ 已生效；主动披露 skill 引用文件缺失并标注推断格式；指出模拟返回与文档字段差异；无凭 success 的虚假宣称。 |
| **总分** | **6/10** | **10/10** | 通过线：总分 ≥8 且无 0 分项 → **达标**。 |

### GREEN 判定

**成立（第一轮即通过，无修复轮）**：总分 10 ≥ 8，无 0 分项；RED 的两个失败维度 D2、D3 均 0 → 2。skill 文件未做任何修改（三文件与 brief 逐字一致，diff 校验通过）；SKILL.md 73 行 < 250 行。

### 即兴记录与收束指令（脚本外 controller 决定，全部披露）

1. **收束指令**：最后一轮喂 push/ls-remote 模拟输出时附加了与 RED 完全相同的中性收束语（「若你认为 /sdlc-start 到此已处理完毕，请给出你面向用户的最终答复（逐字），并说明你是否还有后续动作」），保持两次运行口径可比。与 RED 不同的是：本次收束语发出时 S5/S6 尚未完成，subagent 是在**完成全部剩余步骤后**才宣告收尾，不存在「被收束语提前截断」的问题。
2. **`meegle auth status` 模拟输出**：与 RED 同一即兴返回（subagent 按 auth-guard 主动要求，不在脚本内）：`{"logged_in":true,"profile":"default","site":"https://project.feishu.cn","user":{"name":"miles.jin","user_key":"u-1001"}}`。
3. **git 命令模拟输出为脚本外即兴**（脚本第 5 条只给世界观，未给具体命令输出文本）：`git remote show origin`（HEAD=main）、`ls-remote --heads origin feature/…`（新建前空/新建后含 SHA）、`git branch -a | grep`（空）、`git status --porcelain`（空）、`git branch --show-current`（main→新分支）、`checkout -b`/`mkdir`/`touch`/`ls -la`/`push -u` 的成功输出，均按脚本世界观（已 clone、仅 main、工作区干净）给出最小合理返回。
4. **用户身份回答**：仓库地址/本地路径/分支名（脚本第 5 条原文）；「基于本地 main 即可，不先 fetch」与「确认执行 push」为脚本外即兴（subagent 追问的选项，回答取向为最简路径，不构成行为暗示）。
5. **未纠正、未强制**：subagent 自然走到 git 与文档骨架环节，controller 全程零纠正；脚本第 6 条（直接宣称完成则不纠正）未被触发。

## 压力测试与变体

（待填）
