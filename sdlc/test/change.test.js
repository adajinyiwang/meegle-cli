// :change 回退全链（I4，D38/D45）：互斥分发/候选/预览/apply（db 回退 + 版本 +1
// + change_request 事件 + meta reentered timeline）/幂等/409 过期/--no-change/
// 多候选 slots/脏产物提交/普通 --apply 恢复路由。
// 隔离：SDLC_HOME/SDLC_MOCK_STATE 临时目录（模块加载前设置 → 动态 import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(path.join(tmpdir(), 'sdlc-home-'));
process.env.SDLC_HOME = home;
process.env.SDLC_MOCK_STATE = mkdtempSync(path.join(tmpdir(), 'sdlc-mock-'));
process.env.SDLC_MOCK = '1'; // 命令层 createCore 走 mock 轨（v5：SDLC_MOCK 显式开关）

const { runNext } = await import('../cli/src/command/next.js');
const { createMockCore } = await import('../cli/src/meegle/mock.js');
const { loadPlan } = await import('../cli/src/plan.js');
const { readJournal } = await import('../cli/src/journal.js');
const { findExecutionByPlan } = await import('../cli/src/execution.js');
const { SdlcError } = await import('../cli/src/errors.js');

const REQ = '7220318456';
const BRANCH = `req/${REQ}-login`;
const NEXT_REG = /确认执行：sdlc next --apply ([0-9a-f]{64})/;

const repos = [];
test.after(() => {
  process.chdir(tmpdir());
  for (const r of repos) rmSync(r, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(process.env.SDLC_MOCK_STATE, { recursive: true, force: true });
});

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const gitOut = (args, cwd) => {
  const r = git(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
};

// 三阶段链：prd → dev → test（回退候选 = current 之前的全部阶段）
const CHANGE_CONFIG = `schema_version: 5
git:
  trunk: main
stages:
  - id: prd
    next: dev
    dod:
      - id: prd-sync
        text: 已同步
        check: git_synced
  - id: dev
    next: test
    dod:
      - id: dev-sync
        text: 已同步
        check: git_synced
  - id: test
    next: done
    dod:
      - id: test-brief
        text: 测试简报
        check: file_exists
        path: test/brief.md
`;
const META_DEV = (stageVersion = 2) => `schema_version: 5
req_id: "${REQ}"
title: 报表导出
feishu_url: https://project.feishu.cn/req/${REQ}
profile: dev
branch: ${BRANCH}
current_stage: dev
stage_version: ${stageVersion}
config_revision: x
timeline:
  prd_entered_at: 2026-09-01T00:00:00.000Z
`;
const BIND_EVENT = JSON.stringify({
  v: 5, event_id: 'ev-bind0', execution_id: 'exec-init', action_id: 'bind', plan_id: 'p-init',
  actor: 'usr-mock-dev', ts: '2026-09-29T00:00:00.000Z', action: 'bind', result: 'ok', payload: {},
});

const dbPath = () => path.join(process.env.SDLC_MOCK_STATE, 'db.json');
const mockDb = () => JSON.parse(readFileSync(dbPath(), 'utf8'));
const setDb = (fn) => {
  const db = mockDb();
  fn(db);
  writeFileSync(dbPath(), JSON.stringify(db, null, 2));
};

/**
 * 建仓库 + mock db 对齐（stage 缺省 dev v2 = seed；可指定 test/版本）。
 * @param {{stage?: string, version?: number}} [core]
 */
async function makeRepo(core = { stage: 'dev', version: 2 }) {
  if (existsSync(dbPath())) rmSync(dbPath(), { force: true });
  await createMockCore().requirementState(REQ); // 触发 mock db seed（loadDb 写默认底本）
  setDb((db) => {
    db.requirements[REQ].current_stage = core.stage;
    db.requirements[REQ].stage_version = core.version;
  });
  const repo = mkdtempSync(path.join(tmpdir(), 'sdlc-repo-'));
  repos.push(repo);
  git(['init'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 't'], repo);
  const reqDir = path.join(repo, '.sdlc', `req-${REQ}`);
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(path.join(reqDir, 'meta.yaml'), META_DEV(core.version));
  writeFileSync(path.join(reqDir, 'journal.jsonl'), BIND_EVENT + '\n');
  writeFileSync(path.join(repo, '.sdlc', 'config.yaml'), CHANGE_CONFIG);
  writeFileSync(path.join(repo, 'README.md'), 'init\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: init'], repo);
  git(['checkout', '-b', BRANCH], repo);
  const origin = mkdtempSync(path.join(tmpdir(), 'sdlc-origin-'));
  repos.push(origin);
  git(['init', '--bare'], origin);
  git(['remote', 'add', 'origin', origin.replace(/\\/g, '/')], repo);
  git(['push', '-u', 'origin', BRANCH], repo);
  process.chdir(repo);
  return repo;
}

async function runCapture(positional, flags) {
  const out = [];
  const log = console.log, err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { rc: await runNext(positional, flags), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const planIdOf = (out) => {
  const m = out.join('\n').match(NEXT_REG);
  assert.ok(m, `输出中未找到 plan_id：\n${out.join('\n')}`);
  return m[1];
};
const journalEvents = (repo) => readJournal(path.join(repo, '.sdlc', `req-${REQ}`, 'journal.jsonl')).events;

// ---------- 分发互斥 ----------

test('互斥：--request-change 与 --intent/--apply 同用 → validation_failed；无值 → 报错', async () => {
  await makeRepo();
  await assert.rejects(
    () => runNext([], { requestChange: '原因', intent: 'save' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('互斥'),
  );
  await assert.rejects(
    () => runNext([], { requestChange: '原因', apply: 'abc' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('--apply'),
  );
  await assert.rejects(
    () => runNext([], { requestChange: true }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('说明文本'),
  );
});

// ---------- 预览 ----------

test('预览：单候选定值（dev → prd）+ 动作序列 + state 快照', async () => {
  await makeRepo();
  const { rc, out } = await runCapture([], { requestChange: '需求变更，回退重写' });
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(
    plan.actions.map((a) => a.id),
    ['change', 'meta_update', 'journal', 'publish_commit', 'publish_push'],
  );
  const chg = plan.actions[0];
  assert.deepEqual(chg.args, { from: 'dev', to: 'prd', reason: '需求变更，回退重写' }); // v5：无 expected_stage_version（纯阶段比较）
  assert.equal(plan.state.request_change, '需求变更，回退重写');
  assert.equal(plan.state.to, 'prd');
  assert.equal(plan.state.core_stage, 'dev');
  assert.deepEqual(plan.slots, []);
  assert.ok(out.join('\n').includes('回退说明'));
});

test('预览：--to 候选外拒绝；prd 无候选拒绝', async () => {
  await makeRepo();
  await assert.rejects(
    () => runNext([], { requestChange: 'x', to: 'test' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('候选外'),
  );
  // 首阶段无候选
  await makeRepo({ stage: 'prd', version: 1 });
  const metaText = readFileSync(path.join(process.cwd(), '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  writeFileSync(path.join(process.cwd(), '.sdlc', `req-${REQ}`, 'meta.yaml'), metaText.replace('current_stage: dev', 'current_stage: prd').replace('stage_version: 2', 'stage_version: 1'));
  await assert.rejects(
    () => runNext([], { requestChange: 'x' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('无可回退方向'),
  );
});

test('预览：D45 远端与本地快照不一致 → validation_failed（v5 纯阶段比较）', async () => {
  await makeRepo();
  setDb((db) => { db.requirements[REQ].current_stage = 'test'; }); // 远端已推进
  await assert.rejects(
    () => runNext([], { requestChange: 'x' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('不一致'),
  );
});

test('预览：多候选（test 位）→ slots + apply --to 勾选', async () => {
  const repo = await makeRepo({ stage: 'test', version: 3 });
  const metaText = readFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  writeFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), metaText.replace('current_stage: dev', 'current_stage: test').replace('stage_version: 2', 'stage_version: 3'));
  const { rc, out } = await runCapture([], { requestChange: '回归失败回退' });
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(plan.slots, [{ slot: 'to', candidates: ['prd', 'dev'], chosen: null }]);
  assert.equal(plan.state.to, null);
  assert.equal(plan.actions[0].args.to, null);
  // apply 勾选
  const { rc: rc2, out: applyOut } = await runCapture([], { apply: plan.plan_id, to: 'dev' });
  assert.equal(rc2, 0, applyOut.join('\n'));
  assert.equal(mockDb().requirements[REQ].current_stage, 'dev');
  const ev = journalEvents(repo).find((e) => e.action === 'change_request');
  assert.equal(ev.payload.to, 'dev');
});

// ---------- apply 全链 ----------

test('apply 全链：db 回退 + 版本 +1 + change_request 事件 + meta reentered（不覆盖首次进入）', async () => {
  const repo = await makeRepo();
  const { out } = await runCapture([], { requestChange: '需求变更，回退重写' });
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([], { apply: planId });
  assert.equal(rc, 0, applyOut.join('\n'));

  // core：阶段回退 + 版本单调 +1（rebuildStage 消费 bind→advance→change 链）
  const db = mockDb();
  assert.equal(db.requirements[REQ].current_stage, 'prd');
  assert.equal(db.requirements[REQ].stage_version, 3);

  // 事件：change_request（from/to/版本/reason 留痕）
  const ev = journalEvents(repo).find((e) => e.action === 'change_request');
  assert.equal(ev.result, 'succeeded');
  assert.deepEqual(
    { from: ev.payload.from, to: ev.payload.to, reason: ev.payload.reason, source: ev.payload.source },
    { from: 'dev', to: 'prd', reason: '需求变更，回退重写', source: 'api' },
  );
  assert.equal(ev.payload.to_version, 3);

  // meta：阶段/版本 + timeline 键区分（reentered 不覆盖 entered）
  const metaText = readFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  assert.match(metaText, /current_stage: prd/);
  assert.match(metaText, /stage_version: 3/);
  assert.match(metaText, /prd_reentered_at:/);
  assert.match(metaText, /prd_entered_at: 2026-09-01T00:00:00.000Z/); // 首次进入保留

  // 汇总话术 + 发布
  const text = applyOut.join('\n');
  assert.ok(text.includes('阶段：dev → prd（v2 → v3）'));
  assert.ok(text.includes('说明留痕：需求变更，回退重写'));
  assert.ok(text.includes('[publish_push] 流程记录已推送'));
  // 执行记录含 external_ref 证据
  const exec = findExecutionByPlan(planId);
  assert.equal(exec.actions.change.status, 'ok');
  assert.ok(exec.actions.change.detail.resp);
});

test('幂等重跑：全跳过、db 不动、无新事件', async () => {
  const repo = await makeRepo();
  const { out } = await runCapture([], { requestChange: 'x' });
  const planId = planIdOf(out);
  await runCapture([], { apply: planId });
  const nEvents = journalEvents(repo).length;
  const nCommits = Number(gitOut(['rev-list', '--count', 'HEAD'], repo));

  const { rc, out: again } = await runCapture([], { apply: planId });
  assert.equal(rc, 0, again.join('\n'));
  assert.ok(again.join('\n').includes('[change] 阶段已回退，跳过'));
  assert.equal(mockDb().requirements[REQ].stage_version, 3);
  assert.equal(journalEvents(repo).length, nEvents);
  assert.equal(Number(gitOut(['rev-list', '--count', 'HEAD'], repo)), nCommits);
});

test('过期：预览后远端阶段变化 → apply 报过期（防夹带；v5 纯阶段比较）', async () => {
  await makeRepo();
  const { out } = await runCapture([], { requestChange: 'x' });
  const planId = planIdOf(out);
  setDb((db) => { db.requirements[REQ].current_stage = 'prd'; }); // 远端已被他人回退
  await assert.rejects(
    () => runNext([], { apply: planId }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('远端阶段已变化'),
  );
});

test('--no-change：留痕跳过、无 change_request 事件、meta 不写阶段', async () => {
  const repo = await makeRepo();
  const { out } = await runCapture([], { requestChange: 'x' });
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([], { apply: planId, no: { change: true } });
  assert.equal(rc, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');
  assert.ok(text.includes('[change] 已按 --no-change 跳过'));
  assert.ok(text.includes('阶段未回退'));
  assert.equal(journalEvents(repo).filter((e) => e.action === 'change_request').length, 0);
  assert.equal(mockDb().requirements[REQ].current_stage, 'dev');
  const metaText = readFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  assert.match(metaText, /current_stage: dev/);
});

test('回退带报告更新：脏产物 → commit/push 进计划并执行', async () => {
  const repo = await makeRepo();
  const prdDir = mkdirSync(path.join(repo, '.sdlc', `req-${REQ}`, 'prd'), { recursive: true });
  writeFileSync(path.join(prdDir, 'report.md'), 'report\n');
  const { out } = await runCapture([], { requestChange: 'x' });
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(
    plan.actions.map((a) => a.id),
    ['commit', 'push', 'change', 'meta_update', 'journal', 'publish_commit', 'publish_push'],
  );
  const { rc, out: applyOut } = await runCapture([], { apply: plan.plan_id });
  assert.equal(rc, 0, applyOut.join('\n'));
  assert.ok(applyOut.join('\n').includes('[push]'));
  assert.equal(gitOut(['status', '--porcelain'], repo), '');
});

test('普通 --apply 恢复路由：不带 --request-change 的 apply 识别 change 计划', async () => {
  const repo = await makeRepo();
  const { out } = await runCapture([], { requestChange: '恢复语义' });
  const planId = planIdOf(out);
  // 中断后重跑：普通 --apply（不带 --request-change）→ applyChange 恢复
  const { rc, out: applyOut } = await runCapture([], { apply: planId });
  assert.equal(rc, 0, applyOut.join('\n'));
  assert.ok(applyOut.join('\n').includes('说明留痕：恢复语义'));
  assert.equal(mockDb().requirements[REQ].current_stage, 'prd');
});
