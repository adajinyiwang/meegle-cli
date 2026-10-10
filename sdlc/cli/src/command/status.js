// sdlc status：只读快照（当前需求或指定需求）。无写入、无副作用。
// 恢复展示（start 无参）复用本文件 renderSnapshot / listActiveRequirements。
// I3 深化：归档定点定位（D42）、交接话术只读补取（D46）。
// v5（D59 人工路径）：PR 状态不可回读——快照 PR 行恒「不可回读」，如实展示。
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { findSdlcRoot, loadRepoConfig, evaluateDod } from '../config.js';
import { loadMeta } from '../meta.js';
import { readJournal } from '../journal.js';
import { listExecutions } from '../execution.js';
import { currentBranch, parseReqFromBranch, branchSync } from '../gitops.js';
import { SdlcError } from '../errors.js';

/**
 * 活跃需求目录列表（排除 archive/，D42：已合并未归档仍列）。
 * @param {string} root
 * @returns {{reqId: string, dir: string}[]}
 */
export function listActiveRequirements(root) {
  const sdlcDir = path.join(root, '.sdlc');
  if (!existsSync(sdlcDir)) return [];
  return readdirSync(sdlcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^req-\d+$/.test(e.name))
    .map((e) => ({ reqId: e.name.slice(4), dir: path.join(sdlcDir, e.name) }));
}

/**
 * 归档需求定点定位（D42：只扫目录名 `-req-<id>` 后缀，不读内容）。done 复用（防重复归档）。
 * @param {string} root
 * @param {string} reqId
 * @returns {{dir: string, name: string} | null}
 */
export function findArchived(root, reqId) {
  const archiveDir = path.join(root, '.sdlc', 'archive');
  if (!existsSync(archiveDir)) return null;
  const name = readdirSync(archiveDir).find((n) => n.endsWith(`-req-${reqId}`));
  return name ? { dir: path.join(archiveDir, name), name } : null;
}

/**
 * 需求快照渲染（markdown，人读）。离线（不查远端）——start.js 恢复展示零改动复用。
 * @param {string} root 仓库根
 * @param {string} reqDir .sdlc/req-<id>
 * @returns {string}
 */
export function renderSnapshot(root, reqDir) {
  const { config } = loadRepoConfig(root);
  const meta = loadMeta(path.join(reqDir, 'meta.yaml'));
  if (!meta) return `（${reqDir} 无 meta.yaml，数据不完整）`;
  const { events, issues } = readJournal(path.join(reqDir, 'journal.jsonl'));
  const sync = branchSync(root);
  const dod = evaluateDod(config, reqDir, sync, meta.current_stage, { meta });
  const last = events[events.length - 1];

  const lines = [];
  lines.push(`需求 ${meta.req_id}：${meta.title}`);
  lines.push(`  链接：${meta.feishu_url}`);
  lines.push(`  阶段：${meta.current_stage}；分支：${meta.branch}`);
  lines.push(`  状态：archive=${meta.archive_status} completion=${meta.completion_status} sync=${meta.sync_status}`);
  if (meta.pr_ref) {
    const pending = meta.completion_status === 'pending' ? '——待人工合并（状态不可回读，人工路径）' : '';
    lines.push(`  MR：#${meta.pr_ref.pr_id}${meta.pr_ref.url ? ` ${meta.pr_ref.url}` : ''}${pending}`);
  }
  const roles = Object.entries(meta.participants ?? {})
    .map(([role, list]) => `${role}:${list.map((p) => p.name).join(',')}`)
    .join(' ');
  lines.push(`  参与人：${roles}`);
  lines.push(`  journal：${events.length} 事件${issues.length > 0 ? `（⚠ ${issues.length} 坏行，需人工核对）` : ''}`);
  if (last) lines.push(`  最近事件：${last.action}（${last.ts}）`);
  if (dod.length > 0) {
    lines.push(`  DoD（${meta.current_stage}）：`);
    for (const d of dod) {
      const mark = d.status === 'ok' ? '✓' : d.status === 'gap' ? '✗' : '?';
      lines.push(`    [${mark}] ${d.text}${d.note ? `（${d.note}）` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * 交接话术只读补取（D46）：journal 最后一个 handoff_prepared 的 payload 渲染，
 * 发布状态按该 execution 的 publish_push 事实区分。不追加事件不改文件。
 * @param {string} reqDir
 * @returns {string | null}
 */
function readHandoffNote(reqDir) {
  const { events } = readJournal(path.join(reqDir, 'journal.jsonl'));
  const prep = [...events].reverse().find((e) => e.action === 'handoff_prepared');
  if (!prep) return null;
  const p = prep.payload ?? {};
  const exec = listExecutions().find((r) => r.execution_id === prep.execution_id);
  const published = exec?.actions?.publish_push?.status === 'ok';
  return [
    '交接话术（最近一次 handoff_prepared 补取，可复制转发）：',
    '  ---',
    `  【${p.req_id}】${p.advanced ? `已进入 ${p.to} 阶段` : `阶段未推进（${p.from} → ${p.to} 未完成）`}，请接手：`,
    `    git checkout ${p.branch}`,
    `    sdlc start ${p.req_id}`,
    ...(p.entry_tasks?.length ? [`    入口任务已勾选：${p.entry_tasks.join('、')}`] : []),
    // v5 payload.pr 是人工路径事实（manual + create_url）——不是 MR 详情
    ...(p.pr?.create_url ? [`    MR 创建链接：${p.pr.create_url}`] : []),
    '  ---',
    `  发布状态：${published ? '已发布' : '未核实（publish_push 未完成或执行记录缺失）'}`,
  ].join('\n');
}

/**
 * @param {string[]} args 位置参数（可选 req_id）
 * @param {{json?: boolean}} opts
 * @returns {Promise<number>}
 */
export async function runStatus(args, opts = {}) {
  const root = findSdlcRoot(process.cwd());
  if (!root) {
    console.error('当前目录不在 sdlc 接入的仓库内（未找到 .sdlc/）。请先运行 sdlc init。');
    return 1;
  }
  let reqId = args[0] ?? null;
  if (!reqId) {
    const b = currentBranch(root);
    const parsed = b ? parseReqFromBranch(b) : null;
    if (parsed) reqId = parsed.reqId;
  }
  const active = listActiveRequirements(root);
  if (!reqId) {
    if (active.length === 0) {
      console.log('本仓库暂无活跃需求（.sdlc/req-*/ 为空）。');
      return 0;
    }
    console.log(`未指定需求且当前分支非需求分支。活跃需求 ${active.length} 个：`);
    for (const a of active) console.log(`  ${renderSnapshotOneLine(root, a)}`);
    console.log('（用 sdlc status <req_id> 查看详情）');
    return 0;
  }
  const hit = active.find((a) => a.reqId === reqId);
  let dir = hit?.dir ?? null;
  let archivedName = null;
  if (!dir) {
    const arch = findArchived(root, reqId);
    if (arch) {
      dir = arch.dir;
      archivedName = arch.name;
    } else {
      throw new SdlcError('not_found', `需求 ${reqId} 无本地档案（.sdlc/req-${reqId}/ 与 .sdlc/archive/ 均未找到）`);
    }
  }
  const meta = loadMeta(path.join(dir, 'meta.yaml'));
  if (!meta) throw new SdlcError('not_found', `${dir} 无 meta.yaml，数据不完整`);
  const note = readHandoffNote(dir);
  if (opts.json) {
    console.log(JSON.stringify(snapshotJson(root, { reqId, dir }, note), null, 2));
  } else {
    if (archivedName) console.log(`（已归档：.sdlc/archive/${archivedName}）`);
    console.log(renderSnapshot(root, dir));
    if (note) console.log(note);
  }
  return 0;
}

/** @param {string} root @param {{reqId: string, dir: string}} a */
function renderSnapshotOneLine(root, a) {
  const meta = loadMeta(path.join(a.dir, 'meta.yaml'));
  const { events } = readJournal(path.join(a.dir, 'journal.jsonl'));
  const last = events[events.length - 1];
  const stage = meta?.current_stage ?? '?';
  const ts = last?.ts?.slice(0, 10) ?? '无事件';
  return `${a.reqId}  ${meta?.title ?? '（无 meta）'}  阶段=${stage}  最近活动=${ts}`;
}

/**
 * @param {string} root @param {{reqId: string, dir: string}} a
 * @param {string | null} [handoffNote]
 */
function snapshotJson(root, a, handoffNote = null) {
  const { config, configRevision } = loadRepoConfig(root);
  const meta = loadMeta(path.join(a.dir, 'meta.yaml'));
  const { events, issues } = readJournal(path.join(a.dir, 'journal.jsonl'));
  const sync = branchSync(root);
  const prep = [...events].reverse().find((e) => e.action === 'handoff_prepared');
  return {
    req_id: a.reqId,
    meta,
    config_revision: configRevision,
    stages: config.stages,
    journal: { count: events.length, issues: issues.length, last: events[events.length - 1] ?? null },
    git_sync: sync,
    // v5：PR 状态不可回读（人工路径）——只回显本地引用，state 恒 unknown
    pr: meta?.pr_ref ? { ref: meta.pr_ref, state: 'unknown' } : null,
    handoff_prepared: prep ? { event_id: prep.event_id, ts: prep.ts, payload: prep.payload } : null,
    handoff_note: handoffNote,
    dod: meta ? evaluateDod(config, a.dir, sync, meta.current_stage, { meta }) : [],
  };
}
