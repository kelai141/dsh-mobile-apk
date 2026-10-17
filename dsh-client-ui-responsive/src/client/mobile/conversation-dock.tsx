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
    id: ID, kind: 'conversation', patterns: [PREFIX + '**'], priority: 'extension',
    canOpen: address => conversationTarget(address) !== undefined,
    title: address => {
      const target = conversationTarget(address)
      const snapshot = ctx.sessions.list.getSnapshot()
      if (target !== undefined && typeof target !== 'string') {
        const label = snapshot.projectionsBySession[target.parentSessionId]?.values.subagentCatalog?.find(entry => entry.id === target.childSessionId)?.label
        if (label) return label
      }
      const id = conversationId(address)
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
        // 0.2.1-rc.2：目录条目的 mode 新增 'external'（外部创建的子代理任务）。它不是 durable 子代理地址
        // （SubagentAddress.mode 不含 'external'，上游 manager/service 均显式跳过它），但仍是一个真实会话 id
        // ⇒ 以纯 SessionId 打开，不构造 parent+mode 地址。
        if (node === row) match = entry.mode === 'external'
          ? entry.id
          : { parentSessionId: parent, childSessionId: entry.id, mode: entry.mode }
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
      this.zone.textContent = '松开于侧边栏打开'
      document.body.append(this.zone)
    }
    this.zone.toggleAttribute('data-over', over)
    const label = '松开于侧边栏打开'
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
/* Frost lives only in the edge, never on the reading or composing surface. */
[data-sidebar-right-panel][data-sidebar-right-open]::after {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 12px; z-index: 45;
  pointer-events: none; border: 0;
  background: linear-gradient(to right, rgba(117,167,255,.045), transparent);
  -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
  -webkit-mask-image: linear-gradient(to right, #000, transparent);
  mask-image: linear-gradient(to right, #000, transparent);
}
[data-sidebar-right-open] [data-dockkit-divider]::before {
  background: rgba(117,167,255,.12); box-shadow: 0 0 8px rgba(94,158,255,.06);
}
html[data-dsh-sidebar-reorder] [role=treeitem] { user-select: none; -webkit-user-select: none; }
/* Portrait preserves the dock tree and native tab actions. Only the active
   pane body occupies the full second row; both groups of tabs remain reachable. */
@media (max-width: 767px) {
  [data-sidebar-right-panel] [data-dockkit-split] {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
    grid-template-rows: auto minmax(0, 1fr);
  }
  [data-sidebar-right-panel] [data-dockkit-split] > [data-dockkit-host='dock']:not([hidden]),
  [data-sidebar-right-panel] [data-dockkit-split] > [data-dockkit-host='dock']:not([hidden]) > section { display: contents; }
  [data-sidebar-right-panel] [data-dockkit-split] [class*='tabHostHeader'] { grid-row: 1; min-width: 0; pointer-events: auto; }
  [data-sidebar-right-panel] [data-dockkit-split] [data-dockkit-column='0'] > [class*='tabHostHeader'] { grid-column: 1; }
  [data-sidebar-right-panel] [data-dockkit-split] [data-dockkit-column='1'] > [class*='tabHostHeader'] { grid-column: 2; }
  [data-sidebar-right-panel] [data-dockkit-split] [class*='tabHostBody'] { grid-row: 2; grid-column: 1 / -1; min-height: 0; pointer-events: auto; }
  [data-sidebar-right-panel] [data-dockkit-split] section:not([data-dockkit-pane-active]) > [class*='tabHostBody'],
  [data-sidebar-right-panel] [data-dockkit-split] > [data-dockkit-divider] { display: none; }
}
@media (prefers-reduced-motion: reduce) { .dsh-conversation-drop-zone, .dsh-conversation-drop-zone::before { transition: none; animation: none; } }
`
