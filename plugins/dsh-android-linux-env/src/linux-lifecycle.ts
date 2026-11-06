/** Non-blocking Linux restore state. DSH may serve chat before Debian is ready. */
import type { BootstrapStatus, LinuxBootstrap } from './linux-environment.js'

export type LinuxPhase = 'starting' | 'ready' | 'not-installed' | 'disabled' | 'failed' | 'stopping' | 'stopped'
export function createLinuxLifecycle() {
  let phase: LinuxPhase = 'starting'
  let detail = 'DSH 已启动，Linux 运行时引擎仍在启动。请稍后调用 linux_environment_status；不要猜测路径或改用宿主 shell。'
  let unsubscribe: (() => void) | undefined
  const terminal = () => phase === 'stopping' || phase === 'stopped'
  const update = (status: BootstrapStatus) => {
    if (terminal()) return
    const installed = status.installed ?? Boolean(status.installedLinuxVersion)
    const runtime = status.runtime as { healthy?: boolean; reason?: string } | undefined
    if (status.error || status.lastError || runtime?.healthy === false) {
      phase = 'failed'
      detail = 'Linux 启动或操作失败：' + (status.error ?? status.lastError ?? runtime?.reason ?? '运行时不健康')
    } else if (status.busy || (status.operation && status.operation !== 'idle')) {
      phase = 'starting'
      detail = 'Linux 运行时引擎正在准备（' + (status.operation ?? '安装/恢复') + '）。请稍后重试状态工具。'
    } else if (!installed) {
      phase = 'not-installed'; detail = 'Linux 尚未安装，请在设置中一键下载并安装。'
    } else if (status.enabled !== true || status.injectionActivated !== true) {
      phase = 'disabled'; detail = 'Linux 已安装但未启用；请在设置中检查激活状态。'
    } else {
      phase = 'ready'; detail = 'Linux 运行时已就绪，使用 linux_bash / linux_session；工作区与文件工具自动共享。'
    }
  }
  return {
    snapshot: () => ({ phase, ready: phase === 'ready', engine: 'dsh' as const, message: detail }),
    async attach(bootstrap: LinuxBootstrap) {
      if (terminal()) return
      // status() can wait for restore; never await it from the parent apply or a tool call.
      update(await bootstrap.status())
      if (!terminal()) unsubscribe = bootstrap.subscribe?.(update)
    },
    fail(error: unknown) {
      if (terminal()) return
      phase = 'failed'; detail = 'Linux 启动失败：' + (error instanceof Error ? error.message : String(error))
    },
    stop() { unsubscribe?.(); unsubscribe = undefined; phase = 'stopping'; detail = 'DSH 引擎正在关闭，Linux 终端与后台任务正在退出。' },
    stopped() { phase = 'stopped'; detail = 'Linux 已停止；文件和已安装软件保留。' },
  }
}

/** One process signal owner, even if web/headless profiles both mount the host. */
const shutdowns = new Set<() => Promise<unknown>>()
let draining = false
function handleSignal() {
  if (draining) return
  draining = true
  const force = setTimeout(() => process.exit(1), 8_000)
  void Promise.allSettled([...shutdowns.keys()].map(stop => stop())).then(results => {
    clearTimeout(force)
    process.exit(results.some(result => result.status === 'rejected') ? 1 : 0)
  })
}
export function onEngineShutdown(stop: () => Promise<unknown>): () => void {
  if (draining) throw new Error('DSH engine is stopping')
  if (!shutdowns.size) for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, handleSignal)
  shutdowns.add(stop)
  return () => {
    shutdowns.delete(stop)
    if (!shutdowns.size && !draining) for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, handleSignal)
  }
}
