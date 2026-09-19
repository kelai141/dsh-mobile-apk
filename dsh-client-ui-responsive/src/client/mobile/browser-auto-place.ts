/**
 * AI browser auto-placement into the right Sidebar (0.14.0 P0-2, user semantics;
 * known issue #1 fix, 0.14.1 block D).
 *
 * The expectation is only that a page the model opened becomes *registered* as a tab of the
 * Sidebar that belongs to **the session that acted** — never that the column is pulled open
 * over a conversation the user is reading.
 *
 * Two defects the previous inline implementation had, both measured in source:
 *
 * A. Wrong session. `tick()` read the shell's `browserHostStatus()` — a single JSON document for
 *    the shell's *current* workspace — and placed the tab through `ctx.sidebarRight.openTab`,
 *    which acts on the **mounted** seat's session (the session on screen). A page opened by
 *    session A therefore opened a tab in session B's column. The status document does carry the
 *    acting session (`ownerSessionId`, `BrowserHost.kt` `currentWorkspace?.sessionKey`), so the
 *    placement is now addressed by that field alone: `openTabIn(ownerSessionId, kind)`.
 *
 * B. Forced expansion. `openTab` → `openContent` plans `planSetExpanded(state, true)` as its
 *    first operation (`ui-sidebar-right/src/client/stores.ts`), so calling it while the column is
 *    collapsed expands it. Collapsed columns therefore never receive the call; they only record a
 *    per-session pending placement, flushed when that same session's column is observed expanded.
 *
 * Session identity has two sides and both must agree before anything is written:
 *  - the *acting* session = `ownerSessionId` in the shell status document;
 *  - the *mounted* session = `data-dsh-session-id` on `<html>`, published by `SessionMarker`.
 * A status without `ownerSessionId` is refused outright (no anonymous, global placement), and a
 * status whose owner is not the mounted session only records `pending` — it never touches any
 * column, so one session's activity cannot change another session's Sidebar state.
 *
 * The collapse signal stays the upstream `[data-sidebar-right-expand]` control (the authoritative
 * "collapsed" signal, see `browser-tab.tsx` for the three wrong signals) — but it is only read
 * after the owner/mounted check, so it always describes the column the placement would write to.
 */
import { SESSION_ID_ATTRIBUTE } from './session-marker.ts'

/** Shell status document, as far as placement reads it. */
export interface BrowserHostStatusLike {
  /** A page exists in the shell's current workspace. */
  created?: unknown
  /** Per-page generation counter; part of the edge signature. */
  pageGeneration?: unknown
  /** Tab summaries; only identity fields are read. */
  tabs?: unknown
  /** Session the shell's current workspace belongs to (`BrowserHost.status()`). */
  ownerSessionId?: unknown
}

/** Right-Sidebar face used by placement: the session-addressed navigation entry only. */
export interface BrowserSidebarFace {
  /**
   * Session-addressed placement (`ctx.sidebarRight.openTabIn`, shipped since 0.1.5-rc.1). The
   * mounted-session `openTab` is deliberately not part of this face: on a composition without the
   * addressed entry placement skips rather than writing into whichever session is on screen.
   */
  openTabIn?: (sessionId: string, kind: string, options?: { revealIfOpened?: boolean }) => void
}

/** Everything one placement pass reads; all of it injectable so the policy is unit-testable. */
export interface BrowserAutoPlaceOptions {
  /** Tab kind to register (the AI browser page). */
  kind: string
  /** Raw shell status document, or `undefined` when the bridge is absent. */
  status: () => string | undefined
  /** Session on screen (`data-dsh-session-id`), or `undefined` while none is selected. */
  currentSessionId: () => string | undefined
  /** Resolved right-Sidebar face; `undefined` when the composition has no right column. */
  sidebar: () => BrowserSidebarFace | undefined
  /** Whether the column is collapsed (upstream expand control present). */
  collapsed: () => boolean
  /** Poll period; only used to discover edges. */
  intervalMs?: number
  /** Interval/timer host; defaults to the page `window`. */
  scheduler?: BrowserAutoPlaceScheduler
}

/** The two timer calls placement needs; a seam for tests without a real clock. */
export interface BrowserAutoPlaceScheduler {
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
}

/** Session on screen as published by `SessionMarker`; `undefined` when no session is selected. */
export function domCurrentSessionId(): string | undefined {
  try {
    const value = document.documentElement.getAttribute(SESSION_ID_ATTRIBUTE)
    return value === null || value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Upstream's authoritative collapsed signal: the expand control renders only while collapsed. */
export function domCollapsedNow(): boolean {
  try {
    return document.querySelector('[data-sidebar-right-expand]') !== null
  } catch {
    return false
  }
}

function parseStatus(raw: string | undefined): BrowserHostStatusLike {
  if (raw === undefined || raw === '') return {}
  try {
    const value = JSON.parse(raw) as unknown
    return value !== null && typeof value === 'object' ? (value as BrowserHostStatusLike) : {}
  } catch {
    return {}
  }
}

/** Edge signature = which pages exist at which generation; unchanged means "do nothing". */
function signatureOf(status: BrowserHostStatusLike): string {
  const tabs = Array.isArray(status.tabs) ? (status.tabs as Array<Record<string, unknown>>) : []
  return tabs.map((tab) => String(tab.tabId) + ':' + String(tab.url)).join('|') + '#' + String(status.pageGeneration)
}

/**
 * Edge-triggered, session-addressed placement of the AI browser page.
 *
 * One instance tracks every session it has observed: a per-session signature baseline plus a
 * per-session `pending` flag. Nothing is written for a session that is not both the shell's
 * current workspace owner and the session on screen.
 */
export class BrowserAutoPlace {
  private readonly seen = new Map<string, string>()
  private readonly pending = new Set<string>()
  /**
   * Owners whose workspace was observed **empty** during this page load, before it had a page.
   *
   * This is what separates the two otherwise identical "first observation" cases for one owner:
   *  - the owner was seen empty, then a page appeared: the page cannot predate this page load, so
   *    it is a real appearance and must be placed;
   *  - a page on the very first observation of that owner (`reloadWebUI` with a live BrowserHost):
   *    it may predate this page load, so it only establishes a baseline and never steals the
   *    column.
   *
   * Keyed by owner on purpose: a global flag would let "some workspace was empty once" turn every
   * later session's pre-existing page into a placement, which is the misplacement this module
   * exists to prevent. An empty observation that carries no owner is not attributed to anyone.
   */
  private readonly seenEmpty = new Set<string>()
  private timer: number | undefined
  private attached = false
  private readonly intervalMs: number
  private readonly scheduler: BrowserAutoPlaceScheduler

  /**
   * @param options - status/session/sidebar/collapse readers and the poll period.
   */
  constructor(private readonly options: BrowserAutoPlaceOptions) {
    this.intervalMs = options.intervalMs ?? 1_000
    this.scheduler = options.scheduler ?? {
      setInterval: (handler, ms) => window.setInterval(handler, ms),
      clearInterval: (handle) => { window.clearInterval(handle) },
    }
  }

  /**
   * Start polling for placement edges.
   * @returns the disposer that stops the poll.
   */
  attach(): () => void {
    if (this.attached) return () => {}
    this.attached = true
    this.timer = this.scheduler.setInterval(() => { this.tick() }, this.intervalMs)
    return () => { this.detach() }
  }

  /** Stop polling; pending state is dropped (a later mount re-observes its baseline). */
  detach(): void {
    if (this.timer !== undefined) this.scheduler.clearInterval(this.timer)
    this.timer = undefined
    this.attached = false
  }

  /** Sessions with a recorded pending placement; exposed for assertions and diagnostics. */
  pendingSessions(): string[] {
    return [...this.pending]
  }

  /**
   * One placement pass. Never throws: a bridge that is absent, a status that is unreadable, or a
   * sidebar that is not mounted all leave every column untouched.
   */
  tick(): void {
    try {
      const status = parseStatus(this.options.status())
      if (status.created !== true) {
        // No page in the shell's current workspace. If the document still names an owner, remember
        // that this owner was seen empty: a page appearing next is then a genuine appearance
        // rather than a pre-existing baseline. A document without an owner is attributed to
        // nobody — guessing an owner here is the misplacement defect, not a fix for it.
        const emptyOwner = typeof status.ownerSessionId === 'string' ? status.ownerSessionId : ''
        if (emptyOwner !== '') this.seenEmpty.add(emptyOwner)
        return
      }
      const owner = typeof status.ownerSessionId === 'string' ? status.ownerSessionId : ''
      // No acting-session identity: refuse. The old implementation fell back to the mounted
      // session here, which is exactly defect A.
      if (owner === '') return
      const signature = signatureOf(status)
      const previous = this.seen.get(owner)
      if (previous === undefined) {
        this.seen.set(owner, signature)
        // First observation of this owner: only a page that followed an empty observation of the
        // same owner is known to belong to this page load. Otherwise the page may predate it —
        // establishing the baseline is the whole action, so a reload never steals the column.
        if (!this.seenEmpty.has(owner)) return
      }
      const changed = previous === undefined || signature !== previous
      if (changed) this.seen.set(owner, signature)
      const mounted = this.options.currentSessionId()
      if (mounted === undefined || mounted !== owner) {
        // The page belongs to a session that is not on screen; its column is not this DOM's.
        // Record the intent and stop — writing here is what made session A open tabs in B.
        if (changed) this.pending.add(owner)
        return
      }
      if (this.options.collapsed()) {
        // Collapsed: register nothing that would expand it. A page that appeared during the
        // collapsed period is remembered and flushed on the user's own expansion; a page that was
        // already registered before the collapse needs no second write.
        if (changed) this.pending.add(owner)
        return
      }
      if (!changed && !this.pending.has(owner)) return
      this.place(owner)
    } catch {
      /* Shell unavailable: observe again on the next pass; never surface an exception. */
    }
  }

  private place(sessionId: string): void {
    this.pending.delete(sessionId)
    const sidebar = this.options.sidebar()
    if (sidebar === undefined) return
    // Without the addressed entry there is no way to reach a non-mounted session's column, and
    // the mounted one is by construction not this owner: skip rather than misplace.
    sidebar.openTabIn?.(sessionId, this.options.kind)
  }
}
