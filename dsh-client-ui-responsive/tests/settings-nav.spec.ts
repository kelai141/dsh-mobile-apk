// @vitest-environment jsdom
// 0.14.7-B：设置中心竖屏分层（首页分类 -> 二级页）。
//
// 现场：竖屏此前把 nav 排成横向标签行，与内容同屏，宽标签被裁掉（设备截图「手机控…」）。
// 判据分三层：
//  1. 结构：面板拿到 data-dsh-settings-level，首页只显示列表、二级页只显示内容；
//  2. 行为：点一级行进入二级页、点返回逐级退回、首页返回才真的关设置；
//  3. 边界：横屏（缺手机形态标记）一个字节都不写；我方自有分区才有短说明，第三方/上游行只有
//     上游原本的 icon + label；返回首页不重建内容列（未保存的编辑不丢）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { MobileSettingsNav } from '../src/client/mobile/settings-nav.ts'

/** 我方 index.ts 里 settings.section 注册的 label（真源；下面的漂移用例直接读它）。 */
function ownRegisteredLabels(): string[] {
  const source = readFileSync('src/client/index.ts', 'utf8')
  return source
    .split("ctx.slots.inject('settings.section'")
    .slice(1)
    // Labels are bilingual now: `() => tr('中文', 'English')`; the key stays the Chinese one.
    .map(block =>
      block.match(/label:\s*\(\)\s*=>\s*tr\('([^']+)'/)?.[1]
        ?? block.match(/label:\s*\(\)\s*=>\s*'([^']+)'/)?.[1],
    )
    .filter((label): label is string => label !== undefined)
}

interface PanelHandle {
  overlay: HTMLElement
  panel: HTMLElement
  mask: HTMLElement
  content: HTMLElement
  rows: Map<string, HTMLButtonElement>
  maskClicks: () => number
}

/** 按上游 SettingsRoot 的真实结构造面板（nav 标题 + nav 列表 + 内容列；蒙层是面板的兄弟节点）。 */
function buildPanel(labels: readonly string[], activeLabel?: string): PanelHandle {
  document.body.innerHTML = ''
  const overlay = document.createElement('div')
  const mask = document.createElement('div')
  mask.setAttribute('aria-hidden', 'true')
  let maskClicks = 0
  mask.addEventListener('click', () => { maskClicks += 1 })
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-modal', 'true')
  panel.setAttribute('data-dsh-settings-dialog', '')

  const nav = document.createElement('nav')
  const navTitle = document.createElement('div')
  navTitle.textContent = '设置'
  const navList = document.createElement('div')
  const rows = new Map<string, HTMLButtonElement>()
  for (const label of labels) {
    const button = document.createElement('button')
    button.type = 'button'
    // 上游 navIcon(row.id)：每行一个 svg，未知 id 降级通用齿轮——这里只放一个占位 svg。
    button.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    if (label === activeLabel) button.setAttribute('aria-current', 'true')
    // 上游 onSelect：把 aria-current 挪到被点的行上（真源仍是上游，本模块只读）。
    button.addEventListener('click', () => {
      for (const other of navList.querySelectorAll('button')) other.removeAttribute('aria-current')
      button.setAttribute('aria-current', 'true')
    })
    navList.appendChild(button)
    rows.set(label, button)
  }
  nav.append(navTitle, navList)
  const content = document.createElement('div')
  const contentHeader = document.createElement('div')
  const options = document.createElement('div')
  // 内容列里放一个「编辑中的输入框」：返回首页后它必须还是同一个节点、同一个值。
  const input = document.createElement('input')
  input.value = '编辑中'
  options.appendChild(input)
  content.append(contentHeader, options)
  panel.append(nav, content)
  overlay.append(mask, panel)
  document.body.appendChild(overlay)
  return { overlay, panel, mask, content, rows, maskClicks: () => maskClicks }
}

function setPhoneForm(on: boolean): void {
  if (on) document.documentElement.setAttribute('data-dsh-mobile-form', '')
  else document.documentElement.removeAttribute('data-dsh-mobile-form')
}

/** MutationObserver 与 queueMicrotask 都在微任务里投递，等一拍即可看到收敛结果。 */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function back(panel: HTMLElement): HTMLButtonElement {
  const button = panel.querySelector<HTMLButtonElement>('[data-dsh-settings-back]')
  expect(button, '返回控件必须在场').not.toBeNull()
  return button!
}

let nav: MobileSettingsNav | undefined

beforeEach(() => {
  setPhoneForm(true)
})

afterEach(() => {
  nav?.detach()
  nav = undefined
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-dsh-mobile-form')
})

describe('设置首页：分类列表', () => {
  it('手机形态下把面板标成首页，并保留上游渲染顺序与图标', async () => {
    const handle = buildPanel(['通用设置', '模型', '开发者选项', '手机控制', '通知'])
    nav = new MobileSettingsNav()
    nav.attach()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
    const rows = [...handle.panel.querySelectorAll('nav div:nth-child(2) > button')]
    expect(rows.map(row => row.querySelector('span')!.textContent)).toEqual(
      ['通用设置', '模型', '开发者选项', '手机控制', '通知'])
    // 每行仍是上游那个按钮 + 上游那个 svg 图标，外加我方一条装饰箭头。
    for (const row of rows) expect(row.querySelector('svg')).not.toBeNull()
  })

  it('一级行带标题 + 一行短说明 + 箭头；后续注册的行补插也照样收敛', async () => {
    const handle = buildPanel(['通用设置', '开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    expect(handle.rows.get('开发者选项')!.querySelector('[data-dsh-settings-nav-desc]')).not.toBeNull()
    const added = document.createElement('button')
    added.type = 'button'
    added.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
    const span = document.createElement('span')
    span.textContent = '第三方插件页'
    added.appendChild(span)
    handle.panel.querySelector('nav div:nth-child(2)')!.appendChild(added)
    await settle()
    expect(added.getAttribute('data-dsh-settings-nav')).toBe('other')
    expect(added.querySelector('[data-dsh-settings-nav-chevron]')).not.toBeNull()
    expect(added.querySelector('[data-dsh-settings-nav-desc]')).toBeNull()
  })

  it('首页返回控件 = 关设置：点它走的是上游蒙层那条关闭路径', () => {
    const handle = buildPanel(['通用设置'])
    nav = new MobileSettingsNav()
    nav.attach()
    back(handle.panel).click()
    expect(handle.maskClicks()).toBe(1)
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
  })

  it('首页的 Escape 不拦：那是上游关设置的路径', () => {
    const handle = buildPanel(['通用设置'])
    nav = new MobileSettingsNav()
    nav.attach()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handle.panel.dispatchEvent(escape)
    expect(escape.defaultPrevented, '首页不得吞掉 Escape').toBe(false)
  })
})

describe('重新打开设置后不沿用旧历史', () => {
  it('上次在 A 页、这次从列表进 B 页后，返回直接回列表（不跳到 A）', async () => {
    const first = buildPanel(['通用设置', '开发者选项'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    first.rows.get('通用设置')!.click()
    await settle()
    first.rows.get('开发者选项')!.click()
    await settle()
    nav.detach()

    // 关闭后重新打开：新面板、新实例（与真实关闭/重开一致）
    const second = buildPanel(['通用设置', '开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    second.rows.get('开发者选项')!.click()
    await settle()
    back(second.panel).click()
    await settle()
    expect(second.panel.getAttribute('data-dsh-settings-level'), '应直接回列表').toBe('home')
  })
})

describe('从列表进入任意分区后返回，应回到列表（不得跳去通用设置）', () => {
  it('进入「开发者选项」后返回 -> home，而不是停在通用设置', async () => {
    // 上游默认把第一行（通用设置）标成 aria-current，进详情页后它才挪到目标行。
    // 过渡期若照常记账，会把通用设置误记成「上一页」——真机表现为从任何二级页返回都跳通用设置。
    const handle = buildPanel(['通用设置', '开发者选项'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    await settle()
    handle.rows.get('开发者选项')!.click()
    await settle()
    back(handle.panel).click()
    await settle()
    expect(handle.panel.getAttribute('data-dsh-settings-level'), '应回到列表').toBe('home')
  })
})

describe('系统返回（蒙层 / Escape）也按上一页回退', () => {
  it('A → B 后点蒙层，回到 A 而不是列表', async () => {
    const handle = buildPanel(['通用设置', '关于'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('通用设置')!.click()
    await settle()
    handle.rows.get('关于')!.click()
    await settle()
    handle.mask.click()
    await settle()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('detail')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('通用设置')
  })

  it('A → B 后按 Escape，回到 A 而不是列表', async () => {
    const handle = buildPanel(['通用设置', '关于'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('通用设置')!.click()
    await settle()
    handle.rows.get('关于')!.click()
    await settle()
    handle.panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('detail')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('通用设置')
  })
})

describe('二级页之间跳转与逐页返回', () => {
  it('详情页里换到另一个分区后，返回回到上一页而不是列表', async () => {
    const handle = buildPanel(['通用设置', '关于'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('通用设置')!.click()
    await settle()
    // 详情页里切到「关于」（入口就是这么做的：点一下导航行）
    handle.rows.get('关于')!.click()
    await settle()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('detail')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('关于')

    back(handle.panel).click()
    await settle()
    // 回到「通用设置」这一页，而不是一级列表
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('detail')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('通用设置')

    // 再返一次才回列表
    back(handle.panel).click()
    await settle()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
  })
})

describe('打开设置时不把默认选中画成高亮', () => {
  it('刚打开时面板带 fresh 标记，aria-current 原样保留', async () => {
    const handle = buildPanel(['通用设置', '开发者选项'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    await settle()
    expect(handle.panel.hasAttribute('data-dsh-settings-fresh')).toBe(true)
    // 语义不动：上游的默认选中仍在（返回焦点与标题跟随依赖它）
    expect(handle.rows.get('通用设置')!.getAttribute('aria-current')).toBe('true')
  })

  it('用户点过一次后撤掉 fresh，点击高亮恢复', async () => {
    const handle = buildPanel(['通用设置', '开发者选项'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    await settle()
    handle.rows.get('开发者选项')!.click()
    await settle()
    expect(handle.panel.hasAttribute('data-dsh-settings-fresh')).toBe(false)
    expect(handle.rows.get('开发者选项')!.getAttribute('aria-current')).toBe('true')
  })
})

describe('二级页：点一级分类进入', () => {
  it('点任意一级行进入二级页，标题取该行的注册名，焦点落到返回控件', () => {
    const handle = buildPanel(['通用设置', '开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('开发者选项')!.click()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('detail')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('开发者选项')
    expect(document.activeElement).toBe(back(handle.panel))
  })

  it('第三方行也能进入二级页，标题用上游注册名（不新造名字）', () => {
    const handle = buildPanel(['第三方插件页'])
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('第三方插件页')!.click()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('detail')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('第三方插件页')
  })

  it('没点一级行时保持在首页（点内容列 / 空白处不误进二级页）', () => {
    const handle = buildPanel(['通用设置'])
    nav = new MobileSettingsNav()
    nav.attach()
    handle.content.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
  })

  it('首页标题 = 设置外壳自己的标题（不是上游兜底选中的第一行）', () => {
    // 上游对 active 有兜底：activeId 未落定时会选中第一行。拿它当首页标题会写成「通用设置」，
    // 用户以为自己已经在某个分区里。首页标题必须是外壳标题（settings.header 插槽那段）。
    const handle = buildPanel(['通用设置', '模型'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('设置')
  })

  it('二级页标题跟随上游 aria-current（语言切换后仍取上游当时的注册名）', async () => {
    const handle = buildPanel(['通用设置'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('通用设置')!.click()
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('通用设置')
    // 上游把当前分区的 label 换成另一种语言（locale 变化会重建行）：标题必须跟着走。
    const label = handle.rows.get('通用设置')!.querySelector('span')!
    label.textContent = 'General'
    handle.rows.get('通用设置')!.setAttribute('aria-current', 'true')
    await settle()
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('General')
  })
})

describe('逐级返回', () => {
  it('returns focus to a visible row when the active About row is hidden', () => {
    const handle = buildPanel(['通用设置', '关于'])
    nav = new MobileSettingsNav()
    nav.attach()
    const about = handle.rows.get('关于')!
    about.style.display = 'none'
    about.click()
    back(handle.panel).click()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
    expect(document.activeElement).toBe(handle.rows.get('通用设置'))
    expect(about.getAttribute('aria-current')).toBe('true')
  })

  it('二级页返回 -> 首页，焦点回到当前一级行，内容列节点原样（未保存编辑不丢）', () => {
    const handle = buildPanel(['开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    const input = handle.content.querySelector('input')!
    input.value = '写了一半'
    handle.rows.get('开发者选项')!.click()
    back(handle.panel).click()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent, '回到首页标题必须变回外壳标题').toBe('设置')
    expect(handle.content.querySelector('input')).toBe(input)
    expect((handle.content.querySelector('input') as HTMLInputElement).value).toBe('写了一半')
    expect(document.activeElement).toBe(handle.rows.get('开发者选项'))
    expect(handle.maskClicks(), '二级页返回不得关掉设置').toBe(0)
  })

  it('二级页的 Escape 只退回首页，不关设置', () => {
    const handle = buildPanel(['开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('开发者选项')!.click()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    handle.panel.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(true)
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
    expect(handle.maskClicks()).toBe(0)
  })

  // Android 返回逐级（detail -> home -> 关闭）不是靠新增返回栈层，而是靠 back-stack 的 dialog 层
  // 点蒙层这一步在本层被翻译成「降一级」；首页再按一次才落到 dialog 层真的关闭设置。
  it('二级页里点蒙层（系统返回的 dialog 层路径）只降一级，不关设置；首页再点一次才关', () => {
    const handle = buildPanel(['开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('开发者选项')!.click()
    // 第一次返回：dialog 层点蒙层 -> 只降一级。
    handle.mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(handle.panel.getAttribute('data-dsh-settings-level'), '二级页的返回必须落回首页').toBe('home')
    expect(handle.maskClicks(), '这一下不得真的关掉设置').toBe(0)
    // 第二次返回：已在首页，蒙层关闭照常放行给上游。
    handle.mask.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(handle.maskClicks(), '首页的返回才关闭设置').toBe(1)
  })

  it('返回首页 -> 再进二级页：仍是同一个内容列（不重挂载），可反复往返', () => {
    const handle = buildPanel(['手机控制'])
    nav = new MobileSettingsNav()
    nav.attach()
    const row = handle.rows.get('手机控制')!
    const content = handle.content
    for (let round = 0; round < 3; round += 1) {
      row.click()
      expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('detail')
      back(handle.panel).click()
      expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')
    }
    expect(handle.panel.lastElementChild).toBe(content)
    expect(handle.panel.querySelectorAll('[data-dsh-settings-back]')).toHaveLength(1)
  })

  // 真机 bug（0.14.9）：反复往返时的「串页」。上面的用例每轮进的是**同一个**分区，
  // 所以看不出来；换成两个不同分区就能暴露 —— 第二遍返回会先弹回上一次打开过的二级页。
  it('进 A 返回、再进 B 返回：两次都必须直接回首页，不得跳回上一次的分区', async () => {
    const handle = buildPanel(['通用设置', '关于'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('通用设置')!.click()
    await settle()
    back(handle.panel).click()
    await settle()
    expect(handle.panel.getAttribute('data-dsh-settings-level')).toBe('home')

    handle.rows.get('关于')!.click()
    await settle()
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('关于')
    back(handle.panel).click()
    await settle()
    expect(handle.panel.getAttribute('data-dsh-settings-level'), '不得弹回上一次的「通用设置」').toBe('home')
    expect(handle.panel.querySelector('[data-dsh-settings-bar-title]')!.textContent).toBe('设置')
  })

  it('同一分区连进两轮，第二轮返回也必须直接回首页', async () => {
    const handle = buildPanel(['通用设置', '关于'], '通用设置')
    nav = new MobileSettingsNav()
    nav.attach()
    for (let round = 0; round < 2; round += 1) {
      handle.rows.get('通用设置')!.click()
      await settle()
      back(handle.panel).click()
      await settle()
      expect(handle.panel.getAttribute('data-dsh-settings-level'), '第 ' + (round + 1) + ' 轮').toBe('home')
    }
  })
})

describe('形态与生命周期边界', () => {
  it('反证：横屏（无手机形态标记）本模块一个属性、一个节点都不写', () => {
    setPhoneForm(false)
    const handle = buildPanel(['通用设置'])
    nav = new MobileSettingsNav()
    nav.attach()
    expect(handle.panel.hasAttribute('data-dsh-settings-level')).toBe(false)
    expect(handle.panel.querySelector('[data-dsh-settings-back]')).toBeNull()
    expect(handle.panel.querySelector('[data-dsh-settings-nav-desc]')).toBeNull()
    expect(handle.panel.querySelector('[data-dsh-settings-nav-chevron]')).toBeNull()
    // 且不拦任何点击：上游照旧。
    handle.rows.get('通用设置')!.click()
    expect(handle.panel.hasAttribute('data-dsh-settings-level')).toBe(false)
  })

  it('面板被上游重挂载（新节点）时：注入物收回，层级复位到首页', async () => {
    const handle = buildPanel(['通用设置'])
    nav = new MobileSettingsNav()
    nav.attach()
    handle.rows.get('通用设置')!.click()
    const rebuilt = buildPanel(['通用设置'])
    await settle()
    expect(handle.panel.hasAttribute('data-dsh-settings-level'), '旧面板的标记必须收干净').toBe(false)
    expect(handle.panel.querySelector('[data-dsh-settings-back]')).toBeNull()
    expect(rebuilt.panel.getAttribute('data-dsh-settings-level')).toBe('home')
    expect(rebuilt.panel.querySelectorAll('[data-dsh-settings-back]')).toHaveLength(1)
  })

  it('设置关闭（面板离开 DOM）后不留任何注入节点', async () => {
    const handle = buildPanel(['通用设置', '开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    handle.overlay.remove()
    await settle()
    expect(document.querySelectorAll('[data-dsh-settings-back], [data-dsh-settings-nav-desc]')).toHaveLength(0)
  })

  it('detach 收回全部注入物并把 DOM 还原成上游原样', () => {
    const handle = buildPanel(['通用设置', '开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    nav.detach()
    expect(handle.panel.hasAttribute('data-dsh-settings-level')).toBe(false)
    expect(handle.panel.querySelectorAll('[data-dsh-settings-back], [data-dsh-settings-bar]')).toHaveLength(0)
    expect(handle.panel.querySelectorAll('[data-dsh-settings-nav-desc], [data-dsh-settings-nav-chevron]')).toHaveLength(0)
    expect(handle.panel.querySelectorAll('[data-dsh-settings-nav]')).toHaveLength(0)
    expect(handle.panel.querySelector('nav div:nth-child(2) > button svg')).not.toBeNull()
    nav = undefined
  })
})

describe('短说明的归属（D4/D5）', () => {
  it('index.ts 注册的每个我方自有分区都拿到短说明（表与注册漂移会当场变红）', async () => {
    const labels = ownRegisteredLabels()
    expect(labels.length, 'index.ts 里必须能读出我方自有分区').toBeGreaterThan(0)
    const handle = buildPanel(labels)
    nav = new MobileSettingsNav()
    nav.attach()
    for (const label of labels) {
      const row = handle.rows.get(label)!
      expect(row.getAttribute('data-dsh-settings-nav'), label + ' 应被认作我方自有分区').toBe('own')
      const desc = row.querySelector('[data-dsh-settings-nav-desc]')
      expect(desc, label + ' 必须有一行短说明').not.toBeNull()
      expect((desc!.textContent ?? '').length, label + ' 的说明必须是一行短说明').toBeGreaterThan(0)
      // 说明是补充信息：读屏读到的仍是上游注册名，说明本身不进可访问名。
      expect(desc!.getAttribute('aria-hidden')).toBe('true')
    }
    expect(labels).toContain('开发者选项')
    expect(labels).toContain('手机控制')
    expect(labels).toContain('通知')
  })

  it('反证：上游与第三方行一个字都不改（无说明、label 原样、不隐藏）', () => {
    const handle = buildPanel(['通用设置', '模型', '第三方插件页'])
    nav = new MobileSettingsNav()
    nav.attach()
    for (const label of ['通用设置', '模型', '第三方插件页']) {
      const row = handle.rows.get(label)!
      expect(row.getAttribute('data-dsh-settings-nav'), label + ' 不是我方自有分区').toBe('other')
      expect(row.querySelector('[data-dsh-settings-nav-desc]')).toBeNull()
      expect(row.querySelector('span')!.textContent).toBe(label)
      expect(row.hasAttribute('hidden')).toBe(false)
      expect((row as HTMLButtonElement).style.display).toBe('')
    }
  })
})

describe('一级行的图标（只装饰我方自有分区）', () => {
  /** 一行的图标几何指纹：可见 svg 的 viewBox + 各 path 的 d。 */
  function iconFingerprint(row: HTMLButtonElement): string {
    const svg = row.querySelector('svg[data-dsh-settings-nav-icon]')
    expect(svg, '我方自有分区行必须有本分区图标').not.toBeNull()
    const ds = [...svg!.querySelectorAll('path')].map(path => path.getAttribute('d')).join('|')
    return svg!.getAttribute('viewBox') + '::' + ds
  }

  it('三个自有 id 各行图标互不相同（否则用户无法凭图标区分分类）', () => {
    const handle = buildPanel(['开发者选项', '手机控制', '通知'])
    nav = new MobileSettingsNav()
    nav.attach()
    const fingerprints = [...handle.rows.keys()].map(label => iconFingerprint(handle.rows.get(label)!))
    expect(new Set(fingerprints).size, '三个分类的图标必须两两不同').toBe(3)
  })

  it('未知 id 仍是上游降级图标（我方图标只覆盖自己的行）', () => {
    const handle = buildPanel(['开发者选项', '第三方插件页'])
    nav = new MobileSettingsNav()
    nav.attach()
    // 我方行：上游那个（齿轮）被隐藏，只留一个我方图标。
    const own = handle.rows.get('开发者选项')!
    expect(own.querySelectorAll('svg[data-dsh-settings-nav-icon]')).toHaveLength(1)
    expect(own.querySelectorAll('svg[data-dsh-settings-nav-icon-hidden]')).toHaveLength(1)
    // 第三方行：上游图标原样，且没有我方图标、没有被隐藏。
    const other = handle.rows.get('第三方插件页')!
    expect(other.querySelector('svg[data-dsh-settings-nav-icon]'), '第三方行不得被我方图标覆盖').toBeNull()
    expect(other.querySelector('svg[data-dsh-settings-nav-icon-hidden]')).toBeNull()
    expect(other.querySelector('svg'), '第三方行必须保留上游那个 svg').not.toBeNull()
  })

  it('detach 之后上游图标原样恢复（我方图标收回且隐藏标记去掉）', () => {
    const handle = buildPanel(['开发者选项'])
    nav = new MobileSettingsNav()
    nav.attach()
    nav.detach()
    nav = undefined
    const row = handle.rows.get('开发者选项')!
    expect(row.querySelector('svg[data-dsh-settings-nav-icon]')).toBeNull()
    expect(row.querySelector('svg[data-dsh-settings-nav-icon-hidden]')).toBeNull()
    expect(row.querySelector('svg'), '上游 svg 必须仍在行里').not.toBeNull()
  })
})
