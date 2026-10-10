// sdlc next：保存或明确交接（client/design §3.3 / D41）。
// save（I2）：确认产物 commit → push → journal 事件 → 末尾 publish 提交推送
// journal/meta（publish 自身结果只进 execution，不写 journal 事件——不递归，契约 §5）。
// apply 侧走「存档 plan + 状态分解」（D39 差异确认：内容变化不整体作废，逐文件
// 展示差异、--accept-diffs 后以新内容执行）；恢复 = 重跑同命令跳过已成功动作，
// 以本机/远端 Git 事实裁决（D40 裁剪：不建独立恢复会话）。
// handoff（I3）：command/handoff.js——任务同步/PR 链接/advance 外部链 + 交接话术。
// --pr-url（D59 人工路径回填）：handoff 输出的 MR 创建链接人工创建后，对话
// 回填 MR 链接（pr_link 动作——本地写 meta.pr_ref + pr_linked 事件）。
// 共享底座（范围/指纹/缺口/事件持久化）在 common.js。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findSdlcRoot, loadRepoConfig } from '../config.js';
import { loadMeta } from '../meta.js';
import { buildPlan, renderPlan, savePlan, loadPlan } from '../plan.js';
import { parseTasksFile } from '../tasks.js';
import { newExecution, saveExecution, findExecutionByPlan } from '../execution.js';
import { currentBranch, branchSync, headSha, repoSlug, repoWebUrl } from '../gitops.js';
import { createCore } from '../meegle/index.js';
import { SdlcError } from '../errors.js';
import { sha256, canonical } from '../util.js';
import {
  resolveReqId, collectScope, narrowScope, digestOf, checkFreshness, renderDiffs,
  currentGaps, findUnfinishedExecutions, runActions, deriveSaveEvents,
} from './common.js';
import { previewHandoff, applyHandoff } from './handoff.js';
import { previewChange, applyChange } from './change.js';

/**
 * @param {string[]} positional 位置参数（可选 req_id）
 * @param {Record<string, any>} flags
 * @returns {Promise<number>} 退出码
 */
export async function runNext(positional, flags = {}) {
  // --request-change 平行入口（I4，非第三种 intent）：与 --intent/--apply 互斥
  //（说明文本随计划固化——恢复走普通 --apply，由存档 request_change 识别）
  // --auto 直通（R3 sidecar 白名单）：save/handoff 新计划预览即执行——仅此两
  // intent；存档恢复/回退/PR 回填保留人工确认路径
  if (flags.auto === true && (flags.apply !== undefined || flags.requestChange !== undefined || flags.prUrl !== undefined)) {
    throw new SdlcError('validation_failed', '--auto 与 --apply/--request-change/--pr-url 互斥（直通只用于新计划 save/handoff）');
  }
  const intent = flags.intent ?? 'save';
  if (flags.requestChange !== undefined) {
    if (flags.intent !== undefined) {
      throw new SdlcError('validation_failed', '--request-change 与 --intent 互斥（回退是独立入口，非第三种意图）');
    }
    if (flags.apply !== undefined) {
      throw new SdlcError('validation_failed', '--request-change 不与 --apply 同用——回退计划已固化说明，恢复直接 sdlc next --apply <plan_id>');
    }
    if (typeof flags.requestChange !== 'string' || flags.requestChange.trim() === '') {
      throw new SdlcError('validation_failed', '--request-change 需要说明文本：--request-change "<说明>"');
    }
  } else if (flags.prUrl !== undefined) {
    // --pr-url 平行入口（D59 人工路径回填）：与 --intent/--request-change/--to/--tasks 互斥
    if (flags.intent !== undefined) {
      throw new SdlcError('validation_failed', '--pr-url 与 --intent 互斥（PR 回填是独立入口）');
    }
    if (typeof flags.prUrl !== 'string' || !/^https?:\/\//.test(flags.prUrl)) {
      throw new SdlcError('validation_failed', '--pr-url 需要 MR 详情页链接：--pr-url <https://…>');
    }
    if (flags.to || flags.tasks) {
      throw new SdlcError('validation_failed', '--pr-url 不与 --to/--tasks 同用');
    }
  } else {
    if (intent !== 'save' && intent !== 'handoff') {
      console.log(`sdlc next --intent ${intent} —— 将在后续迭代实现（update 分发属 I5）。`);
      console.log('当前支持：save（缺省）/ handoff / --request-change 回退 / --pr-url PR 回填。');
      return 0;
    }
    // 预览 save 不含 --tasks/--to；apply 带 --to 是 change 计划多候选恢复的勾选，放行
    if (intent === 'save' && (flags.tasks || flags.to) && flags.apply === undefined) {
      throw new SdlcError('validation_failed', '保存计划不含任务同步/目标候选（--tasks/--to 属交接场景，用 --intent handoff）');
    }
  }
  const root = findSdlcRoot(process.cwd());
  if (!root) {
    console.error('当前目录不在 sdlc 接入的仓库内（未找到 .sdlc/）。请先运行 sdlc init。');
    return 1;
  }
  const reqId = resolveReqId(root, positional);
  const reqDir = path.join(root, '.sdlc', `req-${reqId}`);
  const meta = loadMeta(path.join(reqDir, 'meta.yaml'));
  if (!existsSync(reqDir) || !meta) {
    throw new SdlcError('not_found', `需求 ${reqId} 无本地档案（.sdlc/req-${reqId}/），请先 sdlc start ${reqId} 绑定`);
  }
  const branch = meta.branch;
  const cur = currentBranch(root);
  if (cur !== branch) {
    throw new SdlcError('validation_failed', `当前分支 ${cur ?? '(detached)'} 与需求分支 ${branch} 不一致——请先 sdlc start 恢复需求现场`);
  }
  const { config, configRevision } = loadRepoConfig(root);

  const ctx = { root, reqId, reqDir, meta, config, configRevision, branch, flags };
  if (flags.requestChange !== undefined) {
    if (flags.apply === undefined) return previewChange(ctx);
    return applyChange(ctx); // 与 --apply 互斥已在顶部拦截——此处不可达，防御保留
  }
  if (flags.prUrl !== undefined && flags.apply === undefined) return previewPrLink(ctx);
  // 普通 --apply 恢复：change 计划（state.request_change）路由到 applyChange；
  // pr_link 计划（state.pr_link）路由到 applyPrLink；handoff 计划（state.to）
  // 同理按存档路由——预览输出的「确认执行」行不带 --intent，缺省 save 会吞掉
  // --tasks/--to（实测 M1：勾选丢失 → 节点 BQL 前置不满足 → 推进被拒）
  if (flags.apply !== undefined && typeof flags.apply === 'string') {
    const saved = loadPlan(flags.apply);
    if (saved?.state?.request_change) return applyChange(ctx);
    if (saved?.state?.pr_link) return applyPrLink(ctx);
    if (saved?.state?.to) return applyHandoff(ctx);
  }
  if (intent === 'handoff') {
    if (flags.apply === undefined) return previewHandoff(ctx);
    return applyHandoff(ctx);
  }
  if (flags.apply === undefined) return previewSave(ctx);
  return applySave(ctx);
}

/**
 * @typedef {object} SaveCtx
 * @property {string} root
 * @property {string} reqId
 * @property {string} reqDir
 * @property {any} meta
 * @property {any} config
 * @property {string} configRevision
 * @property {string} branch
 * @property {Record<string, any>} flags
 */

/** @param {SaveCtx} ctx @returns {Promise<number>} */
async function previewSave(ctx) {
  const { root, reqId, reqDir, meta, branch, flags } = ctx;
  const { scope, excluded, flowDirty } = collectScope(root, reqId);
  // --files 只能在默认范围内收窄（journal/meta 归 publish 的 D41 边界不可绕过）
  const scopePaths = narrowScope(scope.map((d) => d.path), flags);
  const sync = branchSync(root);
  // v5 待合并提醒快照（remind_merge 只挂 save）：阶段末尾 ∧ meta.pr_ref ∧ 收尾
  // 未记录——PR 状态不可回读（D59 人工路径），恒提醒；remind 进 plan.state 参与
  // 指纹（防夹带），执行期只消费
  let remind = null;
  if (meta.pr_ref) {
    const st = (ctx.config.stages ?? []).find((s) => s.id === meta.current_stage);
    const stageEnd = st?.next === 'done' || (st?.dod ?? []).some((d) => d.check === 'pr_merged');
    const pending = typeof meta.completion_status !== 'string' || meta.completion_status === 'pending';
    if (stageEnd && pending) {
      remind = { pr_id: String(meta.pr_ref.pr_id), url: meta.pr_ref.url, stage: meta.current_stage };
    }
  }
  // 无可保存改动（无产物脏文件、不 ahead/behind、流程记录干净）→ 不出计划
  if (scopePaths.length === 0 && !sync.ahead && !sync.behind && !flowDirty) {
    console.log('无可保存改动（工作区干净、与远端同步、无未发布流程记录）。');
    const gaps = currentGaps(ctx, sync);
    if (gaps.length > 0) console.log(`DoD 提示（${meta.current_stage}）：\n${gaps.map((g) => `  - ${g.id}：${g.text}${g.note ? `（${g.note}）` : ''}`).join('\n')}`);
    for (const u of findUnfinishedExecutions(reqId)) console.log(`⚠ 存在未完成执行 ${u.execution_id}——建议 sdlc next --apply ${u.plan_id} 续做`);
    return 0;
  }

  const subject = `保存 ${reqId} 需求产物`;
  const actions = [];
  if (sync.behind) actions.push({ id: 'sync', title: '落后远端，先 git pull --ff-only 快进同步' });
  if (scopePaths.length > 0) actions.push({ id: 'commit', title: `提交确认产物（${scopePaths.length} 个文件）`, args: { files: scopePaths } });
  if (scopePaths.length > 0 || sync.ahead) actions.push({ id: 'push', title: `推送 ${branch}` });
  // R4：本地已完成任务同步勾选（开发中每完成一项，保存时自动勾远端）。触发 =
  // tasks.md 在本次保存范围内且解析出 completed；不预读远端——apply 时
  // checkTasks 单次回读幂等裁决（open→勾 / 已完成→no_op / 无→not_found）
  {
    const curStage = (ctx.config.stages ?? []).find((s) => s.id === meta.current_stage);
    const tasksRel = (curStage?.dod ?? []).find((d) => d.check === 'tasks_parseable')?.path ?? `${meta.current_stage}/tasks.md`;
    // scopePaths 是 repo 相对形状（.sdlc/req-<id>/…，正斜杠），tasksRel 是 reqDir 相对
    if (scopePaths.includes(`.sdlc/req-${reqId}/${tasksRel}`)) {
      const parsed = parseTasksFile(path.join(reqDir, tasksRel));
      const done = parsed.errors.length === 0 && parsed.found
        ? parsed.tasks.filter((t) => t.state === 'completed')
        : [];
      if (done.length > 0) {
        const completions = done.map((t) => ({ id: t.id, title: t.title, remote_id: meta.tasks_map?.[t.id] }));
        actions.push({ id: 'tasks_check', title: `同步勾选本地已完成任务（${done.map((t) => t.id).join('、')}）`, args: { completions } });
      }
    }
  }
  actions.push({ id: 'journal', title: '追加流程事件（local_commit/push/缺口接受/跳过留痕）' });
  actions.push({ id: 'publish_commit', title: `提交流程记录（${flowDirty ? 'journal.jsonl + meta.yaml' : 'journal.jsonl'}）` });
  actions.push({ id: 'publish_push', title: '推送流程记录' });

  // gaps 不含 git_synced：保存前它恒 gap（保存正是修复它的动作），列出是同义反复
  const gaps = currentGaps(ctx, sync).filter((g) => g.check !== 'git_synced').map((d) => `${d.id}：${d.text}${d.note ? `（${d.note}）` : ''}`);
  const plan = buildPlan({
    reqId,
    title: meta.title,
    url: meta.feishu_url,
    repo: root,
    branch,
    intent: '保存：提交推送确认产物 + 末尾发布流程记录（D41）',
    actions,
    gaps,
    slots: [],
    facts: [
      `通道：${process.env.SDLC_MOCK === '1' ? 'mock（结论不作为已验证）' : 'meegle（飞书项目）'}`,
      `Git：${sync.raw || '（无跟踪信息）'}`,
      `建议 subject：${subject}（--message 只传 subject，type/scope/Refs 由 CLI 拼接）`,
      ...(excluded.length > 0 ? [`范围外脏文件（默认不含，归 publish 或防跨需求收走）：${excluded.map((d) => d.path).join('、')}`] : []),
    ],
    state: {
      req_id: reqId,
      repo: root,
      branch,
      head_sha: headSha(root) ?? '',
      sync_raw: sync.raw,
      files: scopePaths.map((p) => ({ path: p, digest: digestOf(root, p) })),
      // 预览时的完整默认范围（files 可被 --files 收窄；freshness 用它区分「收窄」与「预览后新增」）
      scope_all: scope.map((d) => d.path),
      config_revision: ctx.configRevision,
      stage: meta.current_stage,
      stage_version: meta.stage_version,
      // v5：remind 触发时才写（deriveSaveEvents 消费；无键时指纹与既有 save 计划一致）
      ...(remind ? { remind } : {}),
    },
  });
  savePlan(plan);

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const unfinished = findUnfinishedExecutions(reqId);
  for (const u of unfinished) {
    console.log(`⚠ 存在未完成执行 ${u.execution_id}（plan ${u.plan_id.slice(0, 12)}…）——建议先 sdlc next --apply ${u.plan_id} 续做（D39：先识别旧执行）`);
  }
  console.log(renderPlan(plan));
  // R3 直通：--auto 预览即执行（sidecar 白名单——save/advance/tasks_split 低风险
  // 可回转）；有未完成执行则不自动叠新执行（转人工续做路径）
  if (flags.auto === true) {
    if (unfinished.length > 0) {
      console.log(`✗ --auto 中止：存在未完成执行（见上 ⚠）——先 --apply 续做或处理后再直通`);
      return 1;
    }
    flags.apply = plan.plan_id;
    console.log('▶ --auto 直通执行（免确认白名单，失败即停转述）…');
    return applySave(ctx);
  }
  console.log(`确认执行：sdlc next --apply ${plan.plan_id}`);
  if (gaps.length > 0) console.log('（可加 --accept-gaps 接受上述缺口，留痕 gap_accepted 事件；不接受不阻塞保存）');
  return 0;
}

/** @param {SaveCtx} ctx @returns {Promise<number>} */
async function applySave(ctx) {
  const { root, flags } = ctx;
  if (flags.apply === true) {
    throw new SdlcError('validation_failed', 'next 的 --apply 需要 plan_id 值（见预览输出的「确认执行」一行）');
  }
  const plan = loadPlan(String(flags.apply));
  if (!plan || !plan.state) {
    throw new SdlcError('validation_failed', 'plan_id 无本机存档（或非保存计划）——请重新 sdlc next 预览生成新计划');
  }
  const choices = {
    intent: 'save',
    subject: typeof flags.message === 'string' && flags.message.trim() !== '' ? flags.message.trim() : `保存 ${plan.req_id} 需求产物`,
    accept_gaps: flags.acceptGaps === true,
    no_actions: Object.keys(flags.no ?? {}).sort(),
  };

  let execution = findExecutionByPlan(plan.plan_id);
  if (!execution) {
    // 全新 apply：状态分解（D39）——结构变化 = 过期；仅内容变化 = 差异确认
    const fresh = checkFreshness(root, plan);
    if (fresh.stale) {
      throw new SdlcError('validation_failed', `计划已过期（${fresh.stale}），请重新 sdlc next 预览`);
    }
    if (fresh.diffs.length > 0 && flags.acceptDiffs !== true) {
      renderDiffs(root, fresh.diffs);
      console.error('以上文件内容与预览时不同（防中继夹带）。确认新内容：加 --accept-diffs 重跑；拒绝：重新 sdlc next 预览。');
      return 1;
    }
    execution = newExecution(plan.plan_id, choices, plan.req_id);
    saveExecution(execution); // 首个写动作前持久化选择（契约 §6）
  } else if (execution.choices_hash !== sha256(canonical(choices))) {
    throw new SdlcError('validation_failed', '同一执行不可更改参数（choices 不一致）——改变决定请重新 sdlc next 预览生成新计划');
  }

  const core = createCore();
  const me = await core.me(); // journal actor；real 模式未登录走 D57 自动登录
  return executeSave(plan, execution, choices, me.actor.actor_id, core, ctx);
}

/**
 * save 执行：统一动作引擎（common.js runActions——save/handoff 共用同一循环，
 * save 计划不含外部动作 id，天然不触发外部 case）+ 汇总话术。
 * @param {import('../plan.js').Plan} plan
 * @param {import('../execution.js').ExecutionRecord} execution
 * @param {Record<string, unknown>} choices
 * @param {string} actor
 * @param {import('../meegle/index.js').Core} core
 * @param {SaveCtx} ctx
 * @returns {Promise<number>}
 */
async function executeSave(plan, execution, choices, actor, core, ctx) {
  const { root, reqId, branch } = ctx;
  await runActions(plan, execution, choices, actor, core, ctx, { deriveEvents: deriveSaveEvents });

  // 汇总话术
  const commitAct = plan.actions.find((a) => a.id === 'commit');
  const scope = /** @type {string[]} */ (commitAct?.args?.files ?? []);
  const noSet = new Set(/** @type {string[]} */ (choices.no_actions));
  const c = execution.actions.commit?.detail;
  console.log(`\n✓ 保存完成（execution ${execution.execution_id}）`);
  if (c && typeof c.sha === 'string' && !c.noop) console.log(`  产物提交：${c.sha.slice(0, 8)}（${scope.length} 个文件）`);
  if (noSet.has('push') || noSet.has('publish_push')) {
    console.log('  ⚠ 未推送（草稿保存）——接手人尚不可见，不宣称已同步');
  } else if (execution.actions.push?.status === 'ok') {
    console.log(`  分支 ${branch} 已同步远端`);
  }
  // v5 待合并提醒（预览快照触发，remind_merge 事件已随 journal 发布——供人
  // 转发，不声称交付；PR 状态不可回读，恒提醒直到 done 收尾）
  if (plan.state?.remind) {
    const r = plan.state.remind;
    console.log(`  待合并提醒（可复制转发）：MR #${r.pr_id}（${r.url}）——阶段 ${r.stage} 收尾，人工合并后 sdlc done ${reqId} --manual-confirm pr_merged 走核验收尾`);
  }
  const gaps = currentGaps(ctx, branchSync(root));
  if (gaps.length > 0 && !choices.accept_gaps) {
    console.log(`  DoD 提示（${ctx.meta.current_stage}，可接受后继续）：`);
    for (const g of gaps) console.log(`    - ${g.id}：${g.text}${g.note ? `（${g.note}）` : ''}`);
  }
  console.log('  下一步：继续开发后再次保存；准备交接时在对话中明确告知（sdlc next --intent handoff）。');
  return 0;
}

/**
 * 预览 PR 回填（D59 人工路径）：解析 MR 链接（尽力——Codeup change/通用
 * merge_requests 形状）→ pr_link 小计划（本地写 meta.pr_ref + pr_linked 事件，
 * 随 publish 发布）。source/target 由当前分支/trunk 推断（链接不含分支信息——
 * 尽力字段，展示用途）。
 * @param {SaveCtx} ctx @returns {Promise<number>}
 */
async function previewPrLink(ctx) {
  const { root, reqId, meta, branch, flags } = ctx;
  const url = String(flags.prUrl).trim();
  // Codeup：…/change/{id} 或 …/change/detail/{id}；通用 GitLab 形状 …/merge_requests/{id}
  const m = url.match(/\/change\/(?:detail\/)?(\d+)/) ?? url.match(/\/merge_requests\/(\d+)/);
  if (!m) {
    throw new SdlcError('validation_failed', `无法从链接解析 MR 编号：${url}——请给 MR 详情页链接`);
  }
  const prId = m[1];
  if (meta.pr_ref && String(meta.pr_ref.pr_id) === prId) {
    throw new SdlcError('validation_failed', `meta 已回填同一 MR #${prId}（${meta.pr_ref.url}）——勿重复回填`);
  }
  const repo = repoSlug(root);
  const pr = { repo: repo ?? '', pr_id: prId, url, source: branch, target: ctx.config.git?.trunk ?? 'master' };
  const sync = branchSync(root);

  const actions = [];
  if (sync.behind) actions.push({ id: 'sync', title: '落后远端，先 git pull --ff-only 快进同步' });
  actions.push({ id: 'pr_link', title: `回填 MR #${prId}（本地写 meta.pr_ref + pr_linked 事件）`, args: { pr } });
  actions.push({ id: 'journal', title: '追加流程事件（pr_linked）' });
  actions.push({ id: 'publish_commit', title: '提交流程记录（journal.jsonl + meta.yaml）' });
  actions.push({ id: 'publish_push', title: '推送流程记录' });

  const plan = buildPlan({
    reqId,
    title: meta.title,
    url: meta.feishu_url,
    repo: root,
    branch,
    intent: `PR 回填：MR #${prId}（人工路径，D59）`,
    actions,
    gaps: [],
    slots: [],
    facts: [
      `MR：#${prId} ${url}`,
      `分支（尽力推断）：${branch} → ${pr.target}`,
      `Git：${sync.raw || '（无跟踪信息）'}`,
      ...(meta.pr_ref ? [`⚠ meta 已有 MR 引用 #${meta.pr_ref.pr_id}——本次回填将覆盖（事件如实留痕）`] : []),
    ],
    state: {
      req_id: reqId,
      repo: root,
      branch,
      head_sha: headSha(root) ?? '',
      sync_raw: sync.raw,
      files: [],
      scope_all: [],
      config_revision: ctx.configRevision,
      stage: meta.current_stage,
      stage_version: meta.stage_version,
      // pr-link 扩展：apply 路由识别 + 事实快照（防夹带）
      pr_link: true,
      pr,
    },
  });
  savePlan(plan);

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  console.log(renderPlan(plan));
  console.log(`确认执行：sdlc next --apply ${plan.plan_id}`);
  return 0;
}

/**
 * apply PR 回填：与 save 同构（存档计划 + 状态分解 + choices 锁定）。
 * @param {SaveCtx} ctx @returns {Promise<number>}
 */
async function applyPrLink(ctx) {
  const { root, flags } = ctx;
  if (flags.apply === true) {
    throw new SdlcError('validation_failed', 'next 的 --apply 需要 plan_id 值（见预览输出的「确认执行」一行）');
  }
  const plan = loadPlan(String(flags.apply));
  if (!plan || !plan.state?.pr_link) {
    throw new SdlcError('validation_failed', 'plan_id 无本机存档（或非 PR 回填计划）——请重新 sdlc next --pr-url 预览');
  }
  const choices = {
    intent: 'pr_link',
    subject: `回填 MR ${plan.state.pr.pr_id}`,
    accept_gaps: false,
    no_actions: Object.keys(flags.no ?? {}).sort(),
  };

  let execution = findExecutionByPlan(plan.plan_id);
  if (!execution) {
    const fresh = checkFreshness(root, plan);
    if (fresh.stale) {
      throw new SdlcError('validation_failed', `计划已过期（${fresh.stale}），请重新 sdlc next --pr-url 预览`);
    }
    execution = newExecution(plan.plan_id, choices, plan.req_id);
    saveExecution(execution); // 首个写动作前持久化选择（契约 §6）
  } else if (execution.choices_hash !== sha256(canonical(choices))) {
    throw new SdlcError('validation_failed', '同一执行不可更改参数（choices 不一致）——改变决定请重新预览');
  }

  const core = createCore();
  const me = await core.me(); // journal actor；real 模式未登录走 D57 自动登录
  const pr = execution.actions.pr_link?.status === 'ok' ? execution.actions.pr_link.detail?.pr : plan.state.pr;
  await runActions(plan, execution, choices, me.actor.actor_id, core, ctx);
  console.log(`\n✓ PR 回填完成（execution ${execution.execution_id}）`);
  console.log(`  MR：#${pr.pr_id} ${pr.url}——meta.pr_ref 已记录，随流程记录发布`);
  console.log('  下一步：人工合并后 sdlc done --manual-confirm pr_merged 走核验收尾。');
  return 0;
}
