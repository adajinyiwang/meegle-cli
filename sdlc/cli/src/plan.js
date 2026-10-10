// 确认计划：plan_id 状态指纹 + 人读/机读双模式输出。
// 契约出处：sdlc-contract §6（plan/execution/choices 分工）；client/design §3.0
//（Skill 拼装、plan 外候选 CLI 拒绝）；§7（plan 展示过的候选才可 apply）。
// 预览时存档到 ~/.sdlc/plans/<plan_id>.json（非版本化本地，同 executions 语义）——
// next 的 apply 从存档做状态分解（D39 差异确认），不再重推导比对。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { sha256, canonical } from './util.js';
import { SDLC_HOME } from './config.js';

/**
 * @typedef {object} PlanAction
 * @property {string} id           稳定动作 id（如 checkout/create_branch/init_dir）
 * @property {string} title        人读描述
 * @property {Record<string, unknown>} [args]
 */

/**
 * @typedef {object} PlanState 状态指纹输入（D39：相关状态进 plan_id；next save 用）
 * @property {string} req_id
 * @property {string} repo
 * @property {string} branch
 * @property {string} head_sha
 * @property {string} sync_raw    `git status -sb` 首行原文（绑定精确 ahead/behind 计数）
 * @property {{path: string, digest: string}[]} files  选中文件清单 + 内容摘要
 * @property {string[]} [scope_all]  预览时完整默认范围（files 被 --files 收窄时用于区分收窄/新增）
 * @property {string} config_revision
 * @property {string} stage
 * @property {number} stage_version
 */

/**
 * @typedef {object} Plan
 * @property {string} plan_id      sha256(canonical(敏感字段))，展示给用户确认
 * @property {string} req_id
 * @property {string} title
 * @property {string} [url]
 * @property {string} [repo]
 * @property {string} [branch]
 * @property {string} intent      用户意图转述（I1: 常为空）
 * @property {PlanAction[]} actions
 * @property {string[]} gaps       已识别缺口（--accept-gaps 候选）
 * @property {{slot: string, candidates: string[], chosen: string | null}[]} slots
 *   候选槽位（--to/--tasks 等，I1 主要用于 target repo/branch）
 * @property {string[]} facts      非敏感事实（指纹不含）
 * @property {PlanState} [state]   状态指纹输入（提供时参与 plan_id 哈希）
 */

/**
 * @param {object} input
 * @param {string} input.reqId
 * @param {string} input.title
 * @param {string} [input.url]
 * @param {string} [input.repo]
 * @param {string} [input.branch]
 * @param {string} [input.intent]
 * @param {PlanAction[]} input.actions
 * @param {string[]} [input.gaps]
 * @param {{slot: string, candidates: string[], chosen: string | null}[]} [input.slots]
 * @param {string[]} [input.facts]
 * @param {PlanState} [input.state]
 * @returns {Plan}
 */
export function buildPlan(input) {
  const sensitive = /** @type {Record<string, unknown>} */ ({
    actions: input.actions ?? [],
    gaps: input.gaps ?? [],
    slots: input.slots ?? [],
  });
  if (input.state !== undefined) sensitive.state = input.state;
  return {
    plan_id: sha256(canonical(sensitive)),
    req_id: input.reqId,
    title: input.title,
    url: input.url ?? null,
    repo: input.repo ?? null,
    branch: input.branch ?? null,
    intent: input.intent ?? '',
    ...sensitive,
    facts: input.facts ?? [],
  };
}

const PLANS_DIR = path.join(SDLC_HOME, 'plans');

/** 预览时存档（apply 侧状态分解的数据源）。 @param {Plan} plan */
export function savePlan(plan) {
  mkdirSync(PLANS_DIR, { recursive: true });
  writeFileSync(path.join(PLANS_DIR, `${plan.plan_id}.json`), JSON.stringify(plan, null, 2) + '\n', { encoding: 'utf8' });
}

/** @param {string} planId @returns {Plan | null} 本机无存档返回 null */
export function loadPlan(planId) {
  const p = path.join(PLANS_DIR, `${planId}.json`);
  if (!existsSync(p) || !/^[0-9a-f]{64}$/.test(planId)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** @param {Plan} plan @returns {string} markdown 人读计划（展示给用户确认） */
export function renderPlan(plan) {
  const lines = [];
  lines.push(`# SDLC 执行计划`);
  lines.push('');
  lines.push(`- 需求：${plan.req_id} ${plan.title}`);
  if (plan.url) lines.push(`- 链接：${plan.url}`);
  if (plan.repo) lines.push(`- 仓库：${plan.repo}`);
  if (plan.branch) lines.push(`- 分支：${plan.branch}`);
  if (plan.intent) lines.push(`- 意图：${plan.intent}`);
  lines.push(`- plan_id：${plan.plan_id}`);
  lines.push('');
  lines.push('## 动作');
  plan.actions.forEach((a, i) => lines.push(`${i + 1}. [${a.id}] ${a.title}`));
  if (plan.state?.files?.length) {
    lines.push('');
    lines.push('## 确认文件范围（内容摘要入指纹，改动走差异确认）');
    plan.state.files.forEach((f) => lines.push(`- ${f.path}（${f.digest.slice(0, 8)}）`));
  }
  if (plan.slots.length > 0) {
    lines.push('');
    lines.push('## 候选槽位');
    for (const s of plan.slots) {
      const chosen = s.chosen !== null ? `（选中：${s.chosen}）` : '';
      lines.push(`- ${s.slot}: ${s.candidates.join(' | ')}${chosen}`);
    }
  }
  if (plan.gaps.length > 0) {
    lines.push('');
    lines.push('## 已识别缺口');
    plan.gaps.forEach((g) => lines.push(`- ${g}`));
  }
  if (plan.facts.length > 0) {
    lines.push('');
    lines.push('## 参考（不影响指纹）');
    plan.facts.forEach((f) => lines.push(`- ${f}`));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * apply 侧指纹校验：CLI 只接受 plan 展示过的内容（client/design §3.0）。
 * （start 绑定链用重推导比对；next save 用存档状态分解，不走本函数。）
 * @param {Plan} plan
 * @returns {string} 应等于展示时的 plan_id
 */
export function planFingerprint(plan) {
  const sensitive = /** @type {Record<string, unknown>} */ ({
    actions: plan.actions,
    gaps: plan.gaps,
    slots: plan.slots,
  });
  if (plan.state !== undefined) sensitive.state = plan.state;
  return sha256(canonical(sensitive));
}
