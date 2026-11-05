// @vitest-environment jsdom
// ST-14：导出弹窗隐藏规则的能力兜底（旧内核无 :has() 时 class 路径必须生效，且不得假绿）。
// #919：上游 error 弹窗**不得**被一起隐藏 —— 它是引擎拒绝导出时用户唯一能看到的反馈。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES,
  SESSION_LOG_DIALOG_HIDE_CLASS,
  SESSION_LOG_DIALOG_HIDE_CSS,
  SESSION_LOG_DIALOG_HIDE_LABEL_PREFIXES,
  SHELL_OUTCOME_ATTR,
} from '../src/client/session-log-dialog.css.ts'
import {
  SessionLogDialogObserver,
  isSessionLogDialog,
  shellOutcomeShown,
  shouldHideSessionLogDialog,
  supportsHasSelector,
} from '../src/client/session-log-dialog-observer.ts'

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

/** 把样式表塞进文档，返回真实生效的 display 值（不是"文本在场"）。 */
function computedDisplayOf(presentation: HTMLElement): string {
  const style = document.createElement('style')
  style.textContent = SESSION_LOG_DIALOG_HIDE_CSS
  document.head.appendChild(style)
  const value = getComputedStyle(presentation).display
  style.remove()
  return value
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(SHELL_OUTCOME_ATTR)
})
afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(SHELL_OUTCOME_ATTR)
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

    const second = insertUpstreamDialog('Session download started')
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

describe('#919 error 弹窗必须保留', () => {
  it('preparing 与 success 仍无条件隐藏（壳侧结果面已覆盖这两态）', async () => {
    vi.stubGlobal('CSS', { supports: () => false })
    const observer = new SessionLogDialogObserver()
    observer.attach()
    for (const label of ['正在导出 Session…', 'Exporting Session', 'Session 导出已开始下载', 'Session download started']) {
      const presentation = insertUpstreamDialog(label)
      await flush()
      expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS), label + ' 必须被隐藏').toBe(true)
      presentation.remove()
      await flush()
    }
    observer.detach()
  })

  it('error 弹窗在壳侧未接管结论时不得隐藏（旧规则会把它一起吃掉）', async () => {
    vi.stubGlobal('CSS', { supports: () => false })
    const observer = new SessionLogDialogObserver()
    observer.attach()
    for (const label of SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES) {
      const presentation = insertUpstreamDialog(label)
      await flush()
      expect(
        presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS),
        label + ' 是用户唯一的反馈，不得隐藏',
      ).toBe(false)
      presentation.remove()
      await flush()
    }
    observer.detach()
  })

  it('壳侧接管结论后 error 弹窗才隐藏，且结论收回后立刻放行（事件驱动，不是时间窗）', async () => {
    vi.stubGlobal('CSS', { supports: () => false })
    const observer = new SessionLogDialogObserver()
    observer.attach()
    const presentation = insertUpstreamDialog('Session 导出失败')
    await flush()
    expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(false)

    // 壳侧结果弹窗打开：事实标记落到 <html>，观察器必须重算（否则会一直放行）。
    document.documentElement.setAttribute(SHELL_OUTCOME_ATTR, '')
    await flush()
    expect(shellOutcomeShown()).toBe(true)
    expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(true)

    // 壳侧弹窗关掉：标记撤回，error 弹窗必须立刻回来（不能靠定时器）。
    document.documentElement.removeAttribute(SHELL_OUTCOME_ATTR)
    await flush()
    expect(presentation.classList.contains(SESSION_LOG_DIALOG_HIDE_CLASS)).toBe(false)
    observer.detach()
  })

  it('CSS 主路径与 class 降级路径判据一致（两条路径不得在 error 上分叉）', () => {
    // error 的选择器必须挂在壳侧结论标记下；preparing/success 的选择器必须不挂。
    for (const prefix of SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES) {
      const scoped = `html[${SHELL_OUTCOME_ATTR}] [role="presentation"]:has([role="dialog"][aria-label^="${prefix}"])`
      expect(SESSION_LOG_DIALOG_HIDE_CSS).toContain(scoped)
      // 且不得存在一条**不带**该作用域的 error 规则。
      const bare = `[role="presentation"]:has([role="dialog"][aria-label^="${prefix}"])`
      const bareWithScope = SESSION_LOG_DIALOG_HIDE_CSS.split(bare).length - 1
      const scopedCount = SESSION_LOG_DIALOG_HIDE_CSS.split(scoped).length - 1
      expect(bareWithScope - scopedCount, prefix + ' 存在无作用域的隐藏规则').toBe(0)
    }
    for (const prefix of SESSION_LOG_DIALOG_HIDE_LABEL_PREFIXES) {
      const scoped = `html[${SHELL_OUTCOME_ATTR}] [role="presentation"]:has([role="dialog"][aria-label^="${prefix}"])`
      expect(SESSION_LOG_DIALOG_HIDE_CSS, prefix + ' 不该被作用域限制').not.toContain(scoped)
    }
  })

  it('判据函数与样式表同源：shouldHideSessionLogDialog 直接对 error 说 false', () => {
    const presentation = insertUpstreamDialog('Session export failed')
    const dialog = presentation.firstElementChild as Element
    expect(shouldHideSessionLogDialog(dialog)).toBe(false)
    document.documentElement.setAttribute(SHELL_OUTCOME_ATTR, '')
    expect(shouldHideSessionLogDialog(dialog)).toBe(true)
    document.documentElement.removeAttribute(SHELL_OUTCOME_ATTR)
    expect(shouldHideSessionLogDialog(dialog)).toBe(false)
  })
})
describe('#919 壳侧结论标记与桥接', () => {
  it('dsh:export-result 事件打开壳侧弹窗时置标记，弹窗关闭时清标记（互斥判据来自事件，不是时间窗）', async () => {
    const { ExportResultChannel, reportUserFacingResult } = await import('../src/client/export-result.ts')
    const channel = new ExportResultChannel()
    const markOutcomeShown = (shown: boolean): void => {
      if (shown) document.documentElement.setAttribute(SHELL_OUTCOME_ATTR, '')
      else document.documentElement.removeAttribute(SHELL_OUTCOME_ATTR)
    }
    const onResult = (event: Event): void => {
      const payload = (event as CustomEvent<{ ok: boolean, title: string, detail: string }>).detail
      if (payload === null || typeof payload !== 'object') return
      channel.show(payload)
    }
    const onResultWithMark = (event: Event): void => {
      onResult(event)
      if (channel.getSnapshot().open) markOutcomeShown(true)
    }
    window.addEventListener('dsh:export-result', onResultWithMark)
    const unsubscribe = channel.subscribe(() => {
      if (!channel.getSnapshot().open) markOutcomeShown(false)
    })

    expect(shellOutcomeShown()).toBe(false)
    reportUserFacingResult({ ok: false, title: 'Session 导出失败', detail: 'HEAD 预检失败' })
    await flush()
    expect(channel.getSnapshot().open).toBe(true)
    expect(shellOutcomeShown(), '壳侧弹窗开着时标记必须在场').toBe(true)

    channel.close()
    await flush()
    expect(shellOutcomeShown(), '壳侧弹窗关掉后标记必须立刻撤回').toBe(false)

    window.removeEventListener('dsh:export-result', onResultWithMark)
    unsubscribe()
  })
})
