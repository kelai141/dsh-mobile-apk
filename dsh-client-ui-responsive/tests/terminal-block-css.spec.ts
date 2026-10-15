// @vitest-environment node
// 手机端终端卡片排版的源码级契约（社区截图缺陷）。
//
// 样式表和上游产物各写一半：上游 TerminalBlock 只留了两个「可被宿主重绑」的自定义属性，
// 宿主不重绑就回落到 pre（不换行 → 省略号 + 输出区横滑）。一旦这里的选择器或变量名漂移，
// 界面上就是「命令又被截断 / 右侧又是大片空白」这种静默失效——构建与类型检查都看不出来。
// 故在源码层钉住四件事：
//   1. 两个 whitespace 变量确实被重绑为 pre-wrap，且整张表都 gate 在手机形态下（横屏不可能命中）；
//   2. 选择器只用稳定属性与结构关系，绝不依赖 CSS Modules 哈希类名（类名每次构建都会变）；
//   3. 修复「右侧大片空白」的两条规则都在场 —— header 换行 + 换行行右对齐（end），
//      以及 prompt 独占整行、command 撑满；缺 end 对齐会让换行后的按钮贴左，空白照旧；
//   4. 注入走既有的 injectStyle + ctx.effect 约定（dispose 时样式表移除）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TERMINAL_BLOCK_CSS as CSS } from '../src/client/terminal-block.css.ts'

/** 去掉 /* *\/ 注释，只留选择器与声明，便于逐条断言。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 逐条拆出「选择器 { 声明 }」，不做完整 CSS 解析，够本契约使用。 */
function rules(css: string): { selector: string, body: string }[] {
  const out: { selector: string, body: string }[] = []
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim()
    // @media 的外层是「选择器 + 嵌套块」，其选择器以 @media 开头，跳过。
    if (selector.startsWith('@')) continue
    out.push({ selector, body: match[2] })
  }
  return out
}

const RULES = rules(CSS)

describe('手机端终端卡片排版契约', () => {
  it('整张表都 gate 在手机形态与窄屏媒体查询下', () => {
    expect(CSS).toContain('@media (max-width: 760px)')
    expect(CSS).toContain('data-dsh-mobile-form')
    expect(RULES.length).toBeGreaterThan(0)
    // 反证：任何一条规则少一个 gate，横屏/桌面就会跟着改版。
    for (const rule of RULES) {
      expect(rule.selector, '每条规则都必须以 html[data-dsh-mobile-form] 开头').toMatch(/^html\[data-dsh-mobile-form\]/)
    }
  })

  it('两个 whitespace 变量都重绑为 pre-wrap（消除省略号与输出区横滑）', () => {
    const rebind = RULES.filter(r => r.body.includes('--dsl-terminal-command-whitespace') || r.body.includes('--dsl-terminal-line-whitespace'))
    expect(rebind.length, '缺少 whitespace 变量重绑规则').toBeGreaterThan(0)
    const joined = rebind.map(r => r.body).join('\n')
    for (const name of ['--dsl-terminal-command-whitespace', '--dsl-terminal-line-whitespace']) {
      expect(joined, '缺少 ' + name + ' 重绑').toContain(name)
    }
    // 上游正是靠这两个变量同时退出「省略号」和「输出区横滑」，值必须是 pre-wrap。
    expect((joined.match(/pre-wrap/g) ?? []).length).toBeGreaterThanOrEqual(2)
    // 重绑必须打在卡片元素上：这两个变量在 .block 上没有声明、可继承，打 [data-terminal] 即可全后代生效。
    expect(rebind.some(r => r.selector.includes('[data-terminal]'))).toBe(true)
  })

  it('选择器只用稳定属性与结构关系，不用 CSS Modules 哈希类名', () => {
    const all = RULES.map(r => r.selector).join('\n')
    expect(all, '必须以 data-terminal 作根').toContain('[data-terminal]')
    // 哈希类名形如 _header_1fs6g_32：一旦写死，下次构建就失配。
    expect(all, '不得依赖哈希类名').not.toMatch(/_([A-Za-z0-9-]+)_[a-z0-9]{5}_\d+/)
    // 源码类名同样不可用（产物里已被哈希，源码里的 .command/.prompt 在页面上并不存在）。
    for (const sourceClass of ['.command', '.promptLine', '.prompt', '.header', '.output', '.line', '.block']) {
      expect(all, '不得使用源码类名 ' + sourceClass).not.toContain(sourceClass)
    }
  })

  it('修掉右侧大片空白：header 换行 + 右对齐，prompt 独占整行，command 撑满', () => {
    const headerRule = RULES.find(r => /\[data-terminal\]\s*>\s*:first-child\s*$/.test(r.selector))
    expect(headerRule, '缺少 header（> :first-child）规则').toBeTruthy()
    expect(headerRule!.body, 'header 必须允许换行').toContain('flex-wrap: wrap')
    // 反证：换行后不对齐到右边，胶囊与复制按钮会贴左，右侧空白原样保留（实测 360px 视口空白 224px）。
    expect(headerRule!.body, '换行行必须右对齐，否则按钮贴左、空白照旧').toContain('justify-content: flex-end')
    expect(headerRule!.body, '必须解除 banner 的 150px 上限，否则多行命令在内部滚、仍看不全').toContain('max-height: none')

    const promptRule = RULES.find(r => /\[data-terminal\]\s*>\s*:first-child\s*>\s*:first-child\s*$/.test(r.selector))
    expect(promptRule, '缺少 prompt（> :first-child > :first-child）规则').toBeTruthy()
    expect(promptRule!.body, 'prompt 必须独占整行').toContain('flex: 1 1 100%')

    const cmdRule = RULES.find(r => /:first-child\s*>\s*:first-child\s*>\s*\*\s*>\s*:last-child\s*$/.test(r.selector))
    expect(cmdRule, '缺少 command（> * > :last-child）规则').toBeTruthy()
    expect(cmdRule!.body, 'command 必须撑满整行剩余宽度').toContain('flex: 1 1 auto')
  })

  it('不引入硬编码颜色与 !important（主题与上游优先级保持可继承）', () => {
    expect(CSS).not.toContain('!important')
    expect(stripComments(CSS)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(stripComments(CSS)).not.toMatch(/rgba?\(/)
  })

  it('注入遵守既有 injectStyle + ctx.effect 约定（dispose 时移除样式表）', () => {
    const source = readFileSync('src/client/index.ts', 'utf8')
    expect(source, 'index.ts 必须导入本样式表').toContain("import { TERMINAL_BLOCK_CSS } from './terminal-block.css.ts'")
    expect(source, '必须用既有 injectStyle 注入').toContain("injectStyle('terminal-block', TERMINAL_BLOCK_CSS)")
    // injectStyle 在 ctx.effect 内调用，其返回的 disposer 负责移除样式表。
    const site = source.split("injectStyle('terminal-block'")[0]
    expect(site.includes('ctx.effect('), '注入必须包在 ctx.effect 内以遵守 dispose 约定').toBe(true)
  })
})
