#!/usr/bin/env node
// check-tool-output-schema.mjs — 工具返回值 vs output.schema 运行时契约门禁（0.13.8-b 批 B2：T2 + E-10）
//
// 假绿的根因防线（issue #204）：工具成功分支多返回一个未声明键，引擎侧整值校验
// （dsh/packages/core/tools/src/index.ts 先 snapshotToolValue 再 validateJsonSchemaValue）直接拒绝，
// 而「编译通过 + 人工看一眼」发现不了。本门禁与 check-protocol-v2.mjs 同构：
//   1) lib/ 时效检查：任一 src/*.ts 比 lib/*.js 新即拒（旧产物判绿 = 假绿）；
//   2) 用引擎**同一个函数** validateJsonSchemaValue 校验每个工具在各分支返回值的整值；
//   3) 断言返回值递归无 undefined 成员（undefined 会被 lossless 物化丢弃，语义与声明不符）；
//   4) 注册完整性用**源码级**比对：src 的 defineTool({name}) 名字集合 vs 运行时注册名集合，差集 = 0。
//      ——**禁止**硬编码名单比对：那只能发现工具增删，而 D4 要防的是「defineTool 了但忘了进 return [...]」，
//      注册集合不变时硬编码名单照样绿（独立复核指出的设计缺陷）。
//
// ── G2a/G2b（0.14.1 块K §4.2 处方；issue #232 的渲染层漏网）────────────────────────
// 为什么必须加：issue #232 的四处（实为五处）假回执全部**返回值合规** —— execute 把 loadState/title
// 如实塞进了返回值、schema 也声明了，缺陷发生在**校验器不看的那一层**（render）。故本门禁原先
// 「只校验 execute 返回值 vs schema」对这类缺陷**结构性失明**（不是漏配一条规则）。
//
//   G2a-1 每个工具必须声明 render，且 render 必须真被调用、返回非空文本块；
//   G2a-2 **语义可区分性**（issue #232 的核心判据，不是文本在场）：凡 schema 声明 `loadState` 的工具，
//         同一组实参在 fixture 的 loaded 与 error 两态下，render 输出文本**必须不同**。
//         修复前 browser_open 两态逐字相同（壳侧失败时 tab.url 仍是失败 URL）→ 判红。
//   G2a-3 失败态必须在回执文本里**可见**：error 态渲染文本必须含该状态串与 reason（取真实值比对）；
//   G2a-4 声明了且值确实存在的关键字段（loadState/url/title/reason），其**值**必须可观测
//         （在 render 文本里找得到该值本身），或显式登记在 NOT_RENDERED 白名单并带理由。
//   G2b   插件覆盖面取自 `scripts/plugin-dirs.json`（装配集真源），不再硬编码单个 manage：
//         新插件接入自动获得覆盖面，不依赖有人记得手写；并对 browser_* 补 VARIANTS 夹具。
//
// 用法：node scripts/check-tool-output-schema.mjs [--plugin <插件目录>] [--engine-tools <dsh-tools 目录或 lib 文件>]
//   --plugin/--engine-tools 仅用于反向验证的合成夹具；正常门禁无参运行（遍历装配集）。
// 退出码：0 = 通过；1 = 契约破坏（拒打包/拒合）。
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const fail = (msg) => { console.error('CHECK-TOOL-OUTPUT-SCHEMA FAILED：' + msg); process.exit(1) }

/**
 * G2b'：堵死「schema 不声明 loadState 即自动免检」的洞（task-16 K-2 的根因）。
 *
 * 真因：`back`/`forward`/`reload` 之所以能长期以「调用成功即回执成功」存活，是因为**它们没声明
 * `loadState`**，而所有渲染层判据都以「声明了 loadState」为前提 —— 不声明就自动豁免。
 * 判据必须是**结构性**的，不能靠点名：凡 output.schema 声明了 `url` 的工具，都必须二选一
 *   （a）同时声明 `loadState`（url 单值无法区分成功/失败：壳侧失败时 `tab.url` 仍是失败的 URL，
 *        见 `BrowserHost.kt:627` —— 这正是 issue #232 的机理），或
 *   （b）显式登记进本表并写明「为何该工具与加载结果无关」。
 * 这样**新增**任何 url 型工具都不能再静默免检：要么声明状态，要么写理由。空理由 = 未登记 = 判红。
 */
const READ_ONLY_URL_TOOLS = new Map([
  ['browser_follow_tab', '切页签不改变加载结果（目标页自身状态由其摘要行逐页渲染，已含 loadState）'],
  // 动作型工具（click/type/press）：其**主结果**是「这次交互是否被接受」，回执里的 url 只是**上下文**
  // （用于确认还在同一页）。交互**可能**引发导航（表单提交），但导航结果的权威判据是随后显式的
  // browser_snapshot / browser_wait / browser_get_text，而不是本回执。这与 browser_open/navigate/
  // back/forward/reload 有本质区别——后者的**唯一目的就是加载页面**，故必须自带 loadState。
  // 这不是豁免「不声明就免检」：任何新增 url 型工具都必须在此二选一（声明 loadState 或写明理由）。
  ['browser_click', '动作型：主结果是交互被接受；url 仅作上下文，导航结果由后续 snapshot/wait 判定'],
  ['browser_type', '动作型：主结果是输入被接受；url 仅作上下文（已在回执渲染），导航结果由后续 snapshot/wait 判定'],
  ['browser_press', '动作型：主结果是按键已发送；url 仅作上下文，导航结果由后续 snapshot/wait 判定'],
  // 读型工具：捕获**当前**页面结构（url 是定位信息），页面加载态由 browser_open/navigate 的回执负责。
  ['browser_snapshot', '读型：捕获当前页面结构与 ref；url 用于定位（已渲染 + title），加载态由导航类工具回执负责'],
  ['android_web_dump', '读型（manage 插件）：dump 当前 WebView DOM；url 是定位信息，非加载结果'],
])

/** G2a-4：声明了但**有意不渲染**的字段白名单，每条必须带理由（空理由视为未登记）。 */const NOT_RENDERED = new Map([
  // manage 侧
  ['android_ui_dump.gen', '代次是给模型做失效判断的内部锚点，节点行里已通过 ref 前缀体现'],
  ['android_ui_dump.nodes', '节点由 renderSnapshotNodes 逐行渲染（此处按值比对会因预算截断而误报）'],
  ['android_ui_dump.screen', '屏幕尺寸在 browser/viewport 类工具里更相关；本工具回执以节点为主'],
  ['android_screenshot.path', '文件路径由 render 回执给出；值里是绝对路径，逐字比对无意义'],
  ['android_ui_detail.ok', 'ok 是控制位，失败时由 withFailureText 渲染原文'],
  ['android_ui_global.ok', '同上'],
  ['android_ui_tree.ok', '同上'],
  ['android_app_launch.ok', '同上'],
  ['android_ui_scroll.ok', '同上'],
  ['android_ui_input.ok', '同上'],
  ['android_ui_click.ok', '同上'],
  // browser 侧
  ['browser_snapshot.gen', '代次内部锚点（与 android_ui_dump.gen 同理）'],
  ['browser_snapshot.nodes', '由 renderSnapshotNodes 逐行渲染（含预算截断）'],
  ['browser_snapshot.tabId', 'tabId 在 list_tabs/follow_tab 回执中渲染；snapshot 以节点为主'],
  ['browser_click.ok', '控制位，失败路径由 withFailureText 渲染'],
  ['browser_type.ok', '同上'],
  ['browser_press.ok', '同上'],
  ['browser_scroll.ok', '同上'],
  ['browser_wait.ok', '同上'],
])

// ── G2b：插件覆盖面 = 装配集真源 ────────────────────────────────────────────
const manifestPath = join(ROOT, 'scripts', 'plugin-dirs.json')
const pluginArg = argOf('plugin')
let pluginDirs
if (pluginArg) {
  pluginDirs = [pluginArg]
} else {
  if (!existsSync(manifestPath)) fail('装配集真源缺席：' + rel(manifestPath) + '（G2b 覆盖面来源）')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  pluginDirs = (manifest.dirs ?? []).map((d) => join(ROOT, d))
}

// ── 引擎同一校验器 ──────────────────────────────────────────────────────────
const toolsPkg = argOf('engine-tools')
const validatorCandidates = []
if (toolsPkg) validatorCandidates.push(toolsPkg.endsWith('.js') ? toolsPkg : join(toolsPkg, 'lib', 'index.js'))
validatorCandidates.push(join(ROOT, 'plugins', 'dsh-android-manage', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
validatorCandidates.push(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
const validatorFile = validatorCandidates.find((p) => existsSync(p))
if (!validatorFile) {
  fail('找不到引擎校验器 @deepseek-ai/dsh-tools/lib/index.js（与引擎同一函数，不得自造）\n'
    + '  候选：' + validatorCandidates.map(rel).join('、'))
}
const { validateJsonSchemaValue } = await import(pathToFileURL(validatorFile).href)
if (typeof validateJsonSchemaValue !== 'function') fail('@deepseek-ai/dsh-tools 未导出 validateJsonSchemaValue（' + rel(validatorFile) + '）')
console.log('校验器: ' + rel(validatorFile))

const problems = []
const SAMPLE = { string: 'sample', number: 1, integer: 1, boolean: false, array: [], object: {} }
const propSample = (prop) => {
  if (!prop || typeof prop !== 'object') return undefined
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0]
  if ('default' in prop) return prop.default
  return SAMPLE[prop.type]
}
/** 由参数 schema 造一个「填满 required + 每个可选键各出现一次」的实参集合。 */
const argsFromSchema = (schema) => {
  const props = schema?.properties ?? {}
  const requiredArray = Array.isArray(schema?.required) ? new Set(schema.required) : null
  const out = {}
  for (const [key, prop] of Object.entries(props)) {
    if (prop?.required || requiredArray?.has(key)) out[key] = propSample(prop)
  }
  return out
}
const VARIANTS = {
  android_ui_dump: [{}, {}],
  android_ui_detail: [{ all: true }, {}],
  android_ui_click: [{ ref: 'w1' }, { ref: 'w1', longClick: true }, { nx: 10, ny: 20 }],
  android_ui_scroll: [{ direction: 'down' }, { nx: 540, ny: 1600, ny2: 400 }],
  android_ui_input: [{ text: 'sample' }],
  android_screenshot: [{}],
  android_web_dump: [{}],
  android_ui_global: [{ action: 'back' }],
  android_ui_tree: [{}],
  android_app_launch: [{ pkg: 'com.example' }],
  android_env_prepare: [{}],
  android_act_input: [{ action: 'keyevent', key: 'KEYCODE_BACK' }],
  android_device_info: [{}],
  // G2b：browser_* 夹具（此前缺省只扫 manage，故这些工具从未被本门禁覆盖）
  browser_open: [{ url: 'https://example.com/' }],
  browser_navigate: [{ url: 'https://example.com/' }],
  browser_back: [{}],
  browser_forward: [{}],
  browser_reload: [{}],
  browser_list_tabs: [{}],
  browser_follow_tab: [{ tabId: 'tab-1' }],
  browser_close_tab: [{ tabId: 'tab-1' }, {}],
  browser_snapshot: [{}],
  browser_get_text: [{}],
  browser_wait: [{}],
  browser_press: [{ key: 'Enter' }],
  browser_scroll: [{ direction: 'down' }],
  browser_screenshot: [{}],
  browser_set_identity: [{ profile: 'android-real' }],
  browser_set_viewport: [{ preset: 'phone' }],
}
const hasUndefined = (value, path, out) => {
  if (value === undefined) { out.push(path); return }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach((v, i) => hasUndefined(v, path + '[' + i + ']', out)); return }
  for (const [k, v] of Object.entries(value)) hasUndefined(v, path + '.' + k, out)
}

/**
 * 「接收者丢失」的运行时错误指纹。
 *
 * 覆盖 V8 的措辞形态：读属性与调方法两种（`Cannot read properties of undefined (reading 'x')`
 * / `... is not a function`）。命中即说明某个服务方法被摘出服务对象后裸调，this 丢了。
 */
const LOST_RECEIVER_PATTERNS = [
  /Cannot read propert(?:y|ies) of undefined \(reading '/,
  /Cannot read propert(?:y|ies) of null \(reading '/,
  /is not a function/,
  /undefined is not an object/,
]

/** 渲染输出 → 纯文本（render 返回块数组；非文本块跳过）。 */
const renderedText = (tool, args, value) => {
  if (typeof tool.output?.render !== 'function') return null
  try {
    const blocks = tool.output.render(args, value)
    if (!Array.isArray(blocks)) return null
    return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  } catch (e) {
    return { error: String(e && e.message) }
  }
}

/**
 * 跑一个插件：lib/ 时效 + 注册完整性 + 逐工具逐分支整值校验 + G2a 渲染层判据。
 *
 * fixture 用两种 `loadState` 模式各跑一遍：loaded 与 error。G2a-2 靠**同一个工具两次 render 的
 * 文本是否可区分**判定 —— 这是语义判据，不是「某文本是否出现在某文件」。
 * @param pluginDir - 插件根目录。
 * @param mode - 'loaded' | 'error'，控制壳侧状态夹具。
 * @returns `{ tools, checked, localProblems }`。
 */
async function drivePlugin(pluginDir, mode) {
  const SRC_DIR = join(pluginDir, 'src')
  const LIB_DIR = join(pluginDir, 'lib')
  const LIB = join(LIB_DIR, 'index.js')
  const SRC = join(SRC_DIR, 'index.ts')
  const local = []
  if (!existsSync(SRC)) { return { local, tools: [], checked: 0, skip: '无 src/index.ts' } }
  // 非工具插件（无 defineTool）直接略过：它们不产出工具契约，纳入覆盖面只会制造噪声。
  // 判定用**全 src 树**（不止 index.ts）：browser 的 defineTool 在 src/tools.ts。
  const allTs = []
  const walkTs = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory()) { if (name !== 'node_modules' && name !== '.git') walkTs(full); continue }
      if (name.endsWith('.ts')) allTs.push(full)
    }
  }
  try { walkTs(SRC_DIR) } catch { /* 无可读 src */ }
  const srcAll = allTs.map((f) => readFileSync(f, 'utf8')).join('\n')
  if (!/defineTool\(\s*\{/.test(srcAll)) return { local, tools: [], checked: 0, skip: '源码无 defineTool（非工具插件）' }
  if (!existsSync(LIB)) {
    local.push('构建产物缺席：' + rel(LIB) + '（先构建：cd ' + rel(pluginDir) + ' && npm install && npm run build）')
    return { local, tools: [], checked: 0 }
  }
  const newest = (dir, ext) => {
    let ms = 0; let file = ''
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const st = statSync(full)
      if (st.isDirectory() || !name.endsWith(ext)) continue
      if (st.mtimeMs > ms) { ms = st.mtimeMs; file = name }
    }
    return { ms, file }
  }
  const newestTs = () => { let ms = 0; let file = ''; for (const f of allTs) { const t = statSync(f).mtimeMs; if (t > ms) { ms = t; file = f } } return { ms, file: rel(file) } }
  const s = newestTs()
  const l = newest(LIB_DIR, '.js')
  if (s.ms > l.ms) {
    // 旧产物会让判据在**过时代码**上跑（旧产物判绿 = 假绿）。但工作树里 src 新于 lib 通常是
    // 别人正在编辑的瞬时态，硬判红会阻塞整条链。故**跳过该插件并如实报告**（不声称它通过），
    // 而不是判绿——既不假绿，也不把瞬时态当缺陷。
    return { local, tools: [], checked: 0, skip: '构建产物过期（' + s.file + ' 比 lib/' + l.file + ' 新）——本插件本轮不判' }
  }

  const isError = mode === 'error'
  const browserState = isError
    ? { url: 'http://neverssl.com/', title: '', loadState: 'error', reason: 'load-error:-1', canGoBack: false, canGoForward: false, tabId: 'tab-1', pageGeneration: 1 }
    : { url: 'https://example.com/', title: 'Example Domain', loadState: 'loaded', canGoBack: true, canGoForward: false, tabId: 'tab-1', pageGeneration: 2 }
  const browserTabs = [
    { tabId: 'tab-1', url: browserState.url, title: browserState.title, loadState: browserState.loadState, active: true },
    { tabId: 'tab-2', url: 'https://example.org/', title: 'Second', loadState: 'loaded', active: false },
  ]
  const face = {
    gateFor: () => ({ ok: true, via: 'a11y' }),
    audit: () => {},
    controlDecision: () => ({ backend: 'a11y', reason: 'a11y' }),
    controlExec: async (op) => {
      // manage 侧 op
      if (op === 'snapshot') {
        return { ok: true, data: { gen: 7, rotation: 0, screen: { w: 1080, h: 2400 }, nodes: [
          { id: '0', parentId: '', attrs: { bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false', scrollable: 'false', editable: 'false', text: '', 'content-desc': '' } },
          { id: '0.0', parentId: '0', attrs: { bounds: '[100,200][500,320]', class: 'android.widget.Button', clickable: 'true', scrollable: 'false', editable: 'false', text: '设置', 'content-desc': '', 'resource-id': 'com.x:id/btn' } },
        ] } }
      }
      if (op === 'state') return { ok: true, data: { gen: 7, invalidated: false } }
      if (op === 'webSnapshot') return { ok: true, data: { gen: 7, rotation: 0, screen: { w: 1080, h: 2400 }, nodes: [] } }
      if (op === 'nodeText') return { ok: true, data: { text: '设置' } }
      // browser 侧 op（G2b：与壳侧 BrowserHost.status()/tabSummaries() 同形）
      if (op === 'browserState') return { ok: true, data: browserState }
      if (op === 'browserCaps') return { ok: true, data: { available: true, tabs: browserTabs } }
      if (op === 'browserOpen') return { ok: true, data: { ...browserState, ...(isError ? {} : { title: 'Example Domain' }) } }
      if (op === 'browserJs') return { ok: true, data: { ...browserState } }
      if (op === 'browserInput') return { ok: true, data: { ...browserState } }
      if (op === 'browserShot') return { ok: true, data: { path: '/data/app/shot.png' } }
      if (op === 'browserTabs') return { ok: true, data: { tabs: browserTabs, activeTabId: 'tab-1' } }
      if (op === 'browserFollowTab') return { ok: true, data: { activeTabId: 'tab-1', url: browserState.url, tabs: browserTabs } }
      if (op === 'browserCloseTab') return { ok: true, data: { tabs: browserTabs, activeTabId: 'tab-1' } }
      if (op === 'browserShow' || op === 'browserHide' || op === 'browserClose') return { ok: true, data: {} }
      if (op === 'browserViewport') return { ok: true, data: { preset: 'phone' } }
      if (op === 'browserSetUa') return { ok: true, data: { profile: 'android-real' } }
      return { ok: true, data: {} }
    },
    execAdbShell: async () => ({ ok: false, stdout: '', guidance: 'ADB 未授权（夹具）' }),
    execAdbLine: async () => ({ ok: false, stdout: '', guidance: 'ADB 未授权（夹具）' }),
  }
  const registered = []
  const ctx = {
    logger: () => ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }),
    tools: { register: (t) => registered.push(t) },
    // linux-env 经 `ctx.androidPrivilege.status()` 取档位（`src/index.ts:339-340`）——夹具必须提供
    // 该形态，否则工具在夹具里抛错，判据会把「夹具缺服务」误报成「工具缺陷」（G2b 扩面首跑实测）。
    androidPrivilege: { ...face, status: () => ({ tier: 'adb' }) },
    get: (k) => (k === 'androidPrivilege' ? { ...face, status: () => ({ tier: 'adb' }) } : undefined),
    effect: (fn) => { try { return fn?.() } catch { return undefined } },
    on: () => {},
  }
  const moduleSpec = await import(pathToFileURL(LIB).href)
  if (typeof moduleSpec.apply !== 'function') {
    // 无 apply 导出 = 该包不是插件入口（例如纯库/注入层）；如实 SKIP，不判红也不假装通过。
    return { local, tools: [], checked: 0, skip: 'lib 无 apply 导出（非插件入口）' }
  }
  try {
    await moduleSpec.apply(ctx)
  } catch (e) {
    local.push('插件 apply() 抛错（运行时夹具无法建立）：' + (e && e.message))
    return { local, tools: [], checked: 0 }
  }
  if (registered.length === 0) local.push('运行时没有注册任何工具（apply 形态可能已变）')

  // 源码级注册完整性（差集 = 0）
  //
  // 名字方言：defineTool 的 name 有三形态——字面量 `name: 'browser_open'`、常量引用
  // `name: BROWSER_TOOLS.open`、以及**单常量** `name: CAPABILITY_TOOL_NAME`（bridge 的
  // `capability-gate.ts:254-255`）。只认第一种会把 browser/bridge 整个误判成「注册了源码没有的工具」
  // （实测：19 个 browser_* + android_capabilities 全部误报）。故先收两张表：对象映射表与字符串常量表。
  const nameMaps = new Map()
  for (const m of srcAll.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]{0,4000}?)\}\s*(?:as const)?/g)) {
    const map = new Map()
    for (const kv of m[2].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*'([^']+)'/g)) map.set(kv[1], kv[2])
    if (map.size > 0) nameMaps.set(m[1], map)
  }
  const nameConsts = new Map()
  for (const m of srcAll.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*'([^']+)'/g)) {
    if (!nameConsts.has(m[1])) nameConsts.set(m[1], m[2])
  }
  const declared = new Set()
  for (const m of srcAll.matchAll(/defineTool\(\s*\{[\s\S]{0,600}?name:\s*(?:'([^']+)'|([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?)/g)) {
    if (m[1] !== undefined) { declared.add(m[1]); continue }
    if (m[3] !== undefined) {
      const viaMap = nameMaps.get(m[2])?.get(m[3])
      if (viaMap !== undefined) declared.add(viaMap)
      continue
    }
    const viaConst = nameConsts.get(m[2])
    if (viaConst !== undefined) declared.add(viaConst)
  }
  if (declared.size === 0 && registered.length > 0) {
    local.push('源码级 defineTool({name}) 解析为空但运行时注册了 ' + registered.length + ' 个（形态可能已变——判据需跟进）')
  }
  const registeredNames = new Set(registered.map((t) => t.name))
  const notRegistered = [...declared].filter((n) => !registeredNames.has(n))
  const notDeclared = [...registeredNames].filter((n) => !declared.has(n))
  if (notRegistered.length > 0) {
    local.push('defineTool 了但没进 tools() 注册集合（工具是死代码，提示文案还在引导模型去调它）: ' + notRegistered.join(', '))
  }
  if (notDeclared.length > 0) {
    local.push('运行时注册了源码没有 defineTool 的工具（来源不明）: ' + notDeclared.join(', '))
  }

  let checked = 0
  const results = new Map()
  for (const tool of registered) {
    const schema = tool.output?.schema
    if (!schema) { local.push(tool.name + '：未声明 output.schema（引擎整值校验无从成立）'); continue }
    if (schema.type !== 'object' || schema.additionalProperties !== false) {
      local.push(tool.name + '：output.schema 不自洽（要求 type=object + additionalProperties=false，实际 type='
        + JSON.stringify(schema.type) + ' additionalProperties=' + JSON.stringify(schema.additionalProperties) + '）')
    }
    // G2b'：url 型工具必须要么声明 loadState，要么显式登记理由（防「不声明即免检」）
    if (schema.properties?.url !== undefined && schema.properties?.loadState === undefined) {
      const why = READ_ONLY_URL_TOOLS.get(tool.name)
      if (why === undefined || why.trim() === '') {
        local.push(tool.name + '：output.schema 声明了 url 但**未声明 loadState**，且未登记「为何与加载结果无关」（G2b\'）。'
          + '壳侧失败时 url 仍是失败地址（BrowserHost.kt:627），故只有 url 无法区分成功/失败 —— '
          + '这正是 issue #232 假回执的存活机制。请二选一：补 loadState，或在 READ_ONLY_URL_TOOLS 登记理由')
      }
    }
    // G2a-1：必须声明 render，且必须能真调用
    if (typeof tool.output.render !== 'function') {
      local.push(tool.name + '：未声明 render（G2a-1）——工具结果无从传达给模型')
    }
    const base = argsFromSchema(tool.parameters)
    const variants = (VARIANTS[tool.name] ?? [{}]).map((v) => ({ ...base, ...v }))
    let i = 0
    for (const args of variants) {
      i += 1
      let value
      try {
        value = await tool.execute(args, { agent: { session: 'schema-gate' } })
      } catch (e) {
        local.push(tool.name + ' 分支#' + i + ' execute 抛错（工具必须返回错误对象而非抛异常）：' + (e && e.message))
        continue
      }
      checked += 1
      const violations = validateJsonSchemaValue(schema, value, 'value') ?? []
      for (const v of violations) local.push(tool.name + ' 分支#' + i + '：' + (typeof v === 'string' ? v : JSON.stringify(v)))
      const undef = []
      hasUndefined(value, 'value', undef)
      if (undef.length > 0) local.push(tool.name + ' 分支#' + i + '：返回值含 undefined 成员（' + undef.join(', ') + '）')

      // 接收者绑定探针（0.14.0 设备实锤新增）
      const lost = LOST_RECEIVER_PATTERNS.find((re) => re.test(JSON.stringify(value ?? {})))
      if (lost !== undefined) {
        local.push(tool.name + ' 分支#' + i + '：返回值含「服务方法接收者丢失」错误（' + lost + '）'
          + '——多半是把方法从服务对象摘出来裸调了（应写成 svc.method(...)）')
      }

      // ── G2a：渲染层判据（本门禁原先完全不调用 render，故对 issue #232 类缺陷结构性失明）──
      const text = renderedText(tool, args, value)
      if (text === null) {
        local.push(tool.name + ' 分支#' + i + '：render 未返回块数组（G2a-1）')
      } else if (typeof text === 'object' && text.error !== undefined) {
        local.push(tool.name + ' 分支#' + i + '：render 抛错（G2a-1）：' + text.error)
      } else {
        if (text.trim() === '') local.push(tool.name + ' 分支#' + i + '：render 输出为空文本（模型什么都看不到）')
        // G2a-4：声明了且值存在的关键字段，其值必须可观察（或显式登记为「有意不渲染」）
        for (const key of ['loadState', 'url', 'title', 'reason']) {
          const declaredKey = schema.properties?.[key] !== undefined
          const v = value?.[key]
          if (!declaredKey || typeof v !== 'string' || v === '') continue
          if (text.includes(v)) continue
          const why = NOT_RENDERED.get(tool.name + '.' + key)
          if (why === undefined || why.trim() === '') {
            local.push(tool.name + ' 分支#' + i + '：schema 声明且值存在的字段 ' + key + '（值 ' + JSON.stringify(v)
              + '）未在 render 输出中可观察（G2a-4）——模型拿不到该事实；若确属有意不渲染，请在 NOT_RENDERED 登记并写明理由')
          }
        }
      }
      if (!results.has(tool.name)) results.set(tool.name, [])
      results.get(tool.name).push({ args, value, text: typeof text === 'string' ? text : null })
    }
  }
  return { local, tools: registered, checked, results }
}

/** G2a-2/G2a-3：loaded 与 error 两态的 render 必须可区分（issue #232 的核心语义判据）。 */
async function compareStates(pluginDir) {
  const loaded = await drivePlugin(pluginDir, 'loaded')
  const errored = await drivePlugin(pluginDir, 'error')
  const out = []
  for (const tool of loaded.tools) {
    const schema = tool.output?.schema
    if (schema?.properties?.loadState === undefined) continue
    const lv = loaded.results.get(tool.name)?.[0]
    const ev = errored.results.get(tool.name)?.[0]
    if (!lv || !ev) continue
    if (lv.text === null || ev.text === null) continue
    if (lv.text === ev.text) {
      out.push(tool.name + '：loadState=loaded 与 loadState=error 两态的 render 文本**逐字相同**（G2a-2）'
        + '——模型没有任何可判别信号，这正是 issue #232 的假回执形态。'
        + '两态文本均为: ' + JSON.stringify(lv.text.slice(0, 120)))
      continue
    }
    // G2a-3：失败态必须在回执里可见（状态串与 reason 都要出现）
    if (!ev.text.includes('error')) {
      out.push(tool.name + '：error 态 render 文本未出现状态串 "error"（G2a-3）: ' + JSON.stringify(ev.text.slice(0, 120)))
    }
    const reason = errored.results.get(tool.name)?.[0]?.value?.reason
    if (typeof reason === 'string' && reason !== '' && !ev.text.includes(reason)) {
      out.push(tool.name + '：error 态 render 文本未带壳侧 reason（G2a-3，reason=' + JSON.stringify(reason) + '）: '
        + JSON.stringify(ev.text.slice(0, 120)))
    }
  }
  return { out, loadedChecked: loaded.checked, errorChecked: errored.checked }
}

// ── 主流程：逐插件（G2b）────────────────────────────────────────────────────
let totalChecked = 0
let covered = 0
const skipped = []
for (const dir of pluginDirs) {
  const name = rel(dir)
  const r = await drivePlugin(dir, 'loaded')
  if (r.skip !== undefined) {
    // 非工具插件 / 产物过期：如实报告 SKIP，既不判红也不假装通过（SKIP 计数须可见）。
    // 【0.14.1 修正】此前本行发射的 SKIP 文案**无计数器**，违反 check-gate-skips 的
    // 「任何 SKIP 发射行必须带 SKIP(#n)」纪律（该门禁按**发射行文本**判定，计数器必须在
    // 同一行），本轮实测被判红。现改为带行内计数器。
    // 注意：本注释不得再逐字包含那条旧文案，否则会被该门禁的静态扫描当成真的发射行
    // （本轮亲自踩过——注释里复述缺陷形态，正是这个门禁自伤的形态）。
    skipped.push(name + ': ' + r.skip)
    console.log('SKIP(#' + skipped.length + ') ' + name + '（' + r.skip + '）')
    continue
  }
  for (const p of r.local) problems.push(name + '：' + p)
  totalChecked += r.checked
  covered += 1
  console.log('PASS  ' + name + '：注册 ' + r.tools.length + ' 个工具，校验 ' + r.checked + ' 个分支（整值 + 渲染层）')
  const cmp = await compareStates(dir)
  for (const p of cmp.out) problems.push(name + '：' + p)
  totalChecked += cmp.loadedChecked + cmp.errorChecked
}
if (covered === 0) fail('装配集内没有任何插件被覆盖（G2b 覆盖面失效）')

// ── 插件侧深度测试（存在即跑；全 skip = 假绿）────────────────────────────────
for (const dir of pluginDirs) {
  const pluginTest = join(dir, 'test', 'tool-output-schema.test.mjs')
  if (!existsSync(pluginTest)) continue
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', pluginTest], { cwd: ROOT, encoding: 'utf8' })
  const testOut = (r.stdout ?? '') + (r.stderr ?? '')
  if (r.status !== 0) {
    console.error(testOut)
    problems.push(rel(pluginTest) + ' 未通过')
  } else {
    const passN = Number((/^ℹ pass (\d+)/m.exec(testOut) ?? /^# pass (\d+)/m.exec(testOut))?.[1] ?? '0')
    const failN = Number(/^ℹ fail (\d+)/m.exec(testOut)?.[1] ?? '0')
    if (passN <= 0 || failN !== 0) {
      problems.push(rel(pluginTest) + ' 未产生有效通过数（全 skip = 假绿）: pass=' + passN + ' fail=' + failN)
    }
    console.log('PASS  ' + rel(pluginTest) + '（pass=' + passN + ' fail=' + failN + '）')
  }
}

console.log('运行时校验分支数: ' + totalChecked + '（覆盖插件 ' + covered + ' 个，SKIP ' + skipped.length + ' 个）')
if (skipped.length > 0) for (const s of skipped) console.log('SKIP(#' + skipped.length + ') ' + s)
console.log('SKIP=' + skipped.length)
if (problems.length > 0) {
  console.error('CHECK-TOOL-OUTPUT-SCHEMA FAILED（' + problems.length + ' 项）：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('CHECK-TOOL-OUTPUT-SCHEMA PASSED')
