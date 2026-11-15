// @vitest-environment jsdom
// issue #1782（用户真机 V2425A 1260x2800）：键盘展开 + 输入框里有附件时，输入框被抬到
// 特别高（无附件时不复现）。
//
// 真因（设备 CDP 实测，900x1600 / dpr 1.5）：
//   上游 scrollBody = flex:1; min-height:0; overflow-y:auto（滚动盒）
//   seat            = flex:none; position:sticky; bottom:0（**没有高度上限**）
//   带附件缩略图的 seat 实测 218px；键盘展开后 scrollBody 只剩 181/141/101px。
//   实测：frame 300 -> bodyH 181 / seatH 218 / seatTop 82 < bodyTop 119（顶出容器 37px）
//         frame 260 -> bodyH 141 / seatH 218 / seatTop 42 < bodyTop 119（顶出 77px）
//   键盘越高，顶出的量越大 —— 正是用户说的「被抬到特别高」。
//   无附件时 seat 128px，键盘不展开到底就仍小于 scrollBody，所以不复现。
//
// 修法：seat 高度上限 100%（跟住滚动容器）+ overflow-y:auto（超限在 seat 内滚）。
// 判据（每条配反证）：
//   A. seat 的 max-height 必须是 100% —— 缺陷形态没有这条，sticky 会把顶边顶出容器。
//   B. seat 的 overflow-y 不得是 visible —— 只有上限时超限内容会被直接裁掉。
//   C. A/B 在缺陷形态（去掉本条规则）下必须判红，证明判据有判别力。
import { describe, expect, it } from 'vitest'
import { COMPOSER_INSETS_CSS } from '../src/client/composer-insets.css.ts'

/** 按上游真实结构建座位：scrollBody > seat > composerStack。 */
function mount(css: string): { seat: HTMLElement; stack: HTMLElement } {
  document.head.innerHTML = ''
  document.body.innerHTML =
    '<div class="wSkVaW_scrollBody"><div data-composer-seat><div class="wSkVaW_composerStack"></div></div></div>'
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  return {
    seat: document.querySelector<HTMLElement>('[data-composer-seat]')!,
    stack: document.querySelector<HTMLElement>('.wSkVaW_composerStack')!,
  }
}

/** 取出命中 seat 的规则里对某个属性的声明（浏览器解析，不读源码文本）。 */
function declaredOnSeat(property: string): string[] {
  const sheet = document.querySelector('style')!.sheet!
  const seat = document.querySelector<HTMLElement>('[data-composer-seat]')!
  const values: string[] = []
  for (const rule of Array.from(sheet.cssRules)) {
    if (!(rule instanceof CSSStyleRule)) continue
    if (!seat.matches(rule.selectorText)) continue
    const value = rule.style.getPropertyValue(property)
    if (value !== '') values.push(value)
  }
  return values
}

describe('#1782 带附件的输入框不得被键盘抬出滚动容器', () => {
  it('A. seat 的高度上限是 100%（跟住滚动容器，不再溢出顶边）', () => {
    mount(COMPOSER_INSETS_CSS)
    const caps = declaredOnSeat('max-height')
    expect(caps.length, '必须恰好有一条规则给 seat 高度上限').toBe(1)
    expect(caps[0].trim(), '上限必须是容器高度，写死像素会在键盘不同高度下失效').toBe('100%')
  })

  it('B. seat 允许内部滚动（超限内容不被裁掉）', () => {
    mount(COMPOSER_INSETS_CSS)
    const overflow = declaredOnSeat('overflow-y')
    expect(overflow.length, '必须恰好有一条规则给 seat 内部滚动').toBe(1)
    expect(overflow[0].trim(), '只有上限没有滚动 = 超限的附件缩略图被裁掉').not.toBe('visible')
  })

  it('C. 反证：去掉这两条规则，A/B 必须判红', () => {
    const broken = COMPOSER_INSETS_CSS
      .replace(/max-height:\s*100%;/, '')
      .replace(/overflow-y:\s*auto;/, '')
    expect(broken, '反证用例必须真的去掉两条规则').not.toBe(COMPOSER_INSETS_CSS)
    mount(broken)
    expect(declaredOnSeat('max-height').length, '缺陷形态下 seat 没有高度上限').toBe(0)
    expect(declaredOnSeat('overflow-y').length, '缺陷形态下 seat 不内部滚动').toBe(0)
  })
})

describe('#1782 没有波及 #783 的两条既有约束', () => {
  it('底部预留仍在 composerStack 上，不回到 seat 自身（否则 RO 失聪）', () => {
    const { seat, stack } = mount(COMPOSER_INSETS_CSS)
    const sheet = document.querySelector('style')!.sheet!
    const carriers: { selector: string; hitsSeat: boolean; hitsStack: boolean }[] = []
    for (const rule of Array.from(sheet.cssRules)) {
      if (!(rule instanceof CSSStyleRule)) continue
      if (!rule.style.getPropertyValue('padding-bottom').includes('--dsh-android-navbar-bottom')) continue
      carriers.push({ selector: rule.selectorText, hitsSeat: seat.matches(rule.selectorText), hitsStack: stack.matches(rule.selectorText) })
    }
    expect(carriers.length, '必须恰好有一条规则携带底部预留').toBe(1)
    expect(carriers[0].hitsStack).toBe(true)
    expect(carriers[0].hitsSeat).toBe(false)
  })

  it('键盘高度依旧不进底部预留（壳侧已把 IME 施加到布局尺寸，双重计数会抬两次）', () => {
    expect(COMPOSER_INSETS_CSS).not.toContain('--dsh-android-ime-bottom')
  })
})
