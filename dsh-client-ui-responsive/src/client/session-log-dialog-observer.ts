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
 */
import { SESSION_LOG_DIALOG_HIDE_CLASS, SESSION_LOG_DIALOG_LABEL_PREFIXES } from './session-log-dialog.css.ts'

/** 上游导出弹窗的判定：`[role=dialog]` 且 aria-label 命中导出文案前缀。 */
export function isSessionLogDialog(element: Element): boolean {
  if (!element.matches('[role="dialog"]')) return false
  const label = element.getAttribute('aria-label') ?? ''
  return SESSION_LOG_DIALOG_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix))
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
    this.sync()
  }

  /** 停止监听并清除所有 class。 */
  detach(): void {
    this.mutationObserver.disconnect()
    for (const element of this.tagged) element.classList.remove(SESSION_LOG_DIALOG_HIDE_CLASS)
    this.tagged.clear()
    this.attached = false
  }

  /** 同步一次：命中导出弹窗 → 打 class；弹窗消失 → 收 class（绝不残留）。 */
  sync(): void {
    const next = new Set<Element>()
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!isSessionLogDialog(dialog)) continue
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
    if (record.type === 'attributes') return record.target instanceof Element && isSessionLogDialog(record.target)
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
