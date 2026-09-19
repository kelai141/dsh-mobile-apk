// issue #232 反证回归：浏览器回执必须与壳侧事实同向（loadState=error 不得渲染成「已打开」）。
//
// 依据 docs/0.14.1-preview-ISSUE232-BROWSER-RECEIPT.md §3.1 F1-F5 / §4.2 G2a / §6.3 验收 1-3。
//
// 判据设计（§4.2 明令禁「grep 文本在场」）：
//   - 本文件**不读源码文本、不做字符串在场断言**，而是用夹具驱动真实 `execute()` 拿到 value，
//     再调用真实 `render(args, value)`，比较**两条路径的渲染文本**是否可区分。
//   - 反证必真：error 夹具是壳侧 BrowserHost.kt:623-632 的真实形态（loadState="error"、
//     reason="load-error:<code>"、url 仍是失败的 URL、title 是错误页标题）。因此「成功与失败
//     渲染成同一句话」这条缺陷在本文件里必然被判红——一个不会失败的测试不算防线。
//   - 另有两条**通用可执行判据**（凡 schema 声明 loadState / tabs 的工具都要满足），
//     目的是让「某个工具又漏了渲染」自动变红，而不是靠有人记得手写一条断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { BROWSER_OPS, BROWSER_TOOLS } from '../lib/contract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)
const EXEC = { agent: { session: 'browser-receipt-test' } }

const FAIL_URL = 'http://neverssl.com/'
const OK_URL = 'https://example.com/'

/** 壳侧失败态真实形态（BrowserHost.kt:627 url=失败URL / :628 loadState=error / :629 lastError）。 */
const FAILED_STATE = {
  url: FAIL_URL,
  title: 'net::ERR_CLEARTEXT_NOT_PERMITTED',
  loadState: 'error',
  reason: 'load-error:-1',
  pageGeneration: 3,
  tabId: 'tab-3',
}

/** 壳侧成功态真实形态（status() 的 url/title/loadState/reason 四项）。 */
const LOADED_STATE = {
  url: OK_URL,
  title: 'Example Domain',
  loadState: 'loaded',
  reason: '',
  pageGeneration: 4,
  tabId: 'tab-4',
}

/** 多页夹具：一页成功、一页失败、失败页是活动页（壳侧 tabSummaries() 的五字段形态）。 */
const TABS = [
  { tabId: 'tab-1', url: 'https://example.com/a', title: 'Page A', loadState: 'loaded', active: false },
  { tabId: 'tab-2', url: 'http://192.0.2.1/', title: '错误页', loadState: 'error', active: true, reason: 'load-error:-2' },
]

/** 夹具控制面：按 op 返回桩数据，并记录调用（证明 execute 真的跑了，不是空转）。 */
function makeFace(datas) {
  const calls = []
  const face = {
    gateFor: () => ({ ok: true, via: 'a11y' }),
    audit: () => {},
    controlExec: async (op, args) => {
      calls.push({ op, args })
      if (Object.hasOwn(datas, op)) return { ok: true, data: datas[op] }
      return { ok: true, data: {} }
    },
  }
  return { face, calls }
}

/** 装载插件并取出工具（真跑 apply()，不做静态提取）。 */
function applyBrowser(face) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: (name) => (name === 'androidPrivilege' ? face : undefined),
    effect: (fn) => { try { return fn?.() } catch { return undefined } },
    on: () => {},
  })
  return { tools, byName: (n) => tools.find((t) => t.name === n) }
}

/** 用一套 op 桩驱动某个工具，返回 { tool, value, calls }。 */
async function drive(toolName, args, datas) {
  const { face, calls } = makeFace(datas)
  const { byName } = applyBrowser(face)
  const tool = byName(toolName)
  assert.ok(tool, '工具必须注册：' + toolName)
  const value = await tool.execute(args, EXEC)
  assert.ok(calls.length > 0, toolName + ' 的 execute 必须真的调用壳侧控制面（夹具未被使用 = 空转）')
  return { tool, value, calls }
}

/**
 * 同 [drive]，但先在同一实例上跑一次 snapshot —— click/type/press 的前置是「必须先有 snapshot」
 * （ref 记忆是**实例级**的，而 drive() 每次重新 apply() 都会重置它）。
 */
async function driveWithSnapshotPrimer(toolName, args, datas) {
  const { face, calls } = makeFace({
    ...datas,
    [BROWSER_OPS.js]: {
      url: OK_URL, title: 'Example Domain', pageGeneration: 1,
      nodes: [{ ref: 'bx1', role: 'link', name: 'a' }],
    },
  })
  const { byName } = applyBrowser(face)
  const primer = byName(BROWSER_TOOLS.snapshot)
  if (primer !== undefined) await primer.execute({}, EXEC)
  const tool = byName(toolName)
  assert.ok(tool, '工具必须注册：' + toolName)
  const value = await tool.execute(args, EXEC)
  assert.ok(calls.length > 0, toolName + ' 的 execute 必须真的调用壳侧控制面（夹具未被使用 = 空转）')
  return { tool, value, calls }
}

/** 取渲染文本（工具层 render 是模型唯一能看到的内容）。 */
const renderedText = (tool, value) => tool.output.render({}, value).map((b) => b.text).join('\n')

/** 按参数 schema 造最小实参（只补 required）。两种方言都吃：源码属性级 required:true 与
 *  归一化后的顶层 required:['x']（defineTool 编译后是后者）。 */
function requiredArgs(tool, url) {
  // 方言归一：defineTool 编译后是 `{ type, properties, required }`，而个别工具仍是属性级
  // `required: true`。只读顶层会把「properties 下的 ref/text/key」全漏掉 ⇒ 参数永远补不齐、
  // 通用判据对这些工具**结构性跑不起来**（本轮实测：click/type 因缺 ref 直接抛 INVALID_ARGS）。
  const props = tool.parameters?.properties ?? tool.parameters ?? {}
  const requiredArray = Array.isArray(tool.parameters?.required) ? new Set(tool.parameters.required) : null
  const requiredKeys = new Set([
    ...Object.entries(props).filter(([, prop]) => prop?.required === true).map(([k]) => k),
    ...(requiredArray ?? []),
  ])
  const args = {}
  for (const key of requiredKeys) {
    const prop = props[key] ?? {}
    if (key === 'url') args[key] = url
    else if (key === 'tabId') args[key] = 'tab-2'
    else if (prop.type === 'string') args[key] = 'sample'
    else if (prop.type === 'number') args[key] = 1
    else if (prop.type === 'boolean') args[key] = true
  }
  return args
}

/** 所有 browser_* 工具的两态 op 桩（通用判据用）。 */
const stateStub = (state) => ({ [BROWSER_OPS.state]: state, [BROWSER_OPS.open]: { tabId: state.tabId, pageGeneration: state.pageGeneration } })

// ── 定点反证：issue #232 四处漏网 ─────────────────────────────────────────────

test('K-2 反证：back/forward/reload 三条同族假回执必须按真实 loadState 判定（此前恒报成功）', async () => {
  // 真因：这三条**schema 完全不声明 loadState** → 通用判据自动豁免 → 「调用成功即回执成功」。
  // 判据：schema 必须声明 loadState；error 态回执必须可区分且带 reason。
  const { face } = makeFace({})
  const { tools } = applyBrowser(face)
  const names = [BROWSER_TOOLS.back, BROWSER_TOOLS.forward, BROWSER_TOOLS.reload]
  let checked = 0
  for (const name of names) {
    const tool = tools.find((t) => t.name === name)
    assert.ok(tool !== undefined, name + ' 必须注册')
    assert.ok(tool.output?.schema?.properties?.loadState !== undefined,
      name + '：schema 必须声明 loadState——不声明即被通用判据自动豁免（这正是该族假回执的存活机制）')
    const failed = await drive(name, {}, stateStub(FAILED_STATE))
    const loaded = await drive(name, {}, stateStub(LOADED_STATE))
    const failText = renderedText(tool, failed.value)
    const okText = renderedText(tool, loaded.value)
    assert.notEqual(failText, okText, name + '：loaded 与 error 两态回执必须可区分：' + failText)
    assert.match(failText, /error/, name + '：error 态必须在回执里可见：' + failText)
    assert.match(failText, /load-error:-1/, name + '：error 态必须带壳侧 reason：' + failText)
    // 反假绿：成功态不得出现失败动词（修复前的恒报成功在这里会被反向抓到）
    assert.ok(!/失败/.test(okText), name + '：成功态不得出现失败动词：' + okText)
    checked += 1
  }
  assert.equal(checked, 3, '三条 op 必须全部覆盖，实际 ' + checked)
})

test('K-2 附带：schema 声明且值存在的 url/title 必须在 render 中可观察（G2a-4 判据实测出的两处）', async () => {
  // 这两处不是审计点名的，是新判据自己跑出来的同族缺陷：
  //   · browser_snapshot 声明 title 却从不渲染（模型看不到当前是哪一页）
  //   · browser_type 声明 url 却从不渲染（输入可能触发导航，模型看不到就无法判断要不要重 snapshot）
  const { face } = makeFace({})
  const { tools } = applyBrowser(face)
  const snap = tools.find((t) => t.name === BROWSER_TOOLS.snapshot)
  const snapDrive = await drive(BROWSER_TOOLS.snapshot, {}, {
    [BROWSER_OPS.js]: { url: OK_URL, title: 'Example Domain', pageGeneration: 1, nodes: [] },
    [BROWSER_OPS.state]: LOADED_STATE,
  })
  const snapText = renderedText(snap, snapDrive.value)
  if (typeof snapDrive.value.title === 'string' && snapDrive.value.title !== '') {
    assert.ok(snapText.includes(snapDrive.value.title), BROWSER_TOOLS.snapshot + '：已声明且存在的 title 必须可观察：' + snapText)
  }
  const type = tools.find((t) => t.name === BROWSER_TOOLS.type)
  assert.ok(type !== undefined, BROWSER_TOOLS.type + ' 必须注册')
  // browser_type 的前置是「必须先有 snapshot」（无 ref 记忆时直接返回 snapshot-required，不碰控制面）。
  // 注意：ref 记忆是**插件实例级**的，而 drive() 每次都会重新 apply()（内部 resetBrowserMemory），
  // 故 snapshot 与 type 必须在**同一个实例**上依次跑——否则前置恒不满足、execute 空转被判空转。
  {
    const datas = {
      [BROWSER_OPS.js]: { url: OK_URL, title: 'Example Domain', pageGeneration: 1, nodes: [{ ref: 'r1' }] },
      [BROWSER_OPS.input]: { url: OK_URL, value: 'x' },
      [BROWSER_OPS.state]: LOADED_STATE,
    }
    const { face: f2, calls: c2 } = makeFace(datas)
    const { byName: bn2 } = applyBrowser(f2)
    const snapTool = bn2(BROWSER_TOOLS.snapshot)
    await snapTool.execute({}, EXEC)
    const typeTool = bn2(BROWSER_TOOLS.type)
    const typeValue = await typeTool.execute({ ref: 'r1', text: 'x' }, EXEC)
    assert.ok(c2.length > 0, BROWSER_TOOLS.type + ' 的 execute 必须真的调用壳侧控制面（夹具未被使用 = 空转）')
    const typeText = renderedText(typeTool, typeValue)
    if (typeof typeValue.url === 'string' && typeValue.url !== '') {
      assert.ok(typeText.includes(typeValue.url), BROWSER_TOOLS.type + '：已声明且存在的 url 必须可观察：' + typeText)
    }
  }
})

test('P0-c 反证：browser_open 在 loadState=error 时回执不得声称「已打开」，必须带错误态与原因', async () => {
  const { tool, value } = await drive(BROWSER_TOOLS.open, { url: FAIL_URL }, {
    [BROWSER_OPS.open]: { tabId: 'tab-3', pageGeneration: 3 },
    [BROWSER_OPS.state]: FAILED_STATE,
  })
  assert.equal(value.ok, true, '壳侧 op 成功但页面加载失败：这正是回执必须自己分辨的那条路径')
  assert.equal(value.loadState, 'error', 'execute 必须如实取回 loadState')
  const text = renderedText(tool, value)
  assert.ok(!text.includes('已打开'), '失败路径不得出现「已打开」：' + text)
  assert.match(text, /error/, '失败路径必须带错误态：' + text)
  assert.match(text, /load-error:-1/, '失败路径必须带壳侧 reason：' + text)
})

test('P0-c 核心：同一 URL 的成功与失败回执文本必须可区分（当前实现逐字相同）', async () => {
  const failed = await drive(BROWSER_TOOLS.open, { url: FAIL_URL }, {
    [BROWSER_OPS.open]: { tabId: 'tab-3', pageGeneration: 3 },
    [BROWSER_OPS.state]: FAILED_STATE,
  })
  const loaded = await drive(BROWSER_TOOLS.open, { url: OK_URL }, {
    [BROWSER_OPS.open]: { tabId: 'tab-4', pageGeneration: 4 },
    [BROWSER_OPS.state]: LOADED_STATE,
  })
  const failText = renderedText(failed.tool, failed.value)
  const okText = renderedText(loaded.tool, loaded.value)
  assert.notEqual(failText, okText, '成功与失败被渲染成同一句话 = 回执与事实相反（issue #232 主缺陷）')
  assert.match(okText, /已打开/, '成功路径仍须明确说已打开：' + okText)
  assert.match(okText, /Example Domain/, '成功路径必须带 title（schema 已声明）: ' + okText)
})

test('P1 反证：browser_list_tabs 必须逐页渲染 tabId/url/title/loadState/活动页', async () => {
  const { tool, value } = await drive(BROWSER_TOOLS.listTabs, {}, { [BROWSER_OPS.tabs]: { tabs: TABS, activeTabId: 'tab-2' } })
  assert.equal(value.ok, true)
  const text = renderedText(tool, value)
  for (const needle of ['tab-1', 'tab-2', 'https://example.com/a', 'http://192.0.2.1/', 'Page A', '错误页']) {
    assert.ok(text.includes(needle), '逐页回执必须含 ' + needle + '：' + text)
  }
  assert.match(text, /error/, '失败页的 loadState 必须可见：' + text)
  assert.equal(text.split('活动页').length - 1, 1, '活动页标记必须出现且只出现一次：' + text)
})

test('P1 反证：browser_follow_tab 回执必须带目标页真实 url/title（不能只回 tabId）', async () => {
  const { tool, value } = await drive(BROWSER_TOOLS.followTab, { tabId: 'tab-2' }, {
    [BROWSER_OPS.followTab]: { activeTabId: 'tab-2', url: 'http://192.0.2.1/', tabs: TABS },
  })
  assert.equal(value.ok, true)
  const text = renderedText(tool, value)
  assert.ok(text.includes('http://192.0.2.1/'), '切换回执必须带目标页 url：' + text)
  assert.ok(text.includes('错误页'), '切换回执必须带目标页 title：' + text)
  assert.match(text, /error/, '目标页失败态必须可见：' + text)
})

test('P1 反证：browser_navigate 的 schema/execute/render 三处都必须带 loadState，error 时不得说「已导航」', async () => {
  const failed = await drive(BROWSER_TOOLS.navigate, { url: FAIL_URL }, stateStub(FAILED_STATE))
  const tool = failed.tool
  assert.ok(tool.output.schema.properties.loadState, 'schema 必须声明 loadState（否则 execute 回填会被整值校验拒收）')
  assert.equal(failed.value.loadState, 'error', 'execute 必须取回 loadState')
  const failText = renderedText(tool, failed.value)
  assert.ok(!failText.includes('已导航'), '失败路径不得出现「已导航」：' + failText)
  assert.match(failText, /load-error:-1/, '失败路径必须带壳侧 reason：' + failText)

  const loaded = await drive(BROWSER_TOOLS.navigate, { url: OK_URL }, stateStub(LOADED_STATE))
  const okText = renderedText(loaded.tool, loaded.value)
  assert.match(okText, /已导航/, '成功路径仍须明确说已导航：' + okText)
  assert.notEqual(failText, okText, '成功与失败必须可区分：' + failText + ' || ' + okText)
})

// ── 通用可执行判据（防「又有一处漏网」，不依赖有人记得手写断言）─────────────────

test('可执行判据：凡 output.schema 声明 loadState 的工具，render 必须在 loaded/error 两态可区分', async () => {
  const { face } = makeFace({})
  const { tools } = applyBrowser(face)
  const subject = tools.filter((t) => t.output?.schema?.properties?.loadState !== undefined)
  // 反假绿：声明了 loadState 的工具若归零（有人把字段删了），本判据会退化成空断言，必须判红。
  assert.ok(subject.length >= 2, '声明 loadState 的工具应至少 2 个（browser_open / browser_navigate），实际 ' + subject.length)

  for (const tool of subject) {
    const fail = await driveWithSnapshotPrimer(tool.name, requiredArgs(tool, FAIL_URL), stateStub(FAILED_STATE))
    const ok = await driveWithSnapshotPrimer(tool.name, requiredArgs(tool, OK_URL), stateStub(LOADED_STATE))
    const failText = renderedText(tool, fail.value)
    const okText = renderedText(tool, ok.value)
    assert.notEqual(failText, okText, tool.name + '：loaded 与 error 的 render 输出必须不同（语义判据，非文本在场）')
    assert.match(failText, /error/, tool.name + '：error 态必须在回执里可见')
    assert.match(failText, /load-error:-1/, tool.name + '：error 态必须带 reason')
  }
})

test('可执行判据：凡 output.schema 声明 tabs 的工具，render 必须把每页 url/title 说给模型', async () => {
  const { face } = makeFace({})
  const { tools } = applyBrowser(face)
  const subject = tools.filter((t) => t.output?.schema?.properties?.tabs !== undefined)
  assert.ok(subject.length >= 2, '声明 tabs 的工具应至少 2 个（browser_list_tabs / browser_follow_tab），实际 ' + subject.length)

  const datas = {
    [BROWSER_OPS.tabs]: { tabs: TABS, activeTabId: 'tab-2' },
    [BROWSER_OPS.followTab]: { activeTabId: 'tab-2', url: 'http://192.0.2.1/', tabs: TABS },
    [BROWSER_OPS.closeTab]: { closedTabId: 'tab-1', activeTabId: 'tab-2', tabs: TABS },
  }
  for (const tool of subject) {
    const { value } = await drive(tool.name, requiredArgs(tool, OK_URL), datas)
    const text = renderedText(tool, value)
    assert.ok(text.includes('https://example.com/a') && text.includes('Page A'), tool.name + '：第 1 页 url/title 必须可见：' + text)
    assert.ok(text.includes('http://192.0.2.1/') && text.includes('错误页'), tool.name + '：第 2 页 url/title 必须可见：' + text)
  }
})

// ── 引擎整值校验（F4 的关键：只加 render 读取、不加 schema 声明会被整值校验拒收）────────────

test('F4 契约：loadState/reason 的失败态与成功态返回值都过引擎同款校验器（schema/execute 必须同批改）', async () => {
  // 场景 1：open/navigate 各跑「失败态」「成功态」——只加 render 读取、不加 schema 声明会在这里被整值拒收。
  let checked = 0
  for (const name of [BROWSER_TOOLS.open, BROWSER_TOOLS.navigate]) {
    for (const state of [FAILED_STATE, LOADED_STATE]) {
      const { tool, value } = await drive(name, { url: state.url }, stateStub(state))
      const violations = validateJsonSchemaValue(tool.output.schema, value, 'value') ?? []
      assert.deepEqual(violations, [], name + '（loadState=' + state.loadState + '）返回值未过自身 schema：' + JSON.stringify(violations))
      assert.equal(value.loadState, state.loadState, name + ' 必须如实取回 loadState')
      checked += 1
    }
  }
  // 场景 2：三个多页工具的返回值同样必须过 schema。
  const datas = {
    [BROWSER_OPS.tabs]: { tabs: TABS, activeTabId: 'tab-2' },
    [BROWSER_OPS.followTab]: { activeTabId: 'tab-2', url: 'http://192.0.2.1/', tabs: TABS },
    [BROWSER_OPS.closeTab]: { closedTabId: 'tab-1', activeTabId: 'tab-2', tabs: TABS },
  }
  for (const [name, args] of [[BROWSER_TOOLS.listTabs, {}], [BROWSER_TOOLS.followTab, { tabId: 'tab-2' }], [BROWSER_TOOLS.closeTab, { tabId: 'tab-1' }]]) {
    const { tool, value } = await drive(name, args, datas)
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'value') ?? []
    assert.deepEqual(violations, [], name + ' 返回值未过自身 schema：' + JSON.stringify(violations))
    checked += 1
  }
  // 反假绿：有效校验数必须等于用例数（任何分支被跳过都会露馅）。
  assert.equal(checked, 7, '有效校验数必须为 7（open/navigate 各两态 + 三个多页工具），实际 ' + checked)
})
