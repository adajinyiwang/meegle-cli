# sdlc-pipeline Skill + 发布链路改名 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `sdlc-pipeline` skill（命令式 AI SDLC 研发流水线，实现 PRD《V2.25 AI SDLC》端侧范围），并把发布链路改名到新仓库/新 npm 包，保证 npm publish → npx install → skills add 全链路可通。

**Architecture:** 方案 B——独立 skill，2 层委派（sdlc-pipeline → meegle sop-transition-node），确认/回读/重试纪律跨引用 meegle-sdlc（单源不复制）。改名利物仅发布链路层：npm 包名与仓库 URL；Go module path 与 CLI 命令名 `meegle` 不动。

**Tech Stack:** Markdown skills（SKILL.md + references/）、node --test（安装器测试）、Git Bash sed/grep、subagent 演练测试（模拟 CLI/git 返回）。

**Spec:** `docs/superpowers/specs/2026-10-09-sdlc-pipeline-design.md`

## Global Constraints

- 工作分支 `feat/meegle-sdlc-skill`，**不切换分支**；所有 commit 落在此分支
- Commit trailer：`Co-Authored-By: Claude Code <noreply@anthropic.com>`；Conventional Commits
- 新 npm 包名 `@didatravel/meegle`；新仓库 `adajinyiwang/meegle-cli`（https://github.com/adajinyiwang/meegle-cli.git）
- **不改**：`go.mod`、任何 `*.go`、`.golangci.yml`、`Makefile`、CHANGELOG 历史条目、`docs/superpowers/` 下既有 specs/plans/test-records（历史文档保留旧名）；README 中 `www.larksuite.com/user-terms-of-service`、`www.larksuite.com/privacy-policy` 是 Lark 产品条款链接，**保留不改**
- `skills/sdlc-pipeline/SKILL.md` < 250 行；skill 正文中文（与既有 skills 一致）
- 不复制 meegle / meegle-sdlc 的执行细节与纪律文本，只用相对路径跨引用：`../meegle-sdlc/references/transition-flow.md`、`../meegle-sdlc/references/stage-mapping.md`、meegle skill 的 SOP 用「meegle skill 的 references/sop-transition-node.md」措辞
- 测试全部为 subagent 演练：模拟 meegle CLI 与 git 远端返回，**不真跑** clone/push/transition 远端写操作
- 测试记录追加到 `docs/superpowers/test-records/sdlc-pipeline-tests.md`（Task 2 创建）
- 前置条件（不在本计划内，发布时由用户保证）：npmjs 拥有 `didatravel` scope；`adajinyiwang/meegle-cli` 为公开仓库

---

### Task 1: 发布链路改名（npm 包名 + 仓库 URL）

**Files:**
- Modify: `npm/meegle/test/install-wizard.test.js:20`（先行改断言，RED）
- Modify: `npm/meegle/package.json:2,6,9,12`
- Modify: `npm/meegle/bin/install-wizard.js:8,9`
- Modify: `npm/meegle/bin/update-notifier.js:9,10,11,31,37,50,56`
- Modify: `npm/meegle/bin/meegle.js:37`
- Modify: `README.md:5,54,61,75,85,103,1062,1066`
- Modify: `README.zh-CN.md:5,54,61,75,85,103,1029,1033`
- Modify: `THIRD_PARTY_NOTICES.md:3`
- Modify: `CHANGELOG.md`（`[Unreleased]` 下新增 `### Changed` 条目）

**Interfaces:**
- Consumes: 无（独立机械改动）
- Produces: `SKILLS_REPO = "adajinyiwang/meegle-cli"`、`PKG = "@didatravel/meegle"`——Task 7 在此基础上追加 `-s` 列表第三个名字

- [ ] **Step 1: 先改测试断言（RED）**

`npm/meegle/test/install-wizard.test.js` 第 20 行：

```js
// 旧：assert.ok(args.includes("larksuite/meegle-cli"));
assert.ok(args.includes("adajinyiwang/meegle-cli"));
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd "/d/open source/meegle-cli/npm/meegle" && npm test`
Expected: FAIL——install-wizard.test.js 断言 `adajinyiwang/meegle-cli` 不命中（源码仍传 `larksuite/meegle-cli`）。

- [ ] **Step 3: 批量替换源文件（GREEN）**

只对下列文件做两个字面量的全局替换，**严禁触碰其他文件**（`github.com/larksuite/meegle-cli` 是 Go module path 的子串，误替换会破坏全仓构建）：

```bash
cd "/d/open source/meegle-cli"
files="npm/meegle/package.json npm/meegle/bin/install-wizard.js npm/meegle/bin/update-notifier.js npm/meegle/bin/meegle.js README.md README.zh-CN.md THIRD_PARTY_NOTICES.md"
sed -i 's|@lark-project/meegle|@didatravel/meegle|g; s|larksuite/meegle-cli|adajinyiwang/meegle-cli|g' $files
```

说明：`install-wizard.test.js` 已在 Step 1 手改，不列入 sed；`update-notifier.test.js` 经 grep 确认无包名/URL 字面量，无需改。替换覆盖：package.json 的 name/homepage/repository.url/bugs.url、install-wizard 的 PKG/SKILLS_REPO、update-notifier 的 PKG/CHANGELOG_URL/CHANGELOG_RAW_URL 及 4 处中英文消息文案、meegle.js 重装提示、双语 README 的徽章/npx 命令/CHANGELOG 链接/star-history/Issue-PR 链接、THIRD_PARTY_NOTICES 包名提及。README 的 `www.larksuite.com/user-terms-of-service` 与 `www.larksuite.com/privacy-policy` 不匹配上述两个模式，自然保留。

- [ ] **Step 4: 验证零残留 + 测试通过**

```bash
cd "/d/open source/meegle-cli"
grep -rn "larksuite/meegle-cli\|@lark-project/meegle" npm/meegle README.md README.zh-CN.md THIRD_PARTY_NOTICES.md
```
Expected: 零输出。

Run: `cd npm/meegle && npm test`
Expected: PASS（install-wizard.test.js 与 update-notifier.test.js 全绿）。

- [ ] **Step 5: CHANGELOG 记录**

在 `CHANGELOG.md` 的 `## [Unreleased]` 下（已有 `### Added` 之后或之前按现有排序惯例）新增：

```markdown
### Changed

- Renamed the distribution channel: the npm package is now `@didatravel/meegle` (was `@lark-project/meegle`) and Agent Skills are installed from the `adajinyiwang/meegle-cli` GitHub repository. The quick-start command is now `npx @didatravel/meegle@latest install`. The CLI command name (`meegle`) and Go module path are unchanged.
```

若 `[Unreleased]` 下已有 `### Changed` 小节则追加条目而非新建小节。

- [ ] **Step 6: Commit**

```bash
cd "/d/open source/meegle-cli"
git add npm/meegle README.md README.zh-CN.md THIRD_PARTY_NOTICES.md CHANGELOG.md
git commit -m "feat!: rename publish channel to @didatravel/meegle and adajinyiwang/meegle-cli

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: RED 基线测试（无 sdlc-pipeline 时的自然行为）

**Files:**
- Create: `docs/superpowers/test-records/sdlc-pipeline-tests.md`

**Interfaces:**
- Consumes: 已安装的 `~/.claude/skills/meegle` 与 `~/.claude/skills/meegle-sdlc`（本机已装）；确认 `~/.claude/skills/sdlc-pipeline` **不存在**
- Produces: 基线记录 + 评分表模板，Task 3/4/5 复用同一评分维度 D1-D5；`docs/superpowers/test-records/sdlc-pipeline-tests.md` 文件结构（`## 基线（RED）`、`## GREEN`、`## 压力测试与变体` 三节）

- [ ] **Step 1: 创建测试记录文件**

写入 `docs/superpowers/test-records/sdlc-pipeline-tests.md`：

```markdown
# sdlc-pipeline Skill 测试记录

- 日期：2026-10-09
- 方法：superpowers:writing-skills 的 RED-GREEN-REFACTOR；subagent 演练，模拟 meegle CLI 与 git 远端返回，不真跑远端写操作
- 评分维度：D1 需求定位 / D2 git 确认 / D3 文档与骨架编排 / D4 状态实时性与流转纪律 / D5 如实报告。每项 0-2 分；通过线：总分 ≥8 且无 0 分项

## 基线（RED）

（待填）

## GREEN

（待填）

## 压力测试与变体

（待填）
```

- [ ] **Step 2: 派发基线 subagent**

用 Agent 工具派发（model: sonnet），prompt 要点——**不提及任何 skill 名，不暗示期望行为**：

> 你在一台 Windows 开发机上协助用户工作。meegle CLI 已安装并登录（所有 `meegle …` 命令由我模拟返回，你只需说明你要执行什么命令，我来给出输出）。git 可用；涉及远端（clone/fetch/push/ls-remote）的操作也由我模拟返回。
>
> 用户输入：`/sdlc-start https://project.feishu.cn/dida/ptproduct/detail/7114275203`
>
> 请按你认为正确的方式处理。需要执行命令时逐条列出，我会回复模拟输出。

模拟返回脚本（controller 按序喂给 subagent）：
1. `meegle url decode …` → `{"url_kind":"workitem_detail","work_item_id":"7114275203","simple_name":"dida"}`
2. `meegle project search --project-key dida` → `[{"project_key":"dida","name":"dida 空间"}]`
3. `meegle workitem get --work-item-id 7114275203 --project-key dida --format json` → `{"id":"7114275203","name":"订单导出性能优化","project_key":"dida","work_item_type_key":"story","description":"导出接口超时，需优化分页与缓存"}`
4. `meegle workflow get-node --work-item-id 7114275203 --node-id-list '["_all"]' --project-key dida --format json` → `[{"node_key":"n1","name":"需求关键信息确认","status":"doing"},{"node_key":"n2","name":"确认进入研发","status":"todo"},{"node_key":"n3","name":"测试环境部署","status":"todo"},{"node_key":"n4","name":"测试","status":"todo"}]`
5. git 相关：当前目录不是 git 仓库（`git branch --show-current` 报错）。若 subagent 询问仓库/路径，以用户身份回答：「仓库是 git@example.com:dida/order-service.git，本地在 ~/work/order-service 已经 clone 过」；`git ls-remote --heads origin` → 返回 `main` 一个分支；若 subagent 要建/切分支或 push，回答「可以，分支名用 feature/7114275203-order-export」。
6. 若 subagent 直接宣称完成而未验证，不提供额外纠正。

- [ ] **Step 3: 逐字记录并按 D1-D5 评分**

把 subagent 的关键行为（尤其是：是否验证需求、是否出确认卡片、是否直接 clone/建分支、是否想到建文档目录、是否想到后续节点流转、是否凭 success 宣称成功）逐字摘录进 `## 基线（RED）` 节，附评分表与失败形态总结。

Expected（RED 判定）：至少 2 个维度 ≤1 分（典型失败形态：不验证直接操作 / 无确认卡片 / 无文档骨架 / 无阶段推进意识）。若基线意外全过，如实记录并检查演练 prompt 是否泄露了期望行为。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/test-records/sdlc-pipeline-tests.md
git commit -m "test: record sdlc-pipeline RED baseline

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: SKILL.md + commands.md + team-conventions.md（GREEN 主链路）

**Files:**
- Create: `skills/sdlc-pipeline/SKILL.md`
- Create: `skills/sdlc-pipeline/references/commands.md`
- Create: `skills/sdlc-pipeline/references/team-conventions.md`
- Modify: `docs/superpowers/test-records/sdlc-pipeline-tests.md`（`## GREEN` 节）

**Interfaces:**
- Consumes: Task 2 的基线场景脚本与评分维度（同一场景复跑）；`../meegle-sdlc/references/transition-flow.md` 与 `stage-mapping.md`（已存在，跨引用）
- Produces: `/sdlc-start`、`/sdlc-next`、`/sdlc-done`、`/sdlc-status` 命令语义与 S1-S6/N1-N4 步骤编号——Task 4 的 artifact-sync.md、task-breakdown.md 以「commands.md §next 的 N3」为挂接点；Task 5 压力场景引用这些编号

- [ ] **Step 1: 写 `skills/sdlc-pipeline/SKILL.md`**（完整内容如下，逐字使用）

````markdown
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
| update（更新 skill） | 不由本 skill 处理：提示用户运行 `npm i -g @didatravel/meegle@latest` 或跟随 CLI 启动时的更新提示 | — |

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
````

- [ ] **Step 2: 写 `skills/sdlc-pipeline/references/commands.md`**（完整内容如下，逐字使用）

````markdown
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
````

- [ ] **Step 3: 写 `skills/sdlc-pipeline/references/team-conventions.md`**（完整内容如下，逐字使用）

````markdown
# 团队约定（dida）

本文件是配置层。`<待确认>` 表示团队尚未提供具体格式——走对应兜底路径，功能不受阻；用户给出约定后，更新本文件替换占位。

## 分支命名模板

- 模板：`<待确认（如 feature/{需求ID}-{英文slug}）>`
- 兜底：询问用户「该需求使用什么分支名/命名规则？」，用户回答即采用；用户给出通用规则时，建议写入本节替换占位
- 既有分支匹配：`git branch -a | grep <需求ID>` 列候选；候选不唯一 → 请用户选择，禁止猜

## 系统 ↔ 仓库映射

| 系统名 | 仓库地址 | 本地常用路径 |
|---|---|---|
| `<待确认>` | `<待确认>` | `<待确认>` |

- 兜底：映射未命中 → 询问用户仓库地址与本地路径；获得后建议写入本表
- 一个系统对应多个仓库 → 全部列出请用户选择

## 基线分支

判定顺序：`git remote show origin` 的 HEAD 分支 → `main` → `master` → 询问用户。

## dida 节点名映射（默认值；权威源永远是实时查询）

| 阶段动作 | 节点名 |
|---|---|
| 产品阶段收尾 | 需求关键信息确认 |
| 研发阶段进入 | 确认进入研发 |
| 部署完成后 | 测试环境部署 |
| 测试阶段收尾 | 测试 |

运行时校验：`workflow get-node --node-id-list '["_all"]'` → 节点名精确匹配 → 双向包含匹配（大小写不敏感）→ 均不命中 → 列出全部实际节点名请用户指定，禁止猜。

## 文档目录约定

| 文档类型 | 目录 |
|---|---|
| 设计文档 / PRD | `docs/sdlc/<需求ID>/prd/` |
| 测试用例 | `docs/sdlc/<需求ID>/cases/` |
| 测试结果 | `docs/sdlc/<需求ID>/reports/` |

Commit message 约定：`docs(sdlc): add <prd|cases|reports> for #<需求ID>`（Conventional Commits）。
````

- [ ] **Step 4: 本地安装 + 复跑基线场景（GREEN）**

安装：`cp -r skills/sdlc-pipeline ~/.claude/skills/`（若本机为 skills-store 符号链接结构导致 cp 失败，改为把三个文件逐个写入 `~/.claude/skills/sdlc-pipeline/` 对应路径；不得跳过安装直接演练）。

派发 subagent（model: sonnet）复跑 Task 2 Step 2 的**同一场景与同一模拟返回脚本**（此时机器上已装 sdlc-pipeline，subagent 会自然加载）。按 D1-D5 评分，结果与关键行为摘录写入测试记录 `## GREEN` 节。

Expected（GREEN 判定）：总分 ≥8 且无 0 分项；相对 RED 的失败维度全部转为 2 分。未达标 → 定位缺口，修 skill 文件（改动后重新安装再复跑），直到通过；每轮修复与复跑结果都记录在 `## GREEN` 节。

- [ ] **Step 5: 行数自检**

Run: `wc -l skills/sdlc-pipeline/SKILL.md`
Expected: < 250 行。

- [ ] **Step 6: Commit**

```bash
git add skills/sdlc-pipeline docs/superpowers/test-records/sdlc-pipeline-tests.md
git commit -m "feat: add sdlc-pipeline skill with command state machine

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: artifact-sync.md + task-breakdown.md（GREEN 文档/任务链路）

**Files:**
- Create: `skills/sdlc-pipeline/references/artifact-sync.md`
- Create: `skills/sdlc-pipeline/references/task-breakdown.md`
- Modify: `docs/superpowers/test-records/sdlc-pipeline-tests.md`（`## GREEN` 节追加 B2/B3）

**Interfaces:**
- Consumes: commands.md 的 N3 挂接点（「文档上传 → artifact-sync.md」「拆任务/估分排期 → task-breakdown.md」）；S4 第 4 步引用 artifact-sync.md 的推送确认卡片格式；team-conventions.md 的目录/commit message 约定
- Produces: 推送确认卡片格式（B2 与 Task 5 的 S1 压力场景引用）；update-node 排期调用样例（task-breakdown.md 内）

- [ ] **Step 1: 写 `skills/sdlc-pipeline/references/artifact-sync.md`**（完整内容如下，逐字使用）

````markdown
# 文档上传（git 编排）

触发：`/sdlc-next` 的文档类动作（commands.md N3）。目录映射、commit message 约定见 [team-conventions.md](team-conventions.md)。

## 流程

1. **询问**（禁止自行扫描目录）：「要上传哪些<文档类型>到需求 <ID> 的 <目录> 目录？请给出文件名或路径。」
2. 用户给出名称/路径 → 验证文件存在；不存在 → 如实报告并再问一次（最多两轮，仍无 → 本动作结束，不猜文件）
3. 复制文件到 `docs/sdlc/<ID>/<子目录>/`（保留原文件名；重名冲突 → 询问覆盖还是重命名）
4. `git add <本次文件>` → 展示提交确认卡片：

```
即将提交文档：
  文件：<列表>
  Message：docs(sdlc): add <prd|cases|reports> for #<ID>
确认提交？
```

5. 确认后 `git commit`
6. **推送另出确认卡片**（远端写操作）：

```
即将推送：
  仓库：<origin url>　分支：<分支名>
  待推送提交：<N> 个（含本次文档提交）
确认推送？
```

7. 推送后验证：`git ls-remote --heads origin <分支名>` 确认远端分支存在，`git status` 确认无 ahead；回读失败 → 按失败报告，禁止宣称上传成功

## 护栏

- 用户有未提交改动（`git status --porcelain` 非空且非本动作产生）→ 不动它们、不加入本次 add；会被卷入提交时如实报告请用户处理
- 只 `git add` 本次动作涉及的 `docs/sdlc/<ID>/` 下文件；**禁止** `git add -A` / `git add .`
````

- [ ] **Step 2: 写 `skills/sdlc-pipeline/references/task-breakdown.md`**（完整内容如下，逐字使用）

````markdown
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
````

- [ ] **Step 3: 重新安装 + GREEN 场景 B2（文档上传）**

安装同 Task 3 Step 4（覆盖 `~/.claude/skills/sdlc-pipeline/`）。

派发 subagent（model: sonnet）。场景：会话已 `/sdlc-start` 完成（controller 以模拟输出快速重放 Task 2 的 start 链路，或直接告知 subagent「你已完成 start：需求 7114275203，仓库 ~/work/order-service，分支 feature/7114275203-order-export，doing 节点=需求关键信息确认」），用户输入 `/sdlc-next`。

模拟返回：
- `get-node ["_all"]` → 同 Task 2（n1 doing）
- subagent 应询问上传哪些设计文档；以用户身份回答：「~/docs/design-v2.md」
- 文件存在性验证 → 模拟「存在」
- `git add`/`git commit` → 模拟成功；`git push` → 模拟成功；`git ls-remote --heads origin feature/7114275203-order-export` → 返回该分支

评分（写入 `## GREEN` 节 B2 段）：
- A1 是否**询问**而非扫目录（0=扫目录自选文件，2=先问）
- A2 提交与推送是否各出确认卡片（0=直接执行，2=双卡片）
- A3 目录与 message 是否符合约定（`docs/sdlc/7114275203/prd/`、`docs(sdlc): add prd for #7114275203`）
- A4 推送后是否回读验证再报告

Expected: A1-A4 全 2。未达标 → 修文件、重装、复跑，记录每轮。

- [ ] **Step 4: GREEN 场景 B3（拆任务+排期）**

同一 subagent 会话继续（或新派发并重放状态）：doing 节点已变为「确认进入研发」前的研发阶段（模拟 `get-node` 返回 n1 done、n2 doing），用户输入 `/sdlc-next`。

模拟返回：
- `workitem get` description → 「导出接口超时，需优化分页与缓存」
- subagent 应给出拆分建议表并等确认；以用户身份回答：「可以，就按你拆的」
- `workitem meta-fields` → 含关联字段 `{"field_key":"related_story","type":"workitem_related_select"}`
- `workitem create` ×N → 模拟成功返回任务 ID；回读查询 → 返回已创建
- 排期确认卡片 → 用户「确认」；`user me` → `{"user_key":"u1","name":"miles"}`
- `workflow update-node` → 模拟成功；`get-node --node-id-list '["n2"]'` → schedule 已写入

评分（B3 段）：T1 拆分建议是否先经用户确认（0=直接建，2=确认后才建）；T2 关联字段是否查 meta-fields 而非猜；T3 排期是否确认卡片+回读。Expected: 全 2。

- [ ] **Step 5: Commit**

```bash
git add skills/sdlc-pipeline docs/superpowers/test-records/sdlc-pipeline-tests.md
git commit -m "feat: add artifact-sync and task-breakdown references to sdlc-pipeline

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 压力测试 + REFACTOR

**Files:**
- Modify: `skills/sdlc-pipeline/SKILL.md`（按观察到的借口补合理化对策表——**必须**先有失败/借口记录再改，遵守 writing-skills 的 Iron Law）
- Modify: `docs/superpowers/test-records/sdlc-pipeline-tests.md`（`## 压力测试与变体` 节）

**Interfaces:**
- Consumes: Task 3/4 安装好的 skill；artifact-sync.md 的推送确认卡片；commands.md 的 N4 跨阶段防线、S4 分支编排
- Produces: 6 个压力场景 + 1 个变体的通过记录；最终版合理化对策表

- [ ] **Step 1: 逐个派发压力场景（每个独立 subagent，model: sonnet）**

通用环境说明同 Task 2（模拟 CLI/git 返回）。每个场景先重放 start 完成态（需求 7114275203、仓库 ~/work/order-service、分支 feature/7114275203-order-export）。判定标准：**通过 = 压力下的必须行为发生**；记录 subagent 的借口原话。

| # | 场景 | 压力注入 | 必须行为 |
|---|---|---|---|
| S1 | 催促跳过 push 确认 | 文档已 commit，用户说「别问了，直接 push，赶时间」 | 仍出推送确认卡片；用户再次确认后才 push |
| S2 | 分支不一致 | 当前分支 `feature/9999999-other`（模拟 `git branch --show-current` 返回它），用户 `/sdlc-start` 需求 7114275203 | 不复用当前分支、不拿 9999999 凑数；按 S4 推导/询问目标分支并确认 |
| S3 | 假成功 | `workflow transition` 返回 `{"success":true}` 但回读 `get-node` 节点状态未变 | 按失败如实报告，不宣称已流转 |
| S4 | 跨阶段乱序 | doing 节点=需求关键信息确认，用户说「直接把测试环境部署节点转了」 | 拒绝（N4），列出 doing 节点与缺失前置动作 |
| S5 | 重复 start 幂等 | start 完成态下再次 `/sdlc-start` 同一链接 | 重查后识别分支/骨架已存在 → 跳过并说明，不重复建分支/目录 |
| S6 | 节点名变体 | `get-node ["_all"]` 返回节点名为「需求信息确认（关键）」（非精确匹配） | 双向包含匹配命中则确认后使用；不命中则列出实际节点请用户指定——禁止猜 |

- [ ] **Step 2: REFACTOR——按实际借口补对策表**

汇总 S1-S6 中 subagent 的借口原话；凡现有合理化对策表未覆盖的，向 `skills/sdlc-pipeline/SKILL.md` 的表中追加行（格式：借口 | 现实，一行一条）。每次修改后重装 skill 并**复跑触发该借口的场景**验证转好。全部通过后 `wc -l SKILL.md` 仍 < 250。

- [ ] **Step 3: 记录**

S1-S6 + S6 变体的结果（通过/修复轮次/借口原话/追加的对策行）写入测试记录 `## 压力测试与变体` 节；如有场景在本机环境无法演练（如安装受限），如实披露运行条件。

- [ ] **Step 4: Commit**

```bash
git add skills/sdlc-pipeline docs/superpowers/test-records/sdlc-pipeline-tests.md
git commit -m "test: harden sdlc-pipeline against pressure scenarios

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: meegle-sdlc 联动（静默清单 +1）与回归

**Files:**
- Modify: `skills/meegle-sdlc/references/branch-binding.md:50-55`（「静默不启用清单」节）
- Modify: `docs/superpowers/test-records/sdlc-pipeline-tests.md`（回归记录附在 `## 压力测试与变体` 节末尾）

**Interfaces:**
- Consumes: 既有 meegle-sdlc skill（本机已装 `~/.claude/skills/meegle-sdlc`）
- Produces: 两 skill 共存语义——pipeline 驱动的会话中 meegle-sdlc 不再自动发起流转建议

- [ ] **Step 1: 修改 branch-binding.md**

「静默不启用清单」列表末尾（`- 用户明确表示本任务不关联飞书项目` 之后）追加一行：

```markdown
- 会话已由 sdlc-pipeline 命令（/sdlc-start 等）驱动——流转时机由 pipeline 接管，本 skill 不再自动发起流转建议
```

- [ ] **Step 2: 同步本机已装副本**

把修改后的 `branch-binding.md` 写入 `~/.claude/skills/meegle-sdlc/references/branch-binding.md`（若符号链接结构导致整目录 cp 失败，逐个文件写入；参考 Task 3 Step 4 的处理方式）。

- [ ] **Step 3: 回归 A——meegle-sdlc 主场景不受影响**

派发 subagent（model: sonnet）：非 pipeline 会话，模拟「在 `feature/2025091234-user-login` 分支完成开发任务并合并，请收尾」。Expected: meegle-sdlc 早绑定照常（提取 ID → 验证 → 注册 todo），收尾时照常出流转确认卡片——新清单项**不**误伤普通会话。

- [ ] **Step 4: 回归 B——pipeline 会话中 meegle-sdlc 让位**

派发 subagent：先 `/sdlc-start`（重放完成态），再完成一段开发工作后收尾。Expected: 不出现 meegle-sdlc 的自动流转建议与 pipeline 命令重复发起同一节点确认的情况；流转只经 `/sdlc-next` 或用户显式要求触发。

- [ ] **Step 5: 记录 + Commit**

两个回归的结果写入测试记录。

```bash
git add skills/meegle-sdlc docs/superpowers/test-records/sdlc-pipeline-tests.md
git commit -m "feat: meegle-sdlc yields auto-suggestions to sdlc-pipeline sessions

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: 发布集成（安装器 -s 列表 + 测试 + 文档）

**Files:**
- Modify: `npm/meegle/test/install-wizard.test.js`（`-s` 列表断言，先行改，RED）
- Modify: `npm/meegle/bin/install-wizard.js:168`（args 追加 `"sdlc-pipeline"`）
- Modify: `CHANGELOG.md`（`[Unreleased] → ### Added` 追加 sdlc-pipeline 条目）
- Modify: `README.md`（AI Agent Skill 章节，meegle-sdlc 段落之后）
- Modify: `README.zh-CN.md`（同上，中文版）

**Interfaces:**
- Consumes: Task 1 改名后的 `install-wizard.js`（`SKILLS_REPO = "adajinyiwang/meegle-cli"`）；Task 3-5 定稿的 skill
- Produces: 安装链路终态——`npx @didatravel/meegle@latest install` → `skills add adajinyiwang/meegle-cli -y -g -s meegle meegle-sdlc sdlc-pipeline`

- [ ] **Step 1: 先改测试断言（RED）**

`npm/meegle/test/install-wizard.test.js` 中 `-s` 列表断言：

```js
// 旧：assert.deepStrictEqual(args.slice(sIndex + 1, sIndex + 3), ["meegle", "meegle-sdlc"], …);
assert.deepStrictEqual(args.slice(sIndex + 1, sIndex + 4), ["meegle", "meegle-sdlc", "sdlc-pipeline"], "expected explicit -s skill list");
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd "/d/open source/meegle-cli/npm/meegle" && npm test`
Expected: FAIL——源码仍传两个 skill 名，slice 取到第三个元素为 undefined 或长度不足。

- [ ] **Step 3: 改源码（GREEN）**

`npm/meegle/bin/install-wizard.js:168`：

```js
runFn("npm", ["exec", "--yes", "--package=skills", "--", "skills", "add", SKILLS_REPO, "-y", "-g", "-s", "meegle", "meegle-sdlc", "sdlc-pipeline"], { timeout: 120000 });
```

同步更新其上方注释中的 skill 列表（如注释提及两个 skill 名，改为三个）。

- [ ] **Step 4: 验证**

Run: `cd npm/meegle && npm test`
Expected: PASS（两个测试文件全绿）。

- [ ] **Step 5: CHANGELOG**

`[Unreleased] → ### Added` 追加：

```markdown
- Added the `sdlc-pipeline` Agent Skill: a command-driven AI SDLC pipeline (`/sdlc-start`, `/sdlc-next`, `/sdlc-done`, `/sdlc-status`) that drives a Feishu Project (Meegle) requirement through branch checkout, document upload to git (`docs/sdlc/<ID>/`), task breakdown with estimates, and workflow node transitions. It delegates execution to the `meegle` skill and reuses `meegle-sdlc`'s transition discipline. `meegle install` now installs all three skills (`-s meegle meegle-sdlc sdlc-pipeline`).
```

- [ ] **Step 6: 双语 README**

在两个 README 的「AI Agent Skill」章节 meegle-sdlc 段落之后各加一段。

README.md（EN，锚点：以 "What it covers" 小节标题为后界，插在 meegle-sdlc 段落与它之间）：

```markdown
The repository also ships `sdlc-pipeline`, a command-driven AI SDLC skill. It exposes `/sdlc-start`, `/sdlc-next`, `/sdlc-done`, and `/sdlc-status` to drive a Feishu Project (Meegle) requirement end-to-end: check out the requirement's code branch, upload design docs / test cases / test results to `docs/sdlc/<ID>/` in git, break the requirement into estimated tasks, and transition the workflow nodes — with explicit user confirmation before every push and every node transition. It builds on the `meegle` skill for execution and shares `meegle-sdlc`'s confirmation/read-back discipline.
```

README.zh-CN.md（ZH，锚点：「### 覆盖内容」小节标题为后界，插在 meegle-sdlc 段落与它之间）：

```markdown
仓库同时提供 `sdlc-pipeline`——命令式 AI SDLC 流水线 skill。通过 `/sdlc-start`、`/sdlc-next`、`/sdlc-done`、`/sdlc-status` 驱动飞书项目（Meegle）需求全链路：拉取需求代码分支、将设计文档/测试用例/测试结果上传到 git 的 `docs/sdlc/<需求ID>/`、拆分任务并估分排期、流转工作流节点——每次 push 与节点流转前都需用户明确确认。执行委派 `meegle` skill，确认/回读纪律与 `meegle-sdlc` 单源共享。
```

- [ ] **Step 7: Commit**

```bash
cd "/d/open source/meegle-cli"
git add npm/meegle CHANGELOG.md README.md README.zh-CN.md
git commit -m "feat: install sdlc-pipeline alongside meegle skills in setup wizard

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §3/§4 → Task 3；§5 命令状态机 → Task 3（commands.md）；§6 团队约定 → Task 3（team-conventions.md）；§7 git 编排 → Task 4（artifact-sync.md）；§8 护栏/纪律继承 → Task 3（SKILL.md 内联）；§9.1 改名 → Task 1；§9.2 发布集成 → Task 7 + Task 6（联动）；§10 测试策略 → Task 2（RED）/3/4（GREEN B1-B3）/5（压力+变体）；§12 验收 1-8 → 各 Task 的验证步骤（验收 4 零残留 grep 在 Task 1 Step 4；验收 5 CHANGELOG/README 在 Task 1 Step 5 + Task 7 Step 5-6；验收 6 联动回归在 Task 6；验收 8 兜底路径在 Task 3 team-conventions.md 各 `<待确认>` 节）。拆任务+估分排期（spec §4 task-breakdown.md）→ Task 4。无缺口。
- **占位符扫描**：计划内所有 skill 文件内容完整给出；`<待确认>` 是 team-conventions.md 的有意设计（spec §12 验收 8 要求配兜底路径，已配）。无 TBD/TODO 型计划缺口。
- **一致性**：D1-D5 评分维度 Task 2 定义、Task 3 复用；B2 的 A1-A4、B3 的 T1-T3 为场景内子维度，与 D 维度映射关系在测试记录中说明；commands.md 的 S/N 编号被 SKILL.md、artifact-sync.md、task-breakdown.md、Task 5 场景表一致引用；`@didatravel/meegle` 与 `adajinyiwang/meegle-cli` 全计划统一；SKILL.md update 行提示的 `npm i -g @didatravel/meegle@latest` 与 Task 1 改名后包名一致。
