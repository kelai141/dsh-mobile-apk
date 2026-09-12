// @vitest-environment jsdom
// ST-14：导出弹窗隐藏规则的能力兜底（旧内核无 :has() 时 class 路径必须生效，且不得假绿）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SESSION_LOG_DIALOG_HIDE_CLASS, SESSION_LOG_DIALOG_HIDE_CSS } from '../src/client/session-log-dialog.css.ts'
import { SessionLogDialogObserver, isSessionLogDialog, supportsHasSelector } from '../src/client/session-log-dialog-observer.ts'

const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }

function insertUpstreamDialog(label = '正在导出 Session…'): HTMLElement {
  const presentation = document.createElement('div')
  presentation.setAttribute('role', 'presentation')
  const dialog = document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-label', label)
  presentation.appendChild(dialog)
  document.body.appendChild(presentation)
  return presentation
}

beforeEach(() => {
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('导出弹窗隐藏（ST-14）', () => {
  it('样式文本同时含 :has() 主路径与 class 兜底路径（缺一即假绿）', () => {
    expect(SESSION_LOG_DIALOG_HIDE_CSS).toContain('[role="presentation"]:has(')
    expect(SESSION_LOG_DIALOG_HIDE_CSS).toContain('.' + SESSION_LOG_DIALOG_HIDE_CLASS)
  })

  it('强制 CSS.supports 返回 false（旧内核）：弹窗拿到隐藏 class，且该 class 规则能被 CSSOM 解析', async () => {
    vi.stubGlobal('CSS', { supports: () => false })
    expect(supportsHasSelector()).toBe(false)
    const observer = new SessionLogDialogObserver()
    observer.attach()
    const presentation = insertUpstreamDialog()
    await flush()
    expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(true)

    // 不是「文本在场」：把规则塞进样式表，确认 class 选择器真被 CSSOM 解析出规则
    const style = document.createElement('style')
    style.textContent = SESSION_LOG_DIALOG_HIDE_CSS
    document.head.appendChild(style)
    const rules = [...style.sheet!.cssRules].map((rule) => 'selectorText' in rule ? (rule as CSSStyleRule).selectorText : '')
    expect(rules.some((selector) => selector.includes('.' + SESSION_LOG_DIALOG_HIDE_CLASS))).toBe(true)
    style.remove()
    observer.detach()
  })

  it('原生支持 :has() 时不启用 class 路径（零重复开销）', async () => {
    vi.stubGlobal('CSS', { supports: () => true })
    expect(supportsHasSelector()).toBe(true)
    const observer = new SessionLogDialogObserver()
    observer.attach()
    const presentation = insertUpstreamDialog()
    await flush()
    expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(false)
    observer.detach()
  })

  it('弹窗消失 / detach 后 class 被收回，不留残留', async () => {
    vi.stubGlobal('CSS', { supports: () => false })
    const observer = new SessionLogDialogObserver()
    observer.attach()
    const presentation = insertUpstreamDialog()
    await flush()
    expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(true)
    presentation.remove()
    await flush()
    expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(false)

    const second = insertUpstreamDialog('Session export')
    await flush()
    expect(second.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(true)
    observer.detach()
    expect(second.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(false)
  })

  it('判定只看稳定 ARIA 事实（本地化文案前缀），不认识的行不误伤', () => {
    const presentation = insertUpstreamDialog('完全无关的弹窗')
    const dialog = presentation.firstElementChild as Element
    expect(isSessionLogDialog(dialog)).toBe(false)
    const real = insertUpstreamDialog('Exporting Session')
    expect(isSessionLogDialog(real.firstElementChild as Element)).toBe(true)
    expect(isSessionLogDialog(document.createElement('div'))).toBe(false)
  })
})
