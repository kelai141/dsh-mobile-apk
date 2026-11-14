// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DevSection } from '../src/client/dev-section/DevSection.tsx'
import { toggleOf } from './toggle.ts'

// React 18 concurrent rendering: render and unmount must be wrapped in act (otherwise the DOM is not flushed).
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

type Bridge = {
  restartEngine?: () => boolean
  shutdownToGuide?: () => void
  reloadWebUI?: () => void
  openConsole?: () => void
  getDevLogEnabled?: () => boolean
  setDevLogEnabled?: (enabled: boolean) => void
  hasAllFilesAccess?: () => boolean
  getOverlayEnabled?: () => boolean
  setOverlayEnabled?: (enabled: boolean) => boolean
  getOverlayEntryStyle?: () => 'ball' | 'strip'
  setOverlayEntryStyle?: (style: 'ball' | 'strip') => 'ball' | 'strip'
}

/** 悬浮球开关（开发者选项里的第二个复选框；按标签文本定位，不依赖顺序）。 */
function overlayToggle(el: HTMLElement): HTMLInputElement {
  return toggleOf(el, '悬浮球（任务面板入口）')
}

let root: Root | undefined
let host: HTMLElement | undefined

async function render(bridge: Bridge, renderSlot?: () => React.ReactNode): Promise<HTMLElement> {
  window.androidBridge = bridge
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<DevSection close={() => {}} renderSlot={renderSlot as never} />)
  })
  return host
}

beforeEach(() => {
  delete window.androidBridge
  document.documentElement.lang = 'zh'
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

describe('DevSection（开发者选项设置页）', () => {
  it('渲染操作按钮（重启/关闭/刷新/控制台）与日志开关', async () => {
    const el = await render({})
    const texts = [...el.querySelectorAll('button')].map(b => b.textContent)
    expect(texts).toContain('重启')
    expect(texts).toContain('关闭')
    expect(texts).toContain('刷新界面')
    expect(texts).toContain('打开控制台')
    expect(el.querySelector('button[role="switch"]')).not.toBeNull()
  })

  it('重启：点击后先弹二次确认，确认后才调桥并短暂禁用按钮', async () => {
    vi.useFakeTimers()
    // S3-15：忙碌态只在**桥如实回报「已发起」**时进入，故这里的桩返回 true（旧签名 void 已改）。
    const restartEngine = vi.fn(() => true)
    const el = await render({ restartEngine })
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent === '重启')!
    await act(async () => { btn.click() })
    expect(restartEngine).not.toHaveBeenCalled()
    const confirmBtn = [...el.querySelectorAll('.dsh-dev-modal button')].find(b => b.textContent === '重启')!
    await act(async () => { confirmBtn.click() })
    expect(restartEngine).toHaveBeenCalledOnce()
    expect(btn.hasAttribute('disabled')).toBe(true)
    await act(async () => { vi.advanceTimersByTime(2100) })
    expect(btn.hasAttribute('disabled')).toBe(false)
    vi.useRealTimers()
  })

  it('关闭：点击后弹二次确认，取消不调桥，确认调 shutdownToGuide', async () => {
    const shutdownToGuide = vi.fn()
    const el = await render({ shutdownToGuide })
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent === '关闭')!
    await act(async () => { btn.click() })
    const cancel = [...el.querySelectorAll('.dsh-dev-modal button')].find(b => b.textContent === '取消')!
    await act(async () => { cancel.click() })
    expect(shutdownToGuide).not.toHaveBeenCalled()
    await act(async () => { btn.click() })
    const confirmBtn = [...el.querySelectorAll('.dsh-dev-modal button')].find(b => b.textContent === '关闭')!
    await act(async () => { confirmBtn.click() })
    expect(shutdownToGuide).toHaveBeenCalledOnce()
  })

  it('点击刷新界面 / 打开控制台调用对应桥方法', async () => {
    const reloadWebUI = vi.fn()
    const openConsole = vi.fn()
    const el = await render({ reloadWebUI, openConsole })
    const texts = [...el.querySelectorAll('button')]
    texts.find(b => b.textContent === '刷新界面')!.click()
    texts.find(b => b.textContent === '打开控制台')!.click()
    expect(reloadWebUI).toHaveBeenCalledOnce()
    expect(openConsole).toHaveBeenCalledOnce()
  })

  it('日志开关初始值来自桥（默认关）', async () => {
    const el = await render({ getDevLogEnabled: () => false })
    expect(el.querySelector('button[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
  })

  it('切换日志开关写桥并以壳侧真值回显（写后回读，非乐观置位）', async () => {
    const state = { log: false }
    const setDevLogEnabled = vi.fn((v: boolean) => { state.log = v })
    const el = await render({ getDevLogEnabled: () => state.log, setDevLogEnabled })
    const toggle = el.querySelector('button[role="switch"]')!
    await act(async () => { toggle.click() })
    expect(setDevLogEnabled).toHaveBeenCalledWith(true)
    expect(el.querySelector('button[role="switch"]')!.getAttribute('aria-checked')).toBe('true')
  })

  it('未授予所有文件访问时提示私有目录', async () => {
    const el = await render({ hasAllFilesAccess: () => false })
    // 说明现在挂在「调试日志」行的 desc（div）里，不再是一条独立段落——断言整块文本。
    expect(el.textContent).toContain('应用私有目录')
  })

  it('已授权时提示公共目录路径', async () => {
    const el = await render({ hasAllFilesAccess: () => true })
    expect(el.textContent).toContain('Documents/dshdata/log')
  })

  it('桥缺失时安全降级（不抛异常，默认关）', async () => {
    const el = await render({})
    expect(el.querySelector('button[role="switch"]')!.getAttribute('aria-checked')).toBe('false')
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent === '重启')!
    await act(async () => { btn.click() })
    const confirmBtn = [...el.querySelectorAll('.dsh-dev-modal button')].find(b => b.textContent === '重启')!
    await act(async () => { confirmBtn.click() })
    expect(() => { confirmBtn.click() }).not.toThrow()
  })

  it('渲染 settings.dev.item 子槽（ADB 授权块等设施挂载点）', async () => {
    const el = await render({}, () => <div data-testid="dev-item">ADB 授权块</div>)
    expect(el.querySelector('[data-testid="dev-item"]')).not.toBeNull()
    expect(el.querySelector('[data-testid="dev-item"]')!.textContent).toBe('ADB 授权块')
  })

  it('未提供 renderSlot 时安全降级（不渲染子区、不抛异常）', async () => {
    const el = await render({})
    expect(el.querySelector('[data-testid="dev-item"]')).toBeNull()
  })

  // ── ST-02 页侧半边（F-APK-02 / F-UI-03 的页侧一半）────────────────────────
  // 壳侧真值 = 偏好 && 悬浮窗权限 && 服务实例在场；权限缺失时壳侧已回落偏好 false。
  // 因此页侧必须回读桥真值，并在可见/回前台时收敛（页面不随系统设置返回而重挂载）。

  it('ST-02：悬浮球开关挂载时以桥回值为准（壳侧已回落 false 就不显示「开」）', async () => {
    const el = await render({ getOverlayEnabled: () => false })
    expect(overlayToggle(el).checked).toBe(false)
  })

  // P5-6：与「手机控制」页的虚拟屏浮窗去混淆。两处都叫「浮」，必须各说各是什么，
  // 且其中一处点名另一处（本页点名「虚拟屏浮窗」）。
  it('P5-6：悬浮球文案必须点名「虚拟屏浮窗」以示区分', async () => {
    const el = await render({})
    const text = el.textContent ?? ''
    expect(text).toContain('悬浮球')
    expect(text, '必须点名「手机控制」页的虚拟屏浮窗是另一个东西').toContain('虚拟屏浮窗')
    expect(text, '必须说清悬浮球是什么').toContain('任务面板')
  })

  it('ST-02：系统侧撤销权限后回前台不重挂载也收敛（展示值与桥回值同时收敛）', async () => {
    const state = { overlay: true }
    const el = await render({ getOverlayEnabled: () => state.overlay, setOverlayEnabled: () => state.overlay })
    expect(overlayToggle(el).checked).toBe(true)

    // 只改真源：系统里撤销悬浮窗权限 → 壳侧 isEnabled 回落 false
    state.overlay = false
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(overlayToggle(el).checked, '回前台后展示值必须收敛为桥回值').toBe(false)

    // 反向：重新授予（桥回值 true）→ 同样收敛，无需重挂载
    state.overlay = true
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(overlayToggle(el).checked).toBe(true)
  })

  it('ST-09：只动壳侧真源 + 回前台 → 三处状态展示跟随（无重挂载）', async () => {
    const state = { log: false, overlay: false, allFiles: false }
    const el = await render({
      getDevLogEnabled: () => state.log,
      getOverlayEnabled: () => state.overlay,
      hasAllFilesAccess: () => state.allFiles,
    })
    const logInput = toggleOf(el, '调试日志')
    expect(logInput.checked).toBe(false)
    expect(overlayToggle(el).checked).toBe(false)
    expect(el.textContent).toContain('应用私有目录')

    // 只动系统侧（壳侧真源），不碰我方 UI
    state.log = true
    state.overlay = true
    state.allFiles = true
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })

    expect(logInput.checked).toBe(true)
    expect(overlayToggle(el).checked).toBe(true)
    expect(el.textContent).toContain('Documents/dshdata/log')
  })

  it('ST-02：权限缺失时开关回落且文案要求重新打开（不再宣称「返回后自动生效」）', async () => {
    const el = await render({ getOverlayEnabled: () => false, setOverlayEnabled: () => false })
    const toggle = overlayToggle(el)
    expect(toggle.checked).toBe(false)
    await act(async () => { toggle.click() })
    expect(el.textContent).toContain('已打开系统授权页；授予后请重新打开本开关')
    expect(el.textContent).not.toContain('返回后自动生效')
    expect(toggle.checked, '桥回读为 false → 开关不得乐观置位').toBe(false)
  })
})

describe('新悬浮入口设置 / New floating entry shape', () => {
  const selector = (el: HTMLElement) => el.querySelector('[data-overlay-entry-setting] select') as HTMLSelectElement
  const choose = async (el: HTMLElement, value: string) => {
    await act(async () => {
      selector(el).value = value
      selector(el).dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  it('读取已存球/条偏好，关闭悬浮窗时也可预先选择，不改开关', async () => {
    let stored: 'ball' | 'strip' = 'ball'
    const setOverlayEnabled = vi.fn(() => false)
    const write = vi.fn((style: 'ball' | 'strip') => { stored = style; return stored })
    const el = await render({
      getOverlayEnabled: () => false,
      setOverlayEnabled,
      getOverlayEntryStyle: () => stored,
      setOverlayEntryStyle: write,
    })
    expect(selector(el).disabled).toBe(false)
    expect(selector(el).value).toBe('ball')
    await choose(el, 'strip')
    expect(write).toHaveBeenLastCalledWith('strip')
    expect(selector(el).value).toBe('strip')
    await choose(el, 'ball')
    expect(write).toHaveBeenLastCalledWith('ball')
    expect(selector(el).value).toBe('ball')
    expect(setOverlayEnabled).not.toHaveBeenCalled()
    expect(overlayToggle(el).checked).toBe(false)
    expect(el.textContent).toContain('此设置不会启用新界面或开启悬浮窗，旧版入口保持不变')
  })

  it('首次挂载读取 strip 而不是覆盖成默认 ball', async () => {
    const write = vi.fn(() => 'strip' as const)
    const el = await render({ getOverlayEntryStyle: () => 'strip', setOverlayEntryStyle: write })
    expect(selector(el).value).toBe('strip')
    expect(write).not.toHaveBeenCalled()
    expect(el.querySelectorAll('[data-overlay-entry-setting]')).toHaveLength(1)
  })

  it('写入未生效时保留真源，不能仅相信 setter 回值或乐观置位', async () => {
    const el = await render({ getOverlayEntryStyle: () => 'ball', setOverlayEntryStyle: () => 'strip' })
    await choose(el, 'strip')
    expect(selector(el).value).toBe('ball')
    expect(el.querySelector('[role="status"]')?.textContent).toContain('入口形态未保存')
  })

  it('setter 抛错时可见失败，保留原形态且不变更悬浮开关', async () => {
    const el = await render({
      getOverlayEntryStyle: () => 'strip',
      setOverlayEntryStyle: () => { throw new Error('bridge gone') },
    })
    await choose(el, 'ball')
    expect(selector(el).value).toBe('strip')
    expect(el.textContent).toContain('入口形态未保存')
  })

  it.each([
    ['旧壳没有形态方法', {}],
    ['getter 缺席', { setOverlayEntryStyle: () => 'ball' as const }],
    ['setter 缺席', { getOverlayEntryStyle: () => 'ball' as const }],
    ['getter 抛错', { getOverlayEntryStyle: () => { throw new Error('denied') }, setOverlayEntryStyle: () => 'ball' as const }],
    ['getter 非法值', { getOverlayEntryStyle: () => 'other' as 'ball', setOverlayEntryStyle: () => 'ball' as const }],
  ] as const)('%s 时禁用，不把不可读状态当默认球', async (_label, bridge) => {
    const el = await render(bridge)
    expect(selector(el).disabled).toBe(true)
    expect(selector(el).value).toBe('')
    expect(el.textContent).toContain('当前应用无法读写入口形态')
  })

  it('形态经手势/壳侧改变后回前台重读，无需重挂载或页侧偏好副本', async () => {
    let stored: 'ball' | 'strip' = 'ball'
    const el = await render({ getOverlayEntryStyle: () => stored, setOverlayEntryStyle: (style) => style })
    stored = 'strip'
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(selector(el).value).toBe('strip')
    stored = 'ball'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(selector(el).value).toBe('ball')
  })

  it('已挂载设置随语言即时更新，英文标签/选项/限制均可见', async () => {
    const el = await render({ getOverlayEntryStyle: () => 'ball', setOverlayEntryStyle: (style) => style })
    await act(async () => { document.documentElement.lang = 'en' })
    expect(selector(el).getAttribute('aria-label')).toBe('New floating entry shape')
    expect(selector(el).options[1].text).toBe('Free ball')
    expect(selector(el).options[2].text).toBe('Edge strip')
    expect(el.textContent).toContain('Requires the new overlay UI')
    expect(el.textContent).toContain('the legacy entry is unchanged')
    expect(el.textContent).toContain('either edge')
    await act(async () => { document.documentElement.lang = 'zh' })
    expect(selector(el).getAttribute('aria-label')).toBe('新悬浮入口形态')
  })
})

// 0.14.0：开放屏幕范围选择器随「手机控制」设置分区迁出——用例见 phone-control.spec.tsx。


// ── 0.14.1 批 9（§3.3 S3-14 / S3-15）───────────────────────────────────────
describe('DevSection 破坏性操作与假忙碌（S3-14 / S3-15）', () => {
  /** 临时工作区清理按钮（按文本定位；文案为「一键清理」）。 */
  function cleanButton(el: HTMLElement): HTMLButtonElement {
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent === '一键清理')
    expect(btn, '一键清理按钮必须在场').toBeTruthy()
    return btn as HTMLButtonElement
  }

  it('S3-14：「一键清理」必须二次确认，确认前不得发起清理请求', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url))
      if (String(url).includes('file-incoming') && !String(url).includes('clean')) {
        return { ok: true, status: 200, json: async () => ({ bytes: 4096 }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, removed: 2 }) }
    }))
    const el = await render({})
    await act(async () => { await Promise.resolve() })

    await act(async () => { cleanButton(el).click() })
    // 旧实现：单击即删。现在必须只弹确认。
    expect(el.textContent).toContain('清理临时工作区？')
    expect(el.textContent).toContain('无法恢复')
    expect(calls.some(u => u.includes('/clean')), '确认之前不得发起清理').toBe(false)

    // 确认后才真的删。注意：同页还有「运行时缓存清理」的按钮，文本同为「清理」——
    // 必须**限定在确认弹窗内**取（首版取到的是缓存那枚，测试自身踩了选择器歧义）。
    const dialog = el.querySelector('[role="dialog"]')
    expect(dialog, '必须弹出确认对话框').toBeTruthy()
    const ok = [...dialog!.querySelectorAll('button')].find(b => b.textContent === '清理') as HTMLButtonElement
    expect(ok, '确认弹窗必须有执行按钮').toBeTruthy()
    await act(async () => { ok.click() })
    await act(async () => { await Promise.resolve() })
    expect(calls.some(u => u.includes('/clean'))).toBe(true)
  })

  it('S3-15：重启没发起时如实说明，不得进入假忙碌态', async () => {
    // 桥存在但返回 false（已在重启中/未发起）——旧实现无论成败都显示「重启中…」两秒后自己变回。
    const el = await render({ restartEngine: () => false })
    const restart = [...el.querySelectorAll('button')].find(b => b.textContent === '重启') as HTMLButtonElement
    await act(async () => { restart.click() })
    const confirmBtn = [...el.querySelectorAll('button')].find(b => b.textContent === '重启' && b !== restart) as HTMLButtonElement
    await act(async () => { confirmBtn.click() })
    expect(el.textContent).toContain('重启没有发起')
    expect(el.textContent, '不得显示假忙碌').not.toContain('重启中…')
  })

  it('S3-15：桥缺席时重启也要如实说没发起（不是假装在重启）', async () => {
    const el = await render({})
    const restart = [...el.querySelectorAll('button')].find(b => b.textContent === '重启') as HTMLButtonElement
    await act(async () => { restart.click() })
    const confirmBtn = [...el.querySelectorAll('button')].find(b => b.textContent === '重启' && b !== restart) as HTMLButtonElement
    await act(async () => { confirmBtn.click() })
    expect(el.textContent).toContain('重启没有发起')
  })

  it('S3-15：控制台桥缺席时给回执（不再静默）', async () => {
    const el = await render({})
    const btn = [...el.querySelectorAll('button')].find(b => b.textContent === '打开控制台') as HTMLButtonElement
    await act(async () => { btn.click() })
    expect(el.textContent).toContain('控制台不可用')
  })
})

describe('开发者选项文案在手机宽度下不横向溢出', () => {
  it('说明/提示/警告三类文本都能对不可断的长串（设备绝对路径）断行', async () => {
    // 真机实测：412px 下未加断行规则时，内容列被导出路径撑到 scrollWidth 681 > clientWidth 364，
    // 用户要横向拖动才能读完（0.14.7 Spec §5「不得出现横向溢出 / 长路径撑宽」）。
    // 这里钉住三类共用文本类的规则存在——单测没有布局引擎，故断言规则本身而不是像素。
    const { DEV_SECTION_CSS } = await import('../src/client/dev-section/dev-section.css.ts')
    for (const cls of ['.dsh-dev-note', '.dsh-dev-hint', '.dsh-dev-warn']) {
      const rule = DEV_SECTION_CSS.split(cls + ' {')[1]?.split('}')[0] ?? ''
      expect(rule, cls + ' 的规则必须在场').not.toBe('')
      expect(rule, cls + ' 必须允许长串断行，否则设备路径会撑出横向溢出').toContain('overflow-wrap: anywhere')
    }
  })
})
