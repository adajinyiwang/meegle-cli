// execution 记录：~/.sdlc/executions/<id>.json（非版本化本地，契约 §6）。
// choices_hash 锁定用户已确认的槽位选择；action 结果逐项记录（重试去重依据）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sha256, canonical, shortId } from './util.js';
import { SDLC_HOME } from './config.js';

const EXEC_DIR = path.join(SDLC_HOME, 'executions');

/**
 * @typedef {object} ExecutionRecord
 * @property {string} execution_id
 * @property {string} plan_id
 * @property {string} choices_hash
 * @property {Record<string, unknown>} choices  用户已确认的选择（{} 表示无）
 * @property {string} req_id
 * @property {string} created_at
 * @property {string} updated_at
 * @property {Record<string, {status: 'ok'|'failed'|'skipped', detail?: unknown}>} actions
 *   detail 可携带结构化事实：提交 sha、journal 事件对象等（恢复按本机/远端 Git 事实核验）
 */

const execPath = (id) => path.join(EXEC_DIR, `${id}.json`);

/** @param {string} planId @param {Record<string, unknown>} choices @param {string} reqId @returns {ExecutionRecord} */
export function newExecution(planId, choices, reqId) {
  const now = new Date().toISOString();
  return {
    execution_id: shortId('exec'),
    plan_id: planId,
    choices_hash: sha256(canonical(choices)),
    choices,
    req_id: reqId,
    created_at: now,
    updated_at: now,
    actions: {},
  };
}

/** @param {ExecutionRecord} rec */
export function saveExecution(rec) {
  mkdirSync(EXEC_DIR, { recursive: true });
  rec.updated_at = new Date().toISOString();
  writeFileSync(execPath(rec.execution_id), JSON.stringify(rec, null, 2) + '\n', { encoding: 'utf8' });
}

/** @param {string} id @returns {ExecutionRecord | null} */
export function loadExecution(id) {
  const p = execPath(id);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * 记录单动作结果（幂等：同 action id 覆盖为最新结果）。
 * @param {ExecutionRecord} rec
 * @param {string} actionId
 * @param {{status: 'ok'|'failed'|'skipped', detail?: unknown}} result
 */
export function recordAction(rec, actionId, result) {
  rec.actions[actionId] = result;
  saveExecution(rec);
}

/**
 * 按 plan_id 找本机既有执行（next apply 的恢复入口：先识别旧执行再判变化，D39）。
 * @param {string} planId
 * @returns {ExecutionRecord | null}
 */
export function findExecutionByPlan(planId) {
  return listExecutions().find((r) => r.plan_id === planId) ?? null;
}

/**
 * 列出本机全部 execution（start 无参恢复/审计用，最近在前）。
 * 单个坏文件跳过不猜测（契约 §5 同语义：损坏不靠重建修好）。
 * @returns {ExecutionRecord[]}
 */
export function listExecutions() {
  if (!existsSync(EXEC_DIR)) return [];
  return readdirSync(EXEC_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return loadExecution(f.replace(/\.json$/, ''));
      } catch {
        return null;
      }
    })
    .filter(/** @param {any} r @returns {boolean} */ (r) => r !== null)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
