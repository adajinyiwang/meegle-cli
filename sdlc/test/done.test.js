// done 两段收尾全链（I4，D42；v5=D59 人工路径）：B1a/B2/B4/B6 矩阵坍缩版 +
// 归档移动/幂等/冲突/未跟踪/--no + 第二段核验收尾（唯一入口 --manual-confirm
// pr_merged——PR 状态不可回读，source=manual 如实标注；mock 落库恒 manual，
// with_gaps 细节随 accepted_gaps 留痕）。
// 隔离：SDLC_HOME/SDLC_MOCK_STATE 临时目录（模块加载前设置 → 动态 import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const home = mkdtempSync(path.join(tmpdir(), 'sdlc-home-'));
process.env.SDLC_HOME = home;
process.env.SDLC_MOCK_STATE = mkdtempSync(path.join(tmpdir(), 'sdlc-mock-'));
process.env.SDLC_MOCK = '1'; // 命令层 createCore 走 mock 轨（v5：SDLC_MOCK 显式开关）

const { runDone } = await import('../cli/src/command/done.js');
const { createMockCore } = await import('../cli/src/meegle/mock.js');
const { loadPlan } = await import('../cli/src/plan.js');
const { readJournal } = await import('../cli/src/journal.js');
const { SdlcError } = await import('../cli/src/errors.js');

const REQ = '7220318456';
const BRANCH = `req/${REQ}-login`;
const DONE_REG = /确认执行：sdlc done --apply ([0-9a-f]{64})/;
const NOW = new Date();
const MONTH = `${NOW.getFullYear()}-${String(NOW.getMonth() + 1).padStart(2, '0')}`;
const ARCHIVE_DIR = `.sdlc/archive/${MONTH}-req-${REQ}`;

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

const DONE_CONFIG = `schema_version: 5
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
`;
const META_WITH_PR = `schema_version: 5
req_id: "${REQ}"
title: 报表导出
feishu_url: https://project.feishu.cn/req/${REQ}
profile: dev
branch: ${BRANCH}
current_stage: test
stage_version: 3
config_revision: x
pr_ref:
  repo: mockgroup/mockrepo
  pr_id: 101
  url: https://codeup.example/mock/pr/101
`;
const META_NO_PR = META_WITH_PR.replace(/pr_ref:\n(  .*\n)+/, '');
const BIND_EVENT = JSON.stringify({
  v: 5, event_id: 'ev-bind0', execution_id: 'exec-init', action_id: 'bind', plan_id: 'p-init',
  actor: 'usr-mock-dev', ts: '2026-09-29T00:00:00.000Z', action: 'bind', result: 'ok', payload: {},
});

/**
 * 建已绑定 + 已推送 + meta 带 pr_ref 的仓库（mock db 由预览 requirementState 懒 seed——
 * v5 无 PR 状态回读，不再注入 db.prs）。
 */
function makeDoneRepo(metaYaml = META_WITH_PR) {
  resetMockDb();
  const repo = mkdtempSync(path.join(tmpdir(), 'sdlc-repo-'));
  repos.push(repo);
  git(['init'], repo);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 't'], repo);
  const reqDir = path.join(repo, '.sdlc', `req-${REQ}`);
  mkdirSync(reqDir, { recursive: true });
  mkdirSync(path.join(reqDir, 'test'), { recursive: true });
  writeFileSync(path.join(reqDir, 'meta.yaml'), metaYaml);
  writeFileSync(path.join(reqDir, 'journal.jsonl'), BIND_EVENT + '\n');
  writeFileSync(path.join(reqDir, 'test', 'brief.md'), '# 测试简报\n- test_round: 1\n');
  writeFileSync(path.join(repo, '.sdlc', 'config.yaml'), DONE_CONFIG);
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

const mockDb = () => JSON.parse(readFileSync(path.join(process.env.SDLC_MOCK_STATE, 'db.json'), 'utf8'));
const setDb = (fn) => {
  const db = mockDb();
  fn(db);
  writeFileSync(path.join(process.env.SDLC_MOCK_STATE, 'db.json'), JSON.stringify(db, null, 2));
};
const resetMockDb = () => rmSync(path.join(process.env.SDLC_MOCK_STATE, 'db.json'), { force: true });

async function runCapture(positional, flags) {
  const out = [];
  const log = console.log, err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { rc: await runDone(positional, flags), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const planIdOf = (out) => {
  const m = out.join('\n').match(DONE_REG);
  assert.ok(m, `输出中未找到 plan_id：\n${out.join('\n')}`);
  return m[1];
};
const journalEventsAt = (repo, rel) => readJournal(path.join(repo, rel, 'journal.jsonl')).events;

// ---------- 矩阵分支（v5 坍缩：B1a/B2/B4/B6 + manual-confirm 第二段） ----------

test('B1a：无 MR 引用 → 提示按提测交接准备，无计划（不为归档另开 MR）', async () => {
  makeDoneRepo(META_NO_PR);
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('尚无 MR 引用'));
  assert.ok(text.includes('不为归档另开 MR'));
  assert.ok(!text.includes('确认执行：sdlc done --apply'));
});

test('B2 预览：归档准备计划（动作序列 + 归档目录命名 + 确认行）', async () => {
  makeDoneRepo();
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0);
  const plan = loadPlan(planIdOf(out));
  assert.deepEqual(
    plan.actions.map((a) => a.id),
    ['archive_move', 'meta_done', 'journal', 'archive_commit', 'publish_push'],
  );
  assert.equal(plan.state.kind, 'done_archive');
  assert.equal(plan.state.archive_dir, ARCHIVE_DIR);
  assert.deepEqual(plan.actions[0].args, { archive_dir: ARCHIVE_DIR, source_dir: `.sdlc/req-${REQ}` });
  assert.ok(out.join('\n').includes('待人工合并'));
  // v5：PR 状态不可回读——facts 如实标注人工路径
  assert.ok(out.join('\n').includes('状态不可回读'));
});

test('B2 全链 apply：目录移动 + meta prepared + archive_prepared 事件 + 归档提交 + 推送', async () => {
  const repo = makeDoneRepo();
  const { out } = await runCapture([REQ], {});
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([REQ], { apply: planId });
  assert.equal(rc, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');

  // 物理移动 + meta
  assert.ok(existsSync(path.join(repo, ARCHIVE_DIR, 'meta.yaml')), '归档路径应有 meta');
  assert.ok(!existsSync(path.join(repo, '.sdlc', `req-${REQ}`)), '原目录应已移走');
  const metaText = readFileSync(path.join(repo, ARCHIVE_DIR, 'meta.yaml'), 'utf8');
  assert.match(metaText, /archive_status: prepared/);

  // 事件随归档目录落盘（移动事件随归档提交发布）
  const events = journalEventsAt(repo, ARCHIVE_DIR);
  const prep = events.find((e) => e.action === 'archive_prepared');
  assert.equal(prep.result, 'succeeded');
  assert.equal(prep.payload.archive_dir, ARCHIVE_DIR);
  assert.ok(prep.payload.pr);

  // 归档提交只收归档路径（journal/meta 已含于 git mv 的 rename）
  const lastStat = gitOut(['show', '--stat=200', '--format=', 'HEAD'], repo);
  assert.ok(lastStat.includes('archive'), `归档提交应含 archive 路径：\n${lastStat}`);
  // 推送（origin 有归档提交）
  const remoteCount = Number(gitOut(['rev-list', '--count', `refs/remotes/origin/${BRANCH}`], repo));
  assert.ok(remoteCount >= 2, `远端应有归档提交（实际 ${remoteCount}）`);
  assert.ok(text.includes('[publish_push]'));
  assert.ok(text.includes('归档已准备'));
  assert.ok(text.includes('待人工合并'));
  // 工作区干净（发布边界）
  assert.equal(gitOut(['status', '--porcelain'], repo), '');
});

test('B2 幂等重跑：全跳过、无新提交无新事件', async () => {
  const repo = makeDoneRepo();
  const { out } = await runCapture([REQ], {});
  const planId = planIdOf(out);
  await runCapture([REQ], { apply: planId });
  const nEvents = journalEventsAt(repo, ARCHIVE_DIR).length;
  const nCommits = Number(gitOut(['rev-list', '--count', 'HEAD'], repo));

  const { rc, out: again } = await runCapture([REQ], { apply: planId });
  assert.equal(rc, 0, again.join('\n'));
  const text = again.join('\n');
  assert.ok(text.includes('[archive_move] 已归档至'));
  assert.ok(text.includes('跳过'));
  assert.equal(Number(gitOut(['rev-list', '--count', 'HEAD'], repo)), nCommits);
  assert.equal(journalEventsAt(repo, ARCHIVE_DIR).length, nEvents);
});

test('B2 冲突：归档目录已存在 → 预览拒绝（CLI 不猜测覆盖）', async () => {
  const repo = makeDoneRepo();
  mkdirSync(path.join(repo, ARCHIVE_DIR), { recursive: true });
  writeFileSync(path.join(repo, ARCHIVE_DIR, 'meta.yaml'), 'x: 1\n');
  await assert.rejects(
    () => runDone([REQ], {}),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('归档目录已存在'),
  );
});

test('B2 未跟踪提示：req 目录有未跟踪文件 → 预览警示先 save（git mv 会拒绝）', async () => {
  const repo = makeDoneRepo();
  writeFileSync(path.join(repo, '.sdlc', `req-${REQ}`, 'draft.txt'), 'x\n');
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('未跟踪文件'));
  assert.ok(text.includes('先 sdlc next --intent save'));
});

test('B2 --no-archive_move：目录未动 + meta_done/archive_commit noop + 归档未完成话术', async () => {
  const repo = makeDoneRepo();
  const { out } = await runCapture([REQ], {});
  const planId = planIdOf(out);
  const { rc, out: applyOut } = await runCapture([REQ], { apply: planId, no: { archive_move: true } });
  assert.equal(rc, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');
  assert.ok(existsSync(path.join(repo, '.sdlc', `req-${REQ}`)), '目录应留在原位');
  assert.ok(!existsSync(path.join(repo, ARCHIVE_DIR)));
  assert.ok(text.includes('[meta_done] 未归档，无字段可写，跳过'));
  assert.ok(text.includes('[archive_commit] 未归档，跳过'));
  assert.ok(text.includes('归档未完成'));
  // 留痕：action_skipped + archive_prepared(result=failed) 落原路径 journal
  const events = journalEventsAt(repo, `.sdlc/req-${REQ}`);
  assert.equal(events.filter((e) => e.action === 'action_skipped' && e.payload.action === 'archive_move').length, 1);
  assert.equal(events.find((e) => e.action === 'archive_prepared').result, 'failed');
});

// ---------- B4/B5/B6（B2 之后的链） ----------

/** B2 已执行完的归档仓库（B4/B5/B6 基座）。 */
async function makeArchivedRepo() {
  const repo = makeDoneRepo();
  const prev = await runCapture([REQ], {});
  await runCapture([REQ], { apply: planIdOf(prev.out) });
  return repo;
}

test('B4：已归档 → 稳态提示 + 待合并提醒话术（含人工确认入口），无新计划', async () => {
  await makeArchivedRepo();
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('归档已准备，待人工合并'));
  assert.ok(text.includes('待合并提醒'));
  assert.ok(text.includes(`sdlc done ${REQ} --manual-confirm pr_merged`));
  assert.ok(!text.includes('确认执行：sdlc done --apply'));
});

test('B5 全链：--manual-confirm pr_merged → complete 计划 → db manual + 终态流转 + 本地留痕（不追加收尾提交）', async () => {
  const repo = await makeArchivedRepo();
  const { rc, out } = await runCapture([REQ], { manualConfirm: 'pr_merged' });
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  assert.equal(plan.state.kind, 'done_complete');
  assert.deepEqual(plan.actions.map((a) => a.id), ['complete']);
  assert.equal(plan.actions[0].args.completion.source, 'manual');
  assert.equal(plan.actions[0].args.completion.result, 'manual');
  assert.ok(out.join('\n').includes('人工确认'));

  const nCommits = Number(gitOut(['rev-list', '--count', 'HEAD'], repo));
  const { rc: rc2, out: applyOut } = await runCapture([REQ], { apply: plan.plan_id, manualConfirm: 'pr_merged' });
  assert.equal(rc2, 0, applyOut.join('\n'));
  const text = applyOut.join('\n');

  // core 侧（真源）：completion=manual（source=manual 如实标注——不伪装 verified）+ 终态流转
  const db = mockDb();
  assert.equal(db.requirements[REQ].completion_status, 'manual');
  assert.equal(db.requirements[REQ].current_stage, 'done');
  // 本地留痕：completion_recorded 事件 + meta completion_status（契约 §5——不为事后日志写主干）
  assert.equal(journalEventsAt(repo, ARCHIVE_DIR).filter((e) => e.action === 'completion_recorded').length, 1);
  const metaText = readFileSync(path.join(repo, ARCHIVE_DIR, 'meta.yaml'), 'utf8');
  assert.match(metaText, /completion_status: manual/);
  assert.equal(Number(gitOut(['rev-list', '--count', 'HEAD'], repo)), nCommits);
  // 留痕随下次发布自然收走：归档 journal/meta 脏在工作区（未提交）
  assert.ok(gitOut(['status', '--porcelain'], repo).includes(ARCHIVE_DIR));
  assert.ok(text.includes('completion=manual'));
  assert.ok(text.includes('不追加收尾提交'));
});

test('B5 幂等重跑：complete 跳过（执行记录 ok），db 不变、无新事件', async () => {
  const repo = await makeArchivedRepo();
  const { out } = await runCapture([REQ], { manualConfirm: 'pr_merged' });
  const planId = planIdOf(out);
  await runCapture([REQ], { apply: planId, manualConfirm: 'pr_merged' });
  const nEvents = journalEventsAt(repo, ARCHIVE_DIR).length;
  const { rc, out: again } = await runCapture([REQ], { apply: planId, manualConfirm: 'pr_merged' });
  assert.equal(rc, 0, again.join('\n'));
  assert.ok(again.join('\n').includes('[complete] 收尾已记录，跳过'));
  assert.equal(mockDb().requirements[REQ].completion_status, 'manual');
  assert.equal(journalEventsAt(repo, ARCHIVE_DIR).length, nEvents);
});

test('B5 过期：预览后远端已收尾 → apply 拒绝（core 已记录，不重复执行）', async () => {
  const repo = await makeArchivedRepo();
  const { out } = await runCapture([REQ], { manualConfirm: 'pr_merged' });
  const planId = planIdOf(out);
  setDb((db) => { db.requirements[REQ].completion_status = 'manual'; });
  await assert.rejects(
    () => runDone([REQ], { apply: planId, manualConfirm: 'pr_merged' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('core 已记录收尾'),
  );
});

test('B5 accept-gaps：缺口存在 → --accept-gaps 记 with_gaps（accepted_gaps 随请求留痕）；mock 落库 manual', async () => {
  const repo = await makeArchivedRepo();
  // 制造缺口：删 brief（test-brief check 落 gap）——归档路径里的文件
  rmSync(path.join(repo, ARCHIVE_DIR, 'test', 'brief.md'));
  git(['rm', '-q', path.join(ARCHIVE_DIR, 'test/brief.md')], repo); // rm 后 git 状态一致
  const { out } = await runCapture([REQ], { manualConfirm: 'pr_merged', acceptGaps: true });
  const text = out.join('\n');
  assert.ok(text.includes('核验缺口'), '预览应列出缺口');
  const plan = loadPlan(planIdOf(out));
  assert.ok(plan.gaps.length > 0);
  assert.equal(plan.actions[0].args.completion.result, 'with_gaps');
  assert.equal(plan.actions[0].args.completion.accepted_gaps.length, plan.gaps.length);

  const { rc, out: applyOut } = await runCapture([REQ], { apply: plan.plan_id, manualConfirm: 'pr_merged', acceptGaps: true });
  assert.equal(rc, 0, applyOut.join('\n'));
  // mock 落库：source=manual 恒 manual（不伪称 verified/with_gaps）；缺口细节随事件留痕
  assert.equal(mockDb().requirements[REQ].completion_status, 'manual');
  const ev = journalEventsAt(repo, ARCHIVE_DIR).find((e) => e.action === 'completion_recorded');
  assert.equal(ev.payload.completion_status, 'manual');
  assert.equal(ev.payload.accepted_gaps.length, plan.gaps.length);
});

test('提前合并场景：目录原位 + --manual-confirm → complete 计划（archived:false，留痕落活跃路径）', async () => {
  makeDoneRepo(META_WITH_PR);
  const { rc, out } = await runCapture([REQ], { manualConfirm: 'pr_merged' });
  assert.equal(rc, 0, out.join('\n'));
  const plan = loadPlan(planIdOf(out));
  assert.equal(plan.state.kind, 'done_complete');
  assert.equal(plan.state.archived, false);
  const { rc: rc2, out: applyOut } = await runCapture([REQ], { apply: plan.plan_id, manualConfirm: 'pr_merged' });
  assert.equal(rc2, 0, applyOut.join('\n'));
  // 留痕落活跃目录（提前合并不强制先归档）
  const metaText = readFileSync(path.join(process.cwd(), '.sdlc', `req-${REQ}`, 'meta.yaml'), 'utf8');
  assert.match(metaText, /completion_status: manual/);
  assert.ok(existsSync(path.join(process.cwd(), '.sdlc', `req-${REQ}`)), '目录应留在原位');
});

test('B6：core 已记录收尾 → 终态提示，无计划', async () => {
  await makeArchivedRepo();
  setDb((db) => { db.requirements[REQ].completion_status = 'verified'; });
  const { rc, out } = await runCapture([REQ], {});
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('已完成收尾'));
  assert.ok(text.includes('completion=verified'));
  assert.ok(!text.includes('确认执行：sdlc done --apply'));
});

test('--manual-confirm 值校验：非 pr_merged → validation_failed', async () => {
  makeDoneRepo();
  await assert.rejects(
    () => runDone([REQ], { manualConfirm: 'something_else' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('仅支持 pr_merged'),
  );
});
