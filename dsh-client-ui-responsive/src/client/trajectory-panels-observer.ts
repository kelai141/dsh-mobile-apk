/**
 * 轨迹详情面板开合的 class 降级路径（2026-08-23，#17 回归修复）：
 * 主 CSS 用 :has()（Chromium 105+）抬升 ledger z-index；旧 WebView（MIUI12
 * 时代 Chromium 83）不支持 :has()，整条规则被丢弃 → 面板被顶部 banner 遮挡。
 * 本观察器用 MutationObserver 检测 aside[aria-label="Event details"] 的存在，
 * 给所属 ledger 切换 data-mobile-ledger-raised class（trajectory-details.css.ts
 * 的伴随规则兜底），并在浏览器原生支持 :has() 时自动停摆（零重复开销）。
 */
export class TrajectoryPanelsObserver {
  private readonly mutationObserver = new MutationObserver((records) => {
    if (records.some(record => this.isRelevantMutation(record))) this.sync()
  })
  private readonly ledger: Element | null
  private attached = false

  constructor(ledger: Element | null) {
    this.ledger = ledger
  }

  /** 开始监听面板开合（幂等）。 */
  attach(): void {
    if (this.attached) return
    // 原生支持 :has() 时 CSS 路径已足够，class 降级不启用。
    if (this.supportsHasSelector()) return
    this.attached = true
    this.mutationObserver.observe(document.body, { childList: true, subtree: true })
    this.sync()
  }

  /** 停止监听并清除 class。 */
  detach(): void {
    this.mutationObserver.disconnect()
    if (this.attached && this.ledger !== null) {
      this.ledger.classList.remove('data-mobile-ledger-raised')
    }
    this.attached = false
  }

  /** 面板存在 → 抬升 ledger（class 路径，CSS .data-mobile-ledger-raised）；否则移除。 */
  private sync(): void {
    if (this.ledger === null) return
    const panel = this.ledger.querySelector<HTMLElement>('aside[aria-label="Event details"]')
    this.ledger.classList.toggle('data-mobile-ledger-raised', panel !== null)
  }

  private isRelevantMutation(record: MutationRecord): boolean {
    const targets = [record.target, ...record.addedNodes, ...record.removedNodes]
    return targets.some(node => {
      if (!(node instanceof Element)) return false
      return node.matches('aside[aria-label="Event details"]') ||
        node.querySelector('aside[aria-label="Event details"]') !== null
    })
  }

  /** CSS 支持探测：:has() 对旧内核很可能是 SyntaxError 整条丢弃后的误报，
   *  用 CSS.supports 的官方探测（Chromium 105+ 才有 CSS.supports('selector(:has(*))') 真值）。 */
  private supportsHasSelector(): boolean {
    try {
      return typeof CSS !== 'undefined' && CSS.supports !== undefined && CSS.supports('selector(:has(*))')
    } catch {
      return false
    }
  }
}
