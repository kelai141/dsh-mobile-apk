// @vitest-environment jsdom
/**
 * Source-derived fixtures only: these do not measure WebView paint or native overlay ordering.
 * 唯一的跨仓断言（vendored undo-savepoint 的钩子形态）在 vendor/ 缺席时显式 skip —— 见 vendorPath 注释。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SnapshotPanelsObserver } from '../src/client/snapshot-panels-observer.ts'
import { SNAPSHOT_PANELS_CSS } from '../src/client/snapshot-panels.css.ts'

const RAISED = 'dsh-mobile-snapshot-header-raised'
const UNCONTAINED = 'dsh-mobile-snapshot-title-row-uncontained'

/**
 * Resolve a vendored-fixed copy from cwd upward; jsdom makes import.meta.url non-file.
 *
 * Returns null when absent on purpose: `vendor/dsh-undo-savepoint` lives in the **coordination repo**,
 * not here, so a standalone CI checkout of this repo legitimately has no vendor tree. Returning null lets
 * the single ownership test declare itself skipped there instead of failing on a file it never owned —
 * while still asserting the real hooks wherever the full tree is present (local + APK self-contained build).
 */
function vendorPath(...segments: string[]): string | null {
  let dir = process.cwd()
  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, 'vendor', ...segments)
    if (existsSync(candidate)) return candidate
    const parent = join(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return null
}
const observers: SnapshotPanelsObserver[] = []

afterEach(() => {
  for (const observer of observers.splice(0)) observer.detach()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function attach(Observer: typeof SnapshotPanelsObserver = SnapshotPanelsObserver): SnapshotPanelsObserver {
  const observer = new Observer()
  observer.attach()
  observers.push(observer)
  return observer
}

/**
 * SlotOutlet keeps a real data-slot node even though display:contents removes its layout box.
 * Keep every upstream header outlet: a literal root > header fixture hid issue #288.
 */
function mountConversation(): {
  root: HTMLElement; header: HTMLElement; headerSlot: HTMLElement;
  sessionSlot: HTMLElement; titleRow: HTMLElement; seat: HTMLElement; code: HTMLElement
} {
  const root = document.createElement('div')
  root.setAttribute('data-phase', 'active')
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.innerHTML = '<div data-slot="conversation.header" style="display:contents">' +
    '<header data-window-drag style="display:grid;flex:none">' +
    '<div data-conversation-header-leading><div data-slot="conversation.header.leading" style="display:contents"><button>navigation</button></div></div>' +
    '<div data-slot="conversation.session.header" style="display:contents">' +
    '<div data-test-title-row style="container-type:inline-size"><div><nav>session</nav><div>' +
    '<div data-slot="conversation.session.header.actions" data-test-seat style="display:contents"></div>' +
    '</div></div><div data-conversation-header-corner></div></div>' +
    '</div></header></div><main><div style="position:relative"><div style="position:sticky;z-index:6">Code banner</div>' +
    '<pre><code>content</code></pre></div></main>'
  document.body.append(root)
  return {
    root, header: root.querySelector('header')!,
    headerSlot: root.querySelector('[data-slot="conversation.header"]')!,
    sessionSlot: root.querySelector('[data-slot="conversation.session.header"]')!,
    titleRow: root.querySelector('[data-test-title-row]')!,
    seat: root.querySelector('[data-test-seat]')!, code: root.querySelector('pre')!,
  }
}

/** SnapshotPanel lib/client.js:603–724; rows exist even while loading or empty. */
function mountSnapshot(seat: HTMLElement, title = 'unrelated localized title'): HTMLElement {
  const overlay = document.createElement('div')
  overlay.className = 'u_overlay'
  overlay.setAttribute('data-undo-panel', 'true')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999'
  overlay.innerHTML = '<div class="u_panel"><div class="u_head"><span class="u_title"></span></div>' +
    '<div class="u_toolbar"><button class="u_save"></button></div>' +
    '<div class="u_tbody"><div class="u_empty"></div></div><div class="u_foot"></div></div>'
  overlay.querySelector('.u_title')!.textContent = title
  seat.append(overlay)
  return overlay
}

/** Let ownership mutations and the observer's own class mutation settle; no paint assertion. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('snapshot source ownership', () => {
  it('pins exact vendor hooks and the non-portal header mounting path', (context) => {
    // 不用 new URL(..., import.meta.url)：本文件跑在 jsdom 环境下，import.meta.url 是 http: 协议，
    // fileURLToPath 会抛 TypeError: The URL must be of scheme file（首次进打包门禁时实测）。
    // 改从 cwd 逐级上溯找 vendor/：协调仓布局（cwd=包目录）与 APK 自包含布局都能命中。
    const path = vendorPath('dsh-undo-savepoint', 'lib', 'client.js')
    if (path === null) {
      // 本仓 CI 只检出 dsh-client-ui-responsive，vendor/ 属协调仓 ⇒ 该断言在本仓无从谈起。
      // 显式 skip 而不是伪造通过：整棵树在场时（本地协调仓 / APK 自包含构建）它照常判真。
      context.skip()
      return
    }
    const vendor = readFileSync(path, 'utf8')
    expect(vendor).toContain('overlay: "u_overlay", panel: "u_panel"')
    expect(vendor).toContain('"data-undo-panel": true')
    expect(vendor).toContain('"data-undo-msg-panel": true')
    expect(vendor).toContain('name: "conversation.session.header.actions"')
    expect(vendor).toContain('(SnapshotPanel, { t: props.t, onClose: () => setPanelOpen(false) })')
    expect(vendor).not.toContain('createPortal')
  })

  it('targets the real header outlet and relaxes containment only while its manager is owned', () => {
    const css = SNAPSHOT_PANELS_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toContain('[data-slot="conversation.header"]')
    expect(css).toContain('header[data-window-drag].' + RAISED)
    expect(css).toContain('z-index: 16;')
    expect(css).not.toContain(':has(')
    expect(css).not.toContain('@media')
    expect(css).not.toMatch(/\b(pre|code|iframe|body|html)\b/)
    expect(css).not.toMatch(/(position|transform|isolation|pointer-events|overflow)\s*:/)
    expect(css).toContain('container-type: normal')
    expect(css).toContain('contain: none')
    expect(css).toContain(UNCONTAINED)
  })
})

describe('SnapshotPanelsObserver header promotion', () => {
  it('raises an already mounted owned header without changing DOM, inline styles, or code paint', () => {
    const { root, header, headerSlot, sessionSlot, titleRow, seat, code } = mountConversation()
    const overlay = mountSnapshot(seat)
    header.classList.add('other-owner')
    const headerStyle = header.getAttribute('style')
    const overlayStyle = overlay.getAttribute('style')
    const codeStyle = code.getAttribute('style')
    const titleStyle = titleRow.getAttribute('style')
    expect(header.parentElement).toBe(headerSlot)
    expect(headerSlot.parentElement).toBe(root)
    expect(titleRow.parentElement).toBe(sessionSlot)
    expect(headerSlot.style.display).toBe('contents')
    const observer = attach()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    expect(overlay.parentElement).toBe(seat)
    expect(header.getAttribute('style')).toBe(headerStyle)
    expect(overlay.getAttribute('style')).toBe(overlayStyle)
    expect(code.getAttribute('style')).toBe(codeStyle)
    expect(titleRow.getAttribute('style')).toBe(titleStyle)
    observer.detach()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(header.classList.contains('other-owner')).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
    expect(header.getAttribute('style')).toBe(headerStyle)
    expect(titleRow.getAttribute('style')).toBe(titleStyle)
  })

  it('opens, closes, and reopens without depending on CSS.supports or translated labels', async () => {
    vi.stubGlobal('CSS', undefined)
    const { header, titleRow, seat } = mountConversation()
    attach()
    const first = mountSnapshot(seat, 'Snapshot Manager')
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    first.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
    mountSnapshot(seat, '快照管理')
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
  })

  it('releases disjoint headers independently when one manager closes', async () => {
    const left = mountConversation()
    const right = mountConversation()
    const first = mountSnapshot(left.seat)
    mountSnapshot(right.seat)
    attach()
    expect(left.header.classList.contains(RAISED)).toBe(true)
    expect(right.header.classList.contains(RAISED)).toBe(true)
    expect(left.titleRow.classList.contains(UNCONTAINED)).toBe(true)
    expect(right.titleRow.classList.contains(UNCONTAINED)).toBe(true)
    first.remove()
    await settle()
    expect(left.header.classList.contains(RAISED)).toBe(false)
    expect(right.header.classList.contains(RAISED)).toBe(true)
    expect(left.titleRow.classList.contains(UNCONTAINED)).toBe(false)
    expect(right.titleRow.classList.contains(UNCONTAINED)).toBe(true)
  })

  it('retains a shared header while any of its managers remains', async () => {
    const { header, titleRow, seat } = mountConversation()
    const first = mountSnapshot(seat)
    const second = mountSnapshot(seat)
    attach()
    first.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    second.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
  })

  it('tracks an externally moved manager without itself moving any React-owned node', async () => {
    const left = mountConversation()
    const right = mountConversation()
    const overlay = mountSnapshot(left.seat)
    attach()
    right.seat.append(overlay)
    await settle()
    expect(left.header.classList.contains(RAISED)).toBe(false)
    expect(right.header.classList.contains(RAISED)).toBe(true)
    expect(left.titleRow.classList.contains(UNCONTAINED)).toBe(false)
    expect(right.titleRow.classList.contains(UNCONTAINED)).toBe(true)
    expect(overlay.parentElement).toBe(right.seat)
  })

  it('shares leases across overlapping instances and a module reload', async () => {
    const { header, titleRow, seat } = mountConversation()
    mountSnapshot(seat)
    const old = attach()
    vi.resetModules()
    const { SnapshotPanelsObserver: Reloaded } = await import('../src/client/snapshot-panels-observer.ts')
    const current = attach(Reloaded)
    old.detach()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    current.detach()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
  })

  it('does not remove a class already present before acquisition', () => {
    const { header, titleRow, seat } = mountConversation()
    header.classList.add(RAISED, 'other-owner')
    titleRow.classList.add(UNCONTAINED, 'other-title-owner')
    mountSnapshot(seat)
    const first = attach()
    const second = attach()
    first.detach()
    second.detach()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(header.classList.contains('other-owner')).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    expect(titleRow.classList.contains('other-title-owner')).toBe(true)
  })

  it('attaches/detaches idempotently, releases detached headers, and can attach again', async () => {
    const { root, header, seat } = mountConversation()
    mountSnapshot(seat)
    const observer = attach()
    observer.attach()
    root.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    document.body.append(root)
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    observer.detach()
    observer.detach()
    expect(header.classList.contains(RAISED)).toBe(false)
    observer.attach()
    expect(header.classList.contains(RAISED)).toBe(true)
  })

  it('retracts the class when panel ownership or direct rows disappear', async () => {
    const { header, seat } = mountConversation()
    const overlay = mountSnapshot(seat)
    attach()
    overlay.removeAttribute('data-undo-panel')
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    overlay.setAttribute('data-undo-panel', 'true')
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    overlay.querySelector('.u_toolbar')!.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
  })

  it('retracts and restores promotion when the source-owned header seat is reclassified', async () => {
    const { header, seat } = mountConversation()
    mountSnapshot(seat)
    const leading = header.querySelector('[data-conversation-header-leading]')!
    attach()
    leading.removeAttribute('data-conversation-header-leading')
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    leading.setAttribute('data-conversation-header-leading', '')
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
  })

  it.each(['headerSlot', 'sessionSlot', 'seat'] as const)(
    'releases and reacquires both paint classes when the %s outlet changes ownership', async key => {
      const conversation = mountConversation()
      mountSnapshot(conversation.seat)
      const outlet = conversation[key]
      const original = outlet.getAttribute('data-slot')!
      attach()
      expect(conversation.header.classList.contains(RAISED)).toBe(true)
      expect(conversation.titleRow.classList.contains(UNCONTAINED)).toBe(true)
      outlet.setAttribute('data-slot', 'another.plugin.outlet')
      await settle()
      expect(conversation.header.classList.contains(RAISED)).toBe(false)
      expect(conversation.titleRow.classList.contains(UNCONTAINED)).toBe(false)
      outlet.setAttribute('data-slot', original)
      await settle()
      expect(conversation.header.classList.contains(RAISED)).toBe(true)
      expect(conversation.titleRow.classList.contains(UNCONTAINED)).toBe(true)
    },
  )

  it('releases both classes when a vendor row is reclassified rather than removed', async () => {
    const { header, titleRow, seat } = mountConversation()
    const overlay = mountSnapshot(seat)
    const toolbar = overlay.querySelector('.u_toolbar')!
    attach()
    toolbar.className = 'looks-like-u_toolbar'
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
    toolbar.className = 'u_toolbar'
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
  })

  it('keeps ownership through a real diff child and restores classes only after its manager closes', async () => {
    const { header, titleRow, seat } = mountConversation()
    const overlay = mountSnapshot(seat)
    const panel = overlay.querySelector('.u_panel')!
    const diff = document.createElement('div')
    diff.className = 'u_diffbox'
    diff.setAttribute('data-undo-diff', 'true')
    diff.innerHTML = '<div class="u_diffhead"><button>close diff</button></div><div class="u_diffbody">changes</div>'
    attach()
    panel.insertBefore(diff, panel.querySelector('.u_tbody'))
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    expect(diff.parentElement).toBe(panel)
    diff.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    overlay.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
  })

  it('reacquires classes removed by another renderer and cleans them up without inline-style changes', async () => {
    const { header, titleRow, seat } = mountConversation()
    const originalStyle = titleRow.getAttribute('style')
    const overlay = mountSnapshot(seat)
    attach()
    header.classList.remove(RAISED)
    titleRow.classList.remove(UNCONTAINED)
    await settle()
    expect(header.classList.contains(RAISED)).toBe(true)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(true)
    expect(titleRow.getAttribute('style')).toBe(originalStyle)
    overlay.remove()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
    expect(titleRow.getAttribute('style')).toBe(originalStyle)
  })

  it('releases a replaced title row and leases the replacement without retaining stale classes', async () => {
    const { header, titleRow, sessionSlot, seat } = mountConversation()
    const overlay = mountSnapshot(seat)
    attach()
    const replacement = titleRow.cloneNode(true) as HTMLElement
    replacement.classList.remove(UNCONTAINED)
    replacement.querySelector('[data-test-seat]')!.replaceChildren(overlay)
    titleRow.replaceWith(replacement)
    await settle()
    expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
    expect(replacement.classList.contains(UNCONTAINED)).toBe(true)
    expect(replacement.parentElement).toBe(sessionSlot)
    expect(header.classList.contains(RAISED)).toBe(true)
    overlay.remove()
    await settle()
    expect(replacement.classList.contains(UNCONTAINED)).toBe(false)
    expect(header.classList.contains(RAISED)).toBe(false)
  })

  it.each(['direct-header', 'wrong-header-outlet', 'missing-session-outlet', 'indirect-actions-child'] as const)(
    'rejects the %s lookalike even when vendor marker rows are present', shape => {
      const { root, header, headerSlot, sessionSlot, titleRow, seat } = mountConversation()
      const overlay = mountSnapshot(seat)
      if (shape === 'direct-header') {
        root.insertBefore(header, headerSlot)
        headerSlot.remove()
      } else if (shape === 'wrong-header-outlet') {
        headerSlot.setAttribute('data-slot', 'another.header')
      } else if (shape === 'missing-session-outlet') {
        header.append(titleRow)
        sessionSlot.remove()
      } else {
        const wrapper = document.createElement('div')
        wrapper.append(overlay)
        seat.append(wrapper)
      }
      attach()
      expect(header.classList.contains(RAISED)).toBe(false)
      expect(titleRow.classList.contains(UNCONTAINED)).toBe(false)
      expect(overlay.className).toBe('u_overlay')
    },
  )

  it('ignores localized text, the message panel, class substrings, and unowned body surfaces', () => {
    const { header, seat, code } = mountConversation()
    code.textContent = '<div class="u_overlay" data-undo-panel>Snapshot Manager 快照管理</div>'
    const message = mountSnapshot(seat)
    message.removeAttribute('data-undo-panel')
    message.setAttribute('data-undo-msg-panel', 'true')
    const hashedGuess = mountSnapshot(seat)
    hashedGuess.className = 'u_overlay_not-the-vendor-class'
    mountSnapshot(document.body)
    attach()
    expect(header.classList.contains(RAISED)).toBe(false)
    expect(document.querySelectorAll('.' + RAISED)).toHaveLength(0)
  })

  it('leaves separate shell/right-panel/browser surfaces and their styles untouched', () => {
    const main = mountConversation()
    mountSnapshot(main.seat)
    const shell = document.createElement('div')
    shell.setAttribute('data-shell-overlay', '')
    shell.style.cssText = 'position:absolute;z-index:20;pointer-events:none'
    const right = document.createElement('div')
    right.setAttribute('data-sidebar-right-panel', 'fullscreen')
    right.style.cssText = 'position:fixed;z-index:40'
    const iframe = document.createElement('iframe')
    right.append(iframe)
    document.body.append(shell, right)
    const shellConversation = mountConversation()
    shell.append(shellConversation.root)
    mountSnapshot(shellConversation.seat)
    const rightConversation = mountConversation()
    right.append(rightConversation.root)
    mountSnapshot(rightConversation.seat)
    const shellStyle = shell.getAttribute('style')
    const rightStyle = right.getAttribute('style')
    attach()
    expect(main.header.classList.contains(RAISED)).toBe(true)
    expect(main.titleRow.classList.contains(UNCONTAINED)).toBe(true)
    expect(shellConversation.header.classList.contains(RAISED)).toBe(false)
    expect(rightConversation.header.classList.contains(RAISED)).toBe(false)
    expect(shellConversation.titleRow.classList.contains(UNCONTAINED)).toBe(false)
    expect(rightConversation.titleRow.classList.contains(UNCONTAINED)).toBe(false)
    expect(shell.getAttribute('style')).toBe(shellStyle)
    expect(right.getAttribute('style')).toBe(rightStyle)
    expect(iframe.parentElement).toBe(right)
    expect(iframe.className).toBe('')
  })

  it('disconnects before queued mutations can reacquire a disposed class', async () => {
    const { header, seat } = mountConversation()
    const observer = attach()
    mountSnapshot(seat)
    observer.detach()
    await settle()
    expect(header.classList.contains(RAISED)).toBe(false)
  })
})
