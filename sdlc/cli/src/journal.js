// journal.jsonl：append-only 流程事件、event_id 去重、v5 事件形状。
// 契约出处：sdlc-contract §5（事件字段/事件枚举/去重因果/本机时间仅展示；
// v5：外部事实由 journal + meegle 远端回读承载，completion_recorded 随终态落）。
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { canonical, shortId } from './util.js';
import { SdlcError } from './errors.js';

/** 契约 §5 事件动作枚举 */
export const EVENT_ACTIONS = [
  'bind', 'local_commit', 'push', 'task_synced', 'pr_created', 'pr_linked',
  'stage_advance', 'change_request', 'brief_prepared', 'handoff_prepared',
  'gap_accepted', 'manual_confirmed', 'action_skipped', 'archive_prepared',
  'archive_restored', 'remind_merge', 'operation_reconciled', 'error', 'completion_recorded',
];

/**
 * @typedef {object} JournalEvent v5 事件（契约 §5）
 * @property {number} v
 * @property {string} event_id
 * @property {string} execution_id
 * @property {string} action_id
 * @property {string} plan_id
 * @property {string} actor
 * @property {string} ts        ISO 本机时间，仅展示不裁决因果
 * @property {string} action
 * @property {string} result
 * @property {Record<string, unknown>} payload
 */

/**
 * @param {object} input
 * @param {string} input.action   EVENT_ACTIONS 之一
 * @param {string} [input.eventId] 重试恢复复用同一 ID；缺省新造
 * @param {string} input.executionId
 * @param {string} input.actionId
 * @param {string} input.planId
 * @param {string} input.actor
 * @param {string} input.result
 * @param {Record<string, unknown>} [input.payload]
 * @returns {JournalEvent}
 */
export function makeEvent(input) {
  if (!EVENT_ACTIONS.includes(input.action)) {
    throw new SdlcError('validation_failed', `未知事件动作 ${input.action}（不在契约 §5 枚举内）`);
  }
  return {
    v: 5,
    event_id: input.eventId ?? shortId('ev'),
    execution_id: input.executionId,
    action_id: input.actionId,
    plan_id: input.planId,
    actor: input.actor,
    ts: new Date().toISOString(),
    action: input.action,
    result: input.result,
    payload: input.payload ?? {},
  };
}

/**
 * 读全量事件；坏行不猜测（契约 §5：journal 损坏不能靠重建修好），收集为 issues 由调用方展示。
 * @param {string} journalPath
 * @returns {{events: JournalEvent[], issues: {line: number, text: string}[]}}
 */
export function readJournal(journalPath) {
  if (!existsSync(journalPath)) return { events: [], issues: [] };
  const lines = readFileSync(journalPath, 'utf8').split('\n');
  /** @type {JournalEvent[]} */
  const events = [];
  /** @type {{line: number, text: string}[]} */
  const issues = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    try {
      events.push(JSON.parse(t));
    } catch {
      issues.push({ line: i + 1, text: t.slice(0, 80) });
    }
  });
  return { events, issues };
}

/**
 * 追加事件，契约 §5 去重规则 1：同 event_id 同内容静默跳过（重试安全）；
 * 同 ID 不同内容视为异常，不按整行文本静默择一。
 * @param {string} journalPath
 * @param {JournalEvent} event
 * @returns {'appended' | 'duplicate'}
 */
export function appendEvent(journalPath, event) {
  const { events } = readJournal(journalPath);
  const existing = events.find((e) => e.event_id === event.event_id);
  if (existing) {
    if (canonical(existing) === canonical(event)) return 'duplicate';
    throw new SdlcError('validation_failed', `event_id ${event.event_id} 已存在且内容不同（契约 §5：同 ID 不同内容为异常，需人工核对）`);
  }
  appendFileSync(journalPath, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  return 'appended';
}
