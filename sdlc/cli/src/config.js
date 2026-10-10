// 配置读取：仓库 .sdlc/config.yaml（schema 5）与用户级 ~/.sdlc/config。
// 契约出处：sdlc-contract §3（轻量配置/config_revision/未知 schema 不猜测）；
// client/design §2.0（用户级 config 只存 IDE 选择——D59：凭据移交 meegle
// keychain 托管，sdlc 不持有 core 地址/token，用户级 config 不再有凭据字段）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import yaml from '../vendor/js-yaml/dist/js-yaml.mjs';
import { SdlcError, SCHEMA_VERSION } from './errors.js';
import { sha256, canonical } from './util.js';
import { parseTasksFile } from './tasks.js';

/** 用户级目录 ~/.sdlc（SDLC_HOME 环境变量可覆盖——测试隔离用） */
export const SDLC_HOME = process.env.SDLC_HOME
  ? path.resolve(process.env.SDLC_HOME)
  : path.join(homedir(), '.sdlc');

/**
 * 用户级配置（JSON，非 YAML——不进 Git、不交给 LLM；v5 无凭据字段）。
 * @typedef {object} UserConfig
 * @property {string | null} tool   已铺设薄入口的 IDE（claude/qoder）
 */

/** @returns {UserConfig} */
export function loadUserConfig() {
  const p = path.join(SDLC_HOME, 'config');
  if (!existsSync(p)) return { tool: null };
  try {
    // 旧字段（core_url/token/auth）随登录链退役（I6c）——读取时静默丢弃不迁移
    const { tool = null } = JSON.parse(readFileSync(p, 'utf8'));
    return { tool };
  } catch {
    throw new SdlcError('validation_failed', `~/.sdlc/config 解析失败：${p}`);
  }
}

/** @param {UserConfig} cfg */
export function saveUserConfig(cfg) {
  mkdirSync(SDLC_HOME, { recursive: true });
  writeFileSync(path.join(SDLC_HOME, 'config'), JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8' });
}

/**
 * 是否走 mock（仅 SDLC_MOCK=1 显式开启——D52 mock 边界；v5 无「未配置 core 即
 * mock」隐式路径：真实通道恒为 meegle 子进程，未装/未登录按域码报错不静默降级）。
 */
export function useMock() {
  return process.env.SDLC_MOCK === '1';
}

/**
 * 从 cwd 向上查找已接入 sdlc 的仓库根（含 .sdlc/ 的目录）。
 * @param {string} cwd
 * @returns {string | null}
 */
export function findSdlcRoot(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, '.sdlc'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * @typedef {object} RepoConfig
 * @property {any} config       解析后的 config.yaml 对象
 * @property {string} configRevision  规范化内容摘要（契约 §3）
 * @property {string} root      仓库根
 */

/**
 * 读取仓库配置并校验 schema_version；未知版本不猜测（契约 §3；v5 无迁移承诺）。
 * @param {string} root 含 .sdlc 的仓库根
 * @returns {RepoConfig}
 */
export function loadRepoConfig(root) {
  const p = path.join(root, '.sdlc', 'config.yaml');
  let parsed;
  try {
    parsed = yaml.load(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new SdlcError('validation_failed', `config.yaml 解析失败：${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new SdlcError('validation_failed', 'config.yaml 内容为空或非对象');
  }
  if (parsed.schema_version !== SCHEMA_VERSION) {
    throw new SdlcError(
      'schema_unsupported',
      `不支持的 schema_version=${parsed.schema_version}（当前支持 ${SCHEMA_VERSION}），请通过 sdlc update 维护`,
    );
  }
  return { config: parsed, configRevision: sha256(canonical(parsed)), root };
}

/**
 * 按 config 的 stages 计算 DoD 检查（确定性子集：file_exists / tasks_parseable /
 * git_synced / pr_exists / pr_merged / report_current；其余 check 标 unknown，不猜测）。
 * @param {any} config
 * @param {string} reqDir   .sdlc/req-<id> 目录
 * @param {import('./gitops.js').GitSyncState} sync
 * @param {string} stageId
 * @param {{meta?: any, prState?: any}} [extra]   meta（pr_exists/report_current 判定）；prState 仅兼容旧签名保留（v5 恒 null——PR 状态不可回读）
 * @returns {{id: string, text: string, status: 'ok'|'gap'|'unknown', check: string|null, note?: string}[]}
 */
export function evaluateDod(config, reqDir, sync, stageId, extra = {}) {
  const meta = extra.meta ?? null;
  const prState = extra.prState ?? null;
  const stage = (config.stages ?? []).find(/** @param {any} s */ (s) => s.id === stageId);
  const items = stage?.dod ?? [];
  /** report.md 轻量字段行提取（D44 模板：- key: value；{{…}} 占位算未填）。 */
  const reportField = (reqDir2, rel, key) => {
    let text;
    try {
      text = readFileSync(path.join(reqDir2, rel), 'utf8');
    } catch {
      return { missing: true };
    }
    const m = text.match(new RegExp(`^- ${key}:\\s*(.*)$`, 'm'));
    const v = m ? m[1].trim().replace(/\s*<!--.*$/, '') : '';
    return { missing: false, value: v, unfilled: v === '' || v.startsWith('{{') };
  };
  return items.map(
    /** @param {any} d @returns {{id: string, text: string, status: string, check: string|null, note?: string}} */
    (d) => {
      const check = d.check ?? null;
      if (check === 'file_exists') {
        const ok = d.path ? existsSync(path.join(reqDir, d.path)) : false;
        return { id: d.id, text: d.text, status: ok ? 'ok' : 'gap', check };
      }
      if (check === 'git_synced') {
        const ok = !sync.behind && !sync.ahead && sync.clean;
        return { id: d.id, text: d.text, status: ok ? 'ok' : 'gap', check };
      }
      if (check === 'tasks_parseable') {
        // 缺块/无任务只是提示（模板语义）；解析/字段错误才是 gap（契约 §8）
        const r = d.path ? parseTasksFile(path.join(reqDir, d.path)) : null;
        if (!r) return { id: d.id, text: d.text, status: 'unknown', check };
        if (r.errors.length > 0) return { id: d.id, text: d.text, status: 'gap', check, note: r.errors.join('；') };
        return { id: d.id, text: d.text, status: 'ok', check, note: r.found ? undefined : '未使用任务块（仅提示）' };
      }
      if (check === 'pr_exists') {
        // 本地判定：meta.pr_ref（meta 缺上下文标 unknown，不猜测）
        if (!meta) return { id: d.id, text: d.text, status: 'unknown', check };
        return { id: d.id, text: d.text, status: meta.pr_ref ? 'ok' : 'gap', check, note: meta.pr_ref ? undefined : 'PR 未创建' };
      }
      if (check === 'pr_merged') {
        if (!meta) return { id: d.id, text: d.text, status: 'unknown', check };
        if (!meta.pr_ref) return { id: d.id, text: d.text, status: 'gap', check, note: 'PR 未创建' };
        // v5（D59 无 Codeup API 凭据）：合并事实不可回读——核实来源只有人工确认
        //（done --manual-confirm pr_merged）与已落收尾记录；未确认 = 未核实不猜
        const done = typeof meta.completion_status === 'string' && meta.completion_status !== 'pending';
        if (done) return { id: d.id, text: d.text, status: 'ok', check, note: `收尾记录 completion=${meta.completion_status}（PR 合并经人工确认）` };
        return { id: d.id, text: d.text, status: 'unknown', check, note: '未核实（PR 状态不可回读——done --manual-confirm pr_merged 人工确认）' };
      }
      if (check === 'report_current') {
        // 薄实现（D44）：轻量字段行提取——文件缺/未填/过期 → gap 待复核，不判内容
        if (!meta || !d.path) return { id: d.id, text: d.text, status: 'unknown', check };
        const round = reportField(reqDir, d.path, 'test_round');
        if (round.missing) return { id: d.id, text: d.text, status: 'gap', check, note: '报告未创建' };
        const notes = [];
        const rv = round.value ?? '';
        if (rv !== String(meta.test_round ?? '')) notes.push(rv === '' || rv.startsWith('{{') ? 'test_round 未填' : `test_round 过期（报告 ${rv}，meta ${meta.test_round ?? '?'}）`);
        for (const key of ['requirement_version', 'code_ref', 'result']) {
          const f = reportField(reqDir, d.path, key);
          if (!f.missing && f.unfilled) notes.push(`${key} 未填`);
        }
        if (notes.length > 0) return { id: d.id, text: d.text, status: 'gap', check, note: `${notes.join('；')}，待复核` };
        return { id: d.id, text: d.text, status: 'ok', check };
      }
      // 无 check 或未实现的 check 类型：unknown 不猜测
      return { id: d.id, text: d.text, status: 'unknown', check };
    },
  );
}
