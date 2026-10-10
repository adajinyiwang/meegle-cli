# dida-sdlc 客户端迭代计划

方案真源在主仓 `prd/dida-sdlc/`（本目录只做实现，不复制方案语义；方案级决策回主仓
`prd/dida-sdlc/docs/decisions.md` 维护，D49：单一真源）。本文件维护客户端实现的
迭代切分与进度。

## 仓库形态（2026-09-28 调整）

`dida-sdlc/` 是 Dolphin 主仓内的普通目录（无嵌套 .git，改动随主仓 diff 可见）。
后续分发（D53）时同步到独立 Codeup 分发仓库（双仓同步：Dolphin 仓管开发历史，
分发仓库管面向使用者的只读版本/tag）——分发同步机制在 I5 落地（update 分发随
真实联调同批，I4 范围调整）。

## 当前状态

- **I1（已完成）**：纵向薄切片——安装 → 仓库接入 → start 恢复/绑定（mock）跑通
- **I2（已完成，2026-09-29）**：next save 全链 + plan/apply 完整协议（详见下节）
- **I3（已完成，2026-09-29）**：next handoff 全链 + 任务同步/PR/advance（mock）+
  status 深化 + DoD 真实化（详见下节）
- **I4（已完成，2026-09-29）**：done 两段收尾（归档/提前合并/complete 核验）+
  `:change` 回退 + start 兜底推进（D48）+ remind_merge——流程闭环（详见下节）
- **I5（编码完成，2026-09-29）**：update 分发自更新 + doctor 薄入口核验——
  编码面收口；双 IDE 实测/真实联调/建分发仓库为运行时动作（详见下节）
- **I6（编码完成，2026-10-08，D59 架构转轨）**：meegle-cli 替代 sdlc-core——
  meegle 适配层（runner 信封/错误域/登录交接）替代 apiclient、登录链退役
  （auth.js/login/config 凭据删除，认证移交 meegle keychain）、install 代跑
  meegle、schema 5 全量（tasks_map/纯阶段比较/PR 人工路径）、测试基线迁移
  meegle 轨（详见下节；真实 meegle 实测为 M1 #28–#35 运行时动作）
- **体验反馈批 R1（2026-10-08，用户 feat/v0.1.0 实测反馈）**：① Windows 原生
  支持——install/update 生成 `sdlc.cmd`（cmd/PowerShell 不执行 bash 脚本）+
  用户 Path 自动配置（PowerShell SetEnvironmentVariable 幂等追加）；② 薄入口
  拆 6 个独立 skill（`/sdlc-init|start|next|done|status|update` 斜杠直达，
  login 不单出 D57）——install 循环铺设 + 旧单入口迁移清理，update layoutTargets
  /doctor 核验按 6 skill 粒度（`dist.js CLAUDE_ENTRY_SKILLS`）；③ start 绑定前
  脏工作区拦截（防夹带：脏产物不带进新需求分支，提示先保存/处理）；④ skill-core
  新增 §0 对话输出规范——命令与 plan_id 对用户透明（agent 转述自然语言动作、
  用户对话确认后由 agent 执行 apply）、输出简洁精准无语气词。115 用例全绿；
  Windows 本机冒烟：PowerShell `sdlc --version` 直跑 ✓、6 skills 被发现 ✓
- **体验反馈批 R2（2026-10-08，用户 D:\DidaCoreControl\Dolphin_V2_Test 接真实
  meegle 实测反馈，六条）**：① dida 节点预设——config.yaml 直填
  `project_key: dida` + story/tech 双 profile（产研/公共技术类需求两链实测预设，
  动态开发节点 `*开发` 名称模式匹配，变更时用户经 meegle 查不到节点后自行更新；
  删 delivery_flow/stage_timestamp/participants 无引用段）；② meegle 安装授权
  一步到位——`ensureMeegleReady`（未装代装 npx / 未登录 handshake）挂 init/update
  尾段（失败不阻塞本地接入）+ 登录链修复（`auth login --phase init --device-code`
  v1.0.23 实测形状直出 JSON，`verification_uri_complete` 直达链接 + 自动开浏览器
  `openBrowser`，poll `--phase poll --device-code-value --client-id --once`）；③
  skill-core 效率优先段（R2）——流程动作一次 plan 集中、失败即停转述不加循环、
  git bash 优先执行；④ 轮次根因修复——subtask update 实测参数修正
  （`--action`/`--node-id` 模板节点 + `--task-id` 任务 id + create 标题走
  `--fields [{field_key:name}]`）、性能单次回读（splitTasks/checkTasks N×3 spawn
  → 1 次回读；requirementState 3 串行 → 2 并行）；⑤ D48 v2 时序——advance 追赶
  推进不勾入口任务，勾选挪 tasks_split 尾段（进入阶段且需求子任务已创建后，
  common.js 层 + not_found 容错）；飞书节点流转触发原生通知节点负责人（无需
  另行通知）；⑥ advanceTo 追赶语义（ensure-式连续 confirm 到目标落位，他人已
  推进/超目标幂等；必填缺失懒查 `list-state-required` 停下转述不代填）。
  124 用例全绿（meegle.test.js real 通道假命令链 workflow/workitem/subtask +
  登录链回归）；真实 dida 项目 deep-water（7130936375 之外的写操作）仍属运行时
  动作，本批不触真实需求写操作
- **体验反馈批 R3（2026-10-09，用户两个实例需求实测反馈：story 7131581708 /
  tech 7130685632，sidecar 提速定位）**：① 预设校准——story 入口任务实为
  「确认进入研发」（原预设「确认进入开发」按标题勾不中）；tech 链实测含
  技术评审/Code Review/测试节点，test 映射 state_3 → state_54（真测试节点；
  中间节点追赶语义下无需逐一映射）+ tech dev 补 entry_tasks；② **--auto 直通
  （sidecar 白名单，D39 例外）**——`next --intent save|handoff --auto` 预览即
  执行（save/advance/tasks_split 三类低风险可回转动作免确认），绑定/归档/
  回退/PR 回填保留 plan 确认路径（--auto 与 --apply/--request-change/--pr-url
  互斥；有未完成执行不自动叠新执行转人工续做）；③ skill 薄化——skill-core
  §2 效率段升级决策表（「用户说 X → 直接跑 Y --auto」查表执行不推理）、
  §3.1 直通例外、sdlc-next SKILL.md 同步「用户意图即确认」口径；④ 效率归因
  结论：慢在 agent 思考轮次（主）不在 meegle spawn（实测单次 ~1.0s，无
  batch/长驻机制）——正解是决策表直查 + 免确认直通，不是派轻量子代理（上下
  文复制开销负收益）。126 用例全绿（next.test.js +3：save 直通全链/handoff
  直通 mock 全链/互斥校验）
- **体验反馈批 R4（2026-10-09，细节三条）**：① 创建子任务自动设负责人/排期/
  估分——splitTasks lazy 取 `user me` 缓存一次（失败不阻塞创建）+ estimate>0
  时 `--assignee "[me]"` + `--schedule {estimate_start_date:今日ms,
  estimate_end_date:+估分人天ms}`（R4 实测键名/毫秒形状）+ 估分字段
  `feishu.estimate_field_key` 可配默认 points（实测 create 场景值落地不稳定、
  候选字段名被适用范围拒——键名留配置口）；tasks.js 解析 estimate（正数校验，
  无/非法不带键）+ 模板示例；② save 同步勾选本地已完成任务——tasks.md 在保存
  范围且解析出 completed → 计划加 tasks_check（args.completions 直传 id/title/
  remote_id）；零预读远端，apply 时 checkTasks 单次回读幂等裁决（open→勾/已
  完成→no_op/无→not_found——防夹带由实时回读保证，common.js completions 分支
  不经 --tasks 候选）；③ README 去 mock 模式（「5 分钟上手」换正式模式口径
  （真仓真需求），机制速览删 mock 行；代码 mock 轨保留为测试基建）+ 新建
  `docs/user-guide.md` 用户使用说明（对话口径用户故事：各阶段「对 Claude Code
  说什么 → 发生什么」，不涉命令行——发给使用者）。129 用例全绿（meegle
  splitTasks +2 断言例：assignee/schedule/estimate 字段形状；next save
  tasks_check +1：脏 tasks.md completed → 动作 + mock db 勾选 + task_synced
  事件；freshReal 清理 FAKE_MEEGLE_MODE 残留——user me 静默失败根因）
- **全链实测批 R4b（2026-10-09，story 7131581708 / tech 7131703974 双需求推进
  驱动，7 修 + 3 配置）**：① handoff tasks_split args 补 estimate/state——
  estimate 驱动自动排期/估分（原只传 id/title/assignee_role，R4① 的 estimate 在
  handoff 路径丢失）；② 本地 completed 的新任务创建后即勾选（common.js
  tasks_split 内 checkTasks 续勾——快速推进一轮到位，原来创建→再操作勾选两轮）；
  ③ findUnfinishedExecutions 语义：failed=已结论不拦新执行（拦的只是崩溃中断
  ——ok 后无结果；否则失败 execution 永久悬着拦 --auto）；④ node_key 数组映射
  （同阶段多节点：tech prd=[started,state_56 技术评审]、dev=[*开发,state_62
  Code Review]——中间节点 doing 无映射 → current null → 一致性校验误拦）；
  ⑤ handoff 预览 current null 全放行（追赶路径中间节点/待认领态交 advance 裁决，
  到不了目标如实报错）；⑥ advanceTo 入口任务勾选后异步落位等待（勾选→节点转
  doing 有服务端延迟，轮询 3×2s——原即时重查误报「无进行中节点」）；⑦
  requirementState 暴露 doingNode（real/mock 对齐）。**BQL 语义实测破译**：
  ErrBQLConditionForTransNodeNotMet 主因=节点下子任务未全完成或节点完成结论
  （node_finished_conclusion select：评审/CR=已通过、部署=已部署——值域不同）
  未填；ErrScheduleRequired/ErrPointCheck=按人估分排期（--schedules，值=子任务
  估分总和）。结论填对即触发流转（多数节点），owner 必填受可选范围限制（测试
  账号不在平台工程组——story 7131581708 dev→test 由此待用户侧动作）。两条真实
  链验证：tech 链 prd→dev→test 全通（tasks_split 3 创建+completed 即勾+入口任务
  +MR 链接+追赶推进+发布）；story 链 prd→dev 全通、dev→test 卡 owner。模板
  config.yaml tech 档案同步数组映射。132 用例全绿（meegle +2：story 激活/
  数组映射；next +1：tasks_split completed 即勾）
- **实测批 R4c（2026-10-09，新业务线双需求 7131432757 tech / 7131600756
  story2 推进驱动——上一轮空跑 1 小时+的问题全部自动化）**：① **autoFill
  流转必填自动补齐**（real.js——上轮手工摸索的卡点全部内置）：结论（字段名含
  conclusion 即结论类，值按节点名启发式从 meta-node-fields 动态选项集按名取
  id；`owners_node_finished_conclusion` 多负责人变体走 `owners_finished_info`
  复合字段按人分桶通道——field_value 须序列化为 JSON 字符串，直写子字段名不
  落地）/按人估分排期/子任务勾选（owner 空或含本人代勾，他人任务停转述）/
  **需求实体级 form_items**（字段 key 随流程模板不同不可写死——date 类走
  `workitem update --fields` 补默认值今日+7天，select 类试探报错正则提取
  field_name 转述如「是否需要配置告警及监控机制 field_0c456c」）补齐后自动
  重试流转；② **cur 必填全满足仍被拒时前置探查未开始节点**（BQL 条件可在
  后续节点——story2 state_9 流转拒因 state_10 结论未填；future 模式只补
  结论/form_items/owner 转述，不代填估分不代勾未来节点任务，每节点只探一次）；
  ③ 可查必填全满足仍被拒——**先怀疑结论值不在该节点选项集（无效值，见
  归因修正段）**，候选轮换穷尽后仍拒才考虑模板自定义 BQL 流转条件（迭代
  归属、工时等 CLI 不可枚举），转述口径升级为可操作提示；④ **profileByTable 节点集自适应**（同 work_item_type_key
  多套流程模板按映射节点命中数打分——terminal×2/stage×1，7131600756 节点集
  命中 story2 5 分 vs story 1 分；config.yaml 新增 story2 档案）；⑤
  targetNodes 数组按**声明序**展开（get-node 表序不稳定——表序会把后续节点顶到
  首位勾错入口任务位置）；⑥ advanceTo every-finished 幂等达成分支限定
  confirm 方向（rollback 时目标 finished 恰说明未退到位）。**两链实测结果**：
  tech 7131432757 bind→prd→dev→test→report 全通（中途修声明序 bug，BQL
  date 通道实测破译 form_items——update-node 写不到实体层，须 workitem update）；
  story2 7131600756 bind→prd→dev（一次过）→tasks→test→report→save→pr_link
  回填→done B2 归档（目录移动+archive_prepared+推送）→manual-confirm 第二段
  推进到 state_11（系统权限确认）doing。计速：单链主流程分钟级（链 1 含修
  bug 14 分钟、链 2 优化后 dev→test 一次过 8 分钟），对比上轮单链 1 小时+。
  **遗留**：meegle rollback 真实语义未破译（doing 报 ErrAPIRollbackNode、
  finished 无效——M1 深测）；ErrHitRateLimit 无 CLI 内置退避（退避 8s 重跑
  即过）；update-node 对节点 form_items 的 text 字段不落地（select 落地——
  三件套须界面填）。138 用例全绿（meegle +3：owners 复合结论通道/future
  前置探查/select 试探转述；假命令扩展：__by_key__ 按节点区分清单/
  meta-node-fields 按字段名回选项集/update-node 认复合结论解除拒绝/
  workitem probe 报错带 field_name）
- **R4c 归因修正（2026-10-09，用户核实两链终态后反馈）**：① state_11→end
  卡点**真因=结论值无效**——「系统权限确认」节点结论写入「已通过」
  （system_passed），但该值**不在该节点选项集**（节点选项集是全局集子集，
  写 success 不报错但 BQL 视为未完成），与「是否需要发布后权限配置」无关；
  用户改为节点合法值后自动流转到终态（end finished）。**教训：下拉/枚举
  填充值必须在该节点可选集中，否则视为无效值（唯一可靠验证=流转成功本身）**
  ——节点级子集 CLI 不可知（get-node form_items 只有 value 无 options）。
  落地：autoFill 分支①结论**候选轮换**（启发式名 → system_passed → 选项集
  其余完成语义项，tried 按候选 id 记——填后流转仍拒下一轮换候选，穷尽走
  转述；maxSteps 16 步内早停）。②链 1（7131432757）未到结束的真因=**测试
  节点排期未填**（B1a MR 门先拦住没走到终态 advance——分支② point/schedule
  兜底补占位已覆盖该场景）。**排期业务规则（用户口径）**：开发节点先创建
  任务再勾默认「确认进入开发」任务——**创建任务自动更新总排期/总估分**
  （splitTasks 的 --schedule/--points 通道即此，链 2 实测 T1/T2 估分自动
  落地验证），不需要手动填；**测试节点须手动填总排期/总估分**（form_items
  point(number,required)/schedule(required)——CLI 分支②兜底占位，真实排期
  建议人工填）。③两链现均已终态（用户手动补值后自动流转：7131432757
  state_55 finished、7131600756 end finished）。139 用例全绿（meegle +1：
  结论值不在合法集候选轮换；假命令 update-node 支持 FAKE_CONCLUSION_VALID
  限定合法集模拟 BQL 无效值语义）
- **实测批 R4d（2026-10-09，story 7131398378 / tech 7131752604 收尾驱动，用户
  两问题反馈）**：① **入口任务代勾强控**（链 1 教训：tasks.md 漏标记首跑
  tasks_split 不进计划 → advance 流转被拒 → autoFill ③把入口任务「确认进入
  开发」代勾 → BQL 任务全完成 → 节点被放走，后建 T1/T2 无人勾）——③代勾
  跳过 entry_tasks 名单（勾选只走 tasks_split 尾段=子任务创建后统一勾），
  节点下 open 任务全是入口任务 → stop 转述「先拆分任务再推进」；② **排期
  真通道修正**（--schedules 假通道弃——R4b「可设」结论推翻，实测返回
  success 不落地；链 2 用户验证：任务填估分/排期后**节点总估分/总排期自动
  汇总更新**）：②重写为任务级通道——无子任务 → subtask create 默认执行任务
  「测试执行」（估分 1 人天、排期今日~+1 天、assignee=本人），有任务 → 给
  零估分任务补估分排期（update --fields+--schedule）；③ advanceTo 过冲达成
  兼容（链 1 误报「无进行中节点」——流转直冲终态全 finished 无 doing 时
  终态 finished 即视为达成，仅 confirm 方向）。141 用例全绿（meegle +2：
  入口任务不代勾强控/过冲达成；用例 16 断言迁任务级通道）。两链终态：
  7131752604 verified+T1/T2 补勾、7131398378 verified+归档 B2（用户界面建
  任务「1」验证任务级汇总通道后流转）
- **预置批 R5（2026-10-10，PMO 导出配置分析驱动）**：用户提供的两份 PMO 后台
  导出（公共技术需求/产研需求全配置）提取四模板全量 key 表并落地三项预置：
  ① **config 补全 4 模板 profile**（原仅 2/4——story DiDa `doing/state_8/end`
  与 tech 标准 `started/state_21/state_3` 未覆盖，DiDa story 需求原必错配：
  打分 0 分 → 回退 type 匹配 → 拿敏捷 key 找 DiDa 节点全部落空）；
  ② **模板 id 直查判定链**（实测 workitem get 返回全量属性含
  `work_item_attribute.template {id,name}`——--fields 过滤不生效属真实现状，
  readState 并行调用零往返直读）：判定链 hint > template 直查（config 预置
  template_id 映射）> 节点集打分（保留兜底）> 类型匹配；③ **entry_tasks
  全量变体**（PMO 导出证实入口任务名同模板内混用：story 敏捷「确认进入
  开发/确认进入研发」两拼写、tech 敏捷 +「确定进入开发/默认智能开发任务」
  ——原单名单下 R4d 强控会在未列节点失效）；`*开发` 模式匹配保留（存在
  理由修正：key 实为模板预置稳定值，模式的真实价值=33 个并行 OR 分支开发
  节点的「落位判定 = 任一 doing」，模板加节点自动适应）。**明确不预置**：
  33 开发节点精确 key 枚举（膨胀且更脆）、started 实体必填字段（key 随模板
  变且值为业务决策）、结论字段合法值（PMO 导出不含节点实例数据）、独立
  模板 JSON 查询文件（运行时需要的模板知识已全部收编 config；节点实时状态
  必须走 get-node，本地 JSON 无提速路径且引入第二真源过期风险）。142 用例
  全绿（meegle +1：template 直查覆盖打分/读不到回退）；真实冒烟：
  7131752604/7131398378 两链 workitem get template 读值 4584631/3312019
  与 PMO 导出吻合，V2_Test 归档链 status 正常。**分发模板同步**：
  `templates/config.yaml`（init 铺设给新接入仓的真源）同步 R5 版——
  story2 退役换 story-dida（原 R4b 观察子集的 test 映射 state_40 部署
  测试环境系误读，PMO 全量修正为真测试节点 state_8）、tech-std 新增、
  tech/tech-std prd 数组化（技术评审中间节点防人工卡点断档）、entry_tasks
  全变体；已接入仓 config 不随 update 自动覆盖（自定义不静默覆盖，D53），
  缺 template_id 时判定链回退打分、行为兼容——两份配置 4 profile 结构
  解析一致（vendored js-yaml 校验）
- **skill-core 瘦身（R6，2026-10-10）**：操作手册与实现账本分层。①删头部
  1435 字符实现进度注释，全文清除决策号/需求号/轮次号溯源（真源在 plan.md，
  skill 只留操作规则）；②「流转被拒实测口径」2714 字符 run-on 长句移入 §6
  压缩为「流转被拒转述口径」表——R4c/R4d autoFill 已把修复逻辑 CLI 化，
  AI 侧只需错误码对照与转人工情形（owners 分桶/--schedules 假通道史等
  CLI 内部机制删除——§5.4 禁拼 meegle 命令，AI 无操作面）；③重复规则收口：
  入口任务时序三处→§2 唯一口径块、登录流程两处→§5.1 真源+指针、
  --auto 白名单两处→§2 真源、「无 login 命令」三处→两处；④修正：§1
  「不支持 schema_version: 5」语义反写改为「非 5（不受支持）」、「动态开发
  节点」旧命名（R5 已证 key 为模板预置稳定值）、§1/§2 安装登录主语冲突
  澄清。26856→24075 字符（每会话读取量）；entries 同批清除溯源引用。
  **不拆分场景小 skill**（评估结论）：按命令拆 6 份会使共享协议层
  （§0/§3/§5）重复或仍需引用——真正按场景变化的内容仅 ~15%，薄入口
  +厚核心已是正确分层；拆分触发条件留档——某块知识膨胀到只在特定
  失败场景需要（≥3K 字符）时拆按需读取的第二文件
- **职责边界收敛 + user-guide 重写（R7，2026-10-10）**：定调「这组 skill
  只管**流程推进**，不指导工作内容」（怎么写 PRD/任务/用例/代码是用户与
  AI 的正常工作）。①skill-core §2 触发表收口：删「帮我写 PRD」行、
  「写验收报告」触发改纯流程口径（测试不通过→建议回退）；新增**职责
  边界声明块**（内容请求按通用能力协助、不翻译成 sdlc 命令）；②§4
  「产物写作」重构为「产物归位与同步契约」——PRD/用例/报告写作方法
  论删除（归位即可），保留 tasks.md 两段式解析契约/brief 交接协议/
  report 核对字段（code_ref 不冒充）——entries 六个 description 核验
  本就纯流程无越界；③**user-guide.md 全面重写**（对齐用户自助安装
  现实）：新增「首次安装」章（clone 分发仓 + install.sh --tool claude
  + meegle 代装 + doctor 自检 + 业务仓 init 区分——推翻原「已由维护者
  完成安装」口径）、更新/排障章；主线从自然语言改为**推荐 /sdlc-*
  斜杠命令**（清晰区分推进流程 vs 实际工作，自然语言为辅）；拆任务
  段改口径（任务清单是用户开发工作，sdlc 只管同步）
- **登录全链（2026-09-29 实测通过，D56/D57/D58）**：`sdlc login` SSO 授权码 + PKCE →
  Dolphin API 验证（200）→ 凭据落 `~/.sdlc/config`（refresh_token 自动续期）；
  doctor 登录态自检。回调 RFC 8252 loopback（`http://127.0.0.1:4290/callback`，
  SSO 白名单已配；SSO 端配置时需回调先可达，CLI 等待期即提供）；
  dev-local 备用形态复盘后移除（D58）。
  **登录隐式化（D57）**：需要凭据的命令自动处理未登录/失效（先静默续期再浏览器
  登录，成功后重跑原命令）；`login` 降为显式重登入口
  **（D59 转轨已执行：I6 删除 auth.js/login 命令与 config 凭据，认证整体移交
  meegle OAuth——keychain 托管，sdlc 不再经手任何 token）**
- 源码形态：ESM + JSDoc 直发（源码即分发物，无构建链）；js-yaml 唯一 vendor 依赖
- core 调用统一走 `cli/src/meegle/index.js`（D59 转轨后；mock 切换 `SDLC_MOCK=1`
  显式开关——sdlc-core 服务端与 apiclient 层已删除，api-contract.md 退役为
  prd meegle-contract.md）

## I1 交付范围（已完成 → ✓）

- ✓ 子仓结构 + git init + VERSION 0.1.0
- ✓ CLI 基础件：util/errors/config/journal/meta/gitops/plan/execution
- ✓ apiclient 四件（client/endpoints/mock/index 统一出口）
- ✓ 命令：doctor / init / start（恢复+分流+绑定）/ status / next·done 桩 / update 复用自检
- ✓ install.sh（~/.sdlc 固定锚点 + ~/bin shim + IDE 薄入口 + 自检）
- ✓ 资产迁入：skill-core.md / entries/（claude+qoder）/ templates/
- ✓ node:test 用例 + 手动链验证

**I1 明确不做**：plan/apply 完整协议（差异确认/execution 恢复）、next 全部动作、
DoD 其余 check（pr_exists/pr_merged/report_current/tasks_parseable）、阶段接续
检测（仅提示）、真实 core 登录。

## I2 交付范围（已完成 → ✓）

- ✓ `tasks.js` 粗任务块解析器（契约 §8：缺块=提示、字段错误=errors 不半解析）；
  `evaluateDod` 的 `tasks_parseable` 真实化
- ✓ plan 状态指纹（D39）：`state{head_sha/sync_raw/files[digest]/config_revision/
  stage_version/scope_all}` 进 plan_id（内容摘要防夹带）；预览存档
  `~/.sdlc/plans/<plan_id>.json`，apply 走「存档 plan + 状态分解」
- ✓ `next --intent save`（缺省同 save）全链：sync(behind) → commit(产物) → push →
  journal 事件 → publish 提交/推送 journal/meta（publish 自身不写事件，契约 §5）；
  `--message`（只传 subject）/`--files`（范围内收窄）/`--accept-gaps`/`--no-<action>`
  （`--no-push` 草稿隐含不发布推送）/`--accept-diffs`
- ✓ 差异确认：仅内容变化 → 逐文件 diff 展示 rc1、`--accept-diffs` 以新内容执行；
  文件范围/基线/配置/阶段变化 → 计划过期 rc1（防夹带）
- ✓ execution 恢复（D40 裁剪）：重跑同 `--apply <plan_id>` 跳过已成功动作（本机/
  远端 Git 事实裁决）；choices_hash 锁定（同执行不可改参数）；事件先存
  execution detail 再按 event_id 查缺补漏（幂等）；push 失败 external_unavailable
  rc2 + failed 事件留痕（重跑成功追加 succeeded，append-only）
- ✓ 提交格式（契约 §2）：scope 从分支 slug 派生（无 slug 用 req_id）；publish 用
  `chore(sdlc): <req_id> 流程记录发布`
- ✓ 预览检出未完成 save 执行提示续做（D39 先识别旧执行）；journal/meta 归 publish
  不进产物提交；`.sdlc/` 其他路径防跨需求收走

**I2 明确不做**：任务同步/PR/advance/handoff（I3）、status 深化（I3）、done（I4）、
真实 core 写调用（save 无 core 写，仅 `me()` 取 actor）。

## I3 交付范围（已完成 → ✓）

- ✓ apiclient +7 端点（advance/split/check/prs 建+查/executions 建+查）+ mock 落状态
  （db 扩 tasks/prs/executions；幂等重发安全；FLAKY/UNKNOWN 故障注入开关）
- ✓ **统一动作引擎**：`command/common.js` `runActions`——save/handoff 共用动作循环
  （scope/subject/noSet 从 plan+choices 重算；deriveEvents 注入差异化事件）
- ✓ `next --intent handoff` 全链（D41 顺序）：sync → commit → push → tasks_split →
  tasks_check → pr_create → advance → meta_update → journal → publish；预览含
  任务 diff（新增/完成候选/取消）、--to 候选校验、PR 目标、core 阶段一致性预检（D45）
- ✓ 外部动作恢复（D40 裁剪）：本地 ok 跳过；无记录查 `getExecution`——succeeded 且
  幂等端点（tasks/pr）续做取回详情、advance 补记跳过（重复推进有副作用）；unknown/
  pending → 记 unknown 报「待人工核对」不盲重发；首个外部动作前 `POST /v1/executions`
  保存意图（契约 §6）
- ✓ advance 409 stage_version_conflict → validation_failed rc1 提示重新预览；入口任务
  勾选（feishu profiles stage_nodes[to].entry_tasks）；meta_update 从 core
  requirementState 回读阶段字段（恢复场景也是权威值）+ pr_ref + last_brief
- ✓ 交接话术：advance ok 才输出（design §4 否决语义），事实存 `handoff_prepared`
  事件 payload（journal 步骤落，发布前记录——契约 §5）
- ✓ status 深化：归档定点定位（D42）+ PR 回读行（open+pending → 待人工合并）+
  话术只读补取与发布状态区分（D46，publish_push 事实裁决）+ `--json` 扩
  pr/handoff_prepared/handoff_note
- ✓ DoD 真实化：pr_exists（meta.pr_ref 本地）/ pr_merged（getPr 回读：merged ok、
  open gap、未查 unknown）/ report_current（D44 字段行提取：缺文件/未填/过期 gap）
- ✓ 用例：next.test.js handoff 集成链 8 例（预览/全链/幂等/冲突/FLAKY/UNKNOWN/
  --no-advance/PR 复用）+ status.test.js 5 例 + config.test.js DoD 6 例 + mock 端点例

**I3 明确不做**：done/`:complete`（I4）、`:change` 回退（I4）、start 兜底推进（接手方
侧，I4）、remind_merge、update 分发（I4）、真实 core 联调（I5）；POST /v1/executions
请求形状为客户端建议（契约无示例），联调固化走契约变更流程（D52）。

## I4 交付范围（已完成 → ✓）

- ✓ `sdlc done` 两段收尾（done.js，D42/§3.5）：B0–B6 状态机（活跃/已归档 ×
  PR open/merged/未核实 × core completion）——B2 计划一归档准备（sync →
  archive_move → meta_done → journal → archive_commit → push，`git mv` 进
  `.sdlc/archive/<YYYY-MM>-req-<id>`，移动事件随归档提交发布）；B4 归档已准备
  待人工合并（只读提醒话术不落事件）；B5 计划二 `:complete` 核验（B3 提前合并
  目录原位直走第二段；B5u 未核实可 `--manual-confirm pr_merged` 走 manual 限值）；
  B6 core completion 终态提示
- ✓ **第二段本地零写**（契约 §5）：completion 真源 = core（`:complete` 写、`:state`
  回显）；本地 meta 不写 completion、journal 不落 completion_recorded、不追加收尾
  提交；not_relocated 不持久化（B3 推导展示）
- ✓ `:change` 回退（change.js + next.js `--request-change "<说明>"` 平行入口，D38/
  D45）：候选 = stages 序中 current 之前全部（单候选定值/多候选 slots 勾选）；
  动作链 sync → commit → push → change → meta_update → journal → publish；
  `change_request` 事件留痕（from/to/版本/reason）；meta timeline 键区分
  `<stage>_entered_at`（首次）与 `<stage>_reentered_at`（回退不覆盖首次进入）；
  恢复走普通 `--apply`（plan.state.request_change 存档识别）
- ✓ start 兜底推进（D48 接手方侧）：`handoff_prepared(advanced=false)` 之后无
  `change_request`（回退优先）∧ core 仍在 from → 检测缺口出兜底计划（advance →
  meta_update → journal → publish）；脏产物不进计划（先 save 防夹带）；已满足/
  人工核对三分支；双路径（handoff/兜底）由 expected_stage_version 409 原子互斥
- ✓ remind_merge（只挂 save 链）：预览回读 PR（pr_state/remind 快照进 plan.state
  参与指纹）；阶段末尾 ∧ PR open → `remind_merge` 事件随 journal 发布 + 可复制
  转发提醒话术；merged/未核实不提醒
- ✓ 引擎 +5 case（archive_move/meta_done/archive_commit/change/complete）+
  deriveArchiveEvents/deriveSaveEvents 钩子（统一四参签名）；endpoints +2
  （`:change`/`:complete`，请求形状客户端建议 D52 留痕）；mock 同形路由
  （幂等重放 → 422 from 不符 → 409 版本；`:complete` PR open 422 不伪称已合并、
  manual 限值）+ seed `completion_status` + `:state` 回显
- ✓ 用例 103 全绿：done.test.js 17（B1a/B2 预览·全链·幂·冲突·未跟踪·--no/B4/
  B5 全链·幂·422·accept-gaps/B3/B5u/B6）+ change.test.js 11（互斥/候选/apply
  全链/幂/409/--no-change/多候选/脏产物/恢复路由）+ start.test.js 7 + mock +3
  + next +1（remind_merge）；手动冒烟链（B2→B4→db merged→B5 verified→status
  终态 + change 回退 + start 兜底）

**I4 明确不做**：update 分发（挪 I5——独立分发子系统与真实联调同批）、
archive_restored 返工恢复链（枚举已留位）、IM 卡片推送、真实 core 联调（I5）；
`:change`/`:complete` 请求形状为客户端建议（契约无示例），联调固化走契约变更
流程（D52）。

## I5 交付范围（编码完成 → ✓，联调/实测待运行时）

- ✓ `sdlc update` 分发自更新（D53 §2.1）：`git fetch --tags`（远端不可达不
  阻塞——本地 tag 仍可计划/降级）→ 更新计划（当前→目标、方向、变更摘要
  `git log`、将写入清单、自定义差异提示）→ 确认 `--apply`：dist 内
  `git checkout --detach <tag>`（原子切换点）→ 重铺 shim/skill-core/IDE 薄入口
  → 自检（新版 CLI spawn --version + tag 就位核验；core/登录态不查——不可达
  不算安装失败）→ 失败自动 checkout 回旧 ref 并重铺（不允许半新半旧）；
  `--to <旧tag>` 降级；`--force` 覆盖自定义入口差异
- ✓ 自定义差异预检在 checkout 前（用户侧文件与**当前安装版**比较——升级/降级
  的正常版本差异直接重铺，只有真正的用户自定义不静默覆盖）；qoder 入口为
  手动放置（M1 实测），只提示
- ✓ dist 定位（`cli/src/dist.js`）：SDLC_DIST 可覆盖（测试隔离），缺省从模块
  路径推导；独立判定 = dist 自身持有 .git（开发安装/主仓内目录拒绝自更新，
  提示重跑 install.sh）
- ✓ doctor 薄入口核验行（§2.2 铺设核验）：所选 IDE 入口就位且为分发版（已确认
  自定义差异不算失败）；缺失 → fail 提示重铺；qoder 提示不核验
- ✓ install.sh 铺 tool 时写入 `~/.sdlc/config` 的 tool 字段（node 合并 JSON，
  保留 auth/core_url）——update/doctor 缺省读取
- ✓ main.js：`--tool` 值 flag、`--force` bool、USAGE 更新
- ✓ 用例 113 全绿（update.test.js 10 例：开发安装拒绝/tag 校验/工作区脏/
  预览零写/apply 全链（checkout+shim+skill-core+薄入口+tool 记录）/降级/
  自定义差异 no-force 跳过·force 覆盖/坏构建自检失败回滚/已最新/doctor 核验）

**I5 待运行时（编码面无剩余）**：双 IDE 薄入口实测（发现/触发/非交互确认/恢复
升级——M1 checklist 走查）、真实 core 联调（~~服务端就绪后切 `~/.sdlc/config`
core_url~~ D59 后该项作废——core 已删除，联调对象改为真实 meegle，随 I6 落地）。
分发仓库已建立并首发（2026-09-30：Codeup `Public/dida-sdlc`，master 为受保护
主分支——版本经 feat 分支评审合入；首发走 feat/v0.1.0 分支 + tag v0.1.0，
快照自主仓 `git archive HEAD:dida-sdlc` 导出）。

## I6 交付范围（编码完成 → ✓，D59 架构转轨，2026-10-08）

> 设计真源：主仓 `prd/dida-sdlc/`（方案 v1.0 / schema 5）——总纲、
> `meegle-contract.md`（CLI↔meegle-cli 对接唯一真源）、`client-design.md` §2.3/§6、
> `sdlc-contract.md` v5、决策 D59。契约先行：先改 prd 契约再动实现（本文即实施蓝图）。

- 计划切分（统一实现批次，设计收敛后执行）：
  - ✓ **I6a meegle 适配层**：`cli/src/meegle/`（index 通道 + runner + mock 轨）替代
    `cli/src/apiclient/`——子进程 `meegle <cmd> --format json --envelope`（多行
    stdout 取尾行 JSON）、注入 `MEEGLE_NO_UPDATE_CHECK=1`、信封/退出码解析
    （`SDLC_MEEGLE_BIN`/`SDLC_MEEGLE_TIMEOUT_MS` 测试钩）、`auth status` 预检与
    登录交接（meegleLoginHandshake 返回 `{ok}`，URL 经 onUrl 转述）、错误域映射
    （AUTH_REQUIRED→unauthorized、exit2/超时→external_unavailable、不可解析→
    external_unknown，meegle-contract §4）；mock 轨 `SDLC_MOCK=1` 显式开关
    （文件态 db + 幂等门 gatedTransition + FLAKY/UNKNOWN 故障注入）
  - ✓ **I6b 动作迁移**：advance/change=transition 幂等门三分（已在 to→幂等重放
    idempotent:true / 仍在 from→续发 / 别处→validation_failed details.remote_stage
    ——409 与 executions 端点退役）、tasks 按标题/tasks_map 幂等（already_exists/
    no_op）、complete=飞书终态 transition（source=manual 如实限值）、PR 人工路径
    （pr_create 输出预填 MR 链接不调 API、pr_link 对话回填写 meta.pr_ref +
    pr_linked 事件、合并核验唯一来源 done --manual-confirm pr_merged）；
    恢复=journal 留痕 + 远端回读裁决（去 core 端点）
  - ✓ **I6c 登录退役**：删 auth.js / login 命令 / apiclient 整目录（token 不落
    ~/.sdlc——config.js 读取侧静默丢弃旧凭据字段）；main.js unauthorized→
    meegleLoginHandshake 自动登录交接→重跑原命令；doctor 认证自检走
    meegleAuthStatus（未安装/未核实不算失败）
  - ✓ **I6d 安装链**：install.sh 代跑
    `npx -y @lark-project/meegle@latest install --host project.feishu.cn --device-code --no-skills`
    （host 显式；`||` 失败不阻塞 sdlc 本体，运行时任意命令自动补登录交接）
  - ✓ **I6e schema 5**：meta 增 `tasks_map`（Tn→remote_id 随 Git 共享）与
    `user_key`、journal `"v":5`、config profiles stage_nodes（node_key+entry_tasks
    单映射）；所有版本等值新鲜度比较改**纯阶段比较**（去 expected_stage_version）
  - ✓ **I6f 透明性**：skill-core.md §0/§1 已按 D59 语义更新（meegle 登录 URL
    转述例外、无 login 命令）；skill 不直接触达 meegle 命令
- ✓ 测试基线迁移：meegle.test.js 新建（假二进制方案：SDLC_MEEGLE_BIN=node +
  cwd 裸名脚本——信封/错误域/超时/ENOENT/auth 三态 8 例）；mock.test.js 重写
  （createMockCore 语义 12 例）；config/status/start/change/next/done 六文件
  迁移 meegle 轨（SDLC_MOCK=1 + seed 触发 + 断言 v5 化：remote_id 断言、prs
  断言删、FLAKY/UNKNOWN 恢复改幂等门语义、done B 矩坍缩 B1a/B2/B4/B6+
  manual-confirm 第二段）；journal/tasks/plan/execution 天然绿；update 天然绿
- 明确不做：真实 meegle 实测（M1 #28–#35 运行时）、sdlc-core 仓代码处置
  （用户侧动作）、`MEEGLE_USER_ACCESS_TOKEN` 环境变量模式（keychain 为主）、
  op-records 深度用法（#33 实测后定）
- 实施备注：start.js previewCatchUpPlan 参数缺失（core 未定义）与 done.js
  previewComplete 参数错位（gaps 被吞）两处产品 bug 由迁移测试暴露并修复

## I3–I5 概要

- **I2（已完成）**：plan/apply 完整协议（缺口确认/--accept-gaps、execution 恢复）+ next save
  （commit/push/publish 顺序，契约 §6）+ tasks.md 块解析器
- **I3（已完成，2026-09-29）**：next handoff + 任务同步/PR/advance（mock）+ status 深化 + 话术
- **I4（已完成，2026-09-29）**：done 两段收尾/归档/提前合并 + `:change` 回退 + start
  兜底推进（D48）+ remind_merge——客户端流程闭环（发起→推进→回退→收尾）
- **I5（编码完成，2026-09-29）**：update 完整分发（fetch tags → checkout tag
  原子切换 → 重铺薄入口 → 自检/自动回滚，D53）+ doctor 薄入口核验——**编码面
  全部完成**；剩余为运行时动作：双 IDE 实测、真实 core 联调（分发仓库已首发
  v0.1.0，2026-09-30）

## 验证基线

`node --test test/*.test.js` 全绿（R5 起 142 用例）。I6 v5 面：
meegle 适配层 8 例（假二进制：信封/多行取尾/错误域映射/exit2 retryable/不可解析
不盲重发/超时/ENOENT 未安装提示/auth 三态）；R2/R4/R4c real 通道 16 例（workflow/
workitem/subtask 假命令状态机：`*开发` 名称模式/数组映射/追赶推进/幂等重放/必填
懒查升级/激活/story2 自适应/BQL 自动补齐五类（结论/子任务代勾/owners 复合/
结论无效值候选轮换/future 前置探查/select 试探转述）/splitTasks/checkTasks/
登录链回归）；mock 轨 12 例（幂等门三分/任务
remote_id 三级解析/complete manual 限值/FLAKY 副作用已落/UNKNOWN 写前失败）；
集成链（真实临时 git 仓）v5 语义——next 23 例（save 全链 + save tasks_check
本地完成同步勾选 + handoff：tasks_map/
PR 人工路径/纯阶段冲突/FLAKY 幂等重放/UNKNOWN 续发 + remind_merge 恒提醒/
completion 对照 + R3 直通 3 例）；done 15 例（B1a/B2/B4/B6 坍缩矩阵 + manual-confirm 第二段：
db manual + completion_recorded 本地留痕不追加提交/幂等/远端已收尾拒绝/
accept-gaps with_gaps 留痕/提前合并 archived:false）；change/start 11+9 例
（纯阶段比较/幂等重放/恢复路由）；update 10 例（分发链天然绿——不动外部通道）。
历史链（I2–I5）同基线运行。手动冒烟链随真实 meegle 实测（M1 #28–#35）补；
退出码 0/1/2/3 语义见 `cli/src/errors.js`。
