// tasks.md 块解析：两段式任务文件的「飞书任务」粗任务块（契约 §8）。
// 只做解析与字段校验（tasks_parseable DoD 的依据）；真正调用同步接口前的
// 强校验属 I3——坏数据不下发。缺块/无任务只是提示，不是错误（模板注释语义）。
import { readFileSync } from 'node:fs';
import yaml from '../vendor/js-yaml/dist/js-yaml.mjs';

const BEGIN = '<!-- sdlc:tasks begin -->';
const END = '<!-- sdlc:tasks end -->';
const STATES = ['open', 'completed', 'cancelled'];

/**
 * @typedef {object} CoarseTask 契约 §8 粗任务
 * @property {string} id
 * @property {string} title
 * @property {string} assignee_role
 * @property {string} state   open/completed/cancelled（缺省 open）
 */

/**
 * @typedef {object} TasksParseResult
 * @property {boolean} found   是否存在 sdlc:tasks 块（缺失只是提示）
 * @property {CoarseTask[]} tasks  有错误时为空（不半解析）
 * @property {string[]} errors  字段/结构错误
 */

/**
 * 解析 tasks.md 全文中的粗任务块。
 * @param {string} content
 * @returns {TasksParseResult}
 */
export function parseTasksBlock(content) {
  const errors = /** @type {string[]} */ ([]);
  const begin = content.indexOf(BEGIN);
  if (begin === -1) return { found: false, tasks: [], errors };
  const end = content.indexOf(END, begin);
  if (end === -1) return { found: true, tasks: [], errors: ['sdlc:tasks begin 后没有 end 标记'] };
  const block = content.slice(begin + BEGIN.length, end);
  const fence = block.match(/```ya?ml\r?\n([\s\S]*?)```/);
  if (!fence) return { found: true, tasks: [], errors: ['任务块内未找到 ```yaml 围栏'] };

  let parsed;
  try {
    parsed = yaml.load(fence[1]);
  } catch (e) {
    return { found: true, tasks: [], errors: [`任务块 YAML 解析失败：${/** @type {Error} */ (e).message}`] };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(/** @type {any} */ (parsed).tasks)) {
    return { found: true, tasks: [], errors: ['任务块 YAML 应为 { tasks: [...] }'] };
  }

  const seen = new Set();
  for (const t of /** @type {any[]} */ (/** @type {any} */ (parsed).tasks)) {
    const at = typeof t?.id === 'string' ? `T${t.id}` : '任务项';
    if (typeof t?.id !== 'string' || t.id.trim() === '') { errors.push(`${at}：id 缺失或非字符串`); continue; }
    if (seen.has(t.id)) { errors.push(`${at}：id 重复`); continue; }
    if (typeof t.title !== 'string' || t.title.trim() === '') errors.push(`${at}：title 缺失`);
    if (typeof t.assignee_role !== 'string' || t.assignee_role.trim() === '') errors.push(`${at}：assignee_role 缺失`);
    if (t.state !== undefined && !STATES.includes(t.state)) errors.push(`${at}：state 非法（${t.state}，仅 ${STATES.join('/')}）`);
    seen.add(t.id);
    if (t.estimate !== undefined && (typeof t.estimate !== 'number' || !(t.estimate > 0))) {
      errors.push(`${at}：estimate 应为正数（人天数，可选）`);
    }
  }
  if (errors.length > 0) return { found: true, tasks: [], errors };
  return {
    found: true,
    tasks: /** @type {any[]} */ (/** @type {any} */ (parsed).tasks).map((t) => ({
      id: t.id,
      title: t.title,
      assignee_role: t.assignee_role,
      state: t.state ?? 'open',
      // estimate 可选（人天数）：无/非法不带键——splitTasks 按 estimate>0 判定
      ...(typeof t.estimate === 'number' && t.estimate > 0 ? { estimate: t.estimate } : {}),
    })),
    errors,
  };
}

/**
 * @param {string} filePath tasks.md 路径（缺失视为无块——file_exists 缺口另行覆盖）
 * @returns {TasksParseResult}
 */
export function parseTasksFile(filePath) {
  try {
    return parseTasksBlock(readFileSync(filePath, 'utf8'));
  } catch {
    return { found: false, tasks: [], errors: [] };
  }
}
