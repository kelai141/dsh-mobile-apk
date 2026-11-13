// @vitest-environment jsdom
// FX1-C（0.14.2）：全局主面板（左侧栏「插件」项）没有返回键、没有深度层级、进去出不来。
//
// 用户原话（2026-09-27）：「这个左侧菜单栏里的新增选项没有返回键，没有深度层级，点进去就出不来」；
// 随后又追问「你关闭键呢」（插件页页头确实没有任何返回/关闭控件）。
//
// 真因两头都存在，本文件各守一条：
//   ① 上游 ui-plugin-manager 把插件页挂成 main 主面板（ctx.layout.selectPanel("plugins")），
//      它不是 [role=dialog]，BackStackSignal 观测不到 → 系统返回键被壳侧判为「无层」→ 直接退出应用；
//   ② 该页列表根层级只画 pageHead（标题/刷新/添加插件），没有返回控件。
//
// 判据（每条都配反证；反证 = 把旧形态改回去必须判红）：
//   A. back-stack 新增 main-panel 层，判据取自 layout 服务的 activePanelId（稳定事实，非本地化文案）；
//      conversation（activePanelId === null）上必须**不**产生该层 —— 壳侧仍须 finish activity。
//   B. 该层按「页面自己的控件」退：先退一层详情（上游 DetailTop 的 crumb），再走注入的返回键。
//   C. 注入的返回控件只在手机形态、只在列表根层级出现；详情层已有 crumb 时不重复造。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BackStackSignal } from '../src/client/mobile/back-stack.ts'
import {
  MainPanelBackMount,
  MAIN_PANEL_BACK_ATTR,
  MAIN_PANEL_HEAD_ATTR,
  MAIN_PANEL_OPEN_ATTR,
  PANEL_DETAIL_SELECTORS,
} from '../src/client/mobile/main-panel-back.ts'
import { MAIN_PANEL_BACK_CSS } from '../src/client/mobile/main-panel-back.css.ts'

/** Deliver the pending MutationObserver batch (jsdom delivers it as a microtask). */
function flush(): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, 0) })
}

function setPhoneForm(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-dsh-mobile-form', '')
  else document.documentElement.removeAttribute('data-dsh-mobile-form')
}

/**
 * The plugin-manager page, in the shape upstream actually renders.
 *
 * Upstream nests the head: `section[data-plugin-panel] > div[data-plugin-body] >
 * div[data-plugin-bar] > header[data-window-drag]`. The fixture used to put the head
 * directly under the panel — a shape upstream never had — which is why the control
 * looked mounted here while the device showed no back button at all.
 *
 * @param level - which level the page presents: the list root, one detail level with its
 *   crumb, or the "更多" sub-view whose head has a crumb but no section title.
 */
function buildPanel(level: 'list' | 'detail' | 'more' = 'list'): HTMLElement {
  const panel = document.createElement('section')
  panel.setAttribute('data-plugin-panel', '')
  if (level === 'more') {
    // moreHead: a direct child, carries its own crumb, and no `data-plugin-header-part`.
    const moreHead = document.createElement('header')
    moreHead.setAttribute('data-window-drag', '')
    const back = document.createElement('button')
    back.setAttribute('aria-label', '返回插件列表')
    const title = document.createElement('h1')
    title.textContent = '实验性插件'
    moreHead.append(back, title)
    panel.appendChild(moreHead)
    document.body.appendChild(panel)
    return panel
  }
  const body = document.createElement('div')
  body.setAttribute('data-plugin-body', '')
  const bar = document.createElement('div')
  bar.setAttribute('data-plugin-bar', '')
  const head = document.createElement('header')
  head.setAttribute('data-window-drag', '')
  const heading = document.createElement('div')
  const title = document.createElement('h1')
  title.setAttribute('data-plugin-header-part', 'title')
  title.textContent = '插件'
  heading.appendChild(title)
  const toolbar = document.createElement('div')
  const refresh = document.createElement('button')
  refresh.setAttribute('aria-label', '刷新')
  const add = document.createElement('button')
  add.textContent = '添加插件'
  toolbar.append(refresh, add)
  head.append(heading, toolbar)
  bar.appendChild(head)
  body.appendChild(bar)
  panel.appendChild(body)
  if (level === 'detail') {
    const detail = document.createElement('div')
    detail.setAttribute('data-plugin-detail', '@scope/pkg')
    const top = document.createElement('div')
    const crumb = document.createElement('button')
    crumb.className = 'X_page_crumb'
    crumb.setAttribute('aria-label', '返回插件列表')
    top.appendChild(crumb)
    detail.appendChild(top)
    panel.appendChild(detail)
  }
  document.body.appendChild(panel)
  return panel
}

/** The head our control must land in, resolved the way upstream nests it. */
function pageHead(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-plugin-bar] > header[data-window-drag]')
}

/**
 * A BackStackSignal whose layout service reports the given panel selection.
 * @param panelId - the selected main panel, or null for the Conversation.
 * @param toggleSidebar - the drawer toggle spy.
 * @param leaveMainPanel - the panel-leave spy (the list root has no control of its own).
 */
function buildSignal(
  panelId: string | null,
  toggleSidebar = vi.fn(),
  leaveMainPanel = vi.fn(),
): BackStackSignal {
  return new BackStackSignal({ toggleSidebar, activePanelId: () => panelId, leaveMainPanel })
}

let signal: BackStackSignal | null = null
let mount: MainPanelBackMount | null = null

beforeEach(() => {
  document.body.innerHTML = ''
  setPhoneForm(false)
  signal = null
  mount = null
})

afterEach(() => {
  signal?.detach()
  mount?.detach()
  delete window.dshBackBridge
})

describe('A. main-panel 层（系统返回键）', () => {
  it('插件页在场时贡献 main-panel 层，且系统返回键能通过页面自己的控件退出', async () => {
    setPhoneForm(true)
    buildPanel('list')
    const toggleSidebar = vi.fn()
    const leaveMainPanel = vi.fn()
    signal = buildSignal('plugins', toggleSidebar, leaveMainPanel)
    signal.attach()
    await flush()
    expect(window.__dshBackKinds).toEqual(['main-panel'])
    expect(window.__dshBackDepth).toBe(1)
    expect(window.__dshBack?.()).toBe(true)
    // 列表根层级上游没有控件，所以退的是 layout 服务自己的面板选择（与侧栏行同一动作）。
    expect(leaveMainPanel).toHaveBeenCalledTimes(1)
    // 反证：这一层不是靠侧栏开关关掉的（关侧栏 ≠ 退出主面板）。
    expect(toggleSidebar).not.toHaveBeenCalled()
  })

  it('反证：conversation（activePanelId === null）上不得产生该层 —— 返回键必须继续 finish activity', async () => {
    setPhoneForm(true)
    buildPanel('list')
    signal = buildSignal(null)
    signal.attach()
    await flush()
    // 壳侧把「无层」判为 FINISH_ACTIVITY（BackGate），所以这里必须是 0。
    expect(window.__dshBackKinds).toEqual([])
    expect(window.__dshBackDepth).toBe(0)
    expect(window.__dshBack?.()).toBe(false)
  })

  it('反证：没有插件页 DOM 但主面板仍被选中时，层仍计数不消费（不得退出应用）', async () => {
    setPhoneForm(true)
    const leaveMainPanel = vi.fn()
    signal = buildSignal('plugins', vi.fn(), leaveMainPanel)
    signal.attach()
    await flush()
    expect(window.__dshBackKinds).toEqual(['main-panel'])
    // 页面 DOM 不在场时仍以服务为准退出：消费按键且不落回壳侧。
    expect(window.__dshBack?.()).toBe(true)
    expect(leaveMainPanel).toHaveBeenCalledTimes(1)
    await flush()
    expect(window.__dshBackKinds).toEqual(['main-panel'])
  })

  it('B. 详情层优先走页面自己的 crumb（先退一层详情，不是直接回会话）', async () => {
    setPhoneForm(true)
    buildPanel('detail')
    signal = buildSignal('plugins')
    signal.attach()
    await flush()
    const crumb = document.querySelector('[data-plugin-detail] button') as HTMLElement
    const seen: string[] = []
    crumb.addEventListener('click', () => { seen.push('click') })
    expect(window.__dshBackKinds).toEqual(['main-panel'])
    expect(window.__dshBack?.()).toBe(true)
    expect(seen).toEqual(['click'])
  })

  it('层序：抽屉在下、main-panel 在上（面板盖住抽屉），返回键先退面板', async () => {
    setPhoneForm(true)
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    document.body.appendChild(frame)
    buildPanel('list')
    mount = new MainPanelBackMount(() => {})
    mount.attach()
    await flush()
    signal = buildSignal('plugins')
    signal.attach()
    await flush()
    expect(window.__dshBackKinds).toEqual(['drawer', 'main-panel'])
  })

  it('反证色：层判据不是本地化文案 —— 换语言不影响该层', async () => {
    setPhoneForm(true)
    buildPanel('list')
    document.documentElement.lang = 'en'
    signal = buildSignal('plugins')
    signal.attach()
    await flush()
    expect(window.__dshBackKinds).toEqual(['main-panel'])
  })
})

describe('C. 注入的可见返回控件', () => {
  it('只在手机形态、只在列表根层级注入，且插在页头最前', async () => {
    setPhoneForm(false)
    buildPanel('list')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    // 反证：桌面形态不注入（这是手机版式的补偿）。
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).toBeNull()

    setPhoneForm(true)
    await flush()
    const button = document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')
    expect(button).not.toBeNull()
    const head = pageHead()
    expect(head?.firstElementChild).toBe(button)
    // 页头被打了标记：样式表只认属性，不重述结构（否则上游再挪一层就静默失效）。
    expect(head?.hasAttribute(MAIN_PANEL_HEAD_ATTR)).toBe(true)
  })

  it('反证：详情层已有上游 crumb 时不得重复造返回键', async () => {
    setPhoneForm(true)
    buildPanel('detail')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    // 上游 DetailTop 的 crumb 是那一层的权威控件（back-stack 也走它）。
    expect(document.querySelector('[data-plugin-panel] [data-plugin-detail] button')).not.toBeNull()
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).toBeNull()
  })

  it('点击走 layout.selectPanel(null)（回会话），且不触发默认行为', async () => {
    setPhoneForm(true)
    buildPanel('list')
    const leave = vi.fn()
    mount = new MainPanelBackMount(leave)
    mount.attach()
    await flush()
    const button = document.querySelector<HTMLButtonElement>('[' + MAIN_PANEL_BACK_ATTR + ']')!
    button.click()
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('自愈：React 把它摘掉之后必须重新插回（同一次 attach 内）', async () => {
    setPhoneForm(true)
    buildPanel('list')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    const first = document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')
    expect(first).not.toBeNull()
    // 模拟 React 提交时丢掉外部插入的节点。
    first!.remove()
    await flush()
    const second = document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it('自愈：面板整棵重挂后，控件跟着新页头走', async () => {
    setPhoneForm(true)
    buildPanel('list')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    document.querySelector('[data-plugin-panel]')!.remove()
    await flush()
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).toBeNull()
    buildPanel('list')
    await flush()
    const button = document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')
    expect(button).not.toBeNull()
    expect(pageHead()?.firstElementChild).toBe(button)
  })

  it('detach 撤掉控件与观察者（热卸载不留孤儿）', async () => {
    setPhoneForm(true)
    buildPanel('list')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).not.toBeNull()
    mount.detach()
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).toBeNull()
    // 反证：detach 之后新的面板不得再被注入。
    buildPanel('list')
    await flush()
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).toBeNull()
  })

  it('控件是真实可点、可聚焦的 button，且有可访问名', async () => {
    setPhoneForm(true)
    buildPanel('list')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    const button = document.querySelector<HTMLButtonElement>('[' + MAIN_PANEL_BACK_ATTR + ']')!
    expect(button.tagName).toBe('BUTTON')
    expect(button.type).toBe('button')
    expect(button.getAttribute('aria-label')).toBeTruthy()
  })
})

describe('C2. 页头在嵌套结构里（2026-11-13 用户实报：插件页左上角只有抽屉开关）', () => {
  it('页头不是面板直接子节点时也必须挂上（`:scope > header` 那条老判据在这里恒空）', async () => {
    setPhoneForm(true)
    buildPanel('list')
    const head = pageHead()!
    // 反证：这条正是老判据，它在这个结构上取不到任何东西 —— 控件当年因此从未挂上。
    expect(document.querySelector('[data-plugin-panel] > header[data-window-drag]')).toBeNull()
    expect(head.parentElement?.hasAttribute('data-plugin-bar')).toBe(true)
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).not.toBeNull()
    expect(head.firstElementChild).toBe(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']'))
  })

  it('反证：「更多」子视图的页头有自己的 crumb、且没有分区标题 —— 不得重复造返回键', async () => {
    setPhoneForm(true)
    buildPanel('more')
    // 它确实是 panel 的直接子 header：这正是老判据唯一能命中的那个页头。
    expect(document.querySelector('[data-plugin-panel] > header[data-window-drag]')).not.toBeNull()
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).toBeNull()
  })

  it('面板在屏时给 frame 打上「主面板占屏」标记，离屏时撤销（抽屉开关据此让位）', async () => {
    setPhoneForm(true)
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    const leading = document.createElement('div')
    leading.setAttribute('data-shell-leading', '')
    const opener = document.createElement('button')
    opener.setAttribute('data-sidebar-opener', '')
    leading.appendChild(opener)
    frame.appendChild(leading)
    document.body.appendChild(frame)
    buildPanel('list')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    expect(frame.hasAttribute(MAIN_PANEL_OPEN_ATTR)).toBe(true)
    // 面板离屏（React 卸载）后标记必须撤掉，否则会话页也拿不到抽屉开关。
    document.querySelector('[data-plugin-panel]')!.remove()
    await flush()
    expect(frame.hasAttribute(MAIN_PANEL_OPEN_ATTR)).toBe(false)
    expect(document.querySelector('[' + MAIN_PANEL_BACK_ATTR + ']')).toBeNull()
  })

  it('反证：桌面形态不打标记（抽屉开关只在手机版式让位）', async () => {
    setPhoneForm(false)
    const frame = document.createElement('div')
    frame.setAttribute('data-dsh-frame', '')
    document.body.appendChild(frame)
    buildPanel('list')
    mount = new MainPanelBackMount(vi.fn())
    mount.attach()
    await flush()
    expect(frame.hasAttribute(MAIN_PANEL_OPEN_ATTR)).toBe(false)
  })
})

describe('D. 判据与样式面（机器可判）', () => {
  const src = (...parts: string[]): string => join(process.cwd(), 'src', 'client', ...parts)
  /** Strip comments so prose cannot satisfy a code assertion. */
  const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('back-stack 的层判据取自 layout 服务，而不是本地化文案或 hashed class', () => {
    const source = code(readFileSync(src('mobile', 'back-stack.ts'), 'utf8'))
    expect(source).toContain("| 'main-panel'")
    expect(source).toContain('activePanelId')
    // 反证：不得用插件页的本地化标题当判据（换语言即失效）。
    expect(source).not.toContain('插件列表')
    expect(source).not.toContain("'插件'")
  })

  it('index.ts 把 activePanelId 接到 back-stack，并在主面板切换时主动 reconcile', () => {
    const source = code(readFileSync(src('index.ts'), 'utf8'))
    expect(source).toContain('activePanelId: () => ctx.layout.panelInfo.getSnapshot().activePanelId')
    // 该事实在服务里而非 DOM 里，所以必须订阅它（否则切换面板不会立刻反映到层栈）。
    expect(source).toContain('ctx.layout.panelInfo.subscribe')
    expect(source).toContain('backStack.refresh()')
  })

  it('退出走 layout.selectPanel(null)，不凭空改页面 store', () => {
    const source = code(readFileSync(src('index.ts'), 'utf8'))
    expect(source).toContain('ctx.layout.selectPanel(null)')
  })

  it('进面板时把手机抽屉放下（否则 289px 抽屉盖住返回控件，用户点不到）', () => {
    const source = code(readFileSync(src('index.ts'), 'utf8'))
    expect(source).toContain('new PanelNavDrawer(')
    expect(source).toContain('drawer.sync()')
    // 反证：必须是「进面板那一次」而不是无条件收起（后者会把用户自己拉开的抽屉顶掉）。
    expect(source).not.toMatch(/subscribe\(\(\) => \{\s*ctx\.layout\.toggleSidebar\(\)/)
  })

  it('样式只在手机形态生效，且不动上游页头自身的内边距', () => {
    const css = MAIN_PANEL_BACK_CSS
    expect(css).toContain('@media (max-width: 767px)')
    expect(css).toContain('html[data-dsh-mobile-form] [data-dsh-main-panel-back]')
    // 反证：不得改上游 .pageHead 的 padding（那是页头自己的顶距）。
    expect(css).not.toMatch(/header\[data-window-drag\]\s*\{[^}]*padding-top/)
  })

  it('样式按页头标记生效，不重述「页头是面板直接子节点」这个结构', () => {
    // 页头实际嵌在 pageBody > pageBar 里，子选择器匹配不到；标记由 JS 打在真正的页头上。
    expect(MAIN_PANEL_BACK_CSS).toContain('[data-dsh-main-panel-head]')
    expect(MAIN_PANEL_BACK_CSS).not.toContain('[data-plugin-panel] > header')
  })

  it('抽屉开关让位的判据与注入模块共用同一个属性（两处不许各写一个名字）', () => {
    const formCss = code(readFileSync(src('mobile', 'mobile-form.css.ts'), 'utf8'))
    expect(formCss).toContain('[data-dsh-main-panel-open]')
    const mountSource = code(readFileSync(src('mobile', 'main-panel-back.ts'), 'utf8'))
    expect(mountSource).toContain("MAIN_PANEL_OPEN_ATTR = 'data-dsh-main-panel-open'")
    expect(formCss).toContain('data-dsh-main-panel-open')
  })

  it('详情层选择器与 back-stack 共用同一组（两处不许漂移）', async () => {
    const stackSource = code(readFileSync(src('mobile', 'back-stack.ts'), 'utf8'))
    for (const selector of PANEL_DETAIL_SELECTORS) {
      expect(stackSource).toContain(selector)
      // 反证：选择器取自上游明确属性，不是 hashed class。
      expect(selector.startsWith('[data-plugin-')).toBe(true)
    }
  })
})
