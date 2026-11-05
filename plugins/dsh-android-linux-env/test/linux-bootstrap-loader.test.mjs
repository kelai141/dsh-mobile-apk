import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { importLinuxBootstrap, mountLinuxBootstrap, readLinuxManifest, LINUX_BOOTSTRAP_SPECIFIER } from '../lib/linux-bootstrap-loader.js'

test('bootstrap is imported by package name and both export shapes are accepted', async () => {
  const seen = []
  const named = await importLinuxBootstrap({
    importModule: async specifier => { seen.push(specifier); return { name: 'x', inject: ['linuxPluginHost'], apply() {} } },
  })
  assert.deepEqual(seen, [LINUX_BOOTSTRAP_SPECIFIER])
  assert.equal(named.name, 'x')
  assert.deepEqual(named.inject, ['linuxPluginHost'])

  const viaDefault = await importLinuxBootstrap({
    importModule: async () => ({ default: { name: 'dsh-linux-bootstrap', apply() {} } }),
  })
  assert.equal(viaDefault.name, 'dsh-linux-bootstrap')
  assert.equal(typeof viaDefault.apply, 'function')

  await assert.rejects(importLinuxBootstrap({ importModule: async () => ({}) }), /未导出 apply\(\)/)
  await assert.rejects(importLinuxBootstrap({ importModule: async () => { throw new Error('boom') } }), /无法加载 Linux bootstrap 插件/)
})

test('mounting publishes linuxBootstrap through the real Cordis lifecycle', async () => {
  const ctx = new Context()
  // The real bootstrap injects linuxPluginHost; the host provides it before mounting.
  ctx.provide('linuxPluginHost', { install: async () => {}, uninstall: async () => {}, isInjected: async () => ({ injected: false, active: false }) })
  try {
    // The loader must not invent config: what the host passes is what apply() sees.
    const config = { dataDir: '/data/linux-environment', appVersionProvider: () => '0.15.0' }
    let received
    await mountLinuxBootstrap(ctx, {
      config,
      importModule: async () => ({
        name: 'dsh-linux-bootstrap',
        inject: ['linuxPluginHost'],
        apply(scope, value) { received = value; scope.provide('linuxBootstrap', { marker: true }) },
      }),
    })
    assert.equal(ctx.get('linuxBootstrap').marker, true)
    assert.equal(received, config)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('manifest route reads only the persisted check/pinned manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-manifest-'))
  try {
    assert.equal(readLinuxManifest(dir), null, 'a missing state file is not an error')
    const pinned = { version: '1.0.0', plugins: { runtime: { sha256: 'a'.repeat(64) } } }
    const available = { version: '1.1.0', plugins: { runtime: { sha256: 'b'.repeat(64) } } }
    await writeFile(join(dir, 'linux-bootstrap-state.json'), JSON.stringify({ schemaVersion: 1, pinnedManifest: pinned }))
    assert.deepEqual(readLinuxManifest(dir), pinned)
    // A manual check wins over the pinned version, so the UI prepares the newer asset.
    await writeFile(join(dir, 'linux-bootstrap-state.json'), JSON.stringify({ schemaVersion: 1, pinnedManifest: pinned, availableManifest: available }))
    assert.deepEqual(readLinuxManifest(dir), available)
    await writeFile(join(dir, 'linux-bootstrap-state.json'), '{not json')
    assert.equal(readLinuxManifest(dir), null, 'a corrupt state file must not throw')
    await writeFile(join(dir, 'linux-bootstrap-state.json'), JSON.stringify({ schemaVersion: 1 }))
    assert.equal(readLinuxManifest(dir), null, 'never checked means no manifest')
    await mkdir(join(dir, 'nested'), { recursive: true })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
