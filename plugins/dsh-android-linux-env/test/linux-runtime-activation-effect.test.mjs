/**
 * 回归：安装链必须能装上一个 `apply()` 解析为 **manager 对象** 的运行时插件。
 *
 * 为什么单独立文件：缺陷不在下载、不在解包、也不在摘要——资产全部下载并通过复验之后，
 * 宿主把模块原样交给 Cordis，而 Cordis 对 `apply()` 的返回值只有三种合法语义
 * （函数 = disposer、thenable / 可迭代 = effect 收集、其它 = 非法）。真实的
 * @dsh-android/linux-runtime 的 `apply()` 返回 `LinuxRuntimeManager`，于是 fiber 以
 * `Invalid effect` 进入错误态，安装每次都报失败，但磁盘上什么都不缺。
 *
 * 判据分两层：
 *   1. 反证：用**未包装**的 apply 直接交给 Cordis，必须复现 `Invalid effect`（证明这条用例
 *      真的踩在缺陷上，而不是因为实现换了个写法才变绿）；
 *   2. 正例：走 `createLinuxPluginHost().install()` 全链路，fiber 必须 ACTIVE、必须交出 manager
 *      （即使插件只返回 manager 而不 `provide` 服务）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { cordisScope, createLinuxPluginHost, effectSafeApply } from '../lib/linux-environment.js'

/** 与真实 runtime 同形：apply 解析为 manager 对象（真实包在 async 函数里返回它）。 */
const RETURNS_MANAGER = `
export async function apply(ctx, config) {
  const manager = {
    install: async () => {},
    uninstall: async () => {},
    status: () => ({ healthy: false, runtimeId: 'debian-minimal-x64' }),
  }
  if (config.publish === true) ctx.provide('linuxRuntimeManager', manager)
  return manager
}
`

/** 返回 disposer 的合法插件：包装不能把它吞掉。 */
const RETURNS_DISPOSER = `
export async function apply() {
  globalThis.__linuxDisposed = false
  return () => { globalThis.__linuxDisposed = true }
}
`

async function bundle(root, source) {
  const directory = join(root, 'runtime')
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), '{"type":"module"}')
  await writeFile(join(directory, 'lib', 'index.js'), source)
  return directory
}

test('反驳基线：未包装的 manager 返回值会被 Cordis 判成 Invalid effect', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-effect-baseline-'))
  const ctx = new Context()
  try {
    const directory = await bundle(root, RETURNS_MANAGER)
    const module = await import('file://' + join(directory, 'lib', 'index.js'))
    const fiber = ctx.plugin(module, {})
    await assert.rejects(async () => { await fiber }, /Invalid effect/, '若这里不再报错，说明本用例已脱离缺陷现场，须重新取证')
    // `FiberState` 是 cordis 的 const enum（运行期无导出，见 linux-environment.test.mjs 的转译取法）；
    // 2 = ACTIVE，其余（3 = ERROR / 4 = DISPOSED）都足以证明这条 fiber 没有成功激活。
    assert.notEqual(fiber.state, 2, 'calling a plugin with a non-effect return must not leave it ACTIVE')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('安装链：apply 解析为 manager 的运行时插件必须真的激活并交出 manager', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-effect-install-'))
  const ctx = new Context()
  try {
    const directory = await bundle(root, RETURNS_MANAGER)
    // 不 provide 服务：只靠 apply() 的返回值也必须被采纳。
    const host = createLinuxPluginHost({ root, activate: (plugin, config) => cordisScope(ctx.plugin(plugin, config)) })
    const installed = await host.install({ directory })
    assert.equal(installed.active, true)
    assert.equal(typeof installed.manager.install, 'function')
    assert.equal(installed.manager.status().runtimeId, 'debian-minimal-x64')
    assert.deepEqual(await host.isInjected({ directory }), { injected: true, active: true, directory })
    await host.uninstall()
    assert.deepEqual(await host.isInjected({ directory }), { injected: true, active: false, directory })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('安装链：插件自己 provide 的服务仍然优先于返回值', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-effect-provide-'))
  const ctx = new Context()
  try {
    const directory = await bundle(root, RETURNS_MANAGER)
    const host = createLinuxPluginHost({ root, activate: (plugin, config) => cordisScope(ctx.plugin(plugin, config)) })
    const installed = await host.install({ directory, config: { publish: true } })
    // 同一个对象两条路可达：取到的 manager 必须仍然满足契约。
    assert.equal(typeof installed.manager.uninstall, 'function')
    assert.equal(typeof ctx.get('linuxRuntimeManager').install, 'function')
    await host.uninstall()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('effectSafeApply：disposer 原样透传，非 effect 值一律不再交给 Cordis', async () => {
  const seen = []
  const passthrough = effectSafeApply(() => () => { seen.push('disposed') }, value => seen.push(value))
  const disposer = await passthrough.call(undefined, undefined, undefined)
  assert.equal(typeof disposer, 'function')
  disposer()
  assert.deepEqual(seen.slice(1), ['disposed'])

  const captured = []
  const hiding = effectSafeApply(async () => ({ install() {}, uninstall() {} }), value => captured.push(value))
  assert.equal(await hiding.call(undefined, undefined, undefined), undefined)
  assert.equal(captured.length, 1)
  assert.equal(typeof captured[0].install, 'function')
})

test('安装链：返回 disposer 的插件不被包装破坏（回滚仍可卸载）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linux-effect-disposer-'))
  const ctx = new Context()
  try {
    const directory = await bundle(root, RETURNS_DISPOSER)
    globalThis.__linuxDisposed = false
    const host = createLinuxPluginHost({
      root,
      // 该插件不提供 manager，宿主必须按契约拒绝——但拒绝前不得让 fiber 因返回值而崩。
      activate: (plugin, config) => cordisScope(ctx.plugin(plugin, config)),
    })
    await assert.rejects(host.install({ directory }), /did not provide a runtime manager/)
    assert.equal(globalThis.__linuxDisposed, true, '回滚必须跑到插件自己的 disposer')
  } finally {
    delete globalThis.__linuxDisposed
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
