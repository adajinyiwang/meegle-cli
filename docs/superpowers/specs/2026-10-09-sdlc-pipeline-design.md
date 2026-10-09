# sdlc-pipeline Skill 设计文档

- 日期：2026-10-09
- 状态：已与需求方对齐，待实现
- 来源需求：《V2.25 AI SDLC》（dida 团队 PRD，客户端侧范围）
- 关联：依赖 `skills/meegle/`（REQUIRED SUB-SKILL）与 `skills/meegle-sdlc/`（纪律单源引用），随 meegle-cli 一体化发布

## 1. 背景与目标

PRD《V2.25 AI SDLC》要求以 AI 命令驱动研发流水线：从飞书项目需求出发，完成「拉代码分支 → 上传设计文档/测试用例/测试结果到 git → 确认飞书固定节点 → 拆任务估分排期」的闭环（P0/1024 范围）。服务侧（dolphin 无人值守后端）明确不做，飞书 IM 推送由飞书自身自动化覆盖。

目标：新增 Agent Skill `sdlc-pipeline`——**命令式正向流水线**（需求 → 分支 → 文档 → 节点），与既有 `meegle-sdlc`（自动反向：分支 → 需求 → 流转建议）互补。载体为纯 SKILL.md 触发词形态（跨 agent 通用优先，不做 Claude Code 专属 slash command）。

## 2. 关键决策记录

| 决策点 | 结论 |
|---|---|
| 架构形态 | 方案 B：独立新 skill `sdlc-pipeline`；流转委派 meegle 的 `sop-transition-node`（2 层链路）；确认/回读/重试纪律**跨引用** `meegle-sdlc/references/transition-flow.md`（单源，不复制文本） |
| 载体 | 跨 agent 通用：命令（/sdlc-start 等）作为 SKILL.md 触发词，非 Claude Code slash command |
| 文档目录 | 集中式 `docs/sdlc/<需求ID>/{prd,cases,reports}/` |
| 分支/仓库映射 | 沿用团队既有约定；具体格式由 team-conventions.md 配置，spec 定稿前未提供则保留 `<待确认>` 占位，运行时走「询问用户」兜底路径，功能不受阻 |
| 节点映射 | dida 4 个固定节点名为默认值；权威源永远是运行时 `get-node ["_all"]` 实时查询 |
| update 命令 | 不进 skill——已由 update-notifier / skills CLI 幂等更新覆盖，SKILL.md 仅留一句指引 |
| 安装器策略 | 显式列表增为 `-s meegle meegle-sdlc sdlc-pipeline`（新 skill 显式过安装器评审） |
| 安装名更换 | **仅发布链路层**改名：npm 包 `@lark-project/meegle` → `@didatravel/meegle`；GitHub 仓库 `larksuite/meegle-cli` → `adajinyiwang/meegle-cli`（用户指定 https://github.com/adajinyiwang/meegle-cli.git）。Go module path（`github.com/larksuite/meegle-cli`）与 CLI 命令名 `meegle` **不动**——前者不影响链路通断，后者用户选择保留 |
| 与 meegle-sdlc 共存 | meegle-sdlc 的 branch-binding.md「静默不启用清单」加一条：会话已由 /sdlc-start 驱动时，自动流转建议让位给 pipeline 命令（防重复确认卡片；一行改动，需过其自身回归） |

## 3. 定位与依赖

薄编排层原则不变：只决定**何时、对哪个对象、做什么**，执行全部委派。

```
sdlc-pipeline（命令状态机 + git 编排 + dida 团队约定）
   ├─→ meegle skill：节点流转/字段/查询的执行 SOP（REQUIRED SUB-SKILL: references/sop-transition-node.md）
   ├─→ meegle-sdlc/references/transition-flow.md：确认卡片、回读、重试纪律（跨 skill 引用，单源）
   ├─→ meegle-sdlc/references/stage-mapping.md：阶段关键词表（角色阶段推断复用）
   └─→ agent 原生 git 能力：clone/fetch/checkout/add/commit/push
```

一体化安装保证三个 skill 同仓同版本共存，跨目录相对引用（`../meegle-sdlc/references/*.md`）可靠——与已接受的 STEP 3→4→5 编号耦合同类。

## 4. 目录结构

```
skills/sdlc-pipeline/
  SKILL.md                  # <250 行：SDO description（含命令触发词）、命令分派表、
                            #   状态机总览、护栏、合理化对策表、Red Flags
  references/
    commands.md             # 四命令详细流程（start/next/done/status）
    team-conventions.md     # 分支命名模板、系统↔仓库映射、dida 节点名映射、文档目录约定
    artifact-sync.md        # 三类文档上传 git 的编排
    task-breakdown.md       # 拆任务+估分排期（委派 sop-create-workitem + update-node）
```

按需加载：命令解析只读 commands.md；涉及约定才读 team-conventions.md；上传文档才读 artifact-sync.md；拆任务才读 task-breakdown.md。

### SKILL.md frontmatter（description 只写触发条件，遵循 SDO 规范）

```yaml
name: sdlc-pipeline
description: |
  AI SDLC 命令式研发流水线（飞书项目/Meegle，依赖 meegle 与 meegle-sdlc skill）。Use when the
  user issues /sdlc-start, /sdlc-next, /sdlc-done, or /sdlc-status (also written as sdlc start /
  next / done / status), or asks in natural language to 开启某个需求、进入下一步、完成需求、
  检查当前状态 in a Feishu Project (Meegle) driven development workflow. 关键词：SDLC、
  sdlc-start、研发流水线、需求开启、拉取分支、上传设计文档、测试用例、测试结果、拆任务、估分排期。
```

## 5. 命令状态机

角色阶段判定：优先按 doing 节点用 `meegle-sdlc/references/stage-mapping.md` 关键词表推断（跨 skill 复用），用户可显式覆盖。

| 命令 | 行为 |
|---|---|
| `/sdlc-start [链接\|ID]` | 带参：`url decode` / `workitem get` 验证 → 展示需求摘要卡片（ID/名称/空间/当前 doing 节点）。不带参：检查当前 git 状态（在仓库中？分支名含需求 ID？）→ 确认**新需求还是现有需求**（PRD #4 决议）；新 → 要求链接/编号。之后：按团队约定定位仓库与分支 → **询问确认后**拉取/创建分支 → 建 `docs/sdlc/<ID>/{prd,cases,reports}/` 骨架 → 登记会话状态 |
| `/sdlc-next` | 推进当前角色阶段的下一个未完成动作。**产品**：上传设计文档 → 流转【需求关键信息确认】；**研发**：拆任务+估分排期 →（编码，skill 不管）→ 流转【确认进入研发】→ 部署后流转【测试环境部署】；**测试**：上传用例 → 上传测试结果 → 【测试】节点估分排期 → 流转【测试】 |
| `/sdlc-done` | 收尾核对：重查飞书节点状态 + git 远端状态，列出已完成/未完成清单；有未完成项如实报告，不代跳 |
| `/sdlc-status` | 展示当前需求、所处阶段、动作完成度（每次**实时重查**飞书与 git，不依赖会话记忆） |

**幂等设计**：所有命令的动作完成度都从权威源（飞书 `get-node`、git 远端 `ls-remote`）实时判定——重复 start 不重复建分支；next 不重做已转节点（doing 节点已变，自然跳过）。

**PRD 需求清单覆盖映射**：#2/#8/#13 搜索需求、#3/#9/#14 选择需求 → start/next 的入口交互（`mywork todo` / `workitem query` 列候选）；#4 输入需求 → start 带参/无参双路径；#5 拉取代码 → start 分支编排；#6/#15/#16 上传三类文档 → artifact-sync；#7/#10/#12/#18 四节点确认 → next 委派流转；#11 拆任务 → task-breakdown；#17 测试排期 → next 测试阶段（update-node 估分排期字段）。#1 git 账号开通：PRD 标注本期不考虑。PRD 表格中服务端 dolphin 各行（表内序号与端侧 #16-18 重复，以「模块=服务侧」为准）：范围外。

## 6. 团队约定（team-conventions.md）

- **分支命名模板**：`<待确认，如 feature/{需求ID}-{slug}>`——按模板从需求 ID 推导分支名；推导/匹配不到 → 列候选问用户，**禁止猜**（继承 meegle-sdlc 护栏 1）。占位未填时 skill 直接走询问路径，功能不受阻。
- **系统↔仓库映射**：`<待确认>`（PRD：一对多）。默认策略：映射表命中 → 用之；未命中 → 询问用户并提示可写入映射表（本地文件，agent 维护）。
- **dida 节点名映射**（默认值，权威源为实时查询）：

  | 阶段 | 节点名 |
  |---|---|
  | 产品 | 需求关键信息确认 |
  | 研发 | 确认进入研发 |
  | 研发（部署后） | 测试环境部署 |
  | 测试 | 测试 |

  运行时用 `get-node ["_all"]` 校验实际存在（精确/包含匹配）；匹配不到 → 列实际节点请用户指定，禁止猜。
- **文档目录**：`docs/sdlc/<需求ID>/prd/`（设计文档）、`cases/`（测试用例）、`reports/`（测试结果）。

## 7. git 编排护栏（artifact-sync.md + commands.md）

- **远端写操作（push、建远端分支）前必须确认**：展示摘要卡片（仓库/分支/文件清单/commit message），确认后才执行——与流转确认同一纪律。
- commit message 遵循 Conventional Commits 且带需求 ID（如 `docs(sdlc): add PRD for #7114275203`）。
- 上传文档流程严格按 PRD 原文：**询问用户传哪些文档**，用户给名称/路径后才动（不自作主张扫目录）。
- 本地有未提交改动时不代为 stash/commit，如实报告请用户处理。
- push 后验证：`git ls-remote` 回读远端分支存在性——「如实报告」纪律延伸到 git 侧。

## 8. 护栏与纪律继承（SKILL.md 内联）

1. 流转纪律（确认卡片/回读/重试熔断/假成功防线）→ 遵循 `../meegle-sdlc/references/transition-flow.md`，**不复制文本**。
2. 禁止猜测四对象：需求、仓库、分支、节点——定位不到就问一次，仍无 → 停止。
3. git 远端写与节点流转同级：必须确认，无例外。
4. 每个命令会话内幂等，状态以实时重查为准。
5. 如实报告：push/流转返回 success ≠ 成功，回读为准；未变化按失败报告。
6. 合理化对策表 + Red Flags：延续 meegle-sdlc 的格式，RED 测试中按实际借口补充。

## 9. 发布集成（含安装名更换）

### 9.1 改名触点（仅发布链路层；旧值 → 新值）

| 位置 | 旧值 | 新值 |
|---|---|---|
| `npm/meegle/package.json`：name | `@lark-project/meegle` | `@didatravel/meegle` |
| `npm/meegle/package.json`：homepage / repository.url / bugs.url | `github.com/larksuite/meegle-cli…` | `github.com/adajinyiwang/meegle-cli…` |
| `npm/meegle/bin/install-wizard.js:8` `PKG` | `@lark-project/meegle` | `@didatravel/meegle` |
| `npm/meegle/bin/install-wizard.js:9` `SKILLS_REPO` | `larksuite/meegle-cli` | `adajinyiwang/meegle-cli` |
| `npm/meegle/bin/update-notifier.js`：`PKG`、`CHANGELOG_URL`、`CHANGELOG_RAW_URL` 及 4 处消息文案中的包名字面量 | `@lark-project/meegle`、`…/larksuite/meegle-cli/…` | `@didatravel/meegle`、`…/adajinyiwang/meegle-cli/…` |
| `npm/meegle/bin/meegle.js:37` 重装提示 | `npm i -g @lark-project/meegle` | `npm i -g @didatravel/meegle` |
| `npm/meegle/test/install-wizard.test.js:20` 断言 | `larksuite/meegle-cli` | `adajinyiwang/meegle-cli` |
| `npm/meegle/test/update-notifier.test.js`（如有包名/URL 断言） | 同上模式 | 同上模式 |
| `README.md` / `README.zh-CN.md`：npm 徽章、npx 命令（3 处/文件）、仓库链接 | 旧名 | 新名 |
| `THIRD_PARTY_NOTICES.md:3` 包名提及 | `@lark-project/meegle` | `@didatravel/meegle` |

**不改**：`go.mod` module path、Go import、`.golangci.yml`、CLI 命令名/二进制名 `meegle-*`、Makefile、CHANGELOG 历史条目（历史记录指向旧仓库属事实陈述，保留）。

前置条件（发布时由用户保证，不在实现范围）：npmjs 拥有 `didatravel` scope；`adajinyiwang/meegle-cli` 为公开仓库且含 `skills/` 目录（skills CLI 纯 HTTP 安装依赖）。

### 9.2 sdlc-pipeline 发布（与 meegle-sdlc 同构）

1. `skills/sdlc-pipeline/` 与现有 skills 平级，进仓库即进分发源。
2. `install-wizard.js`：`installAgentSkill()` 的 `-s` 列表增为 `meegle meegle-sdlc sdlc-pipeline`；`update-notifier.js` 共享函数自动继承；`install-wizard.test.js` 断言更新为三元素列表。
3. CHANGELOG `[Unreleased] → ### Added` 记 sdlc-pipeline 一条、`### Changed` 记改名一条；双语 README「AI Agent Skill」章节各补一段。
4. 版本跟随 CLI（`npm/meegle/package.json` 单一来源），无独立版本。
5. meegle-sdlc 联动改动：`skills/meegle-sdlc/references/branch-binding.md` 静默不启用清单 +1 条（见 §2）。

发布流程不变：PR → main → `make meegle-all` → npm publish（新包名首发需 `npm publish --access public`，scoped 包默认 private）。不触碰 Go 代码。

## 10. 测试策略（writing-skills 的 RED-GREEN-REFACTOR）

- **评分维度**：D1 需求定位（链接/ID → 验证 → 摘要卡片）、D2 git 确认（拉/建分支、push 前确认卡片）、D3 文档编排（询问 → 放对目录 → commit 规范）、D4 流转纪律（继承 meegle-sdlc 已验证的 C3/C4：确认卡片 + 回读）、D5 幂等/状态实时性（重复命令不重复动作）。
- **RED 基线**：装 meegle + meegle-sdlc 但**不装** sdlc-pipeline，subagent 收到「/sdlc-start https://project.feishu.cn/dida/ptproduct/detail/7114275203」，逐字记录自然行为。预期失败形态：不验证需求直接 clone / 不确认就 push / 忘了转节点 / 文档乱放 / 重复执行重复建分支。
- **GREEN**：装 skill 跑同场景，验证命令链路全通。
- **压力场景**（每个独立跑）：①用户催促跳过 git push 确认；②需求 ID 与当前分支不一致（猜的诱惑）；③流转假成功（success 但回读未变）；④next 跨阶段乱序（节点未到就想转后面节点）；⑤重复 /sdlc-start（幂等）；⑥dida 空间实际节点名与 PRD 变体不符。
- **安装器测试**：`npm test` 通过，断言含 `-s meegle meegle-sdlc sdlc-pipeline`。
- **运行条件**：延续 meegle-sdlc 演练总说明——模拟 CLI/git 返回，不真跑远端写操作。

## 11. 范围外（YAGNI）

dolphin 服务侧全部、飞书 IM 推送（飞书自身自动化覆盖）、git 账号开通（PRD 本期不考虑）、Claude Code 真 slash command 封装（跨 agent 优先，v2 候选）、状态流工作项、免确认全自动模式、多需求并行会话、产品/研发/测试之外的角色阶段。

## 12. 验收标准

1. `skills/sdlc-pipeline/` 五文件（SKILL.md + 4 references）结构符合 §4，SKILL.md < 250 行；
2. RED 基线记录在案，GREEN 与 6 个压力场景全部通过；
3. `npm test` 通过，安装器参数断言含三 skill 列表；
4. 改名触点（§9.1 表）全部替换完成，`npm/meegle/` 与双语 README 中 `grep larksuite/meegle-cli` 和 `grep @lark-project/meegle` 零命中（CHANGELOG 历史条目除外）；
5. CHANGELOG `[Unreleased]`、双语 README 已更新；
6. meegle-sdlc 联动一行改动完成且其自身回归通过；
7. 全流程不复制 meegle / meegle-sdlc 的执行细节与纪律文本，仅委派/跨引用；
8. team-conventions.md 中 `<待确认>` 占位处均有明确的「询问用户」兜底路径描述。
