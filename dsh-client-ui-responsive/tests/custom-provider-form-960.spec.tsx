// custom-provider-form-960.spec.tsx — issue #960 的两条 UI 判据，打在**真实 DOM 测量**上。
//
// 为什么不用源码文本断言：本 issue 的三条缺陷都是「DOM 看着对了、逻辑没生效」。
// 源码里有没有某个字符串，与用户看到的行数、标签是否撞名，是两件事。这里一律读渲染结果。
//
//   B：「初态模型输入框数量」与「提示语」必须一致——提示说「至少需要一个模型」时，
//      必须真的有一行可以填；一行都没有时不许出现这条提示。
//      （issue 给的是二选一，本仓选「初态就渲染第一行」，因为只藏提示会把「填了却不生效」留在原地。）
//   C：同屏每个模型目录区的 aria-label 必须互不相同；隐藏面板不得留在无障碍树里。
//
// 每条判据都配负控：把实现改回缺陷形态，同一条判据必须真的变红。负控不红的判据没有鉴别力。
//
// 被测对象是**上游原始字节**（补丁夹具，与快照引擎树逐字节同源）施加本仓补丁后的产物。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as store from '@deepseek-ai/dsh-client-store'
import { patchCustomFirstModelRow } from '../../scripts/patches/data/custom-first-model-row-960.mjs'
import { patchModelCatalogSectionLabels } from '../../scripts/patches/data/model-catalog-section-labels-960.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const BASELINE = JSON.parse(readFileSync(join(REPO, 'scripts', 'contract.json'), 'utf8')).baseline
const UPSTREAM = join(REPO, 'scripts', 'patches', 'tests', 'fixtures',
  'dsh-client-ui-settings-models-' + BASELINE, 'lib', 'client.js')

/** 上游原始字节；夹具缺席时整组跳过。 */
const upstream = existsSync(UPSTREAM) ? readFileSync(UPSTREAM, 'utf8') : null

/** 把 IIFE bundle 装进假模块加载器，取出它的导出。 */
function loadBundle(source: string): any {
  let captured: any
  const g = globalThis as any
  g.window = g.window ?? globalThis
  g.window.__ModuleLoader__ = { load: (mod: any) => { captured = mod } }
  const jsx = require('react/jsx-runtime')
  const req = (id: string) => {
    if (id === 'react') return React
    if (id === 'react/jsx-runtime') return jsx
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    if (id === '@deepseek-ai/dsh-client-store') return store
    try { return require(id) } catch { return new Proxy({}, { get: () => () => null }) }
  }
  const doc = { head: { appendChild() {} }, createElement: () => ({ dataset: {}, appendChild() {} }), querySelector: () => null }
  new Function('window', 'require', 'document', source)(g.window, req, doc)
  return captured.factory(req)
}

/** 设置 schema 替身：只回答卡片真正问的那几件事。 */
const schema = {
  getPath: () => undefined,
  setPath: (value: any) => value,
  hasPath: () => false,
  rehydrate: (value: any) => value,
  nodeAtPath: (_root: any, path: string[]) => {
    if (path.includes('api')) return { type: 'union', list: [{ value: 'openai-completions' }] }
    if (path.includes('reasoningEfforts')) return undefined
    if (path.includes('models')) return { type: 'array', meta: { default: [] } }
    return { type: 'object', dict: {} }
  },
}

/** 按原生 setter 写值再派发 input，React 的受控输入才会真的更新。 */
function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

interface Section {
  label: string
  inAccessibilityTree: boolean
}

interface Measured {
  modelInputs: number
  hints: string[]
  sections: Section[]
  inputLabels: string[]
}

/**
 * 渲染「设置 → 模型 → 添加提供商 → 自定义模型 API」，把 issue 里的判据量出来。
 *
 * 目录型 provider 与自定义卡片同属 llm-pi-ai，与 issue 里的形状一致：切换页签时
 * 目录面板只是 hidden，节点仍挂在 DOM 里——三个同名 section 就是这么来的。
 * @param source 待测的 settings-models bundle
 * @param fillIdentity 是否填好 Provider ID 与 API 地址（填好后剩下的唯一缺陷就是「没有模型行」）
 */
async function measure(source: string, fillIdentity: boolean): Promise<Measured> {
  const bundle = loadBundle(source)
  let section: any
  const ctx: any = {
    effect: (fn: any) => { const dispose = fn(); return () => (typeof dispose === 'function' ? dispose() : undefined) },
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    remote: { $on: () => () => {}, llm: {}, credentials: {}, settings: {}, session: {} },
    on: () => () => {},
    get: () => undefined,
    settingsSchema: {},
    configForms: { describe: () => ({}), get: () => ({}) },
    slots: {
      inject: (_name: string, fn: any) => fn(),
      register: (declaration: any, component: any) => { if (declaration.id === 'models') section = component; return () => {} },
    },
  }
  bundle.apply(ctx)

  const namespaces = new Map<string, any>()
  namespaces.set('llm-deepseek', { ns: 'llm-deepseek', schema: {}, value: {}, user: {}, base: {}, revision: 1 })
  namespaces.set('llm-pi-ai', { ns: 'llm-pi-ai', schema: {}, value: {}, user: {}, base: {}, revision: 1 })
  const rows = [
    { entry: { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: ['providers', 'deepseek-official'], active: true, declared: true }, configured: false, removable: false, credential: void 0 },
    { entry: { provider: 'amazon-bedrock', displayName: 'Amazon Bedrock', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'amazon-bedrock'], active: false, declared: false }, configured: false, removable: false, credential: void 0 },
  ]
  const snapshot = { status: 'ready', error: null, rows, namespaces, writable: true, credentialError: null }
  const storeFace = { getSnapshot: () => snapshot, subscribe: () => () => {}, update: () => {} }
  const props = {
    controller: { store: storeFace, load: () => {} },
    useSnapshot: (select: any) => select(snapshot),
    operations: {},
    schema,
    t: (key: string) => key,
    renderSlot: () => null,
  }

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await React.act(async () => { root.render(React.createElement(section, props)) })
  const addButton = [...host.querySelectorAll('button')].find((button) => /addButton/.test(button.className)) as HTMLButtonElement
  await React.act(async () => { addButton.click() })
  const customTab = [...host.querySelectorAll('[role="tab"],button')].find((element) => /custom/i.test(element.textContent ?? '')) as HTMLElement | undefined
  if (customTab) await React.act(async () => { customTab.click() })
  if (fillIdentity) {
    // 必须挑**可见**的那个：隐藏的目录面板里有同名 baseUrl 输入框，按 label 直接取第一个
    // 会落进零高节点——这正是 issue #960 第三条在描述的事，测试自己不能踩。
    const visible = [...host.querySelectorAll('input')].filter((input) => input.closest('[hidden]') === null)
    const route = visible.find((input) => input.getAttribute('aria-label') === 'customRoute') as HTMLInputElement | undefined
    const base = visible.find((input) => input.getAttribute('aria-label') === 'baseUrl') as HTMLInputElement | undefined
    await React.act(async () => { if (route) type(route, 'd1api') })
    await React.act(async () => { if (base) type(base, 'https://d1api.xin/v1') })
  }
  const inputs = [...host.querySelectorAll('input')]
  const measured: Measured = {
    modelInputs: inputs.filter((input) => /modelId/.test(input.getAttribute('aria-label') ?? '')).length,
    hints: [...host.querySelectorAll('p')].map((p) => p.textContent ?? '')
      .filter((text) => /customNeedsModels|customNeedsBaseUrl|modelIdRequired/.test(text)),
    sections: [...host.querySelectorAll('section')].map((node) => ({
      label: node.getAttribute('aria-label') ?? '',
      // 无障碍树里的判定：hidden 属性、aria-hidden 祖先，任一都算被移出。
      inAccessibilityTree: node.closest('[hidden]') === null && node.closest('[aria-hidden="true"]') === null,
    })),
    inputLabels: inputs.map((input) => input.getAttribute('aria-label') ?? ''),
  }
  await React.act(async () => { root.unmount() })
  host.remove()
  return measured
}

/** 判据 B：提示语与可填行数必须一致。 */
function hintMatchesRows(measured: Measured): boolean {
  const claimsNoModels = measured.hints.includes('customNeedsModels')
  return claimsNoModels === (measured.modelInputs === 0)
}

/**
 * 判据 C：同屏渲染出的每个目录区 label 互不相同，且都不为空。
 *
 * 数的是**全部**已渲染 section，不是只数可见的：issue 里就是
 * `document.querySelectorAll('section[aria-label="模型目录"]')` 一次命中三个。
 * 隐藏面板留在 DOM 里正是缺陷的一半，把它滤掉会让判据自己失效。
 */
function labelsAreUnique(measured: Measured): boolean {
  const labels = measured.sections.map((section) => section.label)
  return labels.length > 0 && labels.every((label) => label.length > 0) && new Set(labels).size === labels.length
}

describe.skipIf(upstream === null)('issue #960 自定义 provider 表单', () => {
  const patched = (): string => patchModelCatalogSectionLabels(patchCustomFirstModelRow(upstream as string))

  it('B: 初态就有可填的模型行，提示语与行数一致', async () => {
    const broken = await measure(upstream as string, true)
    // 缺陷形态：提示说「至少需要一个模型」，却一行都填不了。
    expect(broken.modelInputs).toBe(0)
    expect(broken.hints).toContain('customNeedsModels')
    expect(hintMatchesRows(broken)).toBe(true)

    const fixed = await measure(patched(), true)
    expect(fixed.modelInputs).toBeGreaterThanOrEqual(1)
    expect(hintMatchesRows(fixed)).toBe(true)
  })

  it('B 负控：把初值退回空数组，同一条判据立刻变红', async () => {
    const negative = patched().replace('useState)([{ id: "" }])', 'useState)([])')
    expect(negative).not.toBe(patched())
    const measured = await measure(negative, true)
    // 负控必须把缺陷原样复现：零行 + 提示在。
    expect(measured.modelInputs).toBe(0)
    expect(measured.hints).toContain('customNeedsModels')
  })

  it('C: 无障碍树里每个目录区的 label 互不相同', async () => {
    const broken = await measure(upstream as string, true)
    // 缺陷形态：同屏两个同名目录区（issue 里是三个），且隐藏面板留在无障碍树里。
    const brokenLabels = broken.sections.map((section) => section.label)
    expect(new Set(brokenLabels).size).toBeLessThan(brokenLabels.length)
    expect(labelsAreUnique(broken)).toBe(false)

    const fixed = await measure(patched(), true)
    expect(labelsAreUnique(fixed)).toBe(true)
    // 隐藏面板必须已经移出无障碍树。
    expect(fixed.sections.some((section) => !section.inAccessibilityTree)).toBe(true)
  })

  it('C 负控：把 label 退回共用词条，唯一性判据立刻变红', async () => {
    const negative = patched().replace(
      '"aria-label": t("models") + " · " + (probe.provider === void 0 ? t("customTag") : probe.provider),',
      '"aria-label": t("models"),',
    )
    expect(negative).not.toBe(patched())
    expect(labelsAreUnique(await measure(negative, true))).toBe(false)
  })
})
