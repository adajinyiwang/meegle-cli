// 命令分发、参数解析、退出码出口。参数手写解析（命令少、flags 固定）。
// v5（D59）：登录链退役——认证移交 meegle（keychain 托管）；未登录时
// 自动发起 meegle 登录交接（授权 URL 转述是唯一例外，client-design §6）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SdlcError, exitCodeOf } from './errors.js';
import { runInit } from './command/init.js';
import { runStart } from './command/start.js';
import { runStatus } from './command/status.js';
import { runDoctor } from './command/doctor.js';
import { runUpdate } from './command/update.js';
import { runDone } from './command/done.js';
import { runNext } from './command/next.js';
import { meegleLoginHandshake } from './meegle/index.js';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const VERSION = (() => {
  try {
    return readFileSync(path.join(PKG_ROOT, 'VERSION'), 'utf8').trim();
  } catch {
    return '0.0.0-unknown';
  }
})();

const USAGE = `sdlc — AI SDLC 客户端（v${VERSION}）

用法：
  sdlc doctor                          环境/安装/认证自检（meegle auth status + user me）
  sdlc init [--apply]                  仓库接入（预览差异 → 确认写 .sdlc/）
  sdlc start [<URL|id>] [--apply <plan_id>]  进入需求（无参=恢复/分流）
  sdlc status [<req_id>]               只读快照
  sdlc next [<req_id>] [--intent save|handoff] 保存/交接
        save：确认产物 commit → push → 发布流程记录（阶段末尾带待合并提醒）
        handoff：任务同步 → MR 创建链接（人工路径）→ 阶段推进 → 交接话术
        --request-change "<说明>" [--to <stage>]：显式回退（说明留痕 change_request）
        --pr-url <MR链接>：人工创建 MR 后回填引用（pr_link + pr_linked 事件）
        --auto：直通（R3 sidecar 白名单）——save/handoff 预览即执行免确认，失败即停
        --apply <plan_id> [--message <subject>] [--accept-gaps] [--accept-diffs]
        [--files <p,...>] [--to <stage>] [--tasks <id,...>] [--no-<action>]
  sdlc done [<req_id>] [--apply <plan_id>]  完成核验/归档收尾（两段）
        第一段（归档准备）：目录移动 + 归档提交 + 推送，待人工合并
        第二段（--manual-confirm pr_merged）：人工确认合并 → 飞书终态 +
        收尾记录（manual/with_gaps——PR 状态不可回读，合并证据唯一来源是
        人工确认，不伪装 API 核实）
        [--accept-gaps] [--no-<action>]
  sdlc update [--to <tag>] [--tool claude|qoder] [--apply] [--force]
        分发更新：fetch tags → 更新计划 → checkout <tag>（原子切换）→ 重铺薄入口
        → 自检（失败自动回滚）；--to <旧tag> 降级；--force 覆盖自定义入口差异
  sdlc --version

全局 flags：--json（机读输出）

认证：meegle-cli 托管（OAuth 设备码流，keychain 存储）——未登录时命令自动
发起登录交接（输出授权 URL，浏览器完成）；sdlc doctor 可核查认证状态。

数据契约 v5；退出码：0 正常 / 1 参数·授权·冲突 / 2 外部失败 / 3 schema 不符`;

/**
 * 未登录/凭据失效的自动处理（D59）：自动发起 meegle 登录交接（授权 URL →
 * 浏览器授权 → 轮询落 token——token 在 meegle keychain，sdlc 不持有），成功后
 * 重跑原命令。登录是前置条件不是用户流程，只重试一次防循环。doctor 不参与
 *（只读自检，自己会标 missing）。
 * @param {string} command
 * @param {boolean} authHandled
 * @returns {Promise<number | string | null>} 处理了返回退码或 'retry'；不该处理返回 null
 */
async function handleAuthFailure(command, authHandled) {
  if (authHandled || command === 'doctor') return null;
  console.log('未登录/凭据失效——自动发起 meegle 登录（浏览器授权，完成后自动继续）…');
  try {
    const r = await meegleLoginHandshake({
      onUrl: (url) => {
        console.log('  浏览器已自动打开飞书授权页（未弹出请复制此链接完成登录）：');
        console.log(`  ${url}`);
      },
    });
    if (r.ok) {
      console.log('✓ 登录完成');
      return 'retry';
    }
    return 1;
  } catch (e) {
    // 这里在 run() 的 catch 块内，再抛会绕过 SdlcError 格式化直接崩进程——接住按错误域退出
    if (e instanceof SdlcError) {
      console.error(`✗ 自动登录失败：${e.message}（可 sdlc doctor 核查认证状态后重试）`);
      return exitCodeOf(e);
    }
    console.error('✗ 自动登录未预期失败：', e);
    return 1;
  }
}

/** 取值型 flag → flags 键（Skill 拼装，用户不记忆；契约 §4：--message 只传 subject） */
const VALUE_FLAGS = { '--intent': 'intent', '--message': 'message', '--tasks': 'tasks', '--to': 'to', '--files': 'files', '--request-change': 'requestChange', '--manual-confirm': 'manualConfirm', '--pr-url': 'prUrl', '--tool': 'tool' };

/**
 * @param {string[]} argv
 * @param {boolean} [authHandled] 内部重跑标记（自动登录只试一次）
 * @returns {Promise<number>} 进程退出码
 */
export async function run(argv, authHandled = false) {
  let command = null;
  const positional = [];
  const flags = /** @type {Record<string, any>} */ ({});
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') return printVersion(), 0;
    if (a === '--help' || a === '-h') return console.log(USAGE), 0;
    if (a === '--json') {
      flags.json = true;
      continue;
    }
    if (a === '--force') {
      flags.force = true;
      continue;
    }
    if (a === '--accept-gaps') {
      flags.acceptGaps = true;
      continue;
    }
    if (a === '--accept-diffs') {
      flags.acceptDiffs = true;
      continue;
    }
    if (a === '--auto') {
      flags.auto = true;
      continue;
    }
    if (a.startsWith('--no-')) {
      // 通用动作否决（契约 §4：--no-<action> 跳过计划中可跳过的动作并留痕）
      (flags.no ??= {})[a.slice(5)] = true;
      continue;
    }
    const valueFlag = VALUE_FLAGS[a.split('=')[0]];
    if (valueFlag) {
      let v;
      if (a.includes('=')) v = a.slice(a.indexOf('=') + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) { v = next; i++; } else v = '';
      }
      if (v === '') return console.error(`${a.split('=')[0]} 需要值（如 ${a} <值>）`), 1;
      flags[valueFlag] = v;
      continue;
    }
    if (a === '--apply' || a.startsWith('--apply=')) {
      if (a === '--apply') {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) { flags.apply = next; i++; } // start：--apply <plan_id>
        else flags.apply = true; // init：--apply（无值确认）
      } else {
        flags.apply = a.slice(8);
        if (flags.apply === '') return console.error('--apply= 不能为空'), 1;
      }
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      return console.error(`未知 flag：${a}\n\n${USAGE}`), 1;
    }
    if (command === null) command = a;
    else positional.push(a);
  }
  if (!command) return console.log(USAGE), 0;

  try {
    switch (command) {
      case 'doctor':
        return await runDoctor(flags);
      case 'init':
        return await runInit(positional, flags);
      case 'start':
        return await runStart(positional, flags);
      case 'status':
        return await runStatus(positional, flags);
      case 'next':
        return await runNext(positional, flags);
      case 'done':
        return await runDone(positional, flags);
      case 'update':
        return await runUpdate(flags);
      default:
        console.error(`未知命令：${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof SdlcError && err.code === 'unauthorized') {
      const handled = await handleAuthFailure(command, authHandled);
      if (handled === 'retry') return await run(argv, true);
      if (typeof handled === 'number') return handled;
    }
    if (err instanceof SdlcError) {
      console.error(`✗ ${err.code}：${err.message}`);
      if (err.details !== undefined) console.error(`  details: ${JSON.stringify(err.details)}`);
      return exitCodeOf(err);
    }
    console.error('✗ 未预期错误：', err);
    return 1;
  }
}

function printVersion() {
  console.log(`sdlc ${VERSION}`);
}
