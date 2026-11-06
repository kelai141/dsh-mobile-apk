// @vitest-environment jsdom
// 滚动帧扫描预算（缺陷 3「整体卡顿」的判据之一）。
//
// 真因形状：composer-popup-guard 与 top-bar-fold 都在 window 上挂了**捕获阶段**的 scroll
// 监听（`addEventListener('scroll', …, true)`），滚动时每个 scroll 事件都会排队一帧，
// 帧里跑 `document.querySelector` 整文档扫描 —— 即使**没有任何弹层打开**。
// 用户体感：滚动时掉帧，且会话越长越明显。
//
// 判据（可测量，不读源码字符串）：
//  ① 没有弹层打开时，滚动 30 帧的全文档查询次数必须为 0；
//  ② 反证（防假绿）：**真的打开一个会被几何修正的弹层**（带 aria-controls 的
//     role=menu 的 ModelSelect 形态门户）后滚动，查询次数必须 > 0，且弹层的
//     --dsh-mobile-popup-shift 真的被写过 —— 只把 scroll 监听删掉的改法在这里红。
import { describe, expect, it } from 'vitest'
import { countDomScans } from './dom-scan-counter.ts'

/** 等两帧 rAF：滚动监听排队的那一帧 + 观察者微任务。 */
function frame(): Promise<void> {
  return new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
}

/**
 * 造一个手机竖屏会话页：顶栏（含 leading 座位）+ frame + 正文 + 输入卡。
 * @param paragraphs - 正文段数。
 * @returns 输入卡元素（弹层挂载点）。
 */
function buildPage(paragraphs: number): HTMLElement {
  document.body.innerHTML = ''
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  const header = document.createElement('header')
  const leading = document.createElement('div')
  leading.setAttribute('data-conversation-header-leading', '')
  header.appendChild(leading)
  document.body.appendChild(header)
  const frameRoot = document.createElement('div')
  frameRoot.setAttribute('data-dsh-frame', '')
  frameRoot.setAttribute('data-sidebar-collapsed', '')
  document.body.appendChild(frameRoot)
  const conversation = document.createElement('div')
  conversation.setAttribute('data-conversation', '')
  frameRoot.appendChild(conversation)
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  conversation.appendChild(card)
  for (let index = 0; index < paragraphs; index++) {
    const line = document.createElement('p')
    line.textContent = 'line ' + String(index)
    conversation.appendChild(line)
  }
  return card
}

/** 挂上两个滚动监听方。 */
async function attachScrollObservers(): Promise<() => void> {
  const { ComposerPopupGuard } = await import('../src/client/composer-popup-guard.ts')
  const { TopBarFold } = await import('../src/client/mobile/top-bar-fold.ts')
  const guard = new ComposerPopupGuard()
  guard.attach()
  const fold = new TopBarFold()
  fold.attach()
  return () => { guard.detach(); fold.detach() }
}

/**
 * 滚 N 帧并数查询。
 * @param frames - 帧数。
 * @returns 每帧全文档查询次数。
 */
async function scrollFrames(frames: number): Promise<number> {
  const counter = countDomScans()
  try {
    for (let index = 0; index < frames; index++) {
      window.dispatchEvent(new Event('scroll'))
      await frame()
    }
    return counter.stats.documentCalls / frames
  } finally {
    counter.restore()
  }
}

const FRAMES = 30

describe('滚动帧扫描预算', () => {
  it('① 没有弹层打开时，滚动一帧的全文档查询 = 0', async () => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    buildPage(1_200)
    const dispose = await attachScrollObservers()
    await frame()
    await frame()
    try {
      const perFrame = await scrollFrames(FRAMES)
      console.log('① per_frame_queries=' + perFrame.toFixed(2))
      expect(perFrame, '无弹层时的每帧全文档查询次数（修复前 6.00）').toBe(0)
    } finally {
      dispose()
    }
  }, 120_000)

  it('② 反证：真的打开一个被几何修正的弹层后，滚动必须仍然测量它', async () => {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const card = buildPage(1_200)
    // ModelSelect 的真实形态：触发器在输入卡里（aria-haspopup/aria-expanded/aria-controls），
    // 弹层是 body 门户、role=menu、data-menu-material=translucent。
    const trigger = document.createElement('button')
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'true')
    trigger.setAttribute('aria-controls', 'dsh-model-menu-portal')
    card.appendChild(trigger)
    const portal = document.createElement('div')
    portal.id = 'dsh-model-menu-portal'
    portal.setAttribute('role', 'menu')
    portal.setAttribute('data-menu-material', 'translucent')
    portal.style.top = '400px'
    portal.style.left = '8px'
    document.body.appendChild(portal)

    const dispose = await attachScrollObservers()
    await frame()
    await frame()
    try {
      const perFrame = await scrollFrames(FRAMES)
      console.log('② per_frame_queries=' + perFrame.toFixed(2)
        + ' shift=' + JSON.stringify(portal.style.getPropertyValue('--dsh-mobile-popup-shift')))
      expect(perFrame, '有弹层时滚动仍须测量（0 = 把 scroll 监听删掉了）').toBeGreaterThan(0)
      expect(portal.style.getPropertyValue('--dsh-mobile-popup-shift'), '弹层的横向修正必须真的被写过').not.toBe('')
    } finally {
      dispose()
    }
  }, 120_000)
})
