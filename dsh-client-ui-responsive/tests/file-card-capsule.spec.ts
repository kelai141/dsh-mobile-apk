// @vitest-environment jsdom
// 交付文件卡片的两段胶囊：另一种打开方式 + 转发。
//
// 夹具照上游 ui-deliverables/ChangedFiles.tsx 的真实可访问性接线搭：
//   div[data-changed-files][data-single]
//     > button.header[aria-describedby=<id>]        ← 单击 = openReview（默认打开）
//     > span#<id> hidden                            ← resolveWorkspacePath 后的绝对路径
//   多文件：ul > li > button.row[aria-describedby] + span#<id> hidden
// 上游没有文件级操作插槽，胶囊靠这段 DOM 接线取路径，不靠样式类。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  FileCardCapsule, DEFAULT_OPEN_MODE, mimeOf, otherModeOf, type FileCardBridge,
} from '../src/client/mobile/file-card-actions.ts'
import { FILE_CARD_CAPSULE_CSS } from '../src/client/mobile/file-card-capsule.css.ts'

const CAPSULE = '[data-dsh-file-capsule]'
const EXTERNAL = '[data-dsh-file-capsule-external]'
const SHARE = '[data-dsh-file-capsule-share]'
const SEPARATOR = '[data-dsh-file-capsule-separator]'

const COPY = { external: (name: string) => '用其他应用打开：' + name, share: '转发该文件' }

/** 记录桥调用。 */
interface Calls { external: Array<[string, string]>; share: Array<[string, string]> }

function makeBridge(answer: (kind: 'open' | 'share') => string | undefined): FileCardBridge & { calls: Calls } {
  const calls: Calls = { external: [], share: [] }
  return {
    calls,
    openFileExternal: (path, mime) => { calls.external.push([path, mime]); return answer('open') },
    shareFile: (path, mime) => { calls.share.push([path, mime]); return answer('share') },
  }
}

/** 单文件卡片：上游 singleFile 分支的形状。 */
function buildSingleCard(path: string, opts: { onOpen?: () => void } = {}): HTMLButtonElement {
  const card = document.createElement('div')
  card.setAttribute('data-changed-files', '')
  card.setAttribute('data-single', '')
  const header = document.createElement('button')
  header.type = 'button'
  header.setAttribute('aria-describedby', 'p-desc')
  header.addEventListener('click', () => { opts.onOpen?.() })
  const hidden = document.createElement('span')
  hidden.id = 'p-desc'
  hidden.hidden = true
  hidden.textContent = path
  card.append(header, hidden)
  document.body.append(card)
  return header
}

/** 多文件卡片：ul > li > button + hidden span。 */
function buildMultiCard(paths: readonly string[]): HTMLElement {
  const card = document.createElement('div')
  card.setAttribute('data-changed-files', '')
  const list = document.createElement('ul')
  paths.forEach((path, index) => {
    const li = document.createElement('li')
    const row = document.createElement('button')
    row.type = 'button'
    row.setAttribute('aria-describedby', 'row-' + index)
    const hidden = document.createElement('span')
    hidden.id = 'row-' + index
    hidden.hidden = true
    hidden.textContent = path
    li.append(row, hidden)
    list.append(li)
  })
  card.append(list)
  document.body.append(card)
  return card
}

/** 等待观察器微任务批次跑完。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

let capsule: FileCardCapsule

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  capsule?.detach()
  document.body.innerHTML = ''
})

describe('卡片胶囊：结构', () => {
  it('单文件卡片挂上两段，左段在前、右段在后', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    const box = document.querySelector(CAPSULE)!
    expect(box).not.toBeNull()
    expect(box.querySelector(EXTERNAL)).not.toBeNull()
    expect(box.querySelector(SHARE)).not.toBeNull()
    expect([...box.children].map(node => node.getAttribute('data-dsh-file-capsule-external') !== null ? 'external' : node.getAttribute('data-dsh-file-capsule-share') !== null ? 'share' : 'sep'))
      .toEqual(['external', 'sep', 'share'])
  })

  it('多文件卡片每行各挂一条', async () => {
    buildMultiCard(['/work/a.md', '/work/b.png', '/work/c.zip'])
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(3)
  })

  it('重复扫描不重复挂（幂等）', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    document.body.append(document.createElement('div'))
    await flush()
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(1)
  })

  it('两段各自是独立按钮，整条胶囊不是单一角色', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    const box = document.querySelector<HTMLElement>(CAPSULE)!
    // 容器本身不带 role=button，也不可聚焦
    expect(box.getAttribute('role')).toBeNull()
    expect(box.hasAttribute('tabindex')).toBe(false)
    expect(box.querySelectorAll('button[aria-label]')).toHaveLength(2)
  })

  it('左段里再包一个带描边的小块（样图形态），右段没有小块', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    const external = document.querySelector<HTMLElement>(EXTERNAL)!
    const share = document.querySelector<HTMLElement>(SHARE)!
    const chip = external.querySelector('[data-dsh-file-capsule-chip]')
    expect(chip).not.toBeNull()
    expect(chip!.querySelector('svg')).not.toBeNull()
    // 小块只是视觉件，自己不承担语义
    expect(chip!.getAttribute('aria-hidden')).toBe('true')
    expect(share.querySelector('[data-dsh-file-capsule-chip]')).toBeNull()
    // 右段图标直接挂在按钮上
    expect(share.querySelector('svg')).not.toBeNull()
  })

  it('两个段各有 contentDescription（aria-label）', async () => {
    buildSingleCard('/work/report.md')
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    expect(document.querySelector(EXTERNAL)!.getAttribute('aria-label')).toBe('用其他应用打开：report.md')
    expect(document.querySelector(SHARE)!.getAttribute('aria-label')).toBe('转发该文件')
  })
})

describe('卡片胶囊：行为', () => {
  it('① 单击卡片仍走默认动作（侧栏预览），不被胶囊改写', async () => {
    const onOpen = vi.fn()
    const header = buildSingleCard('/work/a.md', { onOpen })
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    // 默认模式是侧栏
    expect(DEFAULT_OPEN_MODE).toBe('sidebar')
    header.click()
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('② 左段调用 openFileExternal，参数是绝对路径 + 推断的 MIME', async () => {
    buildSingleCard('/work/report.md')
    const bridge = makeBridge(() => '{"ok":true}')
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(EXTERNAL)!.click()
    expect(bridge.calls.external).toEqual([['/work/report.md', 'text/markdown']])
    expect(bridge.calls.share).toEqual([])
  })

  it('③ 右段调用 shareFile', async () => {
    buildSingleCard('/work/report.md')
    const bridge = makeBridge(() => '{"ok":true}')
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(SHARE)!.click()
    expect(bridge.calls.share).toEqual([['/work/report.md', 'text/markdown']])
    expect(bridge.calls.external).toEqual([])
  })

  it('点胶囊不冒泡到卡片（不会顺带打开预览）', async () => {
    const onOpen = vi.fn()
    buildSingleCard('/work/a.md', { onOpen })
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(SHARE)!.click()
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('④ 桥不在场时左段隐藏，只留转发', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => ({}), COPY)
    capsule.attach()
    await flush()
    const box = document.querySelector(CAPSULE)!
    expect(box.querySelector(EXTERNAL)).toBeNull()
    expect(box.querySelector(SEPARATOR)).toBeNull()
    expect(box.querySelector(SHARE)).not.toBeNull()
    expect(box.hasAttribute('data-dsh-file-capsule-share-only')).toBe(true)
  })

  it('④b 壳侧答 no-handler 后左段永久收起（不留点了报错的按钮）', async () => {
    buildSingleCard('/work/a.md')
    const bridge = makeBridge(() => '{"ok":false,"reason":"no-handler"}')
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(EXTERNAL)!.click()
    expect(capsule.externalAvailable()).toBe(false)
    expect(document.querySelector(EXTERNAL)).toBeNull()
    expect(document.querySelector(SHARE)).not.toBeNull()
  })

  it('桥抛异常时按失败返回，不向 DOM 事件里抛', async () => {
    buildSingleCard('/work/a.md')
    const bridge: FileCardBridge = {
      shareFile: () => { throw new Error('boom') },
    }
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    expect(capsule.act('share', '/work/a.md')).toEqual({ ok: false, reason: 'empty-answer' })
  })

  it('桥返回非 JSON 按失败处理', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => makeBridge(() => 'not-json'), COPY)
    capsule.attach()
    await flush()
    expect(capsule.act('share', '/work/a.md')).toEqual({ ok: false, reason: 'malformed-answer' })
  })

  it('桥晚注入也生效（装配期不一定有 window.androidBridge）', async () => {
    buildSingleCard('/work/a.md')
    let face: FileCardBridge = {}
    capsule = new FileCardCapsule(() => face, COPY)
    capsule.attach()
    await flush()
    // 装配时桥缺席 -> 左段隐藏
    expect(document.querySelector(EXTERNAL)).toBeNull()
    // 壳侧此刻才注入
    const bridge = makeBridge(() => '{"ok":true}')
    face = bridge
    expect(capsule.externalAvailable()).toBe(true)
    expect(capsule.act('share', '/work/a.md')).toEqual({ ok: true, reason: undefined })
    expect(bridge.calls.share).toEqual([['/work/a.md', 'text/markdown']])
  })

  it('detach 摘掉已挂的胶囊', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    capsule.detach()
    expect(document.querySelector(CAPSULE)).toBeNull()
  })

  it('上游没写绝对路径的行跳过，不猜路径', async () => {
    const card = document.createElement('div')
    card.setAttribute('data-changed-files', '')
    card.setAttribute('data-single', '')
    const header = document.createElement('button')
    header.type = 'button'
    card.append(header)
    document.body.append(card)
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    expect(document.querySelector(CAPSULE)).toBeNull()
  })
})

describe('卡片胶囊：默认模式反向', () => {
  it('otherModeOf 把默认取反', () => {
    expect(otherModeOf('sidebar')).toBe('external')
    expect(otherModeOf('external')).toBe('sidebar')
  })

  it('默认值是单一常量（加设置行时只改它）', () => {
    expect(DEFAULT_OPEN_MODE).toBe('sidebar')
  })
})

describe('MIME 推断', () => {
  it('已知扩展名给出 RFC 类型', () => {
    expect(mimeOf('/a/b.md')).toBe('text/markdown')
    expect(mimeOf('/a/b.png')).toBe('image/png')
    expect(mimeOf('/a/b.apk')).toBe('application/vnd.android.package-archive')
    expect(mimeOf('C:\\a\\b.json')).toBe('application/json')
  })

  it('未知扩展名返回空串，交给壳侧嗅探', () => {
    expect(mimeOf('/a/b.unknownext')).toBe('')
    expect(mimeOf('/a/Makefile')).toBe('')
  })
})

describe('⑤ 无误排文字', () => {
  it('胶囊里只有图标，没有文本节点', async () => {
    buildSingleCard('/work/a.md')
    capsule = new FileCardCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    capsule.attach()
    await flush()
    const box = document.querySelector<HTMLElement>(CAPSULE)!
    expect(box.textContent).toBe('')
    for (const button of box.querySelectorAll('button')) {
      expect(button.textContent).toBe('')
      expect(button.querySelector('svg')).not.toBeNull()
    }
  })

  it('样式表不生成任何可见伪元素文字', () => {
    // 只查真正的 CSS 声明，注释里的中文不算。
    const declarations = FILE_CARD_CAPSULE_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    // 唯一允许的 content 是触控命中区的空串；任何非空 content 都会排出文字。
    const contents = [...declarations.matchAll(/(?:^|[;\s{])content\s*:\s*([^;}]*)/g)].map(m => m[1].trim())
    expect(contents.length).toBeGreaterThan(0)
    for (const value of contents) expect(value).toMatch(/^(''|"")$/)
    expect(declarations).not.toMatch(/::?(?:before|after)[^{]*\{[^}]*content:\s*['"][^'"]+['"]/)
  })
})

describe('样式尺寸（按视觉参考）', () => {
  it('外框：高 32-34 / 圆角 10-12 / 描边 1px，且无阴影无发光', () => {
    const body = FILE_CARD_CAPSULE_CSS.match(/\[data-dsh-file-capsule\]\s*\{([^}]*)\}/)![1]
    const height = Number(body.match(/height:\s*(\d+)px/)![1])
    expect(height).toBeGreaterThanOrEqual(32)
    expect(height).toBeLessThanOrEqual(34)
    const radius = Number(body.match(/border-radius:\s*(\d+)px/)![1])
    expect(radius).toBeGreaterThanOrEqual(10)
    expect(radius).toBeLessThanOrEqual(12)
    expect(body).toMatch(/border:\s*1px/)
    // 卡片是主体：不许有阴影/发光
    expect(body).toMatch(/box-shadow:\s*none/)
    expect(FILE_CARD_CAPSULE_CSS).not.toMatch(/text-shadow|drop-shadow|filter:/)
  })

  it('描边用 .10，左段内块描边 .12，浅色主题取镜像', () => {
    expect(FILE_CARD_CAPSULE_CSS).toMatch(/--dsh-capsule-border:\s*rgba\(255,\s*255,\s*255,\s*0\.10\)/)
    expect(FILE_CARD_CAPSULE_CSS).toMatch(/--dsh-capsule-inner-border:\s*rgba\(255,\s*255,\s*255,\s*0\.12\)/)
    // 浅色主题没有白描边可用，必须有对向取值
    expect(FILE_CARD_CAPSULE_CSS).toMatch(/body:not\(\[data-ds-dark-theme\]\)[^{]*\{[^}]*--dsh-capsule-border:\s*rgba\(0,\s*0,\s*0,/)
  })

  it('左段内块：高 26 / 圆角 8 / 图标 16', () => {
    const chip = FILE_CARD_CAPSULE_CSS.match(/\[data-dsh-file-capsule-chip\]\s*\{([^}]*)\}/)![1]
    expect(chip).toMatch(/height:\s*26px/)
    expect(chip).toMatch(/border-radius:\s*8px/)
    const chipIcon = FILE_CARD_CAPSULE_CSS.match(/\[data-dsh-file-capsule-chip\]\s*>\s*svg\s*\{([^}]*)\}/)![1]
    expect(chipIcon).toMatch(/width:\s*16px/)
  })

  it('右段宽 44-48，纸飞机 16-18', () => {
    const share = FILE_CARD_CAPSULE_CSS.match(/\[data-dsh-file-capsule-share\]\s*\{([^}]*)\}/)![1]
    const width = Number(share.match(/width:\s*(\d+)px/)![1])
    expect(width).toBeGreaterThanOrEqual(44)
    expect(width).toBeLessThanOrEqual(48)
    // 无底色
    expect(share).not.toMatch(/background:(?!\s*transparent)/)
    const icon = FILE_CARD_CAPSULE_CSS.match(/\[data-dsh-file-capsule-share\]\s*>\s*svg\s*\{([^}]*)\}/)![1]
    const size = Number(icon.match(/width:\s*(\d+)px/)![1])
    expect(size).toBeGreaterThanOrEqual(16)
    expect(size).toBeLessThanOrEqual(18)
  })

  it('段间 1px 分隔线，颜色同外框描边', () => {
    const sep = FILE_CARD_CAPSULE_CSS.match(/\[data-dsh-file-capsule-separator\]\s*\{([^}]*)\}/)![1]
    expect(sep).toMatch(/width:\s*1px/)
    expect(sep).toMatch(/background:\s*var\(--dsh-capsule-border/)
  })

  it('图标色用 text-2 而非 text-1；按下态 8% 白底', () => {
    expect(FILE_CARD_CAPSULE_CSS).toContain('--dsw-alias-label-secondary')
    expect(FILE_CARD_CAPSULE_CSS).not.toContain('--dsw-alias-label-primary')
    expect(FILE_CARD_CAPSULE_CSS).toMatch(/--dsh-capsule-press:\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/)
    expect(FILE_CARD_CAPSULE_CSS).toMatch(/:active\s*\{[^}]*background:\s*var\(--dsh-capsule-press/)
  })

  it('视觉高度不靠 min-height 撑大，触控面积用伪元素补齐', () => {
    expect(FILE_CARD_CAPSULE_CSS).not.toMatch(/min-height:\s*48px/)
    const hit = FILE_CARD_CAPSULE_CSS.match(/\[data-dsh-file-capsule\]\s*>\s*button::after\s*\{([^}]*)\}/)![1]
    expect(hit).toMatch(/top:\s*-\d+px/)
    expect(hit).toMatch(/bottom:\s*-\d+px/)
  })
})
