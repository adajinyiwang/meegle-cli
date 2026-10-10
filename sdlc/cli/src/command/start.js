// sdlc start：进入需求。三条路（client/design §3.2 / D54）：
//   1. 无参 + 需求分支上 → 恢复当前需求（只读快照）
//   2. 无参无上下文 → 按活跃需求数分流：0 提示贴 URL/id；1 建议恢复；多 只读列表（agent 对话选择）
//   3. start <URL|id> → 绑定：requirementState 只读回显 → plan 预览 → --apply 执行
//      （分支切换 + 建目录 + meta + journal bind 事件；提交在 next save，start 不 commit）
// I4（D48 接手方侧）：恢复路径追加接续检测——journal 最后 handoff_prepared 未推进
//   ∧ 远端仍在 from → 兜底推进计划（走统一动作引擎零新 case）；与交接方 handoff
//   由适配层幂等门原子互斥（v5：远端已在 to 即幂等重放），双路径不重不漏。
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { findSdlcRoot, loadRepoConfig } from '../config.js';
import { loadMeta, initMetaFromBind, saveMeta } from '../meta.js';
import { makeEvent, appendEvent, readJournal } from '../journal.js';
import { buildPlan, renderPlan, planFingerprint, savePlan, loadPlan } from '../plan.js';
import { newExecution, recordAction, saveExecution, findExecutionByPlan } from '../execution.js';
import { currentBranch, parseReqFromBranch, branchSync, checkoutOrCreate, headSha, runGit } from '../gitops.js';
import { createCore } from '../meegle/index.js';
import { SdlcError } from '../errors.js';
import { sha256, canonical } from '../util.js';
import { listActiveRequirements, renderSnapshot } from './status.js';
import { collectScope, runActions } from './common.js';

/** 从 URL 或裸参数提取需求 id（飞书需求 id 为长数字） */
export function parseReqId(input) {
  const m = String(input).match(/(\d{6,})/);
  return m ? m[1] : null;
}

/**
 * @param {string[]} args 位置参数（0 或 1 个：URL/需求 id）
 * @param {{apply?: string, json?: boolean}} opts
 * @returns {Promise<number>}
 */
export async function runStart(args, opts = {}) {
  const raw = args[0] ?? null;
  const root = findSdlcRoot(process.cwd());
  if (!root) {
    console.error('当前目录不在 sdlc 接入的仓库内（未找到 .sdlc/）。请先运行 sdlc init。');
    return 1;
  }

  // 无参：分流（D54）
  if (!raw) return startNoArg(root, opts);

  const reqId = parseReqId(raw);
  if (!reqId) {
    throw new SdlcError('validation_failed', `无法从「${raw}」解析需求 id（期望飞书需求 URL 或纯数字 id）`);
  }

  // 已有本地档案 + 无 --apply → 恢复语义（不重新绑定）+ 接续检测（D48）
  const reqDir = path.join(root, '.sdlc', `req-${reqId}`);
  if (existsSync(reqDir) && opts.apply === undefined) {
    console.log(`需求 ${reqId} 已有本地档案，恢复语义：`);
    console.log(renderSnapshot(root, reqDir));
    return detectStageCatchUp(root, reqId, reqDir, opts);
  }
  // 恢复 + --apply：兜底推进计划（state.kind=start_advance 存档识别）→ applyCatchUp；
  // 绑定计划不存档 → loadPlan null → 落回 bindFlow（已绑定防护拒绝陈旧 apply）
  if (existsSync(reqDir) && opts.apply !== undefined) {
    const plan = loadPlan(String(opts.apply));
    if (plan?.state?.kind === 'start_advance') return applyCatchUp(root, reqId, reqDir, plan, opts);
  }

  return bindFlow(root, reqId, opts);
}

/**
 * 接续检测（D48 接手方侧）：journal 最后 handoff_prepared 未推进 ∧ 远端仍在
 * from → 兜底推进计划；已在 to → 已满足；其余 → 人工核对（不猜）。
 * 回退（handoff_prepared 之后有 change_request）不适用兜底推进。
 * @param {string} root @param {string} reqId @param {string} reqDir
 * @param {{json?: boolean}} opts
 * @returns {Promise<number>}
 */
async function detectStageCatchUp(root, reqId, reqDir, opts) {
  const { events } = readJournal(path.join(reqDir, 'journal.jsonl'));
  const lastIdx = events.findLastIndex((e) => e.action === 'handoff_prepared');
  const prep = lastIdx >= 0 ? events[lastIdx] : null;
  // 无交接事件或推进已成（advanced=true 时 core 已推进）——无需兜底
  if (!prep || prep.payload?.advanced) return 0;
  // 交接后有回退 → 回退优先，兜底推进不适用
  if (events.slice(lastIdx + 1).some((e) => e.action === 'change_request')) return 0;
  const from = prep.payload.from;
  const to = prep.payload.to;
  const core = createCore();
  /** @type {any} */
  let st;
  try {
    st = await core.requirementState(reqId);
  } catch {
    console.log('\n接续状态未核实（远端不可读）——稍后重试 sdlc start 检测，不猜测推进。');
    return 0;
  }
  if (st.current_stage === from) {
    return previewCatchUpPlan(root, reqId, reqDir, from, to, core, st, prep, opts);
  }
  if (st.current_stage === to) {
    console.log(`\n远端已在 ${to}——交接推进已生效（本地 meta 稍后随 next save 发布对齐），无需兜底。`);
    return 0;
  }
  console.log(`\n远端阶段 ${st.current_stage} 与交接记录（${from} → ${to}）不一致——请人工核对，不猜测推进。`);
  return 0;
}

/**
 * 兜底推进计划（D48）：sync → advance → meta_update → journal → publish——
 * 复用统一动作引擎（零新 case）；入口任务同 handoff 取值。
 * @param {string} root @param {string} reqId @param {string} reqDir
 * @param {string} from @param {string} to @param {any} core createCore 实例
 * @param {any} st core :state（from 位置）
 * @param {any} prep handoff_prepared 事件
 * @param {{json?: boolean}} opts
 * @returns {Promise<number>}
 */
async function previewCatchUpPlan(root, reqId, reqDir, from, to, core, st, prep, opts) {
  const meta = loadMeta(path.join(reqDir, 'meta.yaml')) ?? {};
  const { config, configRevision } = loadRepoConfig(root);
  const { scope } = collectScope(root, reqId);
  if (scope.length > 0) {
    console.log(`\n⚠ 需求产物有未保存改动（${scope.length} 个文件）——先 sdlc next --intent save 保存，兜底推进计划暂不生成（防夹带）。`);
    return 0;
  }
  const entryTasks = config.feishu?.profiles?.[meta.profile]?.stage_nodes?.[to]?.entry_tasks ?? [];
  const sync = branchSync(root);
  const branch = meta.branch ?? `req/${reqId}`;
  const actions = [];
  if (sync.behind) actions.push({ id: 'sync', title: '落后远端，先 git pull --ff-only 快进同步' });
  actions.push({ id: 'advance', title: `兜底推进 ${from} → ${to}（自动连续确认中间节点）`, args: { from, to, entry_tasks: entryTasks } });
  actions.push({ id: 'meta_update', title: '更新 meta（阶段/观察链/入口任务时间线）' });
  actions.push({ id: 'journal', title: '追加流程事件（stage_advance）' });
  actions.push({ id: 'publish_commit', title: '提交流程记录（journal.jsonl + meta.yaml）' });
  actions.push({ id: 'publish_push', title: '推送流程记录' });

  const plan = buildPlan({
    reqId,
    title: meta.title ?? reqId,
    url: meta.feishu_url,
    repo: root,
    branch,
    intent: `start 兜底推进：${from} → ${to}（D48 接手方侧——交接方 handoff 未成时补推进）`,
    actions,
    gaps: [],
    slots: [],
    facts: [
      `通道：${core.mock ? 'mock（结论不作为已验证）' : 'meegle（飞书项目）'}`,
      `远端阶段：${st.current_stage}（仍在交接起点——handoff_prepared ${prep.ts}）`,
      `入口任务（${to} 阶段拆分任务后勾选）：${entryTasks.join('、') || '无配置'}`,
      `Git：${sync.raw || '（无跟踪信息）'}`,
    ],
    state: {
      kind: 'start_advance',
      req_id: reqId,
      repo: root,
      branch,
      head_sha: headSha(root) ?? '',
      sync_raw: sync.raw,
      files: [],
      scope_all: [],
      config_revision: configRevision,
      // stage/stage_version 取本地 meta（checkFreshness 与 meta 比对一致；v5 观察链）
      stage: from,
      stage_version: meta.stage_version ?? 1,
      // 防外部夹带：apply 时与远端再比对（v5 纯阶段——同 handoff 恢复语义）
      to,
      entry_tasks: entryTasks,
      core_stage: st.current_stage,
      profile: st.profile ?? meta.profile,
    },
  });
  savePlan(plan);
  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  console.log(`\n检测到接续缺口：交接 ${from} → ${to} 未推进（远端仍在 ${from}）——兜底推进计划：`);
  console.log(renderPlan(plan));
  console.log(`确认执行：sdlc start ${reqId} --apply ${plan.plan_id}`);
  return 0;
}

/**
 * 兜底推进 apply：choices 锁定 + 远端段新鲜度（v5 纯阶段）+ 统一动作引擎
 *（幂等门原子互斥交接方路径——远端已被交接方推进时幂等重放，不重复计）。
 * 恢复 = 重跑同命令（choices 恒定可重推导）。
 * @param {string} root @param {string} reqId @param {string} reqDir
 * @param {any} plan @param {{json?: boolean}} opts
 * @returns {Promise<number>}
 */
async function applyCatchUp(root, reqId, reqDir, plan, opts) {
  const meta = loadMeta(path.join(reqDir, 'meta.yaml')) ?? {};
  const { config, configRevision } = loadRepoConfig(root);
  const choices = {
    intent: 'start_advance',
    subject: `接续推进 ${reqId} 进入 ${plan.state.to}`,
    accept_gaps: false,
    no_actions: [],
  };

  let execution = findExecutionByPlan(plan.plan_id);
  if (!execution) {
    // 全新 apply：远端段与存档比对（防外部夹带）——本地段无可变产物（files 空）
    const core = createCore();
    const st = await core.requirementState(reqId);
    if (st.current_stage !== plan.state.core_stage) {
      throw new SdlcError('validation_failed', `计划已过期（远端阶段已变化：${st.current_stage}），请重新 sdlc start ${reqId} 检测`);
    }
    execution = newExecution(plan.plan_id, choices, reqId);
    saveExecution(execution); // 首个写动作前持久化选择（契约 §6）
  } else if (execution.choices_hash !== sha256(canonical(choices))) {
    throw new SdlcError('validation_failed', '同一执行不可更改参数（choices 不一致）——请重新 sdlc start 检测');
  }

  const core = createCore();
  const me = await core.me();
  const ctx = { root, reqId, reqDir, meta, config, configRevision, branch: plan.state.branch };
  await runActions(plan, execution, choices, me.actor.actor_id, core, ctx);

  const adv = execution.actions.advance;
  console.log(`\n✓ 兜底推进完成（execution ${execution.execution_id}）`);
  if (adv?.status === 'ok') {
    const resp = adv.detail?.resp;
    if (resp) console.log(`  阶段：${plan.state.stage} → ${plan.state.to}（v${resp.from_version ?? '—'} → v${resp.to_version ?? '—'}${resp.idempotent ? '，远端已在位幂等重放' : ''}）`);
    console.log('  （接手方侧补推进——与交接方 handoff 同一原子推进，幂等门互斥）');
    if (core.mock) console.log('  （mock 模式：以上结论不作为已验证）');
  } else {
    console.log('  ⚠ 阶段未推进（advance 未执行/被跳过/失败）——不宣称已接续（design §4 否决语义）');
  }
  return 0;
}

/** @param {string} root @param {{json?: boolean}} opts @returns {Promise<number>} */
async function startNoArg(root, opts) {
  const b = currentBranch(root);
  const parsed = b ? parseReqFromBranch(b) : null;
  if (parsed) {
    const reqDir = path.join(root, '.sdlc', `req-${parsed.reqId}`);
    if (existsSync(reqDir)) {
      console.log(`当前分支 ${b}，恢复需求 ${parsed.reqId}：`);
      console.log(renderSnapshot(root, reqDir));
      return detectStageCatchUp(root, parsed.reqId, reqDir, opts);
    }
    console.log(`当前分支 ${b} 对应需求 ${parsed.reqId}，但本地无档案（.sdlc/req-${parsed.reqId}/ 不存在）。`);
    console.log(`请用 sdlc start ${parsed.reqId} 绑定建档。`);
    return 1;
  }

  const active = listActiveRequirements(root);
  const withActivity = active
    .map((a) => {
      const { events } = readJournal(path.join(a.dir, 'journal.jsonl'));
      return { ...a, lastTs: events[events.length - 1]?.ts ?? '', count: events.length };
    })
    .sort((x, y) => (x.lastTs < y.lastTs ? 1 : -1));

  if (withActivity.length === 0) {
    console.log('本仓库暂无活跃需求。请贴飞书需求 URL 或需求 id 开始：sdlc start <URL|id>');
    return 0;
  }
  if (withActivity.length === 1) {
    const only = withActivity[0];
    console.log(`仅有 1 个活跃需求，建议恢复：`);
    console.log(renderSnapshot(root, only.dir));
    console.log(`（如需开始新需求：sdlc start <URL|id>）`);
    return 0;
  }
  // 多个：只读列表（选择交互走 agent 对话框，CLI 不做交互菜单，D54）
  if (opts.json) {
    console.log(JSON.stringify({ active: withActivity }, null, 2));
    return 0;
  }
  console.log(`活跃需求 ${withActivity.length} 个（最近活动倒序，列表只读）：`);
  for (const a of withActivity) {
    const meta = loadMeta(path.join(a.dir, 'meta.yaml'));
    const stage = meta?.current_stage ?? '?';
    const ts = a.lastTs ? a.lastTs.slice(0, 16).replace('T', ' ') : '无事件';
    console.log(`  ${a.reqId}  ${meta?.title ?? '（无 meta）'}  阶段=${stage}  最近活动=${ts}`);
  }
  console.log('请在对话中指定需求（如「继续 7114275203」），或 sdlc start <URL|id> 开始新需求。');
  return 0;
}

/**
 * 绑定链路：预览（GET :state 只读）→ plan → --apply。
 * @param {string} root
 * @param {string} reqId
 * @param {{apply?: string, json?: boolean}} opts
 * @returns {Promise<number>}
 */
async function bindFlow(root, reqId, opts) {
  const { configRevision } = loadRepoConfig(root);
  const reqDir = path.join(root, '.sdlc', `req-${reqId}`);

  // 已绑定防护：meta.yaml 存在 = 完整档案（重复 apply 拒绝）；目录存在但无 meta = 中断残留，可重试
  if (existsSync(path.join(reqDir, 'meta.yaml'))) {
    throw new SdlcError('validation_failed', `需求 ${reqId} 已绑定（meta.yaml 已存在）；恢复用 sdlc start ${reqId}（不带 --apply）`);
  }

  // 脏工作区拦截（防夹带）：绑定要切分支，未提交改动会跟着进新需求分支。
  // 先处理再绑定（保存/提交/清理由用户决定），不给「带着走」的口子。
  const dirty = runGit(['status', '--porcelain'], root);
  if (dirty.ok && dirty.stdout.trim() !== '') {
    const files = dirty.stdout.split('\n').filter(Boolean);
    const shown = files.slice(0, 5).join('\n  ');
    throw new SdlcError(
      'validation_failed',
      `工作区有 ${files.length} 处未提交改动，切分支会带进新需求分支（防夹带）——先保存或处理当前分支的改动（如 sdlc next 保存，或自行 commit/清理）后再 start：\n  ${shown}${files.length > 5 ? `\n  …共 ${files.length} 处` : ''}`,
    );
  }

  const core = createCore();
  const state = await core.requirementState(reqId); // 不存在/无权限 → not_found 上抛
  const branch = `req/${reqId}`;

  const plan = buildPlan({
    reqId,
    title: state.title,
    url: state.url,
    repo: root,
    branch,
    intent: '绑定需求：切分支 + 建本地档案',
    actions: [
      { id: 'branch', title: `切换/创建分支 ${branch}` },
      { id: 'init_dir', title: `创建 .sdlc/req-${reqId}/` },
      { id: 'meta', title: '写入 meta.yaml（绑定建档）' },
      { id: 'journal_bind', title: '追加 journal bind 事件' },
    ],
    gaps: [],
    slots: [],
    facts: [
      `通道：${core.mock ? 'mock（结论不作为已验证）' : 'meegle（飞书项目）'}`,
      `阶段：${state.current_stage}`,
      `参与人：${Object.entries(state.participants ?? {})
        .map(([role, list]) => `${role}:${list.map((p) => p.name).join(',')}`)
        .join(' ')}`,
    ],
  });

  if (opts.apply === undefined) {
    if (opts.json) console.log(JSON.stringify(plan, null, 2));
    else {
      console.log(renderPlan(plan));
      console.log(`确认执行：sdlc start ${reqId} --apply ${plan.plan_id}`);
    }
    return 0;
  }

  // apply：校验指纹（重推导比对，只接受 plan 展示过的内容，§3.0）
  if (opts.apply === true) {
    throw new SdlcError('validation_failed', 'start 的 --apply 需要 plan_id 值（见预览输出的「确认执行」一行）');
  }
  if (planFingerprint(plan) !== opts.apply) {
    throw new SdlcError(
      'validation_failed',
      `plan_id 不匹配（需求状态可能已变化），请重新预览后再 apply。期望 ${opts.apply.slice(0, 12)}…，当前 ${planFingerprint(plan).slice(0, 12)}…`,
    );
  }

  // 身份（apply 需要落 journal actor）
  const meResp = await core.me();
  const actorId = meResp.actor.actor_id;

  const execution = newExecution(plan.plan_id, {}, reqId);

  // 动作 1：分支
  if (!checkoutOrCreate(root, branch)) {
    throw new SdlcError('validation_failed', `分支切换/创建失败：git checkout ${branch}`);
  }
  recordAction(execution, 'branch', { status: 'ok', detail: branch });

  // 动作 2：目录
  mkdirSync(reqDir, { recursive: true });
  recordAction(execution, 'init_dir', { status: 'ok', detail: reqDir });

  // 动作 3：meta（user_key 取 me()——v5 绑定时留 meegle 登录用户标识）
  saveMeta(path.join(reqDir, 'meta.yaml'), initMetaFromBind(state, { branch, configRevision, userKey: actorId }));
  recordAction(execution, 'meta', { status: 'ok' });

  // 动作 4：journal bind 事件（观察链基线版本：适配层无数字时按 1 起链——
  // 与 initMetaFromBind 同款兜底，rebuildStage 要 number 不猜）
  const bindEvent = makeEvent({
    action: 'bind',
    executionId: execution.execution_id,
    actionId: 'bind',
    planId: plan.plan_id,
    actor: actorId,
    result: 'ok',
    payload: { current_stage: state.current_stage, stage_version: typeof state.stage_version === 'number' ? state.stage_version : 1 },
  });
  const appendRes = appendEvent(path.join(reqDir, 'journal.jsonl'), bindEvent);
  recordAction(execution, 'journal_bind', { status: 'ok', detail: appendRes });

  console.log(`✓ 需求 ${reqId} 绑定完成（execution ${execution.execution_id}）。`);
  console.log(`  分支：${branch}；档案：.sdlc/req-${reqId}/（meta.yaml + journal.jsonl）`);
  console.log(`  阶段：${state.current_stage}——与飞书项目一致（${core.mock ? 'mock' : 'meegle 通道'}）。`);
  console.log('  下一步：按角色推进（产品 sdlc next / 直接 sdlc next save）。');
  return 0;
}
