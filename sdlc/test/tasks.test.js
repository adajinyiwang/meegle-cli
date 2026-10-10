// tasks：粗任务块解析（契约 §8）。缺块 = 提示；YAML/字段错误 = errors（gap 依据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTasksBlock, parseTasksFile } from '../cli/src/tasks.js';

const BLOCK = (inner) => `# 任务文件\n\n前文\n\n<!-- sdlc:tasks begin -->\n\`\`\`yaml\n${inner}\n\`\`\`\n<!-- sdlc:tasks end -->\n\n后文\n`;

test('合法块：解析出粗任务，state 缺省 open', () => {
  const r = parseTasksBlock(BLOCK(`tasks:\n  - id: "1"\n    title: 梳理接口\n    assignee_role: dev\n  - id: "2"\n    title: 自测\n    assignee_role: dev\n    state: completed\n`));
  assert.equal(r.found, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.tasks, [
    { id: '1', title: '梳理接口', assignee_role: 'dev', state: 'open' },
    { id: '2', title: '自测', assignee_role: 'dev', state: 'completed' },
  ]);
});

test('缺 begin 块 → found:false 无错误（模板注释语义：仅提示）', () => {
  const r = parseTasksBlock('# 只有普通内容\n没有任务块\n');
  assert.deepEqual(r, { found: false, tasks: [], errors: [] });
});

test('有 begin 缺 end → 错误', () => {
  const r = parseTasksBlock('<!-- sdlc:tasks begin -->\n```yaml\ntasks: []\n```\n');
  assert.equal(r.found, true);
  assert.ok(r.errors.length === 1 && r.errors[0].includes('end'));
  assert.deepEqual(r.tasks, []);
});

test('块内无 yaml 围栏 → 错误', () => {
  const r = parseTasksBlock('<!-- sdlc:tasks begin -->\nplain text\n<!-- sdlc:tasks end -->\n');
  assert.equal(r.found, true);
  assert.ok(r.errors[0].includes('围栏'));
});

test('YAML 语法错误 → 错误（不半解析）', () => {
  const r = parseTasksBlock(BLOCK('tasks: [ broken\n  - }\n'));
  assert.equal(r.found, true);
  assert.ok(r.errors[0].includes('YAML 解析失败'));
  assert.deepEqual(r.tasks, []);
});

test('结构非 {tasks:[...]} → 错误', () => {
  const r = parseTasksBlock(BLOCK('items:\n  - a\n'));
  assert.ok(r.errors[0].includes('{ tasks: [...] }'));
});

test('字段错误：id 重复/缺失、title/assignee_role 缺失、state 非法 → errors 且 tasks 空', () => {
  const r = parseTasksBlock(BLOCK(`tasks:\n  - id: "1"\n    title: a\n    assignee_role: dev\n  - id: "1"\n    title: b\n    assignee_role: dev\n  - title: 无id\n    assignee_role: dev\n  - id: "3"\n    assignee_role: dev\n  - id: "4"\n    title: d\n    state: done\n`));
  const joined = r.errors.join('\n');
  assert.ok(joined.includes('id 重复'));
  assert.ok(joined.includes('id 缺失'));
  assert.ok(joined.includes('title 缺失'));
  assert.ok(joined.includes('assignee_role 缺失'));
  assert.ok(joined.includes('state 非法'));
  assert.deepEqual(r.tasks, []);
});

test('parseTasksFile：文件缺失 → found:false；文件读取正常解析', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sdlc-tasks-'));
  test.after(() => rmSync(tmp, { recursive: true, force: true }));
  assert.deepEqual(parseTasksFile(path.join(tmp, 'absent.md')), { found: false, tasks: [], errors: [] });
  const p = path.join(tmp, 'tasks.md');
  writeFileSync(p, BLOCK('tasks:\n  - id: "1"\n    title: t\n    assignee_role: qa\n'), 'utf8');
  const r = parseTasksFile(p);
  assert.equal(r.found, true);
  assert.deepEqual(r.tasks[0], { id: '1', title: 't', assignee_role: 'qa', state: 'open' });
});
