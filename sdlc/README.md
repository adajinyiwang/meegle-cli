# dida-sdlc

> **分发说明（meegle-cli 集成版）**：本目录随 `@didatravel-jinyi/meegle` npm 包分发。
> 安装/更新统一走 npm 机制：`npx -y @didatravel-jinyi/meegle@latest install` 向导铺设
> 6 个 `/sdlc-*` 薄入口与 `~/.sdlc/skill-core.md`，并全局安装 `sdlc` CLI（npm bin
> shim，替代 `~/bin/sdlc`）；更新 = `npm i -g @didatravel-jinyi/meegle@latest`。原
> `install.sh` 与 Codeup tag 分发仓模型已被替代，下文中相关描述仅存历史参考。

AI SDLC 协作客户端：**CLI + IDE 技能薄入口**，把产品/开发/测试之间的交接流程落到 Git 事实与飞书项目节点上。
产物流转用 Git 跟踪，阶段推进/任务同步由 AI 驱动的命令完成——「人」只做决策与确认。

```
版本 0.2.2 ｜ 数据契约 schema_version 5 ｜ Node ≥ 20 ｜ ESM 直发，无构建链
```

> **v0.2.0 架构转轨（D59，已落地）**：sdlc-core 服务端已删除，飞书对接改经
> **官方 meegle-cli**（以你本人的飞书 OAuth 凭据直达飞书，凭据由 meegle
> keychain 托管）；git/Codeup 操作全部走 git 工具，PR 走
> 「CLI 输出预填参数的创建链接 → 人工点击创建 → 链接回填」。数据契约
> schema_version 5（纯阶段比较 + 任务映射随 Git 共享）。apiclient/auth.js/
> `sdlc login` 已整体移除——0.1.0 升级用户注意：旧 `~/.sdlc/config` 凭据
> 字段会被静默忽略（无冲突）；已接入仓库的 `.sdlc/config.yaml` 需照
> `templates/config.yaml` 手工升到 schema 5（无自动迁移）。

## 它解决什么问题

跨角色交接（产品→开发→测试→合并）的三个耗时点，各对应一个机制：

| 耗时点 | 机制 |
|---|---|
| 对接靠反复口头沟通 | 产物模板化（PRD / brief / tasks / testcases / report），交接话术由 CLI 从事实生成 |
| 飞书项目要人手动推进 | 阶段推进、任务同步、PR 链接集中在一条 `handoff` 命令（写飞书经 meegle-cli 用你本人的凭据） |
| AI 说做了不等于真做了 | 所有写动作走 **plan/apply 两段式**：先只读预览出计划，用户确认后才执行；话术只陈述已核实事实 |

## 设计总览

三件套，单一分发单元：

```
┌────────────────────────── 你的机器 ──────────────────────────┐
│  IDE（Claude Code / Qoder）                                    │
│    └─ 薄入口 SKILL.md（触发词 → 转述计划 → 传达确认）            │
│         └─ ~/.sdlc/skill-core.md（共享协作规则，update 维护）    │
│  终端 sdlc（~/bin/sdlc shim → 本仓库 cli/bin/sdlc.js）          │
│    └─ 唯一写通道：plan → 用户确认 → apply → 事实留痕            │
│         ├─ git 子进程 → Codeup（commit/push；PR 走预填链接人工创建）
│         └─ meegle-cli 子进程（官方，飞书项目）                    │
│              └─ 你本人的飞书 OAuth 凭据，meegle keychain 托管    │
└──────────────┬───────────────────────────────────────────────┘
               │
        飞书项目（需求/节点/子任务）——飞书原生权限即授权边界
        ＋ Git 远端（分支；PR 人工创建/合并）
```

- **CLI 是唯一写通道**：AI 与人都不直接调 API、不手改流程文件；`journal.jsonl`/`meta.yaml` 由 CLI 独占写入。
- **薄入口不含规则**：IDE 侧只有几行指针，规则集中在 skill-core.md，版本随 CLI 一起分发升级。
- **外部事实是权威**（meegle 回读的飞书节点/子任务/终态 + 远端 Git）：阶段推进、任务完成以远端回读为准；本地档案是展示缓存。

## 安装

前置：git、Node ≥ 20、bash（Windows 用户：Git Bash，装 Git 自带——安装脚本在 bash 里跑）。
前置 **meegle-cli**（飞书官方 CLI，安装链自动代跑，host 锁定 `project.feishu.cn`；首次安装会弹一次浏览器飞书授权——这是唯一无法避免的弹窗）。

```bash
npm i -g @didatravel-jinyi/meegle@latest
meegle install --host project.feishu.cn   # 向导：CLI 全局装 + 6 个薄入口 + skill-core + 登录
```

> master 为受保护主分支（版本经 feat 分支评审合入后可用）。评审合入前请加
> `-b feat/v0.2.2` 克隆特性分支。

Windows 下安装会同时生成 `sdlc.cmd` 并自动把用户 bin 目录配进用户 Path——
装完 cmd / PowerShell 原生可用（重开终端生效），无需 Git Bash。

安装脚本只写用户级位置（预览后确认才动手）：

| 写入位置 | 内容 |
|---|---|
| `~/.sdlc/skill-core.md` | 共享协作规则（固定锚点，`sdlc update` 维护） |
| `~/bin/sdlc` | shim，exec 本仓库 `cli/bin/sdlc.js` |
| `~/.claude/skills/sdlc/SKILL.md` | Claude Code 薄入口（qoder 为手动放置 `entries/qoder/AGENT.md`，机制以 M1 实测为准） |
| `~/.sdlc/config` | 只记录 tool；不存任何凭据/地址（认证由 meegle keychain 自管） |

装完自检：`sdlc doctor`（环境/安装/meegle 认证态/薄入口核验；meegle 未装/未登录标「未核实」不算失败）。
若提示 `~/bin` 不在 PATH，把它加进 shell 配置后重开终端（Windows 的 cmd/PowerShell Path 由安装脚本自动配置）。

> 从本仓库开发目录直接跑 `install.sh` 属**开发安装**（无独立 Git 根），`sdlc update` 会拒绝自更新并提示重装——这是预期行为。

## 两种使用形态：IDE 对话为主，终端为辅

**日常在 Claude Code 对话框里工作**——6 个斜杠命令或自然语言等价（`/sdlc-start`、用户说「接需求」都行）：

| 斜杠 | 用途 | 自然语言示例 |
|---|---|---|
| `/sdlc-init` | 仓库接入（维护者） | 「接入这个仓库」 |
| `/sdlc-start` | 进入/绑定/恢复需求 | 「接需求 7220318456」「继续 7220318456」 |
| `/sdlc-next` | 保存 / 交接 / 回退 | 「保存一下」「开发完成提测」「打回开发」 |
| `/sdlc-done` | 收尾（归档/核验） | 「需求收尾」 |
| `/sdlc-status` | 现状与话术（只读） | 「现在什么情况」 |
| `/sdlc-update` | 工具更新/自检 | 「更新 sdlc」「工具出问题了」 |

对话中**命令对用户透明**：agent 用自然语言转述计划（如「创建需求分支并绑定」），
你回复「继续」即由它执行；命令行与 plan_id 只在明确要技术细节时出现。登录无需手动
（需要飞书时命令转出授权链接，浏览器弹飞书登录——无法避免的唯一弹窗，完成后自动续跑原命令）。

终端 CLI 与斜杠命令同名同义，适合速查（`sdlc status`）与脚本化——下面 5 分钟上手
以终端形态展示全流程，IDE 对话里说对应自然语言即可走同一条链。

## 5 分钟上手

正式模式直达飞书项目（经你本人的 meegle 凭据；首次命令会转出浏览器飞书授权链接，
授权一次后自动续跑）。拿一个真实需求体验（建议先用自己的测试需求）：

```bash
# 1) 仓库接入（写 .sdlc/ 轻配置 + 产物模板；维护者做一次）
sdlc init --apply

# 2) 绑定需求（飞书需求 URL 或 id；预览绑定计划 → 按输出「确认执行」行复制 --apply <plan_id>）
sdlc start 7220318456

# 3) 写点产物后保存（commit→push→发布记录；本地已勾完成的任务自动同步勾远端）
sdlc next                      # 预览 → --apply <plan_id>

# 4) 提测交接（任务同步 + PR + 阶段推进一气呵成）
sdlc next --intent handoff     # → --apply，按提示 --tasks 勾任务

# 5) 看现状 / 收尾
sdlc status                    # 阶段、DoD 缺口、PR、待合并提示
sdlc done                      # 归档准备 → 待人工合并 → 合并后核验收尾
```

体验前可先 `sdlc doctor` 核对 meegle 认证态（未登录会给授权链接，授权一次即可）。

体感三个设计点：每步都有**预览→确认行**而非直接改；话术保持**否决语义**（「待人工合并」而非「已完成」）；同一 `--apply` 命令**重贴一遍全部幂等跳过**。

## 命令参考

流程四命令 + 维护三命令（`sdlc --help` 同步维护）：

| 命令 | 用途 | 常用形态 |
|---|---|---|
| `sdlc start [<URL\|id>]` | 进入需求：无参恢复现场；带参绑定（分支/档案/飞书回显，先 plan 再 apply）；接手时发现上游交接但节点未推进会建议兜底推进 | `sdlc start 7220318456 --apply <plan_id>` |
| `sdlc next [<req_id>]` | 保存 / 交接 / 回退 | `--intent save`（缺省）：commit→push→发布记录<br>`--intent handoff`：任务同步→PR→阶段推进→话术<br>`--request-change "<说明>" [--to <stage>]`：显式回退（说明留痕） |
| `sdlc status [<req_id>]` | 只读快照：阶段、DoD 缺口、PR 状态、可转交话术（按 req_id 可定位已归档需求） | `sdlc status --json` |
| `sdlc done [<req_id>]` | 两段收尾：第一段归档准备（目录移动+提交，PR open 时停「待人工合并」）；第二段核验 PR 合并（人工确认/回读）后记录终态 | `--accept-gaps` 接受已知缺口；`--manual-confirm pr_merged` 人工确认未核实项 |
| `sdlc init` | 仓库接入（写 `.sdlc/` 轻配置+模板） | `sdlc init --apply` |
| `sdlc update` | 分发自更新：fetch tags → 计划 → `--apply` checkout tag 原子切换 → 重铺薄入口 → 自检（失败自动回滚） | `--to <旧tag>` 降级；`--tool claude\|qoder`；`--force` 覆盖自定义入口 |
| `sdlc doctor` | 环境自检（meegle 认证态/安装/薄入口核验）。无 login 命令——认证由 meegle 托管，凭据缺失时命令自动发起登录交接（授权链接转浏览器，完成后自动续跑原命令） | |

apply 阶段通用 flags：`--message <subject>`（只传主题，type/scope 由 CLI 拼）、`--files <p,...>`（收窄范围）、
`--tasks <id,...>`（勾计划内任务候选）、`--to <stage>`（选计划内转移候选）、`--no-<action>`（跳过计划内动作并留痕）、
`--accept-gaps` / `--accept-diffs` / `--manual-confirm <check,...>`。

退出码：`0` 正常 ｜ `1` 参数·授权·状态冲突 ｜ `2` 外部（飞书/Git 远端）失败 ｜ `3` schema 不符。

## 工作流全景

一个需求的一生（阶段即飞书节点，推进走 meegle-cli——你本人的凭据）：

```
 产品 PRD ──handoff──> 开发(dev) ──handoff──> 测试(test) ──done──> 归档 ──人工合并──> 完成
 product/               dev/                  test/                .sdlc/archive/
   prd.md                tasks.md               testcases.md
   (brief.md)            brief.md               report.md
      │                     │                     │
      └──────────── :change 回退（测试打回，说明留痕）──────────┘
```

- 同一需求**同一分支、同一张 PR**：save 不出 PR；提测时 CLI 输出预填参数的 MR 创建链接，**人工点击创建**后把链接回填对话（`pr_ref` 随分支共享）；review 返工推原分支。
- `done` 归档用 `git mv` 移入 `.sdlc/archive/<YYYY-MM>-req-<id>`，提交推回原 PR——不另开归档 PR。
- PR 合并是**人工动作**：CLI 不创建也不代合并，合并后经人工确认（`--manual-confirm pr_merged`）或飞书终态核验收尾，不伪称已合并。
- 中断恢复：外部动作（任务/推进/收尾）先回读远端事实再决定续做（meegle 幂等门——已在目标节点则幂等重放，未知不盲重发）；同一 `--apply` 重跑幂等。

## 目录与代码结构

```
dida-sdlc/
├── install.sh              安装脚本（预览→确认→铺设→自检）
├── skill-core.md           AI 协作手册（触发映射/plan/apply/写作范围/安全边界）
├── VERSION                 当前版本（0.2.2）
├── cli/
│   ├── bin/sdlc.js         进程入口
│   └── src/
│       ├── main.js         命令分发、flag 解析、退出码出口、自动登录重跑
│       ├── errors.js       SdlcError 域 + 退出码映射（0/1/2/3）
│       ├── config.js       用户级 ~/.sdlc/config 与仓库级 .sdlc/config.yaml、DoD 配置读取
│       ├── gitops.js       git 子进程封装（commit/push/branch/…）
│       ├── journal.js      journal.jsonl 事件写入（v5 契约：幂等、append-only）
│       ├── meta.js         meta.yaml 需求档案（阶段/timeline/PR 引用/任务映射）
│       ├── tasks.js        tasks.md 粗任务块解析（yaml fence 块）
│       ├── plan.js         计划状态指纹（plan_id）与存档 ~/.sdlc/plans/
│       ├── execution.js    执行恢复（动作幂等裁决、外部动作回读）
│       ├── dist.js         分发根定位（update 用）
│       ├── meegle/         meegle-cli 适配层四件（D59，替代 apiclient）：
│       │   runner.js       子进程通道（信封解析/错误域映射/登录交接）
│       │   real.js         真实通道（meegle 命令 ↔ core 方法面）
│       │   mock.js         mock 轨（文件 db + 幂等门 + 故障注入）
│       │   index.js        统一出口（SDLC_MOCK=1 显式切 mock）
│       └── command/        命令实现
│           init/start/status/next/save+handoff/change/done/update/doctor
│           common.js       统一动作引擎（runActions：save/handoff/change/done 共用动作循环）
├── entries/                IDE 薄入口
│   ├── claude/SKILL.md     （安装时铺设到 ~/.claude/skills/sdlc/）
│   └── qoder/AGENT.md      （手动放置）
├── templates/              产物模板：config.yaml/prd/brief/tasks/testcases/report
├── docs/plan.md            迭代计划与进度（I1–I5 交付范围）
├── docs/user-guide.md      用户使用说明（对话口径用户故事——发给使用者，无命令行）
└── test/                   node:test，真实临时 git 仓集成链
```

代码约定：ESM + JSDoc 直发（源码即分发物）；`js-yaml` 为唯一 vendor 依赖（`cli/vendor/`）；
无构建链、无运行时依赖安装步骤。

## 核心机制速览

- **plan/apply 协议**：任何写命令先只读预览，输出含 `plan_id` 的确认行；`--apply <plan_id>` 才执行。
  计划带状态指纹（HEAD/文件摘要/配置版本/阶段版本），apply 时核对——防夹带、防过期。
- **统一动作引擎**（`command/common.js`）：sync → commit → push → 外部动作（任务/PR/推进/收尾）→
  meta/journal → publish 的标准循环；`--no-<action>` 留痕跳过，恢复按动作幂等裁决续做。
- **分发更新**：分发仓库 = 本仓库的 tag 快照；`sdlc update` 在安装目录内 `git checkout --detach <tag>`
  原子切换后重铺用户级文件，自检（新版 CLI 可启动 + tag 就位）失败自动回滚，不允许半新半旧。

## 扩展与维护

**改代码 / 加命令**

1. 新建 `cli/src/command/<cmd>.js` 导出 `run<Cmd>(positional, flags)`；
2. `main.js` 加 import、switch 分支、USAGE 行（值型 flag 进 `VALUE_FLAGS`）；
3. 复杂写动作优先复用 `common.js` 的 `runActions`（幂等/恢复/--no-* 白拿）；
4. `test/<cmd>.test.js` 加用例（参考 `test/update.test.js` 的临时仓隔离模式），`node --test test/` 全绿。

**改 meegle 命令映射**

飞书对接的唯一真源是主仓 `prd/dida-sdlc/docs/meegle-contract.md`——契约先行：改映射先改契约并在决策日志留痕，
再动实现（适配层在 `cli/src/meegle/`）。meegle 输出形状变化（升级破坏解析）也走该流程。

**版本与发布（双仓模型）**

- 开发历史在 Dolphin 主仓（`dida-sdlc/` 为普通目录，改动随主仓 diff 审查）；
- 本仓库（Codeup）是面向使用者的**只读分发仓**：版本快照 + tag；
- 发布 = 从主仓导出 `dida-sdlc/` 快照 → 本仓库 feat 分支 commit → 打 `v<VERSION>` tag
  → push，经评审合入 master（受保护，不接受直接推送）；
  使用者侧 `sdlc update` 即可拿到新版（fetch tags → 计划 → 确认切换）。
- 版本号改 `VERSION` 文件（package.json 同步），tag 格式 `v0.x.y`。

**升级协议时**：`schema_version` 递增；CLI 遇到不支持的版本提示 `sdlc update`，不静默猜测。

## 当前边界与路线

- **架构转轨（D59，v0.2.0 已落地）**：sdlc-core 删除，飞书对接改经官方 meegle-cli（用户本人凭据、飞书原生权限），PR 走预填链接人工创建，登录链退役。真实 meegle 实测以 M1 清单 #28–#35 逐项验证（运行时进行中）——mock 轨结论不作为已验证。
- **双 IDE M1 实测**：Qoder 薄入口机制待实测后固化（当前手动放置 AGENT.md）。
- 暂不做（P1/P2）：Codex 支持、IM 卡片推送、需求搜索与自动 clone、archive 返工恢复链。

详见 `docs/plan.md`（迭代计划与交付边界）。方案与契约文档由 dolphin 团队内部维护。
