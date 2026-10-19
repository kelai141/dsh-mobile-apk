/** Conversation docking reuses the product's resource, Session and dock lifetimes. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime, PropsRenderSlots, PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const ID = '@dsh-android/conversation-dock'
const PREFIX = 'dsh-resource://conversation/session/'

export type DockSessionTarget = Parameters<Context['sessions']['retain']>[0]

interface ChatResource { readonly reference: SessionReference }

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { conversationDock: unknown }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { conversation: ChatResource }
  interface SlotMap {
    'android.dock.conversation': { kind: 'single'; scope: 'session' }
  }
}

export function conversationAddress(target: DockSessionTarget): string {
  if (typeof target === 'string') return PREFIX + encodeURIComponent(target)
  return PREFIX + encodeURIComponent(target.childSessionId)
    + '?parent=' + encodeURIComponent(target.parentSessionId) + '&mode=' + target.mode
}
export function conversationId(address: string): SessionId | undefined {
  if (!address.startsWith(PREFIX)) return undefined
  try {
    const id = decodeURIComponent(address.slice(PREFIX.length).split('?')[0] ?? '')
    return id ? id as SessionId : undefined
  } catch { return undefined }
}
/** Child identity is independent of catalog mode/address spelling. Never duplicate a live child view. */
export function existingConversation(tabs: readonly { id: string; kind: string; contentId: string }[], target: DockSessionTarget): string | undefined {
  const id = typeof target === 'string' ? target : target.childSessionId
  return tabs.find(tab => (tab.kind === 'conversation' || tab.kind === 'subagentchat')
    && conversationId(tab.contentId.replace('dsh-resource://subagentchat/session/', PREFIX)) === id)?.id
}

/** Both the upstream child popover and the left drawer keep their own opening paths. */
export function retainDockIdentity(sidebar: Pick<Context['sidebarRight'], 'mounted' | 'tabsIn' | 'focus' | 'openResource'>): () => void {
  const original = sidebar.openResource
  const wrapped: typeof original = (...args) => {
    const [address] = args
    const id = conversationId(address.replace('dsh-resource://subagentchat/session/', PREFIX))
    const owner = sidebar.mounted.getSnapshot()
    const existing = id && owner ? existingConversation(sidebar.tabsIn(owner), id) : undefined
    if (existing) { sidebar.focus(existing as Parameters<typeof sidebar.focus>[0]); return }
    original.apply(sidebar, args)
  }
  sidebar.openResource = wrapped
  return () => { if (sidebar.openResource === wrapped) sidebar.openResource = original }
}

export function conversationTarget(address: string): DockSessionTarget | undefined {
  const id = conversationId(address)
  if (id === undefined) return undefined
  const query = address.indexOf('?')
  if (query < 0) return id
  const params = new URLSearchParams(address.slice(query + 1))
  const parent = params.get('parent'), mode = params.get('mode')
  if (!parent || (mode !== 'continuable' && mode !== 'one-shot' && mode !== 'unknown')) return undefined
  return { parentSessionId: parent as SessionId, childSessionId: id, mode }
}
function ChatViews(props: ConversationViewsProps) {
  return props.renderSlot('conversation.session', { view: 'chat' })
}
function ChatContent({ useSession, useConversation, renderFactorySlot }: PropsRuntime<'android.dock.conversation'> & PropsRenderFactories) {
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const active = conversation.activeTargets.size > 0 || !session.blank || session.running
  const settling = (session.openState === 'loading' && !active)
    || (session.subagent?.address.mode === 'continuable' && session.subagent.parentAvailable === undefined)
  const hero = !active && session.openState === 'open'
  return renderFactorySlot('conversation.content', {
    variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero,
  }, { slots: { views: ChatViews } })
}
function ChatTab({ useResource, useTabInfo, SessionProvider, renderSlot }: PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'android.dock.conversation'>) {
  const { tab } = useTabInfo()
  const resource = useResource<'conversation'>(tab.contentId)
  return <div data-sidebar-chat="" style={{ display: 'flex', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
    {resource.value === undefined ? <div role="status">{resource.status === 'failed' ? '对话加载失败，请关闭标签后重试' : '正在加载对话…'}</div>
      : <SessionProvider session={resource.value.reference}>{renderSlot('android.dock.conversation', {})}</SessionProvider>}
  </div>
}

export function registerConversationDock(ctx: Context): void {
  const provider: ResourceProvider<'conversation'> = {
    protocol: 'conversation',
    async *open(address, { signal }) {
      const target = conversationTarget(address)
      if (target === undefined) throw new Error('Invalid conversation address')
      if (signal.aborted) return
      const reference = ctx.sessions.retain(target, { source: 'conversationDock', signal })
      try {
        yield { ok: true, value: { reference } }
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      } finally { reference.release() }
    },
  }
  ctx.effect(() => ctx.resources.register(provider), 'ui-responsive: conversation resource')
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: ID, kind: 'conversation', keepMounted: true, patterns: [PREFIX + '**'], priority: 'extension',
    canOpen: address => conversationTarget(address) !== undefined,
    title: address => {
      const target = conversationTarget(address)
      const snapshot = ctx.sessions.list.getSnapshot()
      if (target !== undefined && typeof target !== 'string') {
        const label = snapshot.projectionsBySession[target.parentSessionId]?.values.subagentCatalog?.find(entry => entry.id === target.childSessionId)?.label
        if (label) return label
      }
      const id = conversationId(address)
      if (id !== undefined) {
        for (const projection of Object.values(snapshot.projectionsBySession)) {
          const label = projection?.values.subagentCatalog?.find(entry => entry.id === id)?.label
          if (label) return label
        }
      }
      return (id === undefined ? undefined : snapshot.byId[id]?.title) ?? '对话'
    },
  }), 'ui-responsive: conversation tab')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID,
    children: { 'android.dock.conversation': { kind: 'single', scope: 'session' } },
  }, ChatTab)), 'ui-responsive: conversation body')
  ctx.effect(() => ctx.slots.inject('android.dock.conversation', () => ctx.slots.register({
    name: 'android.dock.conversation',
  }, ChatContent)), 'ui-responsive: embedded conversation')
}

/** Resolve the visible catalog's complete preorder against authoritative projections.
 * Validate every label, depth and row count; never guess identity from a title.
 * No React fibers, global service monkeypatches, or main-session navigation. */
export function resolveDockSubagent(
  row: HTMLElement, sessions: Pick<Context['sessions'], 'list' | 'subagentAddress'>, current: SessionId | undefined,
): DockSessionTarget | undefined {
  if (current === undefined || row.hasAttribute('data-row-key')) return undefined
  const tree = row.closest('[role="tree"]')
  if (!tree) return undefined
  const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')]
  const snapshot = sessions.list.getSnapshot()
  const candidates: SessionId[] = []
  for (let id: SessionId | undefined = current; id !== undefined && !candidates.includes(id); id = sessions.subagentAddress(id)?.parentSessionId) candidates.push(id)
  let resolved: DockSessionTarget | undefined
  for (const root of candidates) {
    let cursor = 0, valid = true
    let match: DockSessionTarget | undefined
    const walk = (parent: SessionId, depth: number): void => {
      if (depth > 32) { valid = false; return }
      const entries = snapshot.projectionsBySession[parent]?.values.subagentCatalog ?? []
      for (const entry of entries) {
        const node = rows[cursor++]
        if (!node || Number(node.getAttribute('aria-level')) !== depth
          || node.querySelector('[class*="_label"]')?.textContent !== (entry.label ?? entry.id)
          || (node.getAttribute('aria-current') === 'true' && entry.id !== current)) { valid = false; return }
        // Older catalogs can still contain external entries even though rc.2 narrows the type.
        const mode: string = entry.mode
        if (node === row) {
          if (mode === 'external') match = entry.id
          else if (mode === 'unknown' || mode === 'one-shot' || mode === 'continuable') match = { parentSessionId: parent, childSessionId: entry.id, mode }
          else { valid = false; return }
        }
        if (node.getAttribute('aria-expanded') === 'true') walk(entry.id, depth + 1)
        if (!valid) return
      }
    }
    walk(root, 1)
    if (valid && cursor === rows.length && match !== undefined) {
      if (resolved !== undefined && JSON.stringify(resolved) !== JSON.stringify(match)) return undefined
      resolved = match
    }
  }
  return resolved
}

/** Kept as a fallback for hosts that have not supplied catalog resolution. */
export function subagentAside(row: HTMLElement): HTMLButtonElement | null {
  if (!row.matches('[role="treeitem"]')) return null
  return row.querySelector<HTMLButtonElement>('button[class*="sidebarButton"]')
}

export class ConversationDropZone {
  private zone: HTMLDivElement | undefined
  private readonly leaving = new Map<HTMLDivElement, number>()
  /** 两种文案：拖动已开始但尚未进入接收区 / 手指已进入接收区可松手。 */
  private static readonly LABELS = {
    idle: '拖到此处以在侧边栏打开',
    over: '松开于侧边栏打开',
  } as const
  constructor(
    private readonly open: (target: DockSessionTarget) => void,
    private readonly current: () => string | undefined = () => undefined,
    private readonly resolveChild?: (row: HTMLElement) => DockSessionTarget | undefined,
  ) {}
  accepts = (row: HTMLElement): boolean => {
    if (row.matches('[data-row-key^="session:"]')) return true
    if (this.resolveChild) return this.resolveChild(row) !== undefined
    return subagentAside(row) !== null || (row.matches('[role=treeitem][aria-current=true]') && this.current() !== undefined)
  }
  preview = (active: boolean, over: boolean): void => {
    if (!active) {
      const old = this.zone
      this.zone = undefined
      if (old) {
        old.setAttribute('data-leaving', '')
        const timer = window.setTimeout(() => { old.remove(); this.leaving.delete(old) }, window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 160)
        this.leaving.set(old, timer)
      }
      return
    }
    if (!this.zone) {
      this.clearLeaving()
      this.zone = document.createElement('div')
      this.zone.className = 'dsh-conversation-drop-zone'
      this.zone.setAttribute('role', 'status')
      this.zone.textContent = ConversationDropZone.LABELS.idle
      document.body.append(this.zone)
    }
    this.zone.toggleAttribute('data-over', over)
    // 文案必须跟着是否进入接收区切换：否则用户看到的永远是「松开」
    // （拖动已开始但手指还在列表上时也在喊松手）。
    const label = over ? ConversationDropZone.LABELS.over : ConversationDropZone.LABELS.idle
    if (this.zone.textContent !== label) this.zone.textContent = label
  }
  detach(): void {
    this.zone?.remove()
    this.zone = undefined
    this.clearLeaving()
  }
  private clearLeaving(): void {
    for (const [node, timer] of this.leaving) { window.clearTimeout(timer); node.remove() }
    this.leaving.clear()
  }
  drop = (row: HTMLElement): void => {
    if (!row.isConnected) return
    this.capture(row)()
  }
  capture = (row: HTMLElement): (() => void) => {
    const key = row.getAttribute('data-row-key')
    const id = key?.startsWith('session:') ? key.slice('session:'.length) : undefined
    if (id) return () => this.open(id as SessionId)
    else {
      if (this.resolveChild) {
        const target = this.resolveChild(row)
        return () => {
          row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
          if (target !== undefined) this.open(target)
        }
      }
      const button = subagentAside(row)
      if (button) return () => button.click()
      else if (row.matches('[aria-current=true]')) {
        const current = this.current()
        return () => {
          if (current) this.open(current as SessionId)
          row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        }
      }
    }
    return () => {}
  }
}
export const CONVERSATION_DOCK_CSS = `
.dsh-conversation-drop-zone {
  position: fixed; z-index: 2147483000; inset: 0 0 0 auto;
  width: 48px; box-sizing: border-box; border: 0; isolation: isolate;
  color: #fff; text-shadow: 0 1px 5px rgba(15,30,60,.28); writing-mode: vertical-rl;
  display: flex; align-items: center; justify-content: center; font-size: 12px;
  pointer-events: none; animation: dsh-dock-arrive 180ms ease-out both;
  transition: width 160ms ease, opacity 160ms ease, transform 160ms ease;
}
.dsh-conversation-drop-zone::before {
  content: ''; position: absolute; inset: 0 0 0 -48px; z-index: -1;
  background: linear-gradient(to left, rgba(108,164,255,.18), rgba(108,164,255,.07) 42%, transparent);
  -webkit-backdrop-filter: blur(5px); backdrop-filter: blur(5px);
  -webkit-mask-image: linear-gradient(to left, #000, transparent);
  mask-image: linear-gradient(to left, #000, transparent);
  opacity: .65; transition: opacity 160ms ease;
}
.dsh-conversation-drop-zone[data-over] { width: 56px; }
.dsh-conversation-drop-zone[data-over]::before { opacity: 1; }
.dsh-conversation-drop-zone[data-leaving] { animation: none; opacity: 0; transform: translateX(14px); }
@keyframes dsh-dock-arrive { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: translateX(0); } }
/* Touch owns long-press; native HTML drag and text selection must not cancel it. */
@media (pointer: coarse) {
  [data-row-key^='session:'], [data-row-key^='session:'] *,
  [role='treeitem']:not([data-row-key]), [role='treeitem']:not([data-row-key]) * {
    -webkit-user-select: none; user-select: none;
    -webkit-user-drag: none; -webkit-touch-callout: none;
  }
}
html[data-dsh-sidebar-reorder] [role=treeitem] { user-select: none; -webkit-user-select: none; }
@media (prefers-reduced-motion: reduce) { .dsh-conversation-drop-zone, .dsh-conversation-drop-zone::before { transition: none; animation: none; } }
`
