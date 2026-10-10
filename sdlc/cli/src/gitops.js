// git 子进程封装（Windows/Git Bash 优先，D25）。
// git 事实只来自 git 命令输出；不偷偷 stash/reset/rebase（契约 §1/§5）。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * @typedef {object} GitResult
 * @property {boolean} ok
 * @property {string} stdout
 * @property {string} stderr
 */

/**
 * @param {string[]} args @param {string} cwd
 * @param {{raw?: boolean}} [opts] raw=true 不 trim stdout/stderr——逐行语义输出
 *   （如 porcelain 首行状态位的前导空格）不能丢，否则路径解析错位
 * @returns {GitResult}
 */
export function runGit(args, cwd, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) return { ok: false, stdout: '', stderr: String(r.error) };
  const t = (s) => (opts.raw ? s : (s ?? '').trim());
  return { ok: r.status === 0, stdout: t(r.stdout), stderr: t(r.stderr) };
}

/** @param {string} cwd @returns {string | null} git toplevel（非 git 仓返回 null） */
export function gitRoot(cwd) {
  const r = runGit(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? r.stdout : null;
}

/** @param {string} cwd @returns {string | null} 当前分支名（detached HEAD 返回 null） */
export function currentBranch(cwd) {
  const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!r.ok) return null;
  return r.stdout === 'HEAD' ? null : r.stdout;
}

/**
 * 从分支名解析需求：req/<id>-<slug> 或 feature/req/<id>-<slug>（契约 §2 命名）。
 * @param {string} branch
 * @returns {{reqId: string, slug: string} | null}
 */
export function parseReqFromBranch(branch) {
  const m = branch.match(/(?:^|\/)req\/(\d+)(?:-([^/]+))?$/);
  if (!m) return null;
  return { reqId: m[1], slug: m[2] ?? '' };
}

/** @param {string} cwd @returns {string | null} origin 远端仓库 slug（group/repo），无远端返回 null */
export function repoSlug(cwd) {
  const r = runGit(['remote', 'get-url', 'origin'], cwd);
  if (!r.ok) return null;
  // git@host:group/repo.git 或 https://host/group/repo.git
  const m = r.stdout.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

/**
 * origin 远端 → Web 基地址（https://host/group/repo），供 Codeup MR 创建链接
 * 拼装（D59 人工路径）。git@host:group/repo.git → https://host/group/repo。
 * @param {string} cwd @returns {string | null}
 */
export function repoWebUrl(cwd) {
  const r = runGit(['remote', 'get-url', 'origin'], cwd);
  if (!r.ok) return null;
  let url = r.stdout.trim();
  const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) url = `https://${ssh[1]}/${ssh[2]}`;
  if (!/^https?:\/\//.test(url)) return null;
  return url.replace(/\.git$/, '');
}

/**
 * @typedef {object} GitSyncState
 * @property {boolean} clean   工作区无未提交修改
 * @property {boolean} ahead   本地领先远端
 * @property {boolean} behind  本地落后远端
 * @property {string} raw      `git status -sb` 首行原文
 */

/** @param {string} cwd @returns {GitSyncState} */
export function branchSync(cwd) {
  const r = runGit(['status', '--short', '--branch'], cwd);
  const first = r.stdout.split('\n')[0] ?? '';
  const dirty = r.stdout.split('\n').slice(1).some((l) => l.trim() !== '');
  const ahead = first.includes('ahead');
  const behind = first.includes('behind');
  return { clean: !dirty, ahead, behind, raw: first };
}

/** @param {string} cwd @param {string} name @returns {boolean} */
export function hasBranch(cwd, name) {
  return runGit(['rev-parse', '--verify', `refs/heads/${name}`], cwd).ok;
}

/** @param {string} cwd @param {string} name @returns {boolean} 本地存在则切换，不存在则创建后切换 */
export function checkoutOrCreate(cwd, name) {
  if (hasBranch(cwd, name)) return runGit(['checkout', name], cwd).ok;
  return runGit(['checkout', '-b', name], cwd).ok;
}

/**
 * 提交指定文件（conventional message + Refs trailer 由 CLI 拼接，契约 §2：
 * 用户只传 subject）。I1 供 next 使用，start 不提交。
 * @param {string} cwd
 * @param {{files: string[], subject: string, reqId: string, type?: string, scope?: string}} input
 * @returns {GitResult}
 */
export function commitFiles(cwd, input) {
  if (input.files.length === 0) return { ok: true, stdout: 'nothing to commit (no files)', stderr: '' };
  const type = input.type ?? 'feat';
  const scope = input.scope ?? 'sdlc';
  const message = `${type}(${scope}): ${input.subject}\n\nRefs: ${input.reqId}`;
  const r = runGit(['add', '--', ...input.files], cwd);
  if (!r.ok) return r;
  return runGit(['commit', '-m', message], cwd);
}

/** @param {string} cwd @param {string} [branch] 缺省推当前分支 @returns {GitResult} */
export function pushBranch(cwd, branch) {
  const args = branch ? ['push', '-u', 'origin', branch] : ['push'];
  return runGit(args, cwd);
}

// ---------- next save 用的 git 事实助手（I2） ----------

/**
 * 脏文件清单（porcelain v1 解析，路径相对仓库根、/ 分隔）。
 * @param {string} cwd
 * @returns {{status: string, path: string}[] | null}  git 失败返回 null
 */
export function listDirtyFiles(cwd) {
  // raw：porcelain 首行状态位的前导空格有意义（trim 会吃掉导致路径错位）；
  // -uall：未跟踪目录展开为逐文件（否则 dir/ 条目会让 digest 读取目录崩）
  const r = runGit(['status', '--porcelain', '--untracked-files=all'], cwd, { raw: true });
  if (!r.ok) return null;
  return r.stdout.split('\n').filter((l) => l.trim() !== '').map((line) => {
    let p = line.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1]; // 重命名取新路径
    return { status: line.slice(0, 2), path: p.replace(/^"|"$/g, '') };
  });
}

/** @param {string} cwd @returns {string | null} HEAD sha（空仓/失败返回 null） */
export function headSha(cwd) {
  const r = runGit(['rev-parse', 'HEAD'], cwd);
  return r.ok ? r.stdout : null;
}

/** @param {string} filePath 绝对路径 @returns {string} 内容 sha256（plan_id 状态指纹用） */
export function fileDigest(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** 落后时快进同步（分叉/冲突不强推，失败如实上抛由调用方交用户处理）。 @param {string} cwd @returns {GitResult} */
export function pullFf(cwd) {
  return runGit(['pull', '--ff-only'], cwd);
}

/** 提交是否在当前分支历史上（恢复时核验本机事实，契约 §6）。 @param {string} cwd @param {string} sha @returns {boolean} */
export function commitInBranch(cwd, sha) {
  return runGit(['merge-base', '--is-ancestor', sha, 'HEAD'], cwd).ok;
}

/** 远端跟踪引用是否存在（push 完成事实：push -u 会建立 origin/<branch>）。 @param {string} cwd @param {string} branch @returns {boolean} */
export function remoteRefExists(cwd, branch) {
  return runGit(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], cwd).ok;
}

/** 跟踪文件的工作区差异（差异确认展示用；未跟踪文件返回空串，由调用方另行预览）。 @param {string} cwd @param {string} file @returns {string} */
export function diffForFile(cwd, file) {
  return runGit(['diff', 'HEAD', '--', file], cwd).stdout;
}
