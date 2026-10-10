// start 兜底推进（I4，D48 接手方侧）：检测命中/已满足/无事件/回退后不兜底/
// 脏产物不进计划 + apply 全链（推进+入口任务+meta+事件+发布）+ 幂等。
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

const { runStart } = await import('../cli/src/command/start.js');
const { createMockCore } = await import('../cli/src/meegle/mock.js');
const { loadPlan } = await import('../cli/src/plan.js');
const { readJournal } = await import('../cli/src/journal.js');
const { SdlcError } = await import('../cli/src/errors.js');

const REQ = '7220318456';
const BRANCH = `req/${REQ}-login`;
const START_REG = /确认执行：sdlc start \d+ --apply ([0-9a-f]{64})/;

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

const CATCHUP_CONFIG = `schema_version: 5
git:
  trunk: main
stages:
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
feishu:
  profiles:
    dev:
      stage_nodes:
        test:
          entry_tasks:
            - 确认进入开发
`;
const META_DEV = `schema_version: 5
req_id: "${REQ}"
title: 报表导出
feishu_url: https://project.feishu.cn/req/${REQ}
profile: dev
branch: ${BRANCH}
current_stage: dev
stage_version: 2
config_revision: x
`;
const BIND_EVENT = JSON.stringify({
  v: 5, event_id: 'ev-bind0', execution_id: 'exec-init', action_id: 'bind', plan_id: 'p-init',
  actor: 'usr-mock-dev', ts: '2026-09-29T00:00:00.000Z', action: 'bind', result: 'ok', payload: {},
});
/** 交接未成（advance 失败）的 handoff_prepared——D48 兜底的触发事实。 */
const PREP_EVENT = (advanced = false) => JSON.stringify({
  v: 5, event_id: 'ev-prep1', execution_id: 'exec-h1', action_id: 'journal', plan_id: 'p-h1',
  actor: 'usr-mock-dev', ts: '2026-09-28T00:00:00.000Z', action: 'handoff_prepared',
  result: advanced ? 'succeeded' : 'failed',
  payload: { req_id: REQ, from: 'dev', to: 'test', branch: BRANCH, advanced, entry_tasks: ['确认进入开发'], pr: null, tasks_completed: [], tasks_cancelled: [] },
});

const dbPath = () => path.join(process.env.SDLC_MOCK_STATE, 'db.json');
const mockDb = () => JSON.parse(readFileSync(dbPath(), 'utf8'));
const setDb = (fn) => {
  const db = mockDb();
  fn(db);
  writeFileSync(dbPath(), JSON.stringify(db, null, 2));
};

/**
 * 建仓库 + mock db 对齐 dev v2 + journal 可选 handoff_prepared。
 * @param {{prep?: string | null, coreStage?: string, coreVersion?: number}} [opts]
 */
async function makeRepo(opts = {}) {
  if (existsSync(dbPath())) rmSync(dbPath(), { force: true });
  await createMockCore().requirementState(REQ); // 触发 mock db seed（loadDb 写默认底本）
  setDb((db) => {
    db.requirements[REQ].current_stage = opts.coreStage ?? 'dev';
    db.requirements[REQ].stage_version = opts.coreVersion ?? 2;
  });
  const repo = mkdtempSync(path.join(tmpdir(), 'sdlc-repo-'));
  repos.push(repo);
  git(['init'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 't'], repo);
  const reqDir = path.join(repo, '.sdlc', `req-${REQ}`);
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(path.join(reqDir, 'meta.yaml'), META_DEV);
  const lines = [BIND_EVENT];
  if (opts.prep !== null) lines.push(opts.prep ?? PREP_EVENT());
  writeFileSync(path.join(reqDir, 'journal.jsonl'), lines.join('\n') + '\n');
  writeFileSync(path.join(repo, '.sdlc', 'config.yaml'), CATCHUP_CONFIG);
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

async function runCapture(args, opts) {
  const out = [];
  const log = console.log, err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { rc: await runStart(args, opts), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const planIdOf = (out) => {
  const m = out.join('\n').match(START_REG);
  assert.ok(m, `输出中未找到 plan_id：\n${out.join('\n')}`);
  return m[1];
};
const journalEvents = (repo) => readJournal(path.join(repo, '.sdlc', `req-${REQ}`, 'journal.jsonl')).events;

// ---------- 检测三分支 ----------

test('新绑定 + 工作区脏 → 拒绝切分支（防夹带），列改动并提示先处理', async () => {
  const repo = await makeRepo();
  writeFileSync(path.join(repo, 'dirty.txt'), '未提交\n');
  await assert.rejects(
    () => runStart(['7114275203'], {}),
    (e) => e instanceof SdlcError && e.code === 'validation_failed'
      && e.message.includes('防夹带') && e.message.includes('dirty.txt'),
  );
  // 脏改动未被触碰
  assert.equal(gitOut(['status', '--porcelain'], repo).trim(), '?? dirty.txt');
});

test('新绑定（干净工作区）不受脏拦截影响：出计划含确认行', async () => {
  await makeRepo();
  const { rc, out } = await runCapture(['7114275203'], {});
  assert.equal(rc, 0, out.join('\n'));
  assert.ok(out.join('\n').includes('确认执行：sdlc start 7114275203'));
});

test('检测命中：交接未成 + 远端仍在 from → 兜底推进计划（动作序列 + state 快照）', async () => {
  await makeRepo();
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(
    plan.actions.map((a) => a.id),
    ['advance', 'meta_update', 'journal', 'publish_commit', 'publish_push'],
  );
  const adv = plan.actions[0];
  assert.deepEqual(adv.args, { from: 'dev', to: 'test', entry_tasks: ['确认进入开发'] }); // v5：无 expected_stage_version（纯阶段比较）
  assert.equal(plan.state.kind, 'start_advance');
  assert.equal(plan.state.to, 'test');
  assert.equal(plan.state.core_stage, 'dev');
  assert.ok(out.join('\n').includes('检测到接续缺口'));
});

test('检测已满足：远端已在 to → 提示无需兜底，无计划', async () => {
  await makeRepo({ coreStage: 'test', coreVersion: 3 });
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('远端已在 test'));
  assert.ok(!text.includes('检测到接续缺口'));
  assert.ok(!text.includes('确认执行：sdlc start'));
});

test('无交接事件/推进已成：不触发检测；回退后（change_request 在后）不兜底', async () => {
  // 无 handoff_prepared
  await makeRepo({ prep: null });
  const { out } = await runCapture([REQ], {});
  assert.ok(!out.join('\n').includes('检测到接续缺口'));
  // 推进已成（advanced=true）
  await makeRepo({ prep: PREP_EVENT(true) });
  const { out: out2 } = await runCapture([REQ], {});
  assert.ok(!out2.join('\n').includes('检测到接续缺口'));
  // 回退发生在交接之后：不兜底（回退优先）
  await makeRepo();
  const jp = path.join(process.cwd(), '.sdlc', `req-${REQ}`, 'journal.jsonl');
  writeFileSync(jp, [BIND_EVENT, PREP_EVENT(), JSON.stringify({
    v: 5, event_id: 'ev-chg1', execution_id: 'exec-c1', action_id: 'change', plan_id: 'p-c1',
    actor: 'usr-mock-dev', ts: '2026-09-28T02:00:00.000Z', action: 'change_request', result: 'succeeded',
    payload: { from: 'test', to: 'dev', reason: '回退', source: 'api' },
  })].join('\n') + '\n');
  const { out: out3 } = await runCapture([REQ], {});
  assert.ok(!out3.join('\n').includes('检测到接续缺口'), '回退后不应兜底推进');
});

test('脏产物：未保存改动 → 不进计划，提示先 save（防夹带）', async () => {
  const repo = await makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('未保存改动'));
  assert.ok(text.includes('sdlc next --intent save'));
  assert.ok(!text.includes('确认执行：sdlc start'));
});

// ---------- apply 全链 ----------

test('apply 全链：推进（入口任务留待拆分后勾选）+ meta + stage_advance 事件 + 发布推送', async () => {
  const repo = await makeRepo();
  const { out } = await runCapture([REQ], {});
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([REQ], { apply: planId });
  assert.equal(rc, 0, applyOut.join('\n'));

  // core：推进落位；入口任务不在此勾选（D48 v2：拆分任务后 tasks_split 尾段勾）
  const db = mockDb();
  assert.equal(db.requirements[REQ].current_stage, 'test');
  assert.equal(db.requirements[REQ].stage_version, 3);
  assert.equal(db.requirements[REQ].tasks.find((t) => t.remote_id === 'st-entry-1').state, 'open');

  // meta + 事件
  const metaText = readFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  assert.match(metaText, /current_stage: test/);
  assert.match(metaText, /stage_version: 3/);
  const ev = journalEvents(repo).find((e) => e.action === 'stage_advance');
  assert.equal(ev.payload.to, 'test');
  assert.equal(ev.payload.to_version, 3);
  const text = applyOut.join('\n');
  assert.ok(text.includes('兜底推进完成'));
  assert.ok(text.includes('阶段：dev → test（v2 → v3）'));
  assert.ok(text.includes('[publish_push] 流程记录已推送'));
  assert.equal(gitOut(['status', '--porcelain'], repo), '');
});

test('apply 幂等重跑：全跳过、db 不动、无新事件', async () => {
  const repo = await makeRepo();
  const { out } = await runCapture([REQ], {});
  const planId = planIdOf(out);
  await runCapture([REQ], { apply: planId });
  const nEvents = journalEvents(repo).length;
  const nCommits = Number(gitOut(['rev-list', '--count', 'HEAD'], repo));

  const { rc, out: again } = await runCapture([REQ], { apply: planId });
  assert.equal(rc, 0, again.join('\n'));
  assert.ok(again.join('\n').includes('[advance] 阶段已推进，跳过'));
  assert.equal(mockDb().requirements[REQ].stage_version, 3);
  assert.equal(journalEvents(repo).length, nEvents);
  assert.equal(Number(gitOut(['rev-list', '--count', 'HEAD'], repo)), nCommits);
});

test('apply 过期：预览后远端推进 → apply 报过期（与 handoff 原子互斥；v5 纯阶段比较）', async () => {
  await makeRepo();
  const { out } = await runCapture([REQ], {});
  const planId = planIdOf(out);
  setDb((db) => { db.requirements[REQ].current_stage = 'test'; }); // 远端已被他人推进
  await assert.rejects(
    () => runStart([REQ], { apply: planId }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('远端阶段已变化'),
  );
});
