import type { IncomingDraftRuntime } from './incoming-draft.ts'

/** Service faces reflect rc.2: Sessions owns identities; uiWorkspace owns visible navigation. */
interface RuntimeServices {
  sessions(): { refresh(): Promise<void>; scope(id: unknown): unknown | undefined; retain?(id: unknown, options: { source: string }): { ready: Promise<unknown>; release(): void } }
  workspaces(): { create(input: { path: string }): Promise<{ workspaceId: unknown }> }
  uiWorkspace(): { connectWorkspace(id: unknown): Promise<unknown>; openSession(id: unknown): void }
  conversation(): {
    addFiles?(id: unknown, files: readonly File[]): boolean
    createDrafts?(id: unknown, files: readonly File[], uploadImages: boolean): readonly { id: string }[]
    releaseDraftAttachment?(id: string): void
    input: { for(scope: unknown): { notify(level: 'info' | 'error', text: string): void; addAttachments?(ids: readonly string[]): boolean; state?: { getSnapshot(): { attachmentIds?: readonly string[] }; subscribe(listener: () => void): () => void } } }
  }
}

/** Transfer one exact retained Session to its attachment rail, shared by import and send rollback. */
export function keepDraftReference(
  reference: { release(): void },
  state: { getSnapshot?(): { attachmentIds?: readonly string[] } | undefined; subscribe?(listener: () => void): () => void } | undefined,
  owners: Set<() => void>,
): boolean {
  if (state?.subscribe === undefined || (state.getSnapshot?.()?.attachmentIds?.length ?? 0) === 0) return false
  let released = false, unsubscribe: (() => void) | undefined
  const drop = () => {
    if (released) return
    released = true; unsubscribe?.(); owners.delete(drop); reference.release()
  }
  const inspect = () => { if ((state.getSnapshot?.()?.attachmentIds?.length ?? 0) === 0) drop() }
  owners.add(drop)
  unsubscribe = state.subscribe(inspect)
  inspect()
  return true
}

/** Resolve each root service at use time, after Cordis has materialized its scoped face. */
export function createIncomingDraftRuntime(services: RuntimeServices): IncomingDraftRuntime {
  const { sessions, workspaces, uiWorkspace, conversation } = services
  const heldDrafts = new Set<() => void>()
  return {
  dispose: () => { for (const drop of [...heldDrafts]) drop() },
  refreshSessions: () => sessions().refresh(),
  retainSession: async id => {
    const reference = sessions().retain?.(id, { source: 'workspaceOperation' })
    if (reference === undefined) return () => {}
    let timer: number | undefined
    try {
      await Promise.race([
        reference.ready,
        new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => reject(new Error('session-not-ready')), 4000) }),
      ])
      let handedOff = false
      return () => {
        if (handedOff) return
        handedOff = true
        const scope = sessions().scope(id)
        const state = scope === undefined ? undefined : conversation().input.for(scope).state
        if (!keepDraftReference(reference, state, heldDrafts)) reference.release()
      }
    } catch (error) { reference.release(); throw error }
    finally { window.clearTimeout(timer) }
  },
  createSession: async (cwd) => {
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-create')
    const workspace = await workspaces().create({ path: cwd })
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-created')
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-connect')
    const sessionId = await uiWorkspace().connectWorkspace(workspace.workspaceId)
    document.documentElement.setAttribute('data-dsh-incoming-draft-poll', 'workspace-connected')
    return String(sessionId)
  },
  openSession: (sessionId) => { uiWorkspace().openSession(sessionId) },
  sessionScope: (sessionId) => sessions().scope(sessionId),
  attachGenericFile: (sessionId, file) => {
    try {
      const face = conversation()
      // Public rc.1 admission path; retain the patched addFiles seam only for older snapshots.
      if (face.createDrafts === undefined) return face.addFiles?.(sessionId, [file]) ?? false
      const scope = sessions().scope(sessionId)
      if (scope === undefined) return false
      const drafts = face.createDrafts(sessionId, [file], true)
      const admitted = face.input.for(scope).addAttachments?.(drafts.map(d => d.id)) === true
      if (!admitted) for (const draft of drafts) face.releaseDraftAttachment?.(draft.id)
      return admitted
    } catch {
      // The target can be released between session navigation and draft admission.
      return false
    }
  },
  notify: (scope, text) => {
    try { conversation().input.for(scope).notify('error', text) } catch { /* target scope ended */ }
  },
  }
}
