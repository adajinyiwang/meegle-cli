// next save 全链：预览 → apply（草稿/发布）→ 幂等恢复 → choices 锁定 →
// 差异确认 → 计划过期 → 完整 push/publish（bare origin）。
// I3 handoff / I4 remind_merge 段走 meegle mock 轨（v5：SDLC_MOCK=1 +
// SDLC_MOCK_STATE 隔离；FLAKY/UNKNOWN 恢复 = 适配层幂等门先读后写）。
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
process.env.SDLC_MOCK = '1'; // 命令层 createCore 走 mock 轨（v5：SDLC_MOCK 显式开关；apply 的 me() 同轨）

const { runNext } = await import('../cli/src/command/next.js');
const { loadPlan } = await import('../cli/src/plan.js');
const { readJournal } = await import('../cli/src/journal.js');
const { findExecutionByPlan } = await import('../cli/src/execution.js');
const { SdlcError } = await import('../cli/src/errors.js');

const REQ = '7220318456';
const REPO_REG = /确认执行：sdlc next --apply ([0-9a-f]{64})/;

const repos = [];
test.after(() => {
  process.chdir(tmpdir());
  for (const r of repos) rmSync(r, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(process.env.SDLC_MOCK_STATE, { recursive: true, force: true });
});

/** @param {string[]} args @param {string} cwd */
const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const gitOut = (args, cwd) => {
  const r = git(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
};

const CONFIG_YAML = `schema_version: 5
git:
  trunk: main
stages:
  - id: dev
    dod:
      - id: dev-sync
        text: 已同步
        check: git_synced
`;
const META_YAML = `schema_version: 5
req_id: "${REQ}"
title: 报表导出
feishu_url: https://project.feishu.cn/req/${REQ}
profile: dev
branch: req/${REQ}-login
current_stage: dev
stage_version: 2
config_revision: x
`;
const BIND_EVENT = JSON.stringify({
  v: 5, event_id: 'ev-bind0', execution_id: 'exec-init', action_id: 'bind', plan_id: 'p-init',
  actor: 'usr-mock-dev', ts: '2026-09-29T00:00:00.000Z', action: 'bind', result: 'ok', payload: {},
});

/** 建一个已绑定需求、基线干净的仓库（可选 bare origin）。 @param {string} [withOrigin] @param {string} [configYaml] */
function makeRepo(withOrigin, configYaml = CONFIG_YAML) {
  const repo = mkdtempSync(path.join(tmpdir(), 'sdlc-repo-'));
  repos.push(repo);
  git(['init'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 't'], repo);
  const reqDir = path.join(repo, '.sdlc', `req-${REQ}`);
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(path.join(reqDir, 'meta.yaml'), META_YAML);
  writeFileSync(path.join(reqDir, 'journal.jsonl'), BIND_EVENT + '\n');
  writeFileSync(path.join(repo, '.sdlc', 'config.yaml'), configYaml);
  writeFileSync(path.join(repo, 'README.md'), 'init\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: init'], repo);
  git(['checkout', '-b', `req/${REQ}-login`], repo);
  if (withOrigin) {
    const origin = mkdtempSync(path.join(tmpdir(), 'sdlc-origin-'));
    repos.push(origin);
    git(['init', '--bare'], origin);
    git(['remote', 'add', 'origin', origin.replace(/\\/g, '/')], repo);
  }
  process.chdir(repo);
  return repo;
}

/** 捕获 console 输出跑 runNext（人读断言用）。 @param {string[]} positional @param {Record<string, any>} flags */
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
  const m = out.join('\n').match(REPO_REG);
  assert.ok(m, `输出中未找到 plan_id：\n${out.join('\n')}`);
  return m[1];
};
const journalEvents = (repo) => readJournal(path.join(repo, '.sdlc', `req-${REQ}`, 'journal.jsonl')).events;

test('预览：脏文件 → 计划存档 + 确认行 + digest 入 state（D39）', async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1)\n', 'utf8');
  const { rc, out } = await runCapture([], {});
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('确认执行：sdlc next --apply '));
  assert.ok(text.includes('确认文件范围'));
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(plan.state.files, [{ path: 'src/a.js', digest: plan.state.files[0].digest }]);
  assert.match(plan.state.files[0].digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(plan.state.scope_all, ['src/a.js']);
  assert.deepEqual(plan.actions.map((a) => a.id), ['commit', 'push', 'journal', 'publish_commit', 'publish_push']);
});

test('--auto 直通（R3 sidecar 白名单）：预览即执行——无确认行，commit/push/发布全落', async () => {
  const repo = makeRepo(true);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1)\n', 'utf8');
  const { rc, out } = await runCapture([], { auto: true });
  assert.equal(rc, 0, out.join('\n'));
  const text = out.join('\n');
  assert.ok(text.includes('--auto 直通执行'), '应有直通执行提示');
  assert.ok(!text.includes('确认执行：sdlc next --apply'), '直通不出确认行');
  assert.ok(text.includes('[push] 已推送'), 'push 落远端');
  assert.ok(text.includes('[publish_push] 流程记录已推送'));
  const subjects = gitOut(['log', '--format=%s', '-3'], repo).split('\n');
  assert.ok(subjects.includes('feat(login): 保存 7220318456 需求产物'));
  assert.equal(gitOut(['status', '--porcelain'], repo), '', '直通保存后工作区干净');
});

test('--auto 互斥：与 --apply/--request-change/--pr-url 同用 → validation_failed', async () => {
  makeRepo();
  await assert.rejects(
    () => runNext([], { auto: true, apply: 'p1' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('互斥'),
  );
  await assert.rejects(
    () => runNext([], { auto: true, requestChange: '说明' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed',
  );
});

test('apply 草稿（--no-push 隐含不发布推送）：commit/journal/发布提交落盘', async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1)\n', 'utf8');
  const { out } = await runCapture([], {});
  const planId = planIdOf(out);

  const { rc, out: applyOut } = await runCapture([], { apply: planId, no: { push: true } });
  assert.equal(rc, 0, applyOut.join('\n'));
  const subjects = gitOut(['log', '--format=%s', `-3`], repo).split('\n');
  assert.ok(subjects.includes('chore(sdlc): 7220318456 流程记录发布'));
  assert.ok(subjects.includes('feat(login): 保存 7220318456 需求产物'));
  // Refs trailer（契约 §2）
  const body = gitOut(['log', '--format=%b', '-2'], repo);
  assert.ok(body.includes(`Refs: ${REQ}`));

  const actions = gitOut(['status', '--porcelain'], repo);
  assert.equal(actions, '', '保存后工作区应干净');

  const exec = findExecutionByPlan(planId);
  assert.equal(exec.actions.commit.status, 'ok');
  assert.equal(exec.actions.push.status, 'skipped');
  assert.equal(exec.actions.publish_push.status, 'skipped'); // --no-push 草稿语义隐含
  assert.ok(applyOut.join('\n').includes('草稿'));

  const events = journalEvents(repo);
  assert.equal(events.filter((e) => e.action === 'local_commit').length, 1);
  assert.equal(events.filter((e) => e.action === 'action_skipped' && e.payload.action === 'push').length, 1);
  assert.equal(events.filter((e) => e.action === 'push').length, 0);
});

test('幂等恢复：重跑同 apply 全部跳过、无新提交无新事件', async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1)\n', 'utf8');
  const { out } = await runCapture([], {});
  const planId = planIdOf(out);
  await runCapture([], { apply: planId, no: { push: true } });
  const before = gitOut(['rev-list', '--count', 'HEAD'], repo);
  const nEvents = journalEvents(repo).length;

  const { rc, out: again } = await runCapture([], { apply: planId, no: { push: true } });
  assert.equal(rc, 0, again.join('\n'));
  const text = again.join('\n');
  assert.ok(text.includes('跳过'));
  assert.ok(!text.includes('追加')); // 无新增事件
  assert.equal(gitOut(['rev-list', '--count', 'HEAD'], repo), before);
  assert.equal(journalEvents(repo).length, nEvents);
});

test('choices 锁定：同执行改参数 → validation_failed（契约 §6）', async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1)\n', 'utf8');
  const { out } = await runCapture([], {});
  const planId = planIdOf(out);
  await runCapture([], { apply: planId, no: { push: true } });
  await assert.rejects(
    () => runNext([], { apply: planId, no: { push: true }, message: '换了个 subject' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('不可更改参数'),
  );
});

test('差异确认：内容变了 → rc1 展示差异；--accept-diffs → 以新内容执行', async () => {
  const repo = makeRepo();
  // 用已跟踪文件（README.md 有 HEAD 基线，diff 可展示旧/新内容）
  writeFileSync(path.join(repo, 'README.md'), 'init\nconsole.log(1)\n', 'utf8');
  const { out } = await runCapture([], {});
  const planId = planIdOf(out);
  // 预览后内容再改 → digest 不一致
  writeFileSync(path.join(repo, 'README.md'), 'init\nconsole.log(2)\n', 'utf8');
  const { rc, out: diffOut } = await runCapture([], { apply: planId, no: { push: true } });
  assert.equal(rc, 1);
  const text = diffOut.join('\n');
  assert.ok(text.includes('与预览时不同'));
  // diff 对 HEAD：展示将提交的新内容（预览时的旧内容只存在于 digest，不可还原——失配即信号）
  assert.ok(text.includes('+console.log(2)'), '差异应展示将提交的新内容');

  const { rc: rc2, out: okOut } = await runCapture([], { apply: planId, no: { push: true }, acceptDiffs: true });
  assert.equal(rc2, 0, okOut.join('\n'));
  assert.equal(readFileSync(path.join(repo, 'README.md'), 'utf8'), 'init\nconsole.log(2)\n');
  // 提交的是新内容（HEAD blob）
  const blob = gitOut(['show', 'HEAD:README.md'], repo);
  assert.ok(blob.includes('console.log(2)'));
});

test('计划过期：预览后新增脏文件 → 文件范围变化 rc1（防夹带）', async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1)\n', 'utf8');
  const { out } = await runCapture([], {});
  const planId = planIdOf(out);
  writeFileSync(path.join(repo, 'src', 'b.js'), 'console.log(9)\n', 'utf8');
  await assert.rejects(
    () => runNext([], { apply: planId, no: { push: true } }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('文件范围变化'),
  );
});

test('完整发布链（bare origin）：push/publish_push 落远端，执行全 ok', async () => {
  const repo = makeRepo(true);
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'console.log(1)\n', 'utf8');
  const { out } = await runCapture([], {});
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([], { apply: planId });
  assert.equal(rc, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');
  assert.ok(text.includes('[push] 已推送'));
  assert.ok(text.includes('[publish_push] 流程记录已推送'));
  assert.ok(text.includes('已同步远端'));

  const exec = findExecutionByPlan(planId);
  for (const id of ['commit', 'push', 'journal', 'publish_commit', 'publish_push']) {
    assert.equal(exec.actions[id].status, 'ok', `${id} 应 ok`);
  }
  // 远端事实：origin 有两个提交（产物 + 发布），journal 含 push 成功事件
  const origin = gitOut(['remote', 'get-url', 'origin'], repo).trim();
  const remoteCount = gitOut(['rev-list', '--count', `refs/remotes/origin/req/${REQ}-login`], repo);
  assert.equal(Number(remoteCount), 3); // init + 产物 + 发布
  const events = journalEvents(repo);
  assert.equal(events.filter((e) => e.action === 'push' && e.result === 'succeeded').length, 1);
});

test('干净且同步：不出计划（无可保存改动）', async () => {
  const repo = makeRepo(true);
  gitOut(['push', '-u', 'origin', `req/${REQ}-login`], repo);
  const { rc, out } = await runCapture([], {});
  assert.equal(rc, 0);
  assert.ok(out.join('\n').includes('无可保存改动'));
});

test('--files：候选内收窄；候选外路径拒绝', async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  writeFileSync(path.join(repo, 'src', 'b.js'), 'b\n', 'utf8');
  await assert.rejects(
    () => runNext([], { files: 'no-such.js' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('候选外'),
  );
  const { rc, out } = await runCapture([], { files: 'src/a.js' });
  assert.equal(rc, 0);
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(plan.state.files.map((f) => f.path), ['src/a.js']);
  assert.deepEqual(plan.state.scope_all, ['src/a.js', 'src/b.js']);
  // 收窄后 apply：b.js 留在工作区不被收走
  const { rc: rc2 } = await runCapture([], { apply: planIdOf(out), no: { push: true } });
  assert.equal(rc2, 0);
  assert.ok(gitOut(['status', '--porcelain'], repo).includes('src/b.js'));
});

test('journal/meta 不进产物提交（归 publish）：流程记录单独成提交', async () => {
  const repo = makeRepo();
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  // journal 变脏（模拟手工/中断追加）→ flowDirty 驱动发布，但不进产物提交
  const jp = path.join(repo, '.sdlc', `req-${REQ}`, 'journal.jsonl');
  writeFileSync(jp, BIND_EVENT + '\n');
  const { out } = await runCapture([], {});
  const plan = loadPlan(planIdOf(out));
  assert.ok(!plan.state.files.some((f) => f.path.startsWith('.sdlc/')));
  const { rc } = await runCapture([], { apply: plan.plan_id, no: { push: true } });
  assert.equal(rc, 0);
  // 产物提交不含 .sdlc 路径；发布提交单独存在
  const art = gitOut(['show', '--stat=200', '--format=', 'HEAD~1'], repo);
  assert.ok(!art.includes('.sdlc/'));
  const pub = gitOut(['show', '--stat=200', '--format=', 'HEAD'], repo);
  assert.ok(pub.includes('journal.jsonl'));
});

// ---------- I3：handoff 全链（统一 mock db，用例前 reset 防 seed 污染） ----------

const mockDb = () => JSON.parse(readFileSync(path.join(process.env.SDLC_MOCK_STATE, 'db.json'), 'utf8'));
const resetMockDb = () => rmSync(path.join(process.env.SDLC_MOCK_STATE, 'db.json'), { force: true });

const HANDOFF_CONFIG = `schema_version: 5
git:
  trunk: main
stages:
  - id: dev
    next: test
    dod:
      - id: dev-sync
        text: 已同步
        check: git_synced
      - id: dev-tasks
        text: 任务块可解析
        check: tasks_parseable
        path: dev/tasks.md
      - id: dev-pr
        text: PR 已创建
        check: pr_exists
  - id: test
    next: done
    dod:
      - id: test-brief
        text: 测试简报
        check: test_brief
feishu:
  profiles:
    dev:
      stage_nodes:
        test:
          entry_tasks:
            - 确认进入开发
`;
const TASKS_MD = `# 任务
<!-- sdlc:tasks begin -->
\`\`\`yaml
tasks:
  - id: entry-1
    title: 确认进入开发
    assignee_role: dev
  - id: T1
    title: 接口重构
    assignee_role: dev
  - id: T2
    title: 导出实现
    assignee_role: dev
\`\`\`
<!-- sdlc:tasks end -->
`;

/** handoff 用 fixture：dev→test 配置 + 任务块（T1/T2 本地新增、entry-1 完成候选）+ 测试简报。 */
function makeHandoffRepo() {
  const repo = makeRepo(true, HANDOFF_CONFIG);
  const reqDir = path.join(repo, '.sdlc', `req-${REQ}`);
  mkdirSync(path.join(reqDir, 'dev'), { recursive: true });
  writeFileSync(path.join(reqDir, 'dev', 'tasks.md'), TASKS_MD);
  mkdirSync(path.join(reqDir, 'test'), { recursive: true });
  writeFileSync(path.join(reqDir, 'test', 'brief.md'), '# 测试简报\n- test_round: 1\n');
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(['add', '.'], repo);
  git(['commit', '-m', 'chore: fixtures'], repo);
  process.chdir(repo);
  return repo;
}

test('handoff 预览：任务 diff/PR/advance 判定入计划 + state 含远端快照', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { rc, out } = await runCapture([], { intent: 'handoff' });
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(
    plan.actions.map((a) => a.id),
    ['commit', 'push', 'tasks_split', 'tasks_check', 'pr_create', 'advance', 'meta_update', 'journal', 'publish_commit', 'publish_push'],
  );
  const split = plan.actions.find((a) => a.id === 'tasks_split');
  assert.deepEqual(split.args.tasks.map((t) => t.id), ['T1', 'T2']);
  const check = plan.actions.find((a) => a.id === 'tasks_check');
  assert.deepEqual(check.args.cancels, []);
  const adv = plan.actions.find((a) => a.id === 'advance');
  assert.equal(adv.args.from, 'dev');
  assert.equal(adv.args.to, 'test');
  assert.deepEqual(adv.args.entry_tasks, ['确认进入开发']);
  assert.deepEqual(plan.slots, [{ slot: 'tasks', candidates: ['entry-1'], chosen: null }]);
  // v5：远端任务以 remote_id 标识；tasks_resolved 留 Tn→{title, remote_id} 解析
  assert.deepEqual(plan.state.tasks_remote, [{ id: 'st-entry-1', state: 'open' }]);
  assert.deepEqual(plan.state.tasks_resolved, { 'entry-1': { title: '确认进入开发', remote_id: 'st-entry-1' } });
  assert.equal(plan.state.to, 'test');
  assert.equal(plan.state.core_stage, 'dev');
  const text = out.join('\n');
  assert.ok(text.includes('新增粗任务：T1 接口重构、T2 导出实现'));
  assert.ok(text.includes('完成候选（--tasks 勾选）：entry-1'));
  assert.ok(text.includes('候选槽位'));
  assert.ok(text.includes('--tasks <id,id,…>'));
});

test('handoff --auto 直通（R3）：预览即执行——mock db 推进 + 事件 + 无确认行', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { rc, out } = await runCapture([], { intent: 'handoff', auto: true });
  assert.equal(rc, 0, out.join('\n'));
  const text = out.join('\n');
  assert.ok(text.includes('--auto 直通执行'), '应有直通提示');
  assert.ok(!text.includes('确认执行：sdlc next --apply'), '直通不出确认行');
  assert.ok(text.includes('[advance]'), '推进动作执行');
  const db = mockDb();
  assert.equal(db.requirements[REQ].current_stage, 'test');
  const events = journalEvents(repo);
  assert.ok(events.some((e) => e.action === 'stage_advance'));
});

test('handoff apply 全链：外部动作落 mock db + meta + 事件 + 话术', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { out } = await runCapture([], { intent: 'handoff' });
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([], { intent: 'handoff', apply: planId, tasks: 'entry-1' });
  assert.equal(rc, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');

  // mock db：阶段推进、任务增量创建（v5 以 remote_id 标识）、入口任务勾选
  const db = mockDb();
  const req = db.requirements[REQ];
  assert.equal(req.current_stage, 'test');
  assert.equal(req.stage_version, 3);
  const t1 = req.tasks.find((t) => t.title === '接口重构');
  const t2 = req.tasks.find((t) => t.title === '导出实现');
  assert.ok(t1 && t1.state === 'open' && t1.remote_id.startsWith('st-'));
  assert.ok(t2 && t2.state === 'open' && t2.remote_id.startsWith('st-'));
  assert.equal(req.tasks.find((t) => t.remote_id === 'st-entry-1').state, 'completed');

  // meta 更新（随 publish 提交）：v5 无 pr_id（PR 人工路径归 pr_link 回填），tasks_map 落 Tn→remote_id
  const metaText = readFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  assert.match(metaText, /current_stage: test/);
  assert.match(metaText, /stage_version: 3/);
  assert.ok(metaText.includes('tasks_map'));
  assert.ok(metaText.includes(t1.remote_id) && metaText.includes(t2.remote_id) && metaText.includes('st-entry-1'));
  assert.match(metaText, /last_brief: test\/brief\.md/);

  // journal 事件
  const events = journalEvents(repo);
  assert.equal(events.filter((e) => e.action === 'task_synced' && e.payload.kind === 'created').length, 2);
  assert.equal(events.filter((e) => e.action === 'task_synced' && e.payload.kind === 'completed').length, 1);
  const advEv = events.find((e) => e.action === 'stage_advance');
  assert.equal(advEv.payload.to, 'test');
  assert.equal(advEv.payload.to_version, 3);
  const prep = events.find((e) => e.action === 'handoff_prepared');
  assert.equal(prep.result, 'succeeded');
  assert.equal(prep.payload.advanced, true);
  // D59 人工路径：pr payload 如实记 manual + 创建链接（本地 origin 不可解析 → null）
  assert.equal(prep.payload.pr.manual, true);
  assert.equal(prep.payload.pr.create_url, null);
  assert.deepEqual(prep.payload.tasks_completed, ['entry-1']);

  // 话术与发布
  assert.ok(text.includes('交接话术'));
  assert.ok(text.includes(`git checkout req/${REQ}-login`));
  assert.ok(text.includes(`sdlc start ${REQ}`));
  assert.ok(text.includes('创建后回填：sdlc next --pr-url'));
  assert.ok(text.includes('[publish_push] 流程记录已推送'));
  assert.ok(text.includes('mock 模式'));
});

test('handoff tasks_split 本地已完成（R4 卡点#11）：新任务创建后即勾选——快速推进一轮到位', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  // T1 completed + estimate（R4①：estimate 随任务走，real splitTasks 排期/估分）
  writeFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'dev', 'tasks.md'), `# 任务
<!-- sdlc:tasks begin -->
\`\`\`yaml
tasks:
  - id: T1
    title: 接口重构
    assignee_role: dev
    estimate: 3
    state: completed
  - id: T2
    title: 导出实现
    assignee_role: dev
\`\`\`
<!-- sdlc:tasks end -->
`);
  const { out } = await runCapture([], { intent: 'handoff', auto: true });
  assert.equal(out.join('\n').includes('[tasks_split] 本地已完成任务已勾选（T1）'), true, out.join('\n'));
  const db = mockDb();
  const req = db.requirements[REQ];
  assert.equal(req.tasks.find((t) => t.title === '接口重构').state, 'completed');
  assert.equal(req.tasks.find((t) => t.title === '导出实现').state, 'open');
  const events = journalEvents(repo);
  // created 2 项 + completed 1 项（T1 创建后勾选）
  assert.equal(events.filter((e) => e.action === 'task_synced' && e.payload.kind === 'created').length, 2);
  assert.equal(events.filter((e) => e.action === 'task_synced' && e.payload.kind === 'completed' && e.payload.id === 'T1').length, 1);
});

test('handoff 幂等重跑：全部跳过、db 无重复副作用、无新事件', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { out } = await runCapture([], { intent: 'handoff' });
  const planId = planIdOf(out);
  await runCapture([], { intent: 'handoff', apply: planId, tasks: 'entry-1' });
  const nEvents = journalEvents(repo).length;
  const nCommits = Number(gitOut(['rev-list', '--count', 'HEAD'], repo));

  const { rc, out: again } = await runCapture([], { intent: 'handoff', apply: planId, tasks: 'entry-1' });
  assert.equal(rc, 0, again.join('\n'));
  const text = again.join('\n');
  assert.ok(text.includes('[advance] 阶段已推进，跳过'));
  assert.ok(text.includes('[tasks_split] 粗任务已同步，跳过'));
  assert.ok(!text.includes('追加'));
  assert.equal(gitOut(['rev-list', '--count', 'HEAD'], repo).trim(), String(nCommits));
  assert.equal(journalEvents(repo).length, nEvents);
  const db = mockDb();
  assert.equal(db.requirements[REQ].stage_version, 3); // 未重复推进
  assert.equal(db.requirements[REQ].current_stage, 'test');
});

test('handoff advance 冲突：预览后远端推进 → apply 报过期（D39/D45）', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { out } = await runCapture([], { intent: 'handoff' });
  const planId = planIdOf(out);
  // 外部把阶段推进了（同需求他人 advance）——v5 纯阶段比较
  const db = mockDb();
  db.requirements[REQ].current_stage = 'test';
  writeFileSync(path.join(process.env.SDLC_MOCK_STATE, 'db.json'), JSON.stringify(db, null, 2));
  await assert.rejects(
    () => runNext([], { intent: 'handoff', apply: planId }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('远端阶段已变化'),
  );
});

test('handoff FLAKY 恢复：副作用已落响应丢失 → rc 中止；重跑幂等门发现已在位重放续链', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { out } = await runCapture([], { intent: 'handoff' });
  const planId = planIdOf(out);
  // advance 副作用已落库但响应丢失（external_unknown——结果未知不盲重发）
  process.env.SDLC_MOCK_FLAKY_ACTION = 'advance';
  await assert.rejects(
    () => runNext([], { intent: 'handoff', apply: planId, tasks: 'entry-1' }),
    (e) => e instanceof SdlcError && e.code === 'external_unknown',
  );
  delete process.env.SDLC_MOCK_FLAKY_ACTION;
  // 副作用已发生（阶段已推进）；链未完成（发布未做）
  assert.equal(mockDb().requirements[REQ].current_stage, 'test');

  const { rc, out: again } = await runCapture([], { intent: 'handoff', apply: planId, tasks: 'entry-1' });
  assert.equal(rc, 0, again.join('\n'));
  const text = again.join('\n');
  assert.ok(text.includes('[advance] 已进入 test（远端已在位，幂等重放）'));
  // 版本未重复推进（仍 3）
  const db = mockDb();
  assert.equal(db.requirements[REQ].stage_version, 3);
  // 发布补齐
  assert.ok(text.includes('[publish_push] 流程记录已推送'));
});

test('handoff UNKNOWN 恢复：写前失败无副作用，重跑先读后写续发成功', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { out } = await runCapture([], { intent: 'handoff' });
  const planId = planIdOf(out);
  process.env.SDLC_MOCK_UNKNOWN_ACTION = 'advance';
  await assert.rejects(
    () => runNext([], { intent: 'handoff', apply: planId, tasks: 'entry-1' }),
    (e) => e instanceof SdlcError && e.code === 'external_unknown',
  );
  delete process.env.SDLC_MOCK_UNKNOWN_ACTION;
  // 写前失败：无副作用（阶段仍在 dev）——重发安全
  assert.equal(mockDb().requirements[REQ].current_stage, 'dev');
  // 重跑：advance 幂等门回读（仍在 from）→ 续发推进，链补齐
  const { rc, out: again } = await runCapture([], { intent: 'handoff', apply: planId, tasks: 'entry-1' });
  assert.equal(rc, 0, again.join('\n'));
  const text = again.join('\n');
  assert.ok(text.includes('[advance] 已进入 test'), again.join('\n'));
  const db = mockDb();
  assert.equal(db.requirements[REQ].current_stage, 'test');
  assert.equal(db.requirements[REQ].stage_version, 3); // 单次推进不重复计
  assert.ok(text.includes('[publish_push] 流程记录已推送'));
});

test('handoff --no-advance：留痕跳过、无 stage_advance 事件、不输出交接话术', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  const { out } = await runCapture([], { intent: 'handoff' });
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([], { intent: 'handoff', apply: planId, no: { advance: true } });
  assert.equal(rc, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');
  assert.ok(text.includes('[advance] 已按 --no-advance 跳过'));
  assert.ok(text.includes('阶段未推进'));
  assert.ok(!text.includes('交接话术'));
  const events = journalEvents(repo);
  assert.equal(events.filter((e) => e.action === 'stage_advance').length, 0);
  assert.equal(events.find((e) => e.action === 'handoff_prepared').result, 'failed');
  // db 阶段未推进、meta 未写 stage（任务照常同步——PR 人工路径无 API 副作用）
  assert.equal(mockDb().requirements[REQ].current_stage, 'dev');
  const metaText = readFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  assert.match(metaText, /current_stage: dev/);
});

test('handoff PR 复用：meta.pr_ref 已存（--pr-url 回填后）→ 预览无 pr_create 动作', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n', 'utf8');
  // v5：pr_ref 由 pr_link 人工回填写 meta——同需求二次交接不重复输出创建链接
  const metaPath = path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml');
  writeFileSync(
    metaPath,
    readFileSync(metaPath, 'utf8')
      + 'pr_ref:\n  repo: mockgroup/mockrepo\n  pr_id: "101"\n  url: https://codeup.example/mock/pr/101\n',
  );
  const { rc, out } = await runCapture([], { intent: 'handoff' });
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  assert.ok(!plan.actions.some((a) => a.id === 'pr_create'));
  assert.ok(out.join('\n').includes('meta 已有 PR 引用，不重复输出创建链接'));
});

test('save tasks_check（R4）：tasks.md 脏 + 本地已完成 → 勾选动作 + apply 回读勾远端', async () => {
  resetMockDb();
  const repo = makeHandoffRepo();
  // 本地 T2 标完成（tasks.md 变脏进保存范围）；远端预置同任务——apply 时
  // checkTasks 单次回读幂等裁决（open→勾）。预览本身零 db 读（R4 设计）
  writeFileSync(
    path.join(repo, '.sdlc', `req-${REQ}`, 'dev', 'tasks.md'),
    TASKS_MD.replace('- id: T2\n    title: 导出实现', '- id: T2\n    title: 导出实现\n    state: completed'),
    'utf8',
  );
  writeFileSync(path.join(process.env.SDLC_MOCK_STATE, 'db.json'), JSON.stringify({
    requirements: {
      [REQ]: {
        req_id: REQ, title: '报表导出', url: `https://project.feishu.cn/mock/req/${REQ}`,
        profile: 'story', current_stage: 'dev', stage_version: 2,
        participants: {}, completion_status: 'pending', completion_source: null,
        tasks: [
          { remote_id: 'st-entry-1', title: '确认进入开发', state: 'open' },
          { remote_id: 'st-t2', title: '导出实现', state: 'open' },
        ],
      },
    },
    next_task_seq: 100,
  }));
  const { rc, out } = await runCapture([], {});
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  const check = plan.actions.find((a) => a.id === 'tasks_check');
  assert.ok(check, '计划应含 tasks_check（本地已完成同步勾选）');
  assert.deepEqual(check.args.completions, [{ id: 'T2', title: '导出实现' }]); // 无 tasks_map 时 remote_id 缺省（apply 按标题回读匹配）
  assert.ok(out.join('\n').includes('同步勾选本地已完成任务'));

  const { rc: rc2, out: applyOut } = await runCapture([], { apply: plan.plan_id, no: { push: true } });
  assert.equal(rc2, 0, applyOut.join('\n'));
  const db = mockDb();
  assert.equal(db.requirements[REQ].tasks.find((t) => t.remote_id === 'st-t2').state, 'completed');
  assert.equal(db.requirements[REQ].tasks.find((t) => t.remote_id === 'st-entry-1').state, 'open', '未完成的不勾');
  assert.ok(journalEvents(repo).some((e) => e.action === 'task_synced' && e.payload.kind === 'completed' && e.payload.id === 'T2'));
});

// ---------- I4/v5：save remind_merge（阶段末尾 + pr_ref + 收尾未记录，恒提醒） ----------

const REMIND_CONFIG = `schema_version: 5
git:
  trunk: main
stages:
  - id: test
    next: done
    dod:
      - id: test-brief
        text: 测试简报
        check: file_exists
        path: test/brief.md
`;
const REMIND_META = `schema_version: 5
req_id: "${REQ}"
title: 报表导出
feishu_url: https://project.feishu.cn/req/${REQ}
profile: dev
branch: req/${REQ}-login
current_stage: test
stage_version: 3
config_revision: x
pr_ref:
  repo: mockgroup/mockrepo
  pr_id: 101
  url: https://codeup.example/mock/pr/101
`;

/** remind_merge fixture：test 阶段（next=done 阶段末尾）+ meta.pr_ref（v5 无 PR 状态回读——save 链不读 mock db）。 */
function makeRemindRepo(metaYaml = REMIND_META) {
  const repo = makeRepo(true, REMIND_CONFIG);
  writeFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'meta.yaml'), metaYaml);
  process.chdir(repo);
  return repo;
}

test('save remind_merge：阶段末尾 + pr_ref + 收尾未记录 → 快照进 state + 事件 + 提醒话术；收尾已记录不提醒', async () => {
  // 收尾未记录（completion_status 缺省 pending）：预览 remind 快照（参与指纹）
  const repo = makeRemindRepo();
  writeFileSync(path.join(repo, 'extra.txt'), 'x\n', 'utf8');
  const { out } = await runCapture([], {});
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(plan.state.remind, { pr_id: '101', url: 'https://codeup.example/mock/pr/101', stage: 'test' });

  // apply：remind_merge 事件随 journal 发布 + 待合并提醒话术
  const { rc, out: applyOut } = await runCapture([], { apply: plan.plan_id });
  assert.equal(rc, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');
  assert.ok(text.includes('待合并提醒'), '应输出待合并提醒话术');
  assert.ok(text.includes(`sdlc done ${REQ}`));
  assert.ok(text.includes('manual-confirm pr_merged'));
  const ev = journalEvents(repo).find((e) => e.action === 'remind_merge');
  assert.equal(ev.result, 'succeeded');
  assert.deepEqual(
    { pr_id: ev.payload.pr_id, url: ev.payload.url, stage: ev.payload.stage },
    { pr_id: '101', url: 'https://codeup.example/mock/pr/101', stage: 'test' },
  );

  // 对照（v5）：收尾已记录（done --manual-confirm 后 completion_status=manual）→ 无快照无事件不提醒
  const repo2 = makeRemindRepo(REMIND_META + 'completion_status: manual\n');
  writeFileSync(path.join(repo2, 'extra.txt'), 'x\n', 'utf8');
  const { out: out2 } = await runCapture([], {});
  const plan2 = loadPlan(planIdOf(out2));
  assert.equal(plan2.state.remind, undefined);
  const { rc: rc2, out: applyOut2 } = await runCapture([], { apply: plan2.plan_id });
  assert.equal(rc2, 0, applyOut2.join('\n'));
  assert.ok(!applyOut2.join('\n').includes('待合并提醒'));
  assert.equal(journalEvents(repo2).filter((e) => e.action === 'remind_merge').length, 0);
});
