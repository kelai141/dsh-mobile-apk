#!/usr/bin/env node
// Run actual workflow guards against dummy local inputs, never upstream builds.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
const ROOT = resolve(import.meta.dirname, '../..')
const yaml = readFileSync(join(ROOT, '.github/workflows/build-apk-source.yml'), 'utf8').replaceAll('\r\n', '\n')
function step(name, workflow = yaml) {
  const start = workflow.indexOf('      - name: ' + name + '\n')
  assert.notEqual(start, -1)
  const end = workflow.indexOf('\n      - name:', start + 1)
  const block = workflow.slice(start, end < 0 ? undefined : end)
  const marker = '        run: |\n'
  assert.ok(block.includes(marker))
  return block.slice(block.indexOf(marker) + marker.length).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
}
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'source-rerun-'))
  try { return fn(root) } finally { rmSync(root, { recursive: true, force: true }) }
}
function bash(script, root, extra = {}) {
  const r = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'set -euo pipefail\n' + script], {
    cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 262144,
    env: { PATH: join(root, 'bin') + ':' + dirname(process.execPath) + ':/usr/bin:/bin', HOME: root, TMPDIR: root, LC_ALL: 'C', GITHUB_WORKSPACE: root, ...extra },
  })
  if (r.error) throw r.error
  return r
}
const linux = { skip: process.platform !== 'linux' }
const buildYaml = readFileSync(join(ROOT, '.github/workflows/build-apk.yml'), 'utf8').replaceAll('\r\n', '\n')
const pluginDirs = JSON.parse(readFileSync(join(ROOT, 'scripts/plugin-dirs.json'), 'utf8')).dirs
const buildableDirs = pluginDirs.filter(d => JSON.parse(readFileSync(join(ROOT, d, 'package.json'), 'utf8')).scripts?.build)
function workflowConcurrencyGroup(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n')
  const start = lines.findIndex(line => line === 'concurrency:')
  if (start < 0) return null
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    if (!/^\s/.test(line)) break
    const match = line.match(/^  group:\s*(.*?)\s*$/)
    if (match) return match[1].replace(/^(?:"(.*)"|'(.*)')$/, (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)
  }
  return null
}
function resolveConcurrencyGroup(template, workflow, ref) {
  return template
    .replaceAll('${{ github.workflow }}', workflow)
    .replaceAll('${{ github.ref }}', ref)
}
function assertDistinctConcurrencyGroups(caller, called, context) {
  const callerGroup = resolveConcurrencyGroup(caller, context.workflow, context.ref)
  const calledGroup = resolveConcurrencyGroup(called, context.workflow, context.ref)
  if (callerGroup === calledGroup) throw new Error('caller and called workflow share concurrency group ' + callerGroup)
  return { callerGroup, calledGroup }
}
test('source-audit caller and reusable workflow use separate concurrency namespaces', () => {
  assert.match(buildYaml, /source-audit:[\s\S]*?uses: \.\/\.github\/workflows\/build-apk-source\.yml/)
  assert.match(yaml, /^  workflow_call:\s*$/m)
  const callerGroup = workflowConcurrencyGroup(buildYaml)
  const sourceGroup = workflowConcurrencyGroup(yaml)
  assert.ok(callerGroup)
  assert.ok(sourceGroup)
  const context = { workflow: 'build-apk', ref: 'refs/heads/concurrency-test' }
  const resolved = assertDistinctConcurrencyGroups(callerGroup, sourceGroup, context)
  assert.equal(resolved.callerGroup, 'build-apk-entry-refs/heads/concurrency-test')
  assert.equal(resolved.calledGroup, 'build-apk-source-refs/heads/concurrency-test')
  assert.equal(
    resolveConcurrencyGroup(sourceGroup, 'build-apk', context.ref),
    resolveConcurrencyGroup(sourceGroup, 'build-apk-source', context.ref),
    'direct dispatch and nested source calls must serialize together',
  )

  const oldGroup = '${{ github.workflow }}-${{ github.ref }}'
  assert.throws(
    () => assertDistinctConcurrencyGroups(oldGroup, oldGroup, context),
    /share concurrency group/,
    'negative control must reject the former shared caller/callee group',
  )
})
function preparePluginBuild(root) {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'scripts/plugin-dirs.json'), JSON.stringify({ dirs: pluginDirs }))
  for (const d of pluginDirs) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, 'package.json'), JSON.stringify({ scripts: buildableDirs.includes(d) ? { build: 'fixture' } : {} }))
  }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  writeFileSync(join(root, 'bin/node'), [
    '#!/bin/bash', 'set -eu',
    'if [ "$1" = -e ]; then exec ' + quote(process.execPath) + ' "$@"; fi',
    'printf "deps:%s\\n" "$2" >> "$HOME/plugin-calls"',
    'if [ "$2" = "${FAILURE_PACKAGE:-}" ]; then exit 23; fi', '',
  ].join('\n'))
  writeFileSync(join(root, 'bin/npm'), [
    '#!/bin/bash', 'set -eu', 'test "$1" = run; test "$2" = build',
    'printf "build:%s\\n" "${PWD#"$HOME/"}" >> "$HOME/plugin-calls"', '',
  ].join('\n'))
  chmodSync(join(root, 'bin/node'), 0o755)
  chmodSync(join(root, 'bin/npm'), 0o755)
}
for (const [label, script] of [
  ['normal', step('准备并构建插件（统一清单、锁解析与单次构建）', buildYaml)],
  ['source', step('Build project plugins from source')],
]) {
  test(label + ' plugin preparation: manifest order, one install and build per package', linux, () => fixture(root => {
    preparePluginBuild(root)
    const r = bash(script, root)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readFileSync(join(root, 'plugin-calls'), 'utf8').trim().split('\n'),
      buildableDirs.flatMap(d => ['deps:' + d, 'build:' + d]))
    assert.ok(buildableDirs.indexOf('dsh-shell-termux') < buildableDirs.indexOf('plugins/dsh-android-linux-env'))
  }))
  test(label + ' plugin preparation: dependency failure stops before any package build', linux, () => fixture(root => {
    preparePluginBuild(root)
    const r = bash(script, root, { FAILURE_PACKAGE: buildableDirs[0] })
    assert.equal(r.status, 23, r.stderr)
    assert.equal(readFileSync(join(root, 'plugin-calls'), 'utf8'), 'deps:' + buildableDirs[0] + '\n')
  }))
  test(label + ' plugin preparation: broken manifest cannot silently produce an empty success', linux, () => fixture(root => {
    preparePluginBuild(root)
    writeFileSync(join(root, 'scripts/plugin-dirs.json'), '{broken')
    assert.notEqual(bash(script, root).status, 0)
    assert.equal(existsSync(join(root, 'plugin-calls')), false)
  }))
}
const bootstrap = step('Authenticate official Termux bootstrap and extract signing keys')
const guard = bootstrap.slice(bootstrap.indexOf('bootstrap_sha256='), bootstrap.indexOf('\n# 先清空'))
const good = Buffer.from('authenticated dummy bootstrap\n')
const sha = createHash('sha256').update(good).digest('hex')
function prepare(root) {
  mkdirSync(join(root, 'scripts/source-build'), { recursive: true })
  mkdirSync(join(root, '.deploy-tmp/source-build'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'scripts/source-build/prepare-termux-bootstrap.py'), 'BOOTSTRAP_SHA256 = "' + sha + '"\n')
  writeFileSync(join(root, 'download'), good)
  const curl = [
    '#!/bin/bash', 'set -eu', 'printf "download\\n" >> "$HOME/calls"',
    'while [ "$#" -gt 0 ]; do if [ "$1" = "--output" ]; then output="$2"; break; fi; shift; done',
    'if [ "' + '$' + '{INTERRUPT:-0}" = 1 ] && [ ! -f "$HOME/interrupted" ]; then printf partial > "$output"; touch "$HOME/interrupted"; exit 22; fi',
    'cp "$HOME/download" "$output"', '',
  ].join('\n')
  writeFileSync(join(root, 'bin/curl'), curl)
  chmodSync(join(root, 'bin/curl'), 0o755)
  return join(root, '.deploy-tmp/source-build/bootstrap-aarch64.zip')
}
for (const cached of ['valid', 'absent', 'wrong', 'truncated']) {
  test('bootstrap ' + cached + ': only authenticated hits reuse', linux, () => fixture(root => {
    const cache = prepare(root)
    if (cached !== 'absent') writeFileSync(cache, cached === 'valid' ? good : Buffer.from(cached))
    const r = bash(guard, root)
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readFileSync(cache), good)
    assert.equal(existsSync(join(root, 'calls')), cached !== 'valid')
    assert.ok(bootstrap.includes('python3 scripts/source-build/prepare-termux-bootstrap.py'))
  }))
}
test('interrupted bootstrap download retries next invocation', linux, () => fixture(root => {
  const cache = prepare(root)
  assert.equal(bash(guard, root, { INTERRUPT: '1' }).status, 22)
  assert.notDeepEqual(readFileSync(cache), good)
  const r = bash(guard, root, { INTERRUPT: '1' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readFileSync(cache), good)
  assert.equal(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').length, 2)
}))
test('bad downloaded bytes are rejected before bootstrap extraction', linux, () => fixture(root => {
  const cache = prepare(root)
  writeFileSync(join(root, 'download'), 'bad download')
  assert.equal(bash(guard, root).status, 0)
  const destination = join(root, 'extracted/usr')
  const checked = spawnSync('/usr/bin/python3', [join(ROOT, 'scripts/source-build/prepare-termux-bootstrap.py'),
    '--extract-bootstrap-only', cache, destination], {
    encoding: 'utf8', timeout: 10000,
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LC_ALL: 'C' },
  })
  assert.notEqual(checked.status, 0)
  assert.ok((checked.stderr + checked.stdout).includes('SHA-256 mismatch'))
  assert.equal(existsSync(destination), false)
}))
test('source reset restores inputs but preserves ignored dependencies', linux, () => fixture(root => {
  const source = join(root, '.deploy-tmp/deepseek-harness')
  mkdirSync(source, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(source, '.gitignore'), 'node_modules/\nlib/\n*.tsbuildinfo\n')
  writeFileSync(join(source, 'source.txt'), 'pinned'); git('add', '.'); git('commit', '-qm', 'fixture')
  writeFileSync(join(source, 'source.txt'), 'interrupted override'); writeFileSync(join(source, 'untracked.txt'), 'remove')
  mkdirSync(join(source, 'node_modules')); writeFileSync(join(source, 'node_modules/sentinel'), 'keep')
  const checkout = step('Checkout pinned DeepSeek Harness source')
  const reset = checkout.slice(checkout.indexOf('test "$(realpath'), checkout.indexOf('\ngit -C .deploy-tmp/deepseek-harness checkout --detach'))
  const r = bash(reset, root)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(source, 'source.txt'), 'utf8'), 'pinned')
  assert.equal(existsSync(join(source, 'untracked.txt')), false)
  assert.equal(readFileSync(join(source, 'node_modules/sentinel'), 'utf8'), 'keep')
}))
test('deploy cleanup is scoped and rejects empty workspace and linked parent', linux, () => fixture(root => {
  const harness = step('Build and pack DeepSeek Harness from source')
  const cleanup = harness.slice(harness.indexOf('test -n "$GITHUB_WORKSPACE"'), harness.indexOf('\ncorepack pnpm@12.2.0 --pm-on-fail=ignore --filter'))
  mkdirSync(join(root, '.deploy-tmp/engine-deploy'), { recursive: true })
  writeFileSync(join(root, '.deploy-tmp/sibling'), 'keep')
  assert.equal(bash(cleanup, root).status, 0)
  assert.equal(existsSync(join(root, '.deploy-tmp/engine-deploy')), false)
  assert.equal(readFileSync(join(root, '.deploy-tmp/sibling'), 'utf8'), 'keep')
  assert.ok(harness.includes('git show "$GITHUB_SHA:scripts/snapshot-config/engine-overlay.json" > scripts/snapshot-config/engine-overlay.json'))
  assert.notEqual(bash(cleanup, root, { GITHUB_WORKSPACE: '' }).status, 0)
  const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'sentinel'), 'keep')
  rmSync(join(root, '.deploy-tmp'), { recursive: true }); symlinkSync(other, join(root, '.deploy-tmp'))
  assert.notEqual(bash(cleanup, root).status, 0)
  assert.equal(readFileSync(join(other, 'sentinel'), 'utf8'), 'keep')
}))

// P1 回归（真实 rc3 演练发现）：合同读取曾在 `cd .deploy-tmp/deepseek-harness` 之后执行，
// 于是从 upstream 的 cwd 解析 ./scripts/contract.json —— 上游没有这个文件，frozen install
// 之后必然 MODULE_NOT_FOUND。这里直接跑工作流原文的初始化片段，确保合同在根目录读取。
test('source build reads the contract before entering the upstream checkout', linux, () => fixture(root => {
  const harnessStep = step('Build and pack DeepSeek Harness from source')
  const harness = join(root, '.deploy-tmp/deepseek-harness')
  mkdirSync(harness, { recursive: true })
  // 片段里的 git checkout/clean 需要真实仓库；用一个已提交的 upstream 夹具即可。
  const git = (...args) => execFileSync('git', ['-C', harness, ...args], {
    env: { PATH: join(root, 'bin') + ':/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(harness, 'package.json'), '{}\n')
  git('add', '.')
  git('commit', '-qm', 'upstream fixture')
  mkdirSync(join(root, 'scripts/snapshot-config'), { recursive: true })
  writeFileSync(join(root, 'scripts/snapshot-config/engine-overlay.json'), '{}\n')
  // 片段开头用 git show "$GITHUB_SHA:<overlay>" 恢复文件，夹具根也必须是已提交仓库。
  const projectGit = (...args) => execFileSync('git', ['-C', root, ...args], {
    env: { PATH: join(root, 'bin') + ':/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  projectGit('init', '-q')
  projectGit('config', 'user.name', 'Fixture')
  projectGit('config', 'user.email', 'fixture@example.invalid')
  projectGit('add', 'scripts/snapshot-config/engine-overlay.json')
  projectGit('commit', '-qm', 'project fixture')
  const projectCommit = projectGit('rev-parse', 'HEAD').toString().trim()
  const contractPath = join(root, 'scripts/contract.json')
  writeFileSync(contractPath, JSON.stringify({
    baseline: '9.9.9-rc.9',
    upstream: { commit: '0123456789abcdef0123456789abcdef01234567', packageManager: 'pnpm@9.9.9' },
  }))
  mkdirSync(join(root, 'bin'))
  // corepack 替身：报告一次成功安装，并且只在 expected_pnpm 已捕获时返回合同版本。
  writeFileSync(join(root, 'bin/corepack'), [
    '#!/bin/bash', 'set -eu',
    'if [ "$1" = enable ]; then exit 0; fi',
    'if [ "$1" = pnpm ]; then',
    '  if [ "$2" = install ]; then exit 0; fi',
    '  if [ "$2" = --version ]; then printf "%s\\n" "${FAKE_PNPM_VERSION:?}"; exit 0; fi',
    'fi',
    'echo "unexpected corepack invocation: $*" >&2; exit 64', '',
  ].join('\n'))
  chmodSync(join(root, 'bin/corepack'), 0o755)
  // 只跑合同捕获与 frozen install 校验；部署 pnpm@12.2.0 预热属于后续步骤。
  const script = harnessStep.slice(0, harnessStep.indexOf('\n# corepack\'s fetcher'))
  assert.ok(script.includes('corepack pnpm install --frozen-lockfile'))
  const run = extra => bash(script, root, { GITHUB_SHA: projectCommit, FAKE_PNPM_VERSION: '9.9.9', ...extra })

  const positive = run({})
  assert.equal(positive.status, 0, positive.stderr + positive.stdout)

  // upstream 自己的 scripts/ 不该被读成合同来源；真实上游此处没有 contract.json。
  mkdirSync(join(harness, 'scripts'), { recursive: true })
  writeFileSync(join(harness, 'scripts/contract.json'), JSON.stringify({
    baseline: '9.9.9-rc.9',
    upstream: { commit: '0123456789abcdef0123456789abcdef01234567', packageManager: 'pnpm@8.8.8' },
  }))
  const stillGood = run({})
  assert.equal(stillGood.status, 0, stillGood.stderr + stillGood.stdout)

  const wrongVersion = run({ FAKE_PNPM_VERSION: '9.9.8' })
  assert.notEqual(wrongVersion.status, 0, 'installed pnpm must match the captured contract version')
}))
