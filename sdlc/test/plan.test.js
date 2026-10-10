// plan：指纹稳定性（敏感字段变 → 指纹变；facts/标题变 → 指纹不变）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, renderPlan, planFingerprint } from '../cli/src/plan.js';

const base = {
  reqId: '7114275203',
  title: '登录流程重构',
  intent: '绑定需求',
  actions: [
    { id: 'branch', title: '切分支 req/7114275203' },
    { id: 'init_dir', title: '创建目录' },
  ],
  gaps: [],
  slots: [],
};

test('指纹稳定：同输入同 plan_id；键序无关', () => {
  const a = buildPlan(base);
  const b = buildPlan({ ...base, actions: [...base.actions] });
  assert.equal(a.plan_id, b.plan_id);
  assert.equal(a.plan_id, planFingerprint(a));
});

test('敏感字段变化 → 指纹变化（actions/gaps/slots）', () => {
  const a = buildPlan(base);
  const withExtraAction = buildPlan({ ...base, actions: [...base.actions, { id: 'x', title: 'x' }] });
  const withGap = buildPlan({ ...base, gaps: ['缺 PRD'] });
  assert.notEqual(a.plan_id, withExtraAction.plan_id);
  assert.notEqual(a.plan_id, withGap.plan_id);
});

test('非敏感字段变化 → 指纹不变（facts/title/url）', () => {
  const a = buildPlan(base);
  const b = buildPlan({ ...base, title: '标题改了', facts: ['mock 模式'] });
  assert.equal(a.plan_id, b.plan_id);
});

test('renderPlan：包含人读关键信息（动作/plan_id）', () => {
  const md = renderPlan(buildPlan(base));
  assert.ok(md.includes('plan_id'));
  assert.ok(md.includes('branch'));
  assert.ok(md.includes('登录流程重构'));
});

// ---------- state 状态指纹（I2，D39：内容摘要必须进 plan_id 防夹带） ----------

const STATE = {
  req_id: '7114275203',
  repo: 'd:/repo',
  branch: 'req/7220318456-login',
  head_sha: 'a'.repeat(40),
  sync_raw: '## req/7220318456-login...origin [ahead 1]',
  files: [{ path: 'src/a.js', digest: 'b'.repeat(64) }],
  scope_all: ['src/a.js'],
  config_revision: 'c'.repeat(64),
  stage: 'dev',
  stage_version: 2,
};

test('state 参与 plan_id：无 state 与有 state 指纹不同；planFingerprint 镜像', () => {
  const a = buildPlan(base);
  const b = buildPlan({ ...base, state: STATE });
  assert.notEqual(a.plan_id, b.plan_id);
  assert.equal(b.plan_id, planFingerprint(b));
});

test('state 内容变 → 指纹变（digest/head/sync_raw）；facts 变 → 不变', () => {
  const b = buildPlan({ ...base, state: STATE });
  const digestChanged = buildPlan({ ...base, state: { ...STATE, files: [{ path: 'src/a.js', digest: 'd'.repeat(64) }] } });
  const headChanged = buildPlan({ ...base, state: { ...STATE, head_sha: 'e'.repeat(40) } });
  const syncChanged = buildPlan({ ...base, state: { ...STATE, sync_raw: '## ...[ahead 2]' } });
  const factsChanged = buildPlan({ ...base, state: STATE, facts: ['x'] });
  assert.notEqual(b.plan_id, digestChanged.plan_id);
  assert.notEqual(b.plan_id, headChanged.plan_id);
  assert.notEqual(b.plan_id, syncChanged.plan_id);
  assert.equal(b.plan_id, factsChanged.plan_id);
});

test('renderPlan：state.files 渲染确认文件范围段（digest 短码）', () => {
  const md = renderPlan(buildPlan({ ...base, state: STATE }));
  assert.ok(md.includes('确认文件范围'));
  assert.ok(md.includes('src/a.js'));
  assert.ok(md.includes(STATE.files[0].digest.slice(0, 8)));
});
