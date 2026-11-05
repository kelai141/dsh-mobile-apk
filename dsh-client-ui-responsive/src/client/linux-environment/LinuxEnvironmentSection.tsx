/**
 * 设置页「Linux环境」分区（实验性内部插件，默认不启用）。
 *
 * 挂载点：本包 `src/client/index.ts` 的 `settings.section` 注册（id `linux-environment`）。
 * 为什么不靠 vendored bootstrap 客户端：那个条目的 `inject` 里写着 `linuxBootstrap`，而浏览器侧
 * 客户端**永远拿不到**引擎 Cordis 上下文里的服务，且该包并未作为 client provider 装载——于是设置页
 * 根本没有入口。这里改由本包注册（唯一注册方），状态与动作走同源受鉴权路由：
 *
 *   GET  /api/android/linux-environment/status
 *   GET  /api/android/linux-environment/manifest   {"manifest":{...}}
 *   POST /api/android/linux-environment/check | install | reinstall | uninstall | auto-update-on|off
 *
 * 资产：引擎侧解不了 `.tar.xz`，也不能走设备控制队列。故安装前由**页面**逐个调用
 * `window.androidBridge.linuxAssetPrepare` 并轮询 `linuxAssetPrepareStatus`，把
 * `plugins.runtime` + 选中 runtime 的 `backendAsset/rootfsAsset/nodeAsset` 全部落进宿主暂存区，
 * 全部 `ok` 后才 POST install（`confirmed:true, activate:true`）。bootstrap 仍会自行复验。
 *
 * 交互口径：一次点击只发起一次安装（模块级 inFlight 守卫 + 按钮 disabled）；失败保留页面并给「重试」；
 * 已就绪显示「返回对话」（走上游 `close`）。`data-linux-*` 属性供 ADB 截图定位。
 *
 * 状态口径：主按钮只在确有新版本时可用——已装且 `updateAvailable !== true` 时禁用为主按钮
 * 「已是最新版本」，检查更新（check）与重新安装（reinstall，走 pinnedManifest）仍可用；
 * 手动 check 返回可更新后主按钮才解禁。「重新安装」之所以是独立入口：引擎对同版本 install
 * 会以 `already installed; use reinstall()` 拒绝降级/重复安装。失败时不渲染「已就绪」提示，
 * 只保留「返回对话」，避免把失败读成成功。
 */
import { useCallback, useEffect, useState } from 'react'
import { tr } from '../i18n.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '../android-bridge.ts'
import {
  AssetError,
  RouteError,
  assetsFor,
  checkForUpdates,
  fetchManifest,
  fetchStatus,
  installEnvironment,
  prepareAssets,
  reinstallEnvironment,
  setAutoUpdate,
  totalBytes,
  uninstallEnvironment,
  type AssetProgress,
  type AssetSpec,
  type LinuxStatus,
} from './transport.ts'

/** 轮询间隔（页面可见时才轮询）。 */
const POLL_MS = 2000

/**
 * 全页唯一的安装守卫：React 状态在重渲染前拦不住连点，故放在模块级。
 * 与引擎侧串行队列互补（那边 busy 时回 409）。
 */
let inFlight = false

type Phase = 'idle' | 'manifest' | 'assets' | 'installing' | 'checking' | 'uninstalling' | 'done' | 'failed'

interface ProgressState {
  stage: 'manifest' | 'assets' | 'installing'
  index?: number
  total?: number
  field?: string
  phase?: string
  bytes?: number
}

/** 字节数（下载体量提示）。 */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB'
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

/** 资产字段 → 用户看得懂的名字。 */
function fieldLabel(field: string): string {
  switch (field) {
    case 'runtime-plugin': return tr('运行时插件', 'runtime plugin')
    case 'backendAsset': return tr('Bionilux 启动器', 'Bionilux launcher')
    case 'rootfsAsset': return tr('Debian 根文件系统', 'Debian root filesystem')
    case 'nodeAsset': return tr('共享 Node.js', 'shared Node.js')
    default: return field
  }
}

/** 失败原因 → 一句人话（路由错误直接沿用宿主文案）。 */
function failureText(cause: unknown): string {
  if (cause instanceof AssetError) {
    if (cause.code === 'linux-asset-bridge-missing') {
      return tr(
        '当前宿主没有提供资产准备通道——请在本机应用内打开设置后重试。',
        'This host has no asset-preparation channel. Open Settings inside the Android app and retry.',
      )
    }
    const detail = cause.detail !== '' ? '（' + cause.detail + '）' : ''
    return tr('准备下载资产失败：', 'Preparing the download failed: ') + cause.message + detail
  }
  if (cause instanceof RouteError) return cause.message
  return cause instanceof Error ? cause.message : String(cause)
}

/** 引擎忙碌时的一句话（状态轮询回来时用）。 */
function operationText(operation: string | undefined): string {
  switch (operation) {
    case 'checking': return tr('正在检查更新…', 'Checking for updates…')
    case 'automatic-check': return tr('正在自动检查更新…', 'Checking for updates automatically…')
    case 'installing': return tr('正在安装 Linux 环境…', 'Installing the Linux environment…')
    case 'reinstalling': return tr('正在重新安装 Linux 环境…', 'Reinstalling the Linux environment…')
    case 'uninstalling': return tr('正在卸载 Linux 环境…', 'Removing the Linux environment…')
    default: return ''
  }
}

/** 持久化状态 → 一行摘要。 */
function statusText(status: LinuxStatus | null): string {
  if (status === null) return tr('正在读取 Linux 环境状态…', 'Reading the Linux environment status…')
  if (status.installed !== true) {
    return status.updateBlocked === true
      ? tr('尚未安装 Linux 环境；发现较旧版本，已阻止降级', 'Not installed yet; an older release was found and downgrades are blocked')
      : tr('尚未安装 Linux 环境', 'The Linux environment is not installed yet')
  }
  const parts = [tr('已安装 Linux 运行时 ', 'Linux runtime ') + (status.version ?? '')]
  if (status.mobileVersion) parts.push(tr('当前 DSH Mobile ', 'current DSH Mobile ') + status.mobileVersion)
  if (status.updateAvailable === true) parts.push(tr('可更新至 ', 'update to ') + (status.availableVersion ?? ''))
  if (status.updateBlocked === true) parts.push(tr('已阻止降级', 'downgrades are blocked'))
  if (status.injectionActivated === false) parts.push(tr('插件已被移除或停用', 'the plugin was removed or disabled'))
  if (status.error) parts.push(status.error)
  return parts.join(tr('；', '; '))
}

type PrimaryState = 'install' | 'update' | 'current' | 'blocked' | 'unknown'

/**
 * 主按钮状态：首装 / 有更新 / 已是最新 / 已阻止降级 / 宿主未上报更新标记。
 *
 * `updateAvailable === undefined` 只表示宿主没给出这个字段（旧适配器），此时保持可点，
 * 免得把「未知」当成「已是最新」而让更新入口永久不可用。
 */
function primaryState(installed: boolean, status: LinuxStatus | null): PrimaryState {
  if (!installed) return 'install'
  if (status?.updateAvailable === true) return 'update'
  if (status?.updateBlocked === true) return 'blocked'
  if (status?.updateAvailable === false) return 'current'
  return 'unknown'
}

/** 主按钮文案（含可更新版本号，便于确认要装到哪一版）。 */
function primaryLabel(state: PrimaryState, status: LinuxStatus | null): string {
  switch (state) {
    case 'install': return tr('一键下载并安装', 'Download and install')
    case 'current': return tr('已是最新版本', 'Up to date')
    case 'blocked': return tr('已阻止降级', 'Downgrade blocked')
    case 'update':
      return status?.availableVersion
        ? tr('下载并安装更新（', 'Download and install update (') + status.availableVersion + '）'
        : tr('下载并安装更新', 'Download and install update')
    default: return tr('下载并安装更新', 'Download and install update')
  }
}

/**
 * 设置页「Linux环境」分区内容列。
 * @param props - 上游 settings.section 提供的 `close`（关闭设置、回到对话）。
 * @returns 分区元素树。
 */
export function LinuxEnvironmentSection({ close }: PropsRuntime<'settings.section'>) {
  const [status, setStatus] = useState<LinuxStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchStatus())
      setStatusError('')
    } catch (cause) {
      setStatusError(failureText(cause))
    }
  }, [])

  useEffect(() => {
    let active = true
    const load = (): void => {
      void fetchStatus().then(
        (next) => { if (active) { setStatus(next); setStatusError('') } },
        (cause: unknown) => { if (active) setStatusError(failureText(cause)) },
      )
    }
    load()
    // 可见时才轮询：后台 WebView 不打扰引擎。
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, POLL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const runtimes = (Array.isArray(status?.runtimes) ? status.runtimes : [])
    .filter((runtime) => status?.architecture === undefined || runtime.architecture === status.architecture)
  const installedId = status?.installed === true
    ? (status.runtime?.id ?? status.runtime?.runtimeId ?? status.runtimeId ?? '')
    : ''
  const selectedRuntime = installedId !== ''
    ? installedId
    : (runtimes.some((runtime) => runtime.id === runtimeId)
      ? runtimeId
      : (status?.defaultRuntimeId ?? runtimes[0]?.id ?? ''))

  const installed = status?.installed === true
  const primary = primaryState(installed, status)
  // A finished or failed attempt is not busy: the retry/back buttons must stay
  // reachable (a failed update on an installed environment still needs a way
  // back to the conversation).
  const attempting = phase !== 'idle' && phase !== 'done' && phase !== 'failed'
  const busy = status?.busy === true || attempting
  // 已确认没有新版本（或已阻止降级）时不提供更新动作：引擎会把同版本 install 当成
  // 「already installed」拒绝，点了只会得到一个误导性的失败。重新安装走 pinnedManifest，
  // 才是同版本下真正可用的入口。
  const primaryDisabled = busy || primary === 'current' || primary === 'blocked'
  // 失败尝试不是成功：已装环境下只保留「返回对话」，不再说「已就绪」。
  const ready = installed && phase !== 'failed' && status?.version !== undefined

  /**
   * 一次安装：准备全部资产 → 引擎安装并激活。
   * 连点由模块级 inFlight 拦下（第二次直接返回）。
   */
  const install = async ({ reinstall = false } = {}): Promise<void> => {
    if (inFlight) return
    inFlight = true
    setError('')
    try {
      if (!reinstall) {
        setPhase('manifest')
        setProgress({ stage: 'manifest' })
        const manifest = await fetchManifest()
        const { runtime, specs } = assetsFor(manifest, {
          runtimeId: selectedRuntime !== '' ? selectedRuntime : undefined,
          architecture: status?.architecture,
        })
        if (runtime === null) {
          throw new AssetError('No runtime in this release matches this device', { code: 'linux-runtime-not-found' })
        }
        setProgress({ stage: 'assets', index: 0, total: specs.length, bytes: totalBytes(specs) })
        await prepareAssets(
          window.androidBridge,
          specs as AssetSpec[],
          (item: AssetProgress) => {
            setProgress({ stage: 'assets', index: item.index, total: item.total, field: item.field, phase: item.phase })
          },
        )
      }
      setPhase('installing')
      setProgress({ stage: 'installing' })
      const next = reinstall
        ? await reinstallEnvironment()
        : await installEnvironment(selectedRuntime !== '' ? selectedRuntime : undefined)
      if (typeof next.installed === 'boolean') setStatus(next)
      setPhase('done')
      await refresh()
    } catch (cause) {
      setPhase('failed')
      setError(failureText(cause))
    } finally {
      setProgress(null)
      inFlight = false
    }
  }

  const run = async (action: () => Promise<LinuxStatus>, nextPhase: Phase): Promise<void> => {
    if (inFlight) return
    inFlight = true
    setError('')
    setPhase(nextPhase)
    try {
      // 动作返回的宿主状态先落地：手动 check 刚刷新出的 updateAvailable 不会被紧随其后的
      // 状态轮询（可能还是上一拍缓存）抹掉。
      const next = await action()
      if (next !== null && typeof next === 'object') setStatus(next)
      await refresh()
      setPhase('idle')
    } catch (cause) {
      setPhase('failed')
      setError(failureText(cause))
    } finally {
      inFlight = false
    }
  }

  const operation = operationText(status?.operation)

  return (
    <section
      className="dsh-linux-env"
      data-plugin="linux-environment"
      data-linux-environment="true"
      data-phase={phase}
      data-installed={installed ? 'true' : 'false'}
      aria-label={tr('Linux环境', 'Linux environment')}
    >
      <header className="dsh-linux-env-header">
        <span>
          <strong>{tr('Linux环境', 'Linux environment')}</strong>
          <small>
            {tr(
              '实验性内部插件，默认不启用。只有你在这里明确安装后，Debian 环境才会下载、校验并启用；应用更新不会自动启用它。',
              'Experimental internal plugin, off by default. Debian is downloaded, verified and enabled only when you install it here; app updates never enable it on their own.',
            )}
          </small>
        </span>
      </header>

      <p className="dsh-linux-env-status" role="status" aria-live="polite" data-linux-status="summary">
        {statusError !== '' ? tr('状态暂不可读：', 'Status unavailable: ') + statusError : statusText(status)}
      </p>
      {operation !== '' && (
        <p className="dsh-linux-env-hint" role="status" data-linux-operation={status?.operation}>{operation}</p>
      )}

      {runtimes.length > 1 && (
        <label className="dsh-linux-env-row">
          <span>{tr('Linux 运行时', 'Linux runtime')}</span>
          <select
            value={selectedRuntime}
            disabled={busy || installed}
            data-linux-runtime-select="true"
            onChange={(event) => { setRuntimeId(event.currentTarget.value) }}
          >
            {runtimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {(runtime.label ?? runtime.id) + '（' + (runtime.architecture ?? '') + '）'}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="dsh-linux-env-check">
        <input
          type="checkbox"
          checked={status?.autoUpdate === true}
          data-linux-auto-update="true"
          disabled={busy || !installed}
          onChange={(event) => {
            const enabled = event.currentTarget.checked
            void run(() => setAutoUpdate(enabled), 'idle')
          }}
        />
        <span>
          {tr(
            '自动更新（已启用时，DSH Mobile 版本变化后检查较新的 Linux 运行时）',
            'Automatic updates (after a DSH Mobile version change, check for a newer Linux runtime)',
          )}
        </span>
      </label>

      {progress !== null && (
        <p className="dsh-linux-env-progress" role="status" aria-live="polite" data-linux-progress={progress.stage}>
          {progress.stage === 'manifest'
            ? tr('正在读取发布清单…', 'Reading the release manifest…')
            : progress.stage === 'installing'
              ? tr('资产已就绪，正在由引擎安装并激活…', 'Assets are ready; the engine is installing and activating…')
              : (progress.index === undefined || progress.index === 0
                ? tr('正在准备下载 ', 'Preparing ') + String(progress.total ?? 0) + tr(' 个资产', ' assets')
                  + (progress.bytes !== undefined && progress.bytes > 0 ? tr('（约 ', ' (about ') + fmtBytes(progress.bytes) + '）' : '')
                : fieldLabel(progress.field ?? '') + ' ' + String(progress.index) + '/' + String(progress.total ?? 0) + tr('：', ': ')
                  + (progress.phase === 'staged'
                    ? tr('已就绪', 'ready')
                    : progress.phase === 'starting' ? tr('开始', 'starting') : tr('下载并校验中', 'downloading and verifying')))}
        </p>
      )}

      <div className="dsh-linux-env-actions">
        <button
          type="button"
          className="dsh-dev-btn dsh-linux-env-primary"
          data-linux-action={installed ? 'update' : 'install'}
          data-linux-primary={primary}
          disabled={primaryDisabled}
          onClick={() => { void install() }}
        >
          {primaryLabel(primary, status)}
        </button>
        <button
          type="button"
          className="dsh-dev-btn"
          data-linux-action="check"
          disabled={busy || !installed}
          onClick={() => { void run(() => checkForUpdates(), 'checking') }}
        >
          {tr('检查更新', 'Check for updates')}
        </button>
        <button
          type="button"
          className="dsh-dev-btn"
          data-linux-action="reinstall"
          disabled={busy || !installed}
          onClick={() => { void install({ reinstall: true }) }}
        >
          {tr('重新安装', 'Reinstall')}
        </button>
        <button
          type="button"
          className="dsh-dev-btn dsh-dev-danger"
          data-linux-action="uninstall"
          disabled={busy || !installed}
          onClick={() => { void run(() => uninstallEnvironment(), 'uninstalling') }}
        >
          {tr('卸载 Linux 环境', 'Remove Linux environment')}
        </button>
        {installed && !busy && (
          <button
            type="button"
            className="dsh-dev-btn"
            data-linux-action="back"
            onClick={() => { close() }}
          >
            {tr('返回对话', 'Back to chat')}
          </button>
        )}
      </div>

      {phase === 'failed' && error !== '' && (
        <div className="dsh-linux-env-error" role="alert" data-linux-error="true">
          <p>{error}</p>
          <button
            type="button"
            className="dsh-dev-btn"
            data-linux-action="retry"
            disabled={attempting}
            onClick={() => { void install() }}
          >
            {tr('重试', 'Retry')}
          </button>
        </div>
      )}

      {ready && (
        <p className="dsh-linux-env-hint" data-linux-ready="true">
          {tr(
            'Linux 环境已就绪，可以直接回到对话使用 Linux 命令。',
            'The Linux environment is ready. Go back to the conversation and use Linux commands.',
          )}
        </p>
      )}
    </section>
  )
}
