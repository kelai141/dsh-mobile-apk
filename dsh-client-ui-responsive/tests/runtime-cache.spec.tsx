// @vitest-environment jsdom
// 0.14.1 块 E 客户端半：设置页「清除运行时缓存」必须**先给可回收体积再执行**，
// 且跳过/失败项如实呈现、绝不展示应用私有目录的绝对路径（详档 §4.3③/§12.5）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RuntimeCacheRow } from '../src/client/dev-section/runtime-cache.tsx'

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

interface RouteCall { url: string; method: string; credentials?: string }

/** 假 fetch：按 URL 分派，并记录调用次序（用于断言「先扫描后执行」）。 */
function makeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: RouteCall[] = []
  const impl = vi.fn(async (input: string, init?: { method?: string; credentials?: string }) => {
    const method = init?.method ?? 'GET'
    calls.push({ url: input, method, credentials: init?.credentials })
    const route = routes[input]
    if (route === undefined) throw new Error('unexpected fetch: ' + input)
    const status = route.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body ?? {},
    }
  })
  return { calls, impl }
}

let root: Root | undefined
let host: HTMLElement | undefined

async function render(): Promise<HTMLElement> {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(<RuntimeCacheRow />) })
  return host
}

const SCAN_BODY = {
  ok: true,
  reclaimableBytes: 3 * 1024 * 1024,
  targets: [
    { id: 'engine-log-1', kind: 'engine-log-generation', label: '$DSH_FILES_DIR/engine.log.1', bytes: 1024 * 1024, files: 1 },
    { id: 'cache-pip', kind: 'cache-subdirectory', label: '$DSH_HOME/cache/pip', bytes: 2 * 1024 * 1024, files: 7 },
  ],
  skipped: [
    { id: 'cache-attachments', label: '$DSH_HOME/cache/attachments', reason: 'not-allowlisted' },
    { id: 'engine-log-current', label: '$DSH_FILES_DIR/engine.log', reason: 'current-generation-absent' },
  ],
}

const EXECUTE_BODY = {
  ok: true,
  removed: 1,
  failed: 1,
  removedBytes: 1024 * 1024,
  plannedBytes: 3 * 1024 * 1024,
  items: [
    { id: 'engine-log-1', label: '$DSH_FILES_DIR/engine.log.1', status: 'removed', bytes: 1024 * 1024 },
    { id: 'cache-pip', label: '$DSH_HOME/cache/pip', status: 'failed', bytes: 0, reason: 'remove-failed', detail: 'EBUSY: injected' },
  ],
}

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

describe('RuntimeCacheRow（块 E 设置页面）', () => {
  it('挂载即扫描并展示实测可回收体积与逐项清单', async () => {
    const fetchSpy = makeFetch({ '/api/android/runtime-cache/scan': { body: SCAN_BODY } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    expect(fetchSpy.calls).toEqual([
      { url: '/api/android/runtime-cache/scan', method: 'GET', credentials: 'same-origin' },
    ])
    expect(el.textContent).toContain('3.0 MB')
    expect(el.textContent).toContain('$DSH_FILES_DIR/engine.log.1')
    expect(el.textContent).toContain('$DSH_HOME/cache/pip')
    // 白名单说明与硬清单口径必须在场（用户能看到边界）。
    expect(el.textContent).toContain('只按清单清理')
    expect(el.textContent).toContain('120分钟可手动回收')
    expect(el.textContent).toContain('不清理仍可用')
    expect(el.textContent).toContain('清理后显示占位')
    expect(el.textContent).toContain('当前日志保留')
  })

  it('不展示任何绝对路径（只接受宿主下发的 $DSH_HOME/$DSH_FILES_DIR 标签）', async () => {
    const fetchSpy = makeFetch({ '/api/android/runtime-cache/scan': { body: SCAN_BODY } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(el.textContent).not.toMatch(/\/data\/user\/0/)
    expect(el.textContent).not.toMatch(/filesDir/)
    expect(el.textContent).not.toMatch(/^[A-Z]:\\/)
  })

  it('先给体积再执行：清理必须先经二次确认，未确认前不得发 execute', async () => {
    const fetchSpy = makeFetch({
      '/api/android/runtime-cache/scan': { body: SCAN_BODY },
      '/api/android/runtime-cache/execute': { body: EXECUTE_BODY },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()

    const clean = [...el.querySelectorAll('button')].find((b) => b.textContent === '清理')!
    await act(async () => { clean.click() })
    expect(fetchSpy.calls.filter((call) => call.url.endsWith('/execute'))).toHaveLength(0)

    const dialog = el.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('3.0 MB')
    expect(dialog.textContent).toContain('$DSH_HOME/cache/pip')

    const confirm = [...dialog.querySelectorAll('button')].find((b) => b.textContent === '清理')!
    await act(async () => { confirm.click() })
    const executions = fetchSpy.calls.filter((call) => call.url.endsWith('/execute'))
    expect(executions).toEqual([
      { url: '/api/android/runtime-cache/execute', method: 'POST', credentials: 'same-origin' },
    ])
  })

  it('取消确认后不发 execute（破坏性动作必须走明确确认）', async () => {
    const fetchSpy = makeFetch({
      '/api/android/runtime-cache/scan': { body: SCAN_BODY },
      '/api/android/runtime-cache/execute': { body: EXECUTE_BODY },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === '清理')!.click() })
    const cancel = [...el.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '取消')!
    await act(async () => { cancel.click() })
    expect(fetchSpy.calls.some((call) => call.url.endsWith('/execute'))).toBe(false)
  })

  it('执行后按项展示结果：失败项如实列出，不粉饰成「已清干净」', async () => {
    const fetchSpy = makeFetch({
      '/api/android/runtime-cache/scan': { body: SCAN_BODY },
      '/api/android/runtime-cache/execute': { body: EXECUTE_BODY },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === '清理')!.click() })
    await act(async () => {
      [...el.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '清理')!.click()
    })
    expect(el.textContent).toContain('已清理 1 项')
    expect(el.textContent).toContain('1 项失败')
    // P3-1/P3-6：OS 错误串不上屏——正文给人话，明细只进 data-detail（可截图给维护方）。
    expect(el.textContent).toContain('删除失败（文件被占用、只读或权限不足）')
    expect(el.textContent, 'OS 错误串不得出现在正文').not.toContain('EBUSY')
    const failed = el.querySelector('[data-detail="EBUSY: injected"]')
    expect(failed, '明细必须可诊断').not.toBeNull()
    expect(failed?.getAttribute('data-reason')).toBe('remove-failed')
    expect(el.textContent).toContain('$DSH_FILES_DIR/engine.log.1 — 已删除 1.0 MB')
  })

  it('跳过项如实展示（未识别路径不得静默）', async () => {
    const fetchSpy = makeFetch({ '/api/android/runtime-cache/scan': { body: SCAN_BODY } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(el.textContent).toContain('跳过 2 项')
    expect(el.textContent).toContain('未列入白名单（本版不清理）')
    expect(el.textContent).toContain('当前引擎日志不在场（引擎未启动）')
  })

  it('无鉴权（401/403）时如实报错且不显示可清理体积', async () => {
    const fetchSpy = makeFetch({ '/api/android/runtime-cache/scan': { status: 403 } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    // P3-1/P3-6：状态码不上屏——正文给人话，码只进 data-http（可 grep、可截图给维护方）。
    expect(el.textContent).toContain('未获授权')
    expect(el.textContent, '状态码不得出现在正文').not.toContain('403')
    expect(el.querySelector('[data-http="403"]'), '状态码必须可诊断').not.toBeNull()
    const clean = [...el.querySelectorAll('button')].find((b) => b.textContent === '清理') as HTMLButtonElement
    expect(clean.disabled, '无可回收体积时「清理」必须禁用').toBe(true)
  })

  it('宿主未装配（fetch 抛错）时如实说「读不到」，不抛异常也不冒充 0 B', async () => {
    // S3-16：旧断言要求显示「可回收：0 B」——那是把「读不到」画成合法空态，属「把缺陷当契约」。
    // 现在：不报错、界面照常渲染，但头部必须说读不到，清理入口禁用。
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const el = await render()
    expect(el.textContent).toContain('读不到')
    expect(el.textContent, '不得冒充真值 0').not.toContain('可回收：0 B')
    const clean = [...el.querySelectorAll('button')].find((b) => b.textContent === '清理') as HTMLButtonElement
    expect(clean.disabled).toBe(true)
  })

  it('可回收体积为 0 时禁用「清理」按钮（不给无意义破坏性入口）', async () => {
    const fetchSpy = makeFetch({
      '/api/android/runtime-cache/scan': { body: { ok: true, reclaimableBytes: 0, targets: [], skipped: [] } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(([...el.querySelectorAll('button')].find((b) => b.textContent === '清理') as HTMLButtonElement).disabled).toBe(true)
  })

  it('重新扫描按用户请求重发（体积刷新不靠重挂载）', async () => {
    const fetchSpy = makeFetch({ '/api/android/runtime-cache/scan': { body: SCAN_BODY } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    await act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === '重新扫描')!.click() })
    expect(fetchSpy.calls.filter((call) => call.method === 'GET')).toHaveLength(2)
  })
})

// ── 0.14.1 批 9（§3.3 S3-16）：「读不到」不得画成「0 B」 ─────────────────────
describe('RuntimeCacheRow 读不到 vs 真值 0（S3-16）', () => {
  it('扫描失败时头部必须说「读不到」，且清理按钮禁用', async () => {
    const fetchSpy = makeFetch({ '/api/android/runtime-cache/scan': { status: 500 } })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    // 旧实现：`reclaimable` 回落成 0 ⇒ 「可回收：0 B（0 项）」，看起来像「确实没东西可清」。
    expect(el.textContent).toContain('读不到')
    expect(el.textContent, '不得把读不到画成 0 B').not.toContain('可回收：0 B')
    expect(el.querySelector('[data-scan-state]')?.getAttribute('data-scan-state')).toBe('failed')
    const clean = [...el.querySelectorAll('button')].find((b) => b.textContent === '清理') as HTMLButtonElement
    expect(clean.disabled, '读不到时不得允许清理').toBe(true)
    // 设备实测补正：读不到时不得继续展示上一次的清单（陈旧数据看起来像现值）。
    expect(el.querySelector('.dsh-dev-cache-list'), '读不到时不得展示缓存清单').toBeNull()
  })

  it('读不到之后再读成功：清单必须回来（证明上面的隐藏不是永久隐藏）', async () => {
    let fail = true
    const impl = vi.fn(async () => {
      if (fail) throw new Error('offline')
      return { ok: true, status: 200, json: async () => SCAN_BODY }
    })
    vi.stubGlobal('fetch', impl)
    const el = await render()
    await act(async () => { await Promise.resolve() })
    expect(el.textContent).toContain('读不到')
    expect(el.querySelector('.dsh-dev-cache-list')).toBeNull()
    fail = false
    const rescan = [...el.querySelectorAll('button')].find((b) => b.textContent === '重新扫描') as HTMLButtonElement
    await act(async () => { rescan.click() })
    await act(async () => { await Promise.resolve() })
    expect(el.textContent).toContain('运行时缓存可回收：3.0 MB')
    expect(el.querySelector('.dsh-dev-cache-list')).not.toBeNull()
  })

  it('宿主不可用（fetch 抛错）时同样说「读不到」，不退化成 0 B', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const el = await render()
    expect(el.textContent).toContain('读不到')
    expect(el.textContent).not.toContain('可回收：0 B')
  })

  it('扫描成功但没有可清理项时，才是「暂无可清理项」这个合法空态', async () => {
    const fetchSpy = makeFetch({
      '/api/android/runtime-cache/scan': { body: { ok: true, reclaimableBytes: 0, targets: [], skipped: [] } },
    })
    vi.stubGlobal('fetch', fetchSpy.impl)
    const el = await render()
    expect(el.textContent).toContain('暂无可清理项')
    expect(el.textContent).not.toContain('读不到')
    expect(el.querySelector('[data-scan-state]')?.getAttribute('data-scan-state')).toBe('ok')
  })
})
