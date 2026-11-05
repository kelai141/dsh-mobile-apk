/**
 * DSH Mobile settings section for the experimental Linux environment.
 *
 * The section is registered from this client plugin, which the Android shell
 * loads from its built-in (hard) plugin directory only after the user enables
 * the Linux environment (presence is not activation).
 *
 * Transport: the page talks to the engine's authenticated host routes over the
 * same origin (/api/android/linux-environment/*). Injecting the engine's
 * `linuxBootstrap` service into a browser client is not possible: the service
 * lives on the engine Cordis context, so a page plugin can never receive it.
 * A host that *does* inject it still works through the small service adapter
 * below, which keeps both paths on one interface.
 *
 * Assets: the engine cannot download Linux release assets itself, and the
 * device-control queue is not a download channel. The section therefore asks
 * the Android shell (window.androidBridge.linuxAssetPrepare / …Status) to stage
 * the runtime plugin bundle plus the selected runtime's backend, rootfs and
 * shared Node before it posts the install. The bootstrap re-verifies every
 * staged bundle before activation.
 *
 * Every install is explicit: the user taps install once, the section posts
 * `{confirmed: true, activate: true}`, and a repeated tap while one attempt is
 * in flight is ignored. Errors keep the section usable and offer a retry.
 */
import React, { useEffect, useState } from 'react'
import { createApi, RouteError } from './api.js'
import { AssetError, assetSpecsFor, prepareAssets, totalBytes } from './assets.js'
import { assetLabel, describeOperation, describeStatus, formatBytes, tr } from './i18n.js'

export const name = 'dsh-linux-bootstrap-client'
// `slots` is the only service this page-side entry needs: the bootstrap service
// lives on the engine context and is reached through the host routes. The DSH
// Mobile host gates slot access on the declared injection set, and its own
// client plugins declare `slots` too (dsh-client-ui-responsive).
export const inject = ['slots']

const h = React.createElement
const SETTINGS_PANEL = '[data-dsh-settings-dialog]'

/** Section order: just before the shell's own Android sections (96..99). */
export const DEFAULT_ORDER = 95

/** Status poll interval; skipped while the page is hidden. */
const POLL_MS = 2000

/**
 * One install attempt at a time, for the whole page.
 *
 * React state is per mount; a user can still tap twice before a re-render, so
 * the guard is module scoped and cleared in `finally`.
 */
let inFlight = false

/**
 * Wrap an injected bootstrap service in the same surface as the route client.
 *
 * Only used when a host really provides the service (tests, future in-page
 * hosts). Manifest data comes from `manifest()` when available, else from the
 * manual check response, else from the route.
 */
function serviceAdapter(service) {
  const api = createApi()
  return {
    status: () => Promise.resolve(service.status()),
    manifest: async () => {
      if (typeof service.manifest === 'function') {
        const manifest = await service.manifest()
        if (manifest && typeof manifest === 'object') return manifest
      }
      const checked = await service.checkForUpdates({ source: 'manual' })
      if (checked && typeof checked === 'object' && Array.isArray(checked.manifest?.runtimes)) return checked.manifest
      return api.manifest()
    },
    check: () => Promise.resolve(service.checkForUpdates({ source: 'manual' })),
    install: ({ runtimeId } = {}) => Promise.resolve(service.install({
      ...(runtimeId ? { runtimeId } : {}),
      confirmed: true,
      activate: true,
    })),
    reinstall: () => Promise.resolve(service.reinstall({ confirmed: true, activate: true })),
    uninstall: () => Promise.resolve(service.uninstall({ confirmed: true })),
    setAutoUpdate: (enabled) => Promise.resolve(service.setAutoUpdateEnabled(enabled)),
  }
}

/** The Android bridge, when this page runs inside the shell. */
function shellBridge() {
  const bridge = typeof window === 'undefined' ? undefined : window.androidBridge
  return bridge && typeof bridge.linuxAssetPrepare === 'function' ? bridge : null
}

/**
 * Leave the settings dialog and return to the conversation.
 *
 * The shell-owned settings panel closes through the paths a user uses: the mask
 * its dialog dispatches a click on, or Escape when no mask is found.
 * @returns {boolean} True when a close was attempted.
 */
export function closeSettings() {
  if (typeof document === 'undefined') return false
  const panel = document.querySelector(SETTINGS_PANEL)
  if (!panel) return false
  const mask = panel.parentElement?.querySelector(':scope > [aria-hidden="true"]') ?? null
  if (mask) {
    mask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return true
  }
  panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return true
}

/** Short, localized reason for a failed attempt. */
export function failureText(cause) {
  if (cause instanceof AssetError) {
    if (cause.code === 'linux-asset-bridge-missing') {
      return tr(
        '当前宿主没有提供资产准备通道；请在本机应用内打开设置后重试。',
        'This host has no asset-preparation channel. Open Settings inside the Android app and retry.',
      )
    }
    const detail = cause.detail ? '（' + cause.detail + '）' : ''
    return tr('准备下载资产失败：', 'Preparing the download failed: ') + cause.message + detail
  }
  if (cause instanceof RouteError) return cause.message
  return cause instanceof Error ? cause.message : String(cause)
}

export function LinuxEnvironmentSection({ linuxBootstrap }) {
  const api = linuxBootstrap ? serviceAdapter(linuxBootstrap) : createApi()
  const [status, setStatus] = useState(null)
  const [statusError, setStatusError] = useState('')
  const [runtimeId, setRuntimeId] = useState('')
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [phase, setPhase] = useState('idle')

  const refresh = async () => {
    try {
      setStatus(await api.status())
      setStatusError('')
    } catch (cause) {
      setStatusError(failureText(cause))
    }
  }

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const next = await api.status()
        if (active) {
          setStatus(next)
          setStatusError('')
        }
      } catch (cause) {
        if (active) setStatusError(failureText(cause))
      }
    }
    void load()
    // Poll only while the page is visible so a backgrounded WebView stays quiet.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api])

  const runtimes = (Array.isArray(status?.runtimes) ? status.runtimes : [])
    .filter((runtime) => !status?.architecture || runtime.architecture === status.architecture)
  const installedId = status?.installed
    ? (status?.runtime?.id ?? status?.runtime?.runtimeId ?? status?.runtimeId ?? '')
    : ''
  const selectedRuntime = installedId
    || (runtimes.some((runtime) => runtime.id === runtimeId) ? runtimeId : (status?.defaultRuntimeId ?? runtimes[0]?.id ?? ''))

  const installed = Boolean(status?.installed)
  // A finished or failed attempt is not busy: retry and back stay reachable.
  const attempting = phase !== 'idle' && phase !== 'done' && phase !== 'failed'
  const busy = Boolean(status?.busy) || attempting

  /**
   * One install attempt: stage every asset, then let the engine install and
   * activate. The module-level guard makes a second tap a no-op.
   */
  const install = async ({ reinstall = false } = {}) => {
    if (inFlight) return
    inFlight = true
    setError('')
    try {
      if (!reinstall) {
        setPhase('manifest')
        setProgress({ stage: 'manifest' })
        const manifest = await api.manifest()
        const { runtime, specs } = assetSpecsFor(manifest, {
          runtimeId: selectedRuntime,
          architecture: status?.architecture,
        })
        if (!runtime) {
          throw new AssetError('No runtime in this release matches this device', { code: 'linux-runtime-not-found' })
        }
        setProgress({ stage: 'assets', index: 0, total: specs.length, bytes: totalBytes(specs) })
        await prepareAssets({
          bridge: shellBridge(),
          specs,
          onProgress: (item) => setProgress({ stage: 'assets', ...item }),
        })
      }
      setPhase('installing')
      setProgress({ stage: 'installing' })
      const next = reinstall
        ? await api.reinstall()
        : await api.install({ runtimeId: selectedRuntime })
      if (next && typeof next === 'object' && 'installed' in next) setStatus(next)
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

  const run = async (action, nextPhase) => {
    if (inFlight) return
    inFlight = true
    setError('')
    setPhase(nextPhase)
    try {
      await action()
      await refresh()
      setPhase('idle')
    } catch (cause) {
      setPhase('failed')
      setError(failureText(cause))
    } finally {
      inFlight = false
    }
  }

  const check = () => run(() => api.check(), 'checking')
  const remove = () => run(() => api.uninstall(), 'uninstalling')
  const toggleAutoUpdate = (enabled) => run(() => api.setAutoUpdate(enabled), 'busy')

  const engineOperation = describeOperation(status?.operation)

  return h(
    'section',
    {
      className: 'linux-environment-settings',
      'aria-label': tr('Linux环境', 'Linux environment'),
      'data-linux-environment': 'true',
      'data-phase': phase,
      'data-installed': installed ? 'true' : 'false',
    },
    h('h2', null, tr('Linux环境', 'Linux environment')),
    h(
      'p',
      { className: 'linux-environment-notice' },
      tr(
        '实验性内部插件：默认不启用。只有你在这里明确安装后，Debian 环境才会下载、校验并启用；应用更新不会自动启用它。',
        'Experimental internal plugin, off by default. Debian is downloaded, verified and enabled only after you install it here; app updates never enable it on their own.',
      ),
    ),
    h(
      'p',
      { role: 'status', 'aria-live': 'polite', 'data-linux-status': 'summary' },
      statusError ? tr('状态暂不可读：', 'Status unavailable: ') + statusError : describeStatus(status),
    ),
    engineOperation ? h('p', { role: 'status', 'data-linux-operation': status?.operation }, engineOperation) : null,
    runtimes.length > 1
      ? h(
        'label',
        { className: 'linux-environment-runtime' },
        tr('Linux 运行时：', 'Linux runtime: '),
        h(
          'select',
          {
            value: selectedRuntime,
            disabled: busy || installed,
            'data-linux-runtime-select': 'true',
            onChange: (event) => setRuntimeId(event.currentTarget.value),
          },
          runtimes.map((runtime) => h(
            'option',
            { key: runtime.id, value: runtime.id },
            runtime.label + '（' + runtime.architecture + '）',
          )),
        ),
      )
      : null,
    h(
      'label',
      { className: 'linux-environment-auto-update' },
      h('input', {
        type: 'checkbox',
        checked: Boolean(status?.autoUpdate),
        'data-linux-auto-update': 'true',
        disabled: busy || !installed,
        onChange: (event) => { void toggleAutoUpdate(event.currentTarget.checked) },
      }),
      tr(
        '自动更新（已启用时，DSH Mobile 版本变化后检查较新的 Linux 运行时）',
        'Automatic updates (after a DSH Mobile version change, check for a newer Linux runtime)',
      ),
    ),
    progress ? h(ProgressLine, { progress }) : null,
    h(
      'div',
      { className: 'linux-environment-actions' },
      h(
        'button',
        {
          type: 'button',
          'data-linux-action': installed ? 'update' : 'install',
          disabled: busy,
          onClick: () => { void install() },
        },
        installed
          ? tr('下载并安装更新', 'Download and install update')
          : tr('一键下载并安装', 'Download and install'),
      ),
      h(
        'button',
        {
          type: 'button',
          'data-linux-action': 'check',
          disabled: busy || !installed,
          onClick: () => { void check() },
        },
        tr('检查更新', 'Check for updates'),
      ),
      h(
        'button',
        {
          type: 'button',
          'data-linux-action': 'reinstall',
          disabled: busy || !installed,
          onClick: () => { void install({ reinstall: true }) },
        },
        tr('重新安装', 'Reinstall'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'linux-environment-danger',
          'data-linux-action': 'uninstall',
          disabled: busy || !installed,
          onClick: () => { void remove() },
        },
        tr('卸载 Linux 环境', 'Remove Linux environment'),
      ),
      installed && !busy
        ? h(
          'button',
          {
            type: 'button',
            'data-linux-action': 'back',
            onClick: () => { closeSettings() },
          },
          tr('返回对话', 'Back to chat'),
        )
        : null,
    ),
    phase === 'failed' && error
      ? h(
        'p',
        { role: 'alert', 'data-linux-error': 'true' },
        error,
        ' ',
        h(
          'button',
          {
            type: 'button',
            'data-linux-action': 'retry',
            disabled: attempting,
            onClick: () => { void install() },
          },
          tr('重试', 'Retry'),
        ),
      )
      : null,
    installed && status?.version
      ? h(
        'p',
        { className: 'linux-environment-ready', 'data-linux-ready': 'true' },
        tr(
          'Linux 环境已就绪，可以直接回到对话使用 Linux 命令。',
          'The Linux environment is ready. Go back to the conversation and use Linux commands.',
        ),
      )
      : null,
    h(
      'p',
      { className: 'linux-environment-links' },
      tr('下载页：', 'Downloads: '),
      ReleaseLink({ label: tr('引导插件', 'bootstrap plugin'), url: status?.pluginReleaseUrls?.bootstrap }),
      ' ',
      ReleaseLink({ label: tr('运行时插件', 'runtime plugin'), url: status?.pluginReleaseUrls?.runtime }),
    ),
  )
}

/** One line of progress for the current attempt. */
function ProgressLine({ progress }) {
  let text = ''
  if (progress.stage === 'manifest') text = tr('正在读取发布清单…', 'Reading the release manifest…')
  else if (progress.stage === 'assets') {
    if (!progress.index) {
      text = tr('正在准备下载 ', 'Preparing ') + (progress.total ?? 0) + tr(' 个资产', ' assets')
      if (progress.bytes) text += tr('（约 ', ' (about ') + formatBytes(progress.bytes) + '）'
    } else {
      const name = assetLabel(progress.field)
      const state = progress.phase === 'staged'
        ? tr('已就绪', 'ready')
        : progress.phase === 'starting' ? tr('开始', 'starting') : tr('下载并校验中', 'downloading and verifying')
      text = name + ' ' + progress.index + '/' + progress.total + '：' + state
    }
  } else if (progress.stage === 'installing' || progress.stage === 'busy') {
    text = tr('资产已就绪，正在由引擎安装并激活…', 'Assets are ready; the engine is installing and activating…')
  }
  return h('p', { className: 'linux-environment-progress', role: 'status', 'aria-live': 'polite', 'data-linux-progress': progress.stage }, text)
}

/** Release page link, restricted to HTTPS GitHub URLs. */
function ReleaseLink({ label, url }) {
  if (typeof url !== 'string' || !url.startsWith('https://github.com/')) return null
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label + ' Release')
}

export function apply(ctx, config = {}) {
  const order = Number.isFinite(config.order) ? config.order : DEFAULT_ORDER
  const Section = (props) => h(LinuxEnvironmentSection, { ...props, linuxBootstrap: ctx.linuxBootstrap })
  const register = () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'linux-environment',
    order,
    label: () => tr('Linux环境', 'Linux environment'),
  }, Section))
  // The slot registry hands back a disposer; routing it through the context
  // removes the section on reload or uninstall instead of leaking it.
  if (typeof ctx.effect === 'function') ctx.effect(register)
  else register()
}

export default { name, inject, apply, LinuxEnvironmentSection, closeSettings }
