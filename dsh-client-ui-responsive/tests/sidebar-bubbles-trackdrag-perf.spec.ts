// @vitest-environment jsdom
// 性能回归（perf-smooth P2-Top2）：气泡拖拽 autoScroll 每帧重复 trackDrag。
//
// 判据落在【可数调用次数】上，不测机器速度：
//  ① 一次 rAF tick（autoScroll 跑一遍）内 trackDrag 只跑 1 遍（改动前 2 遍）；
//  ② 一次 rAF tick 内 getBoundingClientRect 只读 6 次（改动前 11 次）：
//       1 = autoScroll 自己读的 popover 矩形
//       5 = trackDrag 内部：popover 矩形 1 次 + group.find() 逐行 4 次（本夹具 4 个同窗格候选行）
//     改动前是 1 + 5 + 5 = 11（trackDrag 跑了两遍，逐行测量跟着翻倍）。
//  ③ 滚动分支不成立时仍然每帧跑 1 遍 trackDrag —— 证明去重不是「删掉重算」。
//  ④ 负控：把改动前的等价实现装回实例，同一套断言必须不成立（2 遍 / 11 次）。
//
// 为什么不能删掉第二次调用：:649 的 popover.scrollTop += delta 改变了滚动位置，几何必须重算。
// 所以改法是「调用后打标记，第二次判断标记跳过」，不是删除。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { SidebarBubbles } from '../src/client/mobile/sidebar-bubbles.ts'
import { zh } from '../src/client/mobile/sidebar-bubbles.locales.ts'

/** 与 sidebar-bubbles.ts 的 PRESS_MS 对齐：长按多久算拖拽。 */
const PRESS_MS = 400
/** 夹具里同窗格的候选行数（5 个标签去掉被拖的那个）。 */
const CANDIDATE_ROWS = 4
/** 一次 trackDrag 的矩形读取数：popover 1 + 逐行 CANDIDATE_ROWS。 */
const RECTS_PER_TRACK = 1 + CANDIDATE_ROWS
/** 一次 autoScroll tick 的矩形读取数：autoScroll 自己的 popover 1 + 一次 trackDrag。 */
const RECTS_PER_TICK = 1 + RECTS_PER_TRACK
/** 改动前的一次 tick：autoScroll 的 1 + 两遍 trackDrag。 */
const RECTS_PER_TICK_BEFORE = 1 + 2 * RECTS_PER_TRACK

const owner = 'owner' as SessionId
let current: SessionId | undefined
let panel: HTMLElement
let bubbles: SidebarBubbles
let records: TabRecord[]
let selected: string
let frames: FrameRequestCallback[]
let rectReads: Element[]
const t: TranslateNS<'androidSidebarBubbles'> = (key, params) => zh[key].replace('{title}', String(params?.title ?? ''))
const id = (value: string) => value as TabId
const rect = (x: number, y: number, width: number, height: number): DOMRect => ({ x, y, width, height, top: y, bottom: y + height, left: x, right: x + width, toJSON: () => ({}) })
const popover = () => panel.querySelector<HTMLElement>('.dsh-bubble-popover')!
const row = (value: string) => panel.querySelector<HTMLElement>('[data-dsh-bubble-tab="' + value + '"]')!
const select = (value: string) => row(value).querySelector<HTMLButtonElement>('.dsh-bubble-select')!
const toggle = () => panel.querySelector<HTMLButtonElement>('[data-dsh-sidebar-bubbles-toggle]')!

/** 拖拽实例面：测试要数私有成员的调用次数，并（仅负控用例）装回旧实现。 */
interface DragFace {
  trackDrag: () => void
  autoScroll: () => void
  scrollFrame: number | null
  press: { active: boolean; latestX: number; latestY: number } | null
  popover: HTMLElement | null
}
const face = (): DragFace => bubbles as unknown as DragFace

function pointer(type: string, target: EventTarget, x: number, y: number): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 })
  Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } })
  target.dispatchEvent(event)
  return event
}
function addTab(value: string): void {
  records.push({ id: id(value), kind: 'conversation', contentId: 'dsh-resource://test/' + value, title: value })
  const source = document.createElement('div')
  source.setAttribute('role', 'tab')
  source.setAttribute('data-dockkit-tab', value)
  source.setAttribute('aria-selected', String(value === selected))
  source.innerHTML = '<span data-dockkit-tab-title><span data-sidebar-right-tab="' + value + '"><span>' + value + '</span></span></span><button data-dockkit-tab-close="' + value + '" aria-label="关闭"></button>'
  panel.querySelector('[data-dockkit-strip="p"] [data-dockkit-strip-tabs]')!.append(source)
}

/**
 * 全局几何：包 Element.prototype.getBoundingClientRect，既能数调用次数，又能给每个元素稳定的矩形。
 * 必须包原型而不是逐个元素 spy —— 逐元素 spy 会遮蔽原型，数出来的只是「被 spy 过的那几个」。
 * 行矩形固定为 (45, 70 + 55i, 294, 48)，所以指针 y 落在 314 以下时 group.find() 必然扫满全部候选行。
 */
function installGeometry(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
    rectReads.push(this)
    if (this.classList.contains('dsh-bubble-popover')) return rect(40, 60, 304, 360)
    if (this.hasAttribute('data-dsh-bubble-tab')) {
      const index = [...(this.parentElement?.children ?? [])].indexOf(this)
      return rect(45, 70 + Math.max(0, index) * 55, 294, 48)
    }
    if (this.hasAttribute('data-sidebar-right-panel')) return rect(0, 0, 360, 720)
    if (this.matches('[data-dockkit-strip]')) return rect(0, 0, 360, 48)
    return rect(0, 0, 0, 0)
  })
}

/** 长按到拖拽激活（激活本身会跑一次 trackDrag 并排下第一帧）。 */
function activateDrag(y: number): void {
  pointer('pointerdown', select('chat'), 150, y)
  vi.advanceTimersByTime(PRESS_MS)
  expect(row('chat').hasAttribute('data-dragging')).toBe(true)
}
/** 跑一帧 autoScroll（只跑自动滚动那一帧，不碰 refresh 帧）。 */
function tick(): void {
  const target = face().autoScroll
  const index = frames.findIndex(callback => callback === target)
  expect(index).toBeGreaterThanOrEqual(0)
  const [callback] = frames.splice(index, 1)
  callback(performance.now())
}
/** 只数一次 tick：清空计数，跑一帧，返回 {trackDrag, rects}。 */
function measureTick(trackDrag: { mock: { calls: unknown[] } }): { track: number; rects: number } {
  trackDrag.mock.calls.length = 0
  rectReads = []
  tick()
  return { track: trackDrag.mock.calls.length, rects: rectReads.length }
}

beforeEach(() => {
  vi.useFakeTimers()
  current = owner; selected = 'chat'; records = []
  frames = []; rectReads = []
  // rAF 手工驱动：一个 tick = 手动调用一次排进来的回调。用 setTimeout 模拟会让一次
  // advanceTimersByTime 连带跑掉好几帧，数出来的就不是「一帧」了。
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { width: 360, height: 720, offsetLeft: 0, offsetTop: 0 }))
  document.body.innerHTML = '<div data-dsh-frame data-sidebar-collapsed><div data-rightbar-col><div data-sidebar-right-panel="fullscreen" data-sidebar-right-open data-sidebar-right-session="owner"><div data-dockkit-host="dock"><section data-dockkit-pane="p" data-dockkit-pane-active><header><div data-dockkit-strip="p"><div data-dockkit-strip-tabs="p"></div><button data-sidebar-right-mode="push" aria-label="退出全屏"><svg /></button><button data-sidebar-right-toggle aria-label="收起工作面板"><svg /></button><button data-dockkit-add-tab aria-label="新建标签"><svg /></button></div></header><div data-tab-body><input value="draft" /><div data-terminal>running</div></div></section></div></div></div></div>'
  panel = document.querySelector('[data-sidebar-right-panel]')!
  installGeometry()
  for (const value of ['chat', 'child', 'browser', 'terminal', 'screen']) addTab(value)
  bubbles = new SidebarBubbles({ session: () => current, tabs: () => records, reorder: () => true, t })
  bubbles.attach()
  toggle().click()
})
afterEach(() => {
  bubbles.detach()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('perf-smooth P2-Top2：autoScroll 每帧只重算一遍几何', () => {
  it('滚动分支成立时：一帧内 trackDrag 1 次、getBoundingClientRect 6 次', () => {
    activateDrag(410)
    // 指针压在底边触发滚动：410 > rect.bottom(420) - 44。
    pointer('pointermove', document, 150, 410)
    const trackDrag = vi.spyOn(face(), 'trackDrag')
    const before = popover().scrollTop
    const measured = measureTick(trackDrag)
    expect(popover().scrollTop).toBeGreaterThan(before)
    expect(measured.track).toBe(1)
    expect(measured.rects).toBe(RECTS_PER_TICK)
    expect(RECTS_PER_TICK).toBe(6)
  })

  it('滚动分支不成立时：仍然每帧 1 次 trackDrag、6 次 getBoundingClientRect', () => {
    activateDrag(340)
    // 340 在 [top + 44, bottom - 44] 内 ⇒ delta = 0，走不到 scrollTop 分支。
    pointer('pointermove', document, 150, 340)
    const trackDrag = vi.spyOn(face(), 'trackDrag')
    const before = popover().scrollTop
    const measured = measureTick(trackDrag)
    expect(popover().scrollTop).toBe(before)
    expect(measured.track).toBe(1)
    expect(measured.rects).toBe(RECTS_PER_TICK)
  })

  it('连续 3 帧线性叠加：3 次 trackDrag、18 次 getBoundingClientRect', () => {
    activateDrag(410)
    pointer('pointermove', document, 150, 410)
    const trackDrag = vi.spyOn(face(), 'trackDrag')
    trackDrag.mock.calls.length = 0
    rectReads = []
    tick(); tick(); tick()
    expect(trackDrag.mock.calls.length).toBe(3)
    expect(rectReads.length).toBe(3 * RECTS_PER_TICK)
    expect(rectReads.length).toBe(18)
  })

  it('负控：把改动前的等价实现装回实例，同一套断言必须不成立（2 次 / 11 次）', () => {
    // 改动前 autoScroll 的等价实现：:649 分支里调过 trackDrag 之后，紧接着又无条件调一次。
    const self = face()
    self.autoScroll = function legacyAutoScroll(this: void): void {
      self.scrollFrame = null
      const press = self.press
      if (!press?.active || !self.popover) return
      const bounds = self.popover.getBoundingClientRect()
      const y = press.latestY
      const delta = y < bounds.top + 44 ? -Math.min(10, Math.max(0, (bounds.top + 44 - y) / 4))
        : y > bounds.bottom - 44 ? Math.min(10, Math.max(0, (y - bounds.bottom + 44) / 4)) : 0
      if (delta && press.latestX >= bounds.left && press.latestX <= bounds.right) { self.popover.scrollTop += delta; self.trackDrag() }
      self.trackDrag()
      self.scrollFrame = requestAnimationFrame(self.autoScroll)
    }
    activateDrag(410)
    pointer('pointermove', document, 150, 410)
    const trackDrag = vi.spyOn(face(), 'trackDrag')
    const legacy = measureTick(trackDrag)
    // 旧逻辑下真实测到的数字：trackDrag 2 次、getBoundingClientRect 11 次。
    expect(legacy.track).toBe(2)
    expect(legacy.rects).toBe(RECTS_PER_TICK_BEFORE)
    expect(RECTS_PER_TICK_BEFORE).toBe(11)
    // 也就是说，正式用例里的 toBe(1) / toBe(6) 在旧逻辑下必然失败 —— 断言不是空转。
    expect(legacy.track).not.toBe(1)
    expect(legacy.rects).not.toBe(RECTS_PER_TICK)
  })
})
