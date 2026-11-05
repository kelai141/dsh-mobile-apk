/**
 * 「关于」入口（0.15.0 用户定例，第二版：独立页面）。
 *
 * 上游「设置 → 通用」最下方只渲染一行「当前版本：0.2.1-rc.2」（引擎版本）。用户要的是：
 * 把那一行换成「关于」入口，点进去是**一个独立的设置页**（与其它分区一样可返回），
 * 页里写壳（DeepCode）与引擎（DeepSeek​Harness）两个版本。
 *
 * 实现要点：
 *  - 那一行不在 `settings.general.item` 槽里（GeneralSection 只渲染该槽），本包无法用 React
 *    渲染到那个位置 → 隐藏原节点、在其后插入我们自己的入口按钮（不 replaceWith：那会从
 *    React 手里抢走节点，下次重渲染会 removeChild 失败）；
 *  - 「跳页」复用移动层已有的列表→二级页机制：本包注册一个 `settings.section`（id
 *    android-about），入口点击时点一下导航里那一行，面板就切到 detail 层，返回键天然可用；
 *  - 导航里那一行在入口成功插入后才隐藏（否则页面不可达 → 保留为兜底入口）。
 */
import { tr } from '../i18n.ts'

/** 已处理的原节点标记（值 = 抓到的引擎版本）。 */
const HANDLED = 'data-dsh-about-source'
/** 我们插入的入口标记，避免重复插入。 */
const ENTRY = 'data-dsh-about-entry'

/** 从文案里抓版本号：0.2.1-rc.2 / 0.14.9 都吃。 */
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/

/** 抓到的引擎版本；供「关于」页面读取（空 = 尚未抓到）。 */
let engineVersion = ''

/**
 * 是否已经成功接管过（内联入口插进去过一次）。
 *
 * 导航行的收起判据用它而不是「此刻页面上有没有入口」：回到一级列表时分区内容不渲染，
 * 内联入口自然不在 DOM 里，若按后者判断就会把导航行放出来——用户反馈「关于又出现在
 * 一级列表里」。只有从未接管成功（精确文案没找到）时才保留导航行作为兜底入口。
 */
let entryInstalled = false

/** 当前已知的引擎版本；空串表示还没从上游那行抓到。 */
export function getEngineVersion(): string {
  return engineVersion
}

/** 读取壳（APK）版本名；桥缺席返回空串。 */
export function getShellVersion(): string {
  const bridge = (window as unknown as { androidBridge?: { version?: () => string } }).androidBridge
  if (typeof bridge?.version !== 'function') return ''
  try {
    return String(bridge.version() ?? '').trim()
  } catch {
    return ''
  }
}

/** 信息圆环图标（与行内其它图标同一线宽）。 */
function infoIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '10')
  circle.setAttribute('cy', '10')
  circle.setAttribute('r', '7.2')
  svg.appendChild(circle)
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  line.setAttribute('d', 'M10 9v4.2M10 6.6v.2')
  line.setAttribute('stroke-linecap', 'round')
  svg.appendChild(line)
  return svg
}

/** 点一下导航里「关于」那一行，把面板切到该分区（沿用移动层的列表→二级页机制）。 */
function openAboutSection(): void {
  const dialog = document.querySelector('[data-dsh-settings-dialog]')
  const scope: ParentNode = dialog ?? document
  for (const button of scope.querySelectorAll<HTMLButtonElement>('nav button')) {
    if (!(button.textContent ?? '').includes(tr('关于', 'About'))) continue
    // display:none 的按钮 .click() 依旧会派发事件，所以隐藏后这条路仍然有效。
    button.click()
    return
  }
}

/** Restore the adapter-owned sibling without replacing React-owned version nodes. */
function ensureEntry(node: HTMLElement): void {
  if (node.nextElementSibling?.hasAttribute(ENTRY) !== true) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute(ENTRY, '')
    button.className = 'dsh-about-entry'
    button.appendChild(infoIcon())
    const label = document.createElement('span')
    label.textContent = tr('关于', 'About')
    button.appendChild(label)
    node.insertAdjacentElement('afterend', button)
  }
  engineVersion = node.getAttribute(HANDLED) ?? engineVersion
  entryInstalled = true
  if (node.style.display !== 'none') node.style.display = 'none'
}

/** 把上游版本行换成「关于」入口；返回清理函数。 */
export function installAboutEntry(): () => void {
  /**
   * 导航里那条「关于」只在**没有内联入口**时显示。
   *
   * 每轮都按现状同步，而不是「插入入口时顺手隐藏一次」：React 重建导航行会把
   * `display:none` 与标记一起丢掉，只做一次的话列表里会重新冒出第二个「关于」。
   */
  const syncNavRow = (scope: ParentNode): void => {
    const hasEntry = entryInstalled || scope.querySelector('[data-dsh-about-entry]') !== null
    for (const navRow of scope.querySelectorAll<HTMLElement>('nav button')) {
      if (!(navRow.textContent ?? '').includes(tr('关于', 'About'))) continue
      if (hasEntry) {
        if (navRow.dataset.dshAboutNavHidden !== '1') {
          navRow.dataset.dshAboutNavHidden = '1'
          navRow.style.display = 'none'
        }
        continue
      }
      // 没有内联入口（例如用户停在别的分区）：保留导航行，页面依然可达。
      if (navRow.dataset.dshAboutNavHidden === '1') {
        delete navRow.dataset.dshAboutNavHidden
        navRow.style.display = ''
      }
    }
  }

  const swap = (): void => {
    // 本入口只存在于设置对话框里：没有它就直接返回。
    // 观察器挂在 body 上（必须能看见对话框出现），而聊天流式输出会高频改动 DOM——
    // 这一次 querySelector 就是全部代价，不做全量扫描。
    const panel = document.querySelector('[data-dsh-settings-dialog]')
    if (panel === null) return
    const scope: ParentNode = panel
    const leaves = [...scope.querySelectorAll<HTMLElement>('div, p, span')]
      .filter((node) => node.children.length === 0)

    syncNavRow(scope)

    // 第一步：修已处理节点。React 重渲染会把 style 写回原值，只认标记不认样式的话
    // 上游版本行会「复活」，界面上就变成版本行 + 关于入口同时出现。
    for (const node of leaves) {
      if (!node.hasAttribute(HANDLED)) continue
      ensureEntry(node)
    }
    syncNavRow(scope)

    // 第二步：只认「当前版本 / Current version」这条精确文案。
    //
    // 不能保留「含版本 + x.y.z」的宽松兜底：其它分区里只要有一行短文案写着
    // 「版本 1.2.3」（插件/模型的信息行就有），松匹配会把它隐藏并插上「关于」入口——
    // 这是本轮审查实测到的真 bug。精确文案找不到时**什么都不做**：导航里那条「关于」
    // 仍可见，用户依然进得去，属于安全失败。
    const fresh = leaves.filter((node) => !node.hasAttribute(HANDLED))
    const preferred = fresh.find((node) => /当前版本|current version/i.test(node.textContent ?? ''))
    const candidates = preferred === undefined ? [] : [preferred]

    for (const node of candidates) {
      // 绝不能把我们自己「关于」页里的版本行当成上游那一行：那会导致版本行被隐藏、
      // 各自再插一个「关于」入口（真机实测：页面上出现两个「关于」、版本消失）。
      if (node.closest('[data-plugin="android-about"]') !== null) continue
      if (node.closest('[data-dsh-about-entry]') !== null) continue
      const text = (node.textContent ?? '').trim()
      if (text.length === 0 || text.length > 60) continue
      if (!/当前版本|current version/i.test(text)) continue
      // 带我们标签的版本行不是上游那行（上游只写「当前版本：x.y.z」）。
      if (/DeepCode|DeepSeek/i.test(text)) continue
      const found = VERSION.exec(text)
      if (found === null) continue

      engineVersion = found[0]
      node.setAttribute(HANDLED, engineVersion)
      ensureEntry(node)
      // 同一轮就收起导航行：只靠下一轮 observer 的话，页面若不再变化就不会执行。
      syncNavRow(scope)
      return
    }
  }

  // 文档级捕获：按钮被 React 重建后依然有效。
  const onClick = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    if (target.closest('[data-dsh-about-entry]') === null) return
    event.preventDefault()
    event.stopPropagation()
    openAboutSection()
  }
  document.addEventListener('click', onClick, true)

  swap()
  // 合帧：一次 DOM 变更潮（如列表重渲染）只扫一遍，而不是每条记录都扫。
  let scheduled = false
  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      swap()
    })
  }
  const observer = new MutationObserver((records) => {
    const panel = document.querySelector('[data-dsh-settings-dialog]')
    if (panel === null) return
    const touched = records.some((record) => record.target === panel || panel.contains(record.target)
      || [...record.addedNodes].some((node) => node === panel
        || (node instanceof Element && node.contains(panel))))
    if (touched) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    observer.disconnect()
    document.removeEventListener('click', onClick, true)
    // 不归零：同一模块实例生命周期内「接管过」不会因为 dispose 而变得不成立。
    // A fresh module recovers the handled row and version through ensureEntry on installation.
  }
}
