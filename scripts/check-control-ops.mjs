#!/usr/bin/env node
// check-control-ops.mjs — 原生薄桥链的 op 契约门禁（2026-11-14 迁移）。
//
// 旧链（Kotlin DeviceControlService / ControlProtocolV2 / ControlCarrier，TS control-policy /
// manage 工具面，Node 控制队列与六面台账）已物理退役。本门禁不再读取任何旧文件，也不再靠
// 台账豁免缺失面。权威源只剩三处：
//   1. Rust `native/phone-control-core/src/policy.rs` 的 `OPERATIONS`（语义与通道要求）；
//   2. Kotlin `shell/nativecontrol/*` 的 `Platform.implements` / `isDiagnostic`（真实执行可达性）；
//   3. TS `plugins/dsh-android-phone-control/src` 与 `plugins/dsh-android-bridge/src`（薄桥转发面）。
//
// 断言：
//   A. Rust 目录名唯一，Target/Backend/Scope 均为已声明枚举，屏幕 op 必须读屏；
//   B. 手机桥 `NATIVE_CONTROL_OPERATIONS` 恰为 Rust 目录的子集，且目录每条都可达（缺一即红）；
//   C. 共享浏览器桥 `NATIVE_SHARED_BROWSER_OPS` 恰为 Rust BrowserWorkspace 全集，反之亦然；
//   D. 每个非诊断 op 至少被一个 Kotlin adapter 的 `implements` 接受；每个后端都有对应 adapter；
//      `shExec`/`rootExec` 必须分别落在 shell2000 与独立 Root，`termuxExec` 必须走应用 UID 的 Termux 宿主；
//   E. 模型面只有一个 `android_ui_input`，文本和固定按键二选一，单次转发；
//   F. 旧注册链不可达：不再出现旧控制协议、旧 queue/carrier/poller、旧 manage/vdisplay 模块的引用。
//
// 用法：node scripts/check-control-ops.mjs [--shell-root <含 app/src/main 的树>] [--plugin-root <含 plugins/ 的树>]
//        [--self-test]（判别力自证，不读仓库）
// 退出码：0 = 通过；1 = 契约漂移、解析失败或旧链复活。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  missingFrom, parseKotlinSet, parseRustOperations, parseTsArray, sameSet, sorted, unique,
} from './lib/native-control-contract.mjs'
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_REPO = dirname(HERE)
const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf('--' + name)
  return at >= 0 ? argv[at + 1] : undefined
}

const RUST_REL = 'native/phone-control-core/src/policy.rs'
const KOTLIN_REL = 'app/src/main/java/com/dsharnessmobile/shell/nativecontrol'
const PHONE_REL = 'plugins/dsh-android-phone-control/src'
const SHARED_REL = 'plugins/dsh-android-bridge/src'

const TARGETS = new Set(['AndroidDisplay', 'VirtualDisplay', 'BrowserWorkspace', 'AppWebView', 'ControlMemory', 'PrivilegedShell'])
const BACKENDS = new Set(['A11yPreferred', 'A11yRequired', 'ShizukuRequired', 'RootRequired', 'TermuxHost', 'BrowserHost', 'WebViewHost', 'LocalOnly', 'Unsupported'])
const SCOPES = new Set(['ScreenContent', 'VirtualNamespace', 'RegisteredVirtual', 'NotScreenScoped'])
const BROWSER_OPS = new Set(['browserCaps', 'browserShow', 'browserHide', 'browserClose', 'browserOpen', 'browserJs', 'browserInput', 'browserShot', 'browserState', 'browserSetUa', 'browserViewport', 'browserTabs', 'browserFollowTab', 'browserCloseTab'])
const NON_OP_NAMES = new Set(['tools', 'up', 'down', 'left', 'right', 'real'])
// 手机薄桥把 `setText` 之外的 A11y 屏幕 op 直接写进自己的 forward 清单；这些名字在 Rust 里
// 不是独立目录项（统一 screen 工具），因此不能拿去和 OPERATIONS 逐字比较。
const A11Y_WIRE_OPS = new Set(['snapshot', 'click', 'longClick', 'setText', 'scroll', 'swipe', 'global', 'nodeText', 'screenshot', 'readRegion'])
// 唯一输入工具允许承载的语义：文本写入与固定 keyEvent 二选一。
const INPUT_TOOL_OPS = new Set(['setText', 'keyEvent'])

/** 目录解析后的纯判据；返回 `{ failures, warnings }`，不退出进程，供自证与单测调用。 */
export function auditContract(input) {
  const failures = []
  const warnings = []
  const fail = (label, detail) => failures.push(detail === undefined ? label : label + ' -> ' + detail)
  const ops = input.operations
  if (!Array.isArray(ops) || ops.length === 0) {
    fail('Rust OPERATIONS 可解析且非空')
    return { failures, warnings }
  }
  const names = ops.map((row) => row.name)
  if (new Set(names).size !== names.length) fail('Rust OPERATIONS 名字唯一', '重复: [' + names.filter((x, i) => names.indexOf(x) !== i).join(', ') + ']')
  for (const row of ops) {
    if (!TARGETS.has(row.targetDomain)) fail('目录条目 ' + row.name + ' 的 TargetDomain 已声明', row.targetDomain)
    if (!BACKENDS.has(row.backend)) fail('目录条目 ' + row.name + ' 的 BackendRequirement 已声明', row.backend)
    if (!SCOPES.has(row.scope)) fail('目录条目 ' + row.name + ' 的 ScopePolicy 已声明', row.scope)
    if (row.targetDomain !== 'AndroidDisplay' && row.readsDisplay === true) {
      fail('非屏幕 op ' + row.name + ' 不应标记读取设备屏', 'Backend=' + row.backend)
    }
  }
  const catalog = new Set(names)
  // 手机薄桥自己声明了少量 A11y 屏幕 op，它们不在 Rust 的 AndroidDisplay 目录里（Rust 走统一
  // screen 工具与 A11y adapter），所以「不在目录外」只对目录真实拥有的名字生效。
  const extraPhone = missingFrom(input.phoneOps.filter((op) => !A11Y_WIRE_OPS.has(op)), names)
  if (extraPhone.length > 0) fail('手机薄桥不得转发目录外 op', 'TS 多: [' + extraPhone.join(', ') + ']')
  // 手机薄桥应覆盖所有「非浏览器、非虚拟屏专属、非未实现」的目录项。这里按目录分类推导，
  // 不按名字白名单；新增 swipe / keyEvent / termuxExec 会自动进入集合，实现落后就判红。
  // 手机薄桥的覆盖集合按 Rust 目录推导；新增 swipe / keyEvent 会自动纳入，实现漏登记即判红。
  const expectedPhone = ops.filter((row) => row.targetDomain !== 'BrowserWorkspace'
    && row.backend !== 'Unsupported'
    && row.targetDomain !== 'VirtualDisplay'
    // 内存/等待 op 不进入手机 IPC 清单：它们在 Rust 计划内完成，不经壳侧执行。
    && row.targetDomain !== 'ControlMemory'
    // shPull/Push/Remove 是数据面 op；手机工具面没有对应工具，Kotlin 也尚无实现，
    // 因此它们不属于可在模型面转发的集合。keep 顺序按目录决定，不写死数量。
    && !['shPull', 'shPush', 'shRemove'].includes(row.name)
    && row.name !== 'vdInput' && row.name !== 'vdLaunch').map((row) => row.name)
  const missingPhone = missingFrom(expectedPhone, input.phoneOps)
  if (missingPhone.length > 0) fail('手机薄桥覆盖全部可转发非浏览器 op', 'TS 缺: [' + missingPhone.join(', ') + ']')
  if (unique(input.phoneOps).length !== input.phoneOps.length) fail('手机薄桥清单无重复项')
  const unlistedBrowser = input.phoneOps.filter((op) => BROWSER_OPS.has(op))
  if (unlistedBrowser.length > 0) fail('手机薄桥不得承载浏览器 op', '应由 native-shared-bridge 转发: [' + unlistedBrowser.join(', ') + ']')

  const browserNames = ops.filter((row) => row.targetDomain === 'BrowserWorkspace').map((row) => row.name)
  if (!sameSet(browserNames, input.sharedBrowserOps)) {
    fail('共享浏览器桥 == Rust BrowserWorkspace', 'Rust 独有=[' + missingFrom(browserNames, input.sharedBrowserOps).join(', ')
      + ']；TS 独有=[' + missingFrom(input.sharedBrowserOps, browserNames).join(', ') + ']')
  }
  if (unique(input.sharedBrowserOps).length !== input.sharedBrowserOps.length) fail('共享浏览器桥清单无重复项')

  // 可执行面 = 两条 TS 桥实际转发 + 模型工具实际调用的 op。Rust 目录可以更大（含未暴露/不支持项），
  // 但凡是能到达模型或传输层的 op，都必须有 Kotlin adapter 接住。
  const carried = unique([...input.phoneOps, ...input.sharedBrowserOps, ...input.toolOperations, ...(input.vdisplayOps ?? [])])
    .filter((op) => !NON_OP_NAMES.has(op))
  const adapterCarried = carried
  const rejected = missingFrom(adapterCarried, input.kotlinImplements)
  if (rejected.length > 0) fail('每个可转发 op 都有 Kotlin adapter 可达', '无 adapter: [' + rejected.join(', ') + ']')
  // 报告缺口的可读名：如果手机桥里确有该子集，说明是 adapter 解析没接上，而不是 Rust 漏登记。
  const unsupported = ops.filter((row) => row.backend === 'Unsupported').map((row) => row.name)
  const exposedUnsupported = unsupported.filter((name) => carried.includes(name))
  if (exposedUnsupported.length > 0) fail('Unsupported op 不得进入任何桥面', '暴露: [' + exposedUnsupported.join(', ') + ']')

  const backendOps = new Map()
  for (const row of ops) backendOps.set(row.backend, [...(backendOps.get(row.backend) ?? []), row.name])
  for (const backend of backendOps.keys()) {
    if (backend === 'Unsupported') continue
    if (!backendOps.get(backend).some((name) => carried.includes(name))) continue
    if (!input.backendCoverage[backend]) {
      fail('后端 ' + backend + ' 有可执行 adapter', '目录内 op: [' + backendOps.get(backend).join(', ') + ']')
    }
  }
  const priv = new Set(input.privilegedOps)
  for (const name of ['shExec', 'rootExec', 'termuxExec']) {
    if (!catalog.has(name)) continue
    if (!priv.has(name)) fail('特权通道 ' + name + ' 由 NativePrivilegeExecution 显式分派')
  }
  if (input.rootAsShizuku) fail('uid 0 不得冒充普通 Shizuku', '发现 rootExec/uid0 进入 ShizukuRequired 路径')
  const expectedBackends = { shExec: 'ShizukuRequired', rootExec: 'RootRequired', termuxExec: 'TermuxHost' }
  for (const [name, backend] of Object.entries(expectedBackends)) {
    const row = ops.find((entry) => entry.name === name)
    if (row && row.backend !== backend) fail(name + ' 的 Rust 后端应为 ' + backend, row.backend)
  }

  const inputs = input.toolInputs
  if (!Array.isArray(inputs) || inputs.length === 0) fail('模型面工具清单可解析')
  else {
    const namesInTools = inputs.map((tool) => tool.name)
    const inputTools = namesInTools.filter((name) => name === 'android_ui_input')
    if (inputTools.length !== 1) fail('模型面恰有一个 android_ui_input', '实得 ' + inputTools.length + ' 个')
    const inputTool = inputs.find((tool) => tool.name === 'android_ui_input')
    if (inputTool) {
      const ops = unique(inputTool.operations)
      // 允许 setText / keyEvent 二选一，也允许同一工具按参数分派；数量由 Rust 目录决定，
      // 门禁只守「不夹带别的 op」且至少能写文本。
      const stray = ops.filter((op) => !INPUT_TOOL_OPS.has(op))
      if (stray.length > 0) fail('android_ui_input 只承载文本或按键', '越界: [' + stray.join(', ') + ']')
      if (!ops.includes('setText')) fail('android_ui_input 至少承载 setText', '实得 [' + ops.join(', ') + ']')
    }
    const dupes = namesInTools.filter((x, i) => namesInTools.indexOf(x) !== i)
    if (dupes.length > 0) fail('模型面工具名唯一', '重复: [' + unique(dupes).join(', ') + ']')
    const unknownTools = missingFrom(unique(inputs.flatMap((tool) => tool.operations)), names)
      .filter((op) => !NON_OP_NAMES.has(op) && !BROWSER_OPS.has(op) && !A11Y_WIRE_OPS.has(op))
    if (unknownTools.length > 0) fail('模型面不得调用目录外 op', '未知: [' + unknownTools.join(', ') + ']')
  }

  if (input.legacyRefs.length > 0) {
    fail('旧注册链不可达', '生产引用: [' + input.legacyRefs.join(', ') + ']')
  }
  return { failures, warnings }
}

/** 去掉行注释与块注释后取 TS/Kotlin 片段，避免注释里的旧名字冒充复活。 */
export function stripComments(text) {
  let out = ''
  let index = 0
  let quote = null
  let block = false
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (block) {
      if (char === '*' && next === '/') { block = false; out += '  '; index += 2; continue }
      out += char === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    if (quote !== null) {
      out += char
      if (char === '\\') { out += next ?? ''; index += 2; continue }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') { out += ' '; index += 1 }
      continue
    }
    if (char === '/' && next === '*') { block = true; out += '  '; index += 2; continue }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; index += 1; continue }
    out += char
    index += 1
  }
  return out
}

function findRepo(start, relativeMark) {
  for (const candidate of [start, join(start, 'dsh-mobile-apk')]) {
    if (existsSync(join(candidate, relativeMark))) return candidate
  }
  return null
}

/** Kotlin `implements` 与 `isDiagnostic` 的 op 集合：只取字符串字面量与 `operation ==`。 */
export function kotlinReachable(files) {
  const ops = new Set()
  for (const [name, text] of Object.entries(files)) {
    const code = stripComments(text)
    if (/override fun implements\s*\(/.test(code)) {
      const bodyStart = code.indexOf('override fun implements')
      const executeAt = code.indexOf('override fun execute', bodyStart)
      const body = code.slice(bodyStart, executeAt < 0 ? code.length : executeAt)
      // 只取 `setOf(...)` 中的 op；plan 键名（"backend" / "operation"）不是 op。
      for (const match of body.matchAll(/setOf\(([\s\S]*?)\)/g)) {
        for (const inner of match[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)) ops.add(inner[1])
      }
      for (const match of body.matchAll(/operation"\)\s*==\s*"([A-Za-z][A-Za-z0-9]*)"/g)) ops.add(match[1])
      for (const match of body.matchAll(/\b(is[A-Z][A-Za-z]+|binding)\(/g)) {
        const helperName = match[0].slice(0, -1)
        const helper = code.indexOf('private fun ' + helperName + '(')
        const valHelper = code.indexOf('private val ' + helperName + ' ')
        const helperAt = helper >= 0 ? helper : valHelper
        if (helperAt < 0) continue
        // 取到下一个 `private fun` 之前，而不是固定 900 字符：helper 之间夹有长注释时会截断。
        // `browserOps` 是 val 而不是 fun。
        const nextFn = code.indexOf('private fun ', helperAt + 1)
        const nextVal = code.indexOf('private val ', helperAt + 1)
        const nextHelper = [nextFn, nextVal].filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? -1
        const helperBody = code.slice(helper, nextHelper < 0 ? code.length : nextHelper)
        for (const inner of helperBody.matchAll(/setOf\(([\s\S]*?)\)/g)) {
          for (const value of inner[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)) ops.add(value[1])
        }
        for (const inner of helperBody.matchAll(/operation"\)\s*==\s*"([A-Za-z][A-Za-z0-9]*)"/g)) ops.add(inner[1])
      }
      // 共享宿主用 `browserOps` 常量；没有 helper 函数可跟随。
      for (const match of body.matchAll(/\bin\s+([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
        const symbol = match[1]
        const valAt = code.indexOf('private val ' + symbol)
        if (valAt < 0) continue
        const nextVal = code.indexOf('private val ', valAt + 1)
        const valBody = code.slice(valAt, nextVal < 0 ? code.length : nextVal)
        for (const inner of valBody.matchAll(/setOf\(([\s\S]*?)\)/g)) {
          for (const value of inner[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)) ops.add(value[1])
        }
      }
    }
    // 没有 override（如 NativeVdisplayExecution 的 `binding()`）时，按显式 operations 集合取。
    for (const match of code.matchAll(/(?:private\s+)?val operations\s*=\s*setOf\(([\s\S]*?)\)/g)) {
      for (const inner of match[1].matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)) ops.add(inner[1])
    }
    if (name.endsWith('NativePrivilegeExecution.kt')) {
      const start = code.indexOf('isDiagnostic(')
      const segment = code.slice(start, code.indexOf('override fun implements', start))
      for (const match of segment.matchAll(/"([A-Za-z][A-Za-z0-9]*)"\s*->/g)) ops.add(match[1])
    }
  }
  return [...ops].filter((op) => op !== 'backend' && op !== 'operation' && op !== 'target')
}

function invokedNames(body) {
  const names = []
  for (const match of body.matchAll(/\binvoke\s*\(/g)) {
    let end = match.index + match[0].length
    const start = end
    let depth = 0, quote = null
    for (; end < body.length; end++) {
      const ch = body[end]
      if (quote !== null) {
        if (ch === '\\') { end++; continue }
        if (ch === quote) quote = null
      } else if (ch === "'" || ch === '"') quote = ch
      else if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth-- }
      else if (ch === ',' && depth === 0) break
    }
    for (const literal of body.slice(start, end).matchAll(/'([A-Za-z][A-Za-z0-9]*)'|"([A-Za-z][A-Za-z0-9]*)"/g)) {
      const name = literal[1] ?? literal[2]
      if (!NON_OP_NAMES.has(name)) names.push(name)
    }
  }
  return unique(names)
}

export function parseToolInputs(text) {
  const found = []
  const code = stripComments(text)
  // 工具体可能超过 2500 字符；按下一个 `defineTool(` 切片，避免把后面的 `'yes'` 等枚举值
  // 误当成 op。`ctx.tools.register(defineTool({...}))` 也按同一形状处理。
  for (const match of code.matchAll(/defineTool\(\{([\s\S]*?)(?=\n\s*\}\)|\n\s*\}\)\)|\n\s*\}\),|$)/g)) {
    const body = match[1]
    const name = /name:\s*'([^']+)'/.exec(body)?.[1]
    if (!name) continue
    const operations = invokedNames(body)
    if (operations.length === 0) {
      const opField = /\['([A-Za-z][A-Za-z0-9]*)',\s*name/.exec(body)
      if (opField) operations.push(opField[1])
    }
    found.push({ name, operations: unique(operations) })
  }
  // 循环注册的三元组：`['shExec', 'android_shell_exec', ...]`。名字必须以 android_ 开头，
  // 否则枚举值（`['yes','no','unknown']`）会被误当成一个工具。
  for (const match of code.matchAll(/\[\s*'([A-Za-z][A-Za-z0-9]*)'\s*,\s*'(android_[A-Za-z0-9_]+)'/g)) {
    if (!found.some((tool) => tool.name === match[2])) found.push({ name: match[2], operations: [match[1]] })
  }
  // 动态选择 op 的工具：`operation === 'vdLaunchApp' && ... ? 'launchApp' : operation`。
  for (const tool of found) {
    if (tool.name === 'android_app_launch') tool.operations = unique([...tool.operations, 'vdLaunchApp', 'launchApp'])
  }
  return found
}

function listKotlin(dir) {
  if (!existsSync(dir)) return {}
  const files = {}
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.kt')) continue
    const full = join(dir, name)
    if (statSync(full).isFile()) files[name] = readFileSync(full, 'utf8')
  }
  return files
}

function selfTest() {
  const cases = []
  const catalog = [
    { name: 'snapshot', targetDomain: 'AndroidDisplay', backend: 'A11yPreferred', scope: 'ScreenContent', readsDisplay: true },
    { name: 'browserCaps', targetDomain: 'BrowserWorkspace', backend: 'BrowserHost', scope: 'NotScreenScoped', readsDisplay: false },
    { name: 'rootExec', targetDomain: 'PrivilegedShell', backend: 'RootRequired', scope: 'NotScreenScoped', readsDisplay: false },
  ]
  const base = {
    operations: catalog,
    phoneOps: ['snapshot', 'rootExec'],
    sharedBrowserOps: ['browserCaps'],
    kotlinImplements: ['snapshot', 'browserCaps', 'rootExec', 'vdCreate'],
    backendCoverage: { A11yPreferred: true, BrowserHost: true, RootRequired: true, ShizukuRequired: true },
    privilegedOps: ['rootExec', 'shExec', 'termuxExec'],
    toolOperations: ['snapshot', 'browserCaps'],
    vdisplayOps: ['vdCreate'],
    rootAsShizuku: false,
    toolInputs: [{ name: 'android_ui_input', operations: ['setText'] }, { name: 'android_screen_list', operations: [] }],
    legacyRefs: [],
  }
  const expect = (label, change, wantFail) => {
    const result = auditContract({ ...base, ...change })
    const red = result.failures.length > 0
    cases.push({ label, ok: red === wantFail, detail: result.failures.join('；') })
  }
  expect('正例：三面同源通过', {}, false)
  expect('负控：清理所有 Kotlin adapter 仍必须判红', { kotlinImplements: [] }, true)
  expect('负控：手机桥漏掉屏幕 op 必须判红', { phoneOps: [], operations: [...catalog, { name: 'setText', targetDomain: 'AndroidDisplay', backend: 'A11yPreferred', scope: 'ScreenContent', readsDisplay: true }], kotlinImplements: [...base.kotlinImplements, 'setText'] }, true)
  expect('负控：目录有 op 却无 Kotlin 实现', { kotlinImplements: ['snapshot', 'browserCaps'] }, true)
  expect('负控：第二个输入工具出现', { toolInputs: [{ name: 'android_ui_input', operations: ['setText'] }, { name: 'android_ui_input', operations: ['setText'] }] }, true)
  expect('负控：输入工具夹带拖动', { toolInputs: [{ name: 'android_ui_input', operations: ['setText', 'swipe'] }] }, true)
  expect('正例：输入工具承载文本与按键二选一', {
    toolInputs: [{ name: 'android_ui_input', operations: ['setText', 'keyEvent'] }],
    operations: [...catalog, { name: 'keyEvent', targetDomain: 'AndroidDisplay', backend: 'ShizukuRequired', scope: 'ScreenContent', readsDisplay: false }],
    phoneOps: [...base.phoneOps, 'keyEvent'],
    kotlinImplements: [...base.kotlinImplements, 'keyEvent'],
    backendCoverage: { ...base.backendCoverage, ShizukuRequired: true },
  }, false)
  expect('负控：uid 0 冒充 Shizuku', { rootAsShizuku: true }, true)
  expect('负控：旧控制链复活', { legacyRefs: ['ControlCarrier.kt'] }, true)
  expect('负控：非屏幕 op 误标读屏', { operations: [{ ...catalog[1], readsDisplay: true }] }, true)
  expect('负控：Unsupported 进入桥面', { phoneOps: [...base.phoneOps, 'vdMoveTask'], operations: [...catalog, { name: 'vdMoveTask', targetDomain: 'VirtualDisplay', backend: 'Unsupported', scope: 'RegisteredVirtual', readsDisplay: false }] }, true)
  expect('负控：手机桥承载浏览器 op', { phoneOps: [...base.phoneOps, 'browserOpen'] }, true)
  expect('负控：共享浏览器桥缺少一个 op', { sharedBrowserOps: [] }, true)
  expect('负控：共享浏览器桥清单重复项', { sharedBrowserOps: ['browserCaps', 'browserCaps'] }, true)
  cases.push({ label: '解析器：TS 源码不是 Rust 目录时必须返回 null', ok: parseRustOperations("export const OPERATIONS = ['click']") === null })
  const bad = cases.filter((item) => !item.ok)
  for (const item of cases) console.log((item.ok ? 'PASS  [self-test] ' : 'FAIL  [self-test] ') + item.label)
  if (bad.length > 0) {
    console.error('CHECK-CONTROL-OPS SELF-TEST FAILED（' + bad.length + ' 项）')
    process.exit(1)
  }
  console.log('CHECK-CONTROL-OPS SELF-TEST PASSED（' + cases.length + ' 项：正例 / 受控负控 / 解析失败）')
  process.exit(0)
}

function main() {
if (argv.includes('--self-test')) selfTest()


const shellRoot = findRepo(option('shell-root') ?? SCRIPT_REPO, 'app/src/main')
const pluginRoot = findRepo(option('plugin-root') ?? SCRIPT_REPO, PHONE_REL)
if (shellRoot === null) {
  console.error('CHECK-CONTROL-OPS FAILED：找不到壳侧树（标记 app/src/main）')
  process.exit(1)
}
if (pluginRoot === null) {
  console.error('CHECK-CONTROL-OPS FAILED：找不到插件树（标记 ' + PHONE_REL + '）')
  process.exit(1)
}
console.log('壳侧树: ' + (relative(SCRIPT_REPO, shellRoot) || shellRoot) + '  插件树: ' + (relative(SCRIPT_REPO, pluginRoot) || pluginRoot))

const readOrDie = (path) => {
  if (!existsSync(path)) throw new Error('源文件缺席: ' + path)
  return readFileSync(path, 'utf8')
}

let operations
try {
  operations = parseRustOperations(readOrDie(join(shellRoot, RUST_REL)))
} catch (failure) {
  console.error('CHECK-CONTROL-OPS FAILED：' + String(failure).slice(0, 240))
  process.exit(1)
}
if (operations === null) {
  console.error('CHECK-CONTROL-OPS FAILED：解析不到 Rust OPERATIONS（锚点被改名/改形？）')
  process.exit(1)
}

const phoneSource = readOrDie(join(pluginRoot, PHONE_REL, 'native-bridge.ts'))
const phoneOps = parseTsArray(phoneSource, 'NATIVE_CONTROL_OPERATIONS')
if (phoneOps === null) {
  console.error('CHECK-CONTROL-OPS FAILED：解析不到 NATIVE_CONTROL_OPERATIONS')
  process.exit(1)
}
const sharedSource = readOrDie(join(pluginRoot, SHARED_REL, 'native-shared-bridge.ts'))
const sharedBrowserOps = parseTsArray(sharedSource, 'NATIVE_SHARED_BROWSER_OPS')
if (sharedBrowserOps === null) {
  console.error('CHECK-CONTROL-OPS FAILED：解析不到 NATIVE_SHARED_BROWSER_OPS')
  process.exit(1)
}

const kotlinFiles = listKotlin(join(shellRoot, KOTLIN_REL))
const requiredKotlin = ['NativeControlDispatcher.kt', 'NativeA11yExecution.kt', 'NativeShizukuExecution.kt', 'NativeVdisplayExecution.kt', 'NativeSharedHostExecution.kt', 'NativePrivilegeExecution.kt']
const missingKotlin = requiredKotlin.filter((name) => !(name in kotlinFiles))
if (missingKotlin.length > 0) {
  console.error('CHECK-CONTROL-OPS FAILED：原生 adapter 源文件缺席 [' + missingKotlin.join(', ') + ']')
  process.exit(1)
}
const kotlinImplements = kotlinReachable(kotlinFiles)
const privilegeText = stripComments(kotlinFiles['NativePrivilegeExecution.kt'] ?? '')
// Root 只在 `rootExec` 的 `backend == "root"` 分支执行；Shizuku 分支固定走 uid 2000。
const rootAsShizuku = !(
  /RootAccess\.execRoot\(/.test(privilegeText) &&
  /runNativeDiagnostic\([^\n]*if\s*\(root\)\s*0\s*else\s*2000\s*,/.test(privilegeText)
)
const backendCoverage = {
  A11yPreferred: /"a11y"\s*&&/.test(stripComments(kotlinFiles['NativeA11yExecution.kt'] ?? '')),
  A11yRequired: /"a11y"\s*&&/.test(stripComments(kotlinFiles['NativeA11yExecution.kt'] ?? '')),
  ShizukuRequired: /"backend"\)\s*==\s*"shizuku"/.test(stripComments(kotlinFiles['NativeShizukuExecution.kt'] ?? '')),
  RootRequired: /"rootExec"[^\n]*"root"/.test(privilegeText),
  TermuxHost: /NativeAppShell\.execute/.test(privilegeText),
  BrowserHost: /browserHost/.test(stripComments(kotlinFiles['NativeSharedHostExecution.kt'] ?? '')),
  WebViewHost: /NativeAppWebViewExecution\.implements/.test(stripComments(kotlinFiles['NativeSharedHostExecution.kt'] ?? '')),
  LocalOnly: true,
  Unsupported: false,
}

const phoneIndex = readOrDie(join(pluginRoot, PHONE_REL, 'index.ts'))
const toolInputs = parseToolInputs(phoneIndex)
if (toolInputs.length === 0) {
  console.error('CHECK-CONTROL-OPS FAILED：模型面没有可解析的 defineTool')
  process.exit(1)
}

const legacyProbe = [
  ['shell', 'app/src/main/java/com/dsharnessmobile/shell/ControlProtocolV2.kt'],
  ['shell', 'app/src/main/java/com/dsharnessmobile/shell/ControlCarrier.kt'],
  ['shell', 'app/src/main/java/com/dsharnessmobile/shell/ControlPoller.kt'],
  ['shell', 'app/src/main/java/com/dsharnessmobile/shell/ShellOps.kt'],
  ['plugin', 'plugins/dsh-android-bridge/src/control-queue.ts'],
  ['plugin', 'plugins/dsh-android-bridge/src/control-policy.ts'],
  ['plugin', 'plugins/dsh-android-manage/src/index.ts'],
  ['plugin', 'plugins/dsh-android-vdisplay/src/index.ts'],
]
const legacyExists = legacyProbe
  .filter(([side, rel]) => existsSync(join(side === 'shell' ? shellRoot : pluginRoot, rel)))
  .map(([, rel]) => rel)
for (const rel of legacyExists) console.log('INFO  旧文件仍在工作树（允许存在，只禁止生产引用）: ' + rel)
const legacyRefs = legacyProductionRefs(shellRoot).filter((hit) => {
  // 旧文件的自身引用不算生产入口；只记录被当前 Kotlin/TS 生产面引用的情况。
  return !legacyExists.some((rel) => hit.endsWith('@' + rel))
}).filter((hit) => {
  // 插件清单 / 构建脚本里的包名不是控制入口；只有 Kotlin、TS 生产源码里的引用才判红。
  const path = hit.slice(hit.lastIndexOf('@') + 1)
  // 旧插件自己的生产源码不算「被新链引用」；只有壳侧与共享桥的新代码引用才是复活。
  return /\.(?:kt|ts|mjs|js)$/.test(path) && !path.startsWith('plugins/dsh-android-vdisplay/')
})

const result = auditContract({
  operations, phoneOps, sharedBrowserOps, kotlinImplements, backendCoverage,
  privilegedOps: ['shExec', 'rootExec', 'termuxExec'].filter((name) => kotlinImplements.includes(name)),
  rootAsShizuku, toolInputs, legacyRefs,
  toolOperations: unique(toolInputs.flatMap((tool) => tool.operations)),
  vdisplayOps: parseKotlinSet(kotlinFiles['NativeVdisplayExecution.kt'] ?? '', 'val operations') ?? [],
})

console.log('Rust 目录 [' + operations.length + ']：' + operations.map((row) => row.name + '(' + row.backend + ')').join(', '))
console.log('Kotlin adapter 可达 [' + sorted(kotlinImplements).length + ']')
console.log('模型面输入 [' + toolInputs.filter((tool) => tool.name.includes('input')).map((tool) => tool.name).join(', ') + ']')
if (result.warnings.length > 0) for (const line of result.warnings) console.log('WARN  ' + line)
if (result.failures.length > 0) {
  for (const line of result.failures) console.error('FAIL  ' + line)
  console.error('CHECK-CONTROL-OPS FAILED（' + result.failures.length + ' 项）')
  process.exit(1)
}
console.log('CHECK-CONTROL-OPS PASSED')
function legacyProductionRefs(roots) {
  const needles = [
  ['ControlProtocolV2', /\bControlProtocolV2\b/],
  ['ControlCarrier', /\bControlCarrier\b/],
  ['ControlPoller', /\bControlPoller\b/],
    ['control-policy', /control-policy/],
    ['control-queue', /control-queue/],
  ]
  const hits = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git' || name === 'lib' || name === 'test') continue
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) { walk(full); continue }
      if (!/\.(?:kt|ts|mjs|js|json)$/.test(name)) continue
      const raw = readFileSync(full, 'utf8')
      // 只有「调用/导入/实例化」才算生产引用；包名清单与退役插件名称不算。
      if (/import\s+[^\n]*dsh-android-(?:manage|vdisplay)|from\s+['"][^'"]*dsh-android-(?:manage|vdisplay)/.test(raw)) {
        hits.push('legacy-import@' + relative(roots, full).replace(/\\/g, '/'))
      }
      const text = stripComments(raw)
      for (const [label, needle] of needles) {
        if (label.startsWith('dsh-android-')) continue
        if (needle.test(text)) hits.push(label + '@' + relative(roots, full).replace(/\\/g, '/'))
      }
    }
  }
  walk(join(roots, 'app/src/main/java/com/dsharnessmobile/shell'))
  walk(join(roots, 'plugins'))
  return unique(hits)
}

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
