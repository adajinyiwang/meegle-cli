// sdlc next --request-change（I4，契约 §3.3 change / D38）：显式阶段回退。
// 平行 flag（非第三种 intent）：说明文本随计划固化，恢复重跑不重传。
// 预览 = meegle 适配层回读（D45 不以本地覆盖远端）+ 回退候选（stages 序中
// current 之前全部阶段）→ 计划存档；apply = choices 锁定（to ⊆ 候选）+ 统一
// 动作引擎（幂等门在适配层，I6b）。不动任务与 PR——同分支同 PR 语义（回退
// 只改阶段与说明留痕）。change_request 事件由引擎 change case 自身持久化
//（发布前记录，契约 §5）。授权（D38：当前阶段或产品参与人）= 飞书原生权限，
// 客户端不预判（D59）。
import { loadPlan, buildPlan, renderPlan, savePlan } from '../plan.js';
import { newExecution, saveExecution, findExecutionByPlan } from '../execution.js';
import { branchSync, headSha } from '../gitops.js';
import { createCore } from '../meegle/index.js';
import { SdlcError } from '../errors.js';
import { sha256, canonical } from '../util.js';
import {
  collectScope, narrowScope, digestOf, checkFreshness, renderDiffs,
  currentGaps, findUnfinishedExecutions, runActions,
} from './common.js';

/**
 * 预览回退：适配层回读 + 候选/范围收集 → 计划存档。
 * @param {any} ctx（next.js 构造：root/reqId/reqDir/meta/config/configRevision/branch/flags）
 * @returns {Promise<number>}
 */
export async function previewChange(ctx) {
  const { root, reqId, meta, config, configRevision, branch, flags } = ctx;
  const reason = String(flags.requestChange).trim();
  const core = createCore();
  let state;
  try {
    state = await core.requirementState(reqId);
  } catch (e) {
    throw new SdlcError('external_unavailable', `飞书项目回读失败（${e?.message ?? e}）——回退依赖远端阶段事实（D45），不可离线猜测`);
  }
  // D45 新鲜度：v5 纯阶段比较（远端无版本——stage_version 是本地观察链）
  if (state.current_stage !== meta.current_stage) {
    throw new SdlcError('validation_failed', `远端阶段（${state.current_stage ?? '（未识别）'}）与本地快照（${meta.current_stage}）不一致——先 sdlc status ${reqId} 核对（D45：不以本地 journal 覆盖远端事实）`);
  }

  // 回退候选：stages 序中 current 之前全部阶段（prd → 无候选；单候选缺省，多候选 slots）
  const stages = config.stages ?? [];
  const idx = stages.findIndex((s) => s.id === meta.current_stage);
  if (idx < 1) {
    throw new SdlcError('validation_failed', `阶段 ${meta.current_stage} 无可回退方向${idx === 0 ? '（首阶段）' : '（不在配置 stages 序中）'}——回退需远端确认的更早阶段`);
  }
  const candidates = stages.slice(0, idx).map((s) => s.id);
  if (flags.to && !candidates.includes(flags.to)) {
    throw new SdlcError('validation_failed', `--to 候选外：${flags.to}（候选：${candidates.join('、')}）`);
  }
  const to = flags.to ?? (candidates.length === 1 ? candidates[0] : null); // 多候选未指定 → slots，apply 时 --to 勾选

  const { scope, excluded, flowDirty } = collectScope(root, reqId);
  const scopePaths = narrowScope(scope.map((d) => d.path), flags);
  const sync = branchSync(root);

  const actions = [];
  if (sync.behind) actions.push({ id: 'sync', title: '落后远端，先 git pull --ff-only 快进同步' });
  if (scopePaths.length > 0) actions.push({ id: 'commit', title: `提交回退产物（${scopePaths.length} 个文件——回退常带报告更新）`, args: { files: scopePaths } });
  if (scopePaths.length > 0 || sync.ahead) actions.push({ id: 'push', title: `推送 ${branch}` });
  actions.push({ id: 'change', title: `回退 ${meta.current_stage} → ${to ?? '（--to 指定）'}（说明：${reason}）`, args: { from: meta.current_stage, to, reason } });
  actions.push({ id: 'meta_update', title: '更新 meta（阶段/观察链/timeline reentered）' });
  actions.push({ id: 'journal', title: '追加流程事件（change_request）' });
  actions.push({ id: 'publish_commit', title: '提交流程记录（journal.jsonl + meta.yaml）' });
  actions.push({ id: 'publish_push', title: '推送流程记录' });

  // gaps 不含 git_synced：push 动作正是修复它（同 save）
  const gaps = currentGaps(ctx, sync).filter((g) => g.check !== 'git_synced').map((d) => `${d.id}：${d.text}${d.note ? `（${d.note}）` : ''}`);
  const plan = buildPlan({
    reqId,
    title: meta.title,
    url: meta.feishu_url,
    repo: root,
    branch,
    intent: `回退：${meta.current_stage} → ${to ?? '?'}（说明留痕，D38 授权归 core）`,
    actions,
    gaps,
    slots: to ? [] : [{ slot: 'to', candidates, chosen: null }],
    facts: [
      `通道：${core.mock ? 'mock（结论不作为已验证）' : 'meegle（飞书项目）'}`,
      `远端阶段：${state.current_stage}`,
      `回退说明（change_request 留痕）：${reason}`,
      `Git：${sync.raw || '（无跟踪信息）'}`,
      ...(to ? [`回退目标：${to}（候选 ${candidates.join('、')}）`] : [`回退候选：${candidates.join('、')}——apply 时 --to <stage> 勾选`]),
      ...(excluded.length > 0 ? [`范围外脏文件（默认不含）：${excluded.map((d) => d.path).join('、')}`] : []),
      `建议 subject：回退 ${reqId} 至 ${to ?? '<stage>'}`,
    ],
    state: {
      req_id: reqId,
      repo: root,
      branch,
      head_sha: headSha(root) ?? '',
      sync_raw: sync.raw,
      files: scopePaths.map((p) => ({ path: p, digest: digestOf(root, p) })),
      scope_all: scope.map((d) => d.path),
      config_revision: configRevision,
      stage: meta.current_stage,
      stage_version: meta.stage_version,
      // change 扩展（防外部夹带：apply 时与远端再比对——v5 纯阶段）
      request_change: reason,
      to,
      core_stage: state.current_stage,
      profile: state.profile ?? meta.profile,
    },
  });
  savePlan(plan);

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  for (const u of findUnfinishedExecutions(reqId)) {
    console.log(`⚠ 存在未完成执行 ${u.execution_id}（plan ${u.plan_id.slice(0, 12)}…）——建议先 sdlc next --apply ${u.plan_id} 续做（D39：先识别旧执行）`);
  }
  console.log(renderPlan(plan));
  console.log(`确认执行：sdlc next --apply ${plan.plan_id}${to ? '' : ' --to <stage>（从候选槽位勾选）'}`);
  return 0;
}

/**
 * apply 回退：choices 锁定（to 必须 ∈ 候选）+ 新鲜度（本地 + 远端段）+ 统一
 * 动作引擎。恢复 = 重跑 `sdlc next --apply <plan_id> [--to <同值>]`（choices_hash
 * 必须一致；说明已固化在 plan.state，不重传）。
 * @param {any} ctx
 * @returns {Promise<number>}
 */
export async function applyChange(ctx) {
  const { root, flags } = ctx;
  if (flags.apply === true) {
    throw new SdlcError('validation_failed', 'next 的 --apply 需要 plan_id 值（见预览输出的「确认执行」一行）');
  }
  const plan = loadPlan(String(flags.apply));
  if (!plan || !plan.state?.request_change) {
    throw new SdlcError('validation_failed', 'plan_id 无本机存档（或非回退计划）——请重新 sdlc next --request-change "<说明>" 预览');
  }
  const toCandidates = plan.state.to
    ? [plan.state.to]
    : (plan.slots.find((s) => s.slot === 'to')?.candidates ?? []);
  const to = plan.state.to ?? flags.to;
  if (!to) {
    throw new SdlcError('validation_failed', `回退目标未指定——请加 --to <stage>（候选：${toCandidates.join('、')}）`);
  }
  if (flags.to && flags.to !== to) {
    throw new SdlcError('validation_failed', `--to 与计划不符（本计划 to=${to ?? '未定，候选 ' + toCandidates.join('、')}）——改变目标请重新预览`);
  }
  if (!toCandidates.includes(to)) {
    throw new SdlcError('validation_failed', `--to 候选外：${to}（候选：${toCandidates.join('、')}）`);
  }
  const choices = {
    intent: 'change',
    subject: typeof flags.message === 'string' && flags.message.trim() !== '' ? flags.message.trim() : `回退 ${plan.req_id} 至 ${to}`,
    accept_gaps: flags.acceptGaps === true,
    no_actions: Object.keys(flags.no ?? {}).sort(),
    to,
  };

  let execution = findExecutionByPlan(plan.plan_id);
  if (!execution) {
    // 全新 apply：本地新鲜度 + 远端段（core 阶段与存档比对——防外部夹带）
    const fresh = checkFreshness(root, plan);
    if (fresh.stale) {
      throw new SdlcError('validation_failed', `计划已过期（${fresh.stale}），请重新 sdlc next --request-change 预览`);
    }
    if (fresh.diffs.length > 0 && flags.acceptDiffs !== true) {
      renderDiffs(root, fresh.diffs);
      console.error('以上文件内容与预览时不同（防中继夹带）。确认新内容：加 --accept-diffs 重跑；拒绝：重新预览。');
      return 1;
    }
    let core;
    try {
      core = createCore();
      const st = await core.requirementState(plan.req_id);
      // v5 纯阶段比较（远端无版本）
      if (st.current_stage !== plan.state.core_stage) {
        throw new SdlcError('validation_failed', `计划已过期（远端阶段已变化：${st.current_stage}），请重新预览`);
      }
    } catch (e) {
      // 主动抛的过期判断要上抛；其余（网络/未登录）不阻塞预检——执行期外部动作自会暴露
      if (e instanceof SdlcError && (e.code === 'unauthorized' || e.code === 'validation_failed')) throw e;
    }
    execution = newExecution(plan.plan_id, choices, plan.req_id);
    saveExecution(execution); // 首个写动作前持久化选择（契约 §6）
  } else if (execution.choices_hash !== sha256(canonical(choices))) {
    throw new SdlcError('validation_failed', '同一执行不可更改参数（choices 不一致——恢复重跑需带相同 --to 等参数）——改变决定请重新预览');
  }

  const core = createCore();
  const me = await core.me(); // journal actor；real 模式未登录走 D57 自动登录
  return executeChange(plan, execution, choices, me.actor.actor_id, core, ctx);
}

/**
 * 回退执行：统一动作引擎（change_request 事件由 change case 落）+ 汇总话术
 * （change 未成 → 不宣称已回退，design §4 否决语义）。
 * @param {any} plan @param {any} execution @param {Record<string, unknown>} choices
 * @param {string} actor @param {import('../meegle/index.js').Core} core @param {any} ctx
 * @returns {Promise<number>}
 */
async function executeChange(plan, execution, choices, actor, core, ctx) {
  // 槽位计划：apply 勾选的 to 回填（change case 与 meta_update 都从 plan 消费，
  // choices 只锁选择；plan_id 已在存档时固化，回填不改指纹）
  const changeAct = plan.actions.find((a) => a.id === 'change');
  if (changeAct && !changeAct.args.to) changeAct.args.to = choices.to;
  if (!plan.state.to) plan.state.to = choices.to;
  await runActions(plan, execution, choices, actor, core, ctx);

  const chg = execution.actions.change;
  console.log(`\n✓ 回退执行完成（execution ${execution.execution_id}）`);
  if (chg?.status === 'ok') {
    const resp = chg.detail?.resp;
    if (resp) console.log(`  阶段：${plan.state.stage} → ${choices.to}（v${resp.from_version ?? '—'} → v${resp.to_version ?? '—'}${resp.idempotent ? '，远端已在位幂等重放' : ''}）`);
    console.log(`  说明留痕：${plan.state.request_change}（change_request 事件随流程记录发布）`);
    console.log('  （任务与 PR 不动——同分支同 PR；接手方 sdlc start 恢复现场）');
    if (core.mock) console.log('  （mock 模式：以上结论不作为已验证）');
  } else {
    console.log('  ⚠ 阶段未回退（change 未执行/被跳过/失败）——不宣称已完成回退（design §4 否决语义）');
  }
  return 0;
}
