/**
 * 手机竖屏设置中心的容器层：**设置首页（分类）→ 二级页（可操作设置）**（0.14.7-B）。
 *
 * 为什么落在容器层：设置外壳是上游只读 checkout（`ui-settings-general/SettingsRoot`），而竖屏此前是
 * 「横向标签行 + 内容同屏」——宽标签会被裁掉（设备实测「手机控…」被截断），且一级分类与二级内容同屏
 * 互相挤占高度。上游 `settings.section` 注册项只投影 `id / order / label`
 * （`shell-contract.ts` 的 `SettingsSectionRow`），且这三个字段**一个也不在 DOM 上**：nav 行按钮里只有
 * `navIcon(row.id)` 与本行 label。因此分层只能由本容器实现，且**列表本身仍由上游按注册顺序渲染**——
 * 本模块不建列表、不排序、不隐藏任何注册项，只做三件事（全部可逆）：
 *   1. 在面板上写 `data-dsh-settings-level`，由 `mobile-settings.css.ts` 决定「看列表」还是「看内容」；
 *   2. 追加一个返回控件（首页 = 关设置，二级页 = 回首页）与二级页标题；
 *   3. 给我方自有分区的一级行补一行短说明（D4）。图标与 label 一律沿用上游既有渲染（上游
 *      `navIcon` 已对未知 id 降级通用齿轮）；未知/第三方 id 不加说明、不改文案（D5 降级）。
 *
 * 身份问题（为什么按 label 匹配）：DOM 里能看见的只有 label 文本。我方三个分区在 `index.ts` 里注册的
 * 是固定中文字面量（不经 locale），故以该字面量为键是当下唯一可用的身份通道；`settings-nav.spec.ts`
 * 直接读 `index.ts` 断言「表键 == 我方注册的 label」，两边漂移会当场变红。
 *
 * 未保存修改：分层只切 CSS 与属性，React 组件树从不卸载（首页隐藏的只是内容列的 `display`），
 * 故二级页里正在编辑的值、滚动位置与展开态在「返回首页 → 再进入」之间原样保留。
 *
 * 只作用于手机形态：`html[data-dsh-mobile-form]` 缺席时本模块不写任何东西，横屏布局与行为不变。
 */

/** 手机形态标记（`mobile/form-marker.ts` 写在 `<html>` 上，判据同上游 768px 断点）。 */
const MOBILE_FORM_ATTR = 'data-dsh-mobile-form'
/** 设置面板：面板自身没有稳定钩子，`form-marker` 按 nav/content 结构写在它上面。 */
const PANEL_SELECTOR = '[data-dsh-settings-dialog]'
/** 层级：由本模块写在面板上，CSS 据此切换「列表」与「内容」。 */
const LEVEL_ATTR = 'data-dsh-settings-level'
const LEVEL_HOME = 'home'
const LEVEL_DETAIL = 'detail'
/** 返回控件（首页 = 关设置，二级页 = 回首页）。 */
const BACK_ATTR = 'data-dsh-settings-back'
/** 顶部条：返回控件 +（二级页才显示的）分区标题 + 右侧占位。 */
const BAR_ATTR = 'data-dsh-settings-bar'
const BAR_TITLE_ATTR = 'data-dsh-settings-bar-title'
/** 一级行的短说明（只给我方自有分区）。 */
const DESC_ATTR = 'data-dsh-settings-nav-desc'
/** 一级行末端箭头：装饰元素，全部行都有（布局优化，不含任何文案）。 */
const CHEVRON_ATTR = 'data-dsh-settings-nav-chevron'
/** 一级行归属：`own` = 我方自有分区（带短说明），`other` = 上游/第三方（保持上游渲染）。 */
const ROW_ATTR = 'data-dsh-settings-nav'
/** 我方自有分区行的图标（替换上游对未知 id 的通用齿轮降级）；上游/第三方行没有这个节点。 */
const ICON_ATTR = 'data-dsh-settings-nav-icon'
/** 上游 nav 的两段结构（标题 + 列表）。面板没有稳定 class，只能按结构取，同 `form-marker`。 */
const NAV_LIST_SELECTOR = ':scope > nav > div:nth-child(2)'
/** nav 第一段 = 设置外壳自己的标题（`settings.header` 插槽），首页顶部条直接引用它。 */
const NAV_TITLE_SELECTOR = ':scope > nav > div:first-child'
/** 上游把 `aria-current="true"` 只写在当前选中的一级行上（`SettingsRoot.tsx`）。 */
const ACTIVE_ROW_SELECTOR = 'nav button[aria-current="true"]'

/**
 * 我方自有分区的「一行短说明」（D4），键 = `index.ts` 里注册的 label 字面量。
 *
 * 只登记我方自有一级分区；上游「通用设置 / 模型 / 内置插件 / 快照…」与第三方插件行一律不加说明、
 * 不改文案（D5）。表里少一个键 = 那一行按第三方处理（只保留上游 icon + label + 箭头），不是坏值。
 */
const OWN_SECTION_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  ['开发者选项', '控制台、日志与更新'],
  ['手机控制', '屏幕、虚拟屏与特权通道'],
  ['通知', '任务提醒与授权请求'],
  ['模型能力', '补齐第三方模型的思考档位'],
])

/**
 * 我方自有分区的图标，键同上表。
 *
 * 为什么需要它：上游 `navIcon(id)` 只认识 5 个内置 id，我方 id（`android-dev` 等）不认识 →
 * 三个分区全落到同一个通用齿轮，用户无法凭图标区分分类。
 *
 * 为什么是内联几何而不是 import：上游图标是 React 组件
 * （`IconCodeOutlineMedium: (props) => JSX.Element`），而本模块是纯 DOM 容器——
 * `createRoot` + `flushSync` 只为取三份静态标记既拖进 react-dom 运行时，又让
 * `@types/react-dom` 成为新依赖（本包只有 `@types/react`）。这里直接沿用上游
 * `IconCodeOutlineArtwork` 等同一份 `d`/viewBox 数据（上游 16x16、stroke 1.3 的中档图标），
 * 因此外观与上游图标逐像素一致，且不引入任何依赖、不新增 SVG 资产文件。
 *
 * 边界：**只装饰本表登记的 label**。上游内置 id 与第三方/未知行一律不碰——上游不认识
 * 的 id 继续用上游自己的齿轮降级，本表绝不按「凡是齿轮就替换」去猜。
 */
const OWN_SECTION_ICONS: ReadonlyMap<string, SectionIcon> = new Map([
  // IconCodeOutlineMedium：对应「控制台、日志与更新」。
  ['开发者选项', {
    viewBox: '0 0 16 16',
    paths: [
      'M6.27612 1.5L4.52612 14.5',
      'M11.4739 1.5L9.72388 14.5',
      'M2.39868 5.5H14.0681',
      'M1.93188 10.5H13.6013',
    ],
  }],
  // IconFullscreenOutlineMedium：对应「屏幕、虚拟屏与特权通道」。
  ['手机控制', {
    viewBox: '0 0 16 16',
    paths: [
      'M2.33154 9.40576V13.1685C2.3318 13.4444 2.55556 13.6685 2.83154 13.6685H6.49463V14.6685H2.83154C2.00328 14.6685 1.3318 13.9967 1.33154 13.1685V9.40576H2.33154ZM13.1685 1.33154C13.9964 1.33199 14.6683 2.00352 14.6685 2.83154V6.40576H13.6685V2.83154C13.6683 2.5558 13.4441 2.33199 13.1685 2.33154H9.49463V1.33154H13.1685Z',
      'M9.4292 6.57077L13.914 2.08594',
      'M6.57077 9.4292L2.08594 13.914',
    ],
    // 上游此图标首段是填充路径（`fill: currentColor`），其余为描边。
    filledFirstPath: true,
  }],
  // IconAlarmClockOutlineMedium：对应「任务提醒与授权请求」。
  ['通知', {
    viewBox: '0 0 17 17',
    paths: [
      'M4.09372 11.9895L3.11865 14.0387',
      'M12.1392 11.9895L13.1143 14.0387',
      'M8.11646 4.78442V8.03442L10.6165 9.53442',
      'M8.11646 13.4094C11.154 13.4094 13.6165 10.947 13.6165 7.90942C13.6165 4.87186 11.154 2.40942 8.11646 2.40942C5.07889 2.40942 2.61646 4.87186 2.61646 7.90942C2.61646 10.947 5.07889 13.4094 8.11646 13.4094Z',
      'M1.75952 4.74323C2.30657 3.65639 3.12646 2.73047 4.12926 2.05542',
      'M14.3345 4.74323C13.7874 3.65639 12.9675 2.73047 11.9647 2.05542',
    ],
  }],
  // IconSparkleMedium：对应「补齐第三方模型的思考档位」。选它而不是 IconThinkOutlineMedium，
  // 是因为本模块的 `sectionIcon` 只支持「**首段**填充、其余描边」，而 Think 图标的填充段在第三段
  // （其中心圆点 `fill: currentColor`），表达不了；Sparkle 三段全为描边，与本模块能力相符。
  ['模型能力', {
    viewBox: '0 0 16 16',
    paths: [
      'M5.875 3C5.875 6.33333 7.54167 8 10.875 8C7.54167 8 5.875 9.66667 5.875 13C5.875 9.66667 4.20833 8 0.875 8C4.20833 8 5.875 6.33333 5.875 3Z',
      'M12.375 1.55823C12.375 3.39156 13.2917 4.30823 15.125 4.30823C13.2917 4.30823 12.375 5.22489 12.375 7.05823C12.375 5.22489 11.4583 4.30823 9.625 4.30823C11.4583 4.30823 12.375 3.39156 12.375 1.55823Z',
      'M12.375 10.4418C12.375 11.7751 13.0417 12.4418 14.375 12.4418C13.0417 12.4418 12.375 13.1084 12.375 14.4418C12.375 13.1084 11.7083 12.4418 10.375 12.4418C11.7083 12.4418 12.375 11.7751 12.375 10.4418Z',
    ],
  }],
])

/** 一个内联图标的几何定义：viewBox、各 `path` 的 `d`，以及首段是否走上游的填充路径。 */
interface SectionIcon {
  viewBox: string
  paths: readonly string[]
  filledFirstPath?: boolean
}

/**
 * 画一个自有分区图标：几何取自上游 artwork（见 `OWN_SECTION_ICONS`），描边宽度同上游中档图标 1.3。
 *
 * @param icon - 该分区的 viewBox 与 path 数据。
 * @returns 一个 `aria-hidden` 的 `svg`（名称由上游 label 承担，图标不进可访问名）。
 */
function sectionIcon(icon: SectionIcon): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', icon.viewBox)
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  // 上游图标带 `className`（css.navIcon，仅 flex: none）；这里由样式表按属性定位，不需要类名。
  svg.setAttribute('stroke-width', '1.3')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  icon.paths.forEach((d, index) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    if (icon.filledFirstPath === true && index === 0) path.setAttribute('fill', 'currentColor')
    else path.setAttribute('stroke', 'currentColor')
    svg.appendChild(path)
  })
  return svg
}

/** 画一个描边箭头；自带 SVG，不把图标库拉进插件。 */
function strokeArrow(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 18 18')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.6')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/** 上游一级行的 label 文本（按钮里第一个非本模块添加的 `span`）。 */
function rowLabel(button: Element): string {
  const label = [...button.querySelectorAll(':scope > span')].find(
    node => !node.hasAttribute(DESC_ATTR) && !node.hasAttribute(CHEVRON_ATTR),
  )
  return (label?.textContent ?? '').trim()
}

/** 上游把点击事件派发到的原生路径：点蒙层即关闭（`SettingsRoot` 的 mask.onClick）。 */
function maskOf(panel: Element): HTMLElement | null {
  return panel.parentElement?.querySelector<HTMLElement>(':scope > [aria-hidden="true"]') ?? null
}

/** 派发一次真实点击（带 mousedown：蒙层的关闭路径两种事件都有订阅者）。 */
function dispatchClick(target: Element): void {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

/**
 * 手机竖屏设置中心的分层导航（挂在 `html` 级 observer 上的 reconcile 循环）。
 *
 * `attach` 起观察并把已有面板归位到首页；`detach` 收回全部注入物（属性、顶部条、说明行、箭头），
 * 保证热卸载后 DOM 回到上游原样。
 */
export class MobileSettingsNav {
  private observer: MutationObserver | null = null
  private attached = false
  private scheduled = false
  /** 当前追踪的面板；换面板（React 重建）时复位到首页。 */
  private panel: HTMLElement | null = null
  private level: string = LEVEL_HOME
  /** 刚进入二级页时先上屏的标题（等上游把 `aria-current` 挪到目标行后即可撤下）。 */
  private pendingTitle: string | null = null
  /** 同步完成后要落焦点的目标：`'back'` = 返回控件，`'row'` = 当前一级行。 */
  private focusTarget: 'back' | 'row' | null = null

  /** 开始观察并归位当前面板；重复调用无副作用。 */
  attach(): void {
    if (this.attached) return
    this.attached = true
    document.addEventListener('click', this.onClick, true)
    document.addEventListener('keydown', this.onKeyDown, true)
    try {
      this.observer = new MutationObserver(() => { this.schedule() })
      // childList 覆盖面板与 nav 行的出现/重建；`aria-current` 是「当前分区」这一上游事实的
      // 唯一 DOM 落点，二级页标题与返回层级都要读它，故一并观察（属性过滤挡住流式 class/style 噪声）。
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [MOBILE_FORM_ATTR, 'aria-current'],
      })
      this.sync()
    } catch (error) {
      // 手机运行时护栏：这只是导航便利层，绝不能把插件主体拖下水。
      console.warn('[dsh-settings-nav] attach failed; the settings panel keeps its own layout', error)
    }
  }

  /** 撤掉观察与本模块写下的全部 DOM 事实。 */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    document.removeEventListener('click', this.onClick, true)
    document.removeEventListener('keydown', this.onKeyDown, true)
    this.observer?.disconnect()
    this.observer = null
    this.scheduled = false
    this.release(this.panel)
    // 面板可能已被上游整棵摘掉（不在文档里），兜一次文档级扫尾，确保不留孤儿节点。
    for (const node of document.querySelectorAll('[' + BAR_ATTR + ']')) node.remove()
    for (const node of document.querySelectorAll('[' + DESC_ATTR + '], [' + CHEVRON_ATTR + '], [' + ICON_ATTR + ']')) node.remove()
    for (const node of document.querySelectorAll('[' + ICON_ATTR + '-hidden]')) node.removeAttribute(ICON_ATTR + '-hidden')
    for (const node of document.querySelectorAll('[' + ROW_ATTR + ']')) node.removeAttribute(ROW_ATTR)
    this.panel = null
    this.level = LEVEL_HOME
    this.pendingTitle = null
    this.focusTarget = null
  }

  /**
   * 首页里点返回 = 关设置；二级页里点返回 = 回首页。
   *
   * 捕获阶段先在 document 上接手，点击不再往下走（本控件与上游导航无关，不需要它的 onSelect）。
   */
  private readonly onClick = (event: MouseEvent): void => {
    try {
      if (!document.documentElement.hasAttribute(MOBILE_FORM_ATTR)) return
      const target = event.target
      if (!(target instanceof Element)) return
      const panel = document.querySelector<HTMLElement>(PANEL_SELECTOR)
      if (panel === null) return

      if (target.closest('[' + BACK_ATTR + ']') !== null) {
        event.preventDefault()
        event.stopPropagation()
        this.goBack(panel)
        return
      }

      // 一级分类：进入二级页。这里**不能**拦事件——真正切分区的仍是上游 onSelect。
      if (this.level === LEVEL_HOME && target.closest('nav button') !== null) {
        const button = target.closest('nav button')
        if (button !== null) this.enterDetail(panel, button)
        return
      }

      // 蒙层关闭请求：手机形态下面板占满视口，人点不到蒙层，所以走到这里的只有程序化关闭，
      // 而系统返回的 dialog 层正是「点蒙层」（`back-stack.ts` 的 closeDialog）。
      //
      // 二级页里先降一级而不是把设置整个关掉，于是 Android 返回天然逐级：detail -> home -> 关闭。
      // 这里不依赖 back-stack 是否另加 settings-level 层：若将来加了，那一层会直接点我们的返回键，
      // 走的也是同一个 backToHome，不存在两处各降一级。
      if (this.level === LEVEL_DETAIL && this.isSettingsMask(target, panel)) {
        event.preventDefault()
        event.stopPropagation()
        this.backToHome(panel)
      }
    } catch (error) {
      console.warn('[dsh-settings-nav] click handling failed; the panel keeps upstream behavior', error)
    }
  }

  /**
   * Escape 在二级页里只退回首页。
   *
   * 上游 `useModalLayer` 把 Escape 接成「关设置」；二级页里那会一次退两级。捕获阶段先拦下，
   * 首页则原样放行给上游（它才是设置的关闭路径）。
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || this.level !== LEVEL_DETAIL) return
    const panel = document.querySelector<HTMLElement>(PANEL_SELECTOR)
    if (panel === null) return
    event.preventDefault()
    event.stopPropagation()
    this.backToHome(panel)
  }

  /** 返回键：二级页回首页，首页关设置。 */
  private goBack(panel: HTMLElement): void {
    if (this.level === LEVEL_DETAIL) {
      this.backToHome(panel)
      return
    }
    const mask = maskOf(panel)
    if (mask !== null) dispatchClick(mask)
    else panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  }

  /** 是否点在设置面板的蒙层上（蒙层是面板的兄弟节点，本模块按下标定位它）。 */
  private isSettingsMask(target: Element, panel: HTMLElement): boolean {
    const mask = maskOf(panel)
    return mask !== null && (target === mask || mask.contains(target))
  }

  private enterDetail(panel: HTMLElement, button: Element): void {
    this.pendingTitle = rowLabel(button) || null
    this.level = LEVEL_DETAIL
    this.focusTarget = 'back'
    this.sync()
  }

  private backToHome(panel: HTMLElement): void {
    this.level = LEVEL_HOME
    this.pendingTitle = null
    this.focusTarget = 'row'
    this.sync()
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.attached) this.sync()
    })
  }

  /**
   * 把 DOM 收敛到「当前面板 + 当前层级 + 当前注册结果」。
   *
   * 幂等：每次全量重算但只写变化的部分；面板消失或手机形态关闭时把注入物全部收回。
   */
  private sync(): void {
    try {
      const mobileForm = document.documentElement.hasAttribute(MOBILE_FORM_ATTR)
      const panel = mobileForm ? document.querySelector<HTMLElement>(PANEL_SELECTOR) : null
      if (panel === null) {
        this.teardown()
        return
      }
      if (panel !== this.panel) {
        // 新面板（首次打开或 React 重建）：旧面板先收干净（它可能已被摘出文档），
        // 新面板一律从首页开始，不沿用上一次的层级。
        this.release(this.panel)
        this.panel = panel
        this.level = LEVEL_HOME
        this.pendingTitle = null
      }
      if (panel.getAttribute(LEVEL_ATTR) !== this.level) panel.setAttribute(LEVEL_ATTR, this.level)
      const bar = this.ensureBar(panel)
      this.syncRows(panel)
      this.syncTitle(panel, bar)
      this.applyFocus(panel)
    } catch (error) {
      console.warn('[dsh-settings-nav] sync failed; the settings panel keeps upstream layout', error)
    }
  }

  /** 收回注入物（面板消失 / 退出手机形态 / 卸载）。 */
  private teardown(): void {
    this.release(this.panel)
    this.panel = null
    this.level = LEVEL_HOME
    this.pendingTitle = null
    this.focusTarget = null
  }

  /**
   * 把一块面板还原成上游原样：层级属性、顶部条、说明行、箭头、行为标记全部撤掉。
   * @param panel - 要还原的面板；null 时无事可做。
   */
  private release(panel: HTMLElement | null): void {
    if (panel === null) return
    panel.removeAttribute(LEVEL_ATTR)
    for (const node of panel.querySelectorAll('[' + BAR_ATTR + '], [' + DESC_ATTR + '], [' + CHEVRON_ATTR + '], [' + ICON_ATTR + ']')) {
      node.remove()
    }
    // 上游图标只是被标记隐藏，收回时去掉标记即原样恢复。
    for (const node of panel.querySelectorAll('[' + ICON_ATTR + '-hidden]')) node.removeAttribute(ICON_ATTR + '-hidden')
    for (const node of panel.querySelectorAll('[' + ROW_ATTR + ']')) node.removeAttribute(ROW_ATTR)
  }

  /** 顶部条：返回控件 + 分区标题 + 右侧等高占位（标题因此真正居中）。 */
  private ensureBar(panel: HTMLElement): HTMLElement {
    const existing = panel.querySelector<HTMLElement>(':scope > [' + BAR_ATTR + ']')
    if (existing !== null) return existing
    const bar = document.createElement('div')
    bar.setAttribute(BAR_ATTR, '')

    const back = document.createElement('button')
    back.type = 'button'
    back.setAttribute(BACK_ATTR, '')
    back.setAttribute('aria-label', '返回')
    back.appendChild(strokeArrow('M11 4 6 9l5 5'))
    bar.appendChild(back)

    const title = document.createElement('span')
    title.setAttribute(BAR_TITLE_ATTR, '')
    bar.appendChild(title)

    const spacer = document.createElement('span')
    spacer.setAttribute('data-dsh-settings-bar-spacer', '')
    spacer.setAttribute('aria-hidden', 'true')
    bar.appendChild(spacer)

    // 面板的第一个子节点：首页时它绝对定位成返回浮标，二级页时它是一行真正的标题栏。
    panel.insertBefore(bar, panel.firstChild)
    return bar
  }

  /** 逐行补齐装饰：箭头给所有行，短说明只给我方自有分区。 */
  private syncRows(panel: HTMLElement): void {
    const list = panel.querySelector<HTMLElement>(NAV_LIST_SELECTOR)
    if (list === null) return
    const rows = [...list.querySelectorAll<HTMLButtonElement>(':scope > button')]
    for (const row of rows) {
      if (row.querySelector(':scope > [' + CHEVRON_ATTR + ']') === null) {
        const chevron = document.createElement('span')
        chevron.setAttribute(CHEVRON_ATTR, '')
        chevron.setAttribute('aria-hidden', 'true')
        chevron.appendChild(strokeArrow('M7 4l5 5-5 5'))
        row.appendChild(chevron)
      }
      const label = rowLabel(row)
      const description = OWN_SECTION_DESCRIPTIONS.get(label)
      const existing = row.querySelector<HTMLElement>(':scope > [' + DESC_ATTR + ']')
      if (description === undefined) {
        // 未知 / 上游 / 第三方 id：只有上游本来的 icon + label 与我们的箭头，一个字都不加。
        existing?.remove()
        // 上游图标原样留用（含它自己对这些 id 的降级）；我方图标若曾装饰过则收回。
        row.querySelector(':scope > [' + ICON_ATTR + ']')?.remove()
        row.querySelector(':scope > svg')?.removeAttribute('data-dsh-settings-nav-icon-hidden')
        row.setAttribute(ROW_ATTR, 'other')
        continue
      }
      row.setAttribute(ROW_ATTR, 'own')
      this.syncRowIcon(row, label)
      if (existing === null) {
        const span = document.createElement('span')
        span.setAttribute(DESC_ATTR, '')
        // 说明只是标题的补充：读屏用户听到的正是上游注册名，不该再被读一遍同义短句。
        span.setAttribute('aria-hidden', 'true')
        span.textContent = description
        row.appendChild(span)
      } else if (existing.textContent !== description) {
        existing.textContent = description
      }
    }
  }

  /**
   * 给我方自有分区行换成该分区自己的图标（上游对未知 id 一律给通用齿轮，三个分类会长得一模一样）。
   *
   * 只影响本表登记的行：上游内置 id 与第三方/未知行不进这里，它们的图标仍是上游渲染。
   * 做法是「隐藏上游 svg + 插入我方 svg」，保证每一行**只有一个可见图标**；
   * 收回时把上游 svg 原样放回（不改上游节点本身，只加/去一个本模块的属性）。
   *
   * @param row - 一级行按钮。
   * @param label - 该行的上游注册名（本表的键）。
   */
  private syncRowIcon(row: HTMLButtonElement, label: string): void {
    const icon = OWN_SECTION_ICONS.get(label)
    const injected = row.querySelector<SVGSVGElement>(':scope > [' + ICON_ATTR + ']')
    const upstream = [...row.querySelectorAll(':scope > svg')].find(node => node !== injected)
    if (icon === undefined) {
      injected?.remove()
      upstream?.removeAttribute(ICON_ATTR + '-hidden')
      return
    }
    // 上游那个齿轮对本行已无意义：留一个隐藏标记而不是删除，收回时是原样的上游节点。
    if (upstream !== undefined && !upstream.hasAttribute(ICON_ATTR + '-hidden')) {
      upstream.setAttribute(ICON_ATTR + '-hidden', '')
    }
    if (injected === null) {
      const svg = sectionIcon(icon)
      svg.setAttribute(ICON_ATTR, '')
      // 放在行首（grid-area: icon 决定实际位置），上游 svg 仍在其后但已隐藏。
      row.prepend(svg)
    }
  }

  /**
   * 顶部条标题：首页用设置外壳自己的标题，二级页用当前分区名。
   *
   * 两段文案都取自 DOM 里上游已经渲染的文本（首页 = `nav > div:first-child`，即
   * `settings.header` 插槽；二级页 = `aria-current` 那一行），本模块不新造任何一个分区名。
   *
   * 只在真的变了才写：给 textContent 赋同一个值仍会产生 childList 变更记录，
   * 而本模块自己就在监听 childList —— 无脑赋值会把 reconcile 变成自激循环。
   */
  private syncTitle(panel: HTMLElement, bar: HTMLElement): void {
    const title = bar.querySelector<HTMLElement>('[' + BAR_TITLE_ATTR + ']')
    if (title === null) return
    if (this.level === LEVEL_HOME) {
      // 首页：外壳标题（「设置」）。上游对 active 的兜底选择会选中第一行，用它当标题是错的。
      this.pendingTitle = null
      this.writeTitle(title, panel.querySelector(NAV_TITLE_SELECTOR)?.textContent ?? '')
      return
    }
    const activeLabel = rowLabel(panel.querySelector(ACTIVE_ROW_SELECTOR) ?? panel.ownerDocument.createElement('span'))
    if (this.pendingTitle !== null) {
      this.writeTitle(title, this.pendingTitle)
      // 上游把 aria-current 挪到目标行后即可交回常规路径（期间语言切换也由它接手）。
      if (activeLabel === this.pendingTitle) this.pendingTitle = null
      return
    }
    this.writeTitle(title, activeLabel)
  }

  /** 只在文本真的变了才写回（见 syncTitle 的观测循环说明）。 */
  private writeTitle(title: HTMLElement, text: string): void {
    if (text !== '' && title.textContent !== text) title.textContent = text
  }

  /** 层级切换后把焦点放到真正是「当前页」的控件上（二级页 = 返回，首页 = 当前一级行）。 */
  private applyFocus(panel: HTMLElement): void {
    const target = this.focusTarget
    this.focusTarget = null
    if (target === 'back') {
      panel.querySelector<HTMLElement>('[' + BACK_ATTR + ']')?.focus()
      return
    }
    if (target === 'row') {
      const row = panel.querySelector<HTMLElement>(ACTIVE_ROW_SELECTOR)
      if (row !== null && !row.hasAttribute('disabled')) row.focus()
    }
  }
}
