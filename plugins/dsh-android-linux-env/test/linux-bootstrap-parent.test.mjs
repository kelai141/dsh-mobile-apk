import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import * as host from '../lib/index.js'

test('the actual host publishes bootstrap after its parent fiber activates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-parent-'))
  const old = { files: process.env.DSH_FILES_DIR, version: process.env.DSH_APP_VERSION }
  process.env.DSH_FILES_DIR = dir
  process.env.DSH_APP_VERSION = '0.14.9'
  const ctx = new Context()
  const fibers = []
  ctx.on('internal/plugin', fiber => { fibers.push(fiber) })
  ctx.provide('tools', { register: () => () => {} })
  ctx.provide('webServer', { register: () => () => {} })
  ctx.provide('androidPrivilege', { status: () => ({ tier: 'T0' }) })
  try {
    const fiber = ctx.plugin(host)
    await fiber
    const deadline = Date.now() + 3000
    while (!ctx.get('linuxBootstrap') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const service = ctx.get('linuxBootstrap')
    if (!service) t.diagnostic(JSON.stringify(fibers.map(f => ({ name: f.runtime?.name, state: f.state, error: String(f._error) }))))
    assert.ok(service, `bootstrap is absent; parent state=${fiber.state}`)
    assert.equal((await service.status()).installed, false)
  } finally {
    await ctx.fiber.dispose()
    if (old.files === undefined) delete process.env.DSH_FILES_DIR; else process.env.DSH_FILES_DIR = old.files
    if (old.version === undefined) delete process.env.DSH_APP_VERSION; else process.env.DSH_APP_VERSION = old.version
    await rm(dir, { recursive: true, force: true })
  }
})
