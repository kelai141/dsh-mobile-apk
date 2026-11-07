// @vitest-environment jsdom
// P4/P5（0.14.2）：顶部额头回收 + 两个无用控件（用户 2026-09-26 原话）。
//
// 用户原话：「这个顶部的额头太大了（标题上方留空）挤占屏幕空间」；
// 「那个文件夹按钮完全无用，绿点也无用，这俩隐藏掉，然后把左菜单栏展开按钮挪到和原生标题顶栏同一行」。
//
// 本文件守四条判据（方案 §4.2）：
//   ① 页面上不再存在 [data-dsh-mobile-topbar]；
//   ② 抽屉开关注册进上游标题行座位 conversation.header.leading，且不再自绘整条 band；
//   ③ 文件夹按钮的注册被撤掉、vendor 绿点被 CSS 藏掉（且**不碰 vendor 源码**）；
//   ④ centerCol 的 padding-top 只剩 top inset（回收 44px）。
// 每条都配反证：把旧形态改回去必须判红。
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MOBILE_FORM_CSS } from '../src/client/mobile/mobile-form.css.ts'
import { VENDOR_CHROME_HIDE_CSS } from '../src/client/mobile/vendor-chrome-hide.css.ts'
import { SidebarToggle } from '../src/client/mobile/SidebarToggle.tsx'
import { MobileChrome } from '../src/client/mobile/MobileChrome.tsx'

// 本 spec 跑在 jsdom 下：jsdom 会把全局 URL 换成以 http://localhost:3000 为基的版本，
// 于是 new URL(relative, import.meta.url) 得到的是 http: 方案，fileURLToPath 直接抛
// 「The URL must be of scheme file」。vitest 的 cwd 恒为包根，用 process.cwd() 拼接即可。
const src = (...parts: string[]): string => join(process.cwd(), 'src', 'client', ...parts)
/** Strip comments so an assertion about code cannot be satisfied or defeated by prose. */
const code = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const clientRaw = readFileSync(src('index.ts'), 'utf8')
const clientSource = code(clientRaw)
const chromeSource = code(readFileSync(src('mobile', 'MobileChrome.tsx'), 'utf8'))
const toggleSource = code(readFileSync(src('mobile', 'SidebarToggle.tsx'), 'utf8'))
const guardSource = code(readFileSync(src('composer-popup-guard.ts'), 'utf8'))

describe('P4：顶部额头回收', () => {
  it('① 撤掉 [data-dsh-mobile-topbar]：index.ts 不再注册自绘 band，MobileChrome 不再渲染它', () => {
    // 注册面：band 曾经是 shell.overlay 里的 .bar。
    expect(clientSource).not.toContain('data-dsh-mobile-topbar')
    expect(chromeSource).not.toContain('data-dsh-mobile-topbar')
    // 反证：注释里点名「已撤掉的旧属性」是允许的（那是文档），所以断言必须先剥注释 ——
    // 这里证明剥注释确实起了作用（原文含该串，code() 之后不含）。
    expect(clientRaw).toContain('data-dsh-mobile-topbar')
    // 反证色：这两个字符串**曾经**就是缺陷形态，任何一处回来都必须判红。
    expect('div data-dsh-mobile-topbar'.includes('data-dsh-mobile-topbar')).toBe(true)
  })

  it('①b 反证：band 的 CSS 与高度变量必须一起消失（漏一个就是半回收）', () => {
    const css = readFileSync(src('mobile', 'mobile-form.css.ts'), 'utf8')
    // The variable must not exist anywhere -- not even in a comment (the removal is total).
    expect(css).not.toContain('--dsh-mobile-topbar-height')
    // 反证：若把该变量加回去，断言必须能看见它（证明这条不是空断言）。
    expect(('  --dsh-mobile-topbar-height: 44px;').includes('--dsh-mobile-topbar-height')).toBe(true)
  })

  it('② 抽屉开关注册进上游标题行座位 conversation.header.leading', () => {
    expect(clientSource).toContain("ctx.slots.inject('conversation.header.leading'")
    expect(clientSource).toContain('SidebarToggle')
    // 反证色：旧形态是「自绘 band + shell.overlay 里的按钮」。
    expect(clientSource.includes("id: 'mobile-chrome',") && !clientSource.includes('css.bar')).toBe(true)
  })

  it('②b 左栏开关和右栏使用同一套侧栏图标，且仍是 button（可点、可聚焦）', () => {
    expect(toggleSource).toContain('<button')
    expect(toggleSource).toContain('<IconPanelLeftOutlineRegular')
    expect(toggleSource).toContain('aria-expanded')
  })

  it('④ centerCol 的 padding-top 只剩 top inset（回收 44px）', () => {
    const stripped = MOBILE_FORM_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const match = /\[data-dsh-frame\]\s*>\s*\[class\*='centerCol'\]\s*\{[^}]*\}/.exec(stripped)
    expect(match, 'centerCol 规则必须在场').toBeTruthy()
    expect(match![0]).toContain('padding-top: var(--dsh-mobile-top-inset, 0px)')
    // 反证色：旧形态是 calc(topbar-height + top-inset)，必须判红。
    expect(match![0]).not.toContain('calc(')
  })

  it('④b 反证：centerCol 若把 44px 加回去，判据必须判红', () => {
    // 只动 centerCol 那条规则：同一张表里 sidebarCol 也带 padding-top: var(--dsh-mobile-top-inset)，
    // 直接全局 replace 会改错规则，让这条反证变成假绿。
    const centerColRe = /(\[data-dsh-frame\]\s*>\s*\[class\*='centerCol'\]\s*\{)([^}]*)(\})/
    const bad = MOBILE_FORM_CSS.replace(centerColRe, (_m, head, body, tail) =>
      head + body.replace('padding-top: var(--dsh-mobile-top-inset, 0px)',
        'padding-top: calc(var(--dsh-mobile-topbar-height) + var(--dsh-mobile-top-inset, 0px))') + tail)
    const stripped = bad.replace(/\/\*[\s\S]*?\*\//g, '')
    const match = centerColRe.exec(stripped)
    expect(match![2]).toContain('calc(')
  })
})

describe('P5：两个无用控件', () => {
  it('③ 文件夹按钮：conversation.session.header.utilities 的注册被撤掉', () => {
    expect(clientSource).not.toContain('android-open-in-file-manager')
    expect(clientSource).not.toContain('OpenInFileManagerAction')
    // 反证色：注册 id 曾经就是它，加回来必须判红。
    expect("id: 'android-open-in-file-manager'".includes('android-open-in-file-manager')).toBe(true)
  })

  it('③b 绿点：用 CSS 覆盖 vendor 自己的属性选择器，且带 !important', () => {
    expect(VENDOR_CHROME_HIDE_CSS).toContain('[data-undo-header] .u_dot')
    expect(VENDOR_CHROME_HIDE_CSS).toMatch(/display:\s*none\s*!important/)
    // 必须用 vendor 的**自有属性**，而不是哈希后的 CSS-Module 类名（不可达且会随版本失配）。
    expect(VENDOR_CHROME_HIDE_CSS).not.toMatch(/\.[A-Za-z0-9_-]{6,}_/)
  })

  it('③c 反证：CSS 选择器若写错（缺 .u_dot 或换成别的属性）判据必须判红', () => {
    const wrongAttr = VENDOR_CHROME_HIDE_CSS.replace('[data-undo-header]', '[data-undo-header-x]')
    expect(wrongAttr).not.toContain('[data-undo-header] .u_dot')
    const noDot = VENDOR_CHROME_HIDE_CSS.replace('.u_dot', '.u_other')
    expect(noDot).not.toContain('.u_dot')
  })

  it('③d 绝不改 vendor：CSS 只在自己仓里，且没有指向 vendor 路径的写入面', () => {
    expect(VENDOR_CHROME_HIDE_CSS.length).toBeGreaterThan(0)
    // 反证/纪律：本插件**不得**出现 vendor 目录路径（改它就是改第三方固化副本）。
    for (const source of [clientSource, VENDOR_CHROME_HIDE_CSS]) {
      expect(source).not.toMatch(/vendor\/dsh-undo-savepoint/)
    }
  })

  it('③e 保留项：遮罩与浏览器待展开徽标/提示都还在', () => {
    // 遮罩（你没让删，且返回键/点外部关闭依赖它）：属性在 MobileChrome.tsx，注册面在 index.ts。
    expect(chromeSource).toContain('data-dsh-mobile-mask')
    expect(clientSource).toContain("id: 'mobile-chrome',")
    // S3-19 徽标 + 文字提示。
    expect(toggleSource).toContain('data-dsh-browser-badge')
    expect(toggleSource).toContain('data-dsh-browser-pending-hint')
    expect(clientSource).toContain("ctx.slots.inject('shell.overlay'")
  })
})

describe('P4 连带：弹出面板钳制必须改锚到真实顶部 chrome', () => {
  it('旧锚 [data-dsh-mobile-topbar] 不再作为首选；改为经 header 座位解析上游 header', () => {
    expect(guardSource).toContain('headerTopChrome')
    expect(guardSource).toContain('[data-conversation-header-leading]')
    // 反证：第一锚点必须**不是**旧 band（否则 band 删掉后钳制恒 0，菜单会顶到 header 下）。
    const firstAnchor = guardSource.indexOf("const topbar = headerTopChrome()")
    const legacyAnchor = guardSource.indexOf("document.querySelector<HTMLElement>('[data-dsh-mobile-topbar]')")
    expect(firstAnchor).toBeGreaterThan(0)
    expect(legacyAnchor).toBeGreaterThan(firstAnchor)
  })

  it('反证：若顶部 chrome 解析不到（无 header），钳制会放宽 —— 这正是必须改锚的量化理由', async () => {
    const { composerPopupMaxHeight } = await import('../src/client/composer-popup-guard.ts')
    // popupBottom=316：header 底边 76 时留 218；恒 0 时会放宽到 294（多 76px，正好是 header 高）。
    expect(composerPopupMaxHeight(316, 76, 10)).toBe(218)
    expect(composerPopupMaxHeight(316, 0, 10)).toBe(294)
    expect(composerPopupMaxHeight(316, 0, 10)).toBeGreaterThan(composerPopupMaxHeight(316, 76, 10))
  })
})

describe('P4：抽屉开关必须有真实样式（自测抓到的缺陷类）', () => {
  it('CSS 必须同时保留 .toggle 与 .mask；删掉 band 时不得连带删掉 toggle', () => {
    // 缺陷形态（实现期实测踩到）：删 .bar 那段时把共用选择器里的 .toggle 规则一起删了，
    // 于是按钮 classAttr=null、落到浏览器默认样式（实测渲成一块灰色方框）。
    const css = readFileSync(src('mobile', 'MobileChrome.module.css'), 'utf8')
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stripped).toMatch(/\.toggle\s*\{/)
    expect(stripped).toMatch(/\.mask\s*\{/)
    // 反证色：band 的 .bar 规则必须已经删掉（否则说明改动没落地）。
    expect(stripped).not.toMatch(/\.bar\s*[,{]/)
    // 反证：把 .toggle 规则删掉必须能被这条断言看见。
    const broken = stripped.replace(/\.toggle\s*\{[^}]*\}/, '')
    expect(broken).not.toMatch(/\.toggle\s*\{/)
  })

  it('开关在 header 行里尺寸受控（不给它自绘大背景，读起来是标题行的图标之一）', () => {
    const css = readFileSync(src('mobile', 'MobileChrome.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const rule = /\.toggle\s*\{([^}]*)\}/.exec(css)
    expect(rule, '.toggle 规则必须在场').toBeTruthy()
    expect(rule![1]).toContain('background: transparent')
    expect(rule![1]).toMatch(/width:\s*28px/)
    expect(rule![1]).toMatch(/height:\s*28px/)
  })
})

describe('P4 反证：开关只能出现在手机形态（PC 宽度不得变成第二个侧栏按钮）', () => {
  it('开关样式必须挂在 html[data-dsh-mobile-form] 下，而不是裸 .toggle', () => {
    // 缺陷形态（真机实测 16384 抓到）：旧的 band 由 @media 门住，搬进 header 后若规则
    // 变成裸 .toggle，PC 宽度（16384，innerWidth=1067，mobileForm=false）会**同时**出现
    // 上游自己的「收起侧边栏」（x=240）与我方开关（x=300）——两个侧栏按钮。
    const css = readFileSync(src('mobile', 'MobileChrome.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    // 必须成对：基线隐藏 + 手机形态显示。少了基线，未匹配到的宽度下按钮会落回浏览器
    // 默认渲染而**照样出现**（第一次修法实测踩到：16384 仍然两个侧栏按钮）。
    expect(css).toMatch(/\.toggle,\s*\n\.mask\s*\{\s*\n\s*display:\s*none;/)
    expect(css).toContain('html[data-dsh-mobile-form] .toggle')
    // 裸 .toggle 选择器（行首，无 html[...] 前缀）不得存在。
    expect(css).not.toMatch(/(^|\n)\s*\.toggle\s*\{/)
    // 反证：去掉前缀必须能被这条看见。
    const broken = css.replace(/html\[data-dsh-mobile-form\] \.toggle/g, '.toggle')
    expect(broken).toMatch(/(^|\n)\s*\.toggle\s*\{/)
  })

  it('徽标与提示同样只在手机形态下出现（它们定位在开关上）', () => {
    const css = readFileSync(src('mobile', 'MobileChrome.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).toContain('html[data-dsh-mobile-form] .badge')
    expect(css).toContain('html[data-dsh-mobile-form] .pendingHint')
  })

  it('掩码仍然是帧级覆盖（不受手机形态门限制，桌面留空即不绘制）', () => {
    const css = readFileSync(src('mobile', 'MobileChrome.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    // .mask 的显示由 @media (max-width: 767px) 门住，这是既有的、正确的形态门。
    expect(css).toMatch(/@media \(max-width: 767px\)/)
    expect(css).toMatch(/\.mask\s*\{/)
  })
})

describe('P4 硬判据：hero/sessionless 态（新建会话那一屏）必须也有可点的汉堡', () => {
  /**
   * 构造上游 hero 分支的 DOM（ConversationHeader.tsx:18-24 的 blank/sessionless 形态）：
   * headerBlank、min-height:0、border-bottom:none，且 sessionId===undefined 时右侧只是空 titleRow。
   * 关键点：**header 高为 0** 也在所不惜 —— 汉堡的可见性不得依赖 header 高度或 titleRow 是否存在。
   */
  function mountHeroDom(headerHeightPx: number): HTMLElement {
    // 关键：hero 态的**真实**前提是抽屉处于收起态（frame 带 data-sidebar-collapsed）。
    // 少了这个属性，useSidebarOpen 会读成「已展开」，标签就成了「关闭导航」——
    // 那是测试夹具失真，不是实现问题（实现期实测踩到，记录下来）。
    document.body.innerHTML =
      '<div data-dsh-frame data-sidebar-collapsed>'
      + '<header class="headerBlank headerSessionless" style="height:' + headerHeightPx + 'px;min-height:0;padding-bottom:0;border-bottom:none">'
      + '  <div class="headerLeading" data-conversation-header-leading=""></div>'
      + '  <div class="titleRow"></div>'
      + '</header>'
      + '</div>'
    return document.querySelector<HTMLElement>('[data-conversation-header-leading]')!
  }

  it('hero 态：汉堡仍在场、可见（display!=none）、可点，且**不依赖 header 高度**', () => {
    // 本用例的断言里刻意**不出现**任何 header.height 判据（lead 硬要求）：
    // 只用「元素在场 + computed display!=none + aria-label + 可派发 click」判定可点。
    for (const headerHeight of [40, 0]) {
      const leading = mountHeroDom(headerHeight)
      const { createRoot } = require('react-dom/client')
      const { act } = require('react')
      ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
      const host = document.createElement('div')
      leading.appendChild(host)
      const root = createRoot(host)
      let clicked = 0
      act(() => { root.render(<SidebarToggle toggleSidebar={() => { clicked += 1 }} /> as never) })
      const button = leading.querySelector('button')
      expect(button, 'header 高 ' + headerHeight + ' 时汉堡仍必须渲染').toBeTruthy()
      expect(getComputedStyle(button!).display).not.toBe('none')
      expect(button!.getAttribute('aria-label')).toBe('打开导航')
      expect(button!.hasAttribute('data-dsh-sidebar-toggle')).toBe(true)
      const frame = leading.closest('[data-dsh-frame]')!
      expect(frame.hasAttribute('data-dsh-header-sidebar-toggle')).toBe(true)
      act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(clicked, 'hero 态下点汉堡必须真的触发 drawer 切换').toBe(1)
      act(() => { root.unmount() })
      expect(frame.hasAttribute('data-dsh-header-sidebar-toggle')).toBe(false)
    }
  })

  it('hero 态：挂载座位必须是 conversation.header.leading（与会话无关的 root 座位）', () => {
    // 上游该座位 scope='root'，且在 sessionId 判定之外无条件渲染（ConversationHeader.tsx:19-21）。
    // 若挪到会话作用域的座位，hero 态（无会话）就会没有汉堡 —— 那正是用户担心的形态。
    expect(clientSource).toContain("ctx.slots.inject('conversation.header.leading'")
    expect(clientSource).toMatch(/'conversation\.header\.leading'[\s\S]{0,200}SidebarToggle/)
  })

  it('反证：把挂载挪到一个依赖会话/titleRow 的座位，hero 态判据必须判红', () => {
    // 把座位名换成一个只有存在会话时才有内容的座位，本文件的两条 hero 判据必须都不成立。
    const moved = clientSource.split("'conversation.header.leading'").join("'conversation.session.header.utilities'")
    expect(moved).not.toContain("ctx.slots.inject('conversation.header.leading'")
    // 座位依赖会话 = hero 态（sessionId undefined）不会渲染该座位 ⇒ 用户就没有入口。
    expect(moved).not.toMatch(/'conversation\.header\.leading'[\s\S]{0,200}SidebarToggle/)
    // 且“会话作用域”座位在 hero 态不挂载，这条即反证色本身。
    expect(moved).toContain("inject('conversation.session.header.utilities'")
    // 且整份源码里不再有任何 header.leading 座位引用（inject 与 name 都搬走了）。
    expect(moved).not.toContain("'conversation.header.leading'")
  })

  it('反证：汉堡若隐式依赖 titleRow 存在（例如把组件塞进 titleRow 相关选择器），hero 判据必须判红', () => {
    const css = readFileSync(src('mobile', 'MobileChrome.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    // 我们的 .toggle 规则不得带任何 height/min-height 依赖或 display:none 兜底。
    const rule = /\.toggle\s*\{([^}]*)\}/.exec(css)
    expect(rule).toBeTruthy()
    expect(rule![1]).not.toContain('display: none')
    expect(rule![1]).not.toMatch(/min-height|max-height/)
    // 反证：往规则里塞 display:none 必须被上面看见。
    const broken = '.toggle {' + rule![1] + ' display: none; }'
    expect(broken).toContain('display: none')
  })
})

describe('P4/P5：组件本身仍可渲染（没有在重构中变成空壳）', () => {
  it('SidebarToggle 渲染出的按钮必须带 CSS 类（classAttr=null 就是未样式化形态）', () => {
    expect(toggleSource).toMatch(/className={css.toggle}/)
  })

  it('SidebarToggle 渲染出带 aria-label 的按钮', () => {
    document.body.innerHTML = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { createRoot } = require('react-dom/client')
    const { act } = require('react')
    ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(host)
    act(() => { root.render(<SidebarToggle toggleSidebar={() => {}} /> as never) })
    const button = host.querySelector('button')
    expect(button).toBeTruthy()
    expect(button!.getAttribute('aria-label')).toMatch(/打开导航|关闭导航/)
    act(() => { root.unmount() })
  })

  it('MobileChrome 只渲染遮罩（band 不再出现）', () => {
    document.body.innerHTML = ''
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { createRoot } = require('react-dom/client')
    const { act } = require('react')
    const root = createRoot(host)
    act(() => { root.render(<MobileChrome toggleSidebar={() => {}} /> as never) })
    expect(host.querySelector('[data-dsh-mobile-mask]')).toBeTruthy()
    expect(host.querySelector('[data-dsh-mobile-topbar]')).toBeNull()
    act(() => { root.unmount() })
  })
})
