// @vitest-environment jsdom
// issue #783 缺陷 B：「回到底部」悬浮按钮压住最后一行正文、垂直位置偏下。
//
// 真因（设备实测，Android WebView 114）：上游把 `--dsh-composer-height` 写成
// seat.offsetHeight，并在 seat 上挂了 ResizeObserver（默认 content-box）。当**只**改被观察
// 元素自身的 padding-bottom 时，该 RO 不投递通知（隔离实验：seat 128px→174px，回调 0 次；
// 改 height 或改子元素高度则正常投递）。于是变量停在旧值，而 seat 已经变高；依赖它的浮层
// `bottom: calc(var(--dsh-composer-height) + 16px)` 比真实 seat 顶低一个 inset 的高度，
// 按钮压住最后一行正文。
//
// 判据打在浏览器解析出的 **CSSOM 与计算值**上（不是源码切片）：
//   ① 携带底部预留的规则必须命中 seat 的**后代**盒子，且不得命中 seat 自身；
//   ② seat 自身的计算 padding-bottom 必须是 0px。
// ② 是这条缺陷的判别位：只要预留回到 seat 自己身上，RO 就会重新失聪。
import { describe, expect, it } from 'vitest'
import { COMPOSER_INSETS_CSS } from '../src/client/composer-insets.css.ts'

const INSET_PX = 46

/** 按真实结构建座位：seat 里套一层 composerStack（上游的 composer fallback 根）。 */
function mount(css: string): { seat: HTMLElement; stack: HTMLElement } {
  document.head.innerHTML = ''
  document.body.innerHTML = '<div data-composer-seat><div class="wSkVaW_composerStack"></div></div>'
  document.documentElement.style.setProperty('--dsh-android-system-bottom', INSET_PX + 'px')
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  return {
    seat: document.querySelector<HTMLElement>('[data-composer-seat]')!,
    stack: document.querySelector<HTMLElement>('.wSkVaW_composerStack')!,
  }
}

/**
 * seat 自身实际吃到的 padding-bottom（jsdom 对「没有声明」返回空串，与 '0px' 等价）。
 * 这里不写死字符串形态：判的是「有没有吃到底部预留」，不是某个内核的返回值格式。
 */
function seatPaddingBottom(seat: HTMLElement): string {
  const value = getComputedStyle(seat).paddingBottom
  return value === '' ? '0px' : value
}

/** 从 CSSOM 里取出「携带底部预留」的那些规则的命中情况（浏览器解析，不读源码文本）。 */
function insetCarriers(): { selector: string; hitsStack: boolean; hitsSeat: boolean }[] {
  const sheet = document.querySelector('style')!.sheet!
  const result: { selector: string; hitsStack: boolean; hitsSeat: boolean }[] = []
  const seat = document.querySelector<HTMLElement>('[data-composer-seat]')!
  const stack = document.querySelector<HTMLElement>('.wSkVaW_composerStack')!
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule)) continue
    const declared = rule.style.getPropertyValue('padding-bottom')
    if (!declared.includes('--dsh-android-system-bottom')) continue
    result.push({
      selector: rule.selectorText,
      hitsStack: stack.matches(rule.selectorText),
      hitsSeat: seat.matches(rule.selectorText),
    })
  }
  return result
}

describe('issue #783 缺陷 B：底部预留不得落在 ResizeObserver 观察的 seat 自身上', () => {
  it('① 预留规则命中 seat 的后代（composerStack），不命中 seat 自身', () => {
    mount(COMPOSER_INSETS_CSS)
    const carriers = insetCarriers()
    expect(carriers.length, '必须恰好有一条规则携带底部预留').toBe(1)
    expect(carriers[0].hitsStack, '预留必须落在 seat 内部的真实盒子上').toBe(true)
    expect(carriers[0].hitsSeat, '预留不得落在 seat 自身（RO 会失聪，变量停在旧值）').toBe(false)
  })

  it('② seat 自身的计算 padding-bottom 为 0px（缺陷形态的判别位）', () => {
    const { seat } = mount(COMPOSER_INSETS_CSS)
    expect(seatPaddingBottom(seat)).toBe('0px')
  })

  it('③ 预留只认 navbar 通道（不跟手势热区走），旧壳回落到 system 通道', () => {
    const carriers = insetCarriers()
    const declared = document.querySelector('style')!.sheet!.cssRules[0] as CSSStyleRule
    const value = declared.style.getPropertyValue('padding-bottom')
    expect(carriers.length).toBe(1)
    // 首选 navbar（真正盖住页面的系统栏），回落 system（旧壳/桌面），再回落 0px。
    expect(value).toContain('var(--dsh-android-navbar-bottom')
    expect(value).toContain('var(--dsh-android-system-bottom, 0px)')
  })

  it('④ 反证：把预留改回 seat 自身，①② 必须判红（证明判据有判别力）', () => {
    const broken = COMPOSER_INSETS_CSS.replace(
      "[data-composer-seat] [class*='composerStack']",
      '[data-composer-seat]',
    )
    const { seat } = mount(broken)
    const carriers = insetCarriers()
    expect(carriers.length).toBe(1)
    expect(carriers[0].hitsSeat, '缺陷形态下规则必须命中 seat 自身').toBe(true)
    expect(carriers[0].hitsStack).toBe(false)
    // jsdom 不解析 max()/var()，这里判「seat 是否吃到了预留」这一事实本身：
    // 绿色态是 0px（没吃到），缺陷态是那条表达式（吃到了）。
    expect(seatPaddingBottom(seat), '缺陷形态下 seat 吃到了底部预留')
      .toContain('--dsh-android-navbar-bottom')
  })
})
