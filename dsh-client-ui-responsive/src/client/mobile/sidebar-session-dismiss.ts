/**
 * Close the phone drawer after an existing conversation is selected from its
 * session tree. New-session creation has its own handler and is intentionally
 * outside this module's scope.
 */
import { ComposerFocusGuard } from './composer-focus-guard.ts'

const SESSION_ROW_SELECTOR = '[data-dsh-frame] > [class*="sidebarCol"] [data-row-key^="session:"][role="treeitem"]'
const REORDER_ATTR = 'data-dsh-sidebar-reorder'
const ROW_ACTION_SELECTOR = [
  'button', 'a', 'input', 'textarea', 'select', '[role="button"]',
  '[role="menu"]', '[role="menuitem"]', '[contenteditable="true"]',
  '[data-slot="sidebar.session.row.action"]',
  '[data-slot="sidebar.workspaces.session.menu.item"]',
].join(', ')
const COLLAPSE_DELAY_MS = 500

export interface SidebarSessionDismissDeps {
  mobileForm: () => boolean
  drawerCollapsed: () => boolean
  collapseDrawer: () => void
}

/**
 * Reconcile sidebar selection with the phone drawer without owning row clicks.
 * A short delay preserves the upstream title double-click rename gesture.
 */
export class SidebarSessionDismiss {
  private collapseTimer: number | null = null
  private readonly focusGuard: ComposerFocusGuard
  private attached = false

  constructor(
    private readonly deps: SidebarSessionDismissDeps,
    private readonly doc: Document = document,
  ) { this.focusGuard = new ComposerFocusGuard(doc) }

  private readonly onClick = (event: MouseEvent): void => {
    if (!this.deps.mobileForm() || this.deps.drawerCollapsed()
      || this.doc.documentElement.hasAttribute(REORDER_ATTR)) return
    if (!(event.target instanceof Element)) return
    const row = event.target.closest(SESSION_ROW_SELECTOR)
    if (row === null) return
    if (event.target.closest(ROW_ACTION_SELECTOR) !== null) return

    // The first click selects; a second click in the browser's double-click
    // sequence may be the upstream title-rename gesture, so let it complete.
    if (event.detail > 1) {
      this.clearCollapseTimer()
      return
    }
    if (row.getAttribute('aria-selected') !== 'false') return
    this.clearCollapseTimer()
    const selectedKey = row.getAttribute('data-row-key')
    this.collapseTimer = this.doc.defaultView!.setTimeout(() => {
      this.collapseTimer = null
      const selected = [...this.doc.querySelectorAll(SESSION_ROW_SELECTOR)].some(e => e.getAttribute('data-row-key') === selectedKey && e.getAttribute('aria-selected') === 'true')
      if (!selected) { this.focusGuard.clear(); return }
      if (this.deps.mobileForm() && !this.deps.drawerCollapsed()
        && !this.doc.documentElement.hasAttribute(REORDER_ATTR)) this.deps.collapseDrawer()
    }, COLLAPSE_DELAY_MS)
    this.focusGuard.arm()
  }

  // Capture before React commits aria-selected and runs composer focus effects.
  // The delayed collapse still requires the actual row selection to succeed.
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.doc.addEventListener('click', this.onClick, true)
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.doc.removeEventListener('click', this.onClick, true)
    this.clearCollapseTimer()
    this.focusGuard.clear()
  }

  private clearCollapseTimer(): void {
    if (this.collapseTimer === null) return
    this.doc.defaultView!.clearTimeout(this.collapseTimer)
    this.collapseTimer = null
  }
}
