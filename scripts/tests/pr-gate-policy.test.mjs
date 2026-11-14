import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const registry = readFileSync(join(root, 'scripts/check-release-gates.mjs'), 'utf8')
const read = (file) => readFileSync(join(root, file), 'utf8')

// Exercise the production declarations and sink guard without importing the CLI:
// an import runs every wiring/syntax check and exits the test process. Keep these
// explicit boundaries fail-closed if the CLI is reorganized; no repository edits,
// APK build, dependency install, or per-gate subprocesses are needed here.
const section = (start, end) => {
  const i = registry.indexOf(start)
  const j = registry.indexOf(end, i + start.length)
  assert.ok(i >= 0 && j > i, 'production section remains available: ' + start)
  return registry.slice(i, j)
}
const policy = runInNewContext(section('const GATES = [', "if (argv.includes('--list'))")
  + '\nJSON.stringify({ GATES, CI_APK_GATES, ALL_GATES, RELEASE_GATES, RELEASE_EXCLUDED, SINK_KINDS })', { join })
const { GATES, CI_APK_GATES, ALL_GATES, RELEASE_GATES, RELEASE_EXCLUDED, SINK_KINDS } = JSON.parse(policy)
const sinkCallsGate = runInNewContext('('
  + section('export function sinkCallsGate(', '\n/**').replace('export ', '') + ')')

const retained = ['check-snapshot-decode.mjs', 'check-native-linux-loader.mjs']
const transferred = ['check-tool-output-schema.mjs', 'check-plugin-tests.mjs']
const localFile = 'scripts/build-apk-013.ps1'
const cloudFile = 'scripts/build-apk.mjs'
const workflow = '.github/workflows/pr-gate.yml'

test('APK CI declares exactly the retained compile probes, not removed static business gates', () => {
  assert.deepEqual(CI_APK_GATES, retained)
  const compile = read(workflow).split('\n  compile:')[1]?.split('\n  maintenance:')[0]
  assert.ok(compile, 'existing compile job is present')
  for (const script of retained) assert.ok(sinkCallsGate(compile, script, workflow), script)
  const count = GATES.find((g) => g.script === 'check-kotlin-test-count.mjs')
  assert.equal(count.ciApk, false)
  assert.equal(count.releaseSink, false)
  assert.equal(count.sink, 'apk-ci')
  assert.ok(sinkCallsGate(compile, count.script, workflow))
})

test('schema and plugin tests transfer to the existing local build sink, not another PR job', () => {
  for (const script of transferred) {
    const gate = GATES.find((g) => g.script === script)
    assert.equal(gate.ciApk, false)
    assert.equal(gate.releaseSink, false)
    assert.equal(gate.sink, 'local-chain')
    assert.ok(ALL_GATES.includes(script), 'full build declaration retains ' + script)
    assert.ok(!RELEASE_GATES.includes(script), 'release --run exclusions remain unchanged')
    assert.ok(sinkCallsGate(read(localFile), script, localFile), 'actual local call: ' + script)
    assert.ok(sinkCallsGate(read(cloudFile), script, cloudFile), 'actual cloud call: ' + script)
    assert.ok(!sinkCallsGate(read(workflow), script, workflow), 'no transfer to a PR blocking job')
  }
})

// Run the actual release-excluded sink assertion block with in-memory files. It
// must still reject a commented-out build call even when its filename remains.
const sinkGuard = section('{\n  for (const g of RELEASE_EXCLUDED)', '// ── 3b.')
const checkSinks = (files) => {
  const checks = []
  runInNewContext(sinkGuard, {
    RELEASE_EXCLUDED, SINK_KINDS, sinkCallsGate, join,
    ROOT: root, APK_TREE: root, apkTreePresent: true,
    existsSync: (file) => files.has(file),
    readFileSync: (file) => {
      assert.ok(files.has(file), 'fixture sink file is present')
      return files.get(file)
    },
    rel: (file) => file,
    check: (label, ok, detail) => checks.push({ label, ok, detail }),
    skipStatic: () => assert.fail('present APK tree must not skip sink checks'),
  })
  assert.equal(checks.length, RELEASE_EXCLUDED.length, 'all excluded gates are checked')
  return checks.filter((c) => !c.ok)
}
const sinkFiles = () => new Map([
  [join(root, localFile), read(localFile)],
  [join(root, workflow), read(workflow)],
])

test('every release-excluded gate retains a real sink after narrowing APK CI', () => {
  assert.deepEqual(checkSinks(sinkFiles()), [])
})

for (const script of transferred) {
  test('controlled negative: missing actual local build call rejects ' + script, () => {
    const files = sinkFiles()
    const localPath = join(root, localFile)
    let disabled = 0
    files.set(localPath, files.get(localPath).split(/\r?\n/).map((line) => {
      if (!sinkCallsGate(line, script, localFile)) return line
      disabled += 1
      return '# DISABLED: ' + line
    }).join('\n'))
    assert.ok(disabled > 0, 'negative disables an actual build call')
    assert.ok(files.get(localPath).includes(script), 'filename still appears, so includes() is insufficient')
    const failures = checkSinks(files)
    assert.equal(failures.length, 1)
    assert.ok(failures[0].label.includes(script + ' @ local-chain'))
    assert.match(failures[0].detail, /真实执行点/)
  })
}
