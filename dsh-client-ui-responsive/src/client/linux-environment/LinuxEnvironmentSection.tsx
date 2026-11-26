import { SUBLAYER_POP_EVENT } from '../mobile/back-stack.ts'
/**
 * 从设置或侧栏管理 Linux。安卓下载队列独立于页面，运行和更新通过同源路由操作。
 * 终端与工具链是子页，返回只退出子页。终端会话由引擎持有。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, IconChevronLeftOutlineMedium, IconCodeOutlineMedium, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { LinuxTerminal } from './LinuxTerminal.tsx'
import { LinuxToolchains } from './LinuxToolchains.tsx'
import { LinuxDownloadProgress } from './LinuxDownloadButton.tsx'
import { acknowledgeInstallJob, formatBytes, refreshInstallJob, useLinuxInstallJob } from './install-job.ts'
import { tr } from '../i18n.ts'
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
  installRuntimeAssets,
  installJobStatus,
  prepareAssets,
  reinstallEnvironment,
  setAutoUpdate,
  setRuntimePreference,
  startInstallJob,
  totalBytes,
  uninstallEnvironment,
  type AssetProgress,
  type LinuxStatus,
} from './transport.ts'

/** 轮询间隔（页面可见时才轮询）。 */
const BUSY_POLL_MS = 2_000
const IDLE_POLL_MS = 12_000
const SOURCE_KEY = 'dsh.linux.download-source'
const DOWNLOAD_NODES = [['auto', '自动选择', 'Automatic'], ['gh-proxy', 'gh-proxy.com', 'gh-proxy.com'],
  ['ghfast', 'ghfast.top', 'ghfast.top'], ['ghproxy', 'ghproxy.net', 'ghproxy.net']] as const

function savedSource(): string {
  try {
    const value = localStorage.getItem(SOURCE_KEY)
    if (value === 'official' || DOWNLOAD_NODES.some(([id]) => id === value)) return value!
  } catch { /* Use the default when local storage is disabled. */ }
  return 'auto'
}

/**
 * 全页唯一的安装守卫：React 状态在重渲染前拦不住连点，故放在模块级。
 * 与引擎侧串行队列互补（那边 busy 时回 409）。
 */
let inFlight = false
/** 合并同时发起的查询。完成后下一次查询重新访问发布通道。 */
let releaseCheck: Promise<LinuxStatus> | null = null
function queryLatestRelease(): Promise<LinuxStatus> {
  return releaseCheck ?? (releaseCheck = checkForUpdates().finally(() => { releaseCheck = null }))
}

type Phase = 'idle' | 'manifest' | 'assets' | 'installing' | 'checking' | 'uninstalling' | 'done' | 'failed'
type AutoCheckState = 'idle' | 'checking' | 'done' | 'failed'

interface ProgressState {
  stage: 'manifest' | 'assets' | 'installing'
  index?: number
  total?: number
  field?: string
  phase?: string
  bytes?: number
  size?: number
  speed?: number
}

/** 资产字段 → 用户看得懂的名字。 */
function fieldLabel(field: string): string {
  switch (field) {
    case 'plugin':
    case 'runtime-plugin': return tr('运行时插件', 'runtime plugin')
    case 'backend':
    case 'backendAsset': return tr('Bionilux 启动器', 'Bionilux launcher')
    case 'rootfs':
    case 'rootfsAsset': return tr('Debian 根文件系统', 'Debian root filesystem')
    case 'node':
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
  if (cause instanceof RouteError) {
    // 宿主的 detail 是唯一能说明「为什么」的字段；把它一起显示，避免用户只拿到一句
    // 「请检查环境状态与日志」却无从下手（不可调试包上根本读不到日志）。
    return cause.detail !== '' ? cause.message + '\n' + cause.detail : cause.message
  }
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
  const parts = [tr('Debian ', 'Debian ') + (status.version ?? '')]
  if (status.runtime?.healthy === false) parts.push(tr('运行异常', 'Runtime error'))
  else if (status.injectionActivated === false) parts.push(tr('已停止', 'Stopped'))
  else parts.push(tr('运行中', 'Running'))
  if (status.updateAvailable === true) parts.push(tr('可更新至 ', 'update to ') + (status.availableVersion ?? ''))
  if (status.updateBlocked === true) parts.push(tr('已阻止降级', 'downgrades are blocked'))
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
    case 'install': return tr('下载并安装', 'Download and install')
    case 'current': return tr('已是最新版本', 'Up to date')
    case 'blocked': return tr('已阻止降级', 'Downgrade blocked')
    case 'update':
      return status?.availableVersion
        ? tr('下载并安装更新（', 'Download and install update (') + status.availableVersion + '）'
        : tr('下载并安装更新', 'Download and install update')
    default: return tr('下载并安装更新', 'Download and install update')
  }
}

export function LinuxEnvironmentSection({ close, sidebar = false }: { close(): void; sidebar?: boolean }) {
  const [terminalOpen, setTerminalOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [source, setSource] = useState(savedSource)
  const [status, setStatus] = useState<LinuxStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [localProgress, setProgress] = useState<ProgressState | null>(null)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [autoCheckState, setAutoCheckState] = useState<AutoCheckState>('idle')
  const [autoCheckError, setAutoCheckError] = useState('')
  const job = useLinuxInstallJob()
  const [firstDownloadBytes, setFirstDownloadBytes] = useState<number>()
  const sectionRef = useRef<HTMLElement>(null)
  const autoCheckStartedRef = useRef(false)
  const statusRevision = useRef({ issued: 0, applied: 0 })

  const applyStatus = useCallback((revision: number, next: LinuxStatus | null, message = ''): boolean => {
    if (revision < statusRevision.current.applied) return false
    statusRevision.current.applied = revision
    if (next !== null) setStatus(next)
    setStatusError(message)
    return true
  }, [])

  useLayoutEffect(() => {
    const section = sectionRef.current
    if (!section || (!terminalOpen && !toolsOpen)) return
    const pop = (event: Event) => {
      event.preventDefault()
      setTerminalOpen(false)
      setToolsOpen(false)
    }
    const terminal = section.querySelector('[data-dsh-settings-sublayer]')
    terminal?.addEventListener(SUBLAYER_POP_EVENT, pop)
    return () => terminal?.removeEventListener(SUBLAYER_POP_EVENT, pop)
  }, [terminalOpen, toolsOpen])

  const refresh = useCallback(async (): Promise<LinuxStatus | undefined> => {
    const revision = ++statusRevision.current.issued
    try {
      const next = await fetchStatus()
      applyStatus(revision, next)
      return next
    } catch (cause) {
      applyStatus(revision, null, failureText(cause))
    }
  }, [applyStatus])

  useEffect(() => {
    let active = true
    let reading = false
    let timer: number | undefined
    const section = sectionRef.current
    const presented = (): boolean => document.visibilityState === 'visible' &&
      (typeof IntersectionObserver !== 'function' || (section?.getClientRects().length ?? 0) > 0)
    const runAutoCheck = (): void => {
      setAutoCheckState('checking')
      setAutoCheckError('')
      const revision = ++statusRevision.current.issued
      void queryLatestRelease().then(
        (checked) => {
          if (!active) return
          if (checked !== null && typeof checked === 'object') applyStatus(revision, checked)
          setAutoCheckState('done')
          setAutoCheckError('')
        },
        (cause: unknown) => {
          if (!active) return
          // Offline / rate-limit update check failures stay non-fatal: existing
          // installed environment, reinstall and uninstall remain operable.
          setAutoCheckState('failed')
          setAutoCheckError(failureText(cause))
        },
      )
    }
    const load = async (): Promise<void> => {
      window.clearTimeout(timer)
      if (!active || !presented() || reading) return
      reading = true
      const currentJob = installJobStatus()
      let busy = inFlight || ['queued', 'paused', 'installing'].includes(currentJob?.state ?? '')
      const revision = ++statusRevision.current.issued
      try {
        const next = await fetchStatus()
        if (!active || !applyStatus(revision, next)) return
        busy ||= next.busy === true
        if (!autoCheckStartedRef.current && !busy && presented()) {
          autoCheckStartedRef.current = true
          runAutoCheck()
        }
      } catch (cause) {
        if (active) applyStatus(revision, null, failureText(cause))
      } finally {
        reading = false
        if (active && presented()) {
          timer = window.setTimeout(wake, busy ? BUSY_POLL_MS : IDLE_POLL_MS)
        }
      }
    }
    const wake = (): void => { void load() }
    const observer = typeof IntersectionObserver === 'function' && section !== null
      ? new IntersectionObserver(wake)
      : undefined
    if (section !== null) observer?.observe(section)
    document.addEventListener('visibilitychange', wake)
    wake()
    return () => {
      active = false
      observer?.disconnect()
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [applyStatus])

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
  useEffect(() => {
    if (installed || autoCheckState === 'checking') return
    let active = true
    setFirstDownloadBytes(undefined)
    void fetchManifest().then(manifest => {
      const { runtime, specs } = assetsFor(manifest, {
        runtimeId: selectedRuntime || undefined,
        architecture: status?.architecture,
      })
      if (active && runtime && specs.length) setFirstDownloadBytes(totalBytes(specs))
    }).catch(() => { /* The install action refreshes the release if the cached manifest is missing. */ })
    return () => { active = false }
  }, [installed, selectedRuntime, status?.architecture, status?.latestReleaseVersion, autoCheckState])

  const primary = primaryState(installed, status)
  // A finished or failed attempt is not busy: the retry/back buttons must stay
  // reachable (a failed update on an installed environment still needs a way
  // back to the conversation).
  const jobWorking = job?.state === 'queued' || job?.state === 'paused' || job?.state === 'installing'
  const progress = localProgress
  const attempting = jobWorking || (phase !== 'idle' && phase !== 'done' && phase !== 'failed')
  const busy = status?.busy === true || attempting
  // 已确认没有新版本（或已阻止降级）时不提供更新动作：引擎会把同版本 install 当成
  // 「already installed」拒绝，点了只会得到一个误导性的失败。重新安装走 pinnedManifest，
  // 才是同版本下真正可用的入口。
  const primaryDisabled = busy || primary === 'current' || primary === 'blocked'
  // 安装失败时，状态文案和控件反映当前操作。
  const ready = installed && status?.injectionActivated !== false && status?.runtime?.healthy !== false
  const healthy = ready && status?.runtime?.healthy === true
  const canOfferInstall = !installed && !attempting && job?.state !== 'failed' && phase !== 'failed'
  const showTransfer = !!job && (jobWorking || job.state === 'failed')
  const openTerminal = () => {
    acknowledgeInstallJob()
    setTerminalOpen(true)
  }
  const selectSource = (value: string) => {
    setSource(value)
    try { localStorage.setItem(SOURCE_KEY, value) } catch { /* The source remains selected for this page. */ }
  }

  /**
   * 一次安装：准备全部资产 → 引擎安装并激活。
   * 连点由模块级 inFlight 拦下（第二次直接返回）。
   */
  const install = async ({ reinstall = false } = {}): Promise<void> => {
    if (inFlight) return
    inFlight = true
    setError('')
    try {
      let next: LinuxStatus
      const installing = (): void => {
        setPhase('installing')
        setProgress({ stage: 'installing' })
      }
      if (!reinstall) {
        setPhase('manifest')
        setProgress({ stage: 'manifest' })
        try {
          await queryLatestRelease()
          setAutoCheckState('done')
          setAutoCheckError('')
        } catch (cause) {
          // The existing verified manifest remains usable for cached assets.
          setAutoCheckState('failed')
          setAutoCheckError(failureText(cause))
        }
        const current = await refresh()
        const manifest = await fetchManifest()
        const { runtime, specs } = assetsFor(manifest, {
          runtimeId: selectedRuntime !== '' ? selectedRuntime : undefined,
          architecture: status?.architecture,
        })
        if (runtime === null) {
          throw new AssetError('No runtime in this release matches this device', { code: 'linux-runtime-not-found' })
        }
        if (window.androidBridge?.linuxInstallJob && manifest.version) {
          startInstallJob(manifest.version, runtime.id, specs, source, runtime.sharedNodeReuse === true)
          refreshInstallJob()
          setPhase('idle')
          return
        }
        next = await installRuntimeAssets(runtime, specs, current, assets => {
          setPhase('assets')
          setProgress({ stage: 'assets', index: 0, total: assets.length, bytes: totalBytes(assets) })
          return prepareAssets(window.androidBridge, assets, (item: AssetProgress) => {
            setProgress({ stage: 'assets', ...item })
          }, undefined, undefined, source)
        }, candidate => {
          installing()
          return installEnvironment(runtime.id, candidate)
        })
      } else {
        if (window.androidBridge?.linuxAssetPrepare) {
          const manifest = await fetchManifest({ pinned: true })
          const { runtime, specs } = assetsFor(manifest, {
            runtimeId: selectedRuntime !== '' ? selectedRuntime : undefined,
            architecture: status?.architecture,
          })
          if (runtime !== null && specs.length > 0) {
            setPhase('assets')
            setProgress({ stage: 'assets', index: 0, total: specs.length, bytes: totalBytes(specs) })
            await prepareAssets(window.androidBridge, specs, (item: AssetProgress) => {
              setProgress({ stage: 'assets', ...item })
            }, undefined, undefined, source)
          }
        }
        installing()
        next = await reinstallEnvironment()
      }
      if (typeof next.installed === 'boolean') applyStatus(++statusRevision.current.issued, next)
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
      if (nextPhase !== 'checking' && releaseCheck !== null) {
        try { await releaseCheck } catch { /* A query failure does not block local operations. */ }
      }
      // 动作结果覆盖动作完成前发出的读取。后续回读仍可带来更新的宿主状态。
      const next = await action()
      if (next !== null && typeof next === 'object') applyStatus(++statusRevision.current.issued, next)
      if (nextPhase === 'checking') {
        setAutoCheckState('done')
        setAutoCheckError('')
      }
      await refresh()
      setPhase('idle')
    } catch (cause) {
      if (nextPhase === 'checking') {
        setAutoCheckState('idle')
        setAutoCheckError('')
      }
      setPhase('failed')
      setError(failureText(cause))
    } finally {
      inFlight = false
    }
  }

  const operation = operationText(status?.operation)
  const pauseDownload = () => {
    if (progress?.phase === 'paused') window.androidBridge?.linuxAssetResume?.()
    else window.androidBridge?.linuxAssetPause?.()
  }

  return (
    <section
      ref={sectionRef}
      className="dsh-linux-env"
      data-plugin="linux-environment"
      data-linux-environment="true"
      data-phase={phase}
      data-installed={installed ? 'true' : 'false'}
      aria-label={tr('Linux环境', 'Linux environment')}
    >
      {sidebar && <header className="dsh-linux-panel-header">
        <button type="button" className="dsh-resource-back" data-dsh-linux-back=""
          aria-label={tr('返回', 'Back')} onClick={() => {
          const result = window.__dshNavigationBack?.('control')
          if (result !== undefined && result !== 'root') return
          if (terminalOpen) setTerminalOpen(false)
          else if (toolsOpen) setToolsOpen(false)
          else close()
        }}><IconChevronLeftOutlineMedium size={18} /></button>
        <h1>{terminalOpen ? tr('终端', 'Terminal') : toolsOpen
          ? tr('工具链', 'Toolchains') : tr('可选资源', 'Optional resources')}</h1>
      </header>}
      {terminalOpen ? <LinuxTerminal onBack={sidebar ? undefined : () => setTerminalOpen(false)} /> :
        toolsOpen ? <LinuxToolchains onBack={sidebar ? undefined : () => setToolsOpen(false)} /> : <>
      <div className="dsh-resource-intro" data-dsh-resource-card="linux">
        <div className="dsh-resource-intro-heading">
          <span className="dsh-resource-glyph" aria-hidden="true"><IconCodeOutlineMedium size={21} /></span>
          <div>
            <h2>{tr('Linux 工作环境', 'Linux workspace')}</h2>
            {healthy ? <p role="status">{tr('已就绪', 'Ready')}</p> :
              !showTransfer && !installed && <p>
                {tr('在手机上运行终端命令和开发工具。', 'Run terminal commands and development tools on your phone.')}
              </p>}
          </div>
        </div>
        {showTransfer && job ? <LinuxDownloadProgress job={job} /> : healthy ?
          <button type="button" className="dsh-dev-btn dsh-linux-env-primary"
            data-linux-action="terminal" onClick={openTerminal}>
            {tr('打开终端', 'Open terminal')}
          </button> : canOfferInstall && <>
            {firstDownloadBytes !== undefined && <p className="dsh-resource-size" data-dsh-resource-size="">
              {tr('完整下载约 ', 'Full download about ') + formatBytes(firstDownloadBytes)}
            </p>}
            <div className="dsh-resource-actions">
              <button type="button" className="dsh-dev-btn dsh-linux-env-primary"
                data-linux-action="install" data-linux-primary="install" disabled={primaryDisabled}
                onClick={() => { void install() }}>
                {primaryLabel(primary, status)}
              </button>
              {sidebar && <button type="button" className="dsh-resource-link-button"
                data-linux-action="later" onClick={close}>{tr('暂不安装', 'Not now')}</button>}
            </div>
        </>}
      </div>
      {!installed && !attempting && <button type="button" className="dsh-linux-env-row dsh-linux-env-link"
        data-linux-action="settings" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>
        <span>{tr('下载设置', 'Download settings')}</span><span aria-hidden="true">{advanced ? '−' : '›'}</span>
      </button>}
      {advanced && <>
        <label className="dsh-linux-env-row">
          <span>{tr('下载来源', 'Download source')}</span>
          <select value={source === 'official' ? 'official' : 'mirror'} disabled={busy}
            onChange={event => selectSource(event.currentTarget.value === 'official' ? 'official' : 'auto')}>
            <option value="official">{tr('官方源', 'Official')}</option>
            <option value="mirror">{tr('镜像源', 'Mirror')}</option>
          </select>
        </label>
        {source !== 'official' && <label className="dsh-linux-env-row">
          <span>{tr('镜像节点', 'Mirror server')}</span>
          <select value={source} disabled={busy} onChange={event => selectSource(event.currentTarget.value)}>
            {DOWNLOAD_NODES.map(([id, zh, en]) => <option value={id} key={id}>{tr(zh, en)}</option>)}
          </select>
        </label>}
      </>}

      <p className="dsh-linux-env-status" role="status" aria-live="polite"
        hidden={statusError === '' && !advanced && (!installed || healthy)}
        data-linux-status="summary"
        data-linux-ready={ready && phase !== 'failed' ? 'true' : undefined}
        data-linux-auto-check={installed && autoCheckState === 'done' && status?.updateAvailable === true ? 'update-available' : undefined}>
        {statusError !== '' ? tr('状态暂不可读：', 'Status unavailable: ') + statusError : statusText(status)}
      </p>
      {installed && status?.autoStart !== undefined && (advanced || !ready) && <div className="dsh-linux-env-row">
        <span>{tr('运行 Linux', 'Run Linux')}</span>
        <Switch label={tr('运行 Linux', 'Run Linux')} disabled={busy} checked={status.injectionActivated === true}
          onChange={enabled => {
            if (!enabled && !window.confirm(tr('停止 Linux 会结束正在运行的终端和任务。', 'Stopping Linux ends active terminals and jobs.'))) return
            void run(() => setRuntimePreference({ enabled }), 'idle')
          }} />
      </div>}
      {installed && !healthy && <button type="button" className="dsh-linux-env-row dsh-linux-env-link"
        data-linux-action="terminal" disabled={!ready} onClick={openTerminal}>
        <span>{tr('终端', 'Terminal')}</span><span aria-hidden="true">›</span>
      </button>}
      {installed && <button type="button" className="dsh-linux-env-row dsh-linux-env-link"
        data-linux-action="toolchains" disabled={!ready || busy} onClick={() => setToolsOpen(true)}>
        <span>{tr('工具链与存储', 'Toolchains and storage')}</span><span aria-hidden="true">›</span>
      </button>}
      {installed && <button type="button" className="dsh-linux-env-row dsh-linux-env-link"
        data-linux-action="settings" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>
        <span>{tr('Linux 设置', 'Linux settings')}</span><span aria-hidden="true">{advanced ? '−' : '›'}</span>
      </button>}
      {advanced && autoCheckState === 'checking' && !attempting && phase !== 'failed' && (
        <p className="dsh-linux-env-hint" role="status" data-linux-auto-check="checking">
          {tr('正在自动查询上游最新版本…', 'Checking upstream for the latest version…')}
        </p>
      )}
      {advanced && autoCheckState === 'done' && !installed && !attempting && phase !== 'failed' && status?.updateAvailable === true && status?.availableVersion && (
        <p className="dsh-linux-env-hint" data-linux-auto-check="update-available">
          {tr('可安装版本 ', 'Available version ') + status.availableVersion}
        </p>
      )}
      {autoCheckState === 'done' && !attempting && phase !== 'failed' && installed && status?.updateAvailable === false && status?.updateBlocked !== true && (
        <p className="dsh-linux-env-hint" data-linux-auto-check="up-to-date">
          {status.latestReleaseVersion
            ? tr('已安装上游最新版本 ' + status.latestReleaseVersion + '。', 'Latest upstream release ' + status.latestReleaseVersion + ' is installed.')
            : tr('已查询上游最新版本：当前已是最新。', 'Checked upstream: already up to date.')}
        </p>
      )}
      {autoCheckState === 'failed' && autoCheckError !== '' && !attempting && phase !== 'failed' && (
        <p className="dsh-linux-env-hint" data-linux-auto-check="failed">
          {tr('自动查询上游更新失败（不影响现有环境与重装/卸载）：', 'Automatic update check failed (existing environment, reinstall, and removal remain available): ') + autoCheckError}
        </p>
      )}
      {operation !== '' && (
        <p className="dsh-linux-env-hint" role="status" data-linux-operation={status?.operation}>{operation}</p>
      )}

      {advanced && runtimes.length > 1 && (
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

      {installed && advanced && <div className="dsh-linux-env-row">
        <span>{tr('自动安装 Linux 更新', 'Install Linux updates automatically')}</span>
        <Switch
          label={tr('自动安装 Linux 更新', 'Install Linux updates automatically')}
          checked={status?.autoUpdate === true}
          data-linux-auto-update="true"
          disabled={busy || !installed}
          onChange={(enabled) => {
            void run(() => setAutoUpdate(enabled), 'idle')
          }}
        />
      </div>}
      {installed && advanced && status?.autoStart !== undefined && <div className="dsh-linux-env-row">
        <span>{tr('随应用启动', 'Start with the app')}</span>
        <Switch label={tr('随应用启动', 'Start with the app')} disabled={busy} checked={status.autoStart}
          onChange={autoStart => { void run(() => setRuntimePreference({ autoStart }), 'idle') }} />
      </div>}

      {installed && advanced && <details className="dsh-linux-diagnostics">
        <summary className="dsh-linux-env-row dsh-linux-env-link">
          <span>{tr('运行诊断', 'Runtime diagnostics')}</span>
          <span>{status?.runtime?.healthy === true ? tr('健康检查通过', 'Health check passed')
            : status?.runtime?.healthy === false ? tr('运行异常', 'Runtime error')
            : tr('等待运行检查', 'No health result yet')}</span>
        </summary>
        <dl>
          {status?.architecture && <div><dt>{tr('处理器架构', 'CPU architecture')}</dt>
            <dd>{status.architecture}</dd></div>}
          {(status?.runtimeId ?? status?.runtime?.runtimeId ?? status?.runtime?.id) && <div>
            <dt>{tr('运行时', 'Runtime')}</dt><dd>{status?.runtimeId ?? status?.runtime?.runtimeId ?? status?.runtime?.id}</dd>
          </div>}
          {status?.runtime?.reason && <div><dt>{tr('异常原因', 'Failure reason')}</dt><dd>{status.runtime.reason}</dd></div>}
        </dl>
      </details>}

      {!showTransfer && progress !== null && (
        <div className="dsh-linux-env-progress" data-linux-progress={progress.stage}>
          <p role="status">{progress.stage === 'manifest'
            ? tr('正在读取发布清单…', 'Reading the release manifest…')
            : progress.stage === 'installing'
              ? tr('正在安装并初始化…', 'Installing and initializing…')
              : (progress.index === undefined || progress.index === 0
                ? tr('正在准备下载 ', 'Preparing ') + String(progress.total ?? 0) + tr(' 个资产', ' assets')
                   + (progress.bytes !== undefined && progress.bytes > 0 ? tr('（约 ', ' (about ') + formatBytes(progress.bytes) + '）' : '')
                : fieldLabel(progress.field ?? '') + ' ' + String(progress.index) + '/' + String(progress.total ?? 0) + tr('：', ': ')
                  + (progress.phase === 'staged'
                    ? tr('已就绪', 'ready')
                    : progress.phase === 'paused' ? tr('已暂停', 'Paused')
                    : progress.phase === 'verifying' ? tr('正在校验…', 'Verifying…')
                    : progress.phase === 'extracting' ? tr('正在解压…', 'Extracting…')
                    : tr('正在下载…', 'Downloading…')))}</p>
          {progress.stage === 'assets' && (progress.size ?? 0) > 0 && <>
            <progress aria-label={tr('下载进度', 'Download progress')} max={progress.size} value={progress.bytes ?? 0} />
            <div className="dsh-linux-env-row">
              <span>{tr('剩余 ', 'Remaining ') + formatBytes(Math.max(0, progress.size! - (progress.bytes ?? 0)))}
                {(progress.speed ?? 0) > 0 && ' · ' + formatBytes(progress.speed!) + '/s'}</span>
              {(progress.phase === 'paused' || progress.phase === 'downloading') &&
                window.androidBridge?.linuxAssetPause &&
                <Button size="sm" variant="outline" onClick={pauseDownload}>
                  {progress.phase === 'paused' ? tr('继续', 'Resume') : tr('暂停', 'Pause')}
                </Button>}
            </div>
          </>}
        </div>
      )}

      {(installed || advanced) && <div className="dsh-linux-env-actions">
        {installed && (primary === 'update' || primary === 'unknown') && <button
          type="button"
          className="dsh-dev-btn dsh-linux-env-primary"
          data-linux-action={installed ? 'update' : 'install'}
          data-linux-primary={primary}
          disabled={primaryDisabled}
          onClick={() => { void install() }}
        >
          {primaryLabel(primary, status)}
        </button>}
        {advanced && <button
          type="button"
          className="dsh-dev-btn"
          data-linux-action="check"
          disabled={busy}
          onClick={() => { void run(queryLatestRelease, 'checking') }}
        >
          {tr('检查更新', 'Check for updates')}
        </button>}
        {installed && advanced && <button
          type="button"
          className="dsh-dev-btn"
          data-linux-action="reinstall"
          disabled={busy || !installed}
          onClick={() => { void install({ reinstall: true }) }}
        >
          {tr('重新安装', 'Reinstall')}
        </button>}
        {installed && advanced && <button
          type="button"
          className="dsh-dev-btn dsh-dev-danger"
          data-linux-action="uninstall"
          disabled={busy || !installed}
          onClick={() => {
            if (window.confirm(tr('卸载 Linux 环境及其根文件系统？', 'Remove Linux and its root filesystem?'))) {
              void run(() => uninstallEnvironment(), 'uninstalling')
            }
          }}
        >
          {tr('卸载 Linux 环境', 'Remove Linux environment')}
        </button>}

      </div>}

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
      {job?.state === 'failed' && job.error && <details className="dsh-linux-diagnostics">
        <summary className="dsh-linux-env-row dsh-linux-env-link">{tr('查看失败原因', 'View failure details')}</summary>
        <p className="dsh-linux-env-hint">{job.error}</p>
      </details>}

      </>}
    </section>
  )
}
