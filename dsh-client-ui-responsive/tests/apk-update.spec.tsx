// @vitest-environment jsdom
// 0.14.6 客户端半 → 0.15.0 提级：设置页「应用更新」分区（检查 + 下载两枚按钮）。
//
// 用户指令：「更新不应该是只更新快照，应该是下载 apk 然后更新」；
// 0.15.0 追加拍板：「更新块继续放设置页」「从开发者选项提出来」。
// 壳侧能力一直齐备，但状态机曾长在引导页渲染器里、健康态 showWeb() 把引导页藏起来
// => 健康状态没有任何更新入口。本分区补上入口，且与引导页按钮读同一份真源状态。
//
// 本套用例守六件事：
//  1) 八态的文本与**两枚按钮各自的文案/可见性/可点性**（与 CONTRACT C 节的壳侧状态表同口径）；
//  2) **available 态检查按钮禁用**：壳侧 beginCheck() 会清掉已发现的新版载荷，此刻再检查等于丢掉可下载的包；
//  3) **两枚按钮各自硬绑定动作**：点检查只发 check、点下载只发 install，页面不再按状态推断意图
//     （旧实现按 `state === 'available' || canStart` 推断，推断与壳侧受理判据脱节时用户会走进死路）；
//  4) **失败原因原样展示**（不翻译/不截断/不覆盖）——壳侧 reason 已是成句中文；
//  5) **读不到 ≠ idle**：桥缺席时不得显示成「已是最新/未检查」这类合法空态；
//  6) **只在进行中态轮询**：终态立即停止（不做常驻定时器）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ApkUpdateRow, ApkUpdateSection } from '../src/client/dev-section/apk-update.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let host: HTMLElement | undefined

/** 装一个按 state 直接回值的桥（最简：所有 status 都回同一态），并返回被调用的动作序列。 */
function bridgeWith(state: string, extra: Record<string, unknown> = {}): string[] {
  const calls: string[] = []
  Object.defineProperty(window, 'androidBridge', {
    value: { apkUpdate: (action: string) => { calls.push(action); return JSON.stringify({ ok: true, state, ...extra }) } },
    configurable: true, writable: true,
  })
  return calls
}

async function render(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<ApkUpdateRow />) })
  return host
}

/** 主行（含两枚按钮）的文本。 */
function rowText(el: HTMLElement): string {
  return el.querySelector('.dsh-gs-row')?.textContent ?? ''
}

/**
 * 按 `data-apk-action` 取按钮。
 * 旧用例按 `.dsh-dev-row button` 取第一枚——两枚按钮并存后那会**随机取到检查那枚**，
 * 断言就成了「点了哪个全看渲染顺序」，所以必须按动作名取。
 * @param el - 渲染容器。
 * @param action - 壳侧动作名（check / install）。
 * @returns 该动作的按钮；本态不渲染这个动作时返回 null（可见性由用例自行断言）。
 */
function button(el: HTMLElement, action: 'check' | 'install'): HTMLButtonElement | null {
  return el.querySelector(`[data-apk-action="${action}"]`) as HTMLButtonElement | null
}

beforeEach(() => {
  Object.defineProperty(window, 'androidBridge', { value: undefined, configurable: true, writable: true })
})
afterEach(async () => {
  if (root !== undefined) await act(async () => { root!.unmount() })
  root = undefined
  host?.remove()
  host = undefined
  vi.useRealTimers()
})

describe('设置页「应用更新」行：八态的文本与两枚按钮', () => {
  it('idle：说「未检查」，检查按钮可点，下载按钮不渲染', async () => {
    bridgeWith('idle')
    const el = await render()
    expect(rowText(el)).toContain('未检查')
    const check = button(el, 'check')
    expect(check?.textContent).toBe('检查更新')
    expect(check?.disabled).toBe(false)
    expect(button(el, 'install'), '本态没有可受理的 install，摆了也是点了没反应').toBeNull()
  })

  it('checking：检查按钮禁用且说「检查中…」，下载按钮不渲染', async () => {
    bridgeWith('checking')
    const el = await render()
    expect(rowText(el)).toContain('正在查询最新版本')
    const check = button(el, 'check')
    expect(check?.textContent).toBe('检查中…')
    expect(check?.disabled).toBe(true)
    expect(button(el, 'install')).toBeNull()
  })

  it('up-to-date：显示壳侧给的版本，检查按钮变「重新检查」且可点', async () => {
    bridgeWith('up-to-date', { version: 'v0.14.6' })
    const el = await render()
    expect(rowText(el)).toContain('APK 已是最新 v0.14.6')
    const check = button(el, 'check')
    expect(check?.textContent).toBe('重新检查')
    expect(check?.disabled).toBe(false)
    expect(button(el, 'install')).toBeNull()
  })

  // 关键用例一：protected 载荷。壳侧 beginCheck() 会清 currentResult，discovered 的包就没了。
  it('available：**检查按钮禁用**、下载按钮可点，并如实给出资产名与体积', async () => {
    bridgeWith('available', { tag: 'v0.14.7', name: 'dsh-mobile-apk-v0.14.7-x86_64.apk', current: '0.14.6', sizeBytes: 169 * 1024 * 1024 })
    const el = await render()
    const check = button(el, 'check')
    const install = button(el, 'install')
    expect(check?.disabled, '发现新版时再检查会清掉壳侧载荷，必须禁用').toBe(true)
    expect(install, '发现新版时下载按钮必须在场').not.toBeNull()
    expect(install?.disabled).toBe(false)
    expect(install?.textContent).toBe('下载并安装 v0.14.7')
    // 用户要知道「将装哪个包」与「多大」——资产名是本机 ABI 的那个；旧文案「再点一次同一按钮」已删除。
    expect(rowText(el)).toContain('dsh-mobile-apk-v0.14.7-x86_64.apk')
    expect(rowText(el)).toContain('169.0 MB')
    expect(rowText(el)).toContain('当前 v0.14.6')
    expect(rowText(el)).not.toContain('再点')
  })

  // 壳侧 0.15.0 新增 snapshotJson 的 "sha256"：语义是**发布方声明的校验值**，不是「已校验通过」。
  it('available 且发布方给了摘要：如实说「发布方声明」，不得渲染成已校验通过', async () => {
    const sha = 'a'.repeat(64)
    bridgeWith('available', { tag: 'v0.14.7', name: 'x.apk', current: '0.14.6', sizeBytes: 1024, sha256: sha })
    const el = await render()
    const detail = el.querySelector('[data-apk-detail]')?.textContent ?? ''
    expect(detail).toContain('发布方声明')
    expect(detail, '摘要要给出可核对的字符').toContain('aaaaaaaaaaaa')
    expect(detail, '不得声称已校验通过').not.toContain('已校验通过')
  })

  it('available 但本次发布没给摘要：如实说没给，不得留空冒充通过', async () => {
    bridgeWith('available', { tag: 'v0.14.7', name: 'x.apk', current: '0.14.6', sizeBytes: 1024 })
    const el = await render()
    const detail = el.querySelector('[data-apk-detail]')?.textContent ?? ''
    expect(detail).toContain('未提供 sha256 摘要')
    expect(detail, '不得声称已校验通过').not.toContain('已校验通过')
  })

  it('downloading：两枚按钮都禁用并显示真实百分比', async () => {
    bridgeWith('downloading', { percent: 42, name: 'x.apk', sizeBytes: 1024 })
    const el = await render()
    expect(button(el, 'check')?.disabled).toBe(true)
    const install = button(el, 'install')
    expect(install?.textContent).toBe('下载中 42%')
    expect(install?.disabled).toBe(true)
  })

  it('installing：说清「装完需重开应用」；复用缓存时如实说明，检查按钮可点', async () => {
    bridgeWith('installing', { reused: true })
    const el = await render()
    expect(rowText(el)).toContain('重新打开应用')
    expect(rowText(el)).toContain('复用了上次已下载')
    expect(button(el, 'check')?.disabled).toBe(false)
    expect(button(el, 'install')).toBeNull()
  })

  it('need-permission：检查禁用，下载按钮是「授权后继续安装」且可点', async () => {
    bridgeWith('need-permission')
    const el = await render()
    expect(rowText(el)).toContain('安装未知应用')
    expect(button(el, 'check')?.disabled).toBe(true)
    const install = button(el, 'install')
    expect(install?.textContent).toBe('授权后继续安装')
    expect(install?.disabled).toBe(false)
  })

  it('failed 且手上没有待装包：原因原样展示，检查按钮变「重试」，不摆下载按钮', async () => {
    // 没有 readyToInstall 时重试路径只能是 check（重新取元数据），再发 install 壳侧会回 not-available。
    const reason = '检查失败：更新接口限流（HTTP 403）——接口未认证时每小时只有 60 次查询，请稍后重试。这与本机架构无关，不代表没有适配版本'
    bridgeWith('failed', { reason })
    const el = await render()
    expect(rowText(el)).toContain(reason)
    const check = button(el, 'check')
    expect(check?.textContent).toBe('重试')
    expect(check?.disabled).toBe(false)
    expect(button(el, 'install'), '没有可续继的包时不摆下载按钮，点了只会被壳侧拒绝').toBeNull()
  })

  // 安装器拉起失败会留下一个已校验的包；此时 install 是「重试安装」而不是重新下载 169MB。
  it('failed 但壳侧还有已校验的包（hasReadyArtifact）：给「重试安装」按钮且可点', async () => {
    bridgeWith('failed', { reason: '安装器拉起失败，请再点「下载并安装」重试', hasReadyArtifact: true })
    const el = await render()
    const install = button(el, 'install')
    expect(install, '有已校验的包时必须给重试安装的入口').not.toBeNull()
    expect(install?.textContent).toBe('重试安装')
    expect(install?.disabled).toBe(false)
    // 检查按钮仍可用（另一条路是重新取元数据）。
    expect(button(el, 'check')?.disabled).toBe(false)
  })

  // 壳侧每个相位都发恒为布尔的 hasReadyArtifact；false 是最常见的失败形态（镜像链全挂 = 没下到包）。
  it('failed 且 hasReadyArtifact=false：不摆下载按钮', async () => {
    bridgeWith('failed', { reason: '下载失败：镜像链全部不可用', hasReadyArtifact: false })
    const el = await render()
    expect(button(el, 'install')).toBeNull()
  })

  it('旧壳侧快照压根没这个字段时同样不摆（按「没有」兜住，不靠旁证猜）', async () => {
    bridgeWith('failed', { reason: '下载失败：镜像链全部不可用' })
    const el = await render()
    expect(button(el, 'install')).toBeNull()
  })

  it('failed 但没有 reason：如实说未给原因，不编造', async () => {
    bridgeWith('failed')
    const el = await render()
    expect(rowText(el)).toContain('壳侧未给出原因')
  })
})

describe('读不到 ≠ 合法空态', () => {
  it('桥缺席时不得显示成 idle 或「已是最新」', async () => {
    // 不装桥（桌面宿主 / 旧壳）。
    const el = await render()
    expect(rowText(el)).toContain('读不到')
    expect(rowText(el)).not.toContain('已是最新')
    expect(rowText(el)).not.toContain('未检查')
    expect(el.querySelector('.dsh-gs-row')?.getAttribute('data-apk-state')).toBe('unavailable')
  })

  it('桥返回不可解析内容时同样按「读不到」处理（不抛、不冒充）', async () => {
    Object.defineProperty(window, 'androidBridge', {
      value: { apkUpdate: () => 'not-json' }, configurable: true, writable: true,
    })
    const el = await render()
    expect(rowText(el)).toContain('读不到')
    expect(el.querySelector('.dsh-gs-row')?.getAttribute('data-apk-state')).toBe('unavailable')
  })
})

describe('两枚按钮各自硬绑定动作（不再按状态推断）', () => {
  // 关键用例二：旧实现在 act() 里按 `state === 'available' || canStart` 推断动作。
  it('available 态点**检查**按钮发的是 check（即便壳侧说 canStart:true）', async () => {
    const calls = bridgeWith('available', { tag: 'v0.14.7', canStart: true })
    const el = await render()
    calls.length = 0
    const check = button(el, 'check')!
    // 按钮本身就是 disabled（保护载荷），点击不得发出任何动作。
    await act(async () => { check.click() })
    expect(calls, '禁用的检查按钮不得发动作').not.toContain('check')
    expect(calls).not.toContain('install')
  })

  it('available 态点**下载**按钮发的是 install', async () => {
    const calls = bridgeWith('available', { tag: 'v0.14.7', canStart: true })
    const el = await render()
    calls.length = 0
    await act(async () => { button(el, 'install')!.click() })
    expect(calls).toContain('install')
    expect(calls).not.toContain('check')
  })

  it('idle 态点检查按钮发的是 check', async () => {
    const calls = bridgeWith('idle')
    const el = await render()
    calls.length = 0
    await act(async () => { button(el, 'check')!.click() })
    expect(calls).toContain('check')
    expect(calls).not.toContain('install')
  })

  it('failed 态点「重试」发的是 check（不是 install）', async () => {
    const calls = bridgeWith('failed', { reason: '下载失败：镜像链全部不可用' })
    const el = await render()
    calls.length = 0
    await act(async () => { button(el, 'check')!.click() })
    expect(calls).toContain('check')
    expect(calls).not.toContain('install')
  })

  it('failed 且有已校验的包时点「重试安装」发的是 install（续继链，不重新下载）', async () => {
    const calls = bridgeWith('failed', { reason: '安装器拉起失败，请重试', hasReadyArtifact: true })
    const el = await render()
    calls.length = 0
    await act(async () => { button(el, 'install')!.click() })
    expect(calls).toContain('install')
    expect(calls).not.toContain('check')
  })

  // need-permission 的续继链是壳侧 start() 里 readyToInstall/awaitingPermission 那一支；
  // 页面这一侧只需保证「发的是 install」——若页面改发 check，beginCheck() 会清掉待装载荷。
  it('need-permission 态点「授权后继续安装」发的是 install（续继链，不是重新检查）', async () => {
    const calls = bridgeWith('need-permission')
    const el = await render()
    calls.length = 0
    await act(async () => { button(el, 'install')!.click() })
    expect(calls).toContain('install')
    expect(calls).not.toContain('check')
  })
})

describe('回执与轮询纪律', () => {
  it('壳侧回 busy 时如实说明「上一次仍在进行」，不假装受理', async () => {
    Object.defineProperty(window, 'androidBridge', {
      value: {
        apkUpdate: (action: string) => {
          if (action === 'status') return JSON.stringify({ ok: true, state: 'idle' })
          return JSON.stringify({ ok: false, state: 'checking', code: 'busy' })
        },
      },
      configurable: true, writable: true,
    })
    const el = await render()
    await act(async () => { button(el, 'check')!.click() })
    expect(el.textContent).toContain('仍在进行中')
  })

  it('桥缺席时点按钮如实说通道不可用（不假装发起了）', async () => {
    const el = await render()
    await act(async () => { button(el, 'check')!.click() })
    expect(el.textContent).toContain('更新通道不可用')
  })

  it('**只在进行中态轮询**：终态不挂定时器，downloading 才轮询', async () => {
    vi.useFakeTimers()
    // 终态：不应有定时器。
    bridgeWith('up-to-date', { version: 'v0.14.6' })
    await render()
    const idleSpy = vi.fn(() => JSON.stringify({ ok: true, state: 'up-to-date', version: 'v0.14.6' }))
    Object.defineProperty(window, 'androidBridge', {
      value: { apkUpdate: idleSpy }, configurable: true, writable: true,
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(idleSpy.mock.calls.length).toBe(0)
    await act(async () => { root!.unmount() }); root = undefined; host?.remove(); host = undefined

    // 进行中：应每 2 秒读一次 status。
    bridgeWith('downloading', { percent: 10 })
    await render()
    const busySpy = vi.fn(() => JSON.stringify({ ok: true, state: 'downloading', percent: 10 }))
    Object.defineProperty(window, 'androidBridge', {
      value: { apkUpdate: busySpy }, configurable: true, writable: true,
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(4200) })
    // 2 秒一次 => 至少 2 次。
    expect(busySpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('说明段说清「只手动、不自动」与更新的是 APK', async () => {
    bridgeWith('idle')
    const el = await render()
    // 说明段现在挂在行内的灰色说明里（卡片保留、框内用上游行骨架）。
    const hint = [...el.querySelectorAll('.dsh-gs-desc')].map((n) => n.textContent ?? '').join(' ')
    expect(hint).toContain('只在你点击时')
    expect(hint).toContain('APK')
  })
})

describe('分区形态（从开发者选项提级）', () => {
  it('ApkUpdateSection 是可挂进 settings.section 的分区：卡片外壳 + 框内行骨架', async () => {
    bridgeWith('idle')
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root!.render(<ApkUpdateSection close={() => {}} />) })
    // 外壳仍是设置页统一的卡片（用户要求保留「一个框包住」的形态）。
    const section = host.querySelector('section.dsh-screen-control-card')
    expect(section, '分区用设置页统一的卡片外壳').not.toBeNull()
    const titleId = section!.getAttribute('aria-labelledby') ?? ''
    expect(titleId).not.toBe('')
    expect(host.querySelector('#' + titleId)?.textContent).toBe('应用更新')
    // 框内是上游行骨架（标题在左、控件在右），不再套第二层描边盒子。
    const root0 = host.querySelector('[data-plugin="dev-apk-update"]')!
    expect(root0.classList.contains('dsh-dev-cache'), '框内不再套第二层盒子').toBe(false)
    expect(root0.querySelector('.dsh-gs-row'), '框内至少一行').not.toBeNull()
    expect(root0.querySelector('.dsh-gs-title')?.textContent).toBe('检查更新')
    expect(button(host, 'check')).not.toBeNull()
  })

  it('开发者选项只留指路，不再渲染同一组控件（同功能双实现是结构性根因）', async () => {
    const fs = await import('node:fs')
    const dev = fs.readFileSync('src/client/dev-section/DevSection.tsx', 'utf8')
    expect(dev, '开发者选项不得再内嵌 ApkUpdateRow').not.toContain('<ApkUpdateRow')
    expect(dev).toContain('设置 → 应用更新')
    const index = fs.readFileSync('src/client/index.ts', 'utf8')
    expect(index, '一级分区必须在场').toContain("id: 'android-apk-update'")
    expect(index).toContain('ApkUpdateSection')
    // order 96：排在通知（97）/ 手机控制（98）/ 开发者选项（99）之前。
    expect(index).toMatch(/id: 'android-apk-update',\s*\n\s*order: 96,/)
  })

  // 导航图标：上游 navIcon 不认识我们的 id，没登记就落到通用齿轮，五个自有分区里唯独这一行长得不一样。
  it('导航行图标已登记：几何取自上游 IconDownloadOutlineArtwork（16x16，三段描边）', async () => {
    const fs = await import('node:fs')
    const nav = fs.readFileSync('src/client/mobile/settings-nav.ts', 'utf8')
    const block = nav.split("['应用更新', {")[1] ?? ''
    expect(block, '「应用更新」必须登记在 OWN_SECTION_ICONS 里').not.toBe('')
    const body = block.split('}],')[0] ?? ''
    expect(body, '图标几何必须与上游同规格 16x16').toContain("viewBox: '0 0 16 16'")
    // 上游 IconDownloadOutlineArtwork 的三段 d（自 `ui-primitives/src/icons/index.tsx` 原样拷贝）：
    // 改成别的图标时这三条会一起变，改动必须是有意的。
    for (const d of [
      "'M8 1.95317V10.0469'",
      "'M4.25 6.29688L8 10.0469L11.75 6.29688'",
      "'M1.5 10.0469V13.158C1.5 13.3937 1.60536 13.6198 1.79289 13.7865C1.98043 13.9532 2.23478 14.0469 2.5 14.0469H13.5C13.7652 14.0469 14.0196 13.9532 14.2071 13.7865C14.3946 13.6198 14.5 13.3937 14.5 13.158V10.0469'",
    ]) expect(body, '这一段与上游 IconDownloadOutline 的 d 必须逐字一致').toContain(d)
    // sectionIcon 只能表达「首段填充、其余描边」；上游下载图标三段全是描边，不能带 filledFirstPath。
    expect(body, '上游下载图标无填充段，不得声明 filledFirstPath').not.toContain('filledFirstPath')

    // 与已有四个分区互不相同。settings-nav.spec 的「图标互不相同」只覆盖三个行，
    // 抓不到「新分区抄了某个既有图标」——重复几何在本分区就会退化成「两个分类同一个图标」，
    // 用户凭图标区分分类的能力正是这张表存在的理由。
    const pathsOf = (source: string, label: string): string[] => {
      const section = source.split("['" + label + "', {")[1] ?? ''
      const list = section.split('paths: [')[1]?.split(']')[0] ?? ''
      return [...list.matchAll(/'([^']+)'/g)].map(match => match[1]!)
    }
    const mine = pathsOf(nav, '应用更新')
    expect(mine.length, '「应用更新」必须有自己的 path 几何').toBeGreaterThan(0)
    for (const other of ['开发者选项', '手机控制', '通知', '模型能力']) {
      expect(pathsOf(nav, other), '「应用更新」的图标不得与「' + other + '」重复').not.toEqual(mine)
    }
  })
})
