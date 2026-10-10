import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureProjectInputs, captureProjectOutputs } from './record-project-components.mjs'

const dirs = ['dsh-shell-termux', 'dsh-client-ui-responsive', 'dsh-host-web-compat']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'project-components-'))
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(root, '.gitignore'), '.deploy-tmp/\ndsh-shell-termux/lib/\ndsh-client-ui-responsive/lib/\n')
  for (const directory of dirs) {
    mkdirSync(join(root, directory, 'src'), { recursive: true })
    mkdirSync(join(root, directory, 'lib'))
    writeFileSync(join(root, directory, 'src/index.ts'), 'export const value = 1\n')
    writeFileSync(join(root, directory, 'lib/index.js'), 'export const value = 1\n')
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name: `@dsh-android/${directory}`, version: '1.0.0', dependencies: { '@deepseek-ai/cordis': '4.0.4' } }) + '\n')
  }
  mkdirSync(join(root, 'scripts/snapshot-config'), { recursive: true })
  mkdirSync(join(root, 'scripts/source-build'))
  copyFileSync(join(import.meta.dirname, 'record-project-components.mjs'), join(root, 'scripts/source-build/record-project-components.mjs'))
  writeFileSync(join(root, 'scripts/snapshot-config/engine-overlay.json'), '{"packages":{"@deepseek-ai/cordis":"4.0.4"}}\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const commit = git('rev-parse', 'HEAD')
  try { return fn({ root, commit }) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('project component source files and actual built outputs bind to the same commit', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  assert.equal(inputs.projectCommit, commit)
  assert.equal(inputs.sourceRepository, 'https://github.com/kelai141/dsh-mobile-apk')
  for (const directory of dirs) {
    const record = inputs.components[directory]
    assert.equal(record.sourceCommit, commit)
    assert.equal(record.packageName, `@dsh-android/${directory}`)
    assert.equal(record.inputFiles['src/index.ts'], sha256(readFileSync(join(root, directory, 'src/index.ts'))))
  }
  assert.ok(inputs.components['dsh-host-web-compat'].inputFiles['lib/index.js'])
  assert.equal(inputs.components['dsh-shell-termux'].inputFiles['lib/index.js'], undefined)
  writeFileSync(join(root, 'dsh-shell-termux/lib/index.js'), 'new build output\n')
  const outputs = captureProjectOutputs(root, commit, inputs)
  assert.equal(outputs.components['dsh-shell-termux'].outputFiles['lib/index.js'], sha256(Buffer.from('new build output\n')))
  assert.equal(inputs.components['dsh-shell-termux'].outputFiles, undefined)
}))

test('dirty tracked and untracked component inputs cannot claim committed provenance', () => fixture(({ root, commit }) => {
  const tracked = join(root, 'dsh-shell-termux/src/index.ts')
  writeFileSync(tracked, 'dirty source')
  assert.throws(() => captureProjectInputs(root, commit), /differs from project commit/)
  writeFileSync(tracked, 'export const value = 1\n')
  writeFileSync(join(root, 'dsh-shell-termux/src/untracked.ts'), 'extra source')
  assert.throws(() => captureProjectInputs(root, commit), /untracked component inputs/)
}))

test('outputs reject a stale input report and a changed checked-in host payload', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  assert.throws(() => captureProjectOutputs(root, commit, { ...inputs, projectCommit: '0'.repeat(40) }), /different commit/)
  writeFileSync(join(root, 'dsh-host-web-compat/lib/index.js'), 'unexpected replacement')
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /committed JavaScript source/)
}))

test('missing output and changed manifest fail rather than producing incomplete provenance', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  rmSync(join(root, 'dsh-shell-termux/lib/index.js'))
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /did not produce lib\/index.js/)
  writeFileSync(join(root, 'dsh-shell-termux/lib/index.js'), 'output')
  writeFileSync(join(root, 'dsh-shell-termux/package.json'), '{}')
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /manifest changed/)
}))

test('component input provenance preserves the engine-overlay Cordis pin check', () => fixture(({ root, commit }) => {
  writeFileSync(join(root, 'scripts/snapshot-config/engine-overlay.json'), '{"packages":{"@deepseek-ai/cordis":"wrong"}}')
  assert.throws(() => captureProjectInputs(root, commit), /Cordis dependency differs/)
}))

test('a source rewrite during build cannot be attributed to the original input commit', () => fixture(({ root, commit }) => {
  const inputs = captureProjectInputs(root, commit)
  writeFileSync(join(root, 'dsh-client-ui-responsive/src/index.ts'), 'unexpected source rewrite')
  assert.throws(() => captureProjectOutputs(root, commit, inputs), /source changed during build/)
}))

test('actual source workflow verifies project components without an independent host checkout', { skip: process.platform !== 'linux' }, () => fixture(({ root, commit }) => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/build-apk-source.yml'), 'utf8').replaceAll('\r\n', '\n')
  const start = workflow.indexOf('      - name: Checkout pinned component sources\n')
  const end = workflow.indexOf('          marketplace_tarball=', start)
  assert.ok(start > 0 && end > start)
  const block = workflow.slice(start, end)
  assert.equal(block.includes('git clone'), false)
  assert.equal(workflow.includes('component-sources/host-web-compat'), false)
  assert.equal(workflow.includes('2de902729e01eb3619aa50bdfa164c5231948848'), false)
  const script = block.slice(block.indexOf('        run: |\n') + '        run: |\n'.length).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
  const result = spawnSync('/bin/bash', ['-e', '-c', script], { cwd: root, env: { ...process.env, GITHUB_SHA: commit }, encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  const report = JSON.parse(readFileSync(join(root, '.deploy-tmp/source-build/project-component-provenance.json'), 'utf8'))
  assert.deepEqual(Object.keys(report.components), dirs)
  assert.equal(report.projectCommit, commit)
}))
