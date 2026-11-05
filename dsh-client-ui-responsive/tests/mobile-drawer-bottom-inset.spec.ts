// @vitest-environment jsdom
// issue #783 缺陷 A：左侧抽屉底部的大面积无意义留白。
//
// 真因（设备实测 + 壳侧源码）：抽屉的底部预留写的是
//   max(env(safe-area-inset-bottom, 0px), var(--dsh-android-system-bottom, 0px))
// 而壳侧那条 --dsh-android-system-bottom 的取值是
//   max(navigationBars.bottom, mandatorySystemGestures.bottom)
// ——手势导航下 navigationBars.bottom = 0，mandatorySystemGestures.bottom = 138 物理 px
// （= 46 CSS px）。于是「屏幕上没有任何系统条」的手势模式里，抽屉仍被要求让出 46 CSS px，
// 抽屉最低内容之下就是一条纯背景色（荣耀 CRT-AN00：padBottom 46px，最低内容底 750）。
//
// 修法：抽屉这类「不得被系统盖住」的交互面只消费 --dsh-android-navbar-bottom
// （只算真正盖住页面的系统栏），旧壳没有该变量时回落到保守值。
//
// 判据打在浏览器解析出的 **CSSOM 声明**上，并按 CSS 语义把 var()/max()/env() 求值
// （jsdom 不做级联求值，这里只求值本仓实际使用的那几种形态），断言的是**求值结果**，
// 不是源码文本切片。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MOBILE_FORM_CSS } from '../src/client/mobile/mobile-form.css.ts'

const DRAWER = "[data-dsh-frame] > [class*='sidebarCol']"
/** 手机形态宽度（规则挂在 max-width: 767px 下）。 */
const PHONE_WIDTH = 390

/** 把一条 max()/var()/env() 声明按 CSS 语义求值（只覆盖本仓用到的形态）。 */
function evaluate(declaration: string, customProps: Record<string, string>): number {
  const px = (token: string): number => {
    const m = /^(-?[\d.]+)px$/.exec(token.trim())
    if (m === null) throw new Error('无法求值的长度：' + token)
    return Number(m[1])
  }
  const resolveVar = (name: string, fallback: string | null): number => {
    const value = customProps[name]
    if (value !== undefined) return px(value)
    if (fallback === null) throw new Error('自定义属性缺失且无回落值：' + name)
    return evaluateInner(fallback)
  }
  // 从内到外剥掉最外层的 max(...) / var(...) / env(...)
  const evaluateInner = (text: string): number => {
    const t = text.trim()
    if (t.startsWith('max(') && t.endsWith(')')) {
      const args = splitArgs(t.slice(4, -1))
      return Math.max(...args.map(evaluateInner))
    }
    if (t.startsWith('env(') && t.endsWith(')')) {
      // env(safe-area-inset-*) 在本仓实测的 WebView 上恒为 0（壳侧变量才是真值），
      // 求值口径与之一致：取回落值。
      const args = splitArgs(t.slice(4, -1))
      return args.length > 1 ? evaluateInner(args.slice(1).join(',')) : 0
    }
    if (t.startsWith('var(') && t.endsWith(')')) {
      const args = splitArgs(t.slice(4, -1))
      return resolveVar(args[0].trim(), args.length > 1 ? args.slice(1).join(',') : null)
    }
    return px(t)
  }
  const splitArgs = (text: string): string[] => {
    const out: string[] = []
    let depth = 0
    let current = ''
    for (const ch of text) {
      if (ch === '(') depth += 1
      if (ch === ')') depth -= 1
      if (ch === ',' && depth === 0) {
        out.push(current)
        current = ''
        continue
      }
      current += ch
    }
    out.push(current)
    return out.map(part => part.trim()).filter(part => part !== '')
  }
  return evaluateInner(declaration)
}

/** 抽屉实际吃到的 padding-bottom（浏览器解析出的声明 + CSS 语义求值）。 */
function drawerPaddingBottom(css: string, customProps: Record<string, string>): number {
  document.head.innerHTML = ''
  document.body.innerHTML = '<div data-dsh-frame><aside class="upstream_sidebarCol"><button>设置</button></aside></div>'
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
  const drawer = document.querySelector<HTMLElement>(DRAWER)!
  const sheet = document.querySelector('style')!.sheet!
  const declared: string[] = []
  // 抽屉规则写在 (max-width: 767px) 里：按手机宽度展开媒体查询再取命中声明。
  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        const max = /max-width:\s*(\d+)px/.exec(rule.conditionText)
        if (max !== null && PHONE_WIDTH <= Number(max[1])) visit(rule.cssRules)
        continue
      }
      if (!(rule instanceof CSSStyleRule)) continue
      if (!drawer.matches(rule.selectorText)) continue
      const value = rule.style.getPropertyValue('padding-bottom')
      if (value !== '') declared.push(value)
    }
  }
  visit(sheet.cssRules)
  if (declared.length !== 1) throw new Error('抽屉必须恰好有一条 padding-bottom 声明，实际 ' + declared.length)
  return evaluate(declared[0], customProps)
}

beforeEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

afterEach(() => {
  document.head.innerHTML = ''
  document.body.innerHTML = ''
})

describe('issue #783 缺陷 A：抽屉底部预留不得跟着手势热区走', () => {
  it('① 手势导航（无可见系统栏）时预留归零，不产生纯背景带', () => {
    // 壳侧两条通道的真实取值：navbar 0（手势条窗口不可触摸、不遮挡），system 46（含手势热区）。
    expect(drawerPaddingBottom(MOBILE_FORM_CSS, {
      '--dsh-android-navbar-bottom': '0px',
      '--dsh-android-system-bottom': '46px',
    })).toBe(0)
  })

  it('② 三键导航时预留等于导航栏高度（不误伤 #153 的原始修复）', () => {
    expect(drawerPaddingBottom(MOBILE_FORM_CSS, {
      '--dsh-android-navbar-bottom': '48px',
      '--dsh-android-system-bottom': '48px',
    })).toBe(48)
  })

  it('③ 旧壳只有保守通道时回落到它（向后兼容，不出现零预留）', () => {
    expect(drawerPaddingBottom(MOBILE_FORM_CSS, {
      '--dsh-android-system-bottom': '46px',
    })).toBe(46)
  })

  it('④ 反证：改回 max(env, system-bottom) 时 ① 必须判红（证明判据有判别力）', () => {
    const broken = MOBILE_FORM_CSS.replace(
      'var(--dsh-android-navbar-bottom, var(--dsh-android-system-bottom, 0px))',
      'var(--dsh-android-system-bottom, 0px)',
    )
    expect(broken).not.toBe(MOBILE_FORM_CSS)
    expect(drawerPaddingBottom(broken, {
      '--dsh-android-navbar-bottom': '0px',
      '--dsh-android-system-bottom': '46px',
    })).toBe(46)
  })
})
