/**
 * 交付文件卡片（换行汇总卡）上的两段胶囊：另一种打开方式 + 转发。
 *
 * 卡片本身是上游 ui-deliverables 的 ChangedFiles（只读包，不能改），它没有文件级操作插槽，
 * 所以这里按 DOM 增强：找到卡片、读出该文件的绝对设备路径、挂上胶囊。卡片自身的单击行为
 * 完全不动（仍然是 openReview → 侧边栏预览）。
 *
 * ## 路径从哪来
 * 不猜 class、不猜结构：上游给每个可点元素都写了 aria-describedby，指向一个 hidden 的 span，
 * 里面就是 resolveWorkspacePath 之后的绝对设备路径（ChangedFiles.tsx:52/75 单文件、
 * :85/94 多文件行）。照这个可访问性接线取值，比按样式类定位稳定得多。
 *
 * ## 为什么左侧可以反向
 * DEFAULT_OPEN_MODE 是这一处唯一的默认开口假设。胶囊左段永远是「另一种」打开方式：
 * 默认是侧栏 → 左段是外部应用（open-in-new）；默认改成外部应用 → 左段变成侧栏预览。
 * 以后加快捷设置行，只改这个常量，不用动组件。
 */

/** 单击卡片的默认打开方式。加设置行时只改这里，胶囊左段自动反向。 */
export const DEFAULT_OPEN_MODE: OpenMode = 'sidebar'

/** 单击卡片时的目标：侧边栏预览，或交给外部应用。 */
export type OpenMode = 'sidebar' | 'external'

/** 在卡片上执行的两种动作。 */
export type CardAction = 'external' | 'share'

const CARD_SELECTOR = '[data-changed-files]'
const CAPSULE_ATTR = 'data-dsh-file-capsule'
const EXTERNAL_ATTR = 'data-dsh-file-capsule-external'
const SHARE_ATTR = 'data-dsh-file-capsule-share'
const SEPARATOR_ATTR = 'data-dsh-file-capsule-separator'

/** 胶囊自身的标记选择器（本模块自产节点的唯一判据，避免手拼方括号）。 */
const CAPSULE_SELECTOR = '[' + CAPSULE_ATTR + ']'

/**
 * 这批新增节点是不是**全**为本模块自己挂的胶囊。
 *
 * 我们 append 胶囊会立刻产生一条 childList 记录，若不认出来就会「自己叫自己」：
 * 每挂一条胶囊多换一次重扫。判定按「全为自有」而非「含自有」——含别的东西时仍要处理，
 * 否则混在一条记录里的真实新增会被吞掉。
 * @param nodes - 变更记录里的新增节点。
 * @returns 新增节点非空且逐个都在胶囊内（或本身就是胶囊）。
 */
function onlyOwnCapsules(nodes: ArrayLike<Node>): boolean {
  if (nodes.length === 0) return false
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]
    const element = node instanceof Element ? node : node.parentElement
    if (element === null || element.closest(CAPSULE_SELECTOR) === null) return false
  }
  return true
}

/** 扩展名 → MIME。未知一律空串，交给壳侧嗅探（见 android-bridge.ts 的 openFileExternal 注释）。 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  apk: 'application/vnd.android.package-archive',
}

/**
 * 一条卡片动作的运行结果。
 *
 * `error` 是壳侧的错误码，**壳侧是唯一真源**：FileExternalBridge.errorPayload 写的是
 * `{"ok":false,"error":"<code>"}`，四枚码见 FileExternalBridge.ERROR_*（no-receiver /
 * uri-denied / io / bad-request）。本模块只读这一处，不另立一套。
 *
 * `reason` 是**向后兼容**旧壳的遗留字段，见 readAnswer 的注释。
 */
export interface CardBridgeResult {
  readonly ok: boolean
  /** 壳侧错误码（`error` 字段原值）。成功时缺失。 */
  readonly error?: string
  /** 插件内部判据（empty-answer / malformed-answer / unavailable）。不来自壳侧。 */
  readonly reason?: string
}

/**
 * 桥的窄面：只有本模块用到的两个方法，便于测试注入。
 *
 * 返回 string 是壳侧的正常答复；undefined 表示方法不在场（旧壳/桌面），
 * 与「桥返回空串」一样走不可用分支——所以这里允许 undefined，不要求调用方先判空。
 *
 * 这里**不去扩 AndroidShellBridge**：那会先于壳侧实现留下悬空声明，
 * check-bridge-symmetry 会把「类型面有、@JavascriptInterface 没有」判成 tsOnly 不对称。
 * 与 session-cwd.ts 同一做法：插件只在自己消费处声明需要的那一片，
 * 壳侧落地后由 android-bridge.ts 收编，本声明自然收敛。
 */
export interface FileCardBridge {
  openFileExternal?: (path: string, mime: string) => string | undefined
  shareFile?: (path: string, mime: string) => string | undefined
}

/**
 * 把桥返回的 JSON 读成结果；非 JSON 或抛异常都按失败处理，不抛给 UI。
 *
 * ## 字段以壳侧为唯一真源
 * FileExternalBridge.errorPayload 产出的是 `{"ok":false,"error":"<code>"}`——
 * 字段名是 **error**，不是 reason。本函数只认 error。
 *
 * ## 向后兼容（待旧版壳退场后删除）
 * 早期壳（≤ 0.14.9 的某些包）回的是 `{"ok":false,"reason":"no-handler"}`：
 * 字段名是 reason，取值名是 no-handler。旧包可能还在用户机器上，所以 error 缺失时
 * 退回读 reason，并把取值 no-handler 归一到 no-receiver，让下游只判一个值。
 *
 * **删除条件**：确认无 ≤0.14.9 的壳在用后，删掉 LEGACY_REASON_* 与下面那段归一，
 * 只留 answer.error 一条路径。届时 readAnswer 会短一半。
 */
const LEGACY_REASON_FIELD = 'reason'
const LEGACY_REASON_NO_HANDLER = 'no-handler'
/** 旧壳的取值 → 壳侧现行错误码。 */
const SHELL_ERROR_NO_RECEIVER = 'no-receiver'

function readAnswer(raw: unknown): CardBridgeResult {
  if (typeof raw !== 'string' || raw === '') return { ok: false, reason: 'empty-answer' }
  try {
    const answer = JSON.parse(raw) as { ok?: unknown; error?: unknown; reason?: unknown }
    if (answer.ok === true) return { ok: true }
    // 壳侧现行字段。
    if (typeof answer.error === 'string' && answer.error !== '') return { ok: false, error: answer.error }
    // 向后兼容旧壳：仅当 error 缺失时才看 reason。见上方删除条件。
    const legacy = answer[LEGACY_REASON_FIELD]
    if (typeof legacy === 'string' && legacy !== '') {
      return { ok: false, error: legacy === LEGACY_REASON_NO_HANDLER ? SHELL_ERROR_NO_RECEIVER : legacy }
    }
    return { ok: false }
  } catch {
    // 桥返回了非 JSON：当作壳侧故障，和显式拒绝走同一条失败路径。
    return { ok: false, reason: 'malformed-answer' }
  }
}

/** 从路径取扩展名（小写，不含点）。 */
function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * 一个路径的 MIME；未知返回空串（壳侧嗅探，而不是编一个 application/octet-stream）。
 * @param path - 绝对设备路径。
 * @returns 已知扩展名的 MIME，否则空串。
 */
export function mimeOf(path: string): string {
  return MIME_BY_EXTENSION[extensionOf(path)] ?? ''
}

/** 文件名（末段），用于无障碍文案。 */
function nameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** 复制图标路径，24x24 视框，由 CSS 缩到 16。 */
function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

/**
 * 左段图标：文件夹。
 *
 * 语义是「把文件交出去打开」，样图用的是文件夹，手机上也比外跳箭头更不容易被读成
 * 「跳到别处」。语义仍由 aria-label 承担（纯图标，无障碍文案是唯一出口）。
 */
const ICON_FOLDER = 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4.2l1.8 2h9A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z'
/** 纸飞机：转发。 */
const ICON_SHARE = 'M21 3 11 13M21 3l-6.5 18-3.5-8-8-3.5z'

/** 左段内层那个带描边小块的标记属性。 */
const CHIP_ATTR = 'data-dsh-file-capsule-chip'

/** 文案提供者；缺省用内置中英词条。 */
export interface FileCardCopy {
  /** 左段：用其他应用打开。 */
  readonly external: (name: string) => string
  /** 右段：转发该文件。 */
  readonly share: string
}

/**
 * 给交付文件卡片挂两段胶囊。
 *
 * attach 挂 MutationObserver，detach 摘干净（HMR 安全）。卡片由 React 管理，我们只在卡片
 * 末尾追加自己的节点，且不监听 React 的渲染，所以不会和它抢 DOM。
 *
 * ## 观察策略（#985）：观察面全文档，扫描范围只到「脏卡片」
 * 流式输出期间 DOM 每拍都在变，旧实现是「回调直接 scan()，每次对整份文档
 * querySelectorAll(CARD_SELECTOR) 再逐卡片逐行 querySelector」——代价随
 * 「历史消息数 × 变更次数」增长。现在分两步：
 *
 * 1. **回调只登记**：`onMutations` 在记录本身上做廉价判定（脱树 / 无新增元素 /
 *    全是本模块自产的胶囊 → 直接跳过），只把「这一拍真正要重扫的卡片」放进待办集合，
 *    然后 `schedule()` 用 pending 标志 + `queueMicrotask` 合批（写法对齐
 *    `composer-sheet.ts` 的 `schedulePatch`）。
 * 2. **扫描范围有界**：变更落在已知卡片内部（流式新增行、迟到补写的路径 span）→ 只重扫
 *    那张卡片；否则只在这个新增子树里找卡片，绝不下探到整份文档。全文档扫描只剩
 *    attach 的首次 `scanAll()` 一次。
 *
 * 「扫了几次 / 扫了多大范围」由 `cardsIn()` 与 `scanBatch()` 两个 protected 方法承担
 * （用例覆写它们来计数），生产代码里没有为测试留的可变状态；待办集合每拍清空、detach
 * 也清空，所以不会长期持有已移除卡片的引用。
 */
export class FileCardCapsule {
  private observer: MutationObserver | null = null
  /** 桥面提供者：每次动作时调用，壳侧晚注入也能拿到。 */
  private bridge: () => FileCardBridge
  private copy: FileCardCopy
  private attached = false
  /** 已被证明没有外部接收方：不再展示左段（避免留一个点了报错的按钮）。 */
  private externalMissing = false
  /** 这一拍待重扫的卡片（Set 去重：同一张卡被多条记录点到只扫一次）。 */
  private pending = new Set<HTMLElement>()
  /** 合批标志：本拍是否已排过一次扫描。 */
  private batchScheduled = false
  /** 挂载代次：detach 自增，已排队但属于上一轮的合批任务据此作废（HMR 重装不读旧批次）。 */
  private generation = 0

  /**
   * @param bridge - 桥面提供者；每次动作时调用，以便壳侧晚于插件注入也能生效。
   * @param copy - 文案。
   */
  constructor(bridge: () => FileCardBridge, copy: FileCardCopy) {
    this.bridge = bridge
    this.copy = copy
  }

  /** 换绑桥面提供者。 */
  setBridge(bridge: () => FileCardBridge): void {
    this.bridge = bridge
  }

  /** locale/change 后换绑文案。 */
  setCopy(copy: FileCardCopy): void {
    this.copy = copy
  }

  /**
   * 左侧那一段是否可用。
   *
   * 桥不存在（桌面/旧壳）→ 不可用。桥在但曾被答 no-handler → 也不可用。
   * 真正的「先问有没有接收方」需要壳侧提供一个查询方法；当前协议只有两个执行方法，
   * 所以这里用「桥在 + 尚未被证明没有」这条判据，宁可先显示、一旦确证就永久隐藏。
   * @returns 是否渲染左段。
   */
  externalAvailable(): boolean {
    return typeof this.bridge().openFileExternal === 'function' && !this.externalMissing
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    try {
      // 唯一一次全文档扫描：挂载时把存量卡片补齐。
      this.scanAll()
      this.observer = new MutationObserver((records) => { this.onMutations(records) })
      this.observer.observe(document.documentElement, { childList: true, subtree: true })
    } catch (error) {
      // 手机运行时守卫：卡片增强失败不能影响对话渲染。
      console.warn('[dsh-file-card-capsule] attach failed; cards keep upstream behavior', error)
    }
  }

  detach(): void {
    if (!this.attached) return
    this.attached = false
    this.observer?.disconnect()
    this.observer = null
    // 待办里的卡片引用一并放掉：HMR 重装后不能靠上一轮的脏集合继续扫（也不能长期持有已移除的节点）。
    this.pending.clear()
    this.batchScheduled = false
    this.generation += 1
    for (const capsule of document.querySelectorAll('[' + CAPSULE_ATTR + ']')) capsule.remove()
  }

  /**
   * 观察器回调：**只登记、不扫描**。
   *
   * 流式输出时这个回调每拍都会被叫到，所以这里只做 O(记录数) 的廉价判定，真正的 DOM 遍历
   * 延到 `schedule()` 合批之后，且只碰待办里的卡片：
   * - 记录目标已脱树（卡片被移除 / 整枝被替换）→ 跳过，不留失效引用；
   * - 记录是本模块自己的回声（目标在胶囊里，或新增的正是我们刚挂的胶囊）→ 跳过；
   * - 记录落在已知卡片内部（流式新增行、迟到的路径 span）→ 只重扫那一张卡片；
   * - 其余（新卡片被插入别处）→ 只在**新增子树**里找卡片，绝不下探整份文档。
   * @param records - 本拍投递的变更记录。
   */
  private onMutations(records: readonly MutationRecord[]): void {
    for (const record of records) {
      const target = record.target
      // 目标脱树：卡片/容器已经不在文档里，扫它只会拿到失效引用。
      if (!(target instanceof Element) || !target.isConnected) continue
      // 本模块自己产出的节点（胶囊自身，或刚挂上去的那一条）：不重扫，避免自己叫自己。
      if (target.closest(CAPSULE_SELECTOR) !== null) continue
      if (onlyOwnCapsules(record.addedNodes)) continue
      const card = target.closest<HTMLElement>(CARD_SELECTOR)
      if (card !== null) {
        this.pending.add(card)
        continue
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue
        // 装不下卡片的叶子元素（流式输出的每个 token 节点）直接跳过，连子树查询都不做。
        if (node.childElementCount === 0 && !node.matches(CARD_SELECTOR)) continue
        // 新卡片可能自带整棵子树（多文件卡片一次插入），也可能只是外层容器。
        for (const found of this.cardsIn(node)) this.pending.add(found)
      }
    }
    if (this.pending.size > 0) this.schedule()
  }

  /** 合批：同一拍里的多条记录只换一次扫描（同 composer-sheet 的 schedulePatch 写法）。 */
  private schedule(): void {
    if (this.batchScheduled) return
    this.batchScheduled = true
    const generation = this.generation
    queueMicrotask(() => {
      // 已 detach（或 detach 后又 attach）：这一批属于上一轮，直接作废。
      if (generation !== this.generation) return
      this.batchScheduled = false
      if (!this.attached) return
      const cards = [...this.pending]
      this.pending.clear()
      this.scanBatch(cards)
    })
  }

  /**
   * 在给定根里找卡片。**唯一的卡片查询入口**：全文档扫描与子树扫描都走这里，
   * 所以「扫了几次、扫了多大范围」是可以用例覆写它来数的量（生产代码里没有为测试留的状态）。
   * @param root - 查询根：`document`（仅 attach 一次）或变更记录里的新增子树。
   * @returns 该根里（含根本身）的卡片元素。
   */
  protected cardsIn(root: ParentNode): HTMLElement[] {
    const found: HTMLElement[] = []
    if (root instanceof Element && root.matches(CARD_SELECTOR)) found.push(root as HTMLElement)
    for (const card of root.querySelectorAll<HTMLElement>(CARD_SELECTOR)) found.push(card)
    return found
  }

  /**
   * 扫描一批卡片。
   * @param cards - 待扫卡片；合批期间被移出文档的在扫之前剔掉。
   */
  protected scanBatch(cards: readonly HTMLElement[]): void {
    for (const card of cards) {
      if (!card.isConnected) continue
      this.scanCard(card)
    }
  }

  /** 全文档扫一次。只在 attach 时发生，不要放回观察器回调里。 */
  private scanAll(): void {
    this.scanBatch(this.cardsIn(document))
  }

  /** 给一张卡片里还没挂胶囊的文件行补齐。已经是幂等的：已存在就跳过。 */
  private scanCard(card: HTMLElement): void {
    const single = card.hasAttribute('data-single')
    if (single) {
      // 单文件卡片：上游把 header 包在 FileOpenAnchor 里（div > span > button），
      // 不是卡片的直接子元素，所以不能写 :scope > button（实机取证：那条恒 NULL）。
      // 落点用卡片自身——按钮的 parentElement 是 FileOpenAnchor 的 span，挂进去会被
      // 上游重渲染吞掉，而且胶囊会挤在按钮内部而不是卡片角落。
      const header = card.querySelector<HTMLElement>('button[aria-describedby]')
      if (header !== null) this.ensureCapsule(header, card)
      return
    }
    // 多文件卡片：每行同样是 `li > span(FileOpenAnchor) > button`，按钮不是 li 的
    // 直接子元素，所以 `li > button` 也匹配不到（实机取证）。按 li 逐个取行内按钮。
    for (const row of card.querySelectorAll<HTMLElement>('li')) {
      const anchor = row.querySelector<HTMLElement>('button[aria-describedby]')
      if (anchor !== null) this.ensureCapsule(anchor, row)
    }
  }

  /**
   * 为一行文件挂胶囊。
   * @param anchor - 该行的可点元素（上游写的 aria-describedby 指向绝对路径）。
   * @param host - 胶囊的落点（卡片自身或该行 li）。
   */
  private ensureCapsule(anchor: HTMLElement, host: HTMLElement | null): void {
    if (host === null) return
    if (host.querySelector(':scope > [' + CAPSULE_ATTR + ']') !== null) return
    const path = this.pathOf(anchor)
    if (path === undefined) return
    host.append(this.buildCapsule(anchor, path))
  }

  /**
   * 读上游写好的绝对路径。
   *
   * 上游把 resolveWorkspacePath 的结果放在 aria-describedby 指向的 hidden span 里，
   * 这里照抄那条接线，不按样式类找。
   * @param anchor - 该行的可点元素。
   * @returns 绝对设备路径，或 undefined（上游没写/元素缺失）。
   */
  private pathOf(anchor: HTMLElement): string | undefined {
    const described = anchor.getAttribute('aria-describedby')
    if (described === null || described === '') return undefined
    const node = document.getElementById(described)
    const text = node?.textContent?.trim()
    return text === undefined || text === '' ? undefined : text
  }

  private buildCapsule(anchor: HTMLElement, path: string): HTMLElement {
    const capsule = document.createElement('div')
    capsule.setAttribute(CAPSULE_ATTR, '')
    const name = nameOf(path)
    const external = this.buildSegment(EXTERNAL_ATTR, ICON_FOLDER, this.copy.external(name), CHIP_ATTR)
    external.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.act('external', path)
    })
    capsule.append(external)
    if (this.externalAvailable()) {
      const separator = document.createElement('span')
      separator.setAttribute(SEPARATOR_ATTR, '')
      separator.setAttribute('aria-hidden', 'true')
      capsule.append(separator)
    } else {
      // 没有左段：整条胶囊只剩转发，不留空壳。
      capsule.setAttribute('data-dsh-file-capsule-share-only', '')
      external.remove()
    }
    const share = this.buildSegment(SHARE_ATTR, ICON_SHARE, this.copy.share)
    share.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.act('share', path)
    })
    capsule.append(share)
    // 左段存在时它占大头；这里把 anchor 记在数据集上，供默认模式反向时使用。
    capsule.setAttribute('data-dsh-file-capsule-target', anchor.getAttribute('typeof') ?? '')
    return capsule
  }

  /**
   * 造一段。
   * @param attr - 该段的标记属性。
   * @param iconPath - 图标路径。
   * @param label - 该段自己的无障碍文案（纯图标，这是唯一出口）。
   * @param chipAttr - 需要内嵌带描边小块的段，传入小块标记；右段不传。
   * @returns 该段的按钮。
   */
  private buildSegment(attr: string, iconPath: string, label: string, chipAttr?: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(attr, '')
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    if (chipAttr === undefined) {
      button.append(icon(iconPath))
      return button
    }
    // 左段：图标包在带描边的小圆角块里（样图形态），小块本身不可点、无文案。
    const chip = document.createElement('span')
    chip.setAttribute(chipAttr, '')
    chip.setAttribute('aria-hidden', 'true')
    chip.append(icon(iconPath))
    button.append(chip)
    return button
  }

  /**
   * 执行一种动作。两者都走桥、都不抛给 UI。
   * @param action - external 或 share。
   * @param path - 绝对设备路径。
   */
  act(action: CardAction, path: string): CardBridgeResult {
    const mime = mimeOf(path)
    if (action === 'share') {
      const call = this.bridge().shareFile
      if (typeof call !== 'function') return { ok: false, reason: 'unavailable' }
      return this.finish(readAnswer(this.safely(() => call(path, mime))), action)
    }
    const call = this.bridge().openFileExternal
    if (typeof call !== 'function') {
      this.externalMissing = true
      return { ok: false, reason: 'unavailable' }
    }
    return this.finish(readAnswer(this.safely(() => call(path, mime))), action)
  }

  /** 桥抛异常时按失败返回，不让异常穿过 DOM 事件。 */
  private safely(run: () => string | undefined): string | undefined {
    try {
      return run()
    } catch (error) {
      console.warn('[dsh-file-card-capsule] bridge call threw', error)
      return undefined
    }
  }

  /**
   * 记录「确证没有外部接收方」，并让已渲染的胶囊收起左段。
   *
   * ## 只有 no-receiver 才算「确证」
   * 判据是壳侧的 `error === 'no-receiver'`——探活为空 / startActivity 抛 ActivityNotFound，
   * 都是「这台机器上确实没人接」的确证。
   *
   * 其余错误码（uri-denied / io / bad-request）**不收起左段**：它们是这一次调用的失败
   * （路径越界、读不到文件、调用方传错参数），不代表机器没有外部应用。把它们当永久无能力，
   * 会把偶发失败升级成不可恢复的状态——用户挪对路径后按钮也回不来了。
   *
   * 注意：`reason` 字段这里是插件内部码（unavailable / empty-answer / malformed-answer），
   * 不参与本判据；壳侧码一律走 `error`。
   */
  private finish(result: CardBridgeResult, action: CardAction): CardBridgeResult {
    if (action === 'external' && !result.ok && result.error === SHELL_ERROR_NO_RECEIVER && !this.externalMissing) {
      this.externalMissing = true
      for (const capsule of document.querySelectorAll('[' + CAPSULE_ATTR + ']')) {
        capsule.querySelector('[' + EXTERNAL_ATTR + ']')?.remove()
        capsule.querySelector('[' + SEPARATOR_ATTR + ']')?.remove()
        capsule.setAttribute('data-dsh-file-capsule-share-only', '')
      }
    }
    return result
  }
}

/**
 * 左段对应的动作：永远是「另一种」打开方式。
 * @param mode - 当前默认打开方式。
 * @returns 左段该执行的动作。
 */
export function otherModeOf(mode: OpenMode): OpenMode {
  return mode === 'sidebar' ? 'external' : 'sidebar'
}
