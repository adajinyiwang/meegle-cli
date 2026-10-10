// meegle 适配层 mock 轨（I6f）：createCore 路由 + createMockCore 语义——
// 幂等门三分（写前回读）、任务远端标识化（tasks_map 三级解析）、complete 终态、
// 故障注入（FLAKY 副作用已落 / UNKNOWN 未执行）。与真实通道严格同形（D52）。
// 隔离：SDLC_MOCK_STATE / SDLC_MOCK（模块加载前设置 → 动态 import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-mock-'));
process.env.SDLC_MOCK_STATE = tmp;
process.env.SDLC_MOCK = '1';
const { createCore } = await import('../cli/src/meegle/index.js');
const { createMockCore } = await import('../cli/src/meegle/mock.js');
const { SdlcError } = await import('../cli/src/errors.js');

const core = createMockCore();
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const REQ = '7220318456'; // seed：dev v2 + 入口任务「确认进入开发」
const REQ2 = '7114275203'; // seed：prd v1（互不污染）

test('路由：SDLC_MOCK=1 → createCore 走 mock 轨（mock:true）', () => {
  const c = createCore();
  assert.equal(c.mock, true);
});

test('me：mock 身份固定（不查网络）', async () => {
  const resp = await core.me();
  assert.equal(resp.actor.actor_id, 'usr-mock-dev');
});

test('requirementState：存在 → 回显形状（tasks 以远端标识为 id）；不存在 → not_found', async () => {
  const s = await core.requirementState(REQ);
  assert.equal(s.req_id, REQ);
  assert.equal(s.title, '报表导出');
  assert.equal(s.current_stage, 'dev');
  assert.equal(s.stage_version, 2);
  assert.equal(s.participants_source, 'feishu');
  assert.ok(Array.isArray(s.participants.dev));
  assert.ok(Array.isArray(s.tasks));
  assert.ok(s.tasks.some((t) => t.title === '确认进入开发' && t.id === 'st-entry-1' && t.state === 'open'));

  await assert.rejects(
    () => core.requirementState('9999999999'),
    (e) => e instanceof SdlcError && e.code === 'not_found',
  );
});

test('advanceStage：成功推进 + 入口任务不在此勾选（D48 v2：拆分任务后才勾）+ 响应形状', async () => {
  const r = await core.advanceStage({ reqId: REQ, from: 'dev', to: 'test', entryTasks: ['确认进入开发', '不存在的任务'] });
  assert.equal(r.from_version, 2);
  assert.equal(r.to_version, 3);
  assert.equal(r.idempotent, false);
  assert.equal(r.node_status, 'finished');
  const s = await core.requirementState(REQ);
  assert.equal(s.current_stage, 'test');
  assert.equal(s.stage_version, 3);
  // 入口任务勾选拆到 tasks_split 之后（common.js 尾段调 checkTasks）——advance 不动它
  assert.equal(s.tasks.find((t) => t.title === '确认进入开发').state, 'open');
});

test('advanceStage 幂等门：已在 to → 幂等重放（idempotent:true，版本不再 +1）', async () => {
  const r = await core.advanceStage({ reqId: REQ, from: 'dev', to: 'test', entryTasks: [] });
  assert.equal(r.idempotent, true);
  assert.equal(r.to_version, 3);
  const s = await core.requirementState(REQ);
  assert.equal(s.stage_version, 3); // 未重复推进
});

test('advanceStage 分歧：远端在别处 → validation_failed（原 409 语义退役，先读后写）', async () => {
  await assert.rejects(
    () => core.advanceStage({ reqId: REQ, from: 'dev', to: 'done', entryTasks: [] }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.details?.remote_stage === 'test',
  );
});

test('changeStage：回退推进 + 观察链 +1；幂等重放不重复计', async () => {
  const r = await core.changeStage({ reqId: REQ, from: 'test', to: 'dev' });
  assert.equal(r.from_version, 3);
  assert.equal(r.to_version, 4);
  assert.equal(r.idempotent, false);
  const s = await core.requirementState(REQ);
  assert.equal(s.current_stage, 'dev');
  assert.equal(s.stage_version, 4);
  const again = await core.changeStage({ reqId: REQ, from: 'test', to: 'dev' });
  assert.equal(again.idempotent, true);
  assert.equal((await core.requirementState(REQ)).stage_version, 4);
});

test('splitTasks：增量创建（返回 remote_id）+ 同名复用不重复创建（v5 标题幂等）', async () => {
  const r = await core.splitTasks({
    reqId: REQ,
    tasks: [
      { id: 'T1', title: '接口重构', assignee_role: 'dev' },
      { id: 'T2', title: '确认进入开发', assignee_role: 'dev' }, // 与入口任务同名 → 复用
    ],
  });
  assert.equal(r.items[0].result, 'created');
  assert.ok(r.items[0].remote_id.startsWith('st-'));
  assert.equal(r.items[1].result, 'already_exists');
  assert.equal(r.items[1].remote_id, 'st-entry-1');
  const s = await core.requirementState(REQ);
  assert.equal(s.tasks.filter((t) => t.title === '接口重构').length, 1); // 只一条
});

test('checkTasks：三级解析（remote_id → tasks_map → 标题）+ no_op + not_found + cancelled', async () => {
  const remoteT1 = 'st-100'; // splitTasks 首个分配的远端 id（seed next_task_seq=100）
  const r = await core.checkTasks({
    reqId: REQ,
    items: [
      { id: 'T1', remote_id: remoteT1, state: 'completed' }, // 显式远端标识
      { id: 'T1', title: '接口重构', state: 'cancelled' }, // 标题匹配（已 completed → 更新为 cancelled）
      { id: 'T-entry', state: 'completed' }, // tasks_map 映射（拆分后勾选场景 → completed）
      { id: 'T9', title: '不存在', state: 'completed' }, // 三级全不中 → not_found
    ],
    tasksMap: { 'T-entry': 'st-entry-1' },
  });
  assert.deepEqual(r.items.map((i) => [i.id, i.result]), [
    ['T1', 'completed'],
    ['T1', 'cancelled'],
    ['T-entry', 'completed'], // 拆分后勾选（D48 v2：advance 不勾、tasks_split 尾段勾）
    ['T9', 'not_found'],
  ]);
  const s = await core.requirementState(REQ);
  assert.equal(s.tasks.find((t) => t.id === remoteT1).state, 'cancelled');

  // tasks_map 映射：本地 id → 远端标识（换机回查重建场景）
  const viaMap = await core.checkTasks({
    reqId: REQ,
    items: [{ id: 'T1', state: 'completed' }], // 无 remote_id、无 title
    tasksMap: { T1: remoteT1 },
  });
  assert.equal(viaMap.items[0].result, 'completed'); // cancelled → completed 再更新
});

test('completeRequirement：终态流转 + source=manual 如实限值 + 幂等重放', async () => {
  // 先推进到 done 前一位置（test），验证 complete 时观察链再 +1
  await core.advanceStage({ reqId: REQ, from: 'dev', to: 'test', entryTasks: [] });
  const vBefore = (await core.requirementState(REQ)).stage_version;
  const r = await core.completeRequirement({ reqId: REQ, completion: { source: 'manual', result: 'verified', accepted_gaps: ['g1'] } });
  assert.equal(r.completion_status, 'manual'); // 人工确认不伪称 verified
  assert.equal(r.source, 'manual');
  assert.equal(r.idempotent, false);
  const s = await core.requirementState(REQ);
  assert.equal(s.current_stage, 'done');
  assert.equal(s.stage_version, vBefore + 1); // 终态流转计入观察链
  assert.equal(s.completion_status, 'manual');
  // 幂等重放：返回上次结果（恢复重跑不二次流转）
  const again = await core.completeRequirement({ reqId: REQ, completion: { source: 'manual', result: 'verified', accepted_gaps: [] } });
  assert.equal(again.idempotent, true);
  assert.equal(again.completion_status, 'manual');
  assert.equal((await core.requirementState(REQ)).stage_version, vBefore + 1);

  // api 来源按 result 落（REQ2 未流转：complete 从 prd 直落终态）
  const r2 = await core.completeRequirement({ reqId: REQ2, completion: { source: 'api', result: 'verified', accepted_gaps: [] } });
  assert.equal(r2.completion_status, 'verified');
  assert.equal((await core.requirementState(REQ2)).completion_status, 'verified');
});

test('故障注入：FLAKY 副作用已落库（响应丢失）；UNKNOWN 未执行即失败', async () => {
  // UNKNOWN：动作未执行即失败（无副作用——续做安全）
  process.env.SDLC_MOCK_UNKNOWN_ACTION = 'tasks_split';
  await assert.rejects(
    () => core.splitTasks({ reqId: REQ, tasks: [{ id: 'T7', title: '注入', assignee_role: 'dev' }] }),
    (e) => e instanceof SdlcError && e.code === 'external_unknown',
  );
  delete process.env.SDLC_MOCK_UNKNOWN_ACTION;
  assert.ok(!(await core.requirementState(REQ)).tasks.some((t) => t.title === '注入')); // 未落地

  // FLAKY：副作用落地后响应丢失（「结果未知不盲重发」场景——先读后写可发现）
  process.env.SDLC_MOCK_FLAKY_ACTION = 'tasks_split';
  await assert.rejects(
    () => core.splitTasks({ reqId: REQ, tasks: [{ id: 'T7', title: '注入', assignee_role: 'dev' }] }),
    (e) => e instanceof SdlcError && e.code === 'external_unknown',
  );
  delete process.env.SDLC_MOCK_FLAKY_ACTION;
  const s = await core.requirementState(REQ);
  assert.ok(s.tasks.some((t) => t.title === '注入')); // 已落地（回读可见）
  // 重发同名 → 幂等复用（already_exists，不重复创建）
  const r = await core.splitTasks({ reqId: REQ, tasks: [{ id: 'T7', title: '注入', assignee_role: 'dev' }] });
  assert.equal(r.items[0].result, 'already_exists');
});

test('mock db 直改可见（测试钩子：db.json 单一文件态）', async () => {
  const dbFile = path.join(tmp, 'db.json');
  const db = JSON.parse(readFileSync(dbFile, 'utf8'));
  db.requirements['7330999000'] = {
    req_id: '7330999000', title: '直改需求', url: 'u', profile: 'story',
    current_stage: 'dev', stage_version: 1, participants: {}, completion_status: 'pending',
    tasks: [{ remote_id: 'st-x', title: 'X', state: 'open' }],
  };
  writeFileSync(dbFile, JSON.stringify(db, null, 2));
  const s = await core.requirementState('7330999000');
  assert.equal(s.title, '直改需求');
});
