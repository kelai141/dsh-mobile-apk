/**
 * 导出弹窗隐藏的 **class 降级路径**（ST-14，F-UI-06）。
 *
 * 主路径是 `session-log-dialog.css.ts` 的 `:has()` 规则（Chromium 105+）。旧内核把整条
 * 规则当语法错误丢弃 —— 与 #17 的轨迹面板遮挡同一形态（TrajectoryPanelsObserver 已踩过），
 * 而"规则文本还在页面里"会让 grep 类检查全绿（假绿）。本观察器照
 * `TrajectoryPanelsObserver` 的形状实现：
 *  - 能力探测：`CSS.supports('selector(:has(*))')` 为真 → 不启用（零重复开销）；
 *  - 为假 → MutationObserver 盯住上游导出弹窗，给其 `[role=presentation]`（无则由弹窗自身承担）
 *    打上 `dsh-mobile-hide-session-log-dialog` class，由伴随规则隐藏。
 *
 * #919：本文件与 CSS 必须用**同一套判据**，否则两条路径会在 error 弹窗上分叉 ——
 * 主路径放行、降级路径隐藏（或反之），真机上就变成「新内核能看见报错、旧内核看不见」。
 * 判据因此收敛到 `shouldHideSessionLogDialog()` 一处。
 */
import {
  SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES,
  SESSION_LOG_DIALOG_HIDE_CLASS,
  SESSION_LOG_DIALOG_HIDE_LABEL_PREFIXES,
  SHELL_OUTCOME_ATTR,
} from './session-log-dialog.css.ts'

/** 上游导出弹窗的判定：`[role=dialog]` 且 aria-label 命中任一导出文案前缀。 */
export function isSessionLogDialog(element: Element): boolean {
  if (!element.matches('[role="dialog"]')) return false
  const label = element.getAttribute('aria-label') ?? ''
  return isErrorDialogLabel(label) || isPreparingOrSuccessLabel(label)
}

function isPreparingOrSuccessLabel(label: string): boolean {
  return SESSION_LOG_DIALOG_HIDE_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))
}

function isErrorDialogLabel(label: string): boolean {
  return SESSION_LOG_DIALOG_ERROR_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))
}

/** 壳侧自己的结果弹窗是否已接管结论（`<html>` 上的事实标记，事件驱动，不是时间窗）。 */
export function shellOutcomeShown(doc: Document = document): boolean {
  return doc.documentElement.hasAttribute(SHELL_OUTCOME_ATTR)
}

/**
 * 该弹窗此刻是否应当被隐藏。与 `SESSION_LOG_DIALOG_HIDE_CSS` 的两条规则一一对应：
 *  - preparing / success → 恒隐藏；
 *  - error（#919）→ **只在壳侧已接管结论时**隐藏，否则必须放行。
 * @param dialog - 候选的 `[role=dialog]` 元素。
 * @param doc - 用于读取壳侧结论标记的文档（测试可注入）。
 * @returns 是否应当隐藏。
 */
export function shouldHideSessionLogDialog(dialog: Element, doc: Document = document): boolean {
  if (!isSessionLogDialog(dialog)) return false
  const label = dialog.getAttribute('aria-label') ?? ''
  if (isPreparingOrSuccessLabel(label)) return true
  return shellOutcomeShown(doc)
}

export class SessionLogDialogObserver {
  private readonly mutationObserver = new MutationObserver((records) => {
    if (records.some(record => this.isRelevantMutation(record))) this.sync()
  })
  private attached = false
  private readonly tagged = new Set<Element>()

  /** 开始监听导出弹窗（幂等）；原生支持 :has() 时 CSS 路径已足够，class 降级不启用。 */
  attach(): void {
    if (this.attached) return
    if (supportsHasSelector()) return
    this.attached = true
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label'],
    })
    // 壳侧结论标记落在 <html> 上，body 的子树观察看不到，单独盯它。
    this.mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [SHELL_OUTCOME_ATTR],
    })
    this.sync()
  }

  /** 停止监听并清除所有 class。 */
  detach(): void {
    this.mutationObserver.disconnect()
    for (const element of this.tagged) element.classList.remove(SESSION_LOG_DIALOG_HIDE_CLASS)
    this.tagged.clear()
    this.attached = false
  }

  /** 同步一次：命中且应当隐藏 → 打 class；其余（含被放行的 error）→ 收 class。 */
  sync(): void {
    const next = new Set<Element>()
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!shouldHideSessionLogDialog(dialog)) continue
      const target = dialog.closest('[role="presentation"]') ?? dialog
      target.classList.add(SESSION_LOG_DIALOG_HIDE_CLASS)
      next.add(target)
    }
    for (const element of [...this.tagged]) {
      if (next.has(element)) continue
      element.classList.remove(SESSION_LOG_DIALOG_HIDE_CLASS)
      this.tagged.delete(element)
    }
    for (const element of next) this.tagged.add(element)
  }

  private isRelevantMutation(record: MutationRecord): boolean {
    if (record.type === 'attributes') {
      // 壳侧结论标记翻转：必须重算，否则 error 弹窗会停在上一拍的状态。
      if (record.attributeName === SHELL_OUTCOME_ATTR) return true
      return record.target instanceof Element && isSessionLogDialog(record.target)
    }
    const targets = [record.target, ...record.addedNodes, ...record.removedNodes]
    return targets.some((node) => {
      if (!(node instanceof Element)) return false
      return isSessionLogDialog(node) || node.querySelector('[role="dialog"]') !== null
    })
  }
}

/** CSS 支持探测：旧内核缺 `selector(:has(*))` 支持（真值需 Chromium 105+）。 */
export function supportsHasSelector(): boolean {
  try {
    return typeof CSS !== 'undefined' && CSS.supports !== undefined && CSS.supports('selector(:has(*))')
  } catch {
    return false
  }
}
