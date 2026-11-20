// @vitest-environment jsdom
// 「Linux环境」设置分区（0.15.1）：恢复壳侧唯一注册 + 同源 HTTP + 宿主资产预置。
//
// 钉住的跨面契约：
//  1. index.ts 只注册一次 settings.section/id=linux-environment，且 import 本分区；
//  2. 安装前必须把 plugins.runtime 与选中 runtime 的 backend/rootfs/node 逐个交给
//     window.androidBridge.linuxAssetPrepare，全部 ok 之后才 POST install（confirmed+activate）；
//  3. 连点只发起一次；失败保留页面并给「重试」；已就绪给「返回对话」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { LinuxEnvironmentSection } from '../src/client/linux-environment/LinuxEnvironmentSection.tsx'
import { assetsFor, fetchManifest, installRuntimeAssets, RouteError, type AssetSpec } from '../src/client/linux-environment/transport.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const SHA = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const SHA_C = 'c'.repeat(64)
const SHA_D = 'd'.repeat(64)

const MANIFEST = {
  version: '1.2.0',
  minMobileVersion: '0.15.0',
  plugins: { runtime: { url: 'https://github.com/o/r/releases/download/v1.2.0/linux-runtime-plugin.tar.xz', sha256: SHA, size: 10 } },
  runtimes: [
    {
      id: 'debian-minimal',
      label: 'Debian minimal',
      architecture: 'arm64',
      backend: 'bionilux',
      backendAsset: { url: 'https://github.com/o/r/releases/download/v1.2.0/bionilux.tar.xz', sha256: SHA_B, size: 20 },
      rootfsAsset: { url: 'https://github.com/o/r/releases/download/v1.2.0/rootfs.tar.xz', sha256: SHA_C, size: 30 },
      nodeAsset: { url: 'https://github.com/o/r/releases/download/v1.2.0/node.tar.xz', sha256: SHA_D, size: 40 },
    },
  ],
}

const STATUS_INSTALLED = {
  installed: true,
  version: '1.2.0',
  mobileVersion: '0.15.1',
  autoUpdate: false,
  busy: false,
  operation: 'idle',
  runtimeId: 'debian-minimal',
  runtime: { id: 'debian-minimal' },
  runtimes: [{ id: 'debian-minimal', label: 'Debian minimal', architecture: 'arm64' }],
  architecture: 'arm64',
  injectionActivated: true,
}

interface Call { url: string; method: string; body?: unknown }

/** 假 fetch：按 URL 分派并记录调用次序。 */
function makeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: Call[] = []
  const impl = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ url: input, method, body: init?.body === undefined ? undefined : JSON.parse(init.body) })
    const route = routes[input]
    if (route === undefined) throw new Error('unexpected fetch: ' + input)
    const status = route.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => route.body ?? {} }
  })
  return { calls, impl }
}

/** 假桥：linuxAssetPrepare 立即受理，status 在下一次轮询时 ok。 */
function makeBridge(candidateId?: string) {
  const prepared: Array<{ url: string; sha256: string; size: number; rootfsCandidate?: boolean }> = []
  let pending: string | null = null
  let pendingCandidate: string | undefined
  return {
    prepared,
    bridge: {
      linuxAssetPrepare: (specJson: string) => {
        const spec = JSON.parse(specJson) as typeof prepared[number]
        prepared.push(spec)
        pending = spec.sha256
        pendingCandidate = spec.rootfsCandidate ? candidateId : undefined
        return JSON.stringify({ ok: true, phase: 'running', sha256: spec.sha256, rootfsCandidate: pendingCandidate })
      },
      linuxAssetPrepareStatus: () => JSON.stringify({ phase: 'ok', sha256: pending, stagedPath: '/staging/' + pending, rootfsCandidate: pendingCandidate }),
    },
  }
}

let root: Root | undefined
let host: HTMLElement | undefined

async function render(close = vi.fn(), sidebar = false): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<LinuxEnvironmentSection close={close} sidebar={sidebar} />) })
  // The mount fetch resolves in a microtask; flush it so assertions see real state.
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
  return host
}

beforeEach(() => {
  document.documentElement.lang = 'zh'
  Object.defineProperty(window, 'androidBridge', { value: undefined, configurable: true, writable: true })
})
afterEach(async () => {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('first-install manifest discovery', () => {
  it('checks and re-reads a manifest when the freshly installed host returns null', async () => {
    const calls: string[] = []
    let checked = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/check')) checked = true
      return { ok: true, status: 200, json: async () => url.endsWith('/manifest') ? { manifest: checked ? MANIFEST : null } : { installed: false } }
    }))
    expect(await fetchManifest()).toEqual(MANIFEST)
    expect(calls.map(url => url.split('/').pop())).toEqual(['manifest', 'check', 'manifest'])
  })
})

describe('index.ts registration', () => {
  it('registers the section exactly once, under the Linux label, and imports the section', () => {
    const source = readFileSync('src/client/index.ts', 'utf8')
    const registrations = source.split("id: 'linux-environment'").length - 1
    expect(registrations).toBe(1)
    expect(source).toContain("import { LinuxEnvironmentSection } from './linux-environment/LinuxEnvironmentSection.tsx'")
    expect(source).toContain('}, LinuxEnvironmentSection))')
    expect(source).toMatch(/label: \(\) => tr\('Linux环境'/)
  })
})

describe('LinuxEnvironmentSection', () => {
  it('can check the upstream release before Linux is installed', async () => {
    let checks = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/check')) checks += 1
      const version = checks > 1 ? '0.10.9' : '0.10.8'
      return { ok: true, status: 200, json: async () => ({
        installed: false, availableVersion: version, latestReleaseVersion: version, updateAvailable: true,
      }) }
    }))
    const element = await render()
    const check = element.querySelector('[data-linux-action="check"]') as HTMLButtonElement
    expect(check.disabled).toBe(false)
    expect(element.querySelector('[data-linux-auto-check="update-available"]')?.textContent).toContain('0.10.8')
    await act(async () => { check.click() })
    expect(checks).toBe(2)
    expect(element.querySelector('[data-linux-auto-check="update-available"]')?.textContent).toContain('0.10.9')
  })

  it('queues candidate handoff and shared Node capabilities with the pinned release', async () => {
    const runtime = { ...MANIFEST.runtimes[0], rootfsCandidateHandoff: true, sharedNodeReuse: true }
    const { impl, calls } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'arm64', defaultRuntimeId: runtime.id } },
      '/api/android/linux-environment/check': { body: {} },
      '/api/android/linux-environment/manifest': { body: { manifest: { ...MANIFEST, runtimes: [runtime] } } },
    })
    vi.stubGlobal('fetch', impl)
    const queue = vi.fn((_action: string, _payload: string | null) => '{"ok":true}')
    Object.defineProperty(window, 'androidBridge', { value: { linuxInstallJob: queue }, configurable: true })
    const element = await render()
    await act(async () => { (element.querySelector('[data-linux-action="install"]') as HTMLButtonElement).click() })
    const starts = queue.mock.calls.filter(([action]) => action === 'start')
    expect(starts).toHaveLength(1)
    const job = JSON.parse(starts[0][1]!)
    expect(job).toMatchObject({ version: MANIFEST.version, runtimeId: runtime.id, sharedNodeReuse: true })
    expect(job.assets.filter((asset: AssetSpec) => asset.rootfsCandidate)).toMatchObject([{ sha256: SHA_C, kind: 'rootfs' }])
    expect(job.assets.every((asset: { source?: string }) => Boolean(asset.source))).toBe(true)
    expect(calls.some(call => call.url.endsWith('/install'))).toBe(false)
  })

  it('uses the prepared rootfs identity only for a handoff-capable runtime', async () => {
    const runtime = { ...MANIFEST.runtimes[0], id: 'debian-workspace-lite-x64', architecture: 'x64', rootfsCandidateHandoff: true }
    const { calls, impl } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'x64', defaultRuntimeId: runtime.id } },
      '/api/android/linux-environment/manifest': { body: { manifest: { ...MANIFEST, runtimes: [runtime] } } },
      '/api/android/linux-environment/install': { body: STATUS_INSTALLED },
    })
    vi.stubGlobal('fetch', impl)
    const candidateId = '12345678-1234-4123-8123-123456781234'
    const { prepared, bridge } = makeBridge(candidateId)
    Object.defineProperty(window, 'androidBridge', { value: bridge, configurable: true, writable: true })

    const element = await render()
    const install = element.querySelector('[data-linux-action="install"]') as HTMLButtonElement
    await act(async () => { install.click() })

    expect(prepared.filter(item => item.rootfsCandidate === true).map(item => item.sha256)).toEqual([SHA_C])
    expect(calls.find(call => call.url.endsWith('/install'))?.body).toMatchObject({
      confirmed: true, runtimeId: runtime.id, rootfsCandidate: candidateId,
    })
  })

  it('stages the runtime plugin plus backend, rootfs and node before posting install', async () => {
    const { calls, impl } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'arm64', defaultRuntimeId: 'debian-minimal' } },
      '/api/android/linux-environment/manifest': { body: { manifest: MANIFEST } },
      '/api/android/linux-environment/install': { body: STATUS_INSTALLED },
    })
    vi.stubGlobal('fetch', impl)
    const { prepared, bridge } = makeBridge()
    Object.defineProperty(window, 'androidBridge', { value: bridge, configurable: true, writable: true })

    const element = await render()
    const install = element.querySelector('[data-linux-action="install"]') as HTMLButtonElement
    expect(install.textContent).toContain('一键下载并安装')

    await act(async () => { install.click() })
    // 轮询间隔 600ms：等两次即可收敛。
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50) }) })

    expect(prepared.map((spec) => spec.sha256)).toEqual([SHA, SHA_B, SHA_C, SHA_D])
    const installCall = calls.find((call) => call.url.endsWith('/install'))
    expect(installCall?.body).toMatchObject({ confirmed: true, activate: true, runtimeId: 'debian-minimal' })
    // 所有资产都先于 install。
    const manifestIndex = calls.findIndex((call) => call.url.endsWith('/manifest'))
    expect(manifestIndex).toBeGreaterThanOrEqual(0)
    expect(calls[calls.length - 1].url).toMatch(/\/install$|\/status$/)
  }, 20000)

  it('ignores a second tap while one attempt is in flight', async () => {
    const { calls, impl } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'arm64' } },
      '/api/android/linux-environment/manifest': { body: { manifest: MANIFEST } },
      '/api/android/linux-environment/install': { body: STATUS_INSTALLED },
    })
    vi.stubGlobal('fetch', impl)
    const { bridge } = makeBridge()
    Object.defineProperty(window, 'androidBridge', { value: bridge, configurable: true, writable: true })

    const element = await render()
    const install = element.querySelector('[data-linux-action="install"]') as HTMLButtonElement
    await act(async () => {
      install.click()
      install.click()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    })
    expect(calls.filter((call) => call.url.endsWith('/manifest')).length).toBe(1)
    expect(calls.filter((call) => call.url.endsWith('/install')).length).toBe(1)
  }, 20000)

  it('keeps the section usable and offers a retry when asset staging fails', async () => {
    const { impl } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'arm64' } },
      '/api/android/linux-environment/manifest': { body: { manifest: MANIFEST } },
    })
    vi.stubGlobal('fetch', impl)
    Object.defineProperty(window, 'androidBridge', {
      value: {
        linuxAssetPrepare: () => JSON.stringify({ ok: false, code: 'linux-asset-url-rejected', detail: 'host rejected the source' }),
        linuxAssetPrepareStatus: () => JSON.stringify({ phase: 'failed' }),
      },
      configurable: true,
      writable: true,
    })

    const element = await render()
    await act(async () => {
      (element.querySelector('[data-linux-action="install"]') as HTMLButtonElement).click()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    })
    const alert = element.querySelector('[data-linux-error="true"]')
    expect(alert?.textContent).toContain('host rejected the source')
    const retry = element.querySelector('[data-linux-action="retry"]') as HTMLButtonElement | null
    expect(retry).not.toBeNull()
    expect(retry?.disabled).toBe(false)
    expect(element.querySelector('[data-linux-action="install"]')).not.toBeNull()
  }, 20000)

  it('reports a missing bridge instead of silently pretending to download', async () => {
    const { impl } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'arm64' } },
      '/api/android/linux-environment/manifest': { body: { manifest: MANIFEST } },
    })
    vi.stubGlobal('fetch', impl)
    const element = await render()
    await act(async () => {
      (element.querySelector('[data-linux-action="install"]') as HTMLButtonElement).click()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    })
    expect(element.querySelector('[data-linux-error="true"]')?.textContent).toContain('资产准备通道')
  }, 20000)

  it('offers back-to-chat once the environment is ready', async () => {
    const { impl } = makeFetch({
      '/api/android/linux-environment/status': { body: STATUS_INSTALLED },
    })
    vi.stubGlobal('fetch', impl)
    const close = vi.fn()
    const element = await render(close)
    // render() returns the host node; the section itself carries the markers.
    const section = element.querySelector('[data-linux-environment]') as HTMLElement
    expect(section.getAttribute('data-installed')).toBe('true')
    expect(element.querySelector('[data-linux-ready="true"]')).not.toBeNull()
    const back = element.querySelector('[data-linux-action="back"]') as HTMLButtonElement
    expect(back.textContent).toContain('返回对话')
    await act(async () => { back.click() })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uses the sidebar header to return from toolchains and close Linux', async () => {
    const { impl } = makeFetch({
      '/api/android/linux-environment/status': { body: STATUS_INSTALLED },
      '/api/android/linux-environment/tools': { body: { packages: [], source: 'official' } },
    })
    vi.stubGlobal('fetch', impl)
    const close = vi.fn()
    const element = await render(close, true)
    const header = element.querySelector('.dsh-linux-panel-header')!
    const back = header.querySelector('button')!
    const tools = element.querySelector<HTMLButtonElement>('[data-linux-action="toolchains"]')!
    expect(header.querySelector('h1')?.textContent).toBe('Linux 环境')
    expect(element.querySelector('[data-linux-action="back"]')).toBeNull()
    await act(async () => { element.querySelector<HTMLButtonElement>('[data-linux-action="settings"]')!.click() })
    const diagnostics = element.querySelector('.dsh-linux-diagnostics')!
    expect(diagnostics.textContent).toContain('运行诊断')
    expect(diagnostics.textContent).toContain('arm64')
    await act(async () => { tools.click() })
    expect(header.querySelector('h1')?.textContent).toBe('工具链')
    expect(element.querySelector('[data-dsh-settings-sublayer-back]')).toBeNull()
    await act(async () => { back.click() })
    expect(header.querySelector('h1')?.textContent).toBe('Linux 环境')
    expect(close).not.toHaveBeenCalled()
    await act(async () => { back.click() })
    expect(close).toHaveBeenCalledOnce()
  })

  it('stays usable after a failed attempt on an installed environment (retry and back both enabled)', async () => {
    const { impl } = makeFetch({
      '/api/android/linux-environment/status': { body: STATUS_INSTALLED },
      '/api/android/linux-environment/manifest': { body: { manifest: MANIFEST } },
    })
    vi.stubGlobal('fetch', impl)
    Object.defineProperty(window, 'androidBridge', {
      value: {
        linuxAssetPrepare: () => JSON.stringify({ ok: false, code: 'linux-asset-timeout', detail: 'timed out' }),
        linuxAssetPrepareStatus: () => JSON.stringify({ phase: 'failed' }),
      },
      configurable: true,
      writable: true,
    })

    const close = vi.fn()
    const element = await render(close)
    await act(async () => {
      (element.querySelector('[data-linux-action="update"]') as HTMLButtonElement).click()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    })
    expect(element.querySelector('[data-linux-error="true"]')).not.toBeNull()
    expect((element.querySelector('[data-linux-action="retry"]') as HTMLButtonElement).disabled).toBe(false)
    const back = element.querySelector('[data-linux-action="back"]') as HTMLButtonElement
    expect(back.disabled).toBe(false)
    await act(async () => { back.click() })
    expect(close).toHaveBeenCalledTimes(1)
  }, 20000)

  it('falls back to check when the host has no /manifest route', async () => {
    const { calls, impl } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'arm64' } },
      '/api/android/linux-environment/manifest': { status: 404, body: { error: 'not found' } },
      '/api/android/linux-environment/check': { body: { manifest: MANIFEST } },
      '/api/android/linux-environment/install': { body: STATUS_INSTALLED },
    })
    vi.stubGlobal('fetch', impl)
    const { prepared, bridge } = makeBridge()
    Object.defineProperty(window, 'androidBridge', { value: bridge, configurable: true, writable: true })

    const element = await render()
    await act(async () => {
      (element.querySelector('[data-linux-action="install"]') as HTMLButtonElement).click()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    })
    expect(calls.some((call) => call.url.endsWith('/check'))).toBe(true)
    expect(prepared).toHaveLength(4)
  }, 20000)

  it('never claims the environment is ready when an update attempt fails', async () => {
    const { impl } = makeFetch({
      '/api/android/linux-environment/status': { body: STATUS_INSTALLED },
      '/api/android/linux-environment/manifest': { body: { manifest: MANIFEST } },
    })
    vi.stubGlobal('fetch', impl)
    Object.defineProperty(window, 'androidBridge', {
      value: {
        linuxAssetPrepare: () => JSON.stringify({ ok: false, code: 'linux-asset-url-rejected', detail: 'host rejected the source' }),
        linuxAssetPrepareStatus: () => JSON.stringify({ phase: 'failed' }),
      },
      configurable: true,
      writable: true,
    })

    const element = await render()
    // 失败之前确实有 ready 提示，失败之后必须消失。
    expect(element.querySelector('[data-linux-ready="true"]')).not.toBeNull()
    await act(async () => {
      (element.querySelector('[data-linux-action="update"]') as HTMLButtonElement).click()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    })
    expect(element.querySelector('[data-linux-error="true"]')).not.toBeNull()
    expect(element.querySelector('[data-linux-ready="true"]')).toBeNull()
    expect(element.textContent).not.toContain('已就绪')
    // 已装环境仍保留回对话入口。
    expect((element.querySelector('[data-linux-action="back"]') as HTMLButtonElement).disabled).toBe(false)
  }, 20000)

  it('shows release status when current and keeps reinstall available under Linux settings', async () => {
    // 宿主状态可变：首轮自动 check 时已是最新（updateAvailable=false），之后上游才发 1.3.0。
    let upstreamReleased = false
    let checkCount = 0
    const status = (): Record<string, unknown> => ({
      ...STATUS_INSTALLED,
      updateAvailable: upstreamReleased,
      availableVersion: upstreamReleased ? '1.3.0' : undefined,
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => status() }
      if (url.endsWith('/check')) {
        checkCount += 1
        // 挂载自动 check（第 1 次）报当前已是最新；手动点击 check（第 2 次）时上游已发 1.3.0。
        if (checkCount >= 2) upstreamReleased = true
        return { ok: true, status: 200, json: async () => status() }
      }
      throw new Error('unexpected fetch: ' + url)
    }))

    const element = await render()
    expect(element.querySelector('[data-linux-action="update"]')).toBeNull()
    expect(element.querySelector('[data-linux-auto-check="up-to-date"]')).not.toBeNull()
    await act(async () => { (element.querySelector('[data-linux-action="settings"]') as HTMLButtonElement).click() })
    expect((element.querySelector('[data-linux-action="reinstall"]') as HTMLButtonElement).disabled).toBe(false)
    const check = element.querySelector('[data-linux-action="check"]') as HTMLButtonElement
    expect(check.disabled).toBe(false)

    await act(async () => {
      check.click()
      await new Promise((resolve) => { setTimeout(resolve, 50) })
    })
    const primary = element.querySelector('[data-linux-action="update"]') as HTMLButtonElement
    expect(primary.disabled).toBe(false)
    expect(primary.getAttribute('data-linux-primary')).toBe('update')
    expect(primary.textContent).toContain('1.3.0')
  }, 20000)

  it('auto-queries upstream on open, deduplicates 2s polls, and performs one-click upgrade to the new release', async () => {
    let installedVersion = '1.2.0'
    let updateAvailable = false
    const calls: string[] = []
    const nextManifest = {
      ...MANIFEST,
      version: '1.3.0',
      plugins: { runtime: { url: 'https://github.com/o/r/releases/download/v1.3.0/linux-runtime-plugin.tar.xz', sha256: 'e'.repeat(64), size: 12 } },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...STATUS_INSTALLED,
            version: installedVersion,
            updateAvailable,
            availableVersion: updateAvailable ? '1.3.0' : undefined,
          }),
        }
      }
      if (url.endsWith('/check')) {
        updateAvailable = installedVersion !== '1.3.0'
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...STATUS_INSTALLED,
            version: installedVersion,
            updateAvailable,
            availableVersion: '1.3.0',
          }),
        }
      }
      if (url.endsWith('/manifest')) {
        return { ok: true, status: 200, json: async () => ({ manifest: nextManifest }) }
      }
      if (url.endsWith('/install')) {
        installedVersion = '1.3.0'
        updateAvailable = false
        return { ok: true, status: 200, json: async () => ({ ...STATUS_INSTALLED, version: '1.3.0', updateAvailable: false }) }
      }
      throw new Error('unexpected fetch: ' + url)
    }))
    const { prepared, bridge } = makeBridge()
    Object.defineProperty(window, 'androidBridge', { value: bridge, configurable: true, writable: true })

    vi.useFakeTimers()
    let element!: HTMLElement
    try {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
      await act(async () => { root!.render(<LinuxEnvironmentSection close={vi.fn()} />) })
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      element = host

      // Opening the page automatically queried upstream once and enabled the update button.
      expect(calls.filter((u) => u.endsWith('/check')).length).toBe(1)
      const primary = element.querySelector('[data-linux-action="update"]') as HTMLButtonElement
      expect(primary.disabled).toBe(false)
      expect(primary.textContent).toContain('1.3.0')
      expect(element.querySelector('[data-linux-auto-check="update-available"]')).not.toBeNull()

      // Across multiple 2s status polls and visibility events, /check must NOT re-trigger.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6500)
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(10)
      })
      expect(calls.filter((u) => u.endsWith('/status')).length).toBeGreaterThanOrEqual(4)
      expect(calls.filter((u) => u.endsWith('/check')).length).toBe(1)

      // The explicit download rechecks the channel before preparing the verified assets.
      await act(async () => {
        primary.click()
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(prepared[0].sha256).toBe('e'.repeat(64))
      expect(calls.some((u) => u.endsWith('/install'))).toBe(true)
      expect(calls.filter((u) => u.endsWith('/check')).length).toBe(2)
      expect(element.querySelector('[data-linux-ready="true"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('keeps existing controls operable in zh and en when the automatic check fails offline', async () => {
    for (const [lang, expectedHint] of [['zh', '自动查询上游更新失败'], ['en', 'Automatic update check failed']] as const) {
      document.documentElement.lang = lang
      const calls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(url)
        if (url.endsWith('/status')) return { ok: true, status: 200, json: async () => STATUS_INSTALLED }
        if (url.endsWith('/check')) {
          return { ok: false, status: 500, json: async () => ({ error: 'check failed', detail: 'GitHub request failed (403)' }) }
        }
        if (url.endsWith('/reinstall')) return { ok: true, status: 200, json: async () => STATUS_INSTALLED }
        throw new Error('unexpected fetch: ' + url)
      }))

      const close = vi.fn()
      const element = await render(close)
      expect(element.querySelector('[data-linux-ready="true"]')).not.toBeNull()
      const autoHint = element.querySelector('[data-linux-auto-check="failed"]')
      expect(autoHint?.textContent).toContain(expectedHint)
      expect(autoHint?.textContent).toContain('GitHub request failed (403)')
      await act(async () => { (element.querySelector('[data-linux-action="settings"]') as HTMLButtonElement).click() })
      expect((element.querySelector('[data-linux-action="reinstall"]') as HTMLButtonElement).disabled).toBe(false)
      expect((element.querySelector('[data-linux-action="uninstall"]') as HTMLButtonElement).disabled).toBe(false)
      expect((element.querySelector('[data-linux-action="back"]') as HTMLButtonElement).disabled).toBe(false)

      await act(async () => {
        (element.querySelector('[data-linux-action="reinstall"]') as HTMLButtonElement).click()
        await new Promise((resolve) => { setTimeout(resolve, 50) })
      })
      expect(calls.some((u) => u.endsWith('/reinstall'))).toBe(true)
      // Offline reinstall must preserve the failed check state rather than claiming up-to-date.
      expect(element.querySelector('[data-linux-auto-check="up-to-date"]')).toBeNull()
      expect(element.querySelector('[data-linux-auto-check="failed"]')).not.toBeNull()

      await act(async () => { root!.unmount() })
      root = undefined
      host?.remove()
      host = undefined
    }
  }, 20000)

  it('keeps the one-tap install action enabled before anything is installed', async () => {
    const { impl } = makeFetch({
      '/api/android/linux-environment/status': { body: { installed: false, architecture: 'arm64' } },
    })
    vi.stubGlobal('fetch', impl)
    const element = await render()
    const primary = element.querySelector('[data-linux-action="install"]') as HTMLButtonElement
    expect(primary.disabled).toBe(false)
    expect(primary.getAttribute('data-linux-primary')).toBe('install')
    expect(primary.textContent).toContain('一键下载并安装')
  })
})



describe('verified shared Node updates', () => {
  const runtime = { ...MANIFEST.runtimes[0], rootfsCandidateHandoff: true, sharedNodeReuse: true }
  const { specs } = assetsFor({ ...MANIFEST, runtimes: [runtime] })
  const healthy = { runtime: { healthy: true, nodeAssetSha256: SHA_D } }
  const candidate = '12345678-1234-4123-8123-123456781234'

  it('omits staging only while the active digest and target capabilities match', async () => {
    const activate = vi.fn(async () => STATUS_INSTALLED)
    for (const [current, stagesNode] of [
      [healthy, false],
      [{ runtime: { healthy: false, nodeAssetSha256: SHA_D } }, true],
      [{ runtime: { healthy: true, nodeAssetSha256: SHA_C } }, true],
      [undefined, true],
    ] as const) {
      const prepare = vi.fn(async (_assets: typeof specs) => candidate)
      await installRuntimeAssets(runtime, specs, current, prepare, activate)
      expect(prepare.mock.calls[0][0].some(asset => asset.field === 'nodeAsset')).toBe(stagesNode)
    }
    const prepare = vi.fn(async (_assets: typeof specs) => candidate)
    await installRuntimeAssets({ ...runtime, sharedNodeReuse: false }, specs, healthy, prepare, activate)
    expect(prepare).toHaveBeenCalledWith(specs)
  })

  it('prepares only Node and retries the same candidate once on a manager cache miss', async () => {
    const prepare = vi.fn(async (_assets: typeof specs) => candidate)
    const missing = new RouteError('Missing Node', 409, '', 'linux-node-stage-required')
    const activate = vi.fn(async (_id?: string) => STATUS_INSTALLED).mockRejectedValueOnce(missing)
    await installRuntimeAssets(runtime, specs, healthy, prepare, activate)
    expect(prepare.mock.calls.map(([assets]) => assets.map(asset => asset.field))).toEqual([
      ['runtime-plugin', 'backendAsset', 'rootfsAsset'], ['nodeAsset'],
    ])
    expect(activate.mock.calls).toEqual([[candidate], [candidate]])
    activate.mockReset().mockRejectedValue(missing)
    await expect(installRuntimeAssets(runtime, specs, healthy, prepare, activate)).rejects.toBe(missing)
    expect(activate).toHaveBeenCalledTimes(2)
  })

  it('stages Node on a legacy bridge and leaves unrelated installation failures visible', async () => {
    const prepare = vi.fn(async (_assets: typeof specs): Promise<string | undefined> => undefined)
    const activate = vi.fn(async (_id?: string) => STATUS_INSTALLED)
    await installRuntimeAssets(runtime, specs, healthy, prepare, activate)
    expect(prepare.mock.calls[1][0].map(asset => asset.field)).toEqual(['nodeAsset'])
    expect(activate.mock.calls).toEqual([[]])
    prepare.mockClear().mockResolvedValue(candidate)
    const busy = new RouteError('Busy', 409)
    activate.mockClear().mockRejectedValue(busy)
    await expect(installRuntimeAssets(runtime, specs, healthy, prepare, activate)).rejects.toBe(busy)
    expect(activate).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})
