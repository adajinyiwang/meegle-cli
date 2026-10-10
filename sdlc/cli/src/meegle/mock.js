// meegle 适配层 mock 轨（D52 mock 边界：文件态 db，语义与真实通道对齐——
// 先读后写 + 幂等门 + external_unknown 故障注入；结论不作为已验证）。
// 通道替换自 apiclient/mock.js（I6a）：执行意图/executions/PR 端点退役
//（v5：恢复 = 远端回读幂等，PR 走人工路径）；任务远端标识化（tasks_map 语义）。
// db 位置：SDLC_MOCK_STATE/db.json（测试隔离），缺省 ~/.sdlc/mock-state/db.json。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { SdlcError } from '../errors.js';
import { SDLC_HOME } from '../config.js';

const MOCK_ACTOR = 'usr-mock-dev';

const STATE_DIR = process.env.SDLC_MOCK_STATE
  ? path.resolve(process.env.SDLC_MOCK_STATE)
  : path.join(SDLC_HOME, 'mock-state');
const DB_PATH = path.join(STATE_DIR, 'db.json');

/** seed：与 v0.1.0 mock 同底本（登录流程重构 prd / 报表导出 dev + 入口任务），便于测试沿用 */
const DEFAULT_DB = {
  requirements: {
    7114275203: {
      req_id: '7114275203', title: '登录流程重构', url: 'https://project.feishu.cn/mock/req/7114275203',
      profile: 'story', current_stage: 'prd', stage_version: 1,
      participants: { product: [{ user_key: 'usr-mock-pm', name: 'Mock 产品' }], dev: [{ user_key: MOCK_ACTOR, name: 'Mock 开发' }], test: [{ user_key: 'usr-mock-qa', name: 'Mock 测试' }] },
      completion_status: 'pending', completion_source: null,
      tasks: [],
    },
    7220318456: {
      req_id: '7220318456', title: '报表导出', url: 'https://project.feishu.cn/mock/req/7220318456',
      profile: 'story', current_stage: 'dev', stage_version: 2,
      participants: { product: [{ user_key: 'usr-mock-pm', name: 'Mock 产品' }], dev: [{ user_key: MOCK_ACTOR, name: 'Mock 开发' }] },
      completion_status: 'pending', completion_source: null,
      tasks: [{ remote_id: 'st-entry-1', title: '确认进入开发', state: 'open' }],
    },
  },
  next_task_seq: 100,
};

function loadDb() {
  if (!existsSync(DB_PATH)) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeDb(DEFAULT_DB);
    return structuredClone(DEFAULT_DB);
  }
  try {
    const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
    return { ...structuredClone(DEFAULT_DB), ...db };
  } catch {
    throw new SdlcError('validation_failed', `mock db 解析失败：${DB_PATH}`);
  }
}

function writeDb(db) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2) + '\n', { encoding: 'utf8' });
}

/** 故障注入（测试用）：副作用落地后响应丢失（真实感 = external_unknown 不盲重发场景） */
function injectFlaky(action) {
  if (process.env.SDLC_MOCK_FLAKY_ACTION === action) {
    throw new SdlcError('external_unknown', `mock 故障注入：${action} 响应丢失（副作用已落地）——结果未知`);
  }
}

/** 故障注入：动作尚未执行即失败（无副作用——续做安全） */
function injectUnknown(action) {
  if (process.env.SDLC_MOCK_UNKNOWN_ACTION === action) {
    throw new SdlcError('external_unknown', `mock 故障注入：${action} 未执行即失败（无副作用）`);
  }
}

function mustReq(db, reqId) {
  const req = db.requirements[reqId];
  if (!req) throw new SdlcError('not_found', `需求 ${reqId} 不存在（mock db 无记录）`);
  return req;
}

/** 需求状态回读形状（与真实通道 requirementState 对齐——tasks 以远端标识为 id） */
function stateOf(req) {
  return {
    req_id: String(req.req_id),
    title: req.title,
    url: req.url,
    profile: req.profile,
    current_stage: req.current_stage,
    stage_version: req.stage_version,
    // real 通道 readState 的 doingNode 对齐（handoff 预览「无 doing 待认领」放行用）：
    // mock 无节点表——阶段即 doing，done/未识别 → null
    doingNode: req.current_stage && req.current_stage !== 'done' ? { key: String(req.current_stage), name: String(req.current_stage) } : null,
    participants: req.participants,
    participants_source: 'feishu',
    completion_status: req.completion_status,
    tasks: req.tasks.map(({ remote_id, title, state }) => ({ id: remote_id, title, state })),
  };
}

/**
 * 幂等门三步（meegle-contract §3.1）在 mock 的对齐实现：写前回读——
 * 已在目标阶段 → 幂等重放；仍在起点 → 推进；在别处 → 分歧（validation_failed，
 * 原 409 语义退役——v5 无乐观锁，先读后写 + 回读幂等）。
 * @param {any} req @param {string} from @param {string} to
 * @returns {{from_version: number, to_version: number, idempotent: boolean}}
 */
function gatedTransition(req, from, to) {
  if (req.current_stage === to) {
    return { from_version: req.stage_version - 1, to_version: req.stage_version, idempotent: true };
  }
  if (req.current_stage !== from) {
    throw new SdlcError(
      'validation_failed',
      `远端阶段 ${req.current_stage} 与计划起点 ${from} 不符（已被他人推进/回退）——请重新预览`,
      { remote_stage: req.current_stage },
    );
  }
  const fromVersion = req.stage_version;
  req.current_stage = to;
  req.stage_version = fromVersion + 1;
  return { from_version: fromVersion, to_version: req.stage_version, idempotent: false };
}

/**
 * @param {{}} [_opts] 预留（mock 不需要 config/profile）
 */
export function createMockCore(_opts = {}) {
  return {
    mock: true,

    async me() {
      return { actor: { actor_id: MOCK_ACTOR } };
    },

    async authStatus() {
      return { authenticated: true };
    },

    async requirementState(reqId) {
      return stateOf(mustReq(loadDb(), reqId));
    },

    async advanceStage({ reqId, from, to, entryTasks: _ignored }) {
      const db = loadDb();
      const req = mustReq(db, reqId);
      injectUnknown('advance');
      const r = gatedTransition(req, from, to);
      // 入口任务勾选不在此处（D48 v2：进入阶段后、需求子任务已创建——由
      // common.js tasks_split 动作拆分后勾选；语义与 real 通道对齐）
      writeDb(db);
      injectFlaky('advance');
      return { ...r, node_status: 'finished' };
    },

    async changeStage({ reqId, from, to }) {
      const db = loadDb();
      const req = mustReq(db, reqId);
      injectUnknown('change');
      const r = gatedTransition(req, from, to);
      writeDb(db);
      injectFlaky('change');
      return { ...r, node_status: 'finished' };
    },

    async splitTasks({ reqId, tasks }) {
      const db = loadDb();
      const req = mustReq(db, reqId);
      injectUnknown('tasks_split');
      const items = [];
      for (const t of tasks ?? []) {
        // 标题去重（v5：同名不是可靠的未创建证据——幂等复用）
        const existing = req.tasks.find((x) => x.title === t.title);
        if (existing) {
          items.push({ id: t.id, result: 'already_exists', remote_id: existing.remote_id });
          continue;
        }
        const remoteId = `st-${db.next_task_seq++}`;
        req.tasks.push({ remote_id: remoteId, title: t.title, state: 'open' });
        items.push({ id: t.id, result: 'created', remote_id: remoteId });
      }
      writeDb(db);
      injectFlaky('tasks_split');
      return { items };
    },

    async checkTasks({ reqId, items, tasksMap = {} }) {
      const db = loadDb();
      const req = mustReq(db, reqId);
      injectUnknown('tasks_check');
      const byRemote = new Map(req.tasks.map((t) => [t.remote_id, t]));
      const byTitle = new Map(req.tasks.map((t) => [t.title, t]));
      const out = [];
      for (const it of items ?? []) {
        // 解析顺序：显式 remote_id → tasks_map 映射 → 标题匹配（映射丢失回查重建）
        const task = (it.remote_id ? byRemote.get(it.remote_id) : undefined)
          ?? (tasksMap[it.id] ? byRemote.get(tasksMap[it.id]) : undefined)
          ?? (it.title ? byTitle.get(it.title) : undefined);
        if (!task) {
          out.push({ id: it.id, result: 'not_found', remote_id: null });
          continue;
        }
        const target = it.state === 'cancelled' ? 'cancelled' : 'completed';
        if (task.state === target) {
          out.push({ id: it.id, result: 'no_op', remote_id: task.remote_id });
          continue;
        }
        task.state = target;
        out.push({ id: it.id, result: target, remote_id: task.remote_id });
      }
      writeDb(db);
      injectFlaky('tasks_check');
      return { items: out };
    },

    async completeRequirement({ reqId, completion }) {
      const db = loadDb();
      const req = mustReq(db, reqId);
      injectUnknown('complete');
      // 幂等：已记录收尾 → 重放（恢复重跑不二次流转）
      if (req.completion_status && req.completion_status !== 'pending') {
        return { completion_status: req.completion_status, source: req.completion_source ?? 'api', idempotent: true };
      }
      // 飞书终态 = 终结点 transition（观察链 +1；已在 done 不重复计）
      if (req.current_stage !== 'done') {
        req.stage_version += 1;
        req.current_stage = 'done';
      }
      // 人工确认来源如实标注（m1-checklist：不把人工确认伪装 API 核实）
      req.completion_status = completion.source === 'manual'
        ? 'manual'
        : completion.result;
      req.completion_source = completion.source;
      writeDb(db);
      injectFlaky('complete');
      return { completion_status: req.completion_status, source: completion.source, idempotent: false };
    },
  };
}
