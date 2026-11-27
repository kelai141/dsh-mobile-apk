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
import { forwardControlClick } from './activation-guard.ts'

/** Marks the upstream version row as an insertion point for About. */
const HANDLED = 'data-dsh-about-source'
/** 我们插入的入口标记，避免重复插入。 */
const ENTRY = 'data-dsh-about-entry'

/** Recognize the upstream version label before inserting the entry. */
const VERSION_LABEL = /^(?:当前版本|current version)\s*[:：]\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/i
const GENERAL_ITEM_ROW = '[data-slot="settings.general.item"] > div'

/**
 * 是否已经成功接管过（内联入口插进去过一次）。
 *
 * 导航行的收起判据用它而不是「此刻页面上有没有入口」：回到一级列表时分区内容不渲染，
 * 内联入口自然不在 DOM 里，若按后者判断就会把导航行放出来——用户反馈「关于又出现在
 * 一级列表里」。只有从未接管成功（精确文案没找到）时才保留导航行作为兜底入口。
 */
let entryInstalled = false

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
    // 入口可见，实际分区按钮隐藏；明确转发这一次用户点击。
    forwardControlClick(button)
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
    const versionRows = [...scope.querySelectorAll<HTMLElement>(GENERAL_ITEM_ROW)]
      .filter((node) => node.children.length === 0)

    syncNavRow(scope)

    // 第一步：修已处理节点。React 重渲染会把 style 写回原值，只认标记不认样式的话
    // 上游版本行会「复活」，界面上就变成版本行 + 关于入口同时出现。
    for (const node of versionRows) {
      if (!node.hasAttribute(HANDLED)) continue
      ensureEntry(node)
    }
    syncNavRow(scope)

    // App Updates may use the same label. Only the General item slot owns this insertion point.
    const fresh = versionRows.find(node => !node.hasAttribute(HANDLED) && VERSION_LABEL.test(node.textContent?.trim() ?? ''))
    if (fresh === undefined) return
    fresh.setAttribute(HANDLED, '')
    ensureEntry(fresh)
    syncNavRow(scope)
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
    // A fresh module recovers the handled row through ensureEntry on installation.
  }
}
