// status：归档定位（D42）、PR 回读行、话术只读补取与发布状态区分（D46）。
// 隔离：SDLC_HOME/SDLC_MOCK_STATE 临时目录（模块加载前设置 → 动态 import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'sdlc-home-'));
process.env.SDLC_HOME = home;
process.env.SDLC_MOCK_STATE = mkdtempSync(path.join(tmpdir(), 'sdlc-mock-'));

const { runStatus } = await import('../cli/src/command/status.js');
const { makeEvent } = await import('../cli/src/journal.js');
const { newExecution, saveExecution, recordAction } = await import('../cli/src/execution.js');
const { SdlcError } = await import('../cli/src/errors.js');

const REQ = '7331110000';
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

/**
 * 建 status 用仓库 + 需求档案。
 * @param {object} [opts] metaYaml 追加段 / journal 事件行 / 归档
 */
function makeRepo(opts = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'sdlc-status-'));
  repos.push(repo);
  const reqDir = path.join(repo, '.sdlc', `req-${REQ}`);
  mkdirSync(reqDir, { recursive: true });
  writeFileSync(path.join(repo, '.sdlc', 'config.yaml'), CONFIG_YAML);
  writeFileSync(
    path.join(reqDir, 'meta.yaml'),
    `schema_version: 5
req_id: "${REQ}"
title: 状态用需求
feishu_url: https://project.feishu.cn/req/${REQ}
profile: dev
branch: req/${REQ}-x
current_stage: dev
stage_version: 1
completion_status: ${opts.completion ?? 'pending'}
${opts.metaExtra ?? ''}
`,
  );
  if (opts.event) writeFileSync(path.join(reqDir, 'journal.jsonl'), opts.event + '\n');
  if (opts.archive) {
    const archDir = path.join(repo, '.sdlc', 'archive', `2026-09-done-req-${REQ}`);
    mkdirSync(archDir, { recursive: true });
    writeFileSync(path.join(archDir, 'meta.yaml'), readFileSync(path.join(reqDir, 'meta.yaml')));
    if (opts.event) writeFileSync(path.join(archDir, 'journal.jsonl'), opts.event + '\n');
    // 归档后活跃目录移除（模拟 done 归档搬移）
    rmSync(reqDir, { recursive: true, force: true });
  }
  process.chdir(repo);
  return repo;
}

const repos = [];
test.after(() => {
  process.chdir(tmpdir());
  for (const r of repos) rmSync(r, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(process.env.SDLC_MOCK_STATE, { recursive: true, force: true });
});

/** @param {import('../cli/src/command/status.js')} _n 占位避免 lint 空参 */
async function runCapture(args, opts) {
  const out = [];
  const log = console.log, err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { rc: await runStatus(args, opts), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** 造 handoff_prepared 事件 + 对应执行记录（publish_push 可控）。pr 为 v5 人工路径形状。 */
function prepHandoff({ published = true } = {}) {
  const exec = newExecution('p-status-1', { intent: 'handoff' }, REQ);
  saveExecution(exec);
  if (published) recordAction(exec, 'publish_push', { status: 'ok' });
  const ev = makeEvent({
    action: 'handoff_prepared', executionId: exec.execution_id, actionId: 'journal', planId: 'p-status-1',
    actor: 'usr-mock-dev', result: 'succeeded',
    payload: {
      req_id: REQ, from: 'dev', to: 'test', branch: `req/${REQ}-x`, advanced: true,
      entry_tasks: ['确认进入开发'],
      pr: { manual: true, create_url: 'https://codeup.example/mock/change/merge_request_create?srcBranch=req%2Fx', source: 'req/x', target: 'main' },
      tasks_completed: [], tasks_cancelled: [],
    },
  });
  return JSON.stringify(ev);
}

test('话术补取（已发布）：journal handoff_prepared → 话术渲染 + 已发布', async () => {
  const event = prepHandoff({ published: true });
  makeRepo({ event, metaExtra: 'archive_status: merged' });
  const { rc, out } = await runCapture([REQ]);
  assert.equal(rc, 0, out.join('\n'));
  const text = out.join('\n');
  assert.ok(text.includes('交接话术'));
  assert.ok(text.includes(`git checkout req/${REQ}-x`));
  assert.ok(text.includes(`sdlc start ${REQ}`));
  assert.ok(text.includes('入口任务已勾选：确认进入开发'));
  assert.ok(text.includes('已发布'));
});

test('话术补取（未核实）：执行记录无 publish_push ok → 未核实', async () => {
  const event = prepHandoff({ published: false });
  makeRepo({ event });
  const { rc, out } = await runCapture([REQ]);
  assert.equal(rc, 0);
  const text = out.join('\n');
  assert.ok(text.includes('交接话术'));
  assert.ok(text.includes('未核实'));
});

test('PR 行（v5 人工路径）：pr_ref 渲染 + pending 标待人工合并；完成态不再标待合并；话术含 MR 创建链接', async () => {
  const event = prepHandoff();
  makeRepo({ event, metaExtra: 'pr_ref:\n  repo: g/r\n  pr_id: 9\n  url: https://codeup.example/mock/pr/9\n' });
  const { rc, out } = await runCapture([REQ]);
  assert.equal(rc, 0);
  const text = out.join('\n');
  // v5：PR 状态不可回读——恒按本地 pr_ref 渲染 + 标注人工路径
  assert.ok(text.includes('MR：#9 https://codeup.example/mock/pr/9'));
  assert.ok(text.includes('待人工合并'));
  assert.ok(text.includes('不可回读'));
  // 交接话术（v5 payload.pr 为 manual 形状）→ 渲染 MR 创建链接行
  assert.ok(text.includes('MR 创建链接'));

  // 完成态（completion 非 pending）→ 不再标待人工合并
  makeRepo({ event, completion: 'manual', metaExtra: 'pr_ref:\n  repo: g/r\n  pr_id: 9\n  url: https://codeup.example/mock/pr/9\n' });
  const { out: out2 } = await runCapture([REQ]);
  assert.ok(!out2.join('\n').includes('待人工合并'));
});

test('归档定位（D42）：活跃无 → archive 目录名定点命中 + 标注；仍无 → not_found', async () => {
  makeRepo({ archive: true });
  const { rc, out } = await runCapture([REQ]);
  assert.equal(rc, 0, out.join('\n'));
  const text = out.join('\n');
  assert.ok(text.includes('已归档：.sdlc/archive/2026-09-done-req-' + REQ));
  assert.ok(text.includes(`需求 ${REQ}`));

  await assert.rejects(
    () => runStatus(['9999999999']),
    (e) => e instanceof SdlcError && e.code === 'not_found' && e.message.includes('archive'),
  );
});

test('--json：pr（v5 恒 unknown）/handoff_prepared/话术字段', async () => {
  const event = prepHandoff();
  makeRepo({ event, metaExtra: 'pr_ref:\n  repo: g/r\n  pr_id: 9\n  url: https://codeup.example/mock/pr/9\n' });
  const { rc, out } = await runCapture([REQ], { json: true });
  assert.equal(rc, 0);
  const snap = JSON.parse(out.join('\n'));
  assert.equal(snap.req_id, REQ);
  assert.equal(snap.pr.state, 'unknown'); // v5：PR 状态不可回读（人工路径）——恒 unknown
  assert.equal(snap.handoff_prepared.payload.to, 'test');
  assert.ok(snap.handoff_note.includes('请接手'));
});
