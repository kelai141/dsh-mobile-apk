import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createLinuxLifecycle } from '../lib/linux-lifecycle.js'
import { createLinuxPluginHost } from '../lib/linux-environment.js'

test('DSH can answer immediately during deferred Linux restore and follows actual status', async () => {
  const lifecycle = createLinuxLifecycle()
  let ready, listener, unsubscribed = false
  const pending = lifecycle.attach({
    status: () => new Promise(resolve => { ready = resolve }),
    subscribe: callback => { listener = callback; return () => { unsubscribed = true } },
  })
  assert.equal(lifecycle.snapshot().phase, 'starting')
  assert.match(lifecycle.snapshot().message, /仍在启动/)
  ready({ installed: true, enabled: true, injectionActivated: true, runtime: { healthy: true } })
  await pending
  assert.equal(lifecycle.snapshot().ready, true)
  listener({ installed: true, operation: 'reinstalling', busy: true })
  assert.equal(lifecycle.snapshot().phase, 'starting')
  listener({ installed: true, enabled: false })
  assert.equal(lifecycle.snapshot().phase, 'disabled')
  listener({ installed: false })
  assert.equal(lifecycle.snapshot().phase, 'not-installed')
  listener({ installed: true, lastError: 'bad digest' })
  assert.equal(lifecycle.snapshot().phase, 'failed')
  lifecycle.stop(); lifecycle.stopped()
  assert.equal(unsubscribed, true)
  listener({ installed: true, enabled: true, injectionActivated: true })
  assert.equal(lifecycle.snapshot().phase, 'stopped', 'late restore cannot resurrect a stopped engine')
})

test('shutdown cancels a pending import and rejects future activation without deleting installed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-stop-race-'))
  const directory = join(root, 'runtime')
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'lib/index.js'), 'export function apply() {}')
  let imported, finish
  const entered = new Promise(resolve => { imported = resolve })
  const host = createLinuxPluginHost({ root, activate: () => { throw Error('must not activate') },
    importModule: async () => { imported(); return new Promise(resolve => { finish = resolve }) } })
  try {
    const installing = host.install({ directory })
    await entered
    const shutdown = host.shutdown()
    finish({ apply() {} })
    await assert.rejects(installing, { code: 'LINUX_ENGINE_STOPPING' })
    await shutdown
    await assert.rejects(host.install({ directory }), { code: 'LINUX_ENGINE_STOPPING' })
    assert.equal((await host.isInjected({ directory })).injected, true)
    assert.equal((await host.isInjected({ directory })).active, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('SIGTERM drains Linux once and exits without hanging on live handles', { skip: process.platform === 'win32', timeout: 12000 }, async () => {
  const source = `import {onEngineShutdown} from ${JSON.stringify(new URL('../lib/linux-lifecycle.js', import.meta.url).href)};
    onEngineShutdown(async () => { console.log('draining'); await new Promise(r => setTimeout(r, 150)); console.log('drained'); });
    setInterval(() => {}, 1000); console.log('ready');`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { error += chunk })
  const exited = once(child, 'exit')
  try {
    while (!output.includes('ready')) {
      if (child.exitCode !== null) throw Error(error)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    child.kill('SIGTERM'); child.kill('SIGTERM')
    assert.deepEqual(await exited, [0, null], error)
    assert.equal(output.match(/draining/g)?.length, 1)
    assert.match(output, /drained/)
  } finally { child.kill('SIGKILL') }
})
