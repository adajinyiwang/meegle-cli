// execution：本地记录持久化、choices_hash 锁定、findExecutionByPlan 恢复入口。
// 隔离：SDLC_HOME 指向临时目录（模块加载前设置 → 动态 import，EXEC_DIR 模块级常量）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'sdlc-exec-'));
process.env.SDLC_HOME = home;
const { newExecution, saveExecution, loadExecution, recordAction, findExecutionByPlan, listExecutions } =
  await import('../cli/src/execution.js');

test.after(() => rmSync(home, { recursive: true, force: true }));

const CHOICES = { intent: 'save', subject: '保存 7220318456 需求产物', accept_gaps: false, no_actions: [] };

test('newExecution：choices_hash 由 choices 决定（键序无关）', () => {
  const a = newExecution('p'.repeat(64), CHOICES, '7220318456');
  const b = newExecution('p'.repeat(64), { no_actions: [], accept_gaps: false, subject: '保存 7220318456 需求产物', intent: 'save' }, '7220318456');
  assert.equal(a.choices_hash, b.choices_hash);
  assert.notEqual(a.choices_hash, newExecution('p'.repeat(64), { ...CHOICES, subject: '另一个' }, '7220318456').choices_hash);
  assert.match(a.execution_id, /^exec-/);
});

test('saveExecution/loadExecution/recordAction：detail 可携带结构化事实（sha/事件对象）', () => {
  const rec = newExecution('a'.repeat(64), CHOICES, '7220318456');
  saveExecution(rec);
  const ev = { event_id: 'ev-x1', action: 'local_commit', result: 'succeeded' };
  recordAction(rec, 'commit', { status: 'ok', detail: { sha: 'f'.repeat(40), events: [ev] } });
  recordAction(rec, 'push', { status: 'skipped' });
  const loaded = loadExecution(rec.execution_id);
  assert.equal(loaded.actions.commit.detail.sha, 'f'.repeat(40));
  assert.deepEqual(loaded.actions.commit.detail.events, [ev]);
  assert.equal(loaded.actions.push.status, 'skipped');
  assert.ok(loaded.updated_at >= loaded.created_at);
});

test('findExecutionByPlan：按 plan_id 找回（next apply 恢复入口，D39）', () => {
  const pid = 'b'.repeat(64);
  assert.equal(findExecutionByPlan(pid), null);
  const rec = newExecution(pid, CHOICES, '7220318456');
  saveExecution(rec);
  const found = findExecutionByPlan(pid);
  assert.equal(found.execution_id, rec.execution_id);
});

test('listExecutions：最近在前，坏文件不猜测', () => {
  const pid = 'c'.repeat(64);
  const first = newExecution(pid, CHOICES, '7220318456');
  saveExecution(first);
  writeFileSync(path.join(home, 'executions', 'broken.json'), '{ not json', 'utf8');
  const ids = listExecutions().map((r) => r.execution_id);
  assert.ok(ids.includes(first.execution_id));
  assert.equal(ids.length, listExecutions().filter((r) => r.req_id === '7220318456').length);
});
