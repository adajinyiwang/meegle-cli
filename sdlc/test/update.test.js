// sdlc update 分发自更新（I5，D53）：开发安装拒绝/预览计划/apply 全链（checkout
// + shim/skill-core/薄入口重铺 + tool 记录）/降级/自定义差异不静默覆盖/--force/
// 自检失败自动回滚/工作区脏拒绝/已最新。
// 隔离：SDLC_DIST/SDLC_HOME/USERPROFILE 临时目录（模块加载前设置 → 动态 import）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(path.join(tmpdir(), 'sdlc-home-'));
process.env.SDLC_HOME = home;

const { runUpdate } = await import('../cli/src/command/update.js');
const { loadUserConfig } = await import('../cli/src/config.js');
const { runGit } = await import('../cli/src/gitops.js');
const { SdlcError } = await import('../cli/src/errors.js');

const dists = [];
const homes = [];
test.after(() => {
  for (const d of dists) rmSync(d, { recursive: true, force: true });
  for (const h of homes) rmSync(h, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const git = (args, cwd) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const gitOut = (args, cwd) => {
  const r = git(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout;
};

/** v0.2.0 的 skill-core 标记行（内容差异断言锚点）。 */
const V2_MARK = '<!-- v0.2.0 标记行 -->';

/**
 * 建独立分发仓库 dist：拷真实 cli 树 + skill-core/entries/VERSION，打
 * v0.1.0/v0.2.0 tag，push 到 bare origin（fetch 链真实）。
 * @param {{badTag?: boolean}} [opts] badTag：追 v0.3.0（bin 顶层 throw——自检失败用）
 * @returns {string} dist 根
 */
function makeDist(opts = {}) {
  const D = mkdtempSync(path.join(tmpdir(), 'sdlc-dist-'));
  dists.push(D);
  cpSync(path.join(SRC, 'cli'), path.join(D, 'cli'), { recursive: true });
  cpSync(path.join(SRC, 'entries'), path.join(D, 'entries'), { recursive: true });
  cpSync(path.join(SRC, 'skill-core.md'), path.join(D, 'skill-core.md'));
  writeFileSync(path.join(D, 'VERSION'), '0.1.0');
  git(['init'], D);
  git(['config', 'user.email', 't@example.com'], D);
  git(['config', 'user.name', 't'], D);
  git(['add', '.'], D);
  git(['commit', '-qm', 'chore: v0.1.0'], D);
  git(['tag', 'v0.1.0'], D);
  // v0.2.0：skill-core 加标记行 + VERSION 升
  const core = readFileSync(path.join(D, 'skill-core.md'), 'utf8');
  writeFileSync(path.join(D, 'skill-core.md'), core + `\n${V2_MARK}\n`);
  writeFileSync(path.join(D, 'VERSION'), '0.2.0');
  git(['add', '.'], D);
  git(['commit', '-qm', 'chore: v0.2.0'], D);
  git(['tag', 'v0.2.0'], D);
  if (opts.badTag) {
    // v0.3.0：坏构建（bin 顶层 throw → --version spawn 失败 → 触发回滚）
    const bin = readFileSync(path.join(D, 'cli', 'bin', 'sdlc.js'), 'utf8');
    writeFileSync(path.join(D, 'cli', 'bin', 'sdlc.js'), `throw new Error('bad build');\n${bin}`);
    writeFileSync(path.join(D, 'VERSION'), '0.3.0');
    git(['add', '.'], D);
    git(['commit', '-qm', 'chore: v0.3.0 bad'], D);
    git(['tag', 'v0.3.0'], D);
  }
  const O = mkdtempSync(path.join(tmpdir(), 'sdlc-upd-origin-'));
  dists.push(O);
  git(['init', '--bare'], O);
  git(['remote', 'add', 'origin', O.replace(/\\/g, '/')], D);
  git(['branch', 'main'], D); // 远端主线（HEAD 最终 detached 在旧 tag）
  git(['push', '-q', 'origin', 'main'], D);
  git(['push', '-q', '--tags', 'origin'], D);
  git(['checkout', '-q', 'v0.1.0'], D); // 安装态 = 旧 tag（detached）
  return D;
}

/**
 * 环境隔离：SDLC_DIST 指定 dist + 新 USERPROFILE（shim/claude 入口隔离）。
 * @param {string} dist
 * @returns {string} 假 home（os.homedir() 指向它）
 */
function useEnv(dist) {
  process.env.SDLC_DIST = dist;
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'sdlc-fakehome-'));
  homes.push(fakeHome);
  process.env.USERPROFILE = fakeHome;
  return fakeHome;
}

/** @param {Record<string, any>} opts */
async function runCapture(opts) {
  const out = [];
  const log = console.log, err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { rc: await runUpdate(opts), out };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const desc = (dist) => gitOut(['describe', '--tags', '--exact-match', 'HEAD'], dist).trim();
const claudeEntry = (fakeHome, name = 'sdlc-start') => path.join(fakeHome, '.claude', 'skills', name, 'SKILL.md');
const shimOf = (fakeHome) => path.join(fakeHome, 'bin', 'sdlc');

// ---------- 拒绝与校验 ----------

test('开发安装（非独立 git 根）拒绝自更新', async () => {
  const notRepo = mkdtempSync(path.join(tmpdir(), 'sdlc-notrepo-'));
  dists.push(notRepo);
  const { rc, out } = await runCapture({});
  assert.equal(rc, 1);
  assert.ok(out.join('\n').includes('非独立分发仓库'));
});

test('tag 不存在 → validation_failed；未知 --tool 拒绝', async () => {
  const D = makeDist();
  useEnv(D);
  await assert.rejects(
    () => runUpdate({ to: 'v9.9.9' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('不存在'),
  );
  await assert.rejects(
    () => runUpdate({ tool: 'vscode' }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('--tool'),
  );
});

test('工作区脏 → apply 拒绝（不猜测切换）', async () => {
  const D = makeDist();
  useEnv(D);
  writeFileSync(path.join(D, 'local-note.txt'), '脏\n');
  await assert.rejects(
    () => runUpdate({ to: 'v0.2.0', apply: true }),
    (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('不干净'),
  );
  assert.equal(desc(D), 'v0.1.0');
});

// ---------- 预览 ----------

test('预览：当前→目标 + 变更摘要 + 覆盖清单 + 确认行', async () => {
  const D = makeDist();
  const fakeHome = useEnv(D);
  const { rc, out } = await runCapture({ tool: 'claude' });
  assert.equal(rc, 0, out.join('\n'));
  const text = out.join('\n');
  assert.ok(text.includes('当前：v0.1.0'));
  assert.ok(text.includes('目标：v0.2.0'));
  assert.ok(text.includes('升级'));
  assert.ok(text.includes('chore: v0.2.0'));
  assert.ok(text.includes('~/.sdlc/skill-core.md'));
  assert.ok(text.includes('~/.claude/skills/sdlc-start/SKILL.md'));
  assert.ok(text.includes('确认执行：sdlc update --to v0.2.0 --apply --tool claude'));
  assert.equal(desc(D), 'v0.1.0'); // 预览零写
  assert.ok(!existsSync(claudeEntry(fakeHome)));
});

// ---------- apply 全链 ----------

test('apply 全链：checkout v0.2.0 + shim/skill-core/6 skill 薄入口重铺 + tool 记录 + 自检', async () => {
  const D = makeDist();
  const fakeHome = useEnv(D);
  const { rc, out } = await runCapture({ apply: true, tool: 'claude' });
  assert.equal(rc, 0, out.join('\n'));
  assert.equal(desc(D), 'v0.2.0');
  // shim 指向 dist 新版（win32 额外有 .cmd——cmd/PowerShell 入口）
  const shim = readFileSync(shimOf(fakeHome), 'utf8');
  assert.ok(shim.includes('sdlc.js'));
  if (process.platform === 'win32') {
    assert.ok(readFileSync(path.join(fakeHome, 'bin', 'sdlc.cmd'), 'utf8').includes('sdlc.js'));
  }
  // skill-core 为 v0.2.0 版（标记行）
  assert.ok(readFileSync(path.join(home, 'skill-core.md'), 'utf8').includes(V2_MARK));
  // 6 个 skill 薄入口全部就位且为分发版
  const { CLAUDE_ENTRY_SKILLS } = await import('../cli/src/dist.js');
  for (const name of CLAUDE_ENTRY_SKILLS) {
    assert.ok(existsSync(claudeEntry(fakeHome, name)), `skill 缺失：${name}`);
    assert.equal(readFileSync(claudeEntry(fakeHome, name), 'utf8'), readFileSync(path.join(D, 'entries', 'claude', name, 'SKILL.md'), 'utf8'), `skill 内容不符：${name}`);
  }
  const text = out.join('\n');
  assert.ok(text.includes('更新完成（v0.1.0 → v0.2.0'));
  assert.ok(text.includes('自检'));
  // tool 记录（保留无其他字段冲突）
  assert.equal(loadUserConfig().tool, 'claude');
});

test('降级 --to v0.1.0：HEAD 与 skill-core 回旧版', async () => {
  const D = makeDist();
  const fakeHome = useEnv(D);
  await runCapture({ apply: true, tool: 'claude' });
  const { rc, out } = await runCapture({ to: 'v0.1.0', apply: true, tool: 'claude' });
  assert.equal(rc, 0, out.join('\n'));
  assert.equal(desc(D), 'v0.1.0');
  assert.ok(!readFileSync(path.join(home, 'skill-core.md'), 'utf8').includes(V2_MARK));
});

test('自定义差异：无 --force 不覆盖（跳过+警告）；--force 覆盖', async () => {
  const D = makeDist();
  const fakeHome = useEnv(D);
  // 预置自定义 claude 入口（与分发版不同）
  mkdirSync(path.dirname(claudeEntry(fakeHome)), { recursive: true });
  writeFileSync(claudeEntry(fakeHome), '我的自定义入口\n');
  const customBefore = readFileSync(claudeEntry(fakeHome), 'utf8');
  const { rc, out } = await runCapture({ apply: true, tool: 'claude' });
  assert.equal(rc, 0, out.join('\n'));
  assert.equal(readFileSync(claudeEntry(fakeHome), 'utf8'), customBefore); // 未动
  assert.ok(out.join('\n').includes('未静默覆盖'));
  // --force：覆盖为分发版
  const { rc: rc2, out: out2 } = await runCapture({ apply: true, tool: 'claude', force: true });
  assert.equal(rc2, 0, out2.join('\n'));
  assert.notEqual(readFileSync(claudeEntry(fakeHome), 'utf8'), customBefore);
});

test('自检失败自动回滚：坏构建 tag → checkout 回旧版 + 重铺 + rc1', async () => {
  const D = makeDist({ badTag: true });
  const fakeHome = useEnv(D);
  // 先升到 v0.2.0（干净版）
  await runCapture({ to: 'v0.2.0', apply: true, tool: 'claude' });
  assert.equal(desc(D), 'v0.2.0');
  // 再升最新 v0.3.0（坏构建）→ 自检失败 → 回滚 v0.2.0
  const { rc, out } = await runCapture({ apply: true, tool: 'claude' });
  assert.equal(rc, 1);
  const text = out.join('\n');
  assert.ok(text.includes('自检失败'));
  assert.ok(text.includes('已回滚至 v0.2.0'));
  assert.equal(desc(D), 'v0.2.0');
  // 重铺回旧版（skill-core 无坏版内容——v0.2.0 标记仍在）
  assert.ok(readFileSync(path.join(home, 'skill-core.md'), 'utf8').includes(V2_MARK));
});

test('已最新：目标 = 当前 tag → 提示 rc0（无计划输出）', async () => {
  const D = makeDist();
  useEnv(D);
  const { rc, out } = await runCapture({ to: 'v0.1.0' });
  assert.equal(rc, 0);
  assert.ok(out.join('\n').includes('已是最新'));
  assert.ok(!out.join('\n').includes('确认执行'));
});

test('doctor 薄入口核验：apply 后 skill_entry 就位 ok；缺失 → fail', async () => {
  const { runDoctor } = await import('../cli/src/command/doctor.js');
  const D = makeDist();
  const fakeHome = useEnv(D);
  // 未铺 → missing（不算 fail，提示 install）
  const rowOf = (out) => JSON.parse(out.join('\n')).checks.find((r) => r.id === 'skill_entry');
  await runCapture({ apply: true, tool: 'claude' });
  const { out: docOut } = await (async () => {
    const o = [];
    const log = console.log, err = console.error;
    console.log = (...a) => o.push(a.join(' '));
    console.error = (...a) => o.push(a.join(' '));
    try {
      return { rc: await runDoctor({ json: true }), out: o };
    } finally {
      console.log = log;
      console.error = err;
    }
  })();
  const row = rowOf(docOut);
  assert.equal(row.status, 'ok');
  assert.ok(row.text.includes('就位且为分发版'));
  // 删除入口 → fail（重铺提示）
  rmSync(claudeEntry(fakeHome));
  const o2 = [];
  const log2 = console.log, err2 = console.error;
  console.log = (...a) => o2.push(a.join(' '));
  console.error = (...a) => o2.push(a.join(' '));
  try { await runDoctor({ json: true }); } finally { console.log = log2; console.error = err2; }
  const row2 = rowOf(o2);
  assert.equal(row2.status, 'fail');
  assert.ok(row2.text.includes('重铺'));
  assert.ok(row2.text.includes('sdlc-start'));
});
