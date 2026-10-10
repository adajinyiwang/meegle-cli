// meegle 适配层入口（I6a，D59）：createCore() 保持与旧 apiclient 同名方法面
//（command 层最小改动），真实通道 = meegle 子进程（real.js），mock 轨 =
// SDLC_MOCK=1 显式开启（config.useMock）。executions 端点语义退役：恢复 =
// 远端回读幂等（契约 §3.3 写前回读、结果未知不盲重发——门在适配层 gatedTransition）。
// 契约出处：meegle-contract §1/§2/§3；client-design §6（交互边界：只取所需
// 字段、对用户透明——登录 URL 转述是唯一例外）。
import { useMock } from '../config.js';
import { createMockCore } from './mock.js';
import { createRealCore } from './real.js';
import { meegleLoginHandshake, meegleAuthStatus, ensureMeegleReady } from './runner.js';

export { meegleLoginHandshake, meegleAuthStatus, ensureMeegleReady };

/**
 * @typedef {object} Core 面向 command 层的统一核心（真实/mock 同形）
 * @property {boolean} mock
 * @property {() => Promise<{actor: {actor_id: string}}>} me
 * @property {() => Promise<{authenticated: boolean, reason?: string}>} authStatus
 * @property {(reqId: string) => Promise<any>} requirementState
 * @property {(args: {reqId: string, from: string, to: string, entryTasks?: string[], profile?: string}) => Promise<any>} advanceStage
 * @property {(args: {reqId: string, from: string, to: string, reason?: string, profile?: string}) => Promise<any>} changeStage
 * @property {(args: {reqId: string, tasks: any[], tasksMap?: Record<string, string>}) => Promise<{items: any[]}>} splitTasks
 * @property {(args: {reqId: string, items: any[], tasksMap?: Record<string, string>}) => Promise<{items: any[]}>} checkTasks
 * @property {(args: {reqId: string, completion: any, profile?: string}) => Promise<any>} completeRequirement
 */

/**
 * @param {{config?: any, profile?: string}} [opts]  真实通道的仓库配置/profile 提示（缺省自 cwd 探测）
 * @returns {Core}
 */
export function createCore(opts = {}) {
  if (useMock()) return createMockCore(opts);
  return createRealCore(opts);
}
