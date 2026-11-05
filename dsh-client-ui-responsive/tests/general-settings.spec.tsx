// @vitest-environment jsdom
// ST-10 页侧回归（离线）：沉浸式开关的初值必须以壳桥 getImmersiveMode() 为准，
// localStorage 只在桥缺失时兜底（旧实现以 localStorage 为初值 → 与壳侧真值分裂）。
// 2026-10-23：本分区的控件换成上游 Switch（不再用原生 checkbox +
// 描边按钮）；2026-10-24 语言行退役，所以断言从 `input.checked` 改为开关的 `aria-checked`；
// 另加一组结构断言：本页不允许再出现浏览器原生勾选框，行骨架必须是通用设置的行规。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GeneralSettings } from '../src/client/general-settings/GeneralSettings.tsx'
import { LEFT_SWIPE_KEY, RIGHT_SWIPE_KEY } from '../src/client/mobile/sidebar-gestures.ts'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const KEY = 'dsh.android.immersive'

let root: Root | undefined
let host: HTMLElement | undefined

/** 一个上游开关的可访问选中态（button[role=switch] 用 aria-checked 表达开/关）。 */
function checked(el: Element | null): boolean {
  expect(el).not.toBeNull()
  return el!.getAttribute('aria-checked') === 'true'
}

/** 沉浸式那一行的开关（行上有 data-dsh-immersive，避免用“第几个开关”这种顺序断言）。 */
function immersiveSwitch(): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>('[data-dsh-immersive] [role="switch"]')!
}

/** 侧栏滑动某一边的开关。 */
function swipeSwitch(side: 'left' | 'right'): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>(`[data-dsh-sidebar-swipe="${side}"] [role="switch"]`)!
}

async function render(bridge?: Record<string, unknown>): Promise<void> {
  delete window.androidBridge
  if (bridge !== undefined) window.androidBridge = bridge as never
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<GeneralSettings {...({} as never)} />)
  })
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* jsdom storage always present; guard for parity */ }
  delete window.androidBridge
})

afterEach(async () => {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  delete window.androidBridge
})

describe('GeneralSettings 沉浸式开关（ST-10）', () => {
  it('桥与 localStorage 冲突时以桥为准（桥 true / 存储 "0" → 开）', async () => {
    localStorage.setItem(KEY, '0')
    await render({ getImmersiveMode: () => true })
    expect(checked(immersiveSwitch())).toBe(true)
  })

  it('桥与 localStorage 冲突时以桥为准（桥 false / 存储 "1" → 关）', async () => {
    localStorage.setItem(KEY, '1')
    await render({ getImmersiveMode: () => false })
    expect(checked(immersiveSwitch())).toBe(false)
  })

  it('桥缺失时回落 localStorage（"0" → 关）', async () => {
    localStorage.setItem(KEY, '0')
    await render()
    expect(checked(immersiveSwitch())).toBe(false)
  })

  it('桥缺失且无存储值时用壳侧同款默认（true → 开）', async () => {
    await render()
    expect(checked(immersiveSwitch())).toBe(true)
  })

  it('桥抛错时也走存储兜底，不把开关打成关闭', async () => {
    localStorage.setItem(KEY, '1')
    await render({ getImmersiveMode: () => { throw new Error('bridge broken') } })
    expect(checked(immersiveSwitch())).toBe(true)
  })

  it('切换同时写存储镜像并单向推桥，展示值回到壳侧真值', async () => {
    const state = { immersive: true }
    const setImmersiveMode = vi.fn((v: boolean) => { state.immersive = v })
    await render({ getImmersiveMode: () => state.immersive, setImmersiveMode })
    expect(checked(immersiveSwitch())).toBe(true)
    await act(async () => { immersiveSwitch().click() })
    expect(setImmersiveMode).toHaveBeenCalledWith(false)
    expect(localStorage.getItem(KEY)).toBe('0')
    // 写后回读：展示值跟随壳侧真值（stub 已同步翻转）
    expect(checked(immersiveSwitch())).toBe(false)
  })

  it('ST-09：只动壳侧真源 + 回前台 → 展示跟随（不重挂载、不靠 localStorage）', async () => {
    const state = { immersive: true }
    localStorage.setItem(KEY, '1') // 存储镜像与真源相反：必须听真源
    await render({ getImmersiveMode: () => state.immersive })
    expect(checked(immersiveSwitch())).toBe(true)
    state.immersive = false // 系统设置里关掉（只动系统侧）
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(checked(immersiveSwitch())).toBe(false)
  })
})

// ── 0.14.1 批 9（§3.3 S3-17）：本项此前是全仓唯一没有失败反馈路径的设置项 ─────────
describe('GeneralSettings 沉浸式开关的失败回执（S3-17）', () => {
  it('写后回读与请求不一致时如实说明（不得默默回弹）', async () => {
    // 壳桥接受调用但不改变真值（宿主拒绝）——旧实现 refresh 一下，开关自己弹回去，屏上无解释。
    await render({ getImmersiveMode: () => true, setImmersiveMode: () => {} })
    await act(async () => { immersiveSwitch().click() })
    expect(host!.textContent).toContain('状态栏没有恢复')
  })

  it('桥抛错时给失败回执（不假装已生效）', async () => {
    await render({
      getImmersiveMode: () => false,
      setImmersiveMode: () => { throw new Error('bridge blew up') },
    })
    await act(async () => { immersiveSwitch().click() })
    expect(host!.textContent).toContain('设置没有生效')
  })

  it('正常生效时不得出现任何失败文案', async () => {
    let value = false
    await render({ getImmersiveMode: () => value, setImmersiveMode: (v: boolean) => { value = v } })
    await act(async () => { immersiveSwitch().click() })
    expect(value).toBe(true)
    expect(host!.textContent).not.toContain('设置没有生效')
    expect(host!.textContent).not.toContain('没有开启')
  })
})

describe('GeneralSettings 左右侧栏滑动开关（#335）', () => {
  it('默认各自开启，且分别持久化，不互相改写', async () => {
    await render()
    expect(checked(immersiveSwitch())).toBe(true)
    expect(checked(swipeSwitch('left'))).toBe(true)
    expect(checked(swipeSwitch('right'))).toBe(true)
    await act(async () => { swipeSwitch('left').click() })
    expect(localStorage.getItem(LEFT_SWIPE_KEY)).toBe('0')
    expect(localStorage.getItem(RIGHT_SWIPE_KEY)).toBeNull()
    expect(checked(swipeSwitch('right'))).toBe(true)
    await act(async () => { swipeSwitch('right').click() })
    expect(localStorage.getItem(RIGHT_SWIPE_KEY)).toBe('0')
    expect(checked(swipeSwitch('left'))).toBe(false)
  })

  it('从各自存储恢复，而不依赖 immersive bridge', async () => {
    localStorage.setItem(LEFT_SWIPE_KEY, '0')
    localStorage.setItem(RIGHT_SWIPE_KEY, '1')
    await render()
    expect(checked(swipeSwitch('left'))).toBe(false)
    expect(checked(swipeSwitch('right'))).toBe(true)
  })
})

// ── 2026-10-23：设置页观感回归。用户反馈「设置页有些 UI 很突兀、和别的 UI 差别很大」：
// 本分区曾用 16px 原生勾选框（系统蓝）+ 绿色选中态描边按钮 + 13px 提示，与同页上游行并列。
// 结构断言锁死这三类外观：原生勾选框不得回归，行数/行骨架必须与上游行同规。
describe('GeneralSettings 行骨架与上游通用设置一致（2026-10-23）', () => {
  it('不再渲染浏览器原生勾选框（开关一律走上游 Switch 的 role=switch）', async () => {
    await render()
    expect(host!.querySelector('input[type=checkbox]')).toBeNull()
    expect(host!.querySelectorAll('[role="switch"]')).toHaveLength(3)
  })

  it('每个设置项是一行：标题 + 说明 + 右侧控件', async () => {
    await render()
    const rows = [...host!.querySelectorAll('[data-plugin="android-general"] > .dsh-gs-row')]
    // 三行开关（沉浸式、左侧栏滑动、右侧栏滑动）+ 一行动作（意见反馈，右侧是按钮不是开关）。
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.querySelector('.dsh-gs-title')?.textContent).toBeTruthy()
      const control = row.querySelector('[role="switch"], .dsh-gs-control button')
      expect(control, '每行都要有右侧控件（开关或按钮）').not.toBeNull()
    }
  })

  it('意见反馈行：说明与按钮都在，且点击走统一的打开函数', async () => {
    await render()
    const row = host!.querySelector('[data-dsh-feedback]')
    expect(row, '通用设置最下方应有意见反馈行').not.toBeNull()
    expect(row!.querySelector('.dsh-gs-title')?.textContent).toContain('意见反馈')
    expect(row!.querySelector('.dsh-gs-desc')?.textContent).toContain('系统浏览器')
    expect(row!.querySelector('.dsh-gs-control button'), '右侧应是可点的按钮').not.toBeNull()
  })

  it('不再渲染语言行（语言只保留上游 locale 行；壳侧启动时按系统语言写好具体值）', async () => {
    await render()
    expect(host!.querySelector('[data-dsh-ui-language]')).toBeNull()
    expect(host!.querySelector('[role="tablist"]')).toBeNull()
    // 旧实现的自绘按钮类名与 data 钩子必须彻底消失，防止样式表重新长出第二套按钮。
    expect(host!.querySelector('.dsh-dev-btn')).toBeNull()
    expect(host!.querySelector('[data-ui-language-mode]')).toBeNull()
  })
})
