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

test('offline seed and refresh round-trip preserve release identity and checksums', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-delivery-'));
  try {
    for (const dir of ['src', 'tools', 'data']) fs.cpSync(path.join(root, dir), path.join(scratch, dir), { recursive: true });
    const preload = path.join(scratch, 'network.mjs');
    fs.writeFileSync(preload, `
globalThis.fetch = async url => {
  if (process.env.PAGES_TEST_OFFLINE === '1') throw new Error('controlled offline');
  if (String(url).includes('api.github.com')) return { ok: true, json: async () => (${JSON.stringify({ tag_name: tag, published_at: '2026-10-14T00:00:00Z', assets })}) };
  return { ok: true, text: async () => ${JSON.stringify(`${arm}  apk/${asset('arm64')}  100\n${x86}  apk/${asset('x86_64')}  100`)} };
};`);
    const run = (offline, refresh = false) => {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(scratch, 'tools/build.mjs'), ...(refresh ? ['--refresh'] : [])], {
        encoding: 'utf8', env: { ...process.env, PAGES_TEST_OFFLINE: offline ? '1' : '0' },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const data = JSON.parse(fs.readFileSync(path.join(scratch, 'dist/data/releases.json')));
      const html = fs.readFileSync(path.join(scratch, 'dist/index.html'), 'utf8');
      assert.equal(data.tag, tag);
      assert.match(html, /"tag":"v0.14.7"/);
      return data;
    };
    assert.equal(run(true).source, 'seed');
    assert.deepEqual(run(false, true).sha256, { arm64: arm, x86_64: x86 });
    const restored = run(true);
    assert.equal(restored.publishedAt, '2026-10-14T00:00:00Z');
    assert.deepEqual(restored.sha256, { arm64: arm, x86_64: x86 });
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
globalThis.document = { getElementById: get, createElement: node };
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
  assert.doesNotMatch(workflow, /\n  workflow_run:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
});
