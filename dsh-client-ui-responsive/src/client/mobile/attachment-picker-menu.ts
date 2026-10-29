/**
 * Composer attachment-source chooser (D2/D4, 2026-09-25).
 *
 * Upstream 0.1.7-rc.1 has NO dedicated paperclip. The only composer button is the command "+"
 * (InputBar.tsx:419-431: aria-label t('input.commands') = "添加文件或调用指令",
 * aria-haspopup="listbox", onClick=onToggleCommandMenu) and the hidden multiple-file input is its
 * own row sibling. The previous revision claimed "the last BUTTON before the hidden input" as the
 * paperclip, so it claimed that "+": preventDefault + stopImmediatePropagation on the capture phase
 * swallowed onToggleCommandMenu, the command menu never opened, and the user saw "the paperclip is
 * gone and + uploads the file" (D4). The structural pairing itself is the defect, not its lookup.
 *
 * The enhancer now owns its own control and claims no upstream button at all:
 * - a paperclip button is mounted INTO the standard 'conversation.input.left' slot anchor
 *   ('[data-slot="conversation.input.left"]'). The anchor renders with 'display: contents', so the
 *   button becomes a flex item of the same '.tools' toolbar at the slot's own seat, after the
 *   permission/plan seats - the upstream InputBar is not modified and nothing is inserted into its
 *   private '.tools' structure;
 * - only that button opens the menu (its own click listener). No other button is intercepted, so the
 *   upstream "+" keeps its own onClick by construction;
 * - a chosen source is still delegated to InputBar's existing hidden multiple-file input: the menu
 *   item sets that input's accept filter inside its own user gesture, clicks it, then restores the
 *   filter. No second bridge, input, upload state, or attachment rail is introduced.
 *
 * Mounting is best-effort. The composer card may not exist yet (boot order) and the anchor comes and
 * goes with the session; a failure to mount must never propagate into the plugin body, because that
 * body is the phone runtime the user asked to keep alive.
 */
import { observeDocumentLanguage } from '../i18n.ts'

/** 语言观察器只装一次（触发按钮会被反复重建）。 */
let triggerLangWatched = false
const MENU_ATTR = 'data-dsh-attachment-picker-menu'
const ITEM_ATTR = 'data-dsh-attachment-picker-item'
const TRIGGER_ATTR = 'data-dsh-attachment-picker-trigger'
/** The standard upstream slot seat for extra composer-left controls. */
const SLOT_SELECTOR = '[data-slot="conversation.input.left"]'
const CARD_SELECTOR = '[data-composer-card]'

type PickerKind = 'file' | 'image'

interface PickerCopy {
  file: string
  image: string
}

function copyForDocument(): PickerCopy {
  const language = (document.documentElement.lang || navigator.language || '').toLowerCase()
  return language.startsWith('zh')
    ? { file: '上传附件', image: '上传图片' }
    : { file: 'Upload attachment', image: 'Upload image' }
}

/**
 * The hidden multiple-file input the upstream InputBar wired its own admission path to.
 *
 * Card-scoped on purpose: the enhancer no longer derives a button from the input (that derivation is
 * what claimed the "+"), it derives the input from our own trigger's composer card. The card holds
 * exactly one such input (InputBar.tsx:433-440), and a second one would be an upstream change the
 * attachment flow has to re-review anyway.
 */
function hiddenFileInputIn(button: HTMLButtonElement): HTMLInputElement | null {
  return button.closest(CARD_SELECTOR)?.querySelector<HTMLInputElement>('input[type="file"][multiple]') ?? null
}

/** Glyph for one menu row. */
function icon(kind: PickerKind): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', '17')
  svg.setAttribute('height', '17')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', kind === 'file'
    ? 'M5 2.75h6l4 4v10.5H5zM11 2.75v4h4M7.25 11h5.5M7.25 14h5.5'
    : 'M3.25 4.25h13.5v11.5H3.25zM5.5 13l3-3 2.25 2.25 1.5-1.5 2.5 2.5M7.25 7.75h.01')
  svg.appendChild(path)
  return svg
}

/** Paperclip glyph for our own trigger (the "+" glyph belongs to upstream and stays there). */
function paperclipIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M12.9 5.2 7 11.1a1.6 1.6 0 0 0 2.26 2.26l6.32-6.32a3.3 3.3 0 0 0-4.67-4.67L4.4 8.86a4.9 4.9 0 0 0 6.93 6.93l5.2-5.2')
  svg.appendChild(path)
  return svg
}

/**
 * Owns the paperclip trigger, the short-lived source menu, and the delegation to InputBar's input.
 */
export class AttachmentPickerMenuEnhancer {
  private menu: HTMLElement | null = null
  private trigger: HTMLButtonElement | null = null
  private restoreActivePicker: (() => void) | null = null
  private observer: MutationObserver | null = null
  private mountScheduled = false
  private attached = false
  /** Triggers this enhancer mounted, with the anchor each was appended to. */
  private readonly mounted: { anchor: HTMLElement, trigger: HTMLButtonElement }[] = []

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.menu === null || !(event.target instanceof Node)) return
    if (this.menu.contains(event.target) || this.trigger?.contains(event.target) === true) return
    this.close()
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.menu === null) return
    event.preventDefault()
    this.close(true)
  }

  private readonly onViewportChange = (): void => {
    if (this.trigger === null || this.menu === null) return
    this.place(this.trigger, this.menu)
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    try {
      document.addEventListener('pointerdown', this.onPointerDown, true)
      document.addEventListener('keydown', this.onKeyDown, true)
      window.addEventListener('resize', this.onViewportChange)
      window.addEventListener('scroll', this.onViewportChange, true)
      // The anchor is mounted by the upstream slot outlet and is re-created whenever the composer
      // remounts (session switch, hero <-> dock). The observer only schedules work for mutations that
      // can actually change the mount set (a slot anchor appearing, or one of our anchors leaving the
      // DOM): an unconditional pass would run a document-wide query on every streaming render batch,
      // which is the per-frame work this plugin elsewhere avoids (browser-tab publishBounds).
      this.observer = new MutationObserver((records) => { this.onMutations(records) })
      this.observer.observe(document.documentElement, { childList: true, subtree: true })
      this.syncMounts()
    } catch (error) {
      // Phone-runtime guard: mounting a convenience control must never abort the plugin body.
      console.warn('[dsh-attachment-picker] attach failed; composer stays usable without the paperclip', error)
    }
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('resize', this.onViewportChange)
    window.removeEventListener('scroll', this.onViewportChange, true)
    this.observer?.disconnect()
    this.observer = null
    this.mountScheduled = false
    this.close()
    for (const entry of this.mounted) entry.trigger.remove()
    this.mounted.length = 0
    this.restoreActivePicker?.()
  }

  /**
   * Whether a tracked anchor or trigger left the DOM.
   *
   * Deliberately false while nothing is mounted: "no anchor seen yet" is answered by the cheap
   * added-node probe in onMutations, so an enhancer that has not mounted (no composer yet) does not
   * run a document-wide query on every unrelated mutation batch.
   */
  private mountSetDirty(): boolean {
    for (const entry of this.mounted) {
      if (!entry.anchor.isConnected || !entry.trigger.isConnected) return true
    }
    return false
  }

  /** Whether a mutated node is a slot anchor, or contains one. */
  private carriesSlotAnchor(node: Node): boolean {
    if (!(node instanceof Element)) return false
    return node.matches(SLOT_SELECTOR) || node.querySelector(SLOT_SELECTOR) !== null
  }

  private onMutations(records: MutationRecord[]): void {
    let relevant = this.mountSetDirty()
    if (!relevant) {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (this.carriesSlotAnchor(node)) { relevant = true; break }
        }
        if (relevant) break
      }
    }
    if (relevant) this.scheduleMounts()
  }

  private scheduleMounts(): void {
    if (this.mountScheduled) return
    this.mountScheduled = true
    queueMicrotask(() => {
      this.mountScheduled = false
      if (!this.attached) return
      this.syncMounts()
    })
  }

  /** Mount our trigger into every live slot anchor that does not have one yet. */
  private syncMounts(): void {
    // Forget anchors that left the DOM when the composer remounted; their trigger went with them.
    for (let index = this.mounted.length - 1; index >= 0; index -= 1) {
      const entry = this.mounted[index]!
      if (!entry.anchor.isConnected || !entry.trigger.isConnected) this.mounted.splice(index, 1)
    }
    for (const anchor of document.querySelectorAll<HTMLElement>(SLOT_SELECTOR)) {
      try {
        // Two independent guards: our own bookkeeping, plus a live look at the anchor. The second
        // covers a trigger left by an earlier instance of this enhancer (attach/detach/attach across
        // a hot reload), which the bookkeeping list cannot know about.
        if (this.mounted.some((entry) => entry.anchor === anchor)) continue
        if (anchor.querySelector('[' + TRIGGER_ATTR + ']') !== null) continue
        const trigger = this.createTrigger()
        anchor.append(trigger)
        this.mounted.push({ anchor, trigger })
      } catch (error) {
        console.warn('[dsh-attachment-picker] mount into ' + SLOT_SELECTOR + ' failed', error)
      }
    }
  }

  private createTrigger(): HTMLButtonElement {
    const copy = copyForDocument()
    // 语言变化时回写已挂载触发按钮的无障碍名（真机：切英文后按钮仍是「上传附件」）。
    if (!triggerLangWatched) {
      triggerLangWatched = true
      observeDocumentLanguage(() => {
        const fresh = copyForDocument()
        for (const entry of this.mounted) entry.trigger.setAttribute('aria-label', fresh.file)
      })
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-attachment-picker-trigger'
    button.setAttribute(TRIGGER_ATTR, '')
    button.setAttribute('aria-label', copy.file)
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.append(paperclipIcon())
    // Our own listener only: nothing else in the composer is claimed, so the upstream "+" keeps
    // its own onClick (onToggleCommandMenu) by construction.
    button.addEventListener('click', (event) => {
      event.preventDefault()
      this.toggle(button)
    })
    return button
  }

  private toggle(button: HTMLButtonElement): void {
    if (this.trigger === button && this.menu !== null) {
      this.close(true)
      return
    }
    this.open(button)
  }

  private open(button: HTMLButtonElement): void {
    this.close()
    const copy = copyForDocument()
    const menu = document.createElement('div')
    menu.setAttribute(MENU_ATTR, '')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', copy.file + ' / ' + copy.image)
    for (const [kind, label] of [['file', copy.file], ['image', copy.image]] as const) {
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute(ITEM_ATTR, kind)
      item.setAttribute('role', 'menuitem')
      item.setAttribute('aria-label', label)
      item.append(icon(kind))
      const text = document.createElement('span')
      text.textContent = label
      item.append(text)
      item.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.choose(button, kind)
      })
      menu.append(item)
    }
    document.body.append(menu)
    button.setAttribute('aria-expanded', 'true')
    this.menu = menu
    this.trigger = button
    this.place(button, menu)
  }

  private place(button: HTMLButtonElement, menu: HTMLElement): void {
    const rect = button.getBoundingClientRect()
    const width = Math.min(264, Math.max(180, window.innerWidth - 24))
    const left = Math.min(Math.max(rect.left, 12), Math.max(12, window.innerWidth - width - 12))
    menu.style.setProperty('width', width + 'px')
    menu.style.setProperty('left', left + 'px')
    menu.style.setProperty('bottom', Math.max(12, window.innerHeight - rect.top + 8) + 'px')
  }

  private choose(button: HTMLButtonElement, kind: PickerKind): void {
    const input = hiddenFileInputIn(button)
    if (input === null || input.disabled || !input.isConnected) {
      this.close()
      return
    }
    this.restoreActivePicker?.()
    const hadAccept = input.hasAttribute('accept')
    const originalAccept = input.getAttribute('accept')
    let restored = false
    let pickerBackgrounded = document.visibilityState === 'hidden'
    let fallbackTimer: number | undefined
    const restore = (): void => {
      if (restored) return
      restored = true
      input.removeEventListener('change', restore)
      input.removeEventListener('cancel', restore)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onWindowFocus)
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      if (this.restoreActivePicker === restore) this.restoreActivePicker = null
      if (hadAccept) input.setAttribute('accept', originalAccept ?? '')
      else input.removeAttribute('accept')
    }
    function onVisibilityChange(): void {
      if (document.visibilityState === 'hidden') {
        pickerBackgrounded = true
        return
      }
      if (pickerBackgrounded) window.setTimeout(restore, 0)
    }
    function onWindowFocus(): void {
      // WebView may focus the input synchronously. Only restore after the app actually backgrounded
      // for the SAF Activity; restoring before onShowFileChooser reads params loses image/*.
      if (pickerBackgrounded) window.setTimeout(restore, 0)
    }
    input.setAttribute('accept', kind === 'image' ? 'image/*' : '*/*')
    input.addEventListener('change', restore, { once: true })
    input.addEventListener('cancel', restore, { once: true })
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onWindowFocus)
    this.restoreActivePicker = restore
    // A cancelled old DocumentsUI picker may emit neither change nor cancel. The timeout is only a
    // cleanup fallback; it never runs before Android has read the current accept filter.
    fallbackTimer = window.setTimeout(restore, 120_000)
    try {
      // Keep this direct user-gesture stack intact. Some older Android WebViews reject a file-input
      // click if the menu is removed before the native chooser request is dispatched.
      input.click()
    } finally {
      this.close()
    }
  }

  private close(focus = false): void {
    const trigger = this.trigger
    this.menu?.remove()
    this.menu = null
    this.trigger = null
    if (trigger !== null) {
      trigger.setAttribute('aria-expanded', 'false')
      if (focus) trigger.focus({ preventScroll: true })
    }
  }
}
