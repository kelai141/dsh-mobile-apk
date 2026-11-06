/**
 * 冷启动恢复的**工具面**验收：只证明 Cordis fiber ACTIVE 不够。
 *
 * runtime 插件在 `apply()` 时同步一次工具注册，是否注册取决于 `manager.status().healthy`；
 * 而 `status()` 直接读 `active.json`，所以「恢复后工具真的在场」可以离线断言：
 * 有健康记录就有工具，没有健康记录就一个都不注册。本用例用真实 Cordis 上下文跑这条链路。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { cordisScope } from '../lib/linux-environment.js'

const RUNTIME_ENTRY = 'lib/index.js'

/** A runtime bundle shaped like the real one: tools only while the manager is healthy. */
const RUNTIME_SOURCE = `
export function apply(ctx, config) {
  const healthy = config.healthy === true
  const names = []
  const disposers = []
  if (healthy) {
    disposers.push(ctx.tools.register({ name: 'linux_bash', description: 'x', parameters: {}, execute: async () => ({}) }))
    disposers.push(ctx.tools.register({ name: 'linux_session', description: 'x', parameters: {}, execute: async () => ({}) }))
    names.push('linux_bash', 'linux_session')
  }
  // Same lifecycle rule as the real runtime: the scope's effect owns the registrations.
  ctx.effect(() => () => { for (const dispose of disposers) dispose() })
  ctx.provide('linuxRuntimeManager', {
    install: async () => {},
    uninstall: async () => {},
    status: async () => ({ healthy, runtimeId: 'debian-minimal' }),
  })
  return { registered: names }
}
`

async function bundle(root) {
  const directory = join(root, 'runtime')
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  await writeFile(join(directory, RUNTIME_ENTRY), RUNTIME_SOURCE)
  return directory
}

function recordingContext() {
  const ctx = new Context()
  const names = []
  ctx.provide('tools', {
    register(tool) {
      names.push(tool.name)
      return () => { const at = names.indexOf(tool.name); if (at >= 0) names.splice(at, 1) }
    },
  })
  return { ctx, names }
}

test('restoring a healthy installation registers the real Linux tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-restore-tools-'))
  const { ctx, names } = recordingContext()
  try {
    const directory = await bundle(root)
    const scope = cordisScope(ctx.plugin(await import(pathToFileURL(join(directory, RUNTIME_ENTRY)).href), { healthy: true }))
    await scope.ready
    assert.deepEqual(names, ['linux_bash', 'linux_session'], 'a healthy restore must expose both tools')
    assert.equal(typeof scope.get('linuxRuntimeManager').install, 'function')
    await scope.dispose()
    assert.deepEqual(names, [], 'disposing the restored scope must withdraw the tools')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('an unhealthy installation activates without exposing unusable tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-restore-unhealthy-'))
  const { ctx, names } = recordingContext()
  try {
    const directory = await bundle(root)
    const scope = cordisScope(ctx.plugin(await import(pathToFileURL(join(directory, RUNTIME_ENTRY)).href), { healthy: false }))
    await scope.ready
    assert.deepEqual(names, [], 'no tool may appear while the runtime is unhealthy')
    assert.equal((await scope.get('linuxRuntimeManager').status()).healthy, false)
    await scope.dispose()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
