import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { patchBootAttribution } from '../data/boot-attribution.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const root = 'usr/lib/node_modules/@deepseek-ai/dsh'
const target = name => name === 'dsh-root' ? `${root}/lib/bin.js`
  : `${root}/node_modules/@deepseek-ai/${name}/lib/index.js`
const packages = [
  'dsh-root', 'dsh-app-boot', 'cordis-plugin-loader', 'cordis', 'dsh-web-app',
  'dsh-client-modules', 'dsh-host-webserver',
]
const reportPrefix = '[perf] boot-attribution '

test('real patch anchors are strict, compatible with neighboring patches, and idempotent', t => {
  const tempRoot = join(repo, '.deploy-tmp')
  mkdirSync(tempRoot, { recursive: true })
  const scratch = mkdtempSync(join(tempRoot, 'boot-attribution-test-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  for (const name of packages) {
    const file = join(scratch, target(name))
    mkdirSync(dirname(file), { recursive: true })
    copyFileSync(versionedFixture(name, 'lib', name === 'dsh-root' ? 'bin.js' : 'index.js'), file)
    copyFileSync(versionedFixture(name, 'package.json'), join(dirname(file), '..', 'package.json'))
  }

  const patches = 'managed-port-bind-EP1,profile-link-skip-PL1,combo-probe-P1,boot-attribution,perf-compile-cache-flush-N2,boot-third-party-isolation-G3'
  const runner = join(repo, 'scripts/patches/apply-patches.mjs')
  const apply = mode => spawnSync(process.execPath, [runner, scratch, mode, '--scope', 'engine', '--only', patches], { encoding: 'utf8' })
  const expectOk = result => assert.equal(result.status, 0, result.stdout + result.stderr)
  expectOk(apply('--apply'))
  expectOk(apply('--check'))
  assert.match(apply('--apply').stdout, /changed=0/)
  for (const name of packages) {
    expectOk(spawnSync(process.execPath, ['--check', join(scratch, target(name))], { encoding: 'utf8' }))
  }
  const bootFile = join(scratch, target('dsh-app-boot'))
  const patched = readFileSync(bootFile, 'utf8')
  assert.match(patched, /mark\("installation-scan-start"\)[\s\S]+mark\("installation-scan-end"\)/)
  writeFileSync(bootFile, patched.replace('mark("installation-scan-end")', 'mark("missing")'))
  const drift = apply('--check')
  assert.equal(drift.status, 1)
  assert.match(drift.stdout + drift.stderr, /boot attribution: partial patch/)
  assert.equal(apply('--apply').status, 1)

  const entryUrl = pathToFileURL(join(scratch, target('dsh-root'))).href
  const load = () => spawnSync(process.execPath, ['--input-type=module', '-e', `
    await import(${JSON.stringify(entryUrl)});
    console.log(Boolean(globalThis.__dshMobileBootAttribution));
    import { Worker } from "node:worker_threads";
    new Worker('import(' + ${JSON.stringify(JSON.stringify(entryUrl))} +
      ').then(() => console.log(Boolean(globalThis.__dshMobileBootAttribution)))', { eval: true });
  `], { encoding: 'utf8' })
  const disabled = load()
  expectOk(disabled)
  assert.equal(disabled.stdout.trim(), 'false\nfalse')
  writeFileSync(join(scratch, '.boot-attribution'), '')
  const enabled = load()
  expectOk(enabled)
  assert.equal(enabled.stdout.trim(), 'true\nfalse')
})

const fixture = name => readFileSync(versionedFixture(name, 'lib', name === 'dsh-root' ? 'bin.js' : 'index.js'), 'utf8')

test('production entry and inertia hooks attribute the P1 window and emit one bounded ranked report', async () => {
  const installed = name => patchBootAttribution(target(name), fixture(name))
  const entryCode = installed('cordis-plugin-loader').match(/^var Entry = class Entry \{[\s\S]*?^\};/m)[0]
  const inertiaCode = installed('cordis').match(/^\tasync _reload\(\) \{[\s\S]*?^\t\}/m)[0]
  const reportCode = installed('dsh-root').match(/^function createBootAttribution\(entryAt\) \{[\s\S]*?^\}/m)[0]
  let now = 0
  const logs = []
  const { Entry, reload, report, context } = runInNewContext(`
    ${reportCode}
    ${entryCode}
    globalThis.__dshMobileBootAttribution = createBootAttribution(3);
    ({ Entry, reload: ({ ${inertiaCode} })._reload, report: globalThis.__dshMobileBootAttribution, context: globalThis })
  `, { performance: { now: () => now }, process: { pid: 42, hrtime: { bigint: () => 100n } },
    console: { log: line => logs.push(line) } })

  const mark = (name, port) => report.mark(name, ++now + 3, port)
  mark('installation-scan-start')
  mark('installation-scan-end')
  mark('loader-arming')
  mark('loader-armed')
  mark('loader-mount-start')
  now += 3

  const runEntry = async (name, duration, failImport = false) => {
    const ctx = {
      emit() {}, reflect: { notify() {} }, logger: { error(error) { assert.equal(error.message, 'import failed') } },
      registry: {
        plugin() {
          const fiber = {
            entry, parent: { fiber: {} }, _runner: { epoch: 1 }, _store: {},
            _updateState(update) { update() },
            async _execute() {
              if (name !== 'plugin-12') await Promise.resolve()
              now += duration * 2
            },
            await: () => completion,
          }
          const completion = reload.call(fiber)
          return fiber
        },
      },
    }
    const loader = { ctx: { extend: () => ctx }, unwrapExports: value => value, showLog() {}, getTasks: () => [] }
    const entry = new Entry(loader)
    entry.options = { name, id: name }
    entry.parent = {
      tree: { ctx: { fiber: {} }, async import() {
        now += duration
        if (failImport) throw new Error('import failed')
        return {}
      } },
    }
    entry._patchContext = async () => { now += 2 }
    await entry.init()
    await entry.fiber?.await()
  }

  await runEntry('already-settled-before-P1', 200)
  const waitStarted = now
  for (let i = 1; i <= 12; i++) await runEntry(`plugin-${i}`, i)
  await runEntry('failed-import', 100, true)
  report.mark('listener-bound', now, 4145)
  report.mark('p1-wait-start', waitStarted)
  report.mark('p1-settled', now)
  report.mark('loader-settled', ++now)
  await runEntry('runtime-HMR', 1_000)
  report.mark('web-audit-complete', ++now)
  report.mark('url-announced', ++now)
  assert.equal(logs.length, 0)
  report.mark('startup-audit-complete', ++now)
  assert.equal(context.__dshMobileBootAttribution, undefined)
  assert.equal(logs.length, 1)
  assert.ok(logs[0].startsWith(reportPrefix))
  const parsed = JSON.parse(logs[0].slice(reportPrefix.length))
  assert.match(parsed.runId, /^42-100$/)
  assert.equal(parsed.clock, 'node-monotonic-ms')
  assert.equal(parsed.phases.find(phase => phase.name === 'listener-bound').port, 4145)
  assert.equal(parsed.phases[0].atMs, 0)
  assert.ok(parsed.phases.every((phase, index, phases) =>
    phase.deltaMs === phase.atMs - (phases[index - 1]?.atMs ?? 0)))
  assert.equal(parsed.loader.observedEntries, 14)
  assert.equal(parsed.loader.overlappingEntries, 13)
  assert.equal(parsed.loader.p1WaitMs, 358)
  assert.deepEqual(parsed.loader.top.map(row => row.name),
    ['failed-import', 'plugin-12', 'plugin-11', 'plugin-10', 'plugin-9', 'plugin-8', 'plugin-7', 'plugin-6', 'plugin-5', 'plugin-4'])
  assert.deepEqual(parsed.loader.top[0],
    { id: 'failed-import', name: 'failed-import', initTaskMs: 100, importMs: 100, inertiaMs: null, p1OverlapMs: 100 })
  assert.deepEqual(parsed.loader.top[1],
    { id: 'plugin-12', name: 'plugin-12', initTaskMs: 38, importMs: 12, inertiaMs: 24, p1OverlapMs: 38 })
  assert.deepEqual(parsed.loader.top[2],
    { id: 'plugin-11', name: 'plugin-11', initTaskMs: 13, importMs: 11, inertiaMs: 22, p1OverlapMs: 35 })
  const { loader } = parsed
  console.log(`boot-attribution fixture: p1WaitMs=${loader.p1WaitMs} top=${loader.top.length}/${loader.overlappingEntries} `
    + JSON.stringify(loader.top[1]))
})
