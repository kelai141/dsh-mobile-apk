/**
 * 注入层观察者的测试夹具（三个扫描预算 spec 共用）。
 *
 * 为什么需要共用：boot 面观察者是**一起**挂上的，谁漏 detach 谁就污染同一文件的后续用例
 * （实测：构造过程中抛异常会让已 attach 的观察者留在文档上，下一用例多读到 50 次查询）。
 * 所以这里的 attach 一律带失败回滚，且把 jsdom 缺的 `ResizeObserver` 显式补上。
 */

/** jsdom 没有 ResizeObserver；composer-popup-guard 在字段初始化器里就 new 了它。 */
export function installResizeObserverStub(): void {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

/** 已挂载观察者的最小契约。 */
interface Attachable {
  detach(): void
}

/**
 * 挂上 boot 时无条件自动挂载的全部观察者。
 *
 * 任何一步抛异常都会把已经挂上的逐个 detach 再抛：否则异常用例会把观察者漏给下一个用例。
 * @returns 逐个 detach 的函数（幂等）。
 */
export async function attachBootObservers(): Promise<() => void> {
  const { BackStackSignal } = await import('../src/client/mobile/back-stack.ts')
  const { ComposerPopupGuard } = await import('../src/client/composer-popup-guard.ts')
  const { TopBarFold } = await import('../src/client/mobile/top-bar-fold.ts')
  const { MobileFormMarker } = await import('../src/client/mobile/form-marker.ts')
  const { SessionLogDialogObserver } = await import('../src/client/session-log-dialog-observer.ts')
  const { SnapshotPanelsObserver } = await import('../src/client/snapshot-panels-observer.ts')
  const { TrajectoryPanelsObserver } = await import('../src/client/trajectory-panels-observer.ts')
  const { FileCardCapsule } = await import('../src/client/mobile/file-card-actions.ts')
  const { DrawerOverlayDismiss } = await import('../src/client/mobile/drawer-overlay-dismiss.ts')
  const { MobileSettingsNav } = await import('../src/client/mobile/settings-nav.ts')
  const { MainPanelBackMount } = await import('../src/client/mobile/main-panel-back.ts')

  const handles: Attachable[] = []
  const dispose = (): void => { for (const handle of handles) handle.detach() }
  try {
    const back = new BackStackSignal({ toggleSidebar: () => {}, activePanelId: () => null, leaveMainPanel: () => {} })
    back.attach(); handles.push(back)
    const guard = new ComposerPopupGuard()
    guard.attach(); handles.push(guard)
    const fold = new TopBarFold()
    fold.attach(); handles.push(fold)
    const marker = new MobileFormMarker()
    marker.attach(); handles.push(marker)
    const sessionLog = new SessionLogDialogObserver()
    sessionLog.attach(); handles.push(sessionLog)
    const snapshot = new SnapshotPanelsObserver()
    snapshot.attach(); handles.push(snapshot)
    const trajectory = new TrajectoryPanelsObserver(null)
    trajectory.attach(); handles.push(trajectory)
    const capsule = new FileCardCapsule(() => ({ openFileExternal: undefined, shareFile: undefined }), {
      external: () => '', share: () => '', failure: () => '',
    })
    capsule.attach(); handles.push(capsule)
    const dismiss = new DrawerOverlayDismiss({ mobileForm: () => true })
    dismiss.attach(); handles.push(dismiss)
    const nav = new MobileSettingsNav()
    nav.attach(); handles.push(nav)
    const panelBack = new MainPanelBackMount(() => {})
    panelBack.attach(); handles.push(panelBack)
  } catch (error) {
    dispose()
    throw error
  }
  return dispose
}

/**
 * 造一个手机竖屏的会话页：顶栏（含 leading 座位）+ frame + 正文 N 段 + 输入卡。
 * @param paragraphs - 正文段数（会话长度的量纲）。
 * @returns 正文容器，流式提交往它里面追加。
 */
export function buildConversation(paragraphs: number): HTMLElement {
  document.body.innerHTML = ''
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  const header = document.createElement('header')
  const leading = document.createElement('div')
  leading.setAttribute('data-conversation-header-leading', '')
  header.appendChild(leading)
  document.body.appendChild(header)
  const frameRoot = document.createElement('div')
  frameRoot.setAttribute('data-dsh-frame', '')
  frameRoot.setAttribute('data-sidebar-collapsed', '')
  document.body.appendChild(frameRoot)
  const conversation = document.createElement('div')
  conversation.setAttribute('data-conversation', '')
  frameRoot.appendChild(conversation)
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  conversation.appendChild(card)
  for (let index = 0; index < paragraphs; index++) {
    const line = document.createElement('p')
    line.textContent = 'line ' + String(index)
    conversation.appendChild(line)
  }
  return conversation
}
