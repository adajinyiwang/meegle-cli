// sdlc update（I5，D53 §2.1）：分发更新——fetch tags → 更新计划（当前→目标、
// 变更摘要、将覆盖清单、自定义差异提示）→ 确认 --apply：dist 内 git checkout
// <tag>（原子切换点）→ 重铺 shim/skill-core/薄入口（自定义内容不静默覆盖，
// --force 才覆盖）→ 自检（新版 CLI 可加载 + tag 就位；core/登录态不查——不可达
// 不算安装失败）→ 失败自动 checkout 回旧 ref 并重铺（不允许半新半旧）。
// --to <旧tag> 可降级；--tool 显式选择 IDE（缺省读 install 记录）。dist 非 git 仓
// / tag 不存在 / 工作区脏 → 拒绝不猜测。
// v5（D59）：登录链退役——认证移交 meegle，update 不再有 --login 转发。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runGit } from '../gitops.js';
import { SDLC_HOME, loadUserConfig, saveUserConfig, useMock } from '../config.js';
import { distRoot, isDistRepo, CLAUDE_ENTRY_SKILLS } from '../dist.js';
import { SdlcError } from '../errors.js';
import { ensureMeegleReady } from '../meegle/index.js';

/** shim 与 IDE 薄入口都在用户主目录（与 install.sh 同布局；USERPROFILE 走 os.homedir）。 */
const homeDir = () => os.homedir();

/**
 * 各铺设目标（相对 dist 的源 → 用户侧目的地）。qoder 为手动放置（M1 实测为准），
 * 不自动铺——列入提示。claude 为 6 个独立 skill（/sdlc-* 斜杠命令直达）。
 * @param {string} dist @param {string | null} tool
 * @returns {{src: string, dest: string, label: string}[]}
 */
function layoutTargets(dist, tool) {
  const targets = [
    { src: path.join(dist, 'skill-core.md'), dest: path.join(SDLC_HOME, 'skill-core.md'), label: '~/.sdlc/skill-core.md' },
  ];
  if (tool === 'claude') {
    for (const name of CLAUDE_ENTRY_SKILLS) {
      targets.push({
        src: path.join(dist, 'entries', 'claude', name, 'SKILL.md'),
        dest: path.join(homeDir(), '.claude', 'skills', name, 'SKILL.md'),
        label: `~/.claude/skills/${name}/SKILL.md`,
      });
    }
  }
  return targets;
}

/**
 * 单个目标的差异分类：absent（铺）/same（已是该版，跳过）/custom（内容与 dist 版
 * 不同——可能是旧版本升级后的正常差异，也可能是用户自定义；不静默覆盖）。
 * @param {string} dest @param {string} src
 * @returns {'absent' | 'same' | 'custom'}
 */
function diffKind(dest, src) {
  if (!existsSync(dest)) return 'absent';
  const a = readFileSync(dest, 'utf8');
  const b = existsSync(src) ? readFileSync(src, 'utf8') : '';
  return a === b ? 'same' : 'custom';
}

/**
 * dist 当前版本 ref：tag 精确匹配优先，非 tag 安装回落短 sha。
 * @param {string} dist
 * @returns {{ref: string, isTag: boolean}}
 */
function currentRef(dist) {
  const tag = runGit(['describe', '--tags', '--exact-match', 'HEAD'], dist);
  if (tag.ok && tag.stdout) return { ref: tag.stdout, isTag: true };
  const sha = runGit(['rev-parse', '--short', 'HEAD'], dist);
  if (!sha.ok) throw new SdlcError('validation_failed', `dist 内无 Git 提交（${dist}）`);
  return { ref: sha.stdout, isTag: false };
}

/** 最新 tag（git tag semver 降序首个；无 tag 返回 null）。 @param {string} dist */
function latestTag(dist) {
  const r = runGit(['tag', '--sort=-v:refname'], dist);
  if (!r.ok) return null;
  return r.stdout ? r.stdout.split('\n')[0].trim() : null;
}

/** tag 是否存在于本地。 @param {string} dist @param {string} tag */
const tagExists = (dist, tag) => runGit(['rev-parse', '--verify', `refs/tags/${tag}`], dist).ok;

/**
 * 重铺（checkout 后执行）：shim 无条件幂等重写；skill-core/薄入口按 checkout 前
 * 的差异预检决策——custom（用户自定义）未 --force 跳过不静默覆盖，absent/same
 * 为正常版本升级/降级直接写 dist 当前版。preKinds 缺省时现算（同批调用场景）。
 * @param {string} dist @param {string | null} tool
 * @param {{force?: boolean, preKinds?: Map<string, string>}} opts
 * @returns {{laid: string[], skipped: string[], overwritten: string[], notes: string[]}}
 */
function relayout(dist, tool, opts = {}) {
  const out = { laid: [], skipped: [], overwritten: [], notes: [] };
  // shim 无条件幂等重写（被删/被改都恢复）；Windows 下额外写 sdlc.cmd
  // （cmd/PowerShell 不执行 bash 脚本——PATH 加对也识别不了无扩展名 shim）
  const shimDir = path.join(homeDir(), 'bin');
  const shim = path.join(shimDir, 'sdlc');
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/usr/bin/env bash\nexec node "${path.join(dist, 'cli', 'bin', 'sdlc.js')}" "$@"\n`);
  out.laid.push(shim);
  if (process.platform === 'win32') {
    const cmd = path.join(shimDir, 'sdlc.cmd');
    writeFileSync(cmd, `@echo off\r\nnode "${path.join(dist, 'cli', 'bin', 'sdlc.js')}" %*\r\n`);
    out.laid.push(cmd);
  }
  for (const t of layoutTargets(dist, tool)) {
    const pre = opts.preKinds?.get(t.label) ?? diffKind(t.dest, t.src);
    if (pre === 'custom' && opts.force !== true) {
      out.skipped.push(`${t.label}（自定义差异未覆盖——加 --force 覆盖）`);
      out.notes.push(`${t.label} 与分发版不同：自定义或残留，未静默覆盖`);
      continue;
    }
    // absent/same（正常升级降级）或 --force：写 dist 当前版
    mkdirSync(path.dirname(t.dest), { recursive: true });
    writeFileSync(t.dest, readFileSync(t.src, 'utf8'));
    if (pre === 'custom') out.overwritten.push(t.label);
    else out.laid.push(t.label);
  }
  if (tool === 'qoder') {
    out.notes.push(`Qoder 入口为手动放置（机制 M1 实测）：${path.join(dist, 'entries', 'qoder', 'AGENT.md')}`);
  }
  if (tool) {
    const cfg = loadUserConfig();
    if (cfg.tool !== tool) saveUserConfig({ ...cfg, tool });
  }
  return out;
}

/**
 * 自检（§2.2 裁剪——core/登录态不查，不可达不算安装失败）：
 * 新版 CLI 可加载（spawn --version）+ checkout 就位（describe = 目标 tag）。
 * @param {string} dist @param {string} targetTag
 * @returns {{ok: boolean, detail: string}}
 */
function selfCheck(dist, targetTag) {
  const bin = path.join(dist, 'cli', 'bin', 'sdlc.js');
  const v = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 30_000 });
  if (v.status !== 0) {
    const firstErr = (v.stderr ?? '').split('\n').find(Boolean) ?? '';
    return { ok: false, detail: `新版 CLI 自检失败（exit ${v.status ?? 'signal'}${firstErr ? `：${firstErr}` : ''}）` };
  }
  const here = runGit(['describe', '--tags', '--exact-match', 'HEAD'], dist);
  if (!here.ok || here.stdout !== targetTag) {
    return { ok: false, detail: `dist 未就位于 ${targetTag}（实际 ${here.ok ? here.stdout : '非 tag'}）` };
  }
  return { ok: true, detail: v.stdout.trim() };
}

/**
 * apply 执行：校验干净 → checkout（原子点）→ 重铺 → 自检 → 失败回滚重铺。
 * @param {string} dist @param {string} target @param {string | null} tool
 * @param {Record<string, any>} opts
 * @returns {number}
 */
function runApply(dist, target, tool, opts) {
  const dirty = runGit(['status', '--porcelain'], dist);
  if (dirty.ok && dirty.stdout.trim() !== '') {
    throw new SdlcError('validation_failed', `dist 工作区不干净（${dirty.stdout.split('\n').filter(Boolean).length} 处改动）——先提交/清理再更新，不做猜测切换`);
  }
  const old = currentRef(dist);
  // 自定义差异预检在 checkout 前（此时 dist 文件 = 当前安装版——用户侧同版 =
  // 正常版本差异；不同版才是自定义，升级/降级都可正常重铺）
  const preKinds = new Map(layoutTargets(dist, tool).map((t) => [t.label, diffKind(t.dest, t.src)]));

  const co = runGit(['checkout', '--detach', target], dist);
  if (!co.ok) throw new SdlcError('external_unavailable', `checkout ${target} 失败：${co.stderr || co.stdout}`);

  const laid = relayout(dist, tool, { force: opts.force === true, preKinds });

  const check = selfCheck(dist, target);
  if (!check.ok) {
    console.error(`✗ 自检失败：${check.detail}`);
    const back = runGit(['checkout', '--detach', old.ref], dist);
    if (back.ok) {
      // 回旧版重铺（同一预检规则：自定义仍跳过，其余写回旧版——不允许半新半旧）
      relayout(dist, tool, { force: opts.force === true, preKinds });
      console.error(`已回滚至 ${old.ref} 并重铺旧版文件。请人工核对（分发 tag 内容异常）。`);
    } else {
      console.error(`⚠ 回滚失败（${back.stderr || back.stdout}）——dist 停留在 ${target}，请人工执行 git -C <dist> checkout ${old.ref}`);
    }
    return 1;
  }

  console.log(`✓ 更新完成（${old.ref} → ${target}，${check.detail}）`);
  for (const p of laid.laid) console.log(`  铺设/保持：${p}`);
  for (const p of laid.overwritten) console.log(`  ⚠ 覆盖自定义：${p}`);
  for (const p of laid.skipped) console.log(`  跳过：${p}`);
  for (const n of laid.notes) console.log(`  提示：${n}`);
  console.log('  自检：新版 CLI 可加载、dist 已就位于目标 tag（core/登录态不查——不可达不算安装失败）。');
  return 0;
}

/**
 * @param {Record<string, any>} opts  flags（to/tool/apply/force/json）
 * @returns {Promise<number>}
 */
export async function runUpdate(opts = {}) {
  const dist = distRoot();
  if (!existsSync(dist) || !isDistRepo(dist)) {
    console.error(`当前安装非独立分发仓库（${dist} 的 Git 根不是它自身——开发安装或目录布局异常）。`);
    console.error('自更新不可用：npm 分发下请执行 npm i -g @didatravel-jinyi/meegle@latest 后重跑 meegle install --no-auth 重铺薄入口与 skill-core。');
    return 1;
  }

  // fetch（远端不可达不阻塞——本地已有 tag 仍可计划/降级）
  const fetch = runGit(['fetch', '--tags', 'origin'], dist);
  if (!fetch.ok) console.log('⚠ 远端 fetch 失败（网络/凭据），以下基于本地已有 tag。');

  const cur = currentRef(dist);
  const target = typeof opts.to === 'string' && opts.to.trim() !== '' ? opts.to.trim() : latestTag(dist);
  if (!target) throw new SdlcError('validation_failed', 'dist 无任何 tag——先在分发仓库打 tag 再更新');
  if (target === cur.ref && opts.apply === undefined) {
    console.log(`已是最新（${cur.ref}${cur.isTag ? '' : '（HEAD 非 tag 安装）'}）。如需切换指定版本：sdlc update --to <tag> --apply。`);
    return 0;
  }
  if (!tagExists(dist, target)) {
    throw new SdlcError('validation_failed', `tag ${target} 不存在（本地与远端均无）——可先 sdlc update 查看 tag 列表`);
  }

  const tool = typeof opts.tool === 'string' && opts.tool !== '' ? opts.tool : loadUserConfig().tool ?? null;
  if (tool && !['claude', 'qoder'].includes(tool)) {
    throw new SdlcError('validation_failed', `未知 --tool：${tool}（支持 claude/qoder；codex 为 P1）`);
  }
  if (opts.apply !== undefined) {
    const rc = runApply(dist, target, tool, opts);
    // 更新后核查 meegle（R2：安装/授权与 init 同口径——一步到位；警告不阻塞更新结果）
    if (rc === 0 && !useMock()) {
      try {
        const ready = await ensureMeegleReady();
        if (ready.authenticated) console.log('  meegle：已就绪（安装 + 登录）。');
      } catch (e) {
        console.warn(`  ⚠ meegle 未就绪：${e instanceof SdlcError ? e.message : String(e)}——稍后 sdlc doctor 核查续做`);
      }
    }
    return rc;
  }

  // ---------- 预览 ----------
  const up = runGit(['merge-base', '--is-ancestor', cur.ref, target], dist);
  const direction = up.ok ? '升级' : '降级';
  const log = runGit(['log', '--oneline', `${cur.ref}..${target}`], dist);
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean) : [];
  // 自定义差异检测在 checkout 前（此时 dist 文件 = 当前版本）
  const layout = layoutTargets(dist, tool);
  const customs = layout
    .map((t) => ({ label: t.label, kind: diffKind(t.dest, t.src) }))
    .filter((d) => d.kind === 'custom');

  if (opts.json) {
    console.log(JSON.stringify({
      dist,
      current: cur.ref,
      current_is_tag: cur.isTag,
      target,
      direction,
      commits: commits.slice(0, 10),
      more_commits: Math.max(0, commits.length - 10),
      tool: tool ?? '(未选，跳过 IDE 薄入口)',
      override: ['~/bin/sdlc（shim，幂等重写）', ...(process.platform === 'win32' ? ['~/bin/sdlc.cmd（cmd/PowerShell 入口）'] : []), ...layout.map((t) => `${t.label} ← ${path.relative(dist, t.src)}`)],
      custom_diffs: customs.map((c) => c.label),
    }, null, 2));
    return 0;
  }
  console.log(`sdlc update —— 分发更新计划（${direction}）`);
  console.log(`  当前：${cur.ref}${cur.isTag ? '' : '（HEAD 非 tag——开发安装态，建议从 tag 安装）'}`);
  console.log(`  目标：${target}（dist：${dist}）`);
  if (commits.length > 0) {
    console.log('  变更摘要：');
    for (const c of commits.slice(0, 10)) console.log(`    ${c}`);
    if (commits.length > 10) console.log(`    …共 ${commits.length} 条`);
  } else {
    console.log('  变更摘要：（无提交差异——tag 指向同当前或历史分叉）');
  }
  console.log(`  IDE 薄入口：${tool ?? '(未选，跳过 IDE 薄入口)'}`);
  console.log('  将写入：');
  console.log('    ~/bin/sdlc（shim，幂等重写）');
  if (process.platform === 'win32') console.log('    ~/bin/sdlc.cmd（cmd/PowerShell 入口）');
  for (const t of layout) console.log(`    ${t.label} ← ${path.relative(dist, t.src)}`);
  if (customs.length > 0) {
    console.log('  ⚠ 自定义差异（不静默覆盖——确认覆盖加 --force）：');
    for (const c of customs) console.log(`    ${c.label}`);
  }
  console.log(`确认执行：sdlc update --to ${target} --apply${tool ? ` --tool ${tool}` : ''}${customs.length > 0 ? ' [--force]' : ''}`);
  return 0;
}
