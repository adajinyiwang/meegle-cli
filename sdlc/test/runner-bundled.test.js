// runner meegle 可执行解析（Windows npm .cmd shim 规避）：findBundledMeegleEntry
// 从给定目录逐级向上找同包 meegle.js 入口——npm 包布局（<pkg>/bin/meegle.js）与
// 仓库布局（<repo>/npm/meegle/bin/meegle.js）都命中；找不到 → null（调用方回退
// 裸名 meegle，保持 ENOENT → 安装提示语义）。SDLC_MEEGLE_BIN 覆盖优先由
// meegle.test.js 全套用例背书（全部经覆盖通道执行）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { findBundledMeegleEntry } = await import('../cli/src/meegle/runner.js');

/** 在 root 下铺出 relPath 文件并返回其绝对路径。 */
function lay(root, relPath) {
  const full = path.join(root, ...relPath.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, '// fake meegle entry\n');
  return full;
}

test('findBundledMeegleEntry：npm 包布局——<pkg>/sdlc/cli/src/meegle 向上命中 <pkg>/bin/meegle.js', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'sdlc-pkg-'));
  try {
    const entry = lay(pkg, 'bin/meegle.js');
    const from = path.join(pkg, 'sdlc', 'cli', 'src', 'meegle');
    mkdirSync(from, { recursive: true });
    assert.equal(findBundledMeegleEntry(from), entry);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test('findBundledMeegleEntry：仓库布局——<repo>/sdlc/cli/src/meegle 向上命中 <repo>/npm/meegle/bin/meegle.js', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'sdlc-repo-'));
  try {
    const entry = lay(repo, 'npm/meegle/bin/meegle.js');
    const from = path.join(repo, 'sdlc', 'cli', 'src', 'meegle');
    mkdirSync(from, { recursive: true });
    assert.equal(findBundledMeegleEntry(from), entry);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('findBundledMeegleEntry：就近优先——更浅层的 bin/meegle.js 先命中', () => {
  const pkg = mkdtempSync(path.join(tmpdir(), 'sdlc-near-'));
  try {
    lay(pkg, 'bin/meegle.js');
    const near = lay(pkg, 'sdlc/cli/bin/meegle.js'); // 更浅（sdlc/cli 层）
    const from = path.join(pkg, 'sdlc', 'cli', 'src', 'meegle');
    mkdirSync(from, { recursive: true });
    assert.equal(findBundledMeegleEntry(from), near);
  } finally {
    rmSync(pkg, { recursive: true, force: true });
  }
});

test('findBundledMeegleEntry：找不到 → null（调用方回退裸名 meegle）', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'sdlc-empty-'));
  try {
    // 注意：tmpdir 向上可能命中真实布局？——/tmp 之上无 bin/meegle.js，安全
    assert.equal(findBundledMeegleEntry(path.join(empty, 'a', 'b')), null);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
