// journal：事件工厂、追加、去重（同 ID 同内容）、同 ID 不同内容冲突。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeEvent, appendEvent, readJournal } from '../cli/src/journal.js';
import { SdlcError } from '../cli/src/errors.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const jp = path.join(tmp, 'journal.jsonl');

const baseInput = {
  action: 'bind',
  executionId: 'exec-1',
  actionId: 'bind',
  planId: 'plan-abc',
  actor: 'usr-1',
  result: 'ok',
  payload: { current_stage: 'prd', stage_version: 1 },
};

test('makeEvent：未知 action → validation_failed', () => {
  assert.throws(
    () => makeEvent({ ...baseInput, action: 'nope' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed',
  );
});

test('appendEvent → appended；同 ID 同内容 → duplicate；同 ID 异内容 → 抛错', () => {
  const ev = makeEvent(baseInput);
  assert.equal(appendEvent(jp, ev), 'appended');
  assert.equal(appendEvent(jp, ev), 'duplicate');
  const ev2 = makeEvent({ ...baseInput, eventId: ev.event_id, payload: { current_stage: 'dev', stage_version: 2 } });
  assert.throws(
    () => appendEvent(jp, ev2),
    (e) => e instanceof SdlcError && e.code === 'validation_failed',
  );
  const { events } = readJournal(jp);
  assert.equal(events.length, 1);
  assert.equal(events[0].action, 'bind');
});

test('readJournal：坏行收集为 issues，不猜测', () => {
  appendFileSync(jp, 'this is not json\n', 'utf8');
  const { events, issues } = readJournal(jp);
  assert.equal(events.length, 1);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 2);
});
