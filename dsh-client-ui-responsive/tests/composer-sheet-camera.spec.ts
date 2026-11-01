// @vitest-environment jsdom
// 加号面板「拍照」走原生相机（issue #1288 第 4 条）。
//
// 判据全部落在**真实调用**上，不看肉眼看文案：
//   ① 点「拍照」必须真的调用 `window.androidBridge.capturePhoto('capture')`；
//   ② 全程不得有任何 `HTMLInputElement` 被 click（给原型打桩计数）——
//      这正是缺陷形态：旧实现给 hidden file input 叠 capture 再点它，拉起的是图库；
//   ③ 失败回执按壳侧错误码给出对应文案（camera-unavailable / camera-busy / camera-failed），
//      且**不回退**去点 file input；
//   ④ 回执回调挂在**注入层那个** `window.__dshBridge` 上（不新建、不整体赋值——
//      那会顶掉 PICKER_SCRIPT 的目录选择轮询）；
//   ⑤ 「照片」「本地文件」两块仍走 file input（回归：别把另外两条路也一起改了）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ComposerSheet } from '../src/client/mobile/composer-sheet.ts'
import { zh } from '../src/client/mobile/composer-sheet.locales.ts'

const TILE = '[data-dsh-composer-sheet-tile]'
const STATUS = '[data-dsh-composer-sheet-status]'
const ADD = '[data-composer-card] button[aria-haspopup="listbox"]'

/** 上游合成器卡片（只有一个「+」和一颗 hidden multiple file input）。 */
function buildCard(): { add: HTMLButtonElement; input: HTMLInputElement } {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  const add = document.createElement('button')
  add.type = 'button'
  add.setAttribute('aria-haspopup', 'listbox')
  add.setAttribute('aria-expanded', 'false')
  card.append(add)
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.hidden = true
  card.append(input)
  document.body.append(card)
  return { add, input }
}

/** 桥桩：记录每次调用的 (action)，按 order 逐次返回给定载荷。 */
function installBridge(replies: readonly string[]): { calls: string[] } {
  const calls: string[] = []
  const capturePhoto = (action: string): string => {
    calls.push(action)
    const next = replies[Math.min(calls.length - 1, replies.length - 1)] ?? ''
    return next
  }
  ;(window as unknown as { androidBridge?: unknown }).androidBridge = { capturePhoto }
  return { calls }
}

/**
 * 注入层 `__dshBridge`（host-web-compat 的 PICKER_SCRIPT 在 <head> 里建的那个）。
 *
 * 夹具照抄它的形状：**已存在**、带 onDirectoryPicked。判据要看的是「我们只增属性、
 * 不整体赋值」——所以身份与既有成员都必须活到最后。
 */
function installPickerBridge(): Record<string, unknown> {
  const host: Record<string, unknown> = { onDirectoryPicked: () => undefined, onPermissionRequired: () => undefined }
  ;(window as unknown as { __dshBridge?: unknown }).__dshBridge = host
  return host
}

/** 点「拍照」并等微任务收敛（回执同步派发时也要让 rAF 路径跑完）。 */
async function clickCamera(): Promise<void> {
  const camera = [...document.querySelectorAll<HTMLElement>(TILE)]
    .find(tile => tile.getAttribute('data-dsh-composer-sheet-tile') === 'camera')
  expect(camera, '面板里必须有「拍照」瓦片').toBeDefined()
  camera!.click()
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
}

function statusText(): string {
  return (document.querySelector(STATUS)?.textContent ?? '').trim()
}

let sheet: ComposerSheet
/** HTMLInputElement.click 的调用记录（跨用例累计清零）。 */
let inputClicks: string[]

beforeEach(() => {
  document.body.innerHTML = ''
  inputClicks = []
  // 判据 ②：任何 file input 被点 ⇒ 记下来。原型打桩而不是逐节点打桩，
  // 因为「换一颗 input 点」正是旧实现能绕过单节点断言的方式。
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    inputClicks.push(this.type)
  })
  // 注入中文翻译器：jsdom 的 navigator.language 是 en-US，走本地字典兜底会得到英文。
  // 文案断言要确定，就用插件主体真正的注入点（ComposerSheet.setTranslate 的同一个 seam）。
  sheet = new ComposerSheet((key) => zh[key])
})

afterEach(() => {
  sheet.detach()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  delete (window as unknown as { androidBridge?: unknown }).androidBridge
  delete (window as unknown as { __dshBridge?: unknown }).__dshBridge
})

async function openSheet(): Promise<void> {
  sheet.attach()
  document.querySelector<HTMLElement>(ADD)!.click()
  // 打开是同步挂面板 + 异步读上游菜单；这里只等面板出现。
  await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
  expect(document.querySelector(STATUS), '面板必须有 role=status 的回执位').not.toBeNull()
}

describe('「拍照」走原生相机（#1288 第 4 条）', () => {
  it('① 点「拍照」真的调用 androidBridge.capturePhoto("capture")', async () => {
    installPickerBridge()
    const bridge = installBridge(['{"ok":true,"accepted":true}'])
    buildCard()
    await openSheet()
    await clickCamera()
    expect(bridge.calls).toEqual(['capture'])
  })

  it('② 拍照全程不点任何 file input（这正是拉起图库的那一步）', async () => {
    installPickerBridge()
    installBridge(['{"ok":true,"accepted":true}'])
    const { input } = buildCard()
    await openSheet()
    await clickCamera()
    expect(inputClicks).toEqual([])
    // 也不得给 input 留下 capture 属性（旧实现会给它设 environment）
    expect(input.getAttribute('capture')).toBeNull()
  })

  it('失败回执按壳侧错误码给对应文案，且不回退图库', async () => {
    const host = installPickerBridge()
    installBridge(['{"ok":true,"accepted":true}'])
    buildCard()
    await openSheet()
    await clickCamera()
    const receipt = host['onPhotoCaptured']
    expect(typeof receipt, '回执必须挂在注入层既有对象上').toBe('function')

    for (const [code, copy] of [
      ['camera-unavailable', zh.photoUnavailable],
      ['camera-busy', zh.photoBusy],
      ['camera-failed', zh.photoFailed],
    ] as const) {
      ;(receipt as (payload: string) => void)(JSON.stringify({ ok: false, code, message: 'shell copy' }))
      expect(statusText()).toBe(copy)
      // 每报一次码都不许伴随一次 file input 点击
      expect(inputClicks).toEqual([])
    }
  })

  it('成功回执只说「已拍照，正在加入会话」', async () => {
    const host = installPickerBridge()
    installBridge(['{"ok":true,"accepted":true}'])
    buildCard()
    await openSheet()
    await clickCamera()
    ;(host['onPhotoCaptured'] as (payload: string) => void)(
      JSON.stringify({ ok: true, path: '/tmp/a.jpg', mime: 'image/jpeg', bytes: 10, longEdge: 100 }),
    )
    expect(statusText()).toBe(zh.photoAccepted)
    expect(inputClicks).toEqual([])
  })

  it('回执回调只增属性，不整体赋值注入层的 __dshBridge（否则目录选择轮询整段失效）', async () => {
    const host = installPickerBridge()
    installBridge(['{"ok":true,"accepted":true}'])
    buildCard()
    await openSheet()
    await clickCamera()
    // 身份未变：被整体赋值过的话这里会换成另一个对象
    expect((window as unknown as { __dshBridge?: unknown }).__dshBridge).toBe(host)
    // 既有成员还在（整体赋值会顶掉 onDirectoryPicked）
    expect(typeof host['onDirectoryPicked']).toBe('function')
  })

  it('同步失败（not-wired）如实提示未接线，不静默', async () => {
    installPickerBridge()
    installBridge(['{"ok":false,"code":"not-wired"}'])
    buildCard()
    await openSheet()
    await clickCamera()
    expect(statusText()).toBe(zh.photoNotWired)
    expect(inputClicks).toEqual([])
  })

  it('完全没有桥时如实说未接线，不回退 file input', async () => {
    // 不装 androidBridge
    buildCard()
    await openSheet()
    await clickCamera()
    expect(statusText()).toBe(zh.photoNotWired)
    expect(inputClicks).toEqual([])
  })

  it('⑤ 回归：「照片」「本地文件」两块仍走 file input', async () => {
    installPickerBridge()
    installBridge(['{"ok":true,"accepted":true}'])
    const { input } = buildCard()
    await openSheet()

    const pick = (kind: string): void => {
      const tile = [...document.querySelectorAll<HTMLElement>(TILE)]
        .find(node => node.getAttribute('data-dsh-composer-sheet-tile') === kind)
      tile!.click()
    }

    pick('photo')
    expect(inputClicks).toEqual(['file'])
    expect(input.getAttribute('accept')).toBe('image/*')
    // 照片**不得**再叠 capture（旧实现的影响：那会让「照片」也带直采语义）
    expect(input.getAttribute('capture')).toBeNull()

    inputClicks = []
    await openSheet()
    pick('file')
    expect(inputClicks).toEqual(['file'])
  })
})
