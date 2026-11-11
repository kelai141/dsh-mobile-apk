/**
 * 上游合成器「+」菜单的**公共读取层**（宿主 API 与底部 sheet 共用一份口径）。
 *
 * 为什么单独成文件而不是留在 composer-sheet 里：悬浮输入区的命令抽屉（原生）必须拿到
 * **与页面「+」菜单同一份命令清单**。设计 §6.4 的硬约束是「禁止硬编码命令清单」「禁止复制
 * 私有实现而不抽公共函数」——两份实现必然会漂移（上游加一条命令，一边看得见一边看不见）。
 * 于是把「开菜单 → 等提交 → 读 [role=option] → 用上游自己的关法收起」整段抽到这里：
 *   - composer-sheet 只负责把读到的行渲染成自己的 sheet；
 *   - `window.__dshOverlayHost.commands()` 直接读同一函数的结果。
 *
 * 本模块**不认识任何具体命令**：选择器来自上游 DOM 契约（MenuView 的 listbox/option、
 * itemName/itemDescription 类名），唯一固定集合是附件行标题闭集 [ATTACHMENT_ROW_TITLES]，
 * 且只用于去重，注释要求精确匹配、禁止按位置/前缀。
 *
 * 事件契约（来自 composer-sheet 的既有实测结论，别改回去）：
 *   - 上游「+」是 `button[aria-haspopup="listbox"]`，弹层是 `role="listbox"`（不是 menu）；
 *   - 打开菜单必须让编辑器持焦点（MenuView 绑在 draft editor 的 caret 上）；
 *   - 打开后菜单要到**下一次 React 提交**才挂进 DOM，必须轮询等选项出现（#1002）；
 *   - 关闭用 Escape，且必须派发到编辑器根元素（#998），不能 document.dispatchEvent。
 */

/** 上游「+」：ui-conversation 里唯一 aria-haspopup="listbox" 的按钮（MenuView 是 combobox）。 */
export const ADD_BUTTON_SELECTOR = '[data-composer-card] button[aria-haspopup="listbox"]'
export const CARD_SELECTOR = '[data-composer-card]'
/**
 * 上游「+」弹层的根（role="listbox"，不是 role="menu"）。
 *
 * 上游整条链自洽：按钮 aria-haspopup="listbox" → 弹层 role="listbox" → 每项 role="option"。
 * 曾写成 [role="menu"]，查不到就把「选择器错」误判成「上游不渲染菜单」（实机取证：
 * 同一次点击 [role="menu"] 为 null 而 [role="option"] 有 9 项）。
 */
export const UPSTREAM_MENU_SELECTOR = '[data-composer-card] [role="listbox"]'
/** 弹层里的可选项（MenuView 的每条命令/文件项）。 */
export const UPSTREAM_OPTION_SELECTOR = '[role="option"]'
/** 等上游菜单出现的轮询间隔与超时（超时后按「没读到」处理）。 */
const MENU_POLL_INTERVAL_MS = 25
const MENU_WAIT_TIMEOUT_MS = 3000
/** 上游编辑器根元素（ComposerContentEditable 渲染的 contenteditable div）。 */
const EDITOR_ROOT_SELECTOR = '[data-composer-input]'
/** 编辑器根元素缺失时的退化判据（上游不再打 data-composer-input）。 */
const EDITABLE_SELECTOR = '[contenteditable="true"]'
/**
 * 借用上游菜单期间，菜单外层容器上的临时隐藏标记。
 *
 * 读菜单要跨一次上游提交，这段窗口里上游 listbox 是**真的画在屏幕上**的（实测它比
 * composer card 宽，副标题会露在卡片右侧）。用 visibility: hidden 而不是 display:none /
 * remove()：前者会改变上游测量与定位，后者是别人的 DOM 且转发 mousedown 还要用。
 */
const CONCEAL_ATTR = 'data-dsh-composer-sheet-concealed'

/**
 * 附件入口在行列表里的标题（中英两套文案，精确匹配的闭集）。
 *
 * 三块瓦片（拍照 / 照片 / 本地文件）已经覆盖了附件入口，上游「+」菜单里那条同义的
 * 「文件 / file」行是重复的。**必须是精确匹配的闭集，不能用位置或前缀**：
 *   - 按位置会连带隐掉插件插到最前面的项；
 *   - 按前缀会误伤「文件预览」「文件管理」这类真实功能项。
 */
export const ATTACHMENT_ROW_TITLES: ReadonlySet<string> = new Set([
  '文件', '本地文件', 'file', 'files', 'local file', 'local files',
])

/** 从上游「+」菜单复制出来的一条命令（宿主 API 的线上字段；不含任何具体命令知识）。 */
export interface ComposerMenuCommand {
  /** 上游 itemName 文本（读不到时退化为 aria-label）；命令的唯一稳定标识。 */
  name: string
  /** 展示标签：优先上游 aria-label，缺省与 name 相同。 */
  label: string
  /** 上游 itemDescription / itemAlias 文本；没有就是空串（不编）。 */
  description: string
  /** 上游分组标题（`[role="group"]` 的 aria-label）；没有分组时为空串。 */
  section: string
}

/** 行副标题：优先取上游自己的 description 节点，没有就空串（不编、不猜）。 */
export function readMenuOptionSubtitle(option: HTMLElement): string {
  const hint = option.querySelector<HTMLElement>('[class*="itemDescription"]')
  if (hint !== null) return (hint.textContent ?? '').trim()
  const alias = option.querySelector<HTMLElement>('[class*="itemAlias"]')
  if (alias !== null) return (alias.textContent ?? '').trim()
  return ''
}

/** 页面是否已经有上游合成器「+」按钮（命令读取的前提）。 */
export function hasComposerMenuButton(): boolean {
  try {
    return document.querySelector(ADD_BUTTON_SELECTOR) !== null
  } catch {
    return false
  }
}

/** 卡片里当前读得到的上游选项（菜单容器不在场时是空表）。 */
export function findMenuOptions(card: Element): HTMLElement[] {
  const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
  if (menu === null) return []
  return [...menu.querySelectorAll<HTMLElement>(UPSTREAM_OPTION_SELECTOR)]
}

/** 把一条上游 option 映射成宿主 API 的命令项；读不出名字的项跳过（不猜）。 */
export function mapMenuOption(option: HTMLElement): ComposerMenuCommand | undefined {
  const name = (option.querySelector<HTMLElement>('[class*="itemName"]')?.textContent ?? '').trim()
  const label = (option.getAttribute('aria-label') ?? '').trim()
  const resolvedName = name !== '' ? name : label
  if (resolvedName === '') return undefined
  // 附件行去重：与 sheet 同一闭集、同一精确匹配口径（见 ATTACHMENT_ROW_TITLES）。
  if (ATTACHMENT_ROW_TITLES.has(resolvedName.trim().toLowerCase())) return undefined
  const group = option.closest('[role="group"]')
  const section = group instanceof Element ? (group.getAttribute('aria-label') ?? '').trim() : ''
  return {
    name: resolvedName,
    label: label !== '' ? label : resolvedName,
    description: readMenuOptionSubtitle(option),
    section,
  }
}

/**
 * 关掉上游「+」菜单时 Escape 的派发目标。
 *
 * 上游的关闭链挂在**编辑器根元素**上（Lexical 在 contenteditable 上监听 keydown），
 * document.dispatchEvent 的传播路径只有 [document, window]，到不了那个元素，
 * 菜单就留在屏幕上（#998）。所以在编辑器根上派发，让它自己冒泡回 document。
 * 退化目标是 card 本身（最后手段，保「菜单还能关」，保不住元素级监听链路）。
 */
export function upstreamEscapeTarget(card: Element): Element {
  return card.querySelector(EDITOR_ROOT_SELECTOR) ?? card.querySelector(EDITABLE_SELECTOR) ?? card
}

/**
 * 借用上游菜单期间的可选钩子：让调用方在自己的状态机上感知「正在借用」（例如 sheet 要在
 * 借用期间抑制 Escape 联动、忽略自己重入派发的「+」点击）。
 */
export interface UpstreamMenuHooks {
  /** 借用开始（派发打开之前）/ 结束（函数退出时）。 */
  beginBorrow?(): void
  endBorrow?(): void
  /** 调用方自己派发「+」click 的重入闸：true = 这次点击是我们合成的。 */
  setReplaying?(active: boolean): void
  /** 借用结束后的收尾（调用方据此压焦点；过期调用方应自行丢弃）。 */
  afterBorrow?(): void
}

/**
 * 临时让上游「+」菜单开出来，跑完 run 之后再关掉它。
 *
 * 为什么不把菜单留着当数据源：上游 MenuView 在 document 捕获阶段监听 pointerdown，
 * 目标不在菜单/卡片里就自行 dismiss。宿主 API 也没有「常驻」理由——读一次就够。
 *
 * 重入闸：开菜单的唯一办法是派发「+」的 click，而 sheet 的捕获监听会再次看到它；
 * 不设闸就是无限递归（实测 RangeError）。
 */
export async function withUpstreamMenu<T>(
  run: (options: HTMLElement[]) => T,
  fallback: T,
  hooks: UpstreamMenuHooks = {},
  button: HTMLElement | null = null,
): Promise<T> {
  const addButton = button ?? document.querySelector<HTMLElement>(ADD_BUTTON_SELECTOR)
  if (addButton === null) return fallback
  const card = addButton.closest(CARD_SELECTOR)
  if (card === null) return fallback
  const openedHere = card.querySelector(UPSTREAM_MENU_SELECTOR) === null
  hooks.beginBorrow?.()
  // 从**派发打开之前**就开始藏：菜单会在某一帧挂进 DOM，事后藏已经晚了。
  const restoreVisibility = concealUpstreamMenu(card)
  try {
    if (openedHere) {
      // 先把焦点还给编辑器：MenuView 绑在 caret 上，编辑器不持焦点时点「+」只置
      // aria-expanded、菜单节点不挂载（实测：带焦点 dispatch 拿到 9 项，无焦点恒 0）。
      refocusEditor(card)
      hooks.setReplaying?.(true)
      try {
        addButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      } finally {
        hooks.setReplaying?.(false)
      }
      await waitForMenu(card)
    }
    const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
    const options = menu === null ? [] : [...menu.querySelectorAll<HTMLElement>(UPSTREAM_OPTION_SELECTOR)]
    try {
      return run(options)
    } finally {
      closeUpstreamMenu(card)
      restoreVisibility()
    }
  } finally {
    hooks.endBorrow?.()
    restoreVisibility()
    hooks.afterBorrow?.()
  }
}

/**
 * 读上游「+」菜单的全部命令项（打开 → 读 → 用上游自己的方式关闭）。
 *
 * 失败/菜单不在场一律返回空数组：调用方按「没读到」处理，绝不返回猜测的命令表。
 * 返回的是**当前页面真实菜单**的投影，因此天然跟随上游/第三方插件新增的命令。
 */
export async function readComposerMenuCommands(): Promise<ComposerMenuCommand[]> {
  return withUpstreamMenu((options) => {
    const commands: ComposerMenuCommand[] = []
    for (const option of options) {
      const mapped = mapMenuOption(option)
      if (mapped !== undefined) commands.push(mapped)
    }
    return commands
  }, [])
}

/** 把焦点从任何可编辑元素上挪走（宿主 API 借用期间不弹键盘）。 */
export function blurActiveEditor(): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) active.blur()
}

/** 把焦点还上游编辑器（读菜单借用期间用，键盘由调用方的 inputmode 抑制）。 */
function refocusEditor(card: Element): void {
  const editor = card.querySelector<HTMLElement>(EDITOR_ROOT_SELECTOR) ?? null
  if (editor !== null && !editor.contains(document.activeElement)) editor.focus()
}

/**
 * 把上游「+」菜单临时藏起来（借用期间），返回还原函数。
 *
 * 藏的是菜单的**最外层容器**（有 [data-trigger-menu] 的那层），没有就退到 listbox 本身：
 * 只藏 listbox 时上游可能还有一个定位用的外壳留在屏幕上。
 * 必须持续盯（MutationObserver）：菜单异步提交，等轮询到选项再藏，中间几百毫秒
 * 到 1.2s 它已经画在屏幕上了。观察器回调在提交后、绘制前同步跑，能压在第一帧。
 */
function concealUpstreamMenu(card: Element): () => void {
  const pending = new Set<HTMLElement>()
  const apply = (): void => {
    const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
    if (menu === null) return
    const target = menu.closest('[data-trigger-menu]') ?? menu
    if (!(target instanceof HTMLElement)) return
    if (target.getAttribute(CONCEAL_ATTR) !== null) return
    target.setAttribute(CONCEAL_ATTR, '')
    target.style.setProperty('visibility', 'hidden', 'important')
    pending.add(target)
  }
  apply()
  const observer = new MutationObserver(apply)
  observer.observe(card, { childList: true, subtree: true })
  return () => {
    // **顺序是判据**：先 disconnect 再还原，否则排队的观察器回调会在还原之后又藏一次
    // （实测：撤掉还原代码断言照样绿——两种写法最终都停在 hidden，是假绿）。
    observer.disconnect()
    for (const node of pending) {
      node.removeAttribute(CONCEAL_ATTR)
      node.style.removeProperty('visibility')
    }
    pending.clear()
  }
}

/**
 * 用上游自己的关法收起「+」菜单（不直接 remove 别人的 DOM）。Escape 派发到编辑器根元素。
 */
function closeUpstreamMenu(card: Element): void {
  const menu = card.querySelector(UPSTREAM_MENU_SELECTOR)
  if (menu === null || !menu.isConnected) return
  upstreamEscapeTarget(card).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
}

/**
 * 等上游菜单挂进卡片：逐帧轮询而不是固定延时（快机不浪费、慢机不误判）。
 * 判据必须是**选项**而不是容器：上游常先提交容器、下一帧才填 [role=option]（#1002）。
 */
function waitForMenu(card: Element): Promise<void> {
  return new Promise<void>((resolve) => {
    let waited = 0
    const step = (): void => {
      if (findMenuOptions(card).length > 0 || waited >= MENU_WAIT_TIMEOUT_MS) {
        resolve()
        return
      }
      waited += MENU_POLL_INTERVAL_MS
      setTimeout(step, MENU_POLL_INTERVAL_MS)
    }
    step()
  })
}
