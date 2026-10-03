/**
 * Keep the vendored snapshot manager above the transcript and viewport-sized (#288).
 *
 * vendor/dsh-undo-savepoint/lib/client.js renders SnapshotPanel in
 * conversation.session.header.actions, not a body portal. Its exact hooks are
 * div.u_overlay[data-undo-panel] > div.u_panel and the panel's direct u_* rows.
 * Every upstream renderSlot adds a real display:contents DOM wrapper. The header
 * sits under conversation.header, and its title row under conversation.session.header.
 * SnapshotPanel is a direct child of the header.actions outlet (the vendor returns
 * a React Fragment). Recognizing these seats avoids confusing DOM parents with
 * the layout tree, which omits the wrappers.
 *
 * Old WebViews apply layout containment to the title row's container-type:inline-size:
 * it becomes both a stacking context and the fixed panel's containing block. A
 * temporary title-row class removes containment; a separate header class raises
 * the subtree. Closing the last owned panel releases both classes and restores
 * upstream CSS, without moving React nodes or changing transcript containers.
 */

const OVERLAY_SELECTOR = 'div.u_overlay[data-undo-panel]'
const CANDIDATE_SELECTOR = 'div[data-undo-panel]'
const HEADER_SELECTOR = 'header[data-window-drag]'
const RAISED_CLASS = 'dsh-mobile-snapshot-header-raised'
const UNCONTAINED_CLASS = 'dsh-mobile-snapshot-title-row-uncontained'
const LEASES_KEY = Symbol.for('dsh-client-ui-responsive.snapshot-panels.header-leases')
const TITLE_LEASES_KEY = Symbol.for('dsh-client-ui-responsive.snapshot-panels.title-row-leases')

type ClassLease = { users: number; added: boolean }
type ClassLeases = WeakMap<HTMLElement, ClassLease>
type SnapshotOwners = { header: HTMLElement; titleRow: HTMLElement }

/** Share class ownership across overlapping instances, including module reloads. */
function classLeases(document: Document, key: symbol): ClassLeases {
  const existing = Reflect.get(document, key) as ClassLeases | undefined
  if (existing !== undefined) return existing
  const leases: ClassLeases = new WeakMap()
  Reflect.set(document, key, leases)
  return leases
}

/** Match direct vendor-owned children without requiring :has() or CSS-module guesses. */
function hasChild(parent: Element, selector: string): boolean {
  return Array.from(parent.children).some(child => child.matches(selector))
}

/** Distinguish SnapshotPanel from MessagePanel, settings, and text/code lookalikes. */
function snapshotOwners(overlay: HTMLElement): SnapshotOwners | null {
  const panel = Array.from(overlay.children).find(child => child.matches('div.u_panel'))
  if (panel === undefined || !['u_head', 'u_toolbar', 'u_tbody', 'u_foot']
    .every(row => hasChild(panel, 'div.' + row))) return null

  // These are separate upstream overlay/right-panel seats, not conversation chrome.
  if (overlay.closest('[data-shell-overlay], [data-sidebar-right-panel]') !== null) return null
  const actions = overlay.parentElement
  if (!actions?.matches('div[data-slot="conversation.session.header.actions"]')) return null
  const header = actions.closest<HTMLElement>(HEADER_SELECTOR)
  const headerSeat = header?.parentElement
  if (header === null || !headerSeat?.matches('div[data-slot="conversation.header"]')
    || !headerSeat.parentElement?.matches('div[data-phase]')
    || !hasChild(header, 'div[data-conversation-header-leading]')) return null

  // Only the direct session-header row carrying this actions outlet owns its
  // containment; sibling tabs and transcript query containers stay untouched.
  const sessionSeat = Array.from(header.children)
    .find(child => child.matches('div[data-slot="conversation.session.header"]'))
  const titleRow = sessionSeat === undefined ? undefined : Array.from(sessionSeat.children)
    .find(child => child.matches('div') && child.contains(actions)) as HTMLElement | undefined
  return titleRow === undefined ? null : { header, titleRow }
}

/** Lease temporary ownership classes; the companion stylesheet owns geometry and paint. */
export class SnapshotPanelsObserver {
  private observer: MutationObserver | null = null
  private readonly headers = new Set<HTMLElement>()
  private readonly titleRows = new Set<HTMLElement>()
  private readonly leases: ClassLeases
  private readonly titleLeases: ClassLeases

  /** @param document - The document containing the conversation headers. */
  constructor(private readonly document: Document = globalThis.document) {
    this.leases = classLeases(document, LEASES_KEY)
    this.titleLeases = classLeases(document, TITLE_LEASES_KEY)
  }

  /** Observe existing and newly mounted snapshot managers; repeated attachment is harmless. */
  attach(): void {
    if (this.observer !== null || this.document.defaultView === null) return
    this.observer = new this.document.defaultView.MutationObserver(records => {
      if (this.observer !== null && records.some(record => this.relevant(record))) this.sync()
    })
    this.observer.observe(this.document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-slot', 'data-undo-panel', 'data-phase', 'data-window-drag',
        'data-conversation-header-leading', 'data-shell-overlay', 'data-sidebar-right-panel'],
    })
    this.sync()
  }

  /** Release this observer's leases, including owners already detached from the document. */
  detach(): void {
    this.observer?.disconnect()
    this.observer = null
    for (const header of this.headers) this.release(header, RAISED_CLASS, this.leases)
    for (const titleRow of this.titleRows) this.release(titleRow, UNCONTAINED_CLASS, this.titleLeases)
    this.headers.clear()
    this.titleRows.clear()
  }

  private sync(): void {
    const nextHeaders = new Set<HTMLElement>()
    const nextTitleRows = new Set<HTMLElement>()
    for (const overlay of this.document.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR)) {
      const owners = snapshotOwners(overlay)
      if (owners !== null) {
        nextHeaders.add(owners.header)
        nextTitleRows.add(owners.titleRow)
      }
    }
    this.syncClasses(this.headers, nextHeaders, RAISED_CLASS, this.leases)
    this.syncClasses(this.titleRows, nextTitleRows, UNCONTAINED_CLASS, this.titleLeases)
  }

  private syncClasses(owned: Set<HTMLElement>, next: Set<HTMLElement>, className: string, leases: ClassLeases): void {
    for (const element of owned) {
      if (!next.has(element)) this.release(element, className, leases)
    }
    for (const element of next) {
      if (!owned.has(element)) {
        const lease = leases.get(element)
        if (lease !== undefined) lease.users += 1
        else leases.set(element, { users: 1, added: !element.classList.contains(className) })
      }
      if (!element.classList.contains(className)) {
        const lease = leases.get(element)
        if (lease !== undefined) lease.added = true
        element.classList.add(className)
      }
    }
    owned.clear()
    for (const element of next) owned.add(element)
  }

  private release(element: HTMLElement, className: string, leases: ClassLeases): void {
    const lease = leases.get(element)
    if (lease === undefined || --lease.users > 0) return
    if (lease.added) element.classList.remove(className)
    leases.delete(element)
  }

  private relevant(record: MutationRecord): boolean {
    const target = record.target
    if (target.nodeType === 1) {
      const element = target as Element
      // Includes ownership-hook removal and reclassification of an already tracked header.
      for (const owner of [...this.headers, ...this.titleRows]) {
        if (owner.contains(element) || element.contains(owner)) return true
      }
      if (element.closest(CANDIDATE_SELECTOR) !== null) return true
      const header = element.closest(HEADER_SELECTOR)
      if (header !== null && header.querySelector(CANDIDATE_SELECTOR) !== null) return true
      if (record.type === 'attributes' && element.querySelector(CANDIDATE_SELECTOR) !== null) return true
    }
    return [...record.addedNodes, ...record.removedNodes].some(node => {
      if (node.nodeType !== 1) return false
      const element = node as Element
      return element.matches(CANDIDATE_SELECTOR) || element.querySelector(CANDIDATE_SELECTOR) !== null
    })
  }
}
