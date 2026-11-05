import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tag = 'v0.14.7';
const arm = 'a'.repeat(64), x86 = 'b'.repeat(64);
const asset = abi => `dsh-mobile-apk-${tag}-${abi}.apk`;
const assets = ['arm64', 'x86_64'].map(abi => ({ name: asset(abi), size: 100 }));

test('offline build and explicit refresh preserve identity; failed sync never publishes stale data', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-delivery-'));
  try {
    for (const dir of ['src', 'tools', 'data']) fs.cpSync(path.join(root, dir), path.join(scratch, dir), { recursive: true });
    fs.writeFileSync(path.join(scratch, 'data/releases.json'), JSON.stringify({ tag, assets, publishedAt: '2026-10-14T00:00:00Z', sha256: {} }));
    const preload = path.join(scratch, 'network.mjs');
    fs.writeFileSync(preload, `
import fs from 'node:fs';
globalThis.fetch = async url => {
  fs.writeFileSync(new URL('./network-called', import.meta.url), 'called');
  if (process.env.PAGES_TEST_OFFLINE === '1') throw new Error('controlled offline');
  if (process.env.PAGES_TEST_BAD_MANIFEST === '1' && !String(url).includes('api.github.com')) return { ok: true, text: async () => 'invalid manifest' };
  if (String(url).includes('api.github.com')) return { ok: true, json: async () => (${JSON.stringify({ tag_name: tag, published_at: '2026-10-14T00:00:00Z', assets })}) };
  return { ok: true, text: async () => ${JSON.stringify(`${arm}  apk/${asset('arm64')}  100\n${x86}  apk/${asset('x86_64')}  100`)} };
};`);
    const run = (offline, refresh = false) => {
      fs.rmSync(path.join(scratch, 'network-called'), { force: true });
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs'), ...(refresh ? ['--refresh'] : [])], {
        encoding: 'utf8', env: { ...process.env, PAGES_TEST_OFFLINE: offline ? '1' : '0' },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (!refresh) assert.equal(fs.existsSync(path.join(scratch, 'network-called')), false, 'regular builds must make zero network requests');
      const data = JSON.parse(fs.readFileSync(path.join(scratch, 'dist/data/releases.json')));
      const html = fs.readFileSync(path.join(scratch, 'dist/index.html'), 'utf8');
      assert.equal(data.tag, tag);
      assert.match(html, /"tag":"v0.14.7"/);
      // 占位符必须一个不留。真因（2026-10-19）：模板新增 release 参数行时用了 `__TAG__`，
      // 但 render() 的替换表与 assertRendered 的守卫清单都没带上它，于是字面量 `__TAG__`
      // 被原样发到线上 —— 页面正常渲染、参数行却显示占位符，而现有构建不会判红。
      // 这里直接对**构建产物**断言，不看替换表怎么实现，任何漏替换的 token 都会被抓到。
      assert.doesNotMatch(html, /__[A-Z][A-Z0-9_]*__/, '构建产物里残留未替换的占位符');
      return data;
    };
    assert.equal(run(true).source, 'seed');
    assert.deepEqual(run(false, true).sha256, { arm64: arm, x86_64: x86 });
    const restored = run(true);
    assert.equal(restored.publishedAt, '2026-10-14T00:00:00Z');
    assert.deepEqual(restored.sha256, { arm64: arm, x86_64: x86 });
    const strictFailure = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs'), '--refresh'], {
      encoding: 'utf8', env: { ...process.env, PAGES_TEST_OFFLINE: '1' },
    });
    assert.equal(strictFailure.status, 1, 'API failure must not silently publish the seed');
    assert.match(strictFailure.stderr, /controlled offline/);
    const badManifest = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs'), '--refresh'], {
      encoding: 'utf8', env: { ...process.env, PAGES_TEST_OFFLINE: '0', PAGES_TEST_BAD_MANIFEST: '1' },
    });
    assert.equal(badManifest.status, 1, 'invalid manifest must fail publication');
    assert.match(badManifest.stderr, /invalid manifest entry/);
    // The last successful deployment remains complete and usable.
    assert.equal(JSON.parse(fs.readFileSync(path.join(scratch, 'dist/data/releases.json'))).tag, tag);
    // Malformed fallback input must fail rather than publish an unidentified release.
    fs.writeFileSync(path.join(scratch, 'data/releases.json'), '{}');
    const bad = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs')], {
      encoding: 'utf8', env: { ...process.env, PAGES_TEST_OFFLINE: '1' },
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /no valid tag/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('actual app renders the selected checksum, switches ABI, and handles missing hashes', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-app-'));
  try {
    const runner = path.join(scratch, 'render.mjs');
    const appUrl = pathToFileURL(path.join(root, 'src/assets/app.js')).href;
    fs.writeFileSync(runner, `
import assert from 'node:assert/strict';
const release = ${JSON.stringify({ tag, assets, sha256: { arm64: arm, x86_64: x86 } })};
const nodes = new Map();
const node = () => ({ textContent: '', innerHTML: '', dataset: {}, children: [],
  setAttribute(name, value) { this[name] = value; },
  appendChild(child) { this.children.push(child); },
  querySelectorAll() { return this.children; }, querySelector() { return null; },
  addEventListener(type, callback) { this[type] = callback; } });
const get = id => {
  if (!nodes.has(id)) nodes.set(id, node());
  return nodes.get(id);
};
get('release-data').textContent = JSON.stringify(release);
globalThis.document = { documentElement: {}, querySelectorAll: () => [], getElementById: get, createElement: node };
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Linux armv8l', userAgent: '', onLine: false }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.fetch = async () => { throw new Error('controlled offline'); };
await import(${JSON.stringify(appUrl)});
await new Promise(resolve => setImmediate(resolve));
const html = () => get('dl-body').innerHTML;
assert.ok(html().includes(release.sha256.arm64));
assert.ok(!html().includes(release.sha256.x86_64));
get('switch-abi').click();
assert.ok(html().includes(release.sha256.x86_64));
assert.ok(!html().includes(release.sha256.arm64));
delete release.sha256.x86_64;
// Reopen the same module in a fresh generation with the missing checksum.
get('release-data').textContent = JSON.stringify(release);
navigator.platform = 'Linux x86_64';
await import(${JSON.stringify(appUrl + '?missing')});
await new Promise(resolve => setImmediate(resolve));
assert.ok(html().includes('未提供内联校验值'));
assert.ok(!html().includes('[object Object]'));
release.sha256 = {};
get('release-data').textContent = JSON.stringify(release);
await import(${JSON.stringify(appUrl + '?empty')});
await new Promise(resolve => setImmediate(resolve));
assert.ok(html().includes('未提供内联校验值'));
assert.ok(!html().includes('[object Object]'));
`);
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('publication triggers a default-branch site build rather than a draft build', () => {
  const workflow = fs.readFileSync(path.join(root, '../.github/workflows/pages.yml'), 'utf8');
  assert.match(workflow, /\n  release:\s*\n    types: \[published\]/);
  // 站点构建必须检出默认分支，否则 release 事件会按 tag 建出 draft 内容。
  assert.match(workflow, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});

/**
 * 本文件原来有一条断言**有缺陷的接线**，已随 0.14.10 的修复改正。
 *
 * 历史写法（删掉的两行）：
 *   assert.match(workflow, /\n  workflow_call:/);
 *   assert.match(release, /sync-pages:[\s\S]*uses: \.\/\.github\/workflows\/pages\.yml/);
 * 这两条把「pages.yml 暴露 workflow_call」+「release 用 uses: 复用」当成正确形态钉死了，
 * 于是缺陷一直绿着：可复用工作流的 deployment ref 继承调用方 ref（发版分支
 * release/0.14.10），被 github-pages 环境的 branch policy（只放行 branch:main 与
 * tag:v*）拒掉，站点不更新。0.14.10 发版实测 sync-pages / deploy 判红、只能人工补 dispatch。
 *
 * 现在改为断言「deployment ref 恒为 main」这一真正的不变量（详见 pages-deploy-ref.test.mjs）。
 */
test('sync-pages dispatches the site refresh on main so the deployment ref is trusted', () => {
  const release = fs.readFileSync(path.join(root, '../.github/workflows/release.yml'), 'utf8');
  const syncPages = release.slice(release.indexOf('sync-pages:'));
  assert.match(syncPages, /needs: \[publish\]/, 'sync-pages 必须仍排在 publish 之后');
  assert.match(syncPages, /gh workflow run pages\.yml --ref main/, '必须以 main ref 派发');
  assert.doesNotMatch(syncPages, /uses: \.\/\.github\/workflows\/pages\.yml/, '不得用可复用工作流（会继承发版分支 ref）');
});
