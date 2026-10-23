// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrawerOverlayDismiss } from '../src/client/mobile/drawer-overlay-dismiss.ts'

function setMobile(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-dsh-mobile-form', '')
  else document.documentElement.removeAttribute('data-dsh-mobile-form')
}

/** 等一轮宏任务，让 MutationObserver 的微任务回调跑完。 */
async function flushMutations(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

interface Harness {
  frame: HTMLElement
  /** 假菜单是否仍开着（primitives Menu 同款「外部按下即收」判据的行为结果）。 */
  menuOpen: () => boolean
  /** document 上收到的 pointerdown 次数。 */
  dispatched: () => number
  dismiss: DrawerOverlayDismiss
  stop: () => void
}

function harness({ collapsed = false, mobile = true } = {}): Harness {
  document.body.innerHTML = ''
  setMobile(mobile)
  const frame = document.createElement('div')
  frame.setAttribute('data-dsh-frame', '')
  if (collapsed) frame.setAttribute('data-sidebar-collapsed', '')
  document.body.appendChild(frame)

  // 一个行为对齐 primitives Menu 的假菜单：portal 列表挂在 body 下，anchor 包在自己的
  // rootRef span 里；document 上收到目标在两者之外的 pointerdown 就关闭。
  const root = document.createElement('span')
  const anchor = document.createElement('button')
  root.appendChild(anchor)
  document.body.appendChild(root)
  const list = document.createElement('div')
  list.setAttribute('role', 'menu')
  document.body.appendChild(list)
  let open = true
  let dispatched = 0
  const onDocumentPointerDown = (event: Event): void => {
    if (event.type !== 'pointerdown' || !(event.target instanceof Node)) return
    dispatched++
    if (root.contains(event.target) || list.contains(event.target)) return
    open = false
  }
  document.addEventListener('pointerdown', onDocumentPointerDown)

  const dismiss = new DrawerOverlayDismiss({
    mobileForm: () => document.documentElement.hasAttribute('data-dsh-mobile-form'),
  })
  dismiss.attach()
  return {
    frame,
    menuOpen: () => open,
    dispatched: () => dispatched,
    dismiss,
    stop: () => {
      dismiss.detach()
      document.removeEventListener('pointerdown', onDocumentPointerDown)
      document.body.innerHTML = ''
      document.documentElement.removeAttribute('data-dsh-mobile-form')
    },
  }
}

beforeEach(() => { setMobile(true) })
afterEach(() => { document.body.innerHTML = '' })

describe('DrawerOverlayDismiss：抽屉收起时派发外部 pointerdown 关掉瞬态浮层', () => {
  it('手机形态下 data-sidebar-collapsed 开→合翻转，假菜单走自己的外部判据关闭', async () => {
    const h = harness()
    try {
      expect(h.menuOpen()).toBe(true)
      h.frame.setAttribute('data-sidebar-collapsed', '')
      await flushMutations()
      expect(h.menuOpen()).toBe(false)
      expect(h.dispatched()).toBe(1)
    } finally { h.stop() }
  })

  it('展开方向（合→开）不派发', async () => {
    const h = harness({ collapsed: true })
    try {
      h.frame.removeAttribute('data-sidebar-collapsed')
      await flushMutations()
      expect(h.dispatched()).toBe(0)
      expect(h.menuOpen()).toBe(true)
    } finally { h.stop() }
  })

  it('attach 时已是收起态不算翻转；展开后再收起才派发一次', async () => {
    const h = harness({ collapsed: true })
    try {
      await flushMutations()
      expect(h.dispatched()).toBe(0)
      h.frame.removeAttribute('data-sidebar-collapsed')
      await flushMutations()
      expect(h.dispatched()).toBe(0)
      h.frame.setAttribute('data-sidebar-collapsed', '')
      await flushMutations()
      expect(h.dispatched()).toBe(1)
      expect(h.menuOpen()).toBe(false)
    } finally { h.stop() }
  })

  it('非手机形态翻转不派发', async () => {
    const h = harness({ mobile: false })
    try {
      h.frame.setAttribute('data-sidebar-collapsed', '')
      await flushMutations()
      expect(h.dispatched()).toBe(0)
      expect(h.menuOpen()).toBe(true)
    } finally { h.stop() }
  })

  it('已收起后的重复属性写入不重复派发', async () => {
    const h = harness()
    try {
      h.frame.setAttribute('data-sidebar-collapsed', '')
      await flushMutations()
      h.frame.setAttribute('data-sidebar-collapsed', '')
      await flushMutations()
      expect(h.dispatched()).toBe(1)
    } finally { h.stop() }
  })

  it('detach 之后的翻转不再派发', async () => {
    const h = harness()
    h.dismiss.detach()
    h.frame.setAttribute('data-sidebar-collapsed', '')
    await flushMutations()
    expect(h.dispatched()).toBe(0)
    h.stop()
  })

  it('派发的 pointerdown 落在 body 上且冒泡到 document（jsdom 退化 MouseEvent 也可判）', async () => {
    const h = harness()
    try {
      const seen: Event[] = []
      const spy = (event: Event): void => { seen.push(event) }
      document.addEventListener('pointerdown', spy)
      h.frame.setAttribute('data-sidebar-collapsed', '')
      await flushMutations()
      document.removeEventListener('pointerdown', spy)
      expect(seen).toHaveLength(1)
      expect(seen[0]).toBeInstanceOf(MouseEvent)
      expect(seen[0].target).toBe(document.body)
      expect(seen[0].bubbles).toBe(true)
    } finally { h.stop() }
  })

  it('frame 尚未挂载时 attach 不报错；frame 出现后照常工作', async () => {
    document.body.innerHTML = ''
    setMobile(true)
    const dismiss = new DrawerOverlayDismiss({
      mobileForm: () => document.documentElement.hasAttribute('data-dsh-mobile-form'),
    })
    dismiss.attach()
    let dispatched = 0
    const spy = (): void => { dispatched++ }
    document.addEventListener('pointerdown', spy)
    try {
      const frame = document.createElement('div')
      frame.setAttribute('data-dsh-frame', '')
      document.body.appendChild(frame)
      await flushMutations()
      frame.setAttribute('data-sidebar-collapsed', '')
      await flushMutations()
      expect(dispatched).toBe(1)
    } finally {
      document.removeEventListener('pointerdown', spy)
      dismiss.detach()
      document.body.innerHTML = ''
      document.documentElement.removeAttribute('data-dsh-mobile-form')
    }
  })
})
