// save/handoff 共享底座：需求定位、范围收集、指纹新鲜度、差异展示、DoD 缺口、
// 事件持久化（先存 execution detail 再按 event_id 查缺补漏——崩溃安全幂等，D40）。
// 从 next.js 剪出（I3 handoff 复用同一套语义）。
// I6（D59）：外部动作走 meegle 适配层——先意图后写/executions 查证退役，恢复 =
// 适配层幂等门（写前回读 + 条件下发，meegle-contract §3.1/§3.3 不盲重发）；
// PR 人工路径（pr_create 输出预填链接 + pr_link 对话回填）。
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadRepoConfig, evaluateDod } from '../config.js';
import { loadMeta, saveMeta } from '../meta.js';
import { makeEvent, appendEvent, readJournal } from '../journal.js';
import { loadPlan } from '../plan.js';
import { listExecutions, recordAction } from '../execution.js';
import {
  currentBranch, parseReqFromBranch, listDirtyFiles, headSha, fileDigest, diffForFile,
  branchSync, pullFf, commitFiles, pushBranch, commitInBranch, remoteRefExists, runGit,
} from '../gitops.js';
import { SdlcError } from '../errors.js';
import { canonical } from '../util.js';
import { listActiveRequirements } from './status.js';

/** 无显式 req_id 时的定位：当前分支 → 唯一活跃需求 → 多个则列出要求指定。 @param {string} root @param {string[]} positional */
export function resolveReqId(root, positional) {
  const explicit = positional[0];
  if (explicit) {
    if (!/^\d{6,}$/.test(explicit)) {
      throw new SdlcError('validation_failed', `「${explicit}」不是合法需求 id（纯数字）`);
    }
    return explicit;
  }
  const b = currentBranch(root);
  const parsed = b ? parseReqFromBranch(b) : null;
  if (parsed) return parsed.reqId;
  const active = listActiveRequirements(root);
  if (active.length === 0) {
    throw new SdlcError('validation_failed', '当前分支非需求分支且无活跃需求——请先 sdlc start <URL|id> 绑定');
  }
  if (active.length === 1) return active[0].reqId;
  throw new SdlcError(
    'validation_failed',
    `多个活跃需求，请指定：sdlc next <req_id>\n${active.map((a) => `  ${a.reqId}`).join('\n')}`,
  );
}

/**
 * 确认文件范围（默认）：非 .sdlc 脏文件 + 本需求目录内产物（journal/meta 归
 * publish，其他 .sdlc 路径防跨需求收走）。journal/meta 脏 → flowDirty 驱动发布。
 * @param {string} root @param {string} reqId
 * @returns {{dirty: {status: string, path: string}[], scope: {status: string, path: string}[], excluded: {status: string, path: string}[], flowDirty: boolean}}
 */
export function collectScope(root, reqId) {
  const dirty = listDirtyFiles(root);
  if (dirty === null) throw new SdlcError('validation_failed', 'git status 解析失败（非 git 仓库？）');
  const journalRel = `.sdlc/req-${reqId}/journal.jsonl`;
  const metaRel = `.sdlc/req-${reqId}/meta.yaml`;
  const inScope = (p) => !p.startsWith('.sdlc/') || (p.startsWith(`.sdlc/req-${reqId}/`) && p !== journalRel && p !== metaRel);
  const scope = dirty.filter((d) => inScope(d.path));
  const excluded = dirty.filter((d) => !inScope(d.path));
  const flowDirty = dirty.some((d) => d.path === journalRel || d.path === metaRel);
  return { dirty, scope, excluded, flowDirty };
}

/** 脏文件 digest（跟踪/未跟踪读内容；已删除标 'deleted'）。 @param {string} root @param {string} rel */
export function digestOf(root, rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return 'deleted';
  return fileDigest(abs);
}

/**
 * 全新 apply 的新鲜度分解：基线/配置/阶段/文件清单变化 → 过期；仅内容摘要变化 → 差异确认。
 * handoff 的 state 额外字段（core 阶段/远端任务快照）由调用方另行比对。
 * @param {string} root
 * @param {import('../plan.js').Plan} plan
 * @returns {{stale: string | null, diffs: {path: string, old: string, now: string}[]}}
 */
export function checkFreshness(root, plan) {
  const ps = plan.state;
  const reasons = [];
  if (ps.branch !== (currentBranch(root) ?? '')) reasons.push('分支变化');
  if (ps.head_sha !== (headSha(root) ?? '')) reasons.push('Git 基线变化（预览后有新提交）');
  if (ps.config_revision !== loadRepoConfig(root).configRevision) reasons.push('仓库配置变化');
  const meta = loadMeta(path.join(root, '.sdlc', `req-${ps.req_id}`, 'meta.yaml'));
  if (!meta || meta.current_stage !== ps.stage || meta.stage_version !== ps.stage_version) reasons.push('阶段/版本变化');
  // 文件清单：默认范围出现存档外新脏文件 = 计划过期（防夹带——只能执行确认过的内容）。
  // 用 scope_all（预览时全量）而非 files：--files 收窄过的文件不是「新增」。
  const planFiles = ps.files.map((f) => f.path);
  const scopeAll = ps.scope_all ?? planFiles;
  const newFiles = collectScope(root, ps.req_id).scope.map((d) => d.path).filter((p) => !scopeAll.includes(p));
  if (newFiles.length > 0) reasons.push(`文件范围变化（预览后新增：${newFiles.join('、')}）`);
  if (reasons.length > 0) return { stale: reasons.join('、'), diffs: [] };
  const diffs = ps.files
    .map((f) => ({ path: f.path, old: f.digest, now: digestOf(root, f.path) }))
    .filter((f) => f.old !== f.now);
  return { stale: null, diffs };
}

/**
 * --files 收窄（save/handoff 共用）：只能在默认范围内选（防夹带范围外文件）。
 * @param {string[]} scopePaths 默认范围
 * @param {Record<string, any>} flags
 * @returns {string[]}
 */
export function narrowScope(scopePaths, flags) {
  if (!flags.files) return scopePaths;
  const set = new Set(scopePaths);
  const picked = String(flags.files).split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of picked) {
    if (!set.has(f)) throw new SdlcError('validation_failed', `--files 候选外的路径：${f}（仅可收窄默认范围内的脏文件）`);
  }
  return picked;
}

/** 差异确认展示：跟踪文件 git diff HEAD；新文件/删除给摘要。 @param {string} root @param {{path: string}[]} diffs */
export function renderDiffs(root, diffs) {
  for (const d of diffs) {
    console.log(`\n### ${d.path}`);
    const abs = path.join(root, d.path);
    if (!existsSync(abs)) {
      console.log('（文件已删除——提交将移除该文件）');
      continue;
    }
    const diff = diffForFile(root, d.path);
    if (diff.trim() !== '') console.log(diff);
    else {
      const lines = readFileSync(abs, 'utf8').split('\n');
      console.log(`（无 git 差异或未跟踪文件，共 ${lines.length} 行；内容头部预览）`);
      console.log(lines.slice(0, 15).join('\n'));
    }
  }
}

/** DoD 缺口（原样含 check 供过滤；meta 供 pr_exists/report_current 本地判定）。 @param {any} ctx（含 config/reqDir/meta.current_stage） @param {import('../gitops.js').GitSyncState} sync */
export function currentGaps(ctx, sync) {
  return evaluateDod(ctx.config, ctx.reqDir, sync, ctx.meta.current_stage, { meta: ctx.meta }).filter((d) => d.status === 'gap');
}

/**
 * 本 req 未完成的 save/handoff 执行（D39：预览先识别旧执行，防新执行绕过旧未知）。
 * 只认有存档计划且带 state 的（start 绑定执行的计划不存档、无 next 语义）。
 * @param {string} reqId @returns {{execution_id: string, plan_id: string}[]}
 */
export function findUnfinishedExecutions(reqId) {
  return listExecutions()
    .filter((r) => r.req_id === reqId)
    .filter((r) => {
      const plan = loadPlan(r.plan_id);
      if (!plan?.state) return false;
      // 卡点#13（R4 实测 7131581708）：失败已结论（用户当场看到失败输出，续做
      // 走 --apply 是显式选择；failed 后的后续动作本就不会跑）——不拦新执行，
      // 否则失败 execution 永久悬着拦 --auto。拦的只是崩溃中断：动作有 ok 无
      // failed 但链未收尾（发起无结果）——状态未知，防新执行绕过（D39）。
      const hasFailed = plan.actions.some((a) => r.actions[a.id]?.status === 'failed');
      if (hasFailed) return false;
      return plan.actions.some((a) => r.actions[a.id] === undefined);
    })
    .map((r) => ({ execution_id: r.execution_id, plan_id: r.plan_id }));
}

/**
 * 事件持久化闭包（save/handoff/done 共用）：先入 execution detail（崩溃安全），
 * 再按 event_id 查缺补漏追加 journal。extra 合并进 detail（如 commit 的 sha——
 * 恢复跳过判定要核验它）。journalPath 传 getter（archive_move 移动目录后路径会变）。
 * @param {import('../execution.js').ExecutionRecord} execution
 * @param {() => string} journalPathGetter
 * @returns {(actionId: string, status: string, newEvents: any[], extra?: Record<string, unknown>) => void}
 */
export function makePersistEvents(execution, journalPathGetter) {
  return (actionId, status, newEvents, extra = {}) => {
    const prev = execution.actions[actionId]?.detail ?? {};
    const events = [...(prev.events ?? []), ...newEvents];
    recordAction(execution, actionId, { status, detail: { ...prev, ...extra, events } });
    const journalPath = journalPathGetter();
    const have = new Set(readJournal(journalPath).events.map((e) => e.event_id));
    for (const ev of newEvents) if (!have.has(ev.event_id)) appendEvent(journalPath, ev);
  };
}

/** 选择类事件（gap_accepted / action_skipped）。 @param {import('../plan.js').Plan} plan @param {Record<string, unknown>} choices @param {string} actor @param {string} executionId */
export function deriveChoiceEvents(plan, choices, actor, executionId) {
  /** @type {any[]} */
  const events = [];
  if (choices.accept_gaps && plan.gaps.length > 0) {
    events.push(makeEvent({
      action: 'gap_accepted', executionId, actionId: 'journal', planId: plan.plan_id, actor, result: 'succeeded',
      payload: { gaps: plan.gaps },
    }));
  }
  const planIds = new Set(plan.actions.map((a) => a.id));
  for (const a of /** @type {string[]} */ (choices.no_actions)) {
    if (planIds.has(a)) {
      events.push(makeEvent({
        action: 'action_skipped', executionId, actionId: 'journal', planId: plan.plan_id, actor, result: 'succeeded',
        payload: { action: a, reason: `--no-${a}` },
      }));
    }
  }
  return events;
}

/**
 * 统一动作执行循环（save/handoff 共用）：幂等跳过、--no-* 留痕跳过、
 * Git 事实裁决、外部动作走 meegle 适配层（D59/I6b）。
 * 恢复语义（v5，原 core executions 查证退役）：advance/change/complete 重发前
 * 由适配层幂等门写前回读（已在目标 → 幂等重放；仍在起点 → 续发；在别处 →
 * validation_failed 分歧；远端不可读 → external_unavailable 不下发）——结果
 * 未知不盲重发由「先读后写」保证；任务动作按标题/映射幂等（already_exists/no_op）。
 * 事件写入顺序固定「先存 execution detail、再追加 journal」——崩溃后恢复时
 * journal 步骤按 event_id 查缺补漏，天然幂等（D40/契约 §5 去重）。
 * @param {import('../plan.js').Plan} plan
 * @param {import('../execution.js').ExecutionRecord} execution
 * @param {Record<string, unknown>} choices
 * @param {string} actor
 * @param {import('../meegle/index.js').Core} core
 * @param {any} ctx（含 root/reqId/reqDir/branch/configRevision/meta）
 * @param {{deriveEvents?: (plan: any, execution: any, choices: any, actor: string) => any[]}} [opts] journal 派生事件注入（handoff 加 handoff_prepared）
 * @returns {Promise<void>}
 */
export async function runActions(plan, execution, choices, actor, core, ctx, opts = {}) {
  const { root, reqId, branch } = ctx;
  // 目录位置可变（done 第一段 archive_move 后 journal/meta 落新路径）——闭包统一走 loc
  const loc = {
    reqDir: ctx.reqDir,
    journalPath: path.join(ctx.reqDir, 'journal.jsonl'),
    journalRel: `.sdlc/req-${reqId}/journal.jsonl`,
    metaRel: `.sdlc/req-${reqId}/meta.yaml`,
    archiveRel: null,
  };
  /** 归档后切换 journal/meta 落点（目录移动后所有路径跟随——R1） */
  const switchLoc = (archiveRel) => {
    loc.archiveRel = archiveRel;
    loc.reqDir = path.join(root, archiveRel);
    loc.journalPath = path.join(loc.reqDir, 'journal.jsonl');
    loc.journalRel = `${archiveRel}/journal.jsonl`;
    loc.metaRel = `${archiveRel}/meta.yaml`;
  };
  const commitAct = plan.actions.find((a) => a.id === 'commit');
  const scope = /** @type {string[]} */ (commitAct?.args?.files ?? []);
  const subject = String(choices.subject);
  const gitScope = parseReqFromBranch(branch)?.slug || reqId;
  const noSet = new Set(/** @type {string[]} */ (choices.no_actions));
  if (noSet.has('push')) noSet.add('publish_push'); // --no-push = 本地草稿：外发动作一并不推

  const persistEvents = makePersistEvents(execution, () => loc.journalPath);

  for (const act of plan.actions) {
    if (noSet.has(act.id)) {
      recordAction(execution, act.id, { status: 'skipped' });
      console.log(`- [${act.id}] 已按 --no-${act.id} 跳过（留痕）`);
      continue;
    }
    switch (act.id) {
      case 'sync': {
        if (execution.actions.sync?.status === 'ok' && !branchSync(root).behind) break;
        const r = pullFf(root);
        if (!r.ok) {
          recordAction(execution, 'sync', { status: 'failed' });
          throw new SdlcError('validation_failed', `快进同步失败（分叉/冲突需人工处理，不强推不覆盖）：${r.stderr || r.stdout}`);
        }
        recordAction(execution, 'sync', { status: 'ok' });
        console.log('✓ [sync] 已快进同步');
        break;
      }
      case 'commit': {
        const prev = execution.actions.commit;
        if (prev?.status === 'ok' && typeof prev.detail?.sha === 'string' && commitInBranch(root, prev.detail.sha)) {
          console.log(`✓ [commit] 已完成（${prev.detail.sha.slice(0, 8)}），跳过`);
          break;
        }
        const r = commitFiles(root, { files: scope, subject, reqId, scope: gitScope });
        // 干净树上 git commit 以 exit 1 + nothing to commit 结束——那是 noop 不是失败
        const noop = r.stdout.includes('nothing to commit');
        if (!r.ok && !noop) {
          recordAction(execution, 'commit', { status: 'failed' });
          throw new SdlcError('validation_failed', `产物提交失败：${r.stderr || r.stdout}`);
        }
        const sha = headSha(root) ?? '';
        if (!noop && sha) {
          persistEvents('commit', 'ok', [
            makeEvent({ action: 'local_commit', executionId: execution.execution_id, actionId: 'commit', planId: plan.plan_id, actor, result: 'succeeded', payload: { sha, subject, files: scope, branch } }),
          ], { sha });
          console.log(`✓ [commit] ${gitScope} 提交：${sha.slice(0, 8)}（${scope.length} 个文件）`);
        } else {
          recordAction(execution, 'commit', { status: 'ok', detail: { sha, noop: true } });
          console.log('✓ [commit] 无产物改动（nothing to commit）');
        }
        break;
      }
      case 'push': {
        if (execution.actions.push?.status === 'ok' && branchSync(root).ahead === false && remoteRefExists(root, branch)) {
          console.log('✓ [push] 远端已同步，跳过');
          break;
        }
        const r = pushBranch(root, branch);
        if (r.ok) {
          persistEvents('push', 'ok', [
            makeEvent({ action: 'push', executionId: execution.execution_id, actionId: 'push', planId: plan.plan_id, actor, result: 'succeeded', payload: { branch, sha: headSha(root) ?? '' } }),
          ]);
          console.log(`✓ [push] 已推送 ${branch}`);
        } else {
          // 失败也如实留痕（事件 + execution）再中止——恢复重跑时 push 成功会
          // 追加 succeeded 事件（append-only，failed 保留，契约 §5）
          persistEvents('push', 'failed', [
            makeEvent({ action: 'push', executionId: execution.execution_id, actionId: 'push', planId: plan.plan_id, actor, result: 'failed', payload: { branch, error: r.stderr.slice(0, 200) } }),
          ]);
          throw new SdlcError('external_unavailable', `推送失败：${r.stderr || r.stdout}——已完成动作保留（提交在本地），重跑本命令即续做推送与发布`);
        }
        break;
      }
      case 'tasks_split': {
        if (execution.actions.tasks_split?.status === 'ok') {
          console.log('✓ [tasks_split] 粗任务已同步，跳过');
          break;
        }
        {
          // 适配层按标题幂等（already_exists 复用）；tasks_map 供映射（v5）。
          // estimate/state 随任务走（handoff 预览传入）：estimate 驱动自动排期/估分；
          // state=completed 的新任务创建后即勾选——否则快速推进要两轮（创建→再勾选）。
          const tasks = /** @type {{id: string, title: string, assignee_role: string, estimate?: number, state?: string}[]} */ (act.args.tasks ?? []);
          try {
            const resp = await core.splitTasks({ reqId: plan.req_id, tasks, tasksMap: ctx.meta?.tasks_map ?? {} });
            // 本地已完成的新任务：创建后即勾选（R4 实测 7131581708——T1 completed
            // 落 split 只创建不勾，二次操作才能同步）。remote_id 直查，幂等重跑 no_op。
            const dones = resp.items.filter((it) => it.result === 'created'
              && tasks.find((t) => t.id === it.id)?.state === 'completed');
            const checked = dones.length > 0
              ? await core.checkTasks({ reqId: plan.req_id, items: dones.map((it) => ({ id: it.id, title: tasks.find((t) => t.id === it.id)?.title, remote_id: it.remote_id ?? undefined, state: 'completed' })) })
              : { items: [] };
            const events = [
              ...resp.items.map((it) => makeEvent({
                action: 'task_synced', executionId: execution.execution_id, actionId: 'tasks_split', planId: plan.plan_id, actor, result: 'succeeded',
                payload: { kind: 'created', id: it.id, result: it.result, remote_id: it.remote_id ?? null },
              })),
              ...checked.items.map((it) => makeEvent({
                action: 'task_synced', executionId: execution.execution_id, actionId: 'tasks_split', planId: plan.plan_id, actor, result: 'succeeded',
                payload: { kind: 'completed', id: it.id, result: it.result, remote_id: it.remote_id ?? null },
              })),
            ];
            persistEvents('tasks_split', 'ok', events, { external: resp.items });
            console.log(`✓ [tasks_split] 已同步 ${resp.items.length} 项粗任务（${resp.items.map((i) => `${i.id}:${i.result}`).join('、')}）`);
            const doneOk = checked.items.filter((i) => i.result === 'completed' || i.result === 'no_op');
            if (doneOk.length > 0) console.log(`✓ [tasks_split] 本地已完成任务已勾选（${doneOk.map((i) => i.id).join('、')}）`);
          } catch (e) {
            if (e?.code === 'external_unknown') { recordAction(execution, 'tasks_split', { status: 'unknown' }); throw e; }
            persistEvents('tasks_split', 'failed', [
              makeEvent({ action: 'task_synced', executionId: execution.execution_id, actionId: 'tasks_split', planId: plan.plan_id, actor, result: 'failed', payload: { ids: tasks.map((t) => t.id), error: String(e?.message ?? e).slice(0, 200) } }),
            ]);
            throw e;
          }
          // 入口任务勾选（D48 v2：进入该阶段之后、需求子任务已创建——拆分动作
          // 后勾选，交接时不勾、需求阶段不动开发节点）。远端模板无此任务则跳过。
          const entryTasks = /** @type {string[]} */ (ctx.config?.feishu?.profiles?.[ctx.meta?.profile]?.stage_nodes?.[ctx.meta?.current_stage]?.entry_tasks ?? []);
          if (entryTasks.length > 0 && tasks.length > 0) {
            const resp = await core.checkTasks({ reqId: plan.req_id, items: entryTasks.map((t) => ({ id: `entry:${t}`, title: t, state: 'completed' })) });
            const done = resp.items.map((i, idx) => (i.result === 'not_found' ? null : entryTasks[idx])).filter(Boolean);
            if (done.length > 0) {
              console.log(`✓ [tasks_split] 入口任务已勾选（${done.join('、')}）`);
            }
          }
        }
        break;
      }
      case 'tasks_check': {
        if (execution.actions.tasks_check?.status === 'ok') {
          console.log('✓ [tasks_check] 任务状态已同步，跳过');
          break;
        }
        {
          // 完成与取消分开列（契约 §8）：勾选 → completed；远端 open 本地取消 → cancelled。
          // items 带 title/remote_id（预览时解析——映射/标题回查），适配层按其幂等。
          // completions = save 场景（R4）本地已完成差异直传（不经 --tasks 勾选）。
          const picked = /** @type {string[]} */ (choices.tasks ?? []);
          const completions = /** @type {{id: string, title?: string, remote_id?: string}[]} */ (act.args.completions ?? []);
          const cancels = /** @type {{id: string, title?: string, remote_id?: string}[]} */ (act.args.cancels ?? []);
          const resolved = /** @type {Record<string, {title?: string, remote_id?: string}>} */ (plan.state.tasks_resolved ?? {});
          const items = [
            ...completions.map(({ id, title, remote_id }) => ({ id, title, remote_id, state: 'completed' })),
            ...picked.map((id) => ({ id, title: resolved[id]?.title, remote_id: resolved[id]?.remote_id, state: 'completed' })),
            ...cancels.map(({ id, title, remote_id }) => ({ id, title, remote_id, state: 'cancelled' })),
          ];
          if (items.length === 0) {
            recordAction(execution, 'tasks_check', { status: 'ok', detail: { noop: true } });
            console.log('✓ [tasks_check] 无勾选/取消项，跳过');
            break;
          }
          try {
            const resp = await core.checkTasks({ reqId: plan.req_id, items, tasksMap: ctx.meta?.tasks_map ?? {} });
            // kind 取请求侧意图（completed/cancelled）：响应 item 只含 result/remote_id，不含 state
            const events = resp.items.map((it, i) => makeEvent({
              action: 'task_synced', executionId: execution.execution_id, actionId: 'tasks_check', planId: plan.plan_id, actor, result: it.result === 'not_found' ? 'failed' : 'succeeded',
              payload: { kind: items[i].state, id: it.id, result: it.result, remote_id: it.remote_id ?? null },
            }));
            persistEvents('tasks_check', 'ok', events, { external: resp.items });
            console.log(`✓ [tasks_check] 已同步 ${resp.items.length} 项状态（${resp.items.map((i) => `${i.id}:${i.result}`).join('、')}）`);
          } catch (e) {
            if (e?.code === 'external_unknown') { recordAction(execution, 'tasks_check', { status: 'unknown' }); throw e; }
            persistEvents('tasks_check', 'failed', [
              makeEvent({ action: 'task_synced', executionId: execution.execution_id, actionId: 'tasks_check', planId: plan.plan_id, actor, result: 'failed', payload: { ids: items.map((i) => i.id), error: String(e?.message ?? e).slice(0, 200) } }),
            ]);
            throw e;
          }
        }
        break;
      }
      case 'pr_create': {
        if (execution.actions.pr_create?.status === 'ok') {
          console.log('✓ [pr_create] 创建链接已给出，跳过');
          break;
        }
        {
          // D59 人工路径：无 Codeup API 凭据——不调 API、不写事件（无事实可记）；
          // 输出预填参数的 MR 创建链接（预览时拼装），实际创建由人在 Codeup 完成
          const a = act.args; // { create_url, repo, source, target }
          recordAction(execution, 'pr_create', { status: 'ok', detail: { manual: true, create_url: a.create_url } });
          console.log('✓ [pr_create] 请在浏览器创建 MR（参数已预填）：');
          console.log(`  ${a.create_url}`);
          console.log('  创建后回填：sdlc next --pr-url <MR链接>');
        }
        break;
      }
      case 'pr_link': {
        if (execution.actions.pr_link?.status === 'ok') {
          console.log('✓ [pr_link] PR 回填已记录，跳过');
          break;
        }
        {
          // 人工路径回填（D59）：对话确认经 --pr-url 进来；本地写 meta.pr_ref +
          // pr_linked 事件（source_kind=manual 如实标注）。无外部调用——不声称
          // 核实，合并核验唯一来源是 done --manual-confirm pr_merged
          const a = act.args; // { pr: {repo, pr_id, url, source, target} }
          const pr = { repo: a.pr.repo, pr_id: String(a.pr.pr_id), url: a.pr.url, source: a.pr.source, target: a.pr.target };
          persistEvents('pr_link', 'ok', [
            makeEvent({
              action: 'pr_linked', executionId: execution.execution_id, actionId: 'pr_link', planId: plan.plan_id, actor, result: 'succeeded',
              payload: { ...pr, source_kind: 'manual' },
            }),
          ], { pr });
          const metaPath = path.join(loc.reqDir, 'meta.yaml');
          const meta = loadMeta(metaPath) ?? {};
          saveMeta(metaPath, { ...meta, pr_ref: pr });
          console.log(`✓ [pr_link] PR 回填已记录（#${pr.pr_id}）：${pr.url}——meta 随下次发布提交`);
        }
        break;
      }
      case 'advance': {
        if (execution.actions.advance?.status === 'ok') {
          console.log('✓ [advance] 阶段已推进，跳过');
          break;
        }
        {
          // 幂等门在适配层（写前回读三分 + 写后回读，meegle-contract §3.1）：
          // 重发安全——已在 to 幂等重放（idempotent）；在别处 validation_failed 分歧
          const a = act.args;
          try {
            const resp = await core.advanceStage({ reqId: plan.req_id, from: a.from, to: a.to, entryTasks: a.entry_tasks ?? [], profile: plan.state?.profile });
            // 版本取适配层响应（mock 计数器）；real 恒 null → 本地观察链兜底
            const fromV = typeof resp.from_version === 'number' ? resp.from_version : (ctx.meta?.stage_version ?? null);
            const toV = typeof resp.to_version === 'number' ? resp.to_version : (fromV == null ? null : fromV + 1);
            persistEvents('advance', 'ok', [
              makeEvent({
                action: 'stage_advance', executionId: execution.execution_id, actionId: 'advance', planId: plan.plan_id, actor, result: 'succeeded',
                payload: { from: a.from, to: a.to, from_version: fromV, to_version: toV, idempotent: resp.idempotent === true, source: 'api', sync_status: resp.node_status ?? 'unknown' },
              }),
            ], { resp });
            console.log(`✓ [advance] 已进入 ${a.to}${resp.idempotent ? '（远端已在位，幂等重放）' : `（v${fromV ?? '?'} → v${toV ?? '?'}）`}`);
          } catch (e) {
            if (e?.code === 'external_unknown') { recordAction(execution, 'advance', { status: 'unknown' }); throw e; }
            if (e?.code === 'validation_failed') {
              // 远端阶段分歧（被他人推进/回退）→ 计划过期重预览；非执行失败，不落事件
              recordAction(execution, 'advance', { status: 'failed', detail: { remote_stage: e.details?.remote_stage ?? null } });
              throw e;
            }
            persistEvents('advance', 'failed', [
              makeEvent({
                action: 'stage_advance', executionId: execution.execution_id, actionId: 'advance', planId: plan.plan_id, actor, result: 'failed',
                payload: { from: a.from, to: a.to, error: String(e?.message ?? e).slice(0, 200) },
              }),
            ]);
            throw e;
          }
        }
        break;
      }
      case 'change': {
        if (execution.actions.change?.status === 'ok') {
          console.log('✓ [change] 阶段已回退，跳过');
          break;
        }
        {
          // 幂等门在适配层（同 advance）；reason 由适配层传 --rollback-reason 留痕
          const a = act.args;
          try {
            const resp = await core.changeStage({ reqId: plan.req_id, from: a.from, to: a.to, reason: a.reason, profile: plan.state?.profile });
            const fromV = typeof resp.from_version === 'number' ? resp.from_version : (ctx.meta?.stage_version ?? null);
            const toV = typeof resp.to_version === 'number' ? resp.to_version : (fromV == null ? null : fromV + 1);
            persistEvents('change', 'ok', [
              makeEvent({
                action: 'change_request', executionId: execution.execution_id, actionId: 'change', planId: plan.plan_id, actor, result: 'succeeded',
                payload: { from: a.from, to: a.to, from_version: fromV, to_version: toV, idempotent: resp.idempotent === true, reason: a.reason, source: 'api', sync_status: resp.node_status ?? 'unknown' },
              }),
            ], { resp });
            console.log(`✓ [change] 已回退 ${a.from} → ${a.to}${resp.idempotent ? '（远端已在位，幂等重放）' : `（v${fromV ?? '?'} → v${toV ?? '?'}）`}`);
          } catch (e) {
            if (e?.code === 'external_unknown') { recordAction(execution, 'change', { status: 'unknown' }); throw e; }
            if (e?.code === 'validation_failed') {
              // 远端阶段分歧 → 计划过期重预览（同 advance）
              recordAction(execution, 'change', { status: 'failed', detail: { remote_stage: e.details?.remote_stage ?? null } });
              throw e;
            }
            persistEvents('change', 'failed', [
              makeEvent({
                action: 'change_request', executionId: execution.execution_id, actionId: 'change', planId: plan.plan_id, actor, result: 'failed',
                payload: { from: a.from, to: a.to, reason: a.reason, error: String(e?.message ?? e).slice(0, 200) },
              }),
            ]);
            throw e;
          }
        }
        break;
      }
      case 'archive_move': {
        if (execution.actions.archive_move?.status === 'ok') {
          // 路径已切换（上次执行过）——恢复 loc 指向归档位置
          const rel = /** @type {string} */ (execution.actions.archive_move.detail?.archive_dir ?? plan.state.archive_dir);
          if (rel) switchLoc(rel);
          console.log(`✓ [archive_move] 已归档至 ${rel}，跳过`);
          break;
        }
        {
          const a = act.args; // { archive_dir, source_dir }
          const targetAbs = path.join(root, a.archive_dir);
          const sourceAbs = path.join(root, a.source_dir);
          if (existsSync(targetAbs) && !existsSync(sourceAbs)) {
            // 事实裁决：目标在源不在 = 已移动（中断恢复），补记跳过
            switchLoc(a.archive_dir);
            recordAction(execution, 'archive_move', { status: 'ok', detail: { archive_dir: a.archive_dir, recovered: true } });
            console.log(`✓ [archive_move] 目录已在归档位置（恢复补记），跳过`);
            break;
          }
          if (existsSync(targetAbs)) {
            recordAction(execution, 'archive_move', { status: 'failed' });
            throw new SdlcError('validation_failed', `归档目录已存在 ${a.archive_dir}——请人工核对（可能旧归档/双份），CLI 不猜测覆盖`);
          }
          if (!existsSync(sourceAbs)) {
            recordAction(execution, 'archive_move', { status: 'failed' });
            throw new SdlcError('validation_failed', `源目录不存在 ${a.source_dir}——请先 sdlc start 绑定`);
          }
          mkdirSync(path.dirname(targetAbs), { recursive: true });
          const r = runGit(['mv', a.source_dir, a.archive_dir], root);
          if (!r.ok) {
            recordAction(execution, 'archive_move', { status: 'failed' });
            // 常见根因：目录含未跟踪文件（git mv 拒绝）——预览应已提示先 save
            throw new SdlcError('validation_failed', `归档移动失败：${r.stderr || r.stdout}（目录含未跟踪文件时先 sdlc next --intent save 发布）`);
          }
          switchLoc(a.archive_dir);
          recordAction(execution, 'archive_move', { status: 'ok', detail: { archive_dir: a.archive_dir } });
          console.log(`✓ [archive_move] 已归档至 ${a.archive_dir}`);
        }
        break;
      }
      case 'meta_done': {
        if (execution.actions.meta_done?.status === 'ok') {
          console.log('✓ [meta_done] 已更新，跳过');
          break;
        }
        {
          // archive_move 成功才写（--no-archive_move → noop 留痕）；只服务 done 第一段
          const moved = execution.actions.archive_move?.status === 'ok';
          if (!moved) {
            recordAction(execution, 'meta_done', { status: 'ok', detail: { noop: true } });
            console.log('✓ [meta_done] 未归档，无字段可写，跳过');
            break;
          }
          const metaPath = path.join(loc.reqDir, 'meta.yaml');
          const meta = loadMeta(metaPath) ?? {};
          const fields = { archive_status: 'prepared' };
          saveMeta(metaPath, { ...meta, ...fields });
          recordAction(execution, 'meta_done', { status: 'ok', detail: { fields } });
          console.log('✓ [meta_done] meta archive_status=prepared——随归档提交发布');
        }
        break;
      }
      case 'archive_commit': {
        if (!loc.archiveRel) {
          // 归档未发生（--no-archive_move）→ 无归档提交；journal/meta 留原路径由 publish 收
          recordAction(execution, 'archive_commit', { status: 'ok', detail: { noop: true } });
          console.log('✓ [archive_commit] 未归档，跳过');
          break;
        }
        const prev = execution.actions.archive_commit;
        if (prev?.status === 'ok' && typeof prev.detail?.sha === 'string' && commitInBranch(root, prev.detail.sha)) {
          console.log(`✓ [archive_commit] 已完成（${prev.detail.sha.slice(0, 8)}），跳过`);
          break;
        }
        {
          // 收归档目录全部内容（git mv 已 stage rename，journal/meta 修改随后 add）；
          // 流程提交不接受 --message（非产物提交）；即发布动作——自身不写事件（契约 §5）
          const r = commitFiles(root, { files: [loc.archiveRel], subject: `${reqId} 归档准备`, reqId, type: 'chore', scope: 'sdlc' });
          const noop = r.stdout.includes('nothing to commit');
          if (!r.ok && !noop) {
            recordAction(execution, 'archive_commit', { status: 'failed' });
            throw new SdlcError('validation_failed', `归档提交失败：${r.stderr || r.stdout}`);
          }
          const sha = headSha(root) ?? '';
          recordAction(execution, 'archive_commit', { status: 'ok', detail: { sha, noop } });
          console.log(noop ? '✓ [archive_commit] 无归档改动（nothing to commit）' : `✓ [archive_commit] 归档提交：${sha.slice(0, 8)}`);
        }
        break;
      }
      case 'complete': {
        if (execution.actions.complete?.status === 'ok') {
          console.log('✓ [complete] 收尾已记录，跳过');
          break;
        }
        {
          // D59 新语义：适配层终态 transition（幂等门）+ completion_recorded 事件落
          // 本地 journal + meta.completion_status 本地写——不追加收尾提交/推送
          //（契约 §5、skill-core §7.6：不为事后日志再写主干；脏产物随下次发布收走）
          const a = act.args; // { completion: {source, result, accepted_gaps}, pr?: {repo, pr_id, url} }
          try {
            const resp = await core.completeRequirement({ reqId: plan.req_id, completion: a.completion, profile: plan.state?.profile });
            persistEvents('complete', 'ok', [
              makeEvent({
                action: 'completion_recorded', executionId: execution.execution_id, actionId: 'complete', planId: plan.plan_id, actor, result: 'succeeded',
                payload: { completion_status: resp.completion_status, source: resp.source, pr: a.pr ?? null, idempotent: resp.idempotent === true, accepted_gaps: a.completion?.accepted_gaps ?? [] },
              }),
            ], { resp });
            const metaPath = path.join(loc.reqDir, 'meta.yaml');
            const meta = loadMeta(metaPath) ?? {};
            saveMeta(metaPath, { ...meta, completion_status: resp.completion_status });
            console.log(`✓ [complete] 飞书终态已落，收尾已记录（completion=${resp.completion_status}，source=${resp.source}）——本地留痕，不追加收尾提交`);
          } catch (e) {
            if (e?.code === 'external_unknown') { recordAction(execution, 'complete', { status: 'unknown' }); throw e; }
            persistEvents('complete', 'failed', [
              makeEvent({
                action: 'completion_recorded', executionId: execution.execution_id, actionId: 'complete', planId: plan.plan_id, actor, result: 'failed',
                payload: { error: String(e?.message ?? e).slice(0, 200) },
              }),
            ]);
            throw e;
          }
        }
        break;
      }
      case 'meta_update': {
        if (execution.actions.meta_update?.status === 'ok') {
          console.log('✓ [meta_update] 已更新，跳过');
          break;
        }
        {
          // advance/change 成功才写阶段字段（--no-advance/--no-change 只同步其余
          // 字段）；阶段字段取适配层回读（real 无版本——本地观察链 +1 兜底）。
          // pr_ref 归 pr_link 直写（D59 人工路径），本动作不再经 pr_create 写
          const advanced = execution.actions.advance?.status === 'ok';
          const changed = execution.actions.change?.status === 'ok';
          const metaPath = path.join(loc.reqDir, 'meta.yaml');
          const meta = loadMeta(metaPath) ?? {};
          /** @type {Record<string, unknown>} */
          const fields = {};
          if (advanced || changed) {
            const st = await core.requirementState(plan.req_id);
            fields.current_stage = st.current_stage;
            fields.stage_version = typeof st.stage_version === 'number' ? st.stage_version : (meta.stage_version ?? 0) + 1;
            // 回退不覆盖首次进入时间：change 记 reentered，advance 记 entered
            const tkey = changed && !advanced ? `${st.current_stage}_reentered_at` : `${st.current_stage}_entered_at`;
            fields.timeline = { ...(meta.timeline ?? {}), [tkey]: new Date().toISOString() };
          }
          // tasks_map 回写（v5）：split/check 执行响应的 Tn→remote_id + 预览标题
          // 回查重建——随 Git 跨机共享（canonical 比较防无变化重写）
          const splitExt = execution.actions.tasks_split?.detail?.external ?? [];
          const checkExt = execution.actions.tasks_check?.detail?.external ?? [];
          const entries = Object.fromEntries(
            [...splitExt, ...checkExt, ...Object.entries(plan.state?.tasks_recovered ?? {}).map(([id, remote]) => ({ id, remote_id: remote }))]
              .filter((i) => i?.id && i?.remote_id)
              .map((i) => [i.id, String(i.remote_id)]),
          );
          if (Object.keys(entries).length > 0) {
            const merged = { ...(meta.tasks_map ?? {}), ...entries };
            if (canonical(merged) !== canonical(meta.tasks_map ?? {})) fields.tasks_map = merged;
          }
          const briefRel = `${plan.state.to}/brief.md`;
          if (existsSync(path.join(loc.reqDir, briefRel))) fields.last_brief = briefRel;
          if (Object.keys(fields).length === 0) {
            recordAction(execution, 'meta_update', { status: 'ok', detail: { noop: true } });
            console.log('✓ [meta_update] 无可更新字段，跳过');
            break;
          }
          saveMeta(metaPath, { ...meta, ...fields });
          recordAction(execution, 'meta_update', { status: 'ok', detail: { fields } });
          console.log(`✓ [meta_update] meta 已更新（${Object.keys(fields).join('、')}）——随 publish 提交`);
        }
        break;
      }
      case 'journal': {
        // 不因已 ok 早退：每次全量查缺补漏（覆盖「record 后、append 前」的崩溃窗口）
        const stored = /** @type {any[] | undefined} */ (execution.actions.journal?.detail?.events);
        const derive = opts.deriveEvents ?? ((p, exec, ch, actr) => deriveChoiceEvents(p, ch, actr, exec.execution_id));
        const choiceEvents = stored ?? derive(plan, execution, choices, actor);
        // 先固化派生事件（防重跑重造 id），再统一追加
        recordAction(execution, 'journal', { status: 'ok', detail: { events: choiceEvents } });
        const all = [
          ...choiceEvents,
          ...plan.actions.flatMap((a) => /** @type {any[]} */ (execution.actions[a.id]?.detail?.events ?? [])),
        ];
        const have = new Set(readJournal(loc.journalPath).events.map((e) => e.event_id));
        let n = 0;
        for (const ev of all) {
          if (!have.has(ev.event_id)) { appendEvent(loc.journalPath, ev); n++; }
        }
        if (n > 0) console.log(`✓ [journal] 追加 ${n} 个流程事件`);
        break;
      }
      case 'publish_commit': {
        const prev = execution.actions.publish_commit;
        if (prev?.status === 'ok' && typeof prev.detail?.sha === 'string' && commitInBranch(root, prev.detail.sha)) {
          console.log(`✓ [publish_commit] 已完成（${prev.detail.sha.slice(0, 8)}），跳过`);
          break;
        }
        if (!existsSync(loc.journalPath)) {
          recordAction(execution, 'publish_commit', { status: 'ok', detail: { noop: true } });
          console.log('✓ [publish_commit] 无流程记录文件，跳过');
          break;
        }
        // publish 自身不写 journal 事件（契约 §5 发布边界——不递归）
        const files = existsSync(path.join(root, loc.metaRel)) ? [loc.journalRel, loc.metaRel] : [loc.journalRel];
        const r = commitFiles(root, { files, subject: `${reqId} 流程记录发布`, reqId, type: 'chore', scope: 'sdlc' });
        const noop = r.stdout.includes('nothing to commit');
        if (!r.ok && !noop) {
          recordAction(execution, 'publish_commit', { status: 'failed' });
          throw new SdlcError('validation_failed', `流程记录提交失败：${r.stderr || r.stdout}`);
        }
        const sha = headSha(root) ?? '';
        recordAction(execution, 'publish_commit', { status: 'ok', detail: { sha, noop } });
        console.log(noop ? '✓ [publish_commit] 无新流程记录（nothing to commit）' : `✓ [publish_commit] 流程记录已提交：${sha.slice(0, 8)}`);
        break;
      }
      case 'publish_push': {
        if (execution.actions.publish_push?.status === 'ok' && branchSync(root).ahead === false && remoteRefExists(root, branch)) {
          console.log('✓ [publish_push] 流程记录已在远端，跳过');
          break;
        }
        const r = pushBranch(root, branch);
        if (!r.ok) {
          recordAction(execution, 'publish_push', { status: 'failed' });
          throw new SdlcError('external_unavailable', `流程记录推送失败：${r.stderr || r.stdout}——发布未完成，重跑本命令即续做`);
        }
        recordAction(execution, 'publish_push', { status: 'ok' });
        console.log('✓ [publish_push] 流程记录已推送');
        break;
      }
      default:
        // 未知动作：计划存档与实现不符（版本错位），不猜测执行
        throw new SdlcError('schema_unsupported', `计划含未知动作 ${act.id}——CLI 与存档计划版本不一致，请重新 sdlc next 预览`);
    }
  }
}

/**
 * save 派生事件（I4）：选择类 + remind_merge（预览时算好的提醒快照进 plan.state，
 * 执行期只消费——PR 状态参与指纹防夹带）。同执行 event_id 去重幂等。
 * @param {import('../plan.js').Plan} plan @param {any} execution
 * @param {Record<string, unknown>} choices @param {string} actor
 * @returns {any[]}
 */
export function deriveSaveEvents(plan, execution, choices, actor) {
  const events = deriveChoiceEvents(plan, choices, actor, execution.execution_id);
  const remind = plan.state?.remind;
  if (remind) {
    events.push(makeEvent({
      action: 'remind_merge', executionId: execution.execution_id, actionId: 'journal', planId: plan.plan_id, actor, result: 'succeeded',
      payload: { pr_id: remind.pr_id, url: remind.url, stage: remind.stage },
    }));
  }
  return events;
}

/**
 * done 第一段派生事件（I4）：选择类 + archive_prepared（「移动事件随归档提交
 * 发布」——事件先落，archive_commit 收走）。result 依 archive_move 实际状态。
 * @param {import('../plan.js').Plan} plan @param {any} execution
 * @param {Record<string, unknown>} choices @param {string} actor
 * @returns {any[]}
 */
export function deriveArchiveEvents(plan, execution, choices, actor) {
  const events = deriveChoiceEvents(plan, choices, actor, execution.execution_id);
  const moved = execution.actions.archive_move?.status === 'ok';
  events.push(makeEvent({
    action: 'archive_prepared', executionId: execution.execution_id, actionId: 'journal', planId: plan.plan_id, actor,
    result: moved ? 'succeeded' : 'failed',
    payload: {
      archive_dir: plan.state?.archive_dir ?? null,
      pr: plan.state?.pr ?? null,
      gaps: plan.gaps,
    },
  }));
  return events;
}
