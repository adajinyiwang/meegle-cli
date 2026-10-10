// 通用工具：哈希、稳定序列化、短 ID。
// 契约出处：sdlc-contract §6（plan_id/choices_hash 摘要语义）。
import { createHash, randomUUID } from 'node:crypto';

/** @param {string} s @returns {string} hex sha256 */
export function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * 深度键排序后的 JSON 序列化——同一结构内容产出稳定字符串，
 * 用作 config_revision / plan_id / choices_hash 的摘要输入。
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

/** @param {unknown} v @returns {unknown} */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = /** @type {Record<string, unknown>} */ ({});
    for (const k of Object.keys(/** @type {object} */ (v)).sort()) {
      out[k] = sortKeys(/** @type {Record<string, unknown>} */ (v)[k]);
    }
    return out;
  }
  return v;
}

/** @param {string} prefix @returns {string} 如 ex-a1b2c3d4 */
export function shortId(prefix) {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
