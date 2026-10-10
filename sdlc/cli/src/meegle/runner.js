// meegle 子进程通道（meegle-contract §1）：spawn `meegle <cmd> --format json
// --envelope`，统一注入 MEEGLE_NO_UPDATE_CHECK=1（非 TTY 防更新提示挂起）。
// 解析容错：只取所需字段、忽略未知字段；meta.logid 仅错误留痕不进业务判断。
// 退出码：0 成功 / 1 客户端错（错误信封）/ 2 服务端错（retryable）；
// 超时/进程异常/输出不可解析 → external_unknown（待人工核对，不盲重发）。
// SDLC_MEEGLE_BIN 可覆盖可执行路径（测试隔离用）。
import { spawn } from 'node:child_process';
import { SdlcError } from '../errors.js';

const MEEGLE_BIN = () => process.env.SDLC_MEEGLE_BIN || 'meegle';
const TIMEOUT_MS = () => Number(process.env.SDLC_MEEGLE_TIMEOUT_MS) || 120_000;

/** meegle 错误信封 code → SdlcError 域（meegle-contract §4） */
const CODE_MAP = {
  AUTH_REQUIRED: 'unauthorized',
  AUTH_EXPIRED: 'unauthorized',
  CLIENT_COMMAND_DENIED: 'forbidden',
  CLIENT_MISSING_REQUIRED: 'validation_failed',
  PARAM_INVALID: 'validation_failed',
  INVALID_PARAMS_JSON: 'validation_failed',
  INVALID_OPTION: 'validation_failed',
  CONFIG_ENV_UNRESOLVED: 'validation_failed',
  HOST_NOT_CONFIGURED: 'validation_failed',
};

/** 平台默认浏览器打开授权页（尽力而为：失败不阻塞——URL 已打印兜底；
 *  SDLC_NO_BROWSER=1 跳过——无桌面/测试环境）。 */
function openBrowser(url) {
  if (process.env.SDLC_NO_BROWSER === '1') return false;
  try {
    const plat = process.platform;
    const child = plat === 'win32'
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      : plat === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // 打不开就算了——链接已转述
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * meegle 安装预检：`meegle --version` 可执行 → true；ENOENT → false；其他错误 → external_unavailable。
 * @returns {Promise<boolean>}
 */
export function meegleInstalled() {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(MEEGLE_BIN(), ['--version'], {
        env: { ...process.env, MEEGLE_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      reject(new SdlcError('external_unavailable', `meegle 启动失败：${e.message}`));
      return;
    }
    const timeout = setTimeout(() => { child.kill(); reject(new SdlcError('external_unavailable', 'meegle --version 超时——安装态未核实')); }, 15_000);
    child.on('error', (e) => {
      clearTimeout(timeout);
      if (e.code === 'ENOENT') return resolve(false);
      reject(new SdlcError('external_unavailable', `meegle 不可用：${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

/**
 * 代跑 meegle 安装（与 install.sh 同命令；失败不静默——上抛由调用方决定阻塞与否）。
 * @returns {Promise<void>}
 */
export function installMeegle() {
  return new Promise((resolve, reject) => {
    const args = ['-y', '@didatravel-jinyi/meegle@latest', 'install', '--host', 'project.feishu.cn', '--device-code', '--no-skills', '-y'];
    let child;
    try {
      child = spawn('npx', args, { env: { ...process.env, MEEGLE_NO_UPDATE_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    } catch (e) {
      reject(new SdlcError('external_unavailable', `meegle 安装启动失败：${e.message}`));
      return;
    }
    let stderr = '';
    child.on('error', (e) => reject(new SdlcError('external_unavailable', `meegle 安装失败（npx 不可用）：${e.message}`)));
    child.stderr.on('data', (d) => { stderr += d; });
    const timeout = setTimeout(() => { child.kill(); reject(new SdlcError('external_unavailable', 'meegle 安装超时（5 分钟）——请人工执行 bash install.sh 后重试')); }, 300_000);
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolve();
      reject(new SdlcError('external_unavailable', `meegle 安装失败（exit ${code}${stderr ? `：${stderr.slice(0, 200)}` : ''}）——请人工执行 bash install.sh 后重试`));
    });
  });
}

/**
 * 安装与登录一步到位（init/update 尾段用）：未装 → 代跑安装；未登录 → 登录交接。
 * 只输出结论不输出任何凭据；登录失败上抛（调用方如实转述，不阻塞已完成的本地动作）。
 * @param {{onUrl?: (url: string) => void, assumeInstalled?: boolean}} [opts]
 * @returns {Promise<{installed: boolean, authenticated: boolean}>}
 */
export async function ensureMeegleReady(opts = {}) {
  let installed = opts.assumeInstalled === true;
  if (!installed) {
    installed = await meegleInstalled();
    if (!installed) {
      console.log('meegle 未安装——代跑官方安装（约 1-2 分钟，首次会下载依赖）…');
      await installMeegle();
      installed = true;
      console.log('✓ meegle 已安装');
    }
  }
  const auth = await meegleAuthStatus();
  if (!auth.authenticated) {
    const r = await meegleLoginHandshake(opts);
    return { installed, authenticated: r.ok };
  }
  return { installed, authenticated: true };
}

/**
 * @typedef {object} MeegleResult
 * @property {any} data               信封 data（命令所需字段；null=无数据）
 * @property {string} [logid]         错误留痕用（meta.logid，不进业务判断）
 */

/**
 * 运行一条 meegle 命令（信封模式）。失败按 §4 映射抛 SdlcError。
 * @param {string[]} args 命令与参数（不含 --format/--envelope）
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<MeegleResult>}
 */
export function runMeegle(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const full = [...args, '--format', 'json', '--envelope'];
    let child;
    try {
      child = spawn(MEEGLE_BIN(), full, {
        env: { ...process.env, MEEGLE_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(new SdlcError('external_unavailable', `meegle 启动失败：${e.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new SdlcError('external_unknown', `meegle ${args[0]} 超时（${opts.timeoutMs ?? TIMEOUT_MS()}ms）——结果未知，请人工核对后重试`));
    }, opts.timeoutMs ?? TIMEOUT_MS());
    child.on('error', (e) => {
      clearTimeout(timeout);
      const hint = e.code === 'ENOENT'
        ? 'meegle 未安装/不在 PATH——请先安装（npm i -g @didatravel-jinyi/meegle 后运行 meegle install --host project.feishu.cn --device-code，或 npx -y @didatravel-jinyi/meegle@latest install --host project.feishu.cn --device-code --no-skills -y）'
        : e.message;
      reject(new SdlcError('external_unavailable', `meegle 不可用：${hint}`));
    });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      // meegle --format json 输出 pretty 多行 JSON：整段解析，失败退回末行（兼容
      // 单行/带日志输出）。失败时错误信封走 stderr、stdout 空（v1.0.23 实测）——
      // stderr 同样解析（否则必填字段等服务端拒绝理由被吞成「不可解析」）
      const parseEnvelope = (text) => {
        for (const src of [text.trim(), text.trim().split('\n').filter(Boolean).pop() ?? '']) {
          try { return JSON.parse(src); } catch { /* 试下一种形状 */ }
        }
        return null;
      };
      /** @type {any} */
      const env = parseEnvelope(stdout) ?? parseEnvelope(stderr);
      if (env && typeof env === 'object') {
        const err = env.error ?? null;
        if (code === 0 && !err) return resolve({ data: env.data ?? null });
        // exit 1/2 或信封自带 error：按 §4 域映射
        const sdlcCode = err?.code != null ? (CODE_MAP[err.code] ?? (code === 2 ? 'external_unavailable' : 'validation_failed')) : (code === 2 ? 'external_unavailable' : 'external_unknown');
        const logid = env.meta?.logid ? `（logid=${env.meta.logid}）` : '';
        reject(new SdlcError(sdlcCode, `meegle ${args[0]} 失败：${err?.message ?? `exit ${code}`}${logid}`, err ?? null));
        return;
      }
      if (code === 0) {
        // exit 0 但无信封（如部分元命令）：原样返回 null——调用方各自容错
        return resolve({ data: null });
      }
      reject(new SdlcError('external_unknown', `meegle ${args[0]} 输出不可解析（exit ${code}${stderr ? `：${stderr.slice(0, 200)}` : ''}）——结果未知，请人工核对`));
    });
  });
}

/**
 * auth status 预检（契约 §1：exit 0 已认证 / 1 无 token 或被拒 / 2 服务不可达）。
 * 不读 token 内容，只取退出码语义。
 * @returns {Promise<{authenticated: boolean, reason?: string}>}
 */
export async function meegleAuthStatus() {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(MEEGLE_BIN(), ['auth', 'status'], {
        env: { ...process.env, MEEGLE_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(new SdlcError('external_unavailable', `meegle 启动失败：${e.message}`));
      return;
    }
    let out = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new SdlcError('external_unavailable', 'meegle auth status 超时——认证态未核实'));
    }, 30_000);
    child.on('error', (e) => {
      clearTimeout(timeout);
      reject(new SdlcError('external_unavailable', e.code === 'ENOENT' ? 'meegle 未安装/不在 PATH（安装链代跑；未装不影响 sdlc 本体）' : `meegle 不可用：${e.message}`));
    });
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) return resolve({ authenticated: true });
      if (code === 1) return resolve({ authenticated: false, reason: '未认证/凭据被拒' });
      reject(new SdlcError('external_unavailable', `meegle 认证服务不可达（exit ${code}${out ? `：${out.slice(0, 120)}` : ''}）`));
    });
  });
}

/**
 * 非交互登录交接（契约 §1 / client-design §2.3）：`auth login --phase init
 * --device-code` 输出 JSON（v1.0.23 实测：无信封直出
 * {client_id, device_code, expires_in, interval, user_code, verification_uri,
 * verification_uri_complete}——后者是带 user_code 的直达授权链接）→ 自动开
 * 浏览器 + onUrl 兜底转述 → poll 轮询落 token。解析失败按 unknown 抛错不猜。
 * @param {{onUrl?: (url: string) => void, pollIntervalMs?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean}>}
 */
export async function meegleLoginHandshake(opts = {}) {
  // init：拿授权链接 + device_code/client_id（--device-code 模式必传，否则 INVALID_OPTION）
  const init = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(MEEGLE_BIN(), ['auth', 'login', '--phase', 'init', '--device-code'], {
        env: { ...process.env, MEEGLE_NO_UPDATE_CHECK: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      reject(new SdlcError('external_unavailable', `meegle 启动失败：${e.message}`));
      return;
    }
    let out = '';
    child.on('error', (e) => reject(new SdlcError('external_unavailable', e.code === 'ENOENT' ? 'meegle 未安装——登录交接不可用，请先安装 meegle' : `meegle 不可用：${e.message}`)));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', () => resolve(out));
    setTimeout(() => { child.kill(); resolve(out); }, 30_000);
  });
  // JSON 直出（M1 #28 实测形状）；解析容错：整段 → 末行（带前置日志的输出）
  let info = null;
  try {
    info = JSON.parse(init.trim());
  } catch {
    try {
      info = JSON.parse(init.trim().split('\n').filter(Boolean).pop() ?? '');
    } catch { /* 不可解析——按 unknown 上报 */ }
  }
  const url = info?.verification_uri_complete ?? info?.verification_uri ?? null;
  const deviceCode = info?.device_code ?? null;
  const clientId = info?.client_id ?? null;
  if (!url || !deviceCode || !clientId || typeof url !== 'string') {
    throw new SdlcError('external_unknown', `meegle 登录初始化输出无法解析（授权链接/device_code/client_id 缺失）——输出形状与实测结论不符，请人工核对（M1 #28）`);
  }
  openBrowser(url); // 自动弹浏览器（用户实测痛点：登录繁琐不自动弹窗）；打不开再靠 onUrl 链接
  opts.onUrl?.(url);
  const interval = Number.isFinite(info.interval) && info.interval > 0 ? info.interval * 1000 : (opts.pollIntervalMs ?? 5_000);

  // poll：单次轮询循环（--once），间隔重试直到成功/超时（expires_in 秒为窗口上限）
  const deadline = Date.now() + (opts.timeoutMs ?? (Number.isFinite(info.expires_in) ? info.expires_in * 1000 : 300_000));
  for (;;) {
    let poll;
    try {
      poll = await runMeegle([
        'auth', 'login', '--phase', 'poll',
        '--device-code-value', deviceCode, '--client-id', clientId, '--once',
      ], { timeoutMs: 30_000 });
      return { ok: true };
    } catch (e) {
      // 未授权完成（pending）继续轮询；其余错误上抛
      if (!(e instanceof SdlcError) || (e.code !== 'unauthorized' && e.code !== 'external_unavailable' && e.code !== 'validation_failed' && e.code !== 'external_unknown')) throw e;
    }
    if (Date.now() + interval > deadline) {
      throw new SdlcError('external_unavailable', '等待浏览器完成飞书授权超时——请重试本命令重新发起登录交接');
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
