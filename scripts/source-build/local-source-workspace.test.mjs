import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { committedWorkflow, prepareSourceWorkspace, sourceCommit } from './local-source-workspace.mjs'

function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'local-source-safety-'))
  const source = join(root, 'source')
  mkdirSync(join(source, 'vendor/dshmarketplace-plugin'), { recursive: true })
  mkdirSync(join(source, 'scripts/snapshot-config'), { recursive: true })
  mkdirSync(join(source, '.github/workflows'), { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(source, 'vendor/dshmarketplace-plugin/tracked.js'), 'committed marketplace\n')
  writeFileSync(join(source, 'scripts/snapshot-config/engine-overlay.json'), '{"committed":true}\n')
  writeFileSync(join(source, '.github/workflows/build-apk-source.yml'), 'committed workflow\n')
  writeFileSync(join(source, '.gitignore'), '.deploy-tmp/\nbase/\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  try { return fn({ root, source, git, commit: sourceCommit(source) }) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

const linux = { skip: process.platform !== 'linux' }
test('dirty tracked, untracked and ignored source files survive successful and interrupted destructive steps', linux, () => fixture(({ root, source, commit }) => {
  writeFileSync(join(source, 'vendor/dshmarketplace-plugin/tracked.js'), 'uncommitted marketplace\n')
  writeFileSync(join(source, 'vendor/dshmarketplace-plugin/extra.txt'), 'untracked user data\n')
  writeFileSync(join(source, 'scripts/snapshot-config/engine-overlay.json'), '{"local":true}\n')
  mkdirSync(join(source, 'base'))
  writeFileSync(join(source, 'base/sentinel.tar.xz'), 'ignored base bytes\n')
  for (const ending of ['exit 0', 'exit 23', 'kill -TERM $$']) {
    const workspace = prepareSourceWorkspace(source, commit, join(root, ending.replaceAll(' ', '-').replaceAll('$', 'x')))
    assert.equal(readFileSync(join(workspace, 'vendor/dshmarketplace-plugin/tracked.js'), 'utf8'), 'committed marketplace\n')
    assert.equal(existsSync(join(workspace, 'vendor/dshmarketplace-plugin/extra.txt')), false)
    const result = spawnSync('/bin/bash', ['-e', '-c', [
      'test "$PWD" = "$GITHUB_WORKSPACE"',
      'test "$DSH_APK_DIR" = "$GITHUB_WORKSPACE"',
      'rm -rf vendor/dshmarketplace-plugin',
      'git show "$GITHUB_SHA:scripts/snapshot-config/engine-overlay.json" > scripts/snapshot-config/engine-overlay.json',
      ending,
    ].join('\n')], { cwd: workspace, env: { ...process.env, GITHUB_WORKSPACE: workspace, DSH_APK_DIR: workspace, GITHUB_SHA: commit } })
    if (ending === 'exit 0') assert.equal(result.status, 0)
    else if (ending === 'exit 23') assert.equal(result.status, 23)
    else assert.equal(result.signal, 'SIGTERM')
    assert.equal(readFileSync(join(source, 'vendor/dshmarketplace-plugin/tracked.js'), 'utf8'), 'uncommitted marketplace\n')
    assert.equal(readFileSync(join(source, 'vendor/dshmarketplace-plugin/extra.txt'), 'utf8'), 'untracked user data\n')
    assert.equal(readFileSync(join(source, 'scripts/snapshot-config/engine-overlay.json'), 'utf8'), '{"local":true}\n')
    assert.equal(readFileSync(join(source, 'base/sentinel.tar.xz'), 'utf8'), 'ignored base bytes\n')
    assert.equal(prepareSourceWorkspace(source, commit, workspace), workspace)
  }
}))

test('reject source, ancestors, descendants and aliases through symlinks before any clone', linux, () => fixture(({ root, source, commit }) => {
  const alias = join(root, 'source-link')
  symlinkSync(source, alias)
  for (const path of [source, root, join(source, 'new-build'), alias, join(alias, 'nested')]) {
    assert.throws(() => prepareSourceWorkspace(source, commit, path), /工作树之外/)
  }
  assert.equal(existsSync(join(source, 'new-build')), false)
  assert.equal(existsSync(join(source, 'nested')), false)
}))

test('unknown nonempty directories and stale HEAD cannot be reused or cleaned', linux, () => fixture(({ root, source, git, commit }) => {
  const unknown = join(root, 'unknown')
  mkdirSync(unknown)
  writeFileSync(join(unknown, 'sentinel'), 'keep')
  assert.throws(() => prepareSourceWorkspace(source, commit, unknown), /未登记/)
  assert.equal(readFileSync(join(unknown, 'sentinel'), 'utf8'), 'keep')
  const workspace = prepareSourceWorkspace(source, commit, join(root, 'build'))
  writeFileSync(join(workspace, 'retained-artifact'), 'keep')
  writeFileSync(join(source, 'new.txt'), 'new HEAD')
  git('add', 'new.txt')
  git('commit', '-qm', 'next')
  assert.throws(() => prepareSourceWorkspace(source, sourceCommit(source), workspace), /HEAD 不匹配/)
  assert.equal(readFileSync(join(workspace, 'retained-artifact'), 'utf8'), 'keep')
}))

test('TMPDIR inside the source is rejected before creating any directory', linux, () => fixture(({ source, commit }) => {
  const before = readdirSync(source)
  const previous = process.env.TMPDIR
  process.env.TMPDIR = source
  try { assert.throws(() => prepareSourceWorkspace(source, commit), /临时目录位于原工作树内/) }
  finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
  assert.deepEqual(readdirSync(source), before)
}))

test('resume rejects linked .git and workflow write directories escaping the workspace', linux, () => fixture(({ root, source, commit }) => {
  const workspace = prepareSourceWorkspace(source, commit, join(root, 'build'))
  symlinkSync(source, join(workspace, '.deploy-tmp'))
  assert.throws(() => prepareSourceWorkspace(source, commit, workspace), /逃出/)
  rmSync(join(workspace, '.deploy-tmp'))
  rmSync(join(workspace, '.git'), { recursive: true, force: true })
  symlinkSync(join(source, '.git'), join(workspace, '.git'))
  assert.throws(() => prepareSourceWorkspace(source, commit, workspace), /独立 Git/)
}))

test('workflow selection uses committed bytes, even with a modified working copy', linux, () => fixture(({ source, commit }) => {
  writeFileSync(join(source, '.github/workflows/build-apk-source.yml'), 'uncommitted commands')
  assert.equal(committedWorkflow(source, commit), 'committed workflow')
}))

test('resume rejects deep source aliases and Git object alternates', linux, () => fixture(({ root, source, commit }) => {
  const workspace = prepareSourceWorkspace(source, commit, join(root, 'build'))
  mkdirSync(join(workspace, '.deploy-tmp'))
  symlinkSync(source, join(workspace, '.deploy-tmp/deepseek-harness'))
  assert.throws(() => prepareSourceWorkspace(source, commit, workspace), /链接可触及原工作树/)
  rmSync(join(workspace, '.deploy-tmp/deepseek-harness'))
  mkdirSync(join(workspace, '.deploy-tmp/deepseek-harness'))
  writeFileSync(join(workspace, '.deploy-tmp/deepseek-harness/.git'), `gitdir: ${join(source, '.git')}\n`)
  assert.throws(() => prepareSourceWorkspace(source, commit, workspace), /Git 链接可触及原工作树/)
  rmSync(join(workspace, '.deploy-tmp/deepseek-harness'), { recursive: true })
  symlinkSync(join(source, 'scripts/snapshot-config/engine-overlay.json'), join(workspace, 'scripts/check-engine-overlay.mjs'))
  assert.throws(() => prepareSourceWorkspace(source, commit, workspace), /链接可触及原工作树/)
  rmSync(join(workspace, 'scripts/check-engine-overlay.mjs'))
  writeFileSync(join(workspace, '.git/objects/info/alternates'), join(source, '.git/objects') + '\n')
  assert.throws(() => prepareSourceWorkspace(source, commit, workspace), /独立 Git/)
}))

test('actual local runner routes cwd and build environment into isolation and keeps failed output for resume', linux, () => fixture(({ root, source, git }) => {
  const scriptDir = join(source, 'scripts/source-build')
  mkdirSync(scriptDir)
  for (const file of ['run-local-source-chain.mjs', 'local-source-workspace.mjs']) copyFileSync(join(import.meta.dirname, file), join(scriptDir, file))
  writeFileSync(join(source, '.github/workflows/build-apk-source.yml'), [
    'jobs:', '  build:', '    steps:',
    '      - name: Checkout pinned fixture source', '        shell: bash', '        run: |',
    '          test "$PWD" = "$GITHUB_WORKSPACE"',
    '          test "$DSH_APK_DIR" = "$GITHUB_WORKSPACE"',
    '          test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
    '          rm -rf vendor/dshmarketplace-plugin',
    '          git show "$GITHUB_SHA:scripts/snapshot-config/engine-overlay.json" > scripts/snapshot-config/engine-overlay.json',
    '          printf isolated > result.txt', '          exit 23', '',
  ].join('\n'))
  git('add', '.')
  git('commit', '-qm', 'runner fixture')
  writeFileSync(join(source, 'vendor/dshmarketplace-plugin/extra.txt'), 'keep')
  writeFileSync(join(source, 'scripts/snapshot-config/engine-overlay.json'), 'local config')
  const sdk = join(root, 'sdk')
  mkdirSync(join(sdk, 'build-tools/36.0.0'), { recursive: true })
  mkdirSync(join(sdk, 'platforms/android-36'), { recursive: true })
  writeFileSync(join(sdk, 'build-tools/36.0.0/apksigner'), 'fixture')
  writeFileSync(join(sdk, 'platforms/android-36/android.jar'), 'fixture')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  for (const command of ['python', 'python3', 'java', 'xz', 'gpg', 'unzip', 'curl', 'tar']) {
    writeFileSync(join(bin, command), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, command), 0o755)
  }
  const workspace = join(root, 'runner-build')
  const result = spawnSync(process.execPath, [join(scriptDir, 'run-local-source-chain.mjs'), '--only', 'sources', '--build-workspace', workspace], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: root, ANDROID_HOME: sdk, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
  })
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.ok(result.stderr.includes('--build-workspace'))
  assert.equal(readFileSync(join(workspace, 'result.txt'), 'utf8'), 'isolated')
  assert.equal(readFileSync(join(source, 'vendor/dshmarketplace-plugin/extra.txt'), 'utf8'), 'keep')
  assert.equal(readFileSync(join(source, 'scripts/snapshot-config/engine-overlay.json'), 'utf8'), 'local config')
  assert.equal(existsSync(join(source, 'result.txt')), false)
}))
