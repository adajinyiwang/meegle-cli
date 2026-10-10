// sdlc next --intent handoff：明确交接全链（client/design §3.3 / D41 / D48）。
// 预览 = meegle 适配层回读（阶段/任务，D45 不以本地覆盖远端）+ 任务块 diff
//（v5 双层标识：Tn ↔ remote_id 经 tasks_map/标题桥接）+ PR 链接（D59 人工
// 路径）/advance 判定 → 计划存档；apply = choices 锁定（to/tasks）+ 统一动作
// 引擎（common.js runActions——幂等门在适配层）+ 交接话术。
// handoff_prepared 事件在 journal 步骤落（发布前记录，契约 §5 发布边界）。
import path from 'node:path';
import { loadPlan, buildPlan, renderPlan, savePlan } from '../plan.js';
import { newExecution, saveExecution, findExecutionByPlan } from '../execution.js';
import { makeEvent } from '../journal.js';
import { parseTasksFile } from '../tasks.js';
import { branchSync, headSha, repoSlug, repoWebUrl } from '../gitops.js';
import { createCore } from '../meegle/index.js';
import { SdlcError } from '../errors.js';
import { sha256, canonical } from '../util.js';
import {
  collectScope, narrowScope, digestOf, checkFreshness, renderDiffs,
  currentGaps, findUnfinishedExecutions, runActions, deriveChoiceEvents,
} from './common.js';

/**
 * 任务同步 diff（契约 §8：本地任务块 ↔ 远端清单）。v5 双层标识：本地 Tn 与
 * 远端 remote_id 经 tasks_map（meta，随 Git 跨机）桥接；映射丢失按标题回查
 * 重建（recovered 随 meta_update 回写——同名标题不是可靠的未创建证据）。
 * 解析失败 → errors 非空，任务同步两动作整体不进计划（其他动作不受影响）。
 * @param {import('../tasks.js').TasksParseResult} parsed
 * @param {{id: string, title: string, state: string}[]} remoteTasks  id = 远端标识
 * @param {Record<string, string>} tasksMap  Tn → remote_id
 * @returns {{errors: string[] | null, split: {id: string, title: string, assignee_role: string, estimate?: number, state?: string}[], cancels: {id: string, title: string, remote_id: string}[], completions: {id: string, title: string}[], resolved: Record<string, {title: string, remote_id: string}>, recovered: Record<string, string>}}
 */
function taskDiff(parsed, remoteTasks, tasksMap = {}) {
  const result = { errors: null, split: [], cancels: [], completions: [], resolved: {}, recovered: {} };
  if (parsed.errors.length > 0) { result.errors = parsed.errors; return result; }
  if (!parsed.found) return result; // 无任务块只是提示（模板注释语义）
  const byRemote = new Map(remoteTasks.map((t) => [t.id, t]));
  const byTitle = new Map(remoteTasks.map((t) => [t.title, t]));
  /** 本地 Tn → 远端任务（映射 → 标题两级回查） */
  const matched = new Map();
  for (const t of parsed.tasks) {
    const m = (tasksMap[t.id] ? byRemote.get(tasksMap[t.id]) : undefined) ?? byTitle.get(t.title);
    if (m) {
      matched.set(t.id, m);
      result.resolved[t.id] = { title: m.title, remote_id: m.id };
      if (tasksMap[t.id] !== m.id) result.recovered[t.id] = m.id; // 映射丢失回查重建
    } else {
      result.split.push(t); // 本地有、远端无对应 → 增量创建
    }
  }
  for (const [tn, r] of matched) {
    if (r.state === 'open') result.completions.push({ id: tn, title: r.title }); // 勾选候选
  }
  for (const t of parsed.tasks) {
    const r = matched.get(t.id);
    if (t.state === 'cancelled' && r?.state === 'open') result.cancels.push({ id: t.id, title: r.title, remote_id: r.id }); // 远端 open ∩ 本地取消
  }
  return result;
}

/**
 * 预览交接：core 回读 + 任务 diff + PR/advance 判定 → 计划存档。
 * @param {any} ctx（next.js 构造：root/reqId/reqDir/meta/config/configRevision/branch/flags）
 * @returns {Promise<number>}
 */
export async function previewHandoff(ctx) {
  const { root, reqId, reqDir, meta, config, configRevision, branch, flags } = ctx;
  const core = createCore();
  let state;
  try {
    state = await core.requirementState(reqId);
  } catch (e) {
    throw new SdlcError('external_unavailable', `飞书项目回读失败（${e?.message ?? e}）——交接依赖远端阶段/任务事实；本地保存可用 sdlc next --intent save`);
  }
  // D45 新鲜度：v5 纯阶段比较（远端无版本——stage_version 是本地观察链，等值比较退役）。
  // 宽容一档：远端已在本阶段 next（交接推进已被人在页面完成）时放行——advance 动作
  // 幂等 no-op（advanceTo ensure 语义），本地 meta 随 meta_update 对齐远端，不覆盖远端事实。
  // 再宽容一档：current null（无映射的中间节点 doing——追赶路径上的正常停顿，如
  // tech 链「测试环境部署」；或流转后待认领态）放行给 advance 裁决——追赶流转/
  // 入口任务激活到不了目标会如实报错，不会静默破坏（R4 实测 7131703974）。
  const curStage = (config.stages ?? []).find((s) => s.id === meta.current_stage);
  const nextId = curStage?.next;
  if (state.current_stage !== meta.current_stage && state.current_stage !== nextId
    && state.current_stage !== null) {
    throw new SdlcError('validation_failed', `远端阶段（${state.current_stage ?? '（未识别）'}）与本地快照（${meta.current_stage}）不一致——先 sdlc status ${reqId} 核对（D45：不以本地 journal 覆盖远端事实）`);
  }
  if (!nextId) throw new SdlcError('validation_failed', `阶段 ${meta.current_stage} 无后续交接方向（收尾走 sdlc done）`);
  const nextStage = (config.stages ?? []).find((s) => s.id === nextId);
  if (nextId === 'done' || !nextStage) {
    throw new SdlcError('validation_failed', `当前阶段的下一步是 ${nextId}——收尾流程走 sdlc done（I4+）`);
  }
  if (flags.to && flags.to !== nextId) {
    throw new SdlcError('validation_failed', `--to 候选外：${flags.to}（本阶段唯一候选 ${nextId}）`);
  }
  const to = nextId;

  const { scope, excluded, flowDirty } = collectScope(root, reqId);
  const scopePaths = narrowScope(scope.map((d) => d.path), flags);
  const sync = branchSync(root);

  // 任务块路径：当前阶段 tasks_parseable 的 path（配置驱动；无该 check → 缺省约定路径）
  const tasksRel = (curStage?.dod ?? []).find((d) => d.check === 'tasks_parseable')?.path ?? `${meta.current_stage}/tasks.md`;
  const diff = taskDiff(parseTasksFile(path.join(reqDir, tasksRel)), state.tasks ?? [], meta.tasks_map ?? {});

  // PR 判定（D41 ∩ D59 人工路径）：from 阶段 DoD 含 pr_exists 且 meta 无 pr_ref →
  // 输出预填参数的 MR 创建链接（Codeup 形状，M1 #30）；origin 不可解析则退化
  // 为参数清单话术（人工自建），不阻塞交接
  const prNeeded = (curStage?.dod ?? []).some((d) => d.check === 'pr_exists') && !meta.pr_ref;
  const repo = repoSlug(root);
  const prTarget = config.git?.trunk ?? 'master';
  const prTitle = `[${reqId}] ${meta.title}：${meta.current_stage} 交接进入 ${to}`;
  const webBase = prNeeded ? repoWebUrl(root) : null;
  const createUrl = webBase
    ? `${webBase}/change/merge_request_create?srcBranch=${encodeURIComponent(branch)}&destBranch=${encodeURIComponent(prTarget)}&title=${encodeURIComponent(prTitle)}`
    : null;

  // 入口任务（D48：按 title 匹配勾选，配置于 feishu 档案的目标阶段节点）
  const entryTasks = config.feishu?.profiles?.[meta.profile]?.stage_nodes?.[to]?.entry_tasks ?? [];

  // 动作序列（D41 顺序）
  const actions = [];
  if (sync.behind) actions.push({ id: 'sync', title: '落后远端，先 git pull --ff-only 快进同步' });
  if (scopePaths.length > 0) actions.push({ id: 'commit', title: `提交确认产物（${scopePaths.length} 个文件）`, args: { files: scopePaths } });
  if (scopePaths.length > 0 || sync.ahead) actions.push({ id: 'push', title: `推送 ${branch}` });
  if (diff.split.length > 0) {
    // estimate/state 随任务走（R4 实测 7131581708）：estimate 驱动 splitTasks 的
    // 自动排期/估分；state=completed 的任务创建后即勾选（common.js tasks_split）
    actions.push({ id: 'tasks_split', title: `新增粗任务（${diff.split.map((t) => t.id).join('、')}）——远端增量创建（本地已完成的创建后即勾选）`, args: { tasks: diff.split.map(({ id, title, assignee_role, estimate, state }) => ({ id, title, assignee_role, estimate, state })) } });
  }
  if (diff.cancels.length > 0 || diff.completions.length > 0) {
    actions.push({ id: 'tasks_check', title: `任务状态同步（完成勾选走 --tasks；取消：${diff.cancels.map((c) => c.id).join('、') || '无'}）`, args: { cancels: diff.cancels } });
  }
  if (prNeeded) actions.push({ id: 'pr_create', title: `输出 MR 创建链接（${branch} → ${prTarget}，人工在 Codeup 创建后回填 --pr-url）`, args: { repo, source: branch, target: prTarget, create_url: createUrl } });
  actions.push({ id: 'advance', title: `推进进入 ${to}（自动连续确认中间节点，未推进的前置节点一并推进）`, args: { from: meta.current_stage, to, entry_tasks: entryTasks } });
  actions.push({ id: 'meta_update', title: '更新 meta（阶段/观察链/tasks_map/brief）' });
  actions.push({ id: 'journal', title: '追加流程事件（task_synced/stage_advance/handoff_prepared）' });
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
    intent: `交接：${meta.current_stage} → ${to}（任务同步 + PR 链接 + 阶段推进，D41/D59）`,
    actions,
    gaps,
    slots: diff.completions.length > 0 ? [{ slot: 'tasks', candidates: diff.completions.map((c) => c.id), chosen: null }] : [],
    facts: [
      `通道：${core.mock ? 'mock（结论不作为已验证）' : 'meegle（飞书项目）'}`,
      `远端阶段：${state.current_stage}（任务 ${(state.tasks ?? []).length} 项）`,
      `入口任务（${to} 阶段拆分任务后勾选）：${entryTasks.join('、') || '无配置'}`,
      `Git：${sync.raw || '（无跟踪信息）'}`,
      ...(diff.errors ? [`任务块解析失败，跳过任务同步（契约 §8）：${diff.errors.join('；')}`] : []),
      ...(diff.split.length > 0 ? [`新增粗任务：${diff.split.map((t) => `${t.id} ${t.title}`).join('、')}`] : []),
      ...(Object.keys(diff.recovered).length > 0 ? [`映射回查重建：${Object.entries(diff.recovered).map(([id, rid]) => `${id}→${rid}`).join('、')}`] : []),
      ...(diff.completions.length > 0 ? [`完成候选（--tasks 勾选）：${diff.completions.map((c) => `${c.id}（${c.title}）`).join('、')}`] : []),
      ...(prNeeded ? (createUrl ? [`输出 MR 创建链接：${branch} → ${prTarget}（人工创建后 sdlc next --pr-url 回填）`] : ['origin 不可解析——pr_create 将输出参数清单（人工自建 MR）']) : (meta.pr_ref ? ['meta 已有 PR 引用，不重复输出创建链接'] : [])),
      ...(excluded.length > 0 ? [`范围外脏文件（默认不含）：${excluded.map((d) => d.path).join('、')}`] : []),
      `建议 subject：交接 ${reqId} 进入 ${to}`,
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
      // handoff 扩展（防外部夹带：apply 时与远端再比对）
      to,
      entry_tasks: entryTasks,
      core_stage: state.current_stage,
      tasks_remote: (state.tasks ?? []).map(({ id, state: s }) => ({ id, state: s })),
      // v5：Tn→远端任务解析（勾选项带 title/remote_id）+ 标题回查重建映射 + profile
      tasks_resolved: diff.resolved,
      tasks_recovered: diff.recovered,
      profile: state.profile ?? meta.profile,
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
  // R3 直通：--auto 预览即执行（sidecar 白名单）；有未完成执行转人工续做
  if (flags.auto === true) {
    if (unfinished.length > 0) {
      console.log('✗ --auto 中止：存在未完成执行（见上 ⚠）——先 --apply 续做或处理后再直通');
      return 1;
    }
    flags.apply = plan.plan_id;
    console.log('▶ --auto 直通执行（免确认白名单，失败即停转述）…');
    return applyHandoff(ctx);
  }
  console.log(`确认执行：sdlc next --apply ${plan.plan_id}${diff.completions.length > 0 ? ` --tasks <id,id,…>（从候选槽位勾选，不勾则跳过完成同步）` : ''}`);
  return 0;
}

/**
 * apply 交接：choices 锁定（to 必须 === 计划；tasks ⊆ 候选）+ 新鲜度（本地 + 远端段）
 * + 统一动作引擎。恢复 = 重跑同命令同参数（choices_hash 必须一致）。
 * @param {any} ctx
 * @returns {Promise<number>}
 */
export async function applyHandoff(ctx) {
  const { root, flags } = ctx;
  if (flags.apply === true) {
    throw new SdlcError('validation_failed', 'next 的 --apply 需要 plan_id 值（见预览输出的「确认执行」一行）');
  }
  const plan = loadPlan(String(flags.apply));
  if (!plan || !plan.state?.to) {
    throw new SdlcError('validation_failed', 'plan_id 无本机存档（或非交接计划）——请重新 sdlc next --intent handoff 预览');
  }
  const to = plan.state.to;
  if (flags.to && flags.to !== to) {
    throw new SdlcError('validation_failed', `--to 与计划不符（本计划 to=${to}）——改变目标请重新预览`);
  }
  const taskCandidates = plan.slots.find((s) => s.slot === 'tasks')?.candidates ?? [];
  /** @type {string[]} */
  let tasks = [];
  if (flags.tasks) {
    tasks = String(flags.tasks).split(',').map((s) => s.trim()).filter(Boolean);
    for (const t of tasks) {
      if (!taskCandidates.includes(t)) {
        throw new SdlcError('validation_failed', `--tasks 候选外：${t}（候选：${taskCandidates.join('、') || '无'}）`);
      }
    }
  }
  const choices = {
    intent: 'handoff',
    subject: typeof flags.message === 'string' && flags.message.trim() !== '' ? flags.message.trim() : `交接 ${plan.req_id} 进入 ${to}`,
    accept_gaps: flags.acceptGaps === true,
    no_actions: Object.keys(flags.no ?? {}).sort(),
    to,
    tasks,
  };

  let execution = findExecutionByPlan(plan.plan_id);
  if (!execution) {
    // 全新 apply：本地新鲜度 + 远端段（core 阶段/任务与存档比对——防外部夹带）
    const fresh = checkFreshness(root, plan);
    if (fresh.stale) {
      throw new SdlcError('validation_failed', `计划已过期（${fresh.stale}），请重新 sdlc next --intent handoff 预览`);
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
      // v5 纯阶段比较（远端无版本）；任务清单按远端标识比对（防外部夹带）。
      // 按 id 排序后比对——get-node 全表聚合的任务顺序跨调用不稳定（实测 M1），
      // 顺序敏感比较会把「同集合」误判为变化。
      if (st.current_stage !== plan.state.core_stage) {
        throw new SdlcError('validation_failed', `计划已过期（远端阶段已变化：${st.current_stage}），请重新预览`);
      }
      const byId = (a, b) => String(a.id).localeCompare(String(b.id));
      const curTasks = (st.tasks ?? []).map(({ id, state }) => ({ id, state })).sort(byId);
      const savedTasks = [...(plan.state.tasks_remote ?? [])].sort(byId);
      if (canonical(curTasks) !== canonical(savedTasks)) {
        throw new SdlcError('validation_failed', '计划已过期（远端任务清单变化），请重新预览');
      }
    } catch (e) {
      // 主动抛的过期判断要上抛；其余（网络/未登录）不阻塞预检——执行期外部动作自会暴露
      if (e instanceof SdlcError && (e.code === 'unauthorized' || e.code === 'validation_failed')) throw e;
    }
    execution = newExecution(plan.plan_id, choices, plan.req_id);
    saveExecution(execution); // 首个写动作前持久化选择（契约 §6）
  } else if (execution.choices_hash !== sha256(canonical(choices))) {
    throw new SdlcError('validation_failed', '同一执行不可更改参数（choices 不一致——恢复重跑需带相同 --tasks 等参数）——改变决定请重新预览');
  }

  const core = createCore();
  const me = await core.me(); // journal actor；real 模式未登录走 D57 自动登录
  return executeHandoff(plan, execution, choices, me.actor.actor_id, core, ctx);
}

/**
 * handoff 的 journal 派生事件：选择类（gap_accepted/action_skipped）+
 * handoff_prepared（发布前记录，话术事实入 payload——status 深化按此补取，D46）。
 * pr payload 如实记人工路径（D59：manual + 创建链接，无 API 创建事实）。
 * @param {any} plan @param {any} execution @param {Record<string, unknown>} choices @param {string} actor
 * @returns {any[]}
 */
function deriveHandoffEvents(plan, execution, choices, actor) {
  const events = deriveChoiceEvents(plan, choices, actor, execution.execution_id);
  const adv = execution.actions.advance;
  const advPayload = adv?.detail?.events?.find((e) => e.action === 'stage_advance')?.payload ?? null;
  const prAct = plan.actions.find((a) => a.id === 'pr_create');
  events.push(makeEvent({
    action: 'handoff_prepared', executionId: execution.execution_id, actionId: 'journal', planId: plan.plan_id, actor,
    result: adv?.status === 'ok' ? 'succeeded' : 'failed',
    payload: {
      req_id: plan.req_id,
      from: plan.state.stage,
      to: plan.state.to,
      branch: plan.state.branch,
      advanced: adv?.status === 'ok',
      from_version: advPayload?.from_version ?? null,
      to_version: advPayload?.to_version ?? null,
      entry_tasks: plan.state.entry_tasks,
      pr: prAct
        ? { manual: true, create_url: prAct.args?.create_url ?? null, source: prAct.args?.source, target: prAct.args?.target }
        : null,
      tasks_completed: choices.tasks ?? [],
      tasks_cancelled: plan.actions.find((a) => a.id === 'tasks_check')?.args?.cancels ?? [],
    },
  }));
  return events;
}

/**
 * 交接执行：统一动作引擎 + 汇总话术（advance 未成 → 不输出交接话术，design §4 否决语义）。
 * @param {any} plan
 * @param {any} execution
 * @param {Record<string, unknown>} choices
 * @param {string} actor
 * @param {import('../meegle/index.js').Core} core
 * @param {any} ctx
 * @returns {Promise<number>}
 */
async function executeHandoff(plan, execution, choices, actor, core, ctx) {
  const { branch } = ctx;
  await runActions(plan, execution, choices, actor, core, ctx, { deriveEvents: deriveHandoffEvents });

  const adv = execution.actions.advance;
  console.log(`\n✓ 交接完成（execution ${execution.execution_id}）`);
  if (adv?.status === 'ok') {
    const resp = adv.detail?.resp;
    const createUrl = execution.actions.pr_create?.detail?.create_url;
    if (resp) console.log(`  阶段：${plan.state.stage} → ${plan.state.to}（v${resp.from_version ?? '—'} → v${resp.to_version ?? '—'}${resp.idempotent ? '，远端已在位幂等重放' : ''}）`);
    if (execution.actions.pr_create?.status === 'ok') {
      console.log(`  MR 创建链接：${createUrl ?? '（origin 不可解析——请人工创建）'}`);
      console.log('  创建后回填：sdlc next --pr-url <MR链接>');
    }
    console.log('  交接话术（复制转发给接手人）：');
    console.log('  ---');
    console.log(`  【${plan.req_id} ${plan.title}】已进入 ${plan.state.to} 阶段，请接手：`);
    console.log(`    git checkout ${branch}`);
    console.log(`    sdlc start ${plan.req_id}`);
    if (plan.state.entry_tasks.length > 0) console.log(`    入口任务已勾选：${plan.state.entry_tasks.join('、')}`);
    if (ctx.meta?.pr_ref) console.log(`    MR：${ctx.meta.pr_ref.url}`);
    console.log('  ---');
    console.log('  （话术已准备待转发，非已发送——发送渠道 I4+）');
    if (core.mock) console.log('  （mock 模式：以上结论不作为已验证）');
  } else {
    console.log('  ⚠ 阶段未推进（advance 未执行/被跳过）——不宣称已完成交接（design §4 否决语义）');
  }
  return 0;
}
