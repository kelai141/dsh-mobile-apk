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
import { toggleOf } from './toggle.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface BridgeCall { kind: 'get' | 'set'; key: string; value?: boolean }

/** 假桥：记录调用并返回配置的 JSON 应答（真源读面 = 每次调用现算，模拟壳侧回读）。 */
function makeBridge(options: {
  snapshot?: (key: string) => unknown
  write?: (key: string, value: boolean) => unknown
  selfCheck?: () => unknown
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
    // 自检面：形状必须与壳侧 `NotifyCenter.selfCheck` 一致（channels[].selected/exists/degraded/importanceLabel）。
    notifySelfCheck: () => JSON.stringify(options.selfCheck?.() ?? shellSelfCheck()),
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

function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent === text)
  if (button === undefined) throw new Error('找不到按钮：' + text)
  return button as HTMLButtonElement
}

function switchByLabel(el: HTMLElement, label: string): HTMLInputElement {
  return toggleOf(el, label)
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

/**
 * 壳侧 `NotifyCenter.selfCheck` 的真实形状（字段名逐字对齐，P3-1）。
 * 旧页面读 `degraded: string[]` 顶层数组 + `channelId`/`enabled`，三个字段壳侧都不发送 ⇒
 * 界面永远显示「系统通知状态正常」。
 */
function shellSelfCheck(overrides: { channels?: unknown[] } = {}) {
  return {
    ok: true,
    notificationsEnabled: true,
    permissionGranted: true,
    permissionLabel: '已授予',
    channels: overrides.channels ?? [
      { category: 'report', label: '工作汇报', selected: 'dsh-report', exists: true, importance: 4, importanceLabel: '高（会弹到屏幕上并响铃）', degraded: false },
      { category: 'question', label: '提问', selected: 'dsh-question', exists: true, importance: 4, importanceLabel: '高（会弹到屏幕上并响铃）', degraded: false },
    ],
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
    expect(el.textContent).toContain('系统没有接受这次改动')
    // P3-1/P3-6：码不上屏（旧断言把「未生效（readback-mismatch）：cat.question」当契约），只进 data-code。
    expect(el.textContent, '机器码不得出现在正文').not.toContain('readback-mismatch')
    expect(el.textContent, '内部 key 不得出现在正文').not.toContain('cat.')
    expect(el.querySelector('[data-code="readback-mismatch"]'), '码必须可诊断').not.toBeNull()
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

  it('自检：系统把渠道降级时必须说「已降级」，不得显示「未降级任何渠道」', async () => {
    const { bridge } = makeBridge({
      selfCheck: () => shellSelfCheck({
        channels: [
          { category: 'question', label: '提问', selected: 'dsh-question', exists: true, importance: 2, importanceLabel: '低（只在通知栏提示，不响铃）', degraded: true },
        ],
      }),
    })
    setBridge(bridge)
    const el = await render()
    await act(async () => { buttonByText(el, '通知自检').click() })

    expect(el.textContent).toContain('系统已降级以下通知')
    expect(el.textContent).toContain('提问')
    expect(el.textContent, '降级时不得再声称未降级').not.toContain('系统未降级任何通知渠道')
    // 档位取壳侧人话，不印数字（旧页面印的是「（重要性 4）」）。
    expect(el.textContent).toContain('低（只在通知栏提示，不响铃）')
    expect(el.textContent).not.toContain('重要性 2')
  })

  it('自检：未被降级时明确说「未降级任何渠道」（与上一条互为正反）', async () => {
    const { bridge } = makeBridge({ selfCheck: () => shellSelfCheck() })
    setBridge(bridge)
    const el = await render()
    await act(async () => { buttonByText(el, '通知自检').click() })
    expect(el.textContent).toContain('系统未降级任何通知渠道')
    expect(el.textContent).not.toContain('系统已降级以下通知')
    // 总开关与权限也要可见（任务不提醒时用户能看出是哪一层被关）。
    expect(el.textContent).toContain('应用通知总开关')
    expect(el.textContent).toContain('已授予')
  })

  it('自检：渠道设置深链用的是壳侧给的 selected 渠道 id', async () => {
    const opened: string[] = []
    const { bridge } = makeBridge({ selfCheck: () => shellSelfCheck() })
    ;(bridge as Record<string, unknown>).openNotifyChannelSettings = (channelId: string) => {
      opened.push(channelId)
      return true
    }
    setBridge(bridge)
    const el = await render()
    await act(async () => { buttonByText(el, '通知自检').click() })
    const link = [...el.querySelectorAll('button')].find((b) => b.textContent === '打开该渠道设置')
    expect(link, '自检行必须有渠道深链').toBeDefined()
    await act(async () => { (link as HTMLButtonElement).click() })
    expect(opened).toEqual(['dsh-report'])
  })

  it('S3-26：测试通知按钮经桥发送，并按真实条数如实回执', async () => {
    const calls: number[] = []
    const { bridge } = makeBridge({})
    ;(bridge as Record<string, unknown>).notifySendTest = () => { calls.push(1); return 5 }
    setBridge(bridge)
    const el = await render()
    await act(async () => { buttonByText(el, '发送测试通知').click() })
    expect(calls.length).toBe(1)
    expect(el.textContent).toContain('已发送 5 条测试通知')
  })

  it('S3-26：一条都没发出去时必须如实说没发出去（不得谎报已发送）', async () => {
    const { bridge } = makeBridge({})
    ;(bridge as Record<string, unknown>).notifySendTest = () => 0
    setBridge(bridge)
    const el = await render()
    await act(async () => { buttonByText(el, '发送测试通知').click() })
    expect(el.textContent).toContain('一条也没发出去')
    expect(el.textContent).not.toContain('已发送')
  })

  it('P3-2：五类用词与壳侧渠道名同源（同一概念不许两个名字）', async () => {
    const { bridge } = makeBridge({})
    setBridge(bridge)
    const el = await render()
    // 第一行是「前台抑制」，五个分类从第二行起。
    const labels = [...el.querySelectorAll('button[role="switch"]')]
      .slice(1)
      .map((button) => button.getAttribute('aria-label'))
    // 这五个词必须与壳侧 `UserCopy.notifyCategory` + `NotifyCenter.Face.label` 逐字一致
    // （Kotlin 侧 `UserCopyTest.faceLabelsShareTheSingleTable` 钉住那一半）。
    expect(labels).toEqual(['工作汇报', '提问', '授权请求', '待办进度', '后台动态'])
  })

  it('P3-5：通知设置已从「开发者选项」提级为设置页一级分区（源码级形态断言）', async () => {
    const fs = await import('node:fs')
    const index = fs.readFileSync('src/client/index.ts', 'utf8')
    // 一级分区在场，且指向本文件的区块组件（不是行组件）。
    expect(index).toContain("id: 'android-notify'")
    expect(index).toContain('NotifySettingsSection')
    // 开发者选项里不得再渲染同一组开关（同功能双实现是审查档 §5 的结构性根因）；
    // 只允许留一行指路文案。
    const dev = fs.readFileSync('src/client/dev-section/DevSection.tsx', 'utf8')
    expect(dev, '开发者选项不得再内嵌 NotifySettingsRow').not.toContain('<NotifySettingsRow')
    expect(dev).toContain('设置 → 通知')
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
