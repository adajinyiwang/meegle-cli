// 分发定位（D53 §2.0）：dist = CLI 自身所在的分发仓库工作副本（~/.sdlc/dist）。
// SDLC_DIST 环境变量可覆盖（测试隔离）；缺省从模块路径推导（本文件在
// cli/src/ → 上两级 = dist 根）。开发安装（Dolphin 主仓内目录）不是独立分发
// 仓库——update 拒绝自更新，提示重跑 install.sh。
// 独立判定用 dist 下存在 .git（目录或 worktree 指针文件均可）——不用字符串
// 比较 git toplevel（Windows tmpdir 的 8.3 短路径与 git 长路径永不相等）。
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @returns {string} dist 根目录（env 覆盖或模块路径推导） */
export function distRoot() {
  return process.env.SDLC_DIST ? path.resolve(process.env.SDLC_DIST) : DEFAULT_DIST;
}

/**
 * dist 是否独立分发仓库（自身持有 .git——主仓内子目录的 .git 在主仓根，返回 false）。
 * @param {string} dist
 * @returns {boolean}
 */
export function isDistRepo(dist) {
  return existsSync(path.join(dist, '.git'));
}

/**
 * Claude Code 薄入口的 skill 名单（update 铺设/doctor 核验/install 循环共用）。
 * 每个对应 entries/claude/<name>/SKILL.md → ~/.claude/skills/<name>/SKILL.md。
 * login 不单出（凭据问题自动处理，D57）。
 */
export const CLAUDE_ENTRY_SKILLS = ['sdlc-init', 'sdlc-start', 'sdlc-next', 'sdlc-done', 'sdlc-status', 'sdlc-update'];
