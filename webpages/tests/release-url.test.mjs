/**
 * release-url.test.mjs —— 发布资产名与 URL 拼接的门禁（代码层）。
 *
 * 守的是什么（本 PR 最有价值的一条判据）：
 *   arm64 资产名在线上发布史上翻转过一次，App 侧因此有过真实缺陷
 *   （docs/AGENTS/gotchas.md 坑 172）。网页若按字符串臆造资产名，会重演同一缺陷，
 *   而且症状更隐蔽：页面照样显示、按钮照样可点，只是下载 404。
 *
 *   所以本测试**直接读发布链源码**（.github/workflows/release.yml 与
 *   scripts/build-apk-013.ps1 的 --artifact-name），与站点的资产名形态逐字比对——
 *   **发布链改名即判红**，不靠人记得同步。
 *
 * 运行：node --test webpages/tests/release-url.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIRROR_TEMPLATES, OWNER, REPO, SUPPORTED_ABIS,
  apkNameCandidates, assetUrl, canonicalApkName, classifyAbi, manifestUrl, pickAsset, sha256FromManifest,
} from '../src/assets/release.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readRepo = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');

// ── 与发布链绑定 ────────────────────────────────────────────────────────────

test('资产名形态与 build-apk-013.ps1 的 --artifact-name 逐字一致', () => {
  const ps1 = readRepo('scripts/build-apk-013.ps1');
  const m = ps1.match(/--artifact-name"?\s*,\s*"([^"]+)"/);
  assert.ok(m, 'build-apk-013.ps1 中找不到 --artifact-name 声明');
  // 真源形如 dsh-mobile-apk-v<ver>-<abi>.apk，把变量位归一后比对
  const shape = m[1].replace(/\$ver/g, 'X').replace(/\$abi/g, 'Y');
  assert.equal(shape, 'dsh-mobile-apk-vX-Y.apk', '发布链产物名形态变了，站点需同步');
  assert.equal(canonicalApkName('vX', 'Y'), shape, '站点资产名形态与发布链产物名不一致');
});

test('release.yml 归集口径未变（变了必须重核本门禁）', () => {
  const yml = readRepo('.github/workflows/release.yml');
  const pattern = ['out/v', String.fromCharCode(36), '{ver}', '/*.apk'].join('');
  assert.ok(yml.includes(pattern), 'release.yml 的 APK 归集方式变了，需重新核对本测试');
});

test('门禁自身具备判红能力（受控负控）', () => {
  const changed = canonicalApkName('v0.14.7', 'arm64').replace('-arm64.apk', '-arm64v8.apk');
  assert.notEqual(changed, canonicalApkName('v0.14.7', 'arm64'), '反证用例失效：改动未被检出');
});

// ── 命名历史兼容（坑 172 的防线）────────────────────────────────────────────

test('arm64 同时接受现行与历史两种资产名，x86_64 只有一种', () => {
  assert.deepEqual(apkNameCandidates('v0.14.7', 'arm64'),
    ['dsh-mobile-apk-v0.14.7-arm64.apk', 'dsh-mobile-apk-v0.14.7-arm64-v8a.apk']);
  assert.deepEqual(apkNameCandidates('v0.14.2', 'x86_64'),
    ['dsh-mobile-apk-v0.14.2-x86_64.apk']);
});

test('带 v 与不带 v 的 tag 归一到同一资产名', () => {
  assert.equal(canonicalApkName('v0.14.7', 'arm64'), canonicalApkName('0.14.7', 'arm64'));
});

test('pickAsset 命中真实发布历史里的两种 arm64 命名', () => {
  const assetsNew = [{ name: 'dsh-mobile-apk-v0.14.7-arm64.apk', size: 158453224 }];
  const assetsOld = [{ name: 'dsh-mobile-apk-v0.14.2-arm64-v8a.apk', size: 1 }];
  assert.ok(pickAsset('v0.14.7', 'arm64', assetsNew), '现行口径未命中');
  assert.ok(pickAsset('v0.14.2', 'arm64', assetsOld), '历史口径未命中');
});

test('兼容命名不放宽架构校验：异构资产永不命中', () => {
  const x86Only = [{ name: 'dsh-mobile-apk-v0.14.7-x86_64.apk', size: 1 }];
  assert.equal(pickAsset('v0.14.7', 'arm64', x86Only), null, 'arm64 设备不应拿到 x86_64 包');
  const armOnly = [{ name: 'dsh-mobile-apk-v0.14.7-arm64.apk', size: 1 }];
  assert.equal(pickAsset('v0.14.7', 'x86_64', armOnly), null, 'x86_64 设备不应拿到 arm64 包');
});

test('pickAsset 对空/畸形资产清单返回 null 而不抛错', () => {
  assert.equal(pickAsset('v0.14.7', 'arm64', []), null);
  assert.equal(pickAsset('v0.14.7', 'arm64', null), null);
  assert.equal(pickAsset('v0.14.7', 'riscv64', [{ name: 'x' }]), null);
});

// ── URL 拼接 ────────────────────────────────────────────────────────────────

test('URL 拼接为 release 资产直链，且各镜像只差域名前缀', () => {
  const name = 'dsh-mobile-apk-v0.14.7-arm64.apk';
  for (const tpl of MIRROR_TEMPLATES) {
    const url = assetUrl(tpl, 'v0.14.7', name);
    assert.ok(url.startsWith(tpl.prefix), tpl.id + ' 前缀未生效');
    assert.ok(url.endsWith('/' + OWNER + '/' + REPO + '/releases/download/v0.14.7/' + name), tpl.id + ' 路径段不正确');
    assert.ok(!url.includes('//' + 'https'), '前缀拼接出现了双协议');
  }
});

test('镜像前缀必须以斜杠结尾，否则会拼出坏 URL', () => {
  for (const tpl of MIRROR_TEMPLATES) {
    assert.ok(tpl.prefix.endsWith('/'), tpl.id + ' 前缀缺少结尾斜杠');
  }
});

test('assetUrl 缺前缀时抛错而不是静默产出坏链接', () => {
  assert.throws(() => assetUrl({}, 'v0.14.7', 'a.apk'), /缺少镜像前缀/);
  assert.throws(() => assetUrl(null, 'v0.14.7', 'a.apk'), /缺少镜像前缀/);
});

test('manifestUrl 指向 MANIFEST.txt', () => {
  assert.ok(manifestUrl(MIRROR_TEMPLATES[0], 'v0.14.7').endsWith('/v0.14.7/MANIFEST.txt'));
});

// ── ABI 判定 ────────────────────────────────────────────────────────────────

test('x86_64 不被误判为不支持的 x86（子串陷阱）', () => {
  assert.equal(classifyAbi({ platform: 'Linux x86_64' }).abi, 'x86_64');
  assert.equal(classifyAbi({ architecture: 'x86', bitness: '64' }).abi, 'x86_64');
});

test('x86 32 位按结构化字段判为不支持（明确信号不给兜底）', () => {
  const r = classifyAbi({ architecture: 'x86', bitness: '32' });
  assert.equal(r.abi, null);
  assert.equal(r.legacy, 'x86');
  assert.equal(r.confidence, 'unsupported', '明确 32 位应判不支持，而不是兜底');
});

test('arm64 的确定性写法都能识别', () => {
  for (const sig of [{ platform: 'Linux aarch64' }, { architecture: 'arm', bitness: '64' }, { architecture: 'arm64' }]) {
    const r = classifyAbi(sig);
    assert.equal(r.abi, 'arm64', JSON.stringify(sig) + ' 未识别为 arm64');
    assert.equal(r.confidence, 'certain', JSON.stringify(sig) + ' 应为确定判定');
  }
});

test('armv8l 兜底为 arm64 而非判不支持（否则主流机型看到"暂无支持版本"）', () => {
  const r = classifyAbi({ platform: 'Linux armv8l' });
  assert.equal(r.abi, 'arm64', 'arm64 手机常见上报值被判成了不支持');
  assert.equal(r.confidence, 'likely', '兜底结论必须被标注，界面据此提示可手动切换');
});

test('毫无架构线索时判 unknown 交给手动选择（不猜、也不假拒绝）', () => {
  // 现代 Android Chrome 的 reduced UA 不含架构 token，机型已被冻结成 "K"
  const r = classifyAbi({ ua: 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36' });
  assert.equal(r.abi, null);
  assert.equal(r.confidence, 'unknown');
});

test('桌面浏览器判 unknown，不会被谎称成已识别的 arm64', () => {
  assert.equal(classifyAbi({ platform: 'Win32' }).confidence, 'unknown');
  assert.equal(classifyAbi({ platform: 'MacIntel' }).confidence, 'unknown');
  assert.equal(classifyAbi({ platform: 'Win32' }).abi, null, '不得凭空推 APK');
});

test('Linux 桌面 x86_64 可正常判定（不受桌面兜底影响）', () => {
  const r = classifyAbi({ platform: 'Linux x86_64', ua: 'Mozilla/5.0 (X11; Linux x86_64)' });
  assert.equal(r.abi, 'x86_64');
  assert.equal(r.confidence, 'certain');
});

test('真正更老的 32 位与异构架构仍判不支持', () => {
  assert.equal(classifyAbi({ architecture: 'arm', bitness: '32' }).legacy, 'armv7');
  assert.equal(classifyAbi({ architecture: 'mips' }).abi, null);
  assert.equal(classifyAbi({ architecture: 'mips' }).legacy, 'other');
  assert.equal(classifyAbi({ platform: 'Linux riscv64' }).abi, null);
});

test('32 位字符串线索不产生假拒绝，但会标注兜底', () => {
  const r = classifyAbi({ platform: 'Linux armv7l' });
  assert.equal(r.abi, 'arm64', '32 位字符串线索不应直接判不支持');
  assert.equal(r.confidence, 'likely');
});

test('判定结果只可能是受支持集合内或 null（绝不越界）', () => {
  const cases = ['Linux aarch64', 'Linux x86_64', 'Linux armv7l', 'Windows NT 10.0; Win64; x64', '', 'Android'];
  for (const c of cases) {
    const r = classifyAbi({ platform: c });
    assert.ok(r.abi === null || SUPPORTED_ABIS.includes(r.abi), '出现越界 ABI：' + r.abi);
  }
});



// ── MANIFEST 解析 ───────────────────────────────────────────────────────────

test('从 MANIFEST.txt 取出 sha256（真实格式：hash 双空格 相对路径 空格 字节数）', () => {
  const text = [
    '0d96f1b204f7a3d48a89199415f831168cd380ea84f2565717bf646d27ffb1ff  apk/dsh-mobile-apk-v0.14.7-arm64.apk  158453224',
    '5d94b16da56ee7a08eb5030b422fcdd0e686e0208ad1dbaa79bd480b1012e46e  apk/dsh-mobile-apk-v0.14.7-x86_64.apk  155065330',
  ].join('\n');
  assert.equal(sha256FromManifest(text, 'apk/dsh-mobile-apk-v0.14.7-arm64.apk'),
    '0d96f1b204f7a3d48a89199415f831168cd380ea84f2565717bf646d27ffb1ff');
  assert.equal(sha256FromManifest(text, 'apk/nope.apk'), null);
  assert.equal(sha256FromManifest('垃圾输入', 'apk/x.apk'), null);
});

// ── 站点源码约束 ────────────────────────────────────────────────────────────

test('页面不含第三方脚本与统计（Pages 条款禁止收集用户数据）', () => {
  const html = readRepo('webpages/src/index.html');
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html), '出现了外部脚本引用');
  for (const bad of ['google-analytics', 'gtag(', 'umami', 'plausible', 'hm.baidu.com']) {
    assert.ok(!html.includes(bad), '出现统计/埋点：' + bad);
  }
});

test('页面在无 JS 时仍给出可用的下载入口', () => {
  const html = readRepo('webpages/src/index.html');
  assert.ok(/<noscript>/.test(html), '缺少 noscript 兜底');
  assert.ok(/github\.com\/kelai141\/dsh-mobile-apk\/releases/.test(html), 'noscript 未指向 Releases');
});