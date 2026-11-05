/**
 * 引擎侧 bootstrap 装载器（0.15.0 最小面）。
 *
 * 为什么单独一个文件：vendored `dsh-linux-bootstrap` 随快照注入，但不登记进 profile patch（它表达不了
 * 函数型 `linuxAssetIO`），由宿主在运行期动态 import。这里只负责「找到模块 + 交给 Cordis」，
 * 配置由 `createLinuxBootstrapConfig` 造（IO 归它，本文件不复制任何资产 IO）。
 *
 * 解析目标只有一个：包名 `@dsh-android/linux-bootstrap`（注入链保证它在引擎 node_modules 里）。
 * 装载失败时把真实原因带回，避免「服务静默缺席」。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FiberState, type Context } from '@deepseek-ai/cordis'

/** bootstrap 模块的最小可装载面：`apply(ctx, config)` 必须存在。 */
export interface LinuxBootstrapModule {
  name?: string
  inject?: string[]
  apply(ctx: Context, config?: Record<string, unknown>): unknown
}

const isModule = (value: unknown): value is LinuxBootstrapModule => {
  if (value === null || typeof value !== 'object') return false
  const record = value as { apply?: unknown; default?: unknown }
  if (typeof record.apply === 'function') return true
  const fallback = record.default as { apply?: unknown } | undefined
  return typeof fallback?.apply === 'function'
}

/** ESM 命名空间 + default 导出两种形态都接受，统一成带 `apply` 的对象。 */
function normalize(loaded: unknown): LinuxBootstrapModule | undefined {
  if (!isModule(loaded)) return undefined
  const record = loaded as { apply?: unknown; default?: unknown; name?: unknown; inject?: unknown }
  if (typeof record.apply === 'function') {
    return {
      apply: record.apply as LinuxBootstrapModule['apply'],
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(Array.isArray(record.inject) ? { inject: record.inject as string[] } : {}),
    }
  }
  const fallback = record.default as LinuxBootstrapModule
  return {
    apply: fallback.apply,
    ...(typeof fallback.name === 'string' ? { name: fallback.name } : {}),
    ...(Array.isArray(fallback.inject) ? { inject: fallback.inject } : {}),
  }
}

/**
 * 唯一的默认解析目标：**包名**。
 *
 * 注入链把 `@dsh-android/linux-bootstrap`（含 `lib/`）放进引擎的 node_modules，由 Node 自己
 * 解析；在这里猜文件路径只会在两种布局之间漂移。
 */
export const LINUX_BOOTSTRAP_SPECIFIER = '@dsh-android/linux-bootstrap'

/**
 * 按包名装载 bootstrap；只接受真正导出 `apply` 的模块。
 *
 * @param options.importModule 测试注入点（默认动态 import）。
 */
export async function importLinuxBootstrap(options: {
  specifier?: string
  importModule?: (specifier: string) => Promise<unknown>
} = {}): Promise<LinuxBootstrapModule> {
  const specifier = options.specifier ?? LINUX_BOOTSTRAP_SPECIFIER
  let loaded: unknown
  try {
    loaded = options.importModule
      ? await options.importModule(specifier)
      : await import('@dsh-android/linux-bootstrap')
  } catch (error) {
    throw new Error('无法加载 Linux bootstrap 插件 ' + specifier + '：' + (error instanceof Error ? error.message : String(error)))
  }
  const module = normalize(loaded)
  if (module === undefined) throw new Error('Linux bootstrap 插件 ' + specifier + ' 未导出 apply()')
  return module
}

/**
 * 把 bootstrap 挂到当前 Cordis 上下文。
 *
 * `ctx.plugin` 的 fiber 跟随 ctx 生命周期释放；`inject: ['linuxPluginHost']` 由模块自己声明，
 * 所以调用方必须先 `provide('linuxPluginHost', ...)`。
 *
 * 等待 fiber 落定再返回：bootstrap 的 `apply()` 同步 `provide('linuxBootstrap', ...)`，等它落定
 * 之后设置页的 slot 与路由才能立刻看到服务；装载失败也能在调用方被记录成一条日志，而不是
 * 变成「服务静默缺席」。
 */
export async function mountLinuxBootstrap(ctx: Context, options: {
  config?: Record<string, unknown>
  specifier?: string
  importModule?: (specifier: string) => Promise<unknown>
}): Promise<unknown> {
  const module = await importLinuxBootstrap({ specifier: options.specifier, importModule: options.importModule })
  const config = options.config ?? {}
  const plugin = {
    ...(module.name === undefined ? {} : { name: module.name }),
    ...(module.inject === undefined ? {} : { inject: module.inject }),
    apply: module.apply,
  }
  const fiber = ctx.plugin(plugin as never, config as never)
  await fiber
  if (fiber.state !== FiberState.ACTIVE) throw new Error(`Linux bootstrap activation failed (state ${fiber.state})`)
  return fiber
}

/**
 * 已 check / 已 pinned 的 release manifest，**只读持久状态**。
 *
 * 设置页要先按 manifest 里的 `sha256/size/unpackedSize` 让壳侧准备资产，再去 install；
 * 这条读取不触网、不安装，因此不会把「看过一次」变成「已启用」。
 * 优先 `availableManifest`（最近一次 check 的结果），退回 `pinnedManifest`（已安装版本）。
 *
 * @param dataDir bootstrap 的 dataDir（`<filesDir>/linux-environment`）。
 * @returns manifest 或 null（从未 check 过）。
 */
export function readLinuxManifest(dataDir: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = readFileSync(join(dataDir, 'linux-bootstrap-state.json'), 'utf8')
  } catch {
    return null
  }
  let state: unknown
  try {
    state = JSON.parse(raw)
  } catch {
    return null
  }
  if (state === null || typeof state !== 'object') return null
  const record = state as { availableManifest?: unknown; pinnedManifest?: unknown }
  for (const candidate of [record.availableManifest, record.pinnedManifest]) {
    if (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>
    }
  }
  return null
}
