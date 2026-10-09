import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const files = [
  'scripts/check-maintenance-docs.mjs', 'app/build.gradle.kts',
  'build.gradle.kts', 'gradle/wrapper/gradle-wrapper.properties',
  'scripts/patches/registry.json', 'docs/AGENTS/DEPENDENCIES.md',
  'docs/AGENTS/RUNTIME-PATCHES.md',
];
const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-maintenance-docs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const run = (...args) => spawnSync(process.execPath, ['scripts/check-maintenance-docs.mjs', ...args], { cwd: dir, encoding: 'utf8' });
  const mutate = (file, fn) => fs.writeFileSync(path.join(dir, file), fn(fs.readFileSync(path.join(dir, file), 'utf8')));
  return { dir, run, mutate };
};

test('Gradle 版本和依赖改变时检查拒绝，生成后通过', (t) => {
  const { dir, run, mutate } = fixture(t);
  assert.equal(run('--write').status, 0);
  mutate('app/build.gradle.kts', (text) => text
    .replace(/versionName = "[^"]+"/, 'versionName = "fixture-next"')
    .replace(/versionCode = \d+/, 'versionCode = 999')
    .replace('org.tukaani:xz:1.10', 'org.tukaani:xz:fixture-next'));
  assert.equal(run().status, 1);
  assert.equal(run('--write').status, 0);
  assert.equal(run().status, 0);
  const doc = fs.readFileSync(path.join(dir, 'docs/AGENTS/DEPENDENCIES.md'), 'utf8');
  assert.ok(doc.includes('versionName `fixture-next` / versionCode `999`'));
  assert.ok(doc.includes('org.tukaani:xz:fixture-next'));
});

test('补丁增加与退役会更新活动全集，历史章节保持原字节', (t) => {
  const { dir, run, mutate } = fixture(t);
  assert.equal(run('--write').status, 0);
  const file = 'docs/AGENTS/RUNTIME-PATCHES.md';
  const before = fs.readFileSync(path.join(dir, file), 'utf8').split('## 7. ')[1];
  mutate('scripts/patches/registry.json', (text) => {
    const data = JSON.parse(text);
    data.retired.push(data.patches.shift());
    data.patches.push({ id: 'fixture-new', scope: 'engine', target: 'first.js', additionalTargets: ['second.js'] });
    return JSON.stringify(data);
  });
  assert.equal(run().status, 1);
  assert.equal(run('--write').status, 0);
  assert.equal(run().status, 0);
  const after = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.equal(after.split('## 7. ')[1], before);
  assert.ok(after.includes('| `fixture-new` | engine | `first.js`<br>`second.js` |'));
});

test('缺失或重复生成块拒绝写入，避免覆盖历史正文', (t) => {
  for (const replacement of ['', '<!-- generated:gradle-declarations:start -->\n<!-- generated:gradle-declarations:start -->']) {
    const { dir, run, mutate } = fixture(t);
    const file = 'docs/AGENTS/DEPENDENCIES.md';
    mutate(file, (text) => text.replace('<!-- generated:gradle-declarations:start -->', replacement));
    const before = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.notEqual(run('--write').status, 0);
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), before);
  }
});
