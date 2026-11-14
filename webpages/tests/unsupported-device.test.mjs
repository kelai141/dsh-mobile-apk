// issue #1606：**明确不支持**的设备仍渲染「更换架构」按钮，一点就把用户拉回下载分支。
//
// 缺陷链（app.js render 末尾那条追加语句在 if/else 链**之外**）：
//   1. 设备判为 unsupported（32 位 x86、mips 等）=> c.abi = null、asset = null；
//   2. `if (!asset) body.innerHTML += ...` 不受 confidence 约束，照样渲染「更换架构」；
//   3. 点下去 `if (!c.abi)` 分支把架构硬写成 arm64/likely => 重绘进下载分支
//      => 用户下到 160MB 装不上的包（INSTALL_FAILED_NO_MATCHING_ABIS）。
//
// 判据落在**用户可见结果**上：不支持态不得出现改架构入口、不得出现下载直链；
// 并用两条反证（arm64 手机 / 桌面未知）钉死「不得把功能一起删掉」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const tag = 'v0.14.7';
const arm = 'a'.repeat(64);
const x86 = 'b'.repeat(64);
const release = {
  tag,
  assets: ['arm64', 'x86_64'].map(abi => ({ name: 'dsh-mobile-apk-' + tag + '-' + abi + '.apk', size: 100 })),
  sha256: { arm64: arm, x86_64: x86 },
};

/** 跑一次夹具；返回 exit code 与合并输出（判红时用于取证）。 */
function drive(signals, shouldClick) {
  const result = spawnSync(
    process.execPath,
    [path.join(fixtures, 'unsupported-device-runner.mjs'), JSON.stringify(signals), shouldClick ? '1' : '0'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PAGES_RELEASE_JSON: JSON.stringify(release),
        PAGES_APP_PATH: path.join(root, 'src/assets/app.js'),
      },
    },
  );
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
}

test('#1606 明确不支持的设备（32 位 x86）：不得出现可把用户拉进下载分支的「更换架构」', () => {
  const result = drive({ platform: 'Linux', ua: 'Mozilla/5.0 (Linux; Android 8.0)', architecture: 'x86', bitness: '32' }, true);
  assert.equal(result.status, 0, result.output);
});

test('#1606 反证：arm64 手机仍渲染下载直链与「更换架构」入口（修复不得删掉功能）', () => {
  const result = drive({ platform: 'Linux armv8l', ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7)', architecture: '', bitness: '' }, false);
  assert.equal(result.status, 0, result.output);
});

test('#1606 反证：桌面/未知设备仍走手动选择（不被打成「不支持」）', () => {
  const result = drive({ platform: 'Win32', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', architecture: '', bitness: '' }, false);
  assert.equal(result.status, 0, result.output);
});