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

/**
 * 单文件卡片：上游 singleFile 分支的形状。
 *
 * 上游把 header 包在 FileOpenAnchor 里（ChangedFiles.tsx:70-75 的 `<>` 分支），
 * 实际 DOM 是 `div[data-single] > span > button`，**不是**直接子元素。
 * 夹具必须照抄这一层，否则 `:scope > button` 那种写法测不出来（实机取证）。
 */
function buildSingleCard(path: string, opts: { onOpen?: () => void } = {}): HTMLButtonElement {
  const card = document.createElement('div')
  card.setAttribute('data-changed-files', '')
  card.setAttribute('data-single', '')
  const anchor = document.createElement('span')
  const header = document.createElement('button')
  header.type = 'button'
  header.setAttribute('aria-describedby', 'p-desc')
  header.addEventListener('click', () => { opts.onOpen?.() })
  anchor.append(header)
  const hidden = document.createElement('span')
  hidden.id = 'p-desc'
  hidden.hidden = true
  hidden.textContent = path
  card.append(anchor, hidden)
  document.body.append(card)
  return header
}

/**
 * 多文件卡片：`ul > li > span(FileOpenAnchor) > button` + hidden span。
 *
 * 与单文件同理，上游每行的按钮也被 FileOpenAnchor 的 span 包住，
 * 不是 li 的直接子元素（实机取证）。夹具照抄这一层。
 */
function buildMultiCard(paths: readonly string[]): HTMLElement {
  const card = document.createElement('div')
  card.setAttribute('data-changed-files', '')
  const list = document.createElement('ul')
  paths.forEach((path, index) => {
    const li = document.createElement('li')
    const anchor = document.createElement('span')
    const row = document.createElement('button')
    row.type = 'button'
    row.setAttribute('aria-describedby', 'row-' + index)
    anchor.append(row)
    const hidden = document.createElement('span')
    hidden.id = 'row-' + index
    hidden.hidden = true
    hidden.textContent = path
    li.append(anchor, hidden)
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

  // ④b–④e 钉住「确证无接收方 → 收起左段」的判据。
  // 壳侧真源：FileExternalBridge.errorPayload 产出 {"ok":false,"error":"no-receiver"}。
  // 历史缺陷：插件曾读 reason === 'no-handler'，字段名与取值名双双错位，这段降级在真机上是死代码。

  it('④b 壳侧答 error=no-receiver 后左段永久收起（不留点了报错的按钮）', async () => {
    buildSingleCard('/work/a.md')
    const bridge = makeBridge(() => '{"ok":false,"error":"no-receiver"}')
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(EXTERNAL)!.click()
    expect(capsule.externalAvailable()).toBe(false)
    expect(document.querySelector(EXTERNAL)).toBeNull()
    expect(document.querySelector(SHARE)).not.toBeNull()
    expect(document.querySelector(CAPSULE)!.hasAttribute('data-dsh-file-capsule-share-only')).toBe(true)
  })

  it('④c 壳侧答 ok=true 时不收起左段', async () => {
    buildSingleCard('/work/a.md')
    const bridge = makeBridge(() => '{"ok":true}')
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(EXTERNAL)!.click()
    expect(capsule.externalAvailable()).toBe(true)
    expect(document.querySelector(EXTERNAL)).not.toBeNull()
  })

  it('④d 未知 error 保留左段且不永久收起（偶发失败不等于永久无能力）', async () => {
    buildSingleCard('/work/a.md')
    // uri-denied / io / bad-request 都是「这一次调用失败」，不代表机器没有外部应用。
    for (const code of ['uri-denied', 'io', 'bad-request', 'future-unknown-code']) {
      buildSingleCard('/work/a.md')
      const bridge = makeBridge(() => JSON.stringify({ ok: false, error: code }))
      capsule = new FileCardCapsule(() => bridge, COPY)
      capsule.attach()
      await flush()
      document.querySelector<HTMLElement>(EXTERNAL)!.click()
      expect(capsule.externalAvailable(), code + ' 不应被当成永久无能力').toBe(true)
      expect(document.querySelector(EXTERNAL), code + ' 后左段应保留').not.toBeNull()
      capsule.detach()
    }
  })

  it('④e-1 error 与 reason 同时存在时以 error 为准（壳侧是唯一真源）', async () => {
    buildSingleCard('/work/a.md')
    // 旧壳字段 reason=no-handler 与壳侧 error=io 并存：必须听 error，不能收起左段。
    const bridge = makeBridge(() => '{"ok":false,"error":"io","reason":"no-handler"}')
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(EXTERNAL)!.click()
    expect(capsule.externalAvailable(), 'error 在场时不得退回 reason').toBe(true)
  })

  it('④e 旧壳 reason=no-handler 归一为 no-receiver（向后兼容，待旧版退场后删）', async () => {
    buildSingleCard('/work/a.md')
    const bridge = makeBridge(() => '{"ok":false,"reason":"no-handler"}')
    capsule = new FileCardCapsule(() => bridge, COPY)
    capsule.attach()
    await flush()
    document.querySelector<HTMLElement>(EXTERNAL)!.click()
    expect(capsule.externalAvailable()).toBe(false)
    expect(document.querySelector(EXTERNAL)).toBeNull()
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
    expect(capsule.act('share', '/work/a.md')).toEqual({ ok: true })
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

/**
 * 扫描探针：覆写两个 protected 入口来数「扫了几次 / 扫了多大范围」。
 *
 * 生产代码里没有为测试留的可变状态——`cardsIn` 是唯一的卡片查询入口，`scanBatch` 是唯一的
 * 批量扫描出口，观察点就长在真实的调用链上（不是旁路计数器）。
 */
class ProbeCapsule extends FileCardCapsule {
  /** 每次卡片查询的根：'document' = 全文档扫描。 */
  readonly roots: string[] = []
  /** 每一批扫了几张卡片。 */
  readonly batches: number[] = []

  protected override cardsIn(root: ParentNode): HTMLElement[] {
    this.roots.push(root === document ? 'document' : root === document.documentElement ? 'documentElement' : 'subtree')
    return super.cardsIn(root)
  }

  protected override scanBatch(cards: readonly HTMLElement[]): void {
    this.batches.push(cards.length)
    super.scanBatch(cards)
  }

  /** 只看 attach 之后的区间。 */
  reset(): void {
    this.roots.length = 0
    this.batches.length = 0
  }

  /** 全文档扫描次数。 */
  get documentScans(): number {
    return this.roots.filter(root => root === 'document').length
  }
}

/** 连观察器回调与合批微任务一起跑完（比 flush 多等两拍，避免批次没落地就断言）。 */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) await Promise.resolve()
}

/** 一条卡片的查询次数：只数真正的卡片选择器，别的 querySelectorAll 不算。 */
function cardScans(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter(call => call[0] === '[data-changed-files]').length
}

let probe: ProbeCapsule

describe('#985 观察面：合批 + 限定子树', () => {
  afterEach(() => {
    probe?.detach()
  })

  it('流式 token 追加不回扫：整份文档零查询、已知卡片零重扫（反证：旧实现每次全文档扫）', async () => {
    buildSingleCard('/work/a.md')
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    // attach 的那一次全文档扫描是允许的；从这以后不该再出现。
    expect(probe.documentScans).toBe(1)
    probe.reset()

    const spy = vi.spyOn(document, 'querySelectorAll')
    const paragraph = document.createElement('p')
    document.body.append(paragraph)
    await settle()
    probe.reset()
    // 真实的流式形态：一堆叶子节点（token 文本、行内 span）追加进既有段落。
    for (let index = 0; index < 30; index += 1) {
      // 主流式形态：文本节点（markdown 增量）+ 行内元素交替追加。
      paragraph.append('tok' + index)
      if (index % 3 === 0) paragraph.append(document.createElement('span'))
    }
    await settle()

    expect(cardScans(spy), '流式追加时对整份文档做了卡片查询').toBe(0)
    expect(probe.documentScans, '无关变更重新扫了整份文档').toBe(0)
    expect(probe.roots, '无关变更不该产生任何卡片查询').toEqual([])
    expect(probe.batches, '无关变更不该产生扫描批次').toEqual([])
    spy.mockRestore()
  })

  it('无关容器插入时只在那个子树里找卡片，绝不下探整份文档', async () => {
    buildSingleCard('/work/a.md')
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    // 新消息外层容器带着一棵与卡片无关的子树一次性插进来（React 一次提交的形状）。
    const message = document.createElement('div')
    const body = document.createElement('div')
    body.append(document.createElement('p'), document.createElement('pre'))
    message.append(body)
    document.body.append(message)
    await settle()

    expect(probe.roots, '查询范围被限制在新增子树里').toEqual(['subtree'])
    expect(probe.documentScans, '无关容器插入不该升级成全文档扫描').toBe(0)
    expect(probe.batches, '无关子树里没有卡片，不该产生扫描批次').toEqual([])
  })

  it('已有卡片内部的变更只重扫那一张卡片，不扫整份文档', async () => {
    const card = buildMultiCard(['/work/a.md'])
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    // 流式追加一行：上游会往同一个 ul 里插新的 li。
    const list = card.querySelector('ul')!
    const li = document.createElement('li')
    const anchor = document.createElement('span')
    const row = document.createElement('button')
    row.type = 'button'
    row.setAttribute('aria-describedby', 'late-row')
    anchor.append(row)
    const hidden = document.createElement('span')
    hidden.id = 'late-row'
    hidden.hidden = true
    hidden.textContent = '/work/late.md'
    li.append(anchor, hidden)
    list.append(li)
    await settle()

    expect(probe.documentScans, '卡片内部变更不该升级成全文档扫描').toBe(0)
    // 已知卡片内部变更走「登记这张卡」，不做子树查询，也不碰别的卡。
    expect(probe.roots, '已知卡片不该再做卡片查询').toEqual([])
    expect(probe.batches, '只重扫那一张卡片').toEqual([1])
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(2)
  })

  it('同一拍的六次变更只换一次扫描（microtask 合批，不逐条放大）', async () => {
    const card = buildMultiCard(['/work/a.md'])
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    const list = card.querySelector('ul')!
    for (let index = 0; index < 6; index += 1) {
      const li = document.createElement('li')
      const anchor = document.createElement('span')
      const row = document.createElement('button')
      row.type = 'button'
      row.setAttribute('aria-describedby', 'batch-row-' + index)
      anchor.append(row)
      const hidden = document.createElement('span')
      hidden.id = 'batch-row-' + index
      hidden.hidden = true
      hidden.textContent = '/work/batch-' + index + '.md'
      li.append(anchor, hidden)
      list.append(li)
    }
    await settle()

    // 六条记录、同一张卡：一批、一次扫描。逐条扫会得到六个批次。
    expect(probe.batches, '六次变更被合成一批').toEqual([1])
    expect(probe.roots, '已知卡片不再做任何卡片查询').toEqual([])
    // 合批不得把卡片漏掉：六行全部挂上（原有 1 行 + 新增 6 行）。
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(7)
  })

  it('跨两个微任务到达的变更仍然各自成批，但都不做全文档扫描', async () => {
    const card = buildMultiCard(['/work/a.md'])
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    const list = card.querySelector('ul')!
    list.append(document.createElement('li'))
    // 让观察器投递一次、合批微任务落地，再来一次（React 分两次提交的形态）。
    await settle()
    list.append(document.createElement('li'))
    await settle()

    expect(probe.documentScans).toBe(0)
    expect(probe.batches.length).toBeGreaterThanOrEqual(1)
    expect(probe.batches.length).toBeLessThanOrEqual(2)
    expect(probe.batches.every(count => count === 1), '每次都只扫这张卡').toBe(true)
  })

  it('放行例：新卡片在两次微任务内挂上胶囊（观察器一拍 + 合批一拍，不多等）', async () => {
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    buildSingleCard('/work/late.md')
    // 只给两拍：① 观察器回调投递；② 合批微任务落地。多一拍就说明合批把新卡片拖后了。
    await Promise.resolve()
    await Promise.resolve()
    expect(document.querySelectorAll(CAPSULE), '新卡片没有在一拍内被挂上胶囊').toHaveLength(1)
  })

  it('放行例：attach 之后插入的新卡片一个 microtask 批次内挂上胶囊', async () => {
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    buildSingleCard('/work/late.md')
    await settle()
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(1)
    expect(probe.documentScans, '发现新卡片不该靠重扫整份文档').toBe(0)
  })

  it('放行例：卡片插在深层容器里同样被发现', async () => {
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    const wrapper = document.createElement('div')
    const inner = document.createElement('div')
    const message = document.createElement('article')
    inner.append(message)
    wrapper.append(inner)
    document.body.append(wrapper)
    // buildSingleCard 自己 append 到 body，这里把它搬进深层容器。
    const header = buildSingleCard('/work/deep.md')
    const deepCard = header.closest('[data-changed-files]')!
    message.append(deepCard)
    await settle()

    expect(document.querySelectorAll(CAPSULE)).toHaveLength(1)
    expect(probe.documentScans).toBe(0)
  })

  it('放行例：迟到的路径 span 会在同一张卡片上补扫出胶囊', async () => {
    // 上游先挂按钮、下一帧才写 aria-describedby 指向的 hidden span（React 分两次提交）。
    const card = document.createElement('div')
    card.setAttribute('data-changed-files', '')
    card.setAttribute('data-single', '')
    const header = document.createElement('button')
    header.type = 'button'
    card.append(header)
    document.body.append(card)

    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(0)
    probe.reset()

    header.setAttribute('aria-describedby', 'late-path')
    const hidden = document.createElement('span')
    hidden.id = 'late-path'
    hidden.hidden = true
    hidden.textContent = '/work/late.md'
    card.append(hidden)
    await settle()

    expect(document.querySelectorAll(CAPSULE)).toHaveLength(1)
    expect(probe.documentScans).toBe(0)
  })

  it('卡片被移除后不留失效引用：后续变更既不扫它也不抛错', async () => {
    const card = buildMultiCard(['/work/a.md', '/work/b.md'])
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(2)

    card.remove()
    await settle()
    probe.reset()

    // 被摘掉的子树内部再变一次（React 卸载清理的常见形状）：目标脱树，必须直接跳过。
    card.querySelector('ul')!.append(document.createElement('li'))
    await settle()
    expect(probe.roots, '脱树的目标仍被扫描（持有失效引用）').toEqual([])
    expect(probe.batches).toEqual([])

    // 新的卡片照常被发现，且不会把已移除的那张带回来。
    buildSingleCard('/work/c.md')
    await settle()
    expect(probe.batches).toEqual([1])
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(1)
  })

  it('detach 之后已排队的合批不再执行（HMR 安全）', async () => {
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    const card = document.createElement('div')
    card.setAttribute('data-changed-files', '')
    card.setAttribute('data-single', '')
    const header = document.createElement('button')
    header.type = 'button'
    header.setAttribute('aria-describedby', 'gone-path')
    card.append(header)
    document.body.append(card)
    // 观察器回调已投递、合批微任务还没跑的时候 detach。
    await Promise.resolve()
    probe.detach()
    await settle()

    expect(probe.batches).toEqual([])
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(0)
  })

  it('detach 后立刻 re-attach（HMR）：上一轮排队的批次作废，不落到新一轮头上', async () => {
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    // 先制造一条变更：观察器回调投递、合批微任务已排队，但还没跑。
    buildSingleCard('/work/a.md')
    await Promise.resolve()

    probe.detach()
    probe.attach()
    // 新一轮的首次扫描已经跑完，从这里只看旧批次会不会漏进来。
    probe.reset()
    await settle()

    expect(probe.batches, '上一轮排队的批次落到了新一轮头上').toEqual([])
    expect(document.querySelectorAll(CAPSULE), 're-attach 后存量卡片应重新挂上').toHaveLength(1)
  })

  it('自己挂的胶囊不触发回声重扫', async () => {
    probe = new ProbeCapsule(() => makeBridge(() => '{"ok":true}'), COPY)
    probe.attach()
    await settle()
    probe.reset()

    buildMultiCard(['/work/a.md', '/work/b.md', '/work/c.md'])
    await settle()

    // 插入一条记录 → 一批扫描；这三次 append 胶囊自己的三条记录不得再换三次扫描。
    expect(probe.batches).toEqual([1])
    expect(document.querySelectorAll(CAPSULE)).toHaveLength(3)
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
