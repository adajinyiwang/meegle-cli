// sdlc init：仓库接入。写 .sdlc/config.yaml + .sdlc/templates/（文档模板分发）。
// 全程先预览差异（new/same/conflict），--apply 才落盘；conflict 不覆盖（外科手术式）。
// apply 尾段代跑 meegle 安装/授权检查（R2：安装与登录一步到位，登录自动弹
// 浏览器；失败警告不阻塞——本地配置已写好，doctor 可随时核查续做）。
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../util.js';
import { gitRoot } from '../gitops.js';
import { SdlcError } from '../errors.js';
import { useMock } from '../config.js';
import { ensureMeegleReady } from '../meegle/index.js';

/** 子仓根（cli/src/command → 上三级） */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** 分发清单：模板源 → 仓库目标 */
const ASSETS = [
  { src: 'templates/config.yaml', dest: '.sdlc/config.yaml' },
  { src: 'templates/prd.md', dest: '.sdlc/templates/prd.md' },
  { src: 'templates/tasks.md', dest: '.sdlc/templates/tasks.md' },
  { src: 'templates/brief.md', dest: '.sdlc/templates/brief.md' },
  { src: 'templates/testcases.md', dest: '.sdlc/templates/testcases.md' },
  { src: 'templates/report.md', dest: '.sdlc/templates/report.md' },
];

/**
 * @param {string[]} args
 * @param {{apply?: string | true, json?: boolean}} opts
 * @returns {Promise<number>}
 */
export async function runInit(args, opts = {}) {
  const cwd = args[0] ? path.resolve(args[0]) : process.cwd();
  const root = gitRoot(cwd);
  if (!root) {
    throw new SdlcError('validation_failed', `${cwd} 不在 git 仓库内（sdlc 需求档案随 git 分发，必须先 git init）`);
  }

  // 差异预览（纯只读）
  const rows = ASSETS.map((a) => {
    const src = path.join(PKG_ROOT, a.src);
    const dest = path.join(root, a.dest);
    if (!existsSync(src)) return { ...a, status: 'src_missing' };
    if (!existsSync(dest)) return { ...a, status: 'new' };
    const same = sha256(readFileSync(src, 'utf8')) === sha256(readFileSync(dest, 'utf8'));
    return { ...a, status: same ? 'same' : 'conflict' };
  });

  if (opts.json) {
    console.log(JSON.stringify({ command: 'init', repo_root: root, plan: rows }, null, 2));
    return 0;
  }

  console.log(`仓库接入预览（${root}）：`);
  for (const r of rows) {
    const mark = r.status === 'new' ? '+' : r.status === 'same' ? '=' : r.status === 'conflict' ? '!' : '×';
    console.log(`  [${mark}] ${r.dest}  ← ${r.src}（${r.status}）`);
  }
  const conflicts = rows.filter((r) => r.status === 'conflict');
  if (conflicts.length > 0) {
    console.log('⚠ 存在内容冲突：apply 不会覆盖这些文件（人工比对后自行处理）。');
  }
  console.log('确认执行：sdlc init --apply');

  if (opts.apply !== undefined) {
    for (const r of rows) {
      if (r.status === 'new') {
        const dest = path.join(root, r.dest);
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(path.join(PKG_ROOT, r.src), dest);
      }
    }
    console.log(`已写入 ${rows.filter((r) => r.status === 'new').length} 个新文件（same/conflict 跳过）。`);
    console.log('后续：按仓库实际维护 .sdlc/config.yaml（git.trunk / stages；feishu 已预设 dida 日常 4 流程模板 profile——R5 PMO 预置）后 commit，再 sdlc start <需求URL|id>。');
    // meegle 安装/授权一步到位（R2）：未装代跑安装，未登录自动弹浏览器授权；
    // 失败只警告不回滚（本地配置已落盘，sdlc doctor 可随时核查续做）
    if (!useMock()) {
      try {
        const ready = await ensureMeegleReady({
          onUrl: (url) => {
            console.log('  飞书登录（浏览器已自动打开；未弹出请复制此链接完成授权）：');
            console.log(`  ${url}`);
          },
        });
        if (ready.authenticated) console.log('✓ meegle 已就绪（安装 + 登录）——飞书通道可用');
      } catch (e) {
        console.warn(`⚠ meegle 未就绪：${e instanceof SdlcError ? e.message : String(e)}——不影响本地接入，稍后 sdlc doctor 核查后重试`);
      }
    }
  }
  return 0;
}
