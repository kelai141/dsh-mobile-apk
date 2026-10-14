// @vitest-environment jsdom
// 0.14.6 功能 A6 客户端半：开发者选项里的「补齐模型能力」行。
//
// 判据（SPEC-0.14.6 A6 + A7）：
//   ① 手动入口落在既有开发者选项区（dsh-dev-row 样式），不新开独立分区/大按钮；
//   ② 只在用户点击时发一次 POST（**不得**挂载即调用 —— 那是 A7 禁止的自动路径）；
//   ③ 带 same-origin 凭据（浏览器面鉴权 = 会话 cookie，与 RuntimeCacheRow 同款）；
//   ④ 结果如实呈现：「没有可补的字段」「补齐失败」「读不到」三者必须分得开；
//   ⑤ 未授权时不冒充成功，状态码只进 data-http 不上正文。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModelCapabilityRow, ModelCapabilitySection } from '../src/client/dev-section/model-capability.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface RouteCall { url: string; method: string; credentials?: string }

function makeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: RouteCall[] = []
  const impl = vi.fn(async (input: string, init?: { method?: string; credentials?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ url: input, method, credentials: init?.credentials })
    const route = routes[input]
    if (route === undefined) throw new Error('unexpected fetch: ' + input)
    const status = route.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => route.body ?? {} }
  })
  return { calls, impl }
}

const FILL_URL = '/api/android/model-capability/fill'

let root: Root | undefined
let host: HTMLElement | undefined

async function render(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<ModelCapabilityRow />) })
  return host
}

const fillButton = (el: HTMLElement): HTMLButtonElement =>
  [...el.querySelectorAll('button')].find((b) => b.textContent === '补齐') as HTMLButtonElement

beforeEach(() => {
  Object.defineProperty(window, 'androidBridge', { value: undefined, configurable: true, writable: true })
})
afterEach(async () => {
  if (root !== undefined) {
    await act(async () => { root!.unmount() })
    root = undefined
  }
  host?.remove()
  host = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ModelCapabilityRow（A6 手动补齐入口）', () => {
  it('挂载不发任何请求（A7：手动动作不得退化成自动触发）', async () => {
    const fetchSpy = makeFetch({ [FILL_URL]: { body: { ok: true } } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(fetchSpy.calls, '挂载即调用 = 自动路径（A7 禁止）').toHaveLength(0)
    expect(el.textContent).toContain('按需补齐')
  })

  it('点击后发一次 same-origin POST，且只发一次', async () => {
    const fetchSpy = makeFetch({ [FILL_URL]: { body: { ok: true, routes: 1, wrote: 1, details: [] } } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(fetchSpy.calls).toEqual([{ url: FILL_URL, method: 'POST', credentials: 'same-origin' }])
  })

  it('有写入时报告「已补齐 N 个提供商」并逐路由列出写入明细', async () => {
    const fetchSpy = makeFetch({
      [FILL_URL]: { body: {
        ok: true, routes: 1, wrote: 1,
        details: [{ route: 'my-custom-gateway', wrote: true, reason: 'wrote', changes: ['glm-5: 补 reasoningEfforts=low/high'] }],
      } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent).toContain('已补齐 1 个提供商')
    expect(el.textContent).toContain('my-custom-gateway')
    expect(el.textContent).toContain('补 reasoningEfforts=low/high')
  })

  it('没有可补字段时是「没有需要补齐的字段」，不是失败也不是已补齐', async () => {
    const fetchSpy = makeFetch({
      // reason 必须是**插件真实会返回的**串（applyModelPatch 的 'no-change'）。
      // 旧夹具写的 'no-missing-fields' 不是真实值，会让主行分流判据失真。
      [FILL_URL]: { body: { ok: true, routes: 1, wrote: 0, details: [{ route: 'gw', wrote: false, reason: 'no-change' }] } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent).toContain('没有需要补齐的字段')
    expect(el.textContent).not.toContain('已补齐')
    // 未写入的逐路由原因如实上屏（不粉饰）。
    expect(el.textContent).toContain('no-change')
  })

  // Lead 2026-10-11 裁定：主行必须区分「确实无可补」与「有可补但没写进去」。
  // 旧实现只看 wrote>0，于是设备上「xiaomimimo — 未写入（mutate-rejected）」也显示
  // 「没有需要补齐的字段」，让用户以为功能正常（误导性文案）。
  it('有路由要补却一条都没写进去：主行如实说「未能写入」，不得暗示成功', async () => {
    const fetchSpy = makeFetch({
      [FILL_URL]: { body: { ok: true, routes: 1, wrote: 0, details: [
        { route: 'xiaomimimo', wrote: false, reason: 'mutate-rejected', changes: [] },
      ] } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent, '实际什么都没补上，不得显示为「没有需要补齐的字段」')
      .not.toContain('没有需要补齐的字段')
    expect(el.textContent).not.toContain('已补齐')
    expect(el.textContent).toContain('未能写入')
    // 具体原因仍如实上屏
    expect(el.textContent).toContain('mutate-rejected')
  })

  it('良性 no-change 与真失败混在一起时：失败项计入「未能写入」，良性项不计', async () => {
    const fetchSpy = makeFetch({
      [FILL_URL]: { body: { ok: true, routes: 2, wrote: 0, details: [
        { route: 'gw-a', wrote: false, reason: 'no-change' },
        { route: 'gw-b', wrote: false, reason: 'mutate-rejected' },
      ] } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent, '只有 1 项是真失败，不得把良性 no-change 也算进去')
      .toContain('有 1 项未能写入')
  })

  it('宿主返回错误状态时如实报「未获授权」，状态码只进 data-http 不上正文', async () => {
    const fetchSpy = makeFetch({ [FILL_URL]: { status: 403 } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent).toContain('未获授权')
    expect(el.textContent, '状态码不得出现在正文').not.toContain('403')
    expect(el.querySelector('[data-http="403"]'), '状态码必须可诊断').not.toBeNull()
  })

  it('宿主不可用（fetch 抛错）时如实说明，不冒充满分', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent).toContain('补齐请求失败')
    expect(el.textContent).not.toContain('已补齐')
  })

  it('响应无法解析时如实说无法解析，不当作成功', async () => {
    const impl = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }))
    vi.stubGlobal('fetch', impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent).toContain('无法解析')
    expect(el.textContent).not.toContain('已补齐')
  })

  it('不展示任何应用私有目录的绝对路径（本行只上屏路由名与人话）', async () => {
    const fetchSpy = makeFetch({
      [FILL_URL]: { body: { ok: true, routes: 1, wrote: 0, details: [{ route: 'gw', wrote: false, reason: 'not-found' }] } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { fillButton(el).click() })
    expect(el.textContent).not.toMatch(/\/data\/user\/0/)
    expect(el.textContent).not.toMatch(/filesDir/)
  })
})

// ── 0.14.8 提级：设置页一级分区的入口（用户反馈「设置页里没有」）──────────────
//
// 判据：
//   ⑥ 分区组件与开发者选项行**共用同一实现**，不复制第二份控件；
//   ⑦ 分区挂载同样是**零请求**，不排任何定时器（提级不得把手动动作变成自动触发/轮询）；
//   ⑧ 点击后仍走同一条受鉴权路由，凭据口径不变。

describe('ModelCapabilitySection（0.14.8 设置页一级分区）', () => {
  const mountSection = async (): Promise<HTMLElement> => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => { root!.render(<ModelCapabilitySection {...({} as never)} />) })
    return host
  }

  it('分区挂载不发任何请求（提级不得引入自动触发）', async () => {
    const fetchSpy = makeFetch({ [FILL_URL]: { body: { ok: true } } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    await mountSection()
    expect(fetchSpy.calls, '分区挂载即调用 = A7 禁止的自动路径').toHaveLength(0)
  })

  it('分区复用行组件（同一实现，不复制第二份控件）', async () => {
    const fetchSpy = makeFetch({ [FILL_URL]: { body: { ok: true } } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await mountSection()
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === '补齐')
    expect(btn, '分区块里缺少补齐按钮').toBeTruthy()
    expect(el.querySelector('[data-plugin="dev-model-capability"]'), '分区未复用行组件').toBeTruthy()
  })

  it('点击后走同一条受鉴权路由且带 same-origin 凭据', async () => {
    const fetchSpy = makeFetch({ [FILL_URL]: { body: { ok: true, routes: 1, wrote: 0, details: [] } } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await mountSection()
    const btn = [...el.querySelectorAll('button')].find((b) => b.textContent === '补齐') as HTMLButtonElement
    await act(async () => { btn.click() })
    expect(fetchSpy.calls).toHaveLength(1)
    expect(fetchSpy.calls[0].url).toBe(FILL_URL)
    expect(fetchSpy.calls[0].method).toBe('POST')
    expect(fetchSpy.calls[0].credentials, '凭据口径变化').toBe('same-origin')
  })
})
