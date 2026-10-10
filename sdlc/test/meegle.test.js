// meegle runner（I6f）：runMeegle 信封解析 / 错误域映射 / 超时 / ENOENT / 多行
// 取尾行；meegleAuthStatus 退出码语义。
// 假二进制：SDLC_MEEGLE_BIN = node 可执行 + cwd 下裸名脚本（node 对 cwd 裸名
// 文件按入口加载——spawn 形状 `node user me --format json --envelope` 与真实
// `meegle user me …` 对 runner 完全同形）。行为由 FAKE_MEEGLE_MODE 控制。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const binDir = mkdtempSync(path.join(tmpdir(), 'sdlc-meegle-'));
const prevBin = process.env.SDLC_MEEGLE_BIN;
const prevCwd = process.cwd();
process.env.SDLC_MEEGLE_BIN = process.execPath;

// 假 `user` 命令（信封逻辑与命令语义无关——统一经 user me 调 runMeegle）
writeFileSync(path.join(binDir, 'user'), `\
const mode = process.env.FAKE_MEEGLE_MODE || 'ok';
const emit = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exit(code); };
if (mode === 'ok') emit({ data: { user_key: 'u1' }, meta: { logid: 'L1' } });
if (mode === 'auth') emit({ data: null, error: { code: 'AUTH_REQUIRED', message: 'no token' }, meta: { logid: 'L2' } }, 1);
if (mode === 'param') emit({ data: null, error: { code: 'PARAM_INVALID', message: 'bad param' }, meta: {} }, 1);
if (mode === 'retryable') emit({ data: null, error: { code: 'SERVER_BUSY', message: 'server busy' }, meta: {} }, 2);
if (mode === 'garbage') { process.stdout.write('not json at all\\n'); process.exit(1); }
if (mode === 'stderr-1') { process.stderr.write('boom\\n'); process.exit(1); }
if (mode === 'empty0') { process.exit(0); }
if (mode === 'multiline') { process.stdout.write('prelude line\\n' + JSON.stringify({ data: { x: 1 }, meta: {} }) + '\\n'); process.exit(0); }
if (mode === 'sleep') { setTimeout(() => emit({ data: {} }), 5000); }
`);

// 假 `auth status`（meegleAuthStatus 只看退出码）；`auth login` 走 device-code
// JSON 形状（v1.0.23 实测：init 无信封直出 JSON；poll 经 runMeegle 信封）
writeFileSync(path.join(binDir, 'auth'), `\
const a = process.argv.slice(2);
if (a[0] === 'login') {
  // normalize 后 --format json --envelope 尾随：phase init 直出 JSON（真实形状）
  if (a.includes('init') && a.includes('--device-code')) {
    process.stdout.write(JSON.stringify({
      client_id: 'cid-1', device_code: 'dc-1', expires_in: 1800, interval: 1,
      user_code: 'UCOD', verification_uri: 'https://project.feishu.cn/authorize',
      verification_uri_complete: 'https://project.feishu.cn/authorize?code=UCOD',
    }) + '\\n');
    process.exit(0);
  }
  if (a.includes('poll')) { process.stdout.write(JSON.stringify({ data: {}, meta: {} }) + '\\n'); process.exit(0); }
  process.stderr.write('phase without --device-code'); process.exit(1);
}
const m = process.env.FAKE_AUTH_MODE || 'ok';
if (m === 'ok') process.exit(0);
if (m === 'no') process.exit(1);
if (m === 'down') { process.stdout.write('service unreachable'); process.exit(2); }
`);

// 假 `workflow` 命令：get-node 全表 / transition 节点流转 / list-state-required 必填。
// 状态机存 binDir/flow-state.json（story 链预设：started → 动态开发节点 →
// 测试环境部署 → 测试 → 结束；「确认进入开发」模板任务挂开发节点）。
writeFileSync(path.join(binDir, 'workflow'), `\
const fs = require('fs');
const file = require('path').join(${JSON.stringify(binDir)}, 'flow-state.json');
const DEFAULT = { nodes: [
  { key: 'started', name: '需求关键信息确认', status: 'doing' },
  { key: 'state_63', name: '报表导出开发', status: 'not_started', sub_tasks: [{ sub_task_id: 'st-9', sub_task_name: '确认进入开发', is_finished: false }] },
  { key: 'state_34', name: '测试环境部署', status: 'not_started' },
  { key: 'state_45', name: '测试', status: 'not_started' },
  { key: 'state_50', name: '结束', status: 'not_started' },
], subtask_calls: [], next_id: 100 };
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(DEFAULT);
const save = (s) => fs.writeFileSync(file, JSON.stringify(s));
const a = process.argv.slice(2); // workflow <sub> --flags…
const sub = a[0];
const val = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
const emit = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exit(code); };
if (sub === 'get-node') {
  const s = load();
  emit({ data: { list: s.nodes.map((n) => ({ basic: { node_key: n.key, name: n.name, status: n.status }, sub_tasks: n.sub_tasks ?? [] })) }, meta: {} });
}
if (sub === 'transition') {
  const s = load();
  const nk = val('node-id');
  const node = s.nodes.find((n) => n.key === nk);
  if (!node || node.status !== 'doing') emit({ data: null, error: { code: 'PARAM_INVALID', message: 'node not doing: ' + nk }, meta: {} }, 1);
  if (process.env.FAKE_TRANSITION_FAIL === nk || s.fail_until_fixed === nk) emit({ data: null, error: { code: 'PARAM_INVALID', message: 'required fields missing on ' + nk }, meta: {} }, 1);
  node.status = 'finished';
  const idx = s.nodes.indexOf(node);
  const next = s.nodes[idx + 1];
  // hold = story 链语义（R4 实测 7131581708）：流转后下一节点不自动 doing——
  // 勾入口任务（认领）才激活；缺省 = tech 链自动串行
  if (next && next.status === 'not_started' && process.env.FAKE_TRANSITION_NEXT !== 'hold') next.status = 'doing';
  save(s);
  emit({ data: { ok: true }, meta: {} });
}
if (sub === 'list-state-required') {
  // FAKE_REQUIRED_JSON = 结构化形状（autoFill 消费：node_fields{field_key,finished,
  // not_finished_owner}/tasks{task_id,finished}）；__by_key__ = 按节点区分清单
  //（future 前置探查用例——cur 全满足/未来节点缺）；缺省字符串拆分（describeRequired 展示）
  if (process.env.FAKE_REQUIRED_JSON) {
    const j = JSON.parse(process.env.FAKE_REQUIRED_JSON);
    if (j.__by_key__) emit({ data: j.__by_key__[val('state-key')] ?? {}, meta: {} });
    else emit({ data: j, meta: {} });
  }
  const fields = (process.env.FAKE_REQUIRED_FIELDS || '负责人(multi-user)、节点结论(select)').split('、');
  emit({ data: fields.map((name) => ({ name })), meta: {} });
}
if (sub === 'update-node') {
  const s = load();
  (s.update_node_calls ?? (s.update_node_calls = [])).push(a.filter((x) => !x.startsWith('--format') && !x.startsWith('--envelope')));
  // BQL 语义模拟：补了节点结论（标准字段或 owners 复合通道）且值在该节点合法集
  // → 流转拒绝标记解除（结论填对即触发流转）。R4c 教训：值不在选项集=无效值
  //（写 success 不报错但不触发流转）——FAKE_CONCLUSION_VALID=节点合法值 id 列表
  //（缺省全合法）
  try {
    const fs2 = JSON.parse(val('fields') || '[]');
    const concl = fs2.find((f) => f.field_key === 'node_finished_conclusion')
      ?? fs2.find((f) => f.field_key === 'owners_finished_info' && String(f.field_value).includes('conclusion'));
    if (concl) {
      const v = concl.field_key === 'node_finished_conclusion' ? concl.field_value
        : (JSON.parse(concl.field_value)[Object.keys(JSON.parse(concl.field_value))[0]][0].field_value);
      const valid = (process.env.FAKE_CONCLUSION_VALID || '').split(',').filter(Boolean);
      if (!valid.length || valid.includes(v)) delete s.fail_until_fixed;
    }
  } catch {}
  save(s);
  emit({ data: { ok: true }, meta: {} });
}
if (sub === 'meta-node-fields') {
  // 按 --field-keys 请求的字段名回选项集（owners 变体与标准结论字段不同集）
  let key = 'node_finished_conclusion';
  try { key = JSON.parse(val('field-keys') || '["node_finished_conclusion"]')[0]; } catch {}
  const opts = key === 'owners_node_finished_conclusion'
    ? [{ option_id: 'system_passed', option_name: '已通过' }, { option_id: 'system_not_passed', option_name: '未通过' }]
    : [{ option_id: 'system_passed', option_name: '已通过' }, { option_id: 'gyb3oa3ic', option_name: '已部署' }, { option_id: '9889lb2u4', option_name: '发布成功' }];
  emit({ data: { list: [{ field_key: key, options: opts }] }, meta: {} });
}
process.exit(0);
`);

// 假 `workitem` 命令：get → 属性形状（v1.0.23 实测）；update → 记录调用（autoFill
// form_items 补齐通道断言用——与 workflow/subtask 共享 flow-state.json）
writeFileSync(path.join(binDir, 'workitem'), `\
const fs = require('fs');
const file = require('path').join(${JSON.stringify(binDir)}, 'flow-state.json');
const emit = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exit(code); };
if (process.argv[2] === 'update') {
  const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { nodes: [] };
  (s.workitem_calls ?? (s.workitem_calls = [])).push(process.argv.slice(2));
  fs.writeFileSync(file, JSON.stringify(s));
  // select 试探（R4c 分支⑤转述增强）：__probe__ 值 → 服务端校验报错内嵌
  // field_name（真实形状 ErrnoFailedToCheckField——CLI 从 message 正则提取）
  const a = process.argv.slice(2);
  const i = a.indexOf('--fields');
  if (i >= 0 && String(a[i + 1]).includes('__probe__')) {
    emit({ data: null, error: { code: 'SERVER_CALL_FAILED', message: 'error=ErrnoFailedToCheckField,message=Failed to check field,{"field_key":"field_x9","field_name":"是否需要配置告警及监控机制","inner_err":"invalid select option(s): __probe__"}' } }, 1);
  }
  emit({ data: { ok: true }, meta: {} });
}
// FAKE_TEMPLATE_ID：get 输出附 template {id,name}（R5 实测形状——真实 workitem get
// 返回全量属性含 work_item_attribute.template；--fields 过滤不生效属真实现状）
emit({ data: { work_item_attribute: { work_item_name: '报表导出', work_item_type: { key: 'story' }, ...(process.env.FAKE_TEMPLATE_ID ? { template: { id: Number(process.env.FAKE_TEMPLATE_ID), name: 'fake-template' } } : {}) } }, meta: {} });
`);

// 假 `subtask` 命令：记录调用参数（断言 --node-id/--task-id/--fields）+ create 发号。
// 状态与 workflow 共享 flow-state.json（真实远端语义：create 后任务挂 doing 节点、
// 回读可见；fallback 链与 workflow DEFAULT 同款——不许写空表毁节点链）。
writeFileSync(path.join(binDir, 'subtask'), `\
const fs = require('fs');
const file = require('path').join(${JSON.stringify(binDir)}, 'flow-state.json');
const DEFAULT = { nodes: [
  { key: 'started', name: '需求关键信息确认', status: 'doing' },
  { key: 'state_63', name: '报表导出开发', status: 'not_started', sub_tasks: [{ sub_task_id: 'st-9', sub_task_name: '确认进入开发', is_finished: false }] },
  { key: 'state_34', name: '测试环境部署', status: 'not_started' },
  { key: 'state_45', name: '测试', status: 'not_started' },
  { key: 'state_50', name: '结束', status: 'not_started' },
], subtask_calls: [], next_id: 100 };
const s = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(DEFAULT);
const a = process.argv.slice(2);
const val = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : undefined; };
const emit = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\\n'); process.exit(code); };
s.subtask_calls.push(a.filter((x) => !x.startsWith('--format') && !x.startsWith('--envelope')));
if (val('action') === 'create') {
  const id = 'st-' + (s.next_id++);
  let title = '';
  try { title = JSON.parse(val('fields') || '[]').find((f) => f.field_key === 'name')?.field_value ?? ''; } catch {}
  const doing = s.nodes.find((n) => n.status === 'doing');
  if (doing) (doing.sub_tasks ?? (doing.sub_tasks = [])).push({ sub_task_id: id, sub_task_name: title, is_finished: false });
  fs.writeFileSync(file, JSON.stringify(s));
  emit({ data: { sub_task_id: id }, meta: {} });
}
if (val('action') === 'confirm' || val('action') === 'rollback') {
  // R4 story 激活语义：confirm 入口任务 → 所属 not_started 节点转 doing（认领）
  const node = s.nodes.find((n) => n.key === val('node-id'));
  const task = node?.sub_tasks?.find((t) => t.sub_task_id === val('task-id'));
  if (task) task.is_finished = val('action') === 'confirm';
  if (node && val('action') === 'confirm' && node.status === 'not_started') node.status = 'doing';
  fs.writeFileSync(file, JSON.stringify(s));
  emit({ data: { ok: true }, meta: {} });
}
fs.writeFileSync(file, JSON.stringify(s));
emit({ data: { ok: true }, meta: {} });
`);

const { runMeegle, meegleAuthStatus, meegleLoginHandshake } = await import('../cli/src/meegle/runner.js');
const { createRealCore } = await import('../cli/src/meegle/real.js');
const { SdlcError } = await import('../cli/src/errors.js');

test.after(() => {
  process.chdir(prevCwd);
  delete process.env.FAKE_MEEGLE_MODE;
  delete process.env.FAKE_AUTH_MODE;
  delete process.env.FAKE_TRANSITION_FAIL;
  delete process.env.FAKE_REQUIRED_FIELDS;
  delete process.env.FAKE_REQUIRED_JSON;
  delete process.env.SDLC_NO_BROWSER;
  delete process.env.SDLC_MEEGLE_TIMEOUT_MS;
  if (prevBin === undefined) delete process.env.SDLC_MEEGLE_BIN; else process.env.SDLC_MEEGLE_BIN = prevBin;
  rmSync(binDir, { recursive: true, force: true });
});

/** chdir 到 bin 目录（node 裸名入口按 cwd 解析）+ 设 mode 跑 runMeegle */
async function fake(mode, args = ['user', 'me']) {
  process.env.FAKE_MEEGLE_MODE = mode;
  process.chdir(binDir);
  return runMeegle(args);
}

test('信封解析：exit 0 → data；多行 stdout 取最后一行 JSON', async () => {
  const r = await fake('ok');
  assert.deepEqual(r.data, { user_key: 'u1' });
  const multi = await fake('multiline');
  assert.deepEqual(multi.data, { x: 1 });
});

test('错误域映射：AUTH_REQUIRED → unauthorized（logid 留痕）；PARAM_INVALID → validation_failed', async () => {
  await assert.rejects(
    () => fake('auth'),
    (e) => e instanceof SdlcError && e.code === 'unauthorized' && e.message.includes('logid=L2'),
  );
  await assert.rejects(
    () => fake('param'),
    (e) => e instanceof SdlcError && e.code === 'validation_failed',
  );
});

test('exit 2 → external_unavailable（retryable 语义）', async () => {
  await assert.rejects(
    () => fake('retryable'),
    (e) => e instanceof SdlcError && e.code === 'external_unavailable',
  );
});

test('输出不可解析（exit 1 非 JSON / stderr）→ external_unknown 不盲重发', async () => {
  await assert.rejects(
    () => fake('garbage'),
    (e) => e instanceof SdlcError && e.code === 'external_unknown' && e.message.includes('不可解析'),
  );
  await assert.rejects(
    () => fake('stderr-1'),
    (e) => e instanceof SdlcError && e.code === 'external_unknown' && e.message.includes('boom'),
  );
});

test('exit 0 无信封 → data:null（部分元命令，调用方各自容错）', async () => {
  const r = await fake('empty0');
  assert.equal(r.data, null);
});

test('超时（SDLC_MEEGLE_TIMEOUT_MS）→ external_unknown（结果未知）', async () => {
  process.env.SDLC_MEEGLE_TIMEOUT_MS = '200';
  await assert.rejects(
    () => fake('sleep'),
    (e) => e instanceof SdlcError && e.code === 'external_unknown' && e.message.includes('超时'),
  );
});

test('ENOENT：BIN 不存在 → external_unavailable + 安装提示', async () => {
  const prev = process.env.SDLC_MEEGLE_BIN;
  process.env.SDLC_MEEGLE_BIN = path.join(binDir, 'no-such-bin');
  try {
    await assert.rejects(
      () => runMeegle(['user', 'me']),
      (e) => e instanceof SdlcError && e.code === 'external_unavailable' && e.message.includes('未安装'),
    );
  } finally {
    process.env.SDLC_MEEGLE_BIN = prev;
  }
});

test('meegleAuthStatus：exit 0 → authenticated；1 → false；2 → external_unavailable', async () => {
  process.chdir(binDir);
  process.env.FAKE_AUTH_MODE = 'ok';
  assert.deepEqual(await meegleAuthStatus(), { authenticated: true });
  process.env.FAKE_AUTH_MODE = 'no';
  const st = await meegleAuthStatus();
  assert.equal(st.authenticated, false);
  assert.ok(st.reason);
  process.env.FAKE_AUTH_MODE = 'down';
  await assert.rejects(
    () => meegleAuthStatus(),
    (e) => e instanceof SdlcError && e.code === 'external_unavailable' && e.message.includes('不可达'),
  );
});

// ---------- real 通道（假 workflow/workitem/subtask 命令；cwd=binDir 裸名解析） ----------

const STORY_CONFIG = {
  schema_version: 5,
  feishu: {
    project_key: 'dida',
    profiles: {
      story: {
        work_item_type_key: 'story',
        stage_nodes: {
          prd: { node_key: 'started', entry_tasks: [] },
          dev: { node_key: '*开发', entry_tasks: ['确认进入开发'] },
          test: { node_key: 'state_45', entry_tasks: [] },
        },
        terminal: { node_key: 'state_50' },
      },
    },
  },
};

/** 重置假流程状态（每个用例独立链）并返回 real core。 */
function freshReal() {
  rmSync(path.join(binDir, 'flow-state.json'), { force: true });
  process.chdir(binDir);
  process.env.SDLC_NO_BROWSER = '1'; // 防真实开浏览器
  // 前序 runner 用例残留的 FAKE_MEEGLE_MODE/超时会污染 splitTasks 内的 user me
  //（R4 断言 --assignee 时暴露：sleep 残留 → user me 静默失败 → 不带负责人）
  delete process.env.FAKE_MEEGLE_MODE;
  delete process.env.SDLC_MEEGLE_TIMEOUT_MS;
  return createRealCore({ config: STORY_CONFIG });
}

/** 读取假 subtask 命令收到的调用记录。 */
const subtaskCalls = () => {
  const s = JSON.parse(readFileSync(path.join(binDir, 'flow-state.json'), 'utf8'));
  return s.subtask_calls ?? [];
};

/** 读取假 update-node 收到的调用记录。 */
const updateNodeCalls = () => {
  const s = JSON.parse(readFileSync(path.join(binDir, 'flow-state.json'), 'utf8'));
  return s.update_node_calls ?? [];
};

test('real：名称模式匹配——`*开发` 命中动态开发节点（readState 定位 dev）', async () => {
  const core = freshReal();
  const st = await core.requirementState('7130936375');
  assert.equal(st.title, '报表导出');
  assert.ok(st.tasks.some((t) => t.title === '确认进入开发' && t.id === 'st-9' && t.state === 'open'));
  // 初始链：started doing → current_stage = prd
  assert.equal(st.current_stage, 'prd');
});

test('real：node_key 数组映射（R4 卡点#14）——中间节点（如 tech 链技术评审/测试环境部署）算同阶段，不再 null 拦 handoff', async () => {
  freshReal();
  // 直接写流程状态：started/开发 finished，state_34（测试环境部署）doing——
  // 「追赶路径中间节点 doing」现场（get-node 只读不落盘，须手工构造）
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'finished' },
    { key: 'state_63', name: '报表导出开发', status: 'finished', sub_tasks: [{ sub_task_id: 'st-9', sub_task_name: '确认进入开发', is_finished: true }] },
    { key: 'state_34', name: '测试环境部署', status: 'doing' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100 }));
  const config = {
    ...STORY_CONFIG,
    feishu: {
      ...STORY_CONFIG.feishu,
      profiles: {
        story: {
          ...STORY_CONFIG.feishu.profiles.story,
          stage_nodes: {
            // 数组：state_34（测试环境部署，追赶路径中间节点）算 prd 阶段尾节点
            prd: { node_key: ['started', 'state_34'], entry_tasks: [] },
            dev: { node_key: '*开发', entry_tasks: ['确认进入开发'] },
            test: { node_key: 'state_45', entry_tasks: [] },
          },
        },
      },
    },
  };
  const st = await createRealCore({ config }).requirementState('7130936375');
  assert.equal(st.current_stage, 'prd'); // state_34 doing 经数组映射归入 prd（原实现返回 null）
  assert.equal(st.doingNode?.key, 'state_34'); // doingNode 暴露（handoff 放行判定用）
  // 数组混模式：`*开发` 元素按名称后缀匹配（同一数组的模式语义不丢）
  const cfg2 = structuredClone(config);
  cfg2.feishu.profiles.story.stage_nodes.prd.node_key = ['started', '*环境部署'];
  assert.equal((await createRealCore({ config: cfg2 }).requirementState('7130936375')).current_stage, 'prd');
});

test('real：追赶推进 prd→test——连续 confirm 中间节点（开发/测试环境部署）直到目标落位', async () => {
  const core = freshReal();
  const r = await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' });
  assert.equal(r.idempotent, false);
  assert.equal(r.node_status, 'finished');
  const st = await core.requirementState('7130936375');
  assert.equal(st.current_stage, 'test'); // state_45 doing
  // started/开发/测试环境部署全部 finished（未推进的前置节点自动补推）
  const s = JSON.parse(readFileSync(path.join(binDir, 'flow-state.json'), 'utf8'));
  assert.deepEqual(
    s.nodes.filter((n) => ['started', 'state_63', 'state_34', 'state_45'].includes(n.key)).map((n) => n.status),
    ['finished', 'finished', 'finished', 'doing'],
  );
});

test('real：追赶推进幂等——目标已落位不重发（他人已推进）', async () => {
  const core = freshReal();
  await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'dev', profile: 'story' });
  const r = await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'dev', profile: 'story' });
  assert.equal(r.idempotent, true);
});

test('real：追赶遇节点必填缺失——懒查 list-state-required 升级消息（不代填伪数据）', async () => {
  const core = freshReal();
  process.env.FAKE_TRANSITION_FAIL = 'state_34'; // 测试环境部署节点流转被拒
  try {
    await assert.rejects(
      () => core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' }),
      (e) => e instanceof SdlcError && e.code === 'validation_failed'
        && e.message.includes('负责人(multi-user)') && e.message.includes('节点结论(select)')
        && e.message.includes('测试环境部署'),
    );
  } finally {
    delete process.env.FAKE_TRANSITION_FAIL;
  }
});

test('real：story 链激活（R4 实测 7131581708）——流转后节点不自动 doing，勾入口任务认领转 doing', async () => {
  const core = freshReal();
  process.env.FAKE_TRANSITION_NEXT = 'hold'; // story 语义：流转后下一节点 not_started
  try {
    const r = await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'dev', profile: 'story', entryTasks: ['确认进入开发'] });
    assert.equal(r.idempotent, false);
    const s = JSON.parse(readFileSync(path.join(binDir, 'flow-state.json'), 'utf8'));
    const devNode = s.nodes.find((n) => n.key === 'state_63');
    assert.equal(devNode.status, 'doing'); // 入口任务勾选激活（非 transition 自动串行）
    assert.equal(devNode.sub_tasks.find((t) => t.sub_task_id === 'st-9').is_finished, true);
    const confirm = subtaskCalls().find((c) => c.includes('confirm'));
    assert.equal(confirm[confirm.indexOf('--task-id') + 1], 'st-9');
    assert.equal(confirm[confirm.indexOf('--node-id') + 1], 'state_63');
    // 无入口任务（entryTasks 空）→ 维持「无进行中节点」错误不猜
    const core2 = freshReal();
    await assert.rejects(
      () => core2.advanceStage({ reqId: '7130936375', from: 'prd', to: 'dev', profile: 'story' }),
      (e) => e instanceof SdlcError && e.code === 'validation_failed' && e.message.includes('无进行中节点'),
    );
  } finally {
    delete process.env.FAKE_TRANSITION_NEXT;
  }
});

test('real：profileByTable 节点集自适应（R4b 7131600756）——同 type key 多套流程模板按映射命中数选 profile', async () => {
  freshReal();
  // story2 流程模板节点集（doing/Content开发/…/end，与 story 链 started/…/state_50 互斥）
  writeFileSync(path.join(binDir, 'flow-state.json'), JSON.stringify({ nodes: [
    { key: 'doing', name: '需求关键信息确认', status: 'finished' },
    { key: 'state_15', name: 'Content开发', status: 'doing', sub_tasks: [{ sub_task_id: 'st-15', sub_task_name: '确认进入开发', is_finished: false }] },
    { key: 'state_11', name: '系统权限确认', status: 'not_started' },
    { key: 'state_40', name: '部署测试环境', status: 'not_started' },
    { key: 'state_9', name: '系统发布', status: 'not_started' },
    { key: 'state_10', name: 'UAT验收', status: 'not_started' },
    { key: 'end', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 200 }));
  const config = {
    ...STORY_CONFIG,
    feishu: { ...STORY_CONFIG.feishu, profiles: {
      story: STORY_CONFIG.feishu.profiles.story,
      story2: {
        work_item_type_key: 'story', // 同 type key（profileByType 区分不了）
        stage_nodes: {
          prd: { node_key: 'doing', entry_tasks: [] },
          dev: { node_key: '*开发', entry_tasks: ['确认进入开发'] },
          test: { node_key: 'state_40', entry_tasks: [] },
        },
        terminal: { node_key: 'end' },
      },
    } },
  };
  const st = await createRealCore({ config }).requirementState('7131600756');
  assert.equal(st.profile, 'story2');   // doing/state_40/end 命中 5 分 vs story 1 分（仅 *开发）
  assert.equal(st.current_stage, 'dev'); // state_15「Content开发」doing 经模式匹配归 dev
  // 反向：story 链节点表（DEFAULT）→ story 胜出（节点集互斥的另一侧）
  freshReal();
  const st2 = await createRealCore({ config }).requirementState('7130936375');
  assert.equal(st2.profile, 'story');
  assert.equal(st2.current_stage, 'prd');
});

test('real：模板 id 直查 profile（R5 PMO 预置）——template_id 命中优先于节点集打分', async () => {
  freshReal();
  process.env.FAKE_TEMPLATE_ID = '2633577'; // story DiDa 模板（workitem get 读到）
  try {
    const config = {
      ...STORY_CONFIG,
      feishu: { ...STORY_CONFIG.feishu, profiles: {
        story: { ...STORY_CONFIG.feishu.profiles.story, template_id: '3312019' },
        story2: {
          template_id: '2633577', work_item_type_key: 'story',
          stage_nodes: {
            prd: { node_key: 'doing', entry_tasks: [] },
            dev: { node_key: '*开发', entry_tasks: ['确认进入开发'] },
            test: { node_key: 'state_40', entry_tasks: [] },
          },
          terminal: { node_key: 'end' },
        },
      } },
    };
    // 节点表 = story 链（started/…/state_50）——纯打分 story 必胜；template 直查
    // 2633577 → story2 覆盖打分（判定链优先级：直查 > 打分）
    const st = await createRealCore({ config }).requirementState('7130936375');
    assert.equal(st.profile, 'story2');
    // template 读不到（无 FAKE_TEMPLATE_ID）→ 回退打分 → story 胜（现有链路行为不变）
    delete process.env.FAKE_TEMPLATE_ID;
    const st2 = await createRealCore({ config }).requirementState('7130936375');
    assert.equal(st2.profile, 'story');
  } finally {
    delete process.env.FAKE_TEMPLATE_ID;
  }
});

test('real：流转被拒自动补齐（R4b BQL 三成因）——结论/按人估分补齐后重试流转到目标', async () => {
  const core = freshReal();
  // state_34「测试环境部署」BQL 拒（结论未填）+ 估分排期缺失——结论补对即过
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'doing' },
    { key: 'state_63', name: '报表导出开发', status: 'not_started', sub_tasks: [{ sub_task_id: 'st-9', sub_task_name: '确认进入开发', is_finished: false }] },
    { key: 'state_34', name: '测试环境部署', status: 'not_started' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100, fail_until_fixed: 'state_34' }));
  process.env.FAKE_REQUIRED_JSON = JSON.stringify({
    form_items: [{ class: 'field', field_type_key: 'date', finished: false, key: 'field_x1' }],
    node_fields: [
      { field_key: 'node_finished_conclusion' },
      { field_key: 'point', finished: false, not_finished_owner: ['u1'] },
    ],
    tasks: [],
  });
  try {
    const r = await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' });
    assert.equal(r.node_status, 'finished');
    const st = await core.requirementState('7130936375');
    assert.equal(st.current_stage, 'test'); // 补齐后重试流转成功，state_45 doing
    const calls = updateNodeCalls();
    // 结论：部署节点启发式 →「已部署」（动态选项集按名取 id，非 system 前缀空间 id）
    const concl = calls.find((c) => JSON.stringify(c).includes('node_finished_conclusion'));
    const fields = JSON.parse(concl[concl.indexOf('--fields') + 1]);
    assert.deepEqual(fields, [{ field_key: 'node_finished_conclusion', field_value: 'gyb3oa3ic' }]);
    // 估分排期：任务级通道（R4d 破译：任务带估分/排期→节点总估分/总排期自动汇总；
    // update-node --schedules=假通道弃）——无子任务节点创建默认执行任务
    const stCalls = subtaskCalls();
    const createCall = stCalls.find((c) => c.includes('create') && JSON.stringify(c).includes('测试执行'));
    assert.ok(createCall, `未找到默认执行任务创建调用：${JSON.stringify(stCalls)}`);
    const cf = JSON.parse(createCall[createCall.indexOf('--fields') + 1]);
    assert.deepEqual(cf, [{ field_key: 'name', field_value: '测试执行' }, { field_key: 'points', field_value: '1' }]);
    assert.equal(createCall[createCall.indexOf('--node-id') + 1], 'state_34');
    const sched = JSON.parse(createCall[createCall.indexOf('--schedule') + 1]);
    assert.ok(sched.estimate_end_date > sched.estimate_start_date); // 排期今日~+1 天
    // 需求实体级必填（form_items date）：workitem update --fields 通道（R4b 实测
    // 7131432757/7131600756 交付计划完成日期，字段 key 随模板不同不可写死）
    const wiCalls = JSON.parse(readFileSync(path.join(binDir, 'flow-state.json'), 'utf8')).workitem_calls ?? [];
    const dateCall = wiCalls.find((c) => JSON.stringify(c).includes('field_x1'));
    const wiFields = JSON.parse(dateCall[dateCall.indexOf('--fields') + 1]);
    assert.equal(wiFields[0].field_key, 'field_x1');
    assert.ok(Number(wiFields[0].field_value) > Date.now()); // 默认今日 +7 天
  } finally {
    delete process.env.FAKE_REQUIRED_JSON;
  }
});

test('real：流转被拒自动补齐——节点下未完成子任务（owner 空/含我）代勾，他人任务停转述', async () => {
  const core = freshReal();
  // state_63 开发节点挂两个未完成任务（无主 + 他人）→ BQL 拒
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'doing' },
    { key: 'state_63', name: '报表导出开发', status: 'not_started', sub_tasks: [
      { sub_task_id: 'st-9', sub_task_name: '确认进入开发', is_finished: false },
      { sub_task_id: 'st-20', sub_task_name: '无主任务', is_finished: false },
      { sub_task_id: 'st-21', sub_task_name: '他人任务', is_finished: false, owner: JSON.stringify([{ username: 'u-other' }]) },
    ] },
    { key: 'state_34', name: '测试环境部署', status: 'not_started' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100, fail_until_fixed: 'state_63' }));
  process.env.FAKE_REQUIRED_JSON = JSON.stringify({
    node_fields: [],
    tasks: [{ task_id: 'st-20', finished: false }, { task_id: 'st-21', finished: false }],
  });
  try {
    await assert.rejects(
      () => core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' }),
      (e) => e instanceof SdlcError && e.code === 'validation_failed'
        && e.message.includes('他人任务') && e.message.includes('负责人'),
    );
    // 无主任务已代勾（--node-id = 任务归属节点）；他人任务不代勾（转述停）
    const confirms = subtaskCalls().filter((c) => c.includes('confirm'));
    assert.equal(confirms.filter((c) => c.includes('st-20')).length, 1);
    assert.equal(confirms.filter((c) => c.includes('st-21')).length, 0);
    const c20 = confirms.find((c) => c.includes('st-20'));
    assert.equal(c20[c20.indexOf('--node-id') + 1], 'state_63');
  } finally {
    delete process.env.FAKE_REQUIRED_JSON;
  }
});

test('real：流转被拒自动补齐——owners 复合结论字段（R4c story2 state_10）按人分桶走 owners_finished_info 通道', async () => {
  const core = freshReal();
  // started 节点 BQL 拒：owners_node_finished_conclusion 未填（not_finished_owner=u1）
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'doing' },
    { key: 'state_63', name: '报表导出开发', status: 'not_started' },
    { key: 'state_34', name: '测试环境部署', status: 'not_started' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100, fail_until_fixed: 'started' }));
  process.env.FAKE_REQUIRED_JSON = JSON.stringify({
    node_fields: [{ field_key: 'owners_node_finished_conclusion', field_type_key: 'select', finished: false, not_finished_owner: ['u1'] }],
    tasks: [],
  });
  try {
    const r = await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' });
    assert.equal(r.node_status, 'finished');
    // 复合通道：field_key=owners_finished_info（直写子字段名不落地——R4c 实测），
    // field_value=JSON 字符串按人分桶 {u1:[{field_key,field_type,field_value}]}
    const calls = updateNodeCalls();
    const compound = calls.find((c) => JSON.stringify(c).includes('owners_finished_info'));
    assert.ok(compound, '未走复合字段通道');
    const fields = JSON.parse(compound[compound.indexOf('--fields') + 1]);
    assert.equal(fields[0].field_key, 'owners_finished_info');
    assert.equal(typeof fields[0].field_value, 'string'); // 复合值必须序列化（MCP 校验 field_value 必须 string）
    const bucket = JSON.parse(fields[0].field_value);
    assert.deepEqual(bucket.u1, [{ field_key: 'owners_node_finished_conclusion', field_type: 'select', field_value: 'system_passed' }]);
  } finally {
    delete process.env.FAKE_REQUIRED_JSON;
  }
});

test('real：流转被拒自动补齐——结论值不在节点合法集（R4c 教训：无效 select 值写 success 不触发流转）候选轮换到合法值', async () => {
  const core = freshReal();
  // state_34「测试环境部署」结论未填；FAKE_CONCLUSION_VALID 限定唯一合法值「发布成功」
  // ——服务端 BQL 语义模拟：启发式首选项「已部署」与次选「已通过」均无效（写
  // success 但流转仍拒），第三轮换到合法值即流转成功
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'doing' },
    { key: 'state_63', name: '报表导出开发', status: 'not_started' },
    { key: 'state_34', name: '测试环境部署', status: 'not_started' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100, fail_until_fixed: 'state_34' }));
  process.env.FAKE_REQUIRED_JSON = JSON.stringify({
    node_fields: [{ field_key: 'node_finished_conclusion', field_type_key: 'select', finished: false }],
    tasks: [],
  });
  process.env.FAKE_CONCLUSION_VALID = '9889lb2u4';
  try {
    const r = await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' });
    assert.equal(r.node_status, 'finished');
    const st = await core.requirementState('7130936375');
    assert.equal(st.current_stage, 'test');
    // 轮换序列：启发式名「已部署」→ system_passed「已通过」→「发布成功」（合法值，
    // 解除流转拒绝）——无效值不重填（tried 按候选 id 记）
    const conclCalls = updateNodeCalls().filter((c) => JSON.stringify(c).includes('node_finished_conclusion'));
    const values = conclCalls.map((c) => JSON.parse(c[c.indexOf('--fields') + 1])[0].field_value);
    assert.deepEqual(values, ['gyb3oa3ic', 'system_passed', '9889lb2u4']);
  } finally {
    delete process.env.FAKE_REQUIRED_JSON;
    delete process.env.FAKE_CONCLUSION_VALID;
  }
});

test('real：流转被拒自动补齐——cur 必填全满足仍拒时前置补未来节点结论（R4c story2 state_9 拒因 state_10）', async () => {
  const core = freshReal();
  // started（cur）清单全满足；state_45（未来/测试节点）缺 owners 结论——BQL 条件在未来节点
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'doing' },
    { key: 'state_63', name: '报表导出开发', status: 'not_started' },
    { key: 'state_34', name: '测试环境部署', status: 'not_started' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100, fail_until_fixed: 'started' }));
  process.env.FAKE_REQUIRED_JSON = JSON.stringify({ __by_key__: {
    started: { node_fields: [{ field_key: 'owner', field_type_key: 'multi-user', finished: true }], tasks: [] },
    state_45: { node_fields: [{ field_key: 'owners_node_finished_conclusion', field_type_key: 'select', finished: false, not_finished_owner: ['u1'] }], tasks: [] },
  } });
  try {
    const r = await core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' });
    assert.equal(r.node_status, 'finished');
    // 前置补齐发生在未来节点（--node-id state_45）——复合通道解除流转拒绝
    const compound = updateNodeCalls().find((c) => JSON.stringify(c).includes('owners_finished_info'));
    assert.ok(compound);
    assert.equal(compound[compound.indexOf('--node-id') + 1], 'state_45');
  } finally {
    delete process.env.FAKE_REQUIRED_JSON;
  }
});

test('real：流转被拒自动补齐——select 类 form_items 试探报错取字段名转述（R4c field_0c456c）', async () => {
  const core = freshReal();
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'doing' },
    { key: 'state_63', name: '报表导出开发', status: 'not_started' },
    { key: 'state_34', name: '测试环境部署', status: 'not_started' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100, fail_until_fixed: 'started' }));
  process.env.FAKE_REQUIRED_JSON = JSON.stringify({
    form_items: [{ class: 'field', field_type_key: 'select', finished: false, key: 'field_x9' }],
    node_fields: [{ field_key: 'owner', field_type_key: 'multi-user', finished: true }],
    tasks: [],
  });
  try {
    await assert.rejects(
      () => core.advanceStage({ reqId: '7130936375', from: 'prd', to: 'test', profile: 'story' }),
      (e) => e instanceof SdlcError && e.code === 'validation_failed'
        && e.message.includes('是否需要配置告警及监控机制') && e.message.includes('field_x9'),
    );
    // 试探调用发生（__probe__ 无效值触发服务端校验报错——不写入）
    const wiCalls = JSON.parse(readFileSync(path.join(binDir, 'flow-state.json'), 'utf8')).workitem_calls ?? [];
    assert.ok(wiCalls.some((c) => JSON.stringify(c).includes('__probe__')));
  } finally {
    delete process.env.FAKE_REQUIRED_JSON;
  }
});

test('real：splitTasks 创建挂当前 doing 节点（--node-id + --fields name）；单次回读幂等复用', async () => {
  const core = freshReal();
  const r = await core.splitTasks({ reqId: '7130936375', tasks: [{ id: 'T1', title: '接口重构', assignee_role: 'dev' }] });
  assert.equal(r.items[0].result, 'created');
  assert.equal(r.items[0].remote_id, 'st-100');
  const calls = subtaskCalls().filter((c) => c.includes('create'));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--node-id'));
  assert.ok(calls[0].includes('--fields'));
  const fields = JSON.parse(calls[0][calls[0].indexOf('--fields') + 1]);
  assert.deepEqual(fields, [{ field_key: 'name', field_value: '接口重构' }]);
  // R4：自动设当前用户为负责人（user me 假命令 → u1）；无 estimate 不带排期/估分
  assert.equal(calls[0][calls[0].indexOf('--assignee') + 1], '["u1"]');
  assert.ok(!calls[0].includes('--schedule'));
  // 同名重放 → already_exists（不再 create）
  const again = await core.splitTasks({ reqId: '7130936375', tasks: [{ id: 'T1', title: '接口重构', assignee_role: 'dev' }] });
  assert.equal(again.items[0].result, 'already_exists');
  assert.equal(subtaskCalls().filter((c) => c.includes('create')).length, 1);
});

test('real：splitTasks 带 estimate——排期毫秒时间戳 + 估分字段（R4）', async () => {
  const core = freshReal();
  await core.splitTasks({ reqId: '7130936375', tasks: [{ id: 'T1', title: '带估分任务', assignee_role: 'dev', estimate: 3 }] });
  const call = subtaskCalls().find((c) => c.includes('create'));
  const fields = JSON.parse(call[call.indexOf('--fields') + 1]);
  assert.deepEqual(fields[1], { field_key: 'points', field_value: '3' }); // 估分键默认 points（可配 feishu.estimate_field_key）
  const schedule = JSON.parse(call[call.indexOf('--schedule') + 1]);
  const day = (v) => new Date(v).setHours(0, 0, 0, 0);
  assert.equal(day(schedule.estimate_start_date), day(Date.now()));
  assert.equal(schedule.estimate_end_date - schedule.estimate_start_date, 3 * 86_400_000); // 今日 + 3 人天
});

test('real：checkTasks 勾选用 --task-id + --node-id（任务所属节点）', async () => {
  const core = freshReal();
  const r = await core.checkTasks({ reqId: '7130936375', items: [{ id: 'T-entry', title: '确认进入开发', state: 'completed' }] });
  assert.equal(r.items[0].result, 'completed');
  assert.equal(r.items[0].remote_id, 'st-9');
  const call = subtaskCalls().find((c) => c.includes('confirm'));
  assert.ok(call, 'confirm 调用发生');
  assert.equal(call[call.indexOf('--task-id') + 1], 'st-9');
  assert.equal(call[call.indexOf('--node-id') + 1], 'state_63'); // 任务挂在开发节点
});

test('real：入口任务不代勾（R4d 链 1 教训）——节点下仅入口任务未勾时停转述「先拆任务」，不放走节点', async () => {
  const core = freshReal();
  // 链 1 事故还原：dev 节点 doing，流转被拒，节点下只有入口任务「确认进入开发」
  //（open，无开发子任务）——旧 ③会代勾入口任务 → BQL 任务全完成 → 节点被放走
  //（后建任务无人勾）。新强控：不勾入口任务，stop 转述先拆任务
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'finished' },
    { key: 'state_63', name: '报表导出开发', status: 'doing', sub_tasks: [{ sub_task_id: 'st-9', sub_task_name: '确认进入开发', is_finished: false }] },
    { key: 'state_34', name: '测试环境部署', status: 'not_started' },
    { key: 'state_45', name: '测试', status: 'not_started' },
    { key: 'state_50', name: '结束', status: 'not_started' },
  ], subtask_calls: [], next_id: 100, fail_until_fixed: 'state_63' }));
  process.env.FAKE_REQUIRED_JSON = JSON.stringify({
    node_fields: [],
    tasks: [{ task_id: 'st-9', finished: false }],
  });
  try {
    await assert.rejects(
      core.advanceStage({ reqId: '7130936375', from: 'dev', to: 'test', profile: 'story' }),
      (e) => {
        assert.equal(e.code, 'validation_failed');
        assert.match(e.message, /先拆分任务|入口任务/);
        return true;
      },
    );
    // 强控核心：入口任务未被代勾（无 confirm 调用）
    assert.ok(!subtaskCalls().some((c) => c.includes('confirm')), '入口任务不得被代勾');
  } finally {
    delete process.env.FAKE_REQUIRED_JSON;
  }
});

test('real：过冲达成（R4d 链 1）——流转直冲终态全 finished 无 doing 时视为达成，不误报「无进行中节点」', async () => {
  const core = freshReal();
  // 链 1 场景：流转一路直冲终态（全节点 finished、无 doing）；目标 test 映射节点
  // 不在表（targets 空）→ 旧代码 461 无 doing 直落「远端无进行中节点」误报
  const file = path.join(binDir, 'flow-state.json');
  writeFileSync(file, JSON.stringify({ nodes: [
    { key: 'started', name: '需求关键信息确认', status: 'finished' },
    { key: 'state_63', name: '报表导出开发', status: 'finished' },
    { key: 'state_34', name: '测试环境部署', status: 'finished' },
    { key: 'state_50', name: '结束', status: 'finished' },
  ], subtask_calls: [], next_id: 100 }));
  const r = await core.advanceStage({ reqId: '7130936375', from: 'test', to: 'test', profile: 'story' });
  assert.equal(r.node_status, 'finished');
  assert.equal(r.idempotent, true); // 幂等达成（终态 finished 即视为已推进）
});

test('登录链：--device-code init JSON 解析 + verification_uri_complete + poll 成功（R2 修复回归）', async () => {
  process.chdir(binDir);
  process.env.SDLC_NO_BROWSER = '1';
  let seenUrl = null;
  const r = await meegleLoginHandshake({ onUrl: (u) => { seenUrl = u; }, timeoutMs: 15_000 });
  assert.equal(r.ok, true);
  assert.equal(seenUrl, 'https://project.feishu.cn/authorize?code=UCOD'); // 直达链接优先
});
