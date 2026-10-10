// config：yaml 解析、schema 校验、config_revision 稳定性、evaluateDod 子集。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadRepoConfig, evaluateDod } from '../cli/src/config.js';
import { SdlcError } from '../cli/src/errors.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-test-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const CONFIG_YAML = `schema_version: 5
git:
  trunk: main
stages:
  - id: prd
    dod:
      - id: prd-file
        text: PRD 存在
        check: file_exists
        path: product/prd.md
      - id: prd-sync
        text: 已同步
        check: git_synced
  - id: dev
    dod: []
`;

function makeRoot(name, yamlText) {
  const root = path.join(tmp, name);
  mkdirSync(path.join(root, '.sdlc'), { recursive: true });
  writeFileSync(path.join(root, '.sdlc', 'config.yaml'), yamlText ?? CONFIG_YAML);
  return root;
}

test('loadRepoConfig：解析 + revision 稳定（同内容同摘要）', () => {
  const a = loadRepoConfig(makeRoot('r1'));
  const b = loadRepoConfig(makeRoot('r2'));
  assert.equal(a.configRevision, b.configRevision);
  assert.equal(a.config.stages.length, 2);
  assert.match(a.configRevision, /^[0-9a-f]{64}$/);
});

test('loadRepoConfig：schema_version 不符 → schema_unsupported', () => {
  const root = makeRoot('r3', 'schema_version: 3\n');
  assert.throws(() => loadRepoConfig(root), (e) => e instanceof SdlcError && e.code === 'schema_unsupported');
});

test('evaluateDod：file_exists 按 req 目录判定，未实现 check 标 unknown', () => {
  const { config, root } = loadRepoConfig(makeRoot('r4'));
  const reqDir = path.join(root, '.sdlc', 'req-123');
  mkdirSync(path.join(reqDir, 'product'), { recursive: true });
  writeFileSync(path.join(reqDir, 'product', 'prd.md'), 'x');
  const sync = { clean: true, ahead: false, behind: false, raw: '' };
  const dod = evaluateDod(config, reqDir, sync, 'prd');
  assert.deepEqual(
    dod.map((d) => [d.id, d.status]),
    [
      ['prd-file', 'ok'],
      ['prd-sync', 'ok'],
    ],
  );
  // 文件缺失 → gap；未实现 check → unknown
  const dod2 = evaluateDod(config, reqDir, { clean: true, ahead: true, behind: false, raw: '' }, 'prd');
  assert.equal(dod2[0].status, 'ok');
  assert.equal(dod2[1].status, 'gap');
});

// ---------- tasks_parseable（I2：接 tasks.js 真实解析，契约 §8） ----------

const TASKS_YAML = `schema_version: 5
git:
  trunk: main
stages:
  - id: dev
    dod:
      - id: dev-tasks
        text: 粗任务块可解析
        check: tasks_parseable
        path: tasks.md
`;

function writeTasks(reqDir, inner) {
  mkdirSync(reqDir, { recursive: true });
  const body = inner === null ? '# 无任务块\n' : `<!-- sdlc:tasks begin -->\n\`\`\`yaml\n${inner}\n\`\`\`\n<!-- sdlc:tasks end -->\n`;
  writeFileSync(path.join(reqDir, 'tasks.md'), body, 'utf8');
}

test('evaluateDod tasks_parseable：合法块 ok；缺块 ok + note 提示；字段错误 gap 带 note', () => {
  const { config, root } = loadRepoConfig(makeRoot('r5', TASKS_YAML));
  const sync = { clean: true, ahead: false, behind: false, raw: '' };

  const okDir = path.join(root, '.sdlc', 'req-200');
  writeTasks(okDir, 'tasks:\n  - id: "1"\n    title: t\n    assignee_role: dev\n');
  const ok = evaluateDod(config, okDir, sync, 'dev');
  assert.equal(ok[0].status, 'ok');
  assert.equal(ok[0].note, undefined);

  const noBlockDir = path.join(root, '.sdlc', 'req-201');
  writeTasks(noBlockDir, null);
  const noBlock = evaluateDod(config, noBlockDir, sync, 'dev');
  assert.equal(noBlock[0].status, 'ok');
  assert.ok(noBlock[0].note.includes('未使用任务块'));

  const badDir = path.join(root, '.sdlc', 'req-202');
  writeTasks(badDir, 'tasks:\n  - id: "1"\n    title: t\n');
  const bad = evaluateDod(config, badDir, sync, 'dev');
  assert.equal(bad[0].status, 'gap');
  assert.ok(bad[0].note.includes('assignee_role'));

  // 文件缺失：file_exists 另行覆盖，这里表现为 found:false → ok + note
  const missingDir = path.join(root, '.sdlc', 'req-203');
  mkdirSync(missingDir, { recursive: true });
  const missing = evaluateDod(config, missingDir, sync, 'dev');
  assert.equal(missing[0].status, 'ok');
  assert.ok(missing[0].note.includes('未使用任务块'));
});

// ---------- I3：pr_exists / pr_merged / report_current ----------

const DOD3_YAML = `schema_version: 5
git:
  trunk: main
stages:
  - id: dev
    dod:
      - id: dev-pr
        text: PR 已创建
        check: pr_exists
      - id: dev-merged
        text: PR 已合并
        check: pr_merged
  - id: test
    dod:
      - id: test-report
        text: 报告为本轮
        check: report_current
        path: test/report.md
`;

test('evaluateDod pr_exists/pr_merged：本地引用 + 回读裁决（未核实不猜）', () => {
  const { config, root } = loadRepoConfig(makeRoot('r6', DOD3_YAML));
  const sync = { clean: true, ahead: false, behind: false, raw: '' };
  const reqDir = path.join(root, '.sdlc', 'req-300');
  mkdirSync(reqDir, { recursive: true });

  // 无 meta → unknown（不猜测）；有 meta 无 pr_ref → 两个都 gap
  const noMeta = evaluateDod(config, reqDir, sync, 'dev');
  assert.deepEqual(noMeta.map((d) => d.status), ['unknown', 'unknown']);
  const noPr = evaluateDod(config, reqDir, sync, 'dev', { meta: {} });
  assert.deepEqual(noPr.map((d) => [d.id, d.status, d.note]), [
    ['dev-pr', 'gap', 'PR 未创建'],
    ['dev-merged', 'gap', 'PR 未创建'],
  ]);

  // v5（D59 人工路径）：有 pr_ref 时 pr_exists ok；pr_merged 状态不可回读——
  // 核实来源只有人工确认收尾记录（completion_status）；未确认 → unknown 不猜
  const meta = { pr_ref: { pr_id: 1, repo: 'g/r', url: 'u' } };
  assert.equal(evaluateDod(config, reqDir, sync, 'dev', { meta })[0].status, 'ok');
  const unverified = evaluateDod(config, reqDir, sync, 'dev', { meta });
  assert.equal(unverified[1].status, 'unknown');
  assert.ok(unverified[1].note.includes('未核实'));
  assert.ok(unverified[1].note.includes('--manual-confirm'));
  // 旧 prState 回读路径退役（兼容签名保留但不可达）——传入也不再裁决
  const stale = evaluateDod(config, reqDir, sync, 'dev', { meta, prState: { state: 'merged' } });
  assert.equal(stale[1].status, 'unknown');
  // 人工确认收尾已落（completion_status 非 pending）→ ok，note 标注人工确认
  const confirmed = evaluateDod(config, reqDir, sync, 'dev', { meta: { ...meta, completion_status: 'manual' } });
  assert.equal(confirmed[1].status, 'ok');
  assert.ok(confirmed[1].note.includes('人工确认'));
});

test('evaluateDod report_current：缺文件/未填/过期 → gap 待复核；齐 → ok', () => {
  const { config, root } = loadRepoConfig(makeRoot('r7', DOD3_YAML));
  const sync = { clean: true, ahead: false, behind: false, raw: '' };
  const reqDir = path.join(root, '.sdlc', 'req-301');
  mkdirSync(path.join(reqDir, 'test'), { recursive: true });
  const report = (text) => writeFileSync(path.join(reqDir, 'test', 'report.md'), text, 'utf8');

  const meta = { test_round: 2 };
  const at = (extra) => evaluateDod(config, reqDir, sync, 'test', { meta, ...extra })[0];

  // 缺文件
  assert.equal(at().status, 'gap');
  assert.ok(at().note.includes('报告未创建'));
  // 模板占位（{{…}}）算未填
  report('# 报告\n- test_round: {{test_round}}\n- requirement_version: {{requirement_version}}\n');
  const tpl = at();
  assert.equal(tpl.status, 'gap');
  assert.ok(tpl.note.includes('test_round 未填') && tpl.note.includes('requirement_version 未填'));
  // 过期：报告第 1 轮，meta 第 2 轮
  report('- test_round: 1\n- requirement_version: v1\n- code_ref: sha\n- result: 通过\n');
  const stale = at();
  assert.equal(stale.status, 'gap');
  assert.ok(stale.note.includes('test_round 过期'));
  // 齐 → ok
  report('- test_round: 2\n- requirement_version: v1\n- code_ref: sha\n- result: 通过\n');
  assert.equal(at().status, 'ok');
  // 注释尾不算内容（D44 模板字段行带行内注释）
  report('- test_round: 2 <!-- 本轮 -->\n- requirement_version: v1\n- code_ref: sha\n- result: 通过\n');
  assert.equal(at().status, 'ok');
});
