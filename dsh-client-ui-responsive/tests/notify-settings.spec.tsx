// @vitest-environment jsdom
// 0.14.1 块J FIX-4 客户端半（J-1 修复）：通知设置入口必须真的可达。
//
// 缺陷背景：壳侧 `NotifyCenter.settingsSnapshot` / `applySetting` 全仓零外部调用点、
// 桥面无 notify/suppress 方法、本目录 grep 0 命中——能力在、入口无。本套件把「可达」钉成行为断言：
// 挂载即从真源读、写必须经桥、写后回读 applied=false 不得置位、未知/失败如实显示。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NotifySettingsRow } from '../src/client/dev-section/notify-settings.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface BridgeCall { kind: 'get' | 'set'; key: string; value?: boolean }

/** 假桥：记录调用并返回配置的 JSON 应答（真源读面 = 每次调用现算，模拟壳侧回读）。 */
function makeBridge(options: {
  snapshot?: (key: string) => unknown
  write?: (key: string, value: boolean) => unknown
  absent?: boolean
}) {
  const calls: BridgeCall[] = []
  const bridge: Record<string, unknown> = {
    getNotifySetting: (key?: string) => {
      calls.push({ kind: 'get', key: key ?? '' })
      return JSON.stringify(options.snapshot?.(key ?? '') ?? { ok: true })
    },
    setNotifySetting: (key: string, value: boolean) => {
      calls.push({ kind: 'set', key, value })
      return JSON.stringify(options.write?.(key, value) ?? { ok: true, applied: true, reason: 'ok' })
    },
  }
  return { calls, bridge }
}

let root: Root | undefined
let host: HTMLElement | undefined

function setBridge(value: unknown): void {
  Object.defineProperty(window, 'androidBridge', { value, configurable: true, writable: true })
}

async function render(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<NotifySettingsRow />) })
  return host
}

function switchByLabel(el: HTMLElement, label: string): HTMLInputElement {
  const input = el.querySelector('input[aria-label="' + label + '"]')
  if (input === null) throw new Error('找不到开关：' + label)
  return input as HTMLInputElement
}

/** 壳侧快照工厂（五类默认全开）。 */
function snapshot(overrides: { suppressForeground?: boolean; categories?: Record<string, boolean> } = {}) {
  return {
    ok: true,
    suppressForeground: overrides.suppressForeground ?? false,
    suppressForegroundDefault: false,
    categories: overrides.categories ?? {
      report: true, question: true, approval: true, todo: true, silent: true,
    },
  }
}

beforeEach(() => { setBridge(undefined) })
afterEach(async () => {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  vi.restoreAllMocks()
})

describe('NotifySettingsRow（块J FIX-4 设置页入口）', () => {
  it('挂载即从壳侧真源读取（不是本地默认值，也不是一次性裸读）', async () => {
    const { calls, bridge } = makeBridge({ snapshot: () => snapshot({ suppressForeground: true }) })
    setBridge(bridge)
    const el = await render()

    expect(calls.filter((c) => c.kind === 'get').length).toBeGreaterThan(0)
    // 展示值必须等于真源：true = 抑制开启。
    expect(switchByLabel(el, '前台抑制通知').checked).toBe(true)
    expect(el.textContent).toContain('前台抑制开启')
  })

  it('默认值下开关为关且文案说明「前台照常推送」', async () => {
    const { bridge } = makeBridge({ snapshot: () => snapshot() })
    setBridge(bridge)
    const el = await render()
    expect(switchByLabel(el, '前台抑制通知').checked).toBe(false)
    expect(el.textContent).toContain('前台照常推送')
    expect(el.textContent).toContain('等于本版默认值')
  })

  it('拨动开关必须经桥写入，并按返回读回（真源变才置位）', async () => {
    let stored = false
    const { calls, bridge } = makeBridge({
      snapshot: () => snapshot({ suppressForeground: stored }),
      write: () => { stored = true; return { ok: true, applied: true, reason: 'ok' } },
    })
    setBridge(bridge)
    const el = await render()

    await act(async () => { switchByLabel(el, '前台抑制通知').click() })

    const writes = calls.filter((c) => c.kind === 'set')
    expect(writes).toEqual([{ kind: 'set', key: 'suppressForeground', value: true }])
    // 写后必须再读真源（而不是把入参写进本地 state）。
    expect(calls.filter((c) => c.kind === 'get').length).toBeGreaterThanOrEqual(2)
    expect(switchByLabel(el, '前台抑制通知').checked).toBe(true)
  })

  it('applied=false 时不得置位，并如实显示真因（拒绝乐观置位）', async () => {
    const { calls, bridge } = makeBridge({
      snapshot: () => snapshot({ suppressForeground: false }),
      write: () => ({ ok: true, applied: false, reason: 'readback-mismatch' }),
    })
    setBridge(bridge)
    const el = await render()

    await act(async () => { switchByLabel(el, '前台抑制通知').click() })

    expect(calls.some((c) => c.kind === 'set')).toBe(true)
    // 真源仍为 false ⇒ 开关必须仍是关的（不得乐观置位）。
    expect(switchByLabel(el, '前台抑制通知').checked).toBe(false)
    expect(el.textContent).toContain('未生效')
    expect(el.textContent).toContain('readback-mismatch')
  })

  it('五类分类开关各自经桥写入 cat.<类别>，且展示值取自真源', async () => {
    const cats: Record<string, boolean> = {
      report: true, question: true, approval: true, todo: true, silent: false,
    }
    const { calls, bridge } = makeBridge({
      snapshot: () => snapshot({ categories: cats }),
      write: (key, value) => { cats[key.slice(4)] = value; return { ok: true, applied: true, reason: 'ok' } },
    })
    setBridge(bridge)
    const el = await render()

    expect(switchByLabel(el, '后台动态').checked).toBe(false)
    expect(switchByLabel(el, '工作汇报').checked).toBe(true)

    await act(async () => { switchByLabel(el, '工作汇报').click() })
    expect(calls.filter((c) => c.kind === 'set')).toEqual([{ kind: 'set', key: 'cat.report', value: false }])
    expect(switchByLabel(el, '工作汇报').checked).toBe(false)
  })

  it('桥缺席时显示不可用，绝不显示伪造的开关状态', async () => {
    setBridge(undefined)
    const el = await render()
    expect(el.textContent).toContain('通知设置不可用')
    expect(el.querySelector('input[role="switch"]')).toBeNull()
  })

  it('壳侧明确拒绝（ok=false）时同样按不可用处理，不当作「全部默认值」', async () => {
    const { bridge } = makeBridge({ snapshot: () => ({ ok: false, reason: 'no-shell-context' }) })
    setBridge(bridge)
    const el = await render()
    expect(el.textContent).toContain('通知设置不可用')
    expect(el.querySelector('input[role="switch"]')).toBeNull()
  })

  it('写调用抛异常时显示失败且不崩', async () => {
    const bridge = {
      getNotifySetting: () => JSON.stringify(snapshot()),
      setNotifySetting: () => { throw new Error('bridge blew up') },
    }
    setBridge(bridge)
    const el = await render()
    await act(async () => { switchByLabel(el, '前台抑制通知').click() })
    expect(el.textContent).toContain('写入失败')
    expect(switchByLabel(el, '前台抑制通知').checked).toBe(false)
  })

  it('回前台重读真源（从系统设置返回后展示值不得陈旧）', async () => {
    let stored = false
    const { bridge } = makeBridge({ snapshot: () => snapshot({ suppressForeground: stored }) })
    setBridge(bridge)
    const el = await render()
    expect(switchByLabel(el, '前台抑制通知').checked).toBe(false)

    // 模拟「在别处（壳侧/adb）改了真源，然后回到页面」。
    stored = true
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(switchByLabel(el, '前台抑制通知').checked).toBe(true)
  })
})
