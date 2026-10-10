// sdlc done（I4，D42/Design §3.5；v5=D59 人工路径转轨）：完成核验与归档收尾，两段——
// 第一段（归档准备）：git mv 到 .sdlc/archive/<YYYY-MM>-req-<id>/，meta
//   archive_status=prepared + archive_prepared 事件随归档提交发布，推送原需求分支
//   （= 原 MR source，不主干、不另开 MR）；停在「归档已准备，待人工合并」。
// 第二段（核验收尾，唯一入口 --manual-confirm pr_merged）：适配层终态
//   transition（幂等门）+ completion_recorded 事件落本地 journal + meta
//   completion_status 本地写——不追加收尾提交/推送（契约 §5、skill-core §7.6）。
// v5 证据边界：PR 状态不可回读（无 Codeup API 凭据）——合并事实唯一来源是
//   人工确认（source=manual 如实标注，不伪装 API 核实）；verified 枚举保留但
//   人工路径不可达（result 恒 manual|with_gaps）。
// 默认只检查/提示（预览恒 rc0）：不把命令名当已完成事实。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { findSdlcRoot, loadRepoConfig, evaluateDod } from '../config.js';
import { loadMeta } from '../meta.js';
import { buildPlan, renderPlan, savePlan, loadPlan } from '../plan.js';
import { newExecution, saveExecution, findExecutionByPlan } from '../execution.js';
import { currentBranch, branchSync, headSha, runGit } from '../gitops.js';
import { createCore } from '../meegle/index.js';
import { SdlcError } from '../errors.js';
import { sha256, canonical } from '../util.js';
import {
  resolveReqId, checkFreshness, runActions, deriveArchiveEvents, findUnfinishedExecutions,
} from './common.js';
import { findArchived, listActiveRequirements } from './status.js';

/**
 * @param {string[]} positional 位置参数（可选 req_id）
 * @param {Record<string, any>} flags
 * @returns {Promise<number>} 退出码
 */
export async function runDone(positional, flags = {}) {
  const root = findSdlcRoot(process.cwd());
  if (!root) {
    console.error('当前目录不在 sdlc 接入的仓库内（未找到 .sdlc/）。请先运行 sdlc init。');
    return 1;
  }
  const reqId = resolveReqId(root, positional); // 显式 id → 当前分支 → 唯一活跃
  if (flags.manualConfirm && flags.manualConfirm !== 'pr_merged') {
    throw new SdlcError('validation_failed', '--manual-confirm 目前仅支持 pr_merged');
  }
  const active = listActiveRequirements(root).find((a) => a.reqId === reqId);
  const archived = active ? null : findArchived(root, reqId);
  if (!active && !archived) {
    throw new SdlcError('not_found', `需求 ${reqId} 无本地档案（.sdlc/req-${reqId}/ 与 .sdlc/archive/ 均未找到）`);
  }
  const dir = active?.dir ?? archived.dir;
  const meta = loadMeta(path.join(dir, 'meta.yaml'));
  if (!meta) throw new SdlcError('not_found', `${dir} 无 meta.yaml，数据不完整`);
  const { config, configRevision } = loadRepoConfig(root);
  const branch = meta.branch;
  const cur = currentBranch(root);
  if (cur !== branch) {
    throw new SdlcError('validation_failed', `当前分支 ${cur ?? '(detached)'} 与需求分支 ${branch} 不一致——请先 sdlc start ${reqId} 恢复需求现场`);
  }
  const ctx = { root, reqId, dir, archived: Boolean(archived), meta, config, configRevision, branch, flags };
  if (flags.apply === undefined) return previewDone(ctx);
  return applyDone(ctx);
}

/**
 * done 预览：事实收集 + B 矩阵（v5 坍缩——PR 状态不可回读，合并证据唯一来源
 * 是 --manual-confirm）。只读（远端回读失败不阻塞，标未核实）。
 * 分支：B6 收尾已落 → B1a 无 MR → --manual-confirm → B4 已归档稳态 → B2 归档计划。
 * @param {DoneCtx} ctx
 * @returns {Promise<number>}
 */
async function previewDone(ctx) {
  const { root, reqId, dir, archived, meta, config, branch, flags } = ctx;
  const sync = branchSync(root);
  const core = createCore();
  /** @type {any} */
  let coreState = null;
  try {
    coreState = await core.requirementState(reqId);
  } catch {
    coreState = null; // 远端不可读不阻塞预览（未核实）
  }
  // DoD 缺口（B2 计划 gaps/complete 核验共用；pr_merged check 走 meta 人工确认语义）
  const dod = evaluateDod(config, dir, sync, meta.current_stage, { meta });
  const gapList = dod.filter((d) => d.status === 'gap');
  const gaps = gapList.map((d) => `${d.id}：${d.text}${d.note ? `（${d.note}）` : ''}`);
  const prLabel = meta.pr_ref
    ? `#${meta.pr_ref.pr_id}（状态不可回读——人工路径）${meta.pr_ref.url}`
    : '无';
  console.log(`需求 ${reqId}：${meta.title}（done 检查）`);
  console.log(`  位置：${archived ? `已归档 ${path.relative(root, dir)}` : '活跃'}；阶段：${meta.current_stage}；分支：${branch}`);
  console.log(`  MR：${prLabel}`);
  console.log(`  远端：${coreState ? `completion=${coreState.completion_status ?? 'pending'}（阶段 ${coreState.current_stage}）` : '未核实（不可读）'}`);
  if (meta.completion_status && meta.completion_status !== 'pending') {
    console.log(`  本地：completion=${meta.completion_status}（completion_recorded 留痕）`);
  }
  for (const u of findUnfinishedExecutions(reqId)) {
    console.log(`⚠ 存在未完成执行 ${u.execution_id}（plan ${u.plan_id.slice(0, 12)}…）——建议先 sdlc next --apply ${u.plan_id} 续做`);
  }

  // B6：收尾已落（远端终态或本地记录）→ 终态提示
  const completion = coreState?.completion_status;
  const localDone = typeof meta.completion_status === 'string' && meta.completion_status !== 'pending';
  if (completion === 'verified' || completion === 'manual' || completion === 'with_gaps' || localDone) {
    const src = completion && completion !== 'pending' ? `远端回读 ${completion}` : `本地记录 ${meta.completion_status}`;
    console.log(`\n✓ 已完成收尾（${src}）。归档位置：${archived ? path.relative(root, dir) : '目录未整理（提前合并场景）'}。`);
    return 0;
  }

  // 归档目录内未跟踪文件（git mv 前置，B2 第一段才需要）
  const untracked = archived ? [] : listUntrackedInReqDir(root, reqId);
  if (!archived && untracked.length > 0) {
    console.log(`\n⚠ 需求目录内有未跟踪文件（git mv 会拒绝）：${untracked.join('、')}——先 sdlc next --intent save 发布`);
  }

  // B1a：无 MR——不为归档另开 MR（D42）；可能未走 handoff 或未回填
  if (!meta.pr_ref) {
    console.log('\n尚无 MR 引用：完成交付需先经提测交接（sdlc next --intent handoff 输出创建链接，');
    console.log('人工创建 MR 后 sdlc next --pr-url <MR链接> 回填）——不为归档另开 MR。');
    return 0;
  }
  // 人工确认 → 第二段（complete）计划
  if (flags.manualConfirm === 'pr_merged') {
    return previewComplete(ctx, gaps);
  }
  // B4：已归档 → 待合并稳态
  if (archived) {
    console.log('\n归档已准备，待人工合并（不能宣称完整交付）。人工合并后走人工确认收尾：');
    console.log(`  sdlc done ${reqId} --manual-confirm pr_merged`);
    console.log(renderMergeRemind(meta));
    return 0;
  }
  // B2：活跃 + 有 MR 引用 → 第一段（归档准备）
  return previewArchive(ctx, sync, gaps);
}

/**
 * B2 第一段预览：归档准备计划（sync → archive_move → meta_done → journal →
 * archive_commit → publish_push——publish_push 即发布边界，自身不写事件）。
 * @param {DoneCtx} ctx @param {import('../gitops.js').GitSyncState} sync @param {string[]} gaps
 * @returns {number}
 */
function previewArchive(ctx, sync, gaps) {
  const { root, reqId, meta, branch, configRevision, flags } = ctx;
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const archiveDir = `.sdlc/archive/${month}-req-${reqId}`;
  if (existsSync(path.join(root, archiveDir))) {
    throw new SdlcError('validation_failed', `归档目录已存在 ${archiveDir}——请人工核对（可能旧归档/双份），CLI 不猜测覆盖`);
  }
  const actions = [];
  if (sync.behind) actions.push({ id: 'sync', title: '落后远端，先 git pull --ff-only 快进同步' });
  actions.push({ id: 'archive_move', title: `归档目录移动（.sdlc/req-${reqId}/ → ${archiveDir}/）`, args: { archive_dir: archiveDir, source_dir: `.sdlc/req-${reqId}` } });
  actions.push({ id: 'meta_done', title: '更新 meta（archive_status=prepared）' });
  actions.push({ id: 'journal', title: '追加流程事件（archive_prepared——随归档提交发布）' });
  actions.push({ id: 'archive_commit', title: `归档提交（chore(sdlc): ${reqId} 归档准备）` });
  actions.push({ id: 'publish_push', title: `推送 ${branch}（= 原 PR source，不走主干）` });

  const plan = buildPlan({
    reqId,
    title: meta.title,
    url: meta.feishu_url,
    repo: root,
    branch,
    intent: 'done 第一段：归档准备——待人工合并（D42）',
    actions,
    gaps,
    slots: [],
    facts: [
      `通道：${process.env.SDLC_MOCK === '1' ? 'mock（结论不作为已验证）' : 'meegle（飞书项目）'}`,
      `Git：${sync.raw || '（无跟踪信息）'}`,
      `MR #${meta.pr_ref.pr_id} 待人工合并（状态不可回读——人工路径，D59）——本计划停在「归档已准备」，不宣称完整交付`,
    ],
    state: {
      kind: 'done_archive',
      req_id: reqId,
      repo: root,
      branch,
      head_sha: headSha(root) ?? '',
      sync_raw: sync.raw,
      files: [],
      scope_all: [],
      config_revision: configRevision,
      stage: meta.current_stage,
      stage_version: meta.stage_version,
      archive_dir: archiveDir,
      pr: meta.pr_ref ? { pr_id: String(meta.pr_ref.pr_id) } : null,
    },
  });
  savePlan(plan);
  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  console.log(renderPlan(plan));
  console.log(`确认执行：sdlc done --apply ${plan.plan_id}`);
  console.log('（可加 --accept-gaps 接受缺口，留痕 gap_accepted；执行后停在「归档已准备，待人工合并」）');
  return 0;
}

/**
 * 第二段预览：complete 计划（单动作）。合并核验唯一来源 = --manual-confirm
 * pr_merged（人工确认，source=manual 如实标注——不伪装 API 核实）；result 恒
 * manual｜with_gaps（verified 保留枚举但人工路径不可达）。
 * @param {DoneCtx} ctx @param {string[]} gaps
 * @returns {number}
 */
function previewComplete(ctx, gaps) {
  const { root, reqId, meta, branch, configRevision, flags, archived } = ctx;
  const sync = branchSync(root);
  if (flags.manualConfirm !== 'pr_merged') {
    // previewDone 已分流到本函数的路径都带 manual-confirm——此处不可达，防御保留
    throw new SdlcError('validation_failed', 'complete 计划需 --manual-confirm pr_merged（合并核验唯一入口）');
  }

  /** @type {any} */
  const completion = {
    source: 'manual',
    result: flags.acceptGaps === true && gaps.length > 0 ? 'with_gaps' : 'manual',
    accepted_gaps: flags.acceptGaps === true ? gaps : [],
  };
  const actions = [{
    id: 'complete',
    title: `飞书终态 transition + 收尾记录（completion=${completion.result}，source=manual）`,
    args: { pr: { repo: meta.pr_ref.repo, pr_id: String(meta.pr_ref.pr_id), url: meta.pr_ref.url }, completion },
  }];
  const plan = buildPlan({
    reqId,
    title: meta.title,
    url: meta.feishu_url,
    repo: root,
    branch,
    intent: 'done 第二段：人工确认合并后核验收尾（D42/D59）',
    actions,
    gaps,
    slots: [],
    facts: [
      `通道：${process.env.SDLC_MOCK === '1' ? 'mock（结论不作为已验证）' : 'meegle（飞书项目）'}`,
      `MR：#${meta.pr_ref.pr_id} ${meta.pr_ref.url}`,
      '人工确认（--manual-confirm pr_merged）：PR 状态不可回读——如实标注 source=manual，不伪装 API 核实',
      `核验缺口：${gaps.length > 0 ? gaps.join('；') + (flags.acceptGaps === true ? '（已接受，result=with_gaps）' : '（未接受——result=manual 随请求如实记录）') : '无'}`,
      '本地留痕：completion_recorded 事件 + meta completion_status 落本地，不追加收尾提交（契约 §5）',
    ],
    state: {
      kind: 'done_complete',
      req_id: reqId,
      repo: root,
      branch,
      head_sha: headSha(root) ?? '',
      sync_raw: sync.raw,
      files: [],
      scope_all: [],
      config_revision: configRevision,
      stage: meta.current_stage,
      stage_version: meta.stage_version,
      archived,
      profile: meta.profile,
      pr: { pr_id: String(meta.pr_ref.pr_id), source_kind: 'manual' },
      completion,
    },
  });
  savePlan(plan);
  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  if (gaps.length > 0 && flags.acceptGaps !== true) {
    console.log('\n核验缺口（人工确认后仍如实记录 result=manual，缺口随 accepted_gaps 传空）：');
    for (const g of gaps) console.log(`  - ${g}`);
    console.log('（可加 --accept-gaps 接受遗留，result=with_gaps 随请求记录）');
  }
  console.log(renderPlan(plan));
  console.log(`确认执行：sdlc done --apply ${plan.plan_id}`);
  return 0;
}

/**
 * @param {DoneCtx} ctx
 * @returns {Promise<number>}
 */
async function applyDone(ctx) {
  const { root, flags } = ctx;
  if (flags.apply === true) {
    throw new SdlcError('validation_failed', 'done 的 --apply 需要 plan_id 值（见预览输出的「确认执行」一行）');
  }
  const plan = loadPlan(String(flags.apply));
  if (!plan?.state || (plan.state.kind !== 'done_archive' && plan.state.kind !== 'done_complete')) {
    throw new SdlcError('validation_failed', 'plan_id 无本机存档（或非 done 计划）——请重新 sdlc done 预览生成新计划');
  }
  const kind = plan.state.kind;
  const choices = {
    intent: kind,
    subject: kind === 'done_archive' ? `${plan.req_id} 归档准备` : `${plan.req_id} 完成收尾`,
    accept_gaps: flags.acceptGaps === true,
    no_actions: Object.keys(flags.no ?? {}).sort(),
    manual_confirm: flags.manualConfirm ?? null,
  };
  // 第二段：--accept-gaps 是 apply 期选择（choices 参与指纹，重跑一致）——预览固
  // 化 verified，接受时改写 completion 随请求传 core（本地零写：gap_accepted 不落 journal）
  if (kind === 'done_complete' && choices.accept_gaps && plan.gaps.length > 0) {
    const act = plan.actions[0];
    act.args.completion.result = 'with_gaps';
    act.args.completion.accepted_gaps = plan.gaps;
  }

  let execution = findExecutionByPlan(plan.plan_id);
  if (!execution) {
    if (kind === 'done_archive') {
      const fresh = checkFreshness(root, plan);
      if (fresh.stale) {
        throw new SdlcError('validation_failed', `计划已过期（${fresh.stale}），请重新 sdlc done 预览`);
      }
    } else {
      // 第二段 freshness：core completion 仍 pending + PR 状态与存档一致（core 侧裁决）
      const core = createCore();
      const st = await core.requirementState(plan.req_id);
      if (st.completion_status && st.completion_status !== 'pending') {
        throw new SdlcError('validation_failed', `core 已记录收尾（completion=${st.completion_status}）——无需重复执行`);
      }
    }
    execution = newExecution(plan.plan_id, choices, plan.req_id);
    saveExecution(execution);
  } else if (execution.choices_hash !== sha256(canonical(choices))) {
    throw new SdlcError('validation_failed', '同一执行不可更改参数（choices 不一致）——改变决定请重新 sdlc done 预览生成新计划');
  }

  const core = createCore();
  const me = await core.me();
  // done 两段都从存档 state 恢复 reqDir（第一段执行中目录会移动——引擎 loc 切换；
  // 第二段 complete 的本地留痕落归档/活跃实际位置）
  const reqDir = kind === 'done_archive'
    ? path.join(root, `.sdlc/req-${plan.req_id}`)
    : (plan.state.archived
      ? (findArchived(root, plan.req_id)?.dir ?? path.join(root, `.sdlc/req-${plan.req_id}`))
      : path.join(root, `.sdlc/req-${plan.req_id}`));
  const doneCtx = { root, reqId: plan.req_id, reqDir, meta: ctx.meta, config: ctx.config, configRevision: ctx.configRevision, branch: plan.branch };
  const opts = kind === 'done_archive' ? { deriveEvents: deriveArchiveEvents } : {};
  await runActions(plan, execution, choices, me.actor.actor_id, core, doneCtx, opts);

  // 汇总
  console.log(`\n✓ done 执行完成（execution ${execution.execution_id}）`);
  if (kind === 'done_archive') {
    const moved = execution.actions.archive_move?.status === 'ok';
    const noSet = new Set(/** @type {string[]} */ (choices.no_actions));
    if (moved && !noSet.has('publish_push')) {
      console.log(`  归档已准备：${plan.state.archive_dir}（已提交并推送 ${plan.branch}）`);
      console.log('  待人工合并——不宣称完整交付；人工合并后 sdlc done --manual-confirm pr_merged 走核验收尾。');
    } else {
      console.log('  ⚠ 归档未完成（--no-archive_move 留痕或推送被跳过）——不宣称归档已准备。');
    }
  } else {
    const resp = execution.actions.complete?.detail?.resp;
    console.log(`  收尾已记录：completion=${resp?.completion_status ?? '?'}（source=${resp?.source ?? '?'}）——飞书终态已落，本地留痕不追加收尾提交。`);
    console.log('  （completion_recorded 事件与 meta 随下次发布自然收走；换机可 sdlc status 查询远端终态）');
  }
  return 0;
}

/**
 * 归档目录（.sdlc/req-<id>/）内未跟踪文件（git mv 会拒绝）。
 * @param {string} root @param {string} reqId
 * @returns {string[]}
 */
function listUntrackedInReqDir(root, reqId) {
  const r = runGit(['status', '--porcelain', '--untracked-files=all', '--', `.sdlc/req-${reqId}`], root);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim());
}

/**
 * 待合并提醒话术（B4 只读输出 / next save remind_merge 事件同语义）。
 * v5：PR 状态不可回读——话术基于本地 pr_ref，发送前请人工核对。
 * @param {any} meta
 * @returns {string}
 */
function renderMergeRemind(meta) {
  return [
    '  待合并提醒（可复制转发）：',
    '  ---',
    `  【${meta.req_id} ${meta.title}】MR #${meta.pr_ref.pr_id} 待人工合并：${meta.pr_ref.url}`,
    `    归档已准备（.sdlc/archive/），合并后 sdlc done ${meta.req_id} --manual-confirm pr_merged 走核验收尾`,
    '  ---',
    '  （PR 状态不可回读——话术基于本地 pr_ref，发送前请核对）',
  ].join('\n');
}

/**
 * @typedef {object} DoneCtx
 * @property {string} root
 * @property {string} reqId
 * @property {string} dir
 * @property {boolean} archived
 * @property {any} meta
 * @property {any} config
 * @property {string} configRevision
 * @property {string} branch
 * @property {Record<string, any>} flags
 */
