// @vitest-environment jsdom
// @ 菜单「添加 N 项」的在途标志必须随 detach 复位（issue #1527）。
//
// ## 缺陷形态
// `busy` 只在 `addSelected` 的 finally 里复位，而整段插入是异步的（每项最长 1500+600ms）。
// 在途时关掉面板 → `detach()` → 重新打开并 re-attach（enhancer 实例被复用）：
//   - `busy` 恒 true，`onMenuClick` 的 `if (this.busy) return` 挡掉每一次点击；
//   - 而底部条是 `clearState()` 撤掉、re-attach 后 `renderBar()` **新建**的按钮 —— 新按钮是
//     enabled 的、没有 aria-busy。于是「按钮看着能用、点下去什么都不发生」，且没有任何提示。
// 判据只能落在行为上：源码里有没有那句 `this.busy = false` 不是用户能观察的事实。
//
// ## 判据
//   1 在途事实：第一次点「添加」之后按钮确实 disabled + aria-busy（证明夹具真的造出了在途窗口）；
//   2 重挂事实：detach → attach 之后底部条是**新节点**、且 enabled、无 aria-busy；
//   3 核心判据：重挂后点「添加」必须真的起一条新的插入链（上游 settle-pick 被再次驱动）；
//   4 旧链收尾不得抹掉新链的在途标志（旧链的 finally 只对它自己那条链生效）。
//
// ## 负控
//   NC1 去掉 `detach()` 里的 `this.busy = false`（#1527 的原缺陷）-> 用例 3 红（第二次点击什么都不做）。
//   NC2 去掉 `addSelected` 里的代次守卫（finally 无条件复位）-> 用例 4 红（旧链收尾把新链的
//       disabled/aria-busy 抹掉，双击又能起第三条链 —— #1404 的重复插入原样复发）。
//
// ## 夹具
// 上游 settle-pick 用「行被派发 mousedown」代表，这是插件驱动上游的唯一动作
// （`pickByKey` 里 `row.dispatchEvent(new MouseEvent('mousedown'))`）；插入是否「仍在途」
// 由上游等待窗口决定，这里用真实计时器跑（每项 600ms），不伪造时间。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ReferenceMenuEnhancer } from '../src/client/mobile/reference-menu.ts'

const BAR = '[data-dsh-ref-bar]'
const ADD = '[data-dsh-ref-add]'
const ROW = '[data-trigger-menu] [role="option"]'

let enhancer: ReferenceMenuEnhancer
/** 上游 settle-pick 被驱动的次数（每次 = 插件对某一行派发了 mousedown）。 */
let picks = 0

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function flush(): Promise<void> {
  return new Promise((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }) })
}

/** 上游菜单形状：listbox + 若干引用源行（id 前缀决定触发源门）。 */
function buildMenu(labels: string[]): void {
  const menu = document.createElement('div')
  menu.setAttribute('data-trigger-menu', '')
  const list = document.createElement('div')
  list.setAttribute('role', 'listbox')
  for (const [index, label] of labels.entries()) {
    const row = document.createElement('button')
    row.setAttribute('role', 'option')
    row.id = 'dsh-slash-option-reference-' + String(index)
    const name = document.createElement('span')
    name.className = 'x_itemName'
    name.textContent = label
    // 计数点：插件 pickByKey 对行派发 mousedown 就是「这一行被交给上游插入」。
    row.addEventListener('mousedown', () => { picks += 1 })
    list.append(row)
  }
  menu.append(list)
  document.body.append(menu)
}

function composer(): void {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  card.append(editable)
  document.body.append(card)
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(ROW))
}

/** 点一行的复选框（jsdom 无 PointerEvent，与既有 spec 同一写法）。 */
function tap(row: HTMLElement): void {
  row.querySelector('[data-dsh-ref-check]')?.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
  )
}

function addButton(): HTMLButtonElement {
  const add = document.querySelector<HTMLButtonElement>(ADD)
  expect(add, '底部条的「添加」按钮必须存在').not.toBeNull()
  return add!
}

beforeEach(async () => {
  picks = 0
  document.documentElement.setAttribute('data-dsh-mobile-form', '')
  composer()
  buildMenu(['sub/', 'alpha.txt', 'beta.txt'])
  enhancer = new ReferenceMenuEnhancer()
})

afterEach(() => {
  enhancer.detach()
  document.documentElement.removeAttribute('data-dsh-mobile-form')
  document.body.innerHTML = ''
})

describe('@ 菜单在途标志随 detach 复位（issue #1527）', () => {
  it('在途时 detach 再 attach：按钮恢复可用，且点下去真的起一条新插入链', async () => {
    enhancer.attach()
    await flush()
    tap(rows()[0])
    expect(document.querySelector(BAR), '勾选后必须出现底部条').not.toBeNull()

    // ---- 造出在途窗口：第一项的上游等待是 600ms ----
    const first = addButton()
    first.click()
    await sleep(80)
    // 判据 1：在途事实（没有这条，后面「重挂后能点」可能只是没进过在途态）。
    expect(first.disabled, '在途期间按钮必须 disabled').toBe(true)
    expect(first.getAttribute('aria-busy')).toBe('true')
    expect(picks, '第一条链必须已经开始驱动上游').toBe(1)

    // ---- 在途时关面板：detach -> 重新打开 -> re-attach（同一个实例） ----
    enhancer.detach()
    enhancer.attach()
    await flush()
    // 判据 2：底部条已被 clearState 撤掉，重挂后是新节点，且**看着可用**。
    tap(rows()[1])
    tap(rows()[2])
    await flush()
    const second = addButton()
    expect(second, '重挂后底部条必须重建（不是旧节点复活）').not.toBe(first)
    expect(second.disabled, '重挂后的新按钮不该带旧链的在途态').toBe(false)
    expect(second.hasAttribute('aria-busy')).toBe(false)

    // ---- 判据 3（核心）：点击必须真的起新链，而不是被旧的 busy 挡掉 ----
    second.click()
    await sleep(80)
    expect(picks, '重挂后点「添加」必须真的驱动上游（旧 busy 不得挡住点击）').toBe(2)
    expect(second.disabled, '新链在途时按钮必须重新 disabled').toBe(true)
    expect(second.getAttribute('aria-busy')).toBe('true')

    // ---- 判据 4：旧链（1 项，600ms 窗口）此刻已收尾，但它不得抹掉新链的在途标志 ----
    await sleep(700)
    expect(second.disabled, '旧链收尾不得复位新链的在途标志').toBe(true)
    expect(second.getAttribute('aria-busy')).toBe('true')
  })
})
