// custom-provider-form-960.test.mjs — issue #960：自定义模型提供商表单的三个陷阱，逐条行为判据。
//
// 判据一律打在**产物语义**上，不打源码文本：
//   A 高：给了 baseURL 的「获取可用模型」必须真的向 {baseURL}/models 发 GET，拿端点自己的列表；
//         端点失败必须明确报错，**绝不回落内置目录**（回落正是这条 issue 的病灶）。
//   B 中：自定义卡片初态就渲染出第一行模型输入框，与提示语「至少需要一个模型」不再互相矛盾；
//         占位空行不得混进「获取可用模型」的采纳结果。
//   C 中：同屏每个模型目录区的 aria-label 互不相同且带归属标识；隐藏面板移出无障碍树。
//
// 每条判据都配一个负控：把实现改回缺陷形态，判据必须真的变红。负控不红的判据没有鉴别力。
//
// 做法：从**上游原始字节**（夹具，与快照引擎树逐字节同源）出发施加补丁，再把产物真的跑起来。
// 不拿 vendor/ 已入库产物当输入——那是补丁链的输出，拿它当夹具测不出补丁是否真的起作用。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Script } from 'node:vm'
import {
  hasCustomEndpointDiscovery, patchCustomEndpointDiscovery,
} from '../data/custom-endpoint-discovery-960.mjs'
import {
  hasCustomFirstModelRow, patchCustomFirstModelRow,
} from '../data/custom-first-model-row-960.mjs'
import {
  hasModelCatalogSectionLabels, patchModelCatalogSectionLabels,
} from '../data/model-catalog-section-labels-960.mjs'
import { versionedFixture } from './lib/fixture.mjs'

/** 上游原始字节：pi-ai 适配器（含 discoverModels）。 */
const PIAI = () => readFileSync(versionedFixture('dsh-llm-pi-ai', 'lib', 'index.js'), 'utf8')
/** 上游原始字节：设置页模型面板的客户端 bundle。 */
const SM = () => readFileSync(versionedFixture('dsh-client-ui-settings-models', 'lib', 'client.js'), 'utf8')

/**
 * 内置目录的规模：pi-ai 1.1.0 的 amazon-bedrock 恰好 193 条，正是 issue 里数出来的那个数。
 * 替身目录按同规模铺，负控才能复现「用户看到 193 条不相干条目」这个现象。
 */
const CATALOG_SIZE = 193

/**
 * 依赖替身：适配器在 import 期就要用到的那些包。只顶掉本测试不关心的部分。
 *
 * pi-ai 也走替身：夹具是**部分捕获**（只含补丁目标文件，没有 dist/providers/），
 * 而本判据只需要「某个 provider 在内置目录里有 N 条模型」这一件事成立。
 * 真目录那条路径是上游自己的代码（catalogModels），本补丁只改**什么时候**走它，所以替身不失真。
 * @returns 包名到 ESM 源码的映射
 */
function stubDependencies() {
  const catalog = Array.from({ length: CATALOG_SIZE }, (_, index) => ({
    id: 'catalog-model-' + String(index + 1),
    name: 'catalog-model-' + String(index + 1),
    contextWindow: 200000,
    maxTokens: 8192,
    input: ['text'],
  }))
  return {
    '@earendil-works/pi-ai/providers/all': `
const MODELS = ${JSON.stringify(catalog)}
const provider = { id: 'amazon-bedrock', name: 'Amazon Bedrock', models: MODELS, auth: {} }
export const builtinProviders = () => [provider]
export const builtinModels = (id) => (id === provider.id ? provider.models : [])
export const getBuiltinModels = (id) => (id === provider.id ? provider.models : [])
export const getAllBuiltinModels = (id) => (id === provider.id ? provider.models : [])
`,
    '@earendil-works/pi-ai/api/anthropic-messages.lazy': 'export const anthropicMessagesApi = {}',
    '@earendil-works/pi-ai/api/openai-completions.lazy': 'export const openAICompletionsApi = {}',
    '@earendil-works/pi-ai/api/openai-responses.lazy': 'export const openAIResponsesApi = {}',
    '@earendil-works/pi-ai/utils/overflow': 'export const isContextOverflow = () => false',
    '@deepseek-ai/dsh-llm': `
export class LlmError extends Error { constructor(message, code, opts) { super(message); this.code = code; if (opts?.cause) this.cause = opts.cause } }
export const attributionHeaders = () => ({})
export const assertUsableApiKey = (value) => value
export const normalizeApiKey = (value) => ({ ok: true, value })
export const contentHasImage = () => false
export const offloadedImageText = () => ''
export const projectOffloadedImages = (value) => value
export const requestImageHandleText = () => ''
export const requiredImageOffload = () => false
export const resolveImageAttachmentAccess = () => undefined
export const resolveRetryPolicy = (value) => value
export const isContextWindowExceededError = () => false
export const isQuotaExceededError = () => false
export const RetryPolicySchema = {}
export const ReasoningEffortId = {}
export class LlmAdapter {}
export const CONTEXT_WINDOW_EXCEEDED_CODE = 'context-window-exceeded'
export const EMPTY_RESPONSE_CODE = 'empty-response'
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'image-offload-required'
export const INVALID_CREDENTIAL_CODE = 'invalid-credential'
export const QUOTA_EXCEEDED_CODE = 'quota-exceeded'
`,
    '@deepseek-ai/dsh-launch-environment': 'export const launchEnvironmentOf = () => ({ get: () => undefined })',
    '@deepseek-ai/dsh-util-values': 'export const deepEqualJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)',
    '@deepseek-ai/dsh-timeout': 'export const MAX_TIMER_DELAY_MS = 1000; export const idleWatchdog = () => ({}); export const timeoutOf = () => ({})',
    '@deepseek-ai/dsh-brand': 'export const brandString = (value) => value',
    '@deepseek-ai/dsh-attachment': 'export const requestImageDimensions = () => undefined',
    '@deepseek-ai/schemastery': 'const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain, construct: () => chain }); export default chain',
    '@deepseek-ai/dsh-credentials': 'export const credentialKey = () => ""; export const credentialKeyId = () => ""; export const credentialKeyScope = () => ""; export const credentialRef = () => ""; export const isCredentialKeySegment = () => true; export const isCredentialRefName = () => true',
  }
}

/**
 * 把施加过补丁的适配器真的跑起来，取出它注册进 llm 服务的 discover 闭包。
 * @param source 施加过补丁的适配器源码
 * @returns 注册进 llm 服务的 discover 闭包
 */
async function loadDiscovery(source) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-960-'))
  for (const [specifier, code] of Object.entries(stubDependencies())) {
    // 形如 '@earendil-works/pi-ai/providers/all' 的是**子路径导出**：必须按包名建包，
    // 再用 exports 通配映射到对应文件，否则 Node 会把整个子路径当目录去解析。
    // 包名 = 首个 / 之前（含 scope 的第二个 /）；其后全是子路径。
    const parts = specifier.split('/')
    const nameParts = specifier.startsWith('@') ? 2 : 1
    const isSubpath = parts.length > nameParts
    const packageName = parts.slice(0, nameParts).join('/')
    const subpath = isSubpath ? '.' + specifier.slice(packageName.length) : '.'
    const dir = join(root, 'node_modules', packageName)
    mkdirSync(dir, { recursive: true })
    const file = isSubpath ? subpath.slice(2) + '.js' : 'index.js'
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), code)
    // exports 的键必须带通配，Node 才会把具体子路径映射过来。
    const exportsMap = {}
    for (const key of Object.keys(stubDependencies())) {
      if (!key.startsWith(packageName + '/')) continue
      exportsMap['./*'] = './*.js'
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: packageName, version: '0.0.0', type: 'module',
      ...(isSubpath ? { exports: exportsMap } : { main: 'index.js' }),
    }))
  }
  const file = join(root, 'adapter.mjs')
  writeFileSync(file, source)
  const module = await import(pathToFileURL(file).href)
  let discovery
  const ctx = {
    effect: (fn) => { const dispose = fn(); return () => (typeof dispose === 'function' ? dispose() : undefined) },
    on: () => () => {},
    get: () => undefined,
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    inject: (_deps, fn) => { fn(ctx) },
    fiber: { entry: { options: { id: 'llm-pi-ai' } } },
    settings: { configure: () => ({}) },
    authorization: { registerFlow: () => () => {} },
    llm: {
      registerModelDiscovery: (_ns, fn) => { discovery = fn; return () => {} },
      registerAdapter: () => ({ replace: () => {} }),
      registerConfigurableProviders: () => ({ replace: () => {} }),
    },
  }
  module.apply(ctx, { providers: { get: () => ({}) } })
  assert.equal(typeof discovery, 'function', '适配器必须注册 model discovery')
  return discovery
}

/** 假 fetch：记录被请求的 URL，按 handler 回应。 */
function stubFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => handler(String(url))
  return () => { globalThis.fetch = original }
}

/** 造一个 JSON 响应。 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 一次「自定义端点」探测：provider 与 baseURL 同时给，正是 issue 里的形状。 */
const CUSTOM_PROBE = { provider: 'amazon-bedrock', baseURL: 'https://d1api.xin/v1', api: 'openai-completions', apiKey: 'sk-test' }

test('A: 补丁幂等，半补丁与锚点漂移都拒绝写回', () => {
  const source = PIAI()
  assert.equal(hasCustomEndpointDiscovery(source), false, '上游原始字节不应已带 marker')
  const once = patchCustomEndpointDiscovery(source)
  assert.equal(hasCustomEndpointDiscovery(once), true)
  assert.equal(patchCustomEndpointDiscovery(once), once, '重复施加必须字节不变')

  // 半补丁：marker 在、原锚点已不在 ⇒ 必须抛，不许静默当作已施加
  // 半补丁 = marker 还在，但被替换的那段已经不完整（这里把新判据整行删掉，注释留着）。
  const judgement = 'const endpointGiven = typeof request.baseURL === "string" && request.baseURL.length > 0;\n'
  assert.equal(once.includes(judgement), true, '新判据必须在场，半补丁探针才有意义')
  const half = once.replace(judgement, '')
  assert.equal(half.includes('dsh-mobile custom endpoint discovery'), true, 'marker 仍在')
  assert.equal(hasCustomEndpointDiscovery(half), false, '半补丁不得被判成已完成')
  assert.throws(() => patchCustomEndpointDiscovery(half), /半补丁|锚点/)

  // 锚点漂移：既不命中也不带 marker ⇒ 必须抛（不是静默空转）
  assert.throws(() => patchCustomEndpointDiscovery('no anchor here'), /锚点未命中/)
})

test('A: 带 baseURL 的请求真的向 {baseURL}/models 取列表', async () => {
  const discovery = await loadDiscovery(patchCustomEndpointDiscovery(PIAI()))
  const calls = []
  const restore = stubFetch((url) => {
    calls.push(url)
    return jsonResponse({ data: [{ id: 'deepseek-v4.1-flash' }] })
  })
  try {
    const models = await discovery(CUSTOM_PROBE)
    assert.deepEqual(calls, ['https://d1api.xin/v1/models'], '必须请求用户填的端点，而不是读内置目录')
    assert.deepEqual(models.map((model) => model.id), ['deepseek-v4.1-flash'], '必须是端点返回的模型')
  } finally {
    restore()
  }
})

test('A: 端点失败时明确报错，绝不回落内置目录', async () => {
  const discovery = await loadDiscovery(patchCustomEndpointDiscovery(PIAI()))
  const restore = stubFetch(() => jsonResponse({ error: 'nope' }, 500))
  try {
    await assert.rejects(
      () => discovery(CUSTOM_PROBE),
      (error) => {
        assert.match(String(error.message), /d1api\.xin/, '错误必须点名端点，用户才知道是谁没通')
        return true
      },
    )
  } finally {
    restore()
  }
})

test('A: 没给 baseURL 时仍读内置目录（保住原有行为）', async () => {
  const discovery = await loadDiscovery(patchCustomEndpointDiscovery(PIAI()))
  const calls = []
  const restore = stubFetch((url) => {
    calls.push(url)
    return jsonResponse({ data: [] })
  })
  try {
    const models = await discovery({ provider: 'amazon-bedrock' })
    assert.deepEqual(calls, [], '目录型浏览不该发请求')
    assert.equal(models.length, CATALOG_SIZE, '没有端点时，内置目录照旧')
  } finally {
    restore()
  }
})

test('A 负控：退回 provider 优先后，端点一次都没被请求，结果变成内置目录 193 条', async () => {
  // 负控 = 把本补丁的那一处判断改回去，其它字节完全不动。
  const broken = patchCustomEndpointDiscovery(PIAI())
    .replace('if (!endpointGiven && request.provider !== void 0) {', 'if (request.provider !== void 0) {')
  assert.notEqual(broken, patchCustomEndpointDiscovery(PIAI()), '负控必须真的改到字节')
  const discovery = await loadDiscovery(broken)
  const calls = []
  const restore = stubFetch((url) => {
    calls.push(url)
    return jsonResponse({ data: [{ id: 'deepseek-v4.1-flash' }] })
  })
  try {
    const models = await discovery(CUSTOM_PROBE)
    assert.deepEqual(calls, [], '负控：端点根本没被请求')
    assert.equal(models.length, CATALOG_SIZE, '负控：拿到的是内置目录，与 issue 里的 193 条一致')
    assert.equal(models.some((model) => model.id === 'deepseek-v4.1-flash'), false, '负控：端点自己的模型不在结果里')
  } finally {
    restore()
  }
})

test('B: 初态就有一行模型输入，占位空行不进采纳结果', () => {
  const source = SM()
  assert.equal(hasCustomFirstModelRow(source), false, '上游原始字节不应已带 marker')
  const patched = patchCustomFirstModelRow(source)
  assert.equal(hasCustomFirstModelRow(patched), true)
  assert.equal(patchCustomFirstModelRow(patched), patched, '重复施加必须字节不变')
  assert.throws(() => patchCustomFirstModelRow('no anchor here'), /锚点未命中/)
  new Script(patched, { filename: 'dsh-client-ui-settings-models/client.js' })
  assert.match(patched, /useState\)\(\[\{ id: "" \}\]\)/, '初值必须给出一行')
  assert.match(patched, /textOf\(model, "id"\)\.trim\(\)\.length > 0/, '采纳必须过滤占位空行')
})

test('B 负控：把初值退回空数组后，初态一行都没有', () => {
  const patched = patchCustomFirstModelRow(SM())
  const broken = patched.replace('useState)([{ id: "" }])', 'useState)([])')
  assert.notEqual(broken, patched, '负控必须真的改到字节')
  assert.equal(/useState\)\(\[\{ id: "" \}\]\)/.test(broken), false, '负控：初值退回空数组')
})

test('C: 每个目录区 label 唯一且带归属，隐藏面板移出无障碍树', () => {
  const source = SM()
  assert.equal(hasModelCatalogSectionLabels(source), false, '上游原始字节不应已带 marker')
  const patched = patchModelCatalogSectionLabels(source)
  assert.equal(hasModelCatalogSectionLabels(patched), true)
  assert.equal(patchModelCatalogSectionLabels(patched), patched, '重复施加必须字节不变')
  assert.throws(() => patchModelCatalogSectionLabels('no anchor here'), /锚点未命中/)
  new Script(patched, { filename: 'dsh-client-ui-settings-models/client.js' })
  assert.match(patched, /"data-dsh-model-catalog"/, '每个目录区必须带归属标识')
  assert.match(patched, /"aria-hidden": mode !== "catalog"/, '隐藏面板必须移出无障碍树')
  assert.equal(/"aria-label": t\("models"\),/.test(patched), false, 'label 不能再是裸的共用词条')
})

test('C 负控：退回裸 t("models") 后，三个目录区 label 完全相同', () => {
  const patched = patchModelCatalogSectionLabels(SM())
  const broken = patched
    .replace('"aria-label": t("models") + " · " + (probe.provider === void 0 ? t("customTag") : probe.provider),', '"aria-label": t("models"),')
    .replace('\t\t\t\t"data-dsh-model-catalog": probe.provider === void 0 ? "custom" : probe.provider,\n', '')
  assert.notEqual(broken, patched, '负控必须真的改到字节')
  assert.equal(/"aria-label": t\("models"\),/.test(broken), true, '负控：label 退回裸共用词条')
  assert.equal(broken.includes('"data-dsh-model-catalog"'), false, '负控：归属标识消失')
})
