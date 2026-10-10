// meta.yaml：派生快照的读、写（确认计划内持久化）与从 journal 重建。
// 契约出处：sdlc-contract §4（meta 字段/派生快照边界；v5：新增 tasks_map/
// user_key，参与人为 {user_key, name} 数组）；预览只在内存，落盘走确认计划。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import yaml from '../vendor/js-yaml/dist/js-yaml.mjs';
import { SdlcError } from './errors.js';

/**
 * @typedef {object} Meta 契约 §4 形状（节选）
 * @property {number} schema_version
 * @property {string} req_id
 * @property {string} title
 * @property {string} feishu_url
 * @property {string} profile
 * @property {string} branch
 * @property {string} current_stage
 * @property {number} stage_version
 * @property {string} config_revision
 * @property {any} pr_ref
 * @property {Record<string, string>} tasks_map  Tn → 远端子任务标识（v5，随 Git 跨机共享）
 * @property {string | null} user_key   meegle 登录用户标识（user me）
 * @property {Record<string, {user_key: string, name: string}[]>} participants
 * @property {string} participants_source
 * @property {string | null} participants_checked_at
 * @property {any[]} additional_items
 * @property {any[]} artifact_refs
 * @property {string | null} last_brief
 * @property {number} test_round
 * @property {string} archive_status        active/prepared/not_relocated
 * @property {string} completion_status     pending/verified/manual/with_gaps
 * @property {string} sync_status           verified/manual/skipped/unknown
 * @property {Record<string, string>} timeline
 */

/** @param {string} metaPath @returns {Meta | null} */
export function loadMeta(metaPath) {
  if (!existsSync(metaPath)) return null;
  try {
    return yaml.load(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    throw new SdlcError('validation_failed', `meta.yaml 解析失败：${e.message}`);
  }
}

/** @param {string} metaPath @param {Meta} meta */
export function saveMeta(metaPath, meta) {
  mkdirSync(path.dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, yaml.dump(meta, { lineWidth: 120 }), { encoding: 'utf8' });
}

/**
 * 绑定建档时按契约 §4 形状初始化 meta。
 * @param {any} stateResp requirementState 回读（标题/URL/阶段/参与人——meegle 适配层形状）
 * @param {{branch: string, configRevision: string, userKey?: string | null}} ctx
 * @returns {Meta}
 */
export function initMetaFromBind(stateResp, ctx) {
  const checkedAt = new Date().toISOString();
  const participants = /** @type {Meta['participants']} */ ({});
  for (const [role, list] of Object.entries(stateResp.participants ?? {})) {
    // v5 参与人 {user_key, name}（旧 actor_id 字段容错读——M1 #31 读取形状回填）
    participants[role] = /** @type {{user_key: string, name: string}[]} */ (list);
  }
  return {
    schema_version: 5,
    req_id: String(stateResp.req_id),
    title: stateResp.title,
    feishu_url: stateResp.url,
    profile: stateResp.profile,
    branch: ctx.branch,
    current_stage: stateResp.current_stage,
    // v5：stage_version 是 journal 观察链（远端无版本）；绑定基线 v1
    stage_version: typeof stateResp.stage_version === 'number' ? stateResp.stage_version : 1,
    config_revision: ctx.configRevision,
    pr_ref: null,
    tasks_map: {},
    user_key: ctx.userKey ?? null,
    participants,
    participants_source: stateResp.participants_source ?? 'feishu',
    participants_checked_at: checkedAt,
    additional_items: [],
    artifact_refs: [],
    last_brief: null,
    test_round: 0,
    archive_status: 'active',
    completion_status: 'pending',
    sync_status: 'verified',
    timeline: {},
  };
}

/**
 * 从 journal 事件链内存重建阶段（契约 §4：meta 是派生快照，可从合法证据重建）。
 * 只认 bind / stage_advance / change_request 的合法版本链；缺事件或断链不猜。
 * @param {import('./journal.js').JournalEvent[]} events
 * @returns {{current_stage: string | null, stage_version: number, chain_broken: boolean}}
 */
export function rebuildStage(events) {
  let stage = /** @type {string | null} */ (null);
  let version = 0;
  let broken = false;
  for (const ev of events) {
    if (ev.action === 'bind') {
      const from0 = ev.payload?.current_stage;
      const v0 = ev.payload?.stage_version;
      if (typeof from0 === 'string' && typeof v0 === 'number') { stage = from0; version = v0; }
      else broken = true;
    } else if (ev.action === 'stage_advance' || ev.action === 'change_request') {
      const fromV = ev.payload?.from_version;
      const toV = ev.payload?.to_version;
      const to = ev.payload?.to;
      if (fromV === version && typeof toV === 'number' && typeof to === 'string' && toV === version + 1) {
        stage = to;
        version = toV;
      } else {
        broken = true; // 断链/冲突：契约 §5 不按时间排序猜状态
      }
    }
  }
  return { current_stage: stage, stage_version: version, chain_broken: broken };
}
