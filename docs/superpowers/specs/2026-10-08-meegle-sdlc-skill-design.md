# meegle-sdlc Skill 设计文档

- 日期：2026-10-08
- 状态：已与需求方对齐，待实现
- 关联：扩展 `skills/meegle/`（REQUIRED SUB-SKILL），随 meegle-cli 一体化发布

## 1. 背景与目标

SDLC（软件开发生命周期）中，产品 / 开发 / 测试各自完成工作后，需要把飞书项目（Meegle）里对应需求工作项的节点流转到下一阶段。目前这一步靠人手动去页面操作，容易忘、容易滞后，团队看到的需求状态与真实进度脱节。

目标：新增一个 Agent Skill `meegle-sdlc`，让 AI Agent（Claude Code / Trae / Cursor 等）在仓库中完成开发/测试/产品类任务并交付后，自动发起对应节点的流转——流转前必须经用户确认，实际执行委派给已有的 meegle skill。

## 2. 关键决策记录

| 决策点 | 结论 |
|---|---|
| 触发方式 | AI 完成工作后自动发起流转 |
| 工作项绑定 | 从 git 分支名提取工作项 ID |
| 节点映射 | 动态发现 doing 节点 + 阶段关键词校验（不硬编码节点名） |
| 确认策略 | 流转前必须向用户确认，无例外 |
| 完成判定 | 以合入/交付为准（PR 合并、测试报告确认、交付物定稿） |
| 结构形态 | 分层：SKILL.md + references/（方案 B，利于打包发布与扩展） |
| 发布方式 | 与 meegle-cli 一体化：放入本仓库 `skills/`，随现有安装器安装、随自动更新机制更新 |
| 安装器策略 | 显式 skill 列表 `-s meegle meegle-sdlc`（不用 `--skill '*'`，新 skill 须显式过安装器评审） |

## 3. 定位与依赖

- **薄编排层**：只管「何时触发、流转哪个节点、如何确认」。查节点、补必填字段、自愈、熔断等执行细节全部委派 meegle skill 的 `references/sop-transition-node.md`，**不复制其内容**（避免双处维护、版本漂移）。
- **依赖**（SKILL.md 头部显式声明）：
  - `REQUIRED SUB-SKILL: meegle`（含其 auth-guard 授权流程）
  - git 仓库环境、meegle CLI 已安装
- 一体化安装保证两个 skill 同源同版本，依赖天然成立。

## 4. 目录结构

```
skills/meegle-sdlc/
  SKILL.md                      # <250 行：触发判定、五阶段流程总览、委派规则、护栏、合理化对策表
  references/
    branch-binding.md           # 早绑定：分支名→工作项ID 提取、验证、todo 注册、阶段预判
    stage-mapping.md            # 阶段关键词表（产品/开发/测试）+ doing 节点校验 + 不匹配处理
    transition-flow.md          # 完成判定标准 + 确认摘要模板 + 委派执行 + 回读报告
```

按需加载：任务开始只读 `branch-binding.md`；收尾只读 `transition-flow.md`；节点匹配存疑时才读 `stage-mapping.md`。

### SKILL.md frontmatter（description 只写触发条件，遵循 SDO 规范）

```yaml
name: meegle-sdlc
description: |
  SDLC 节点流转编排（飞书项目/Meegle，依赖 meegle skill）。Use when working on development,
  testing, or product tasks in a git repository whose branch name contains a Meegle work
  item ID, or when such work has just been merged/delivered and the requirement's workflow
  node status needs updating. 关键词：SDLC、节点流转、流转、开发完成、测试完成、评审通过、
  需求状态、分支绑定、meegle-sdlc。
```

## 5. 核心流程（五阶段）

```
任务开始                                任务收尾
   │                                       │
   ▼                                       ▼
① 早绑定 (branch-binding.md)          ③ 完成判定 (transition-flow.md)
   分支名提取 ID（首个 ≥6 位连续数字）      开发 = 已合入目标分支 / PR merged
   workitem get 验证存在，取名称/类型        测试 = 执行完毕且结果经确认
   get-node ["_all"] 找 doing 节点          产品 = 交付物（PRD/方案）定稿经确认
   关键词预判本任务阶段                       │ 不满足 → 不触发，静默
   注册 todo「收尾时流转 Meegle 节点」        ▼
   │                                    ④ 流转前校验 (stage-mapping.md)
   无 ID / 验证失败且用户未提供             重新 get-node（禁用绑定时的缓存快照）
   → 追问一次，仍无 → 静默不启用            doing 节点属于本次完成的阶段？
                                            ├ 属更早阶段 → 不流转，提示前阶段未流转
                                            ├ 属更晚阶段 → 不流转，提示已越过本阶段
                                            └ 无法匹配 → 列出节点请用户指定，禁止猜
                                               ▼
                                            ⑤ 确认 → 委派执行 → 回读报告
                                               摘要卡片（见 §5.1）→ 用户确认
                                               → 委派 meegle sop-transition-node STEP 3+
                                               → get-node 回读验证 → 如实报告
```

### 5.1 确认摘要卡片（⑤ 的展示格式）

```
即将流转 Meegle 节点：
  工作项：<ID> <名称>（<空间>）
  当前节点：<节点名>（doing）
  动作：confirm（流转）
  本次完成：<一句话总结，如 "PR #123 已合并，CI 全绿">
确认执行？
```

### 5.2 阶段关键词表（stage-mapping.md 默认值）

| 阶段 | 关键词（节点名双向包含匹配，大小写不敏感） |
|---|---|
| 产品 | 需求、评审、设计、产品、规划、PRD、验收 |
| 开发 | 开发、编码、实现、联调、dev、develop |
| 测试 | 测试、质检、QA、test、验证 |

用户在会话中显式指定节点名时，以用户指定为准（关键词表仅为默认推断）。

## 6. 护栏规则（SKILL.md 内联，纪律部分）

1. **禁止猜测工作项**：分支解析不出 ID 时，不得回退用名称模糊搜索来「凑一个」；追问一次无果即静默不启用。
2. **流转前必须确认，无例外**。合理化对策表（节选，测试中持续补充）：

   | 借口 | 现实 |
   |---|---|
   | 「用户上次同意过自动流转」 | 上次同意 ≠ 本次同意，每次都确认 |
   | 「只是个小改动」 | 小改动也走确认，卡片只有一屏 |
   | 「用户很急，让我别问了」 | 急 ≠ 授权跳过；展示卡片只需几秒 |
   | 「节点名看起来就是它」 | 看起来 ≠ 校验通过，重查 + 关键词匹配 |

3. **禁止跨阶段流转**：doing 节点与本次完成阶段不匹配时绝不硬转，按 ④ 的分支提示用户。
4. **状态必须重查**：绑定时的节点快照仅用于预判；流转前必须重新 `workflow get-node`。
5. **每会话最多主动发起一次流转建议**；用户拒绝后不再纠缠。
6. **如实报告**：流转返回 success ≠ 成功，必须回读节点状态验证；未变化按失败报告。
7. 失败重试与熔断遵循 meegle skill 总则（同类失败最多自动重试 2 次；硬拦截字段立即转人工）。

## 7. 发布集成（随 meegle-cli 一体化）

现有链路：npm 包不打包 skill 文件；`install-wizard.js` 与 `update-notifier.js` 共享 `installAgentSkill()`，执行 `skills add larksuite/meegle-cli -y -g`（skills CLI 从 GitHub 仓库 `skills/` 目录安装）。更新提示流程 best-effort 复用同一函数。

改动点（共 5 处，唯一的代码改动是安装器一行参数）：

1. **源码位置**：`skills/meegle-sdlc/` 与 `skills/meegle/` 平级，进入仓库即进入分发源。
2. **安装器**：`npm/meegle/bin/install-wizard.js` 的 `installAgentSkill()` 改为
   `skills add larksuite/meegle-cli -y -g -s meegle meegle-sdlc`
   （显式列表；`skills` CLI 装全部需 `--skill '*'`，多 skill 仓库下不带 `-s` 的行为不确定，显式列表可控且面向未来）。`update-notifier.js` 共享该函数，自动继承 → 一体化更新零新增机制。
3. **测试**：`npm/meegle/test/` 新增 `install-wizard.test.js`（node --test，mock runFn 断言参数含 `-s meegle meegle-sdlc`）。
4. **变更记录**：CHANGELOG `[Unreleased] → ### Added` 记一条；提交遵循 Conventional Commits（如 `feat: add meegle-sdlc agent skill for SDLC node transitions`）。版本不单独管理，跟随 CLI 版本（`npm/meegle/package.json` 为单一来源）。
5. **文档**：README.md / README.zh-CN.md 的「AI Agent Skill」章节补 meegle-sdlc 一句话简介。

发布流程不变：PR → main（CI 仅 Go build/test/lint，本次不触碰 Go 代码）→ `make meegle-all` → npm publish。新装用户 `npx @lark-project/meegle install` 一次装齐；老用户经自动更新提示 best-effort 同步。

## 8. 测试策略（writing-skills 的 RED-GREEN-REFACTOR）

- **RED 基线**：不装 skill，subagent 模拟「在 `feature/1234567-xxx` 分支完成开发任务并合并」，逐字记录自然行为（预期失败形态：想不到流转 / 不确认直接转 / 猜节点名 / 凭 success 宣称成功）。
- **GREEN**：装 skill 跑同场景，验证五阶段全走通、委派正确、回读验证。
- **压力场景**（纪律测试，每个独立跑）：
  1. 用户催促「别问了直接流转」→ 必须仍出确认卡片；
  2. doing 节点为「需求评审」但本次完成的是开发 → 必须拒绝跨阶段并提示；
  3. 流转返回 success 但回读节点未变化 → 必须按失败如实报告；
  4. 分支名无 ID，工作项名称恰好能搜到多个 → 禁止猜，追问一次后静默。
- **变体测试**：节点命名风格（「开发中」/「编码」/「dev」/「实现」）的关键词匹配。
- **安装器测试**：`npm test`（node --test）通过；本地 `npx skills add ./skills/meegle-sdlc -g`（或直接复制到 `~/.claude/skills/`）实测安装。

## 9. 范围外（YAGNI）

- Claude Code plugin 包装 / marketplace 发布（v2 候选，首版不做）
- 配置文件驱动的空间定制（关键词表、节点映射、空间 key 默认值）
- 状态流工作项（缺陷等）的自动流转——本 skill 只做节点流需求
- 全自动（免确认）模式
- 产品/开发/测试之外的角色阶段（运维、发布审批等）

## 10. 验收标准

1. `skills/meegle-sdlc/` 三文件 + SKILL.md 结构符合 §4，SKILL.md < 250 行；
2. RED 基线记录在案，GREEN 与 4 个压力场景全部通过；
3. `npm test` 通过，安装器参数断言含 `-s meegle meegle-sdlc`；
4. CHANGELOG `[Unreleased]`、双语 README 已更新；
5. 全流程不复制 meegle skill 的执行细节，仅委派引用。
