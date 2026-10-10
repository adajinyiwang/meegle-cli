// sdlc doctor：安装/环境自检（D53 §2.2 的命令形态）。meegle 不可达只标「未核实」，
// 不算失败（离线可装）；mock 模式标注 mock，不伪造「已验证」结论。
// v5（D59）：认证/连通移交 meegle-cli（auth status / user me）——凭据在 meegle
// keychain 托管，sdlc 不持有；旧 Dolphin 登录链随 I6c 退役。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadUserConfig, SDLC_HOME, useMock } from '../config.js';
import { runGit } from '../gitops.js';
import { createCore, meegleAuthStatus } from '../meegle/index.js';
import { distRoot, isDistRepo, CLAUDE_ENTRY_SKILLS } from '../dist.js';

/**
 * meegle 认证/连通检查（auth status + user me，runner.js 语义）：
 * exit 0 → 已认证；1 → 未登录（首次走登录交接）；2/超时 → 未核实。
 * @returns {Promise<{id: string, text: string, status: string}>}
 */
async function meegleAuthRow() {
  try {
    const st = await meegleAuthStatus();
    if (st.authenticated) {
      // 已认证：顺带核验 user me（连通性 + 身份可读）
      try {
        const core = createCore();
        const me = await core.me();
        return { id: 'meegle_auth', text: `meegle 已认证（user_key=${me.actor.actor_id}）`, status: 'ok' };
      } catch (e) {
        return { id: 'meegle_auth', text: `meegle 已认证但 user me 不可读（${e.message}）——形状未核实`, status: 'unknown' };
      }
    }
    return { id: 'meegle_auth', text: `meegle 未登录（${st.reason ?? '需授权'}）——需要凭据的命令会自动发起登录交接`, status: 'missing' };
  } catch (e) {
    return { id: 'meegle_auth', text: `meegle 认证状态未核实（${e.message}）`, status: 'unknown' };
  }
}

/**
 * 薄入口核验（D53 §2.2 铺设核验）：6 个 Claude skill（/sdlc-* 斜杠命令）全部
 * 就位且内容为分发版（或已确认的自定义差异——不算失败）；任一缺失 → fail 提示
 * 重铺。qoder 为手动放置（M1 实测），只提示不核验。
 * @param {any} cfg
 * @returns {{id: string, text: string, status: string}}
 */
function skillEntryRow(cfg) {
  const tool = cfg.tool;
  if (!tool) return { id: 'skill_entry', text: '未铺设 IDE 薄入口（install --tool / update --tool）', status: 'missing' };
  if (tool === 'qoder') {
    return { id: 'skill_entry', text: 'Qoder 入口为手动放置（AGENT.md，机制 M1 实测），不自动核验', status: 'unknown' };
  }
  const dist = distRoot();
  if (!isDistRepo(dist)) {
    return { id: 'skill_entry', text: `dist 非独立分发仓库（${dist}，开发安装）——薄入口比对跳过`, status: 'unknown' };
  }
  const home = os.homedir();
  const pairs = CLAUDE_ENTRY_SKILLS.map((name) => ({
    name,
    dest: path.join(home, '.claude', 'skills', name, 'SKILL.md'),
    src: path.join(dist, 'entries', 'claude', name, 'SKILL.md'),
  }));
  const missing = pairs.filter((p) => !existsSync(p.dest)).map((p) => p.name);
  if (missing.length > 0) {
    return { id: 'skill_entry', text: `Claude 薄入口缺失（${missing.join('、')}）——sdlc update --tool claude --apply 重铺`, status: 'fail' };
  }
  const diff = pairs.filter((p) => !(existsSync(p.src) && readFileSync(p.dest, 'utf8') === readFileSync(p.src, 'utf8'))).map((p) => p.name);
  return diff.length === 0
    ? { id: 'skill_entry', text: `Claude 薄入口（${CLAUDE_ENTRY_SKILLS.length} 个 skill）就位且为分发版`, status: 'ok' }
    : { id: 'skill_entry', text: `Claude 薄入口自定义差异（${diff.join('、')}——可接受，否则 sdlc update --force 覆盖）`, status: 'ok' };
}

/**
 * @param {{json?: boolean}} opts
 * @returns {Promise<number>} 退出码（检查失败 → 1）
 */
export async function runDoctor(opts = {}) {
  const rows = [];
  const push = (id, text, status) => rows.push({ id, text, status });

  // node ≥ 20
  const major = Number(process.versions.node.split('.')[0]);
  push('node', `node ${process.versions.node}`, major >= 20 ? 'ok' : 'fail');

  // git 可用
  const git = runGit(['--version'], process.cwd());
  push('git', git.ok ? git.stdout : 'git 不可用', git.ok ? 'ok' : 'fail');

  // ~/.sdlc 与用户配置（v5 只存 IDE 选择——凭据移交 meegle keychain）
  push('sdlc_home', `~/.sdlc（${SDLC_HOME}）`, existsSync(SDLC_HOME) ? 'ok' : 'missing');
  const cfg = loadUserConfig();
  push('tool', cfg.tool ? `已铺设薄入口：${cfg.tool}` : '未铺设 IDE 薄入口（install --tool）', 'ok');
  rows.push(skillEntryRow(cfg));

  // meegle 认证/连通（真实外部系统；mock 模式不查网络标注 mock）
  if (useMock()) {
    rows.push({ id: 'meegle_auth', text: 'mock 模式（SDLC_MOCK=1）——meegle 认证/连通性未核实', status: 'unknown' });
  } else {
    rows.push(await meegleAuthRow());
  }

  const failed = rows.some((r) => r.status === 'fail');
  if (opts.json) {
    console.log(JSON.stringify({ tool: 'sdlc-doctor', checks: rows }, null, 2));
  } else {
    console.log('sdlc doctor —— 自检');
    for (const r of rows) {
      const mark = r.status === 'ok' ? '✓' : r.status === 'fail' ? '✗' : '?';
      console.log(`  [${mark}] ${r.id}: ${r.text}`);
    }
  }
  return failed ? 1 : 0;
}
