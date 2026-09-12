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
//      注册集合不变时硬编码名单照绿（独立复核指出的设计缺陷）。
//
// 用法：node scripts/check-tool-output-schema.mjs [--plugin <插件目录>] [--engine-tools <dsh-tools 目录或 lib 文件>]
//   --plugin/--engine-tools 仅用于反向验证的合成夹具；正常门禁无参运行。
// 退出码：0 = 通过；1 = 契约破坏（拒打包/拒合）。
import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const fail = (msg) => { console.error('CHECK-TOOL-OUTPUT-SCHEMA FAILED：' + msg); process.exit(1) }

const PLUGIN = argOf('plugin') ? argOf('plugin') : join(ROOT, 'plugins', 'dsh-android-manage')
const SRC_DIR = join(PLUGIN, 'src')
const LIB_DIR = join(PLUGIN, 'lib')
const LIB = join(LIB_DIR, 'index.js')
const SRC = join(SRC_DIR, 'index.ts')

// ── 1. lib/ 时效 ────────────────────────────────────────────────────────────
if (!existsSync(SRC)) fail('源文件缺席：' + SRC)
if (!existsSync(LIB)) fail('构建产物缺席：' + LIB + '\n  先构建：cd ' + rel(PLUGIN) + ' && npm install && npm run build')
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
const s = newest(SRC_DIR, '.ts')
const l = newest(LIB_DIR, '.js')
if (s.ms > l.ms) {
  fail('构建产物过期：src/' + s.file + ' 比 lib/' + l.file + ' 新\n'
    + '  先构建：cd ' + rel(PLUGIN) + ' && npm run build（旧产物判绿 = 假绿）')
}
console.log('PASS  lib/ 不比 src/ 旧（src/' + s.file + ' vs lib/' + l.file + '）')

// ── 引擎同一校验器 ──────────────────────────────────────────────────────────
const toolsPkg = argOf('engine-tools')
const validatorCandidates = []
if (toolsPkg) validatorCandidates.push(toolsPkg.endsWith('.js') ? toolsPkg : join(toolsPkg, 'lib', 'index.js'))
validatorCandidates.push(join(PLUGIN, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
validatorCandidates.push(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
const validatorFile = validatorCandidates.find((p) => existsSync(p))
if (!validatorFile) {
  fail('找不到引擎校验器 @deepseek-ai/dsh-tools/lib/index.js（与引擎同一函数，不得自造）\n'
    + '  候选：' + validatorCandidates.map(rel).join('、') + '\n'
    + '  先跑：cd ' + rel(PLUGIN) + ' && npm install')
}
const { validateJsonSchemaValue } = await import(pathToFileURL(validatorFile).href)
if (typeof validateJsonSchemaValue !== 'function') fail('@deepseek-ai/dsh-tools 未导出 validateJsonSchemaValue（' + rel(validatorFile) + '）')
console.log('校验器: ' + rel(validatorFile))

// ── 运行时注册（E-10：跑真工具，不做静态提取）────────────────────────────────
const mod = await import(pathToFileURL(LIB).href)
const registered = []
const a11yOnly = process.env.DSH_SCHEMA_FORCE_ADB !== '1'
const calls = { control: [], adb: [] }
const face = {
  gateFor: () => ({ ok: true, via: 'a11y' }),
  audit: () => {},
  controlDecision: (_op, _s, force) => (force === 'adb' && a11yOnly
    ? { backend: 'deny', reason: 'ADB 三道人门未齐（门禁夹具）', guidance: '（夹具：无线调试未配对）' }
    : { backend: 'a11y', reason: 'a11y' }),
  controlExec: async (op) => {
    calls.control.push(op)
    if (op === 'snapshot') {
      return { ok: true, data: { gen: 7, rotation: 0, screen: { w: 1080, h: 2400 }, nodes: [
        { id: '0', parentId: '', attrs: { bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false', scrollable: 'false', editable: 'false', text: '', 'content-desc': '' } },
        { id: '0.0', parentId: '0', attrs: { bounds: '[100,200][500,320]', class: 'android.widget.Button', clickable: 'true', scrollable: 'false', editable: 'false', text: '设置', 'content-desc': '', 'resource-id': 'com.x:id/btn' } },
      ] } }
    }
    if (op === 'state') return { ok: true, data: { gen: 7, invalidated: false } }
    if (op === 'webSnapshot') return { ok: true, data: { gen: 7, rotation: 0, screen: { w: 1080, h: 2400 }, nodes: [] } }
    if (op === 'nodeText') return { ok: true, data: { text: '设置' } }
    return { ok: true, data: {} }
  },
  execAdbShell: async (c) => { calls.adb.push(c); return { ok: false, stdout: '', guidance: 'ADB 未授权（夹具）' } },
  execAdbLine: async (c) => { calls.adb.push(c); return { ok: false, stdout: '', guidance: 'ADB 未授权（夹具）' } },
}
const ctx = {
  logger: () => ({ warn: () => {}, debug: () => {}, info: () => {}, error: () => {} }),
  tools: { register: (t) => registered.push(t) },
  androidPrivilege: face,
  get: () => undefined,
  effect: (fn) => { try { return fn?.() } catch { return undefined } },
  on: () => {},
}
try {
  await mod.apply(ctx)
} catch (e) {
  fail('插件 apply() 抛错（运行时夹具无法建立）：' + (e && e.message))
}
if (registered.length === 0) fail('运行时没有注册任何工具（apply 形态可能已变）')
console.log('运行时注册 ' + registered.length + ' 个工具：' + registered.map((t) => t.name).join(', '))

const problems = []

// ── 4. 源码级注册完整性（差集 = 0）──────────────────────────────────────────
const srcText = readFileSync(SRC, 'utf8')
const declared = new Set([...srcText.matchAll(/defineTool\(\{\s*\n?\s*name:\s*'([^']+)'/g)].map((m) => m[1]))
if (declared.size === 0) fail('源码级 defineTool({name}) 解析为空（形态可能已变）')
const registeredNames = new Set(registered.map((t) => t.name))
const notRegistered = [...declared].filter((n) => !registeredNames.has(n))
const notDeclared = [...registeredNames].filter((n) => !declared.has(n))
if (notRegistered.length > 0) {
  problems.push('defineTool 了但没进 tools() 注册集合（工具是死代码，提示文案还在引导模型去调它）: ' + notRegistered.join(', '))
}
if (notDeclared.length > 0) {
  problems.push('运行时注册了源码没有 defineTool 的工具（来源不明）: ' + notDeclared.join(', '))
}
if (notRegistered.length === 0 && notDeclared.length === 0) {
  console.log('PASS  源码 defineTool 名集合 == 运行时注册名集合（' + declared.size + ' 项，差集 0）')
}

// ── 2/3. 逐工具、逐分支：整值校验 + 递归 undefined ──────────────────────────
const SAMPLE = {
  string: 'sample', number: 1, integer: 1, boolean: false, array: [], object: {},
}
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
    // 两种方言：defineTool 归一化后是 `required: ['x']` 数组，源码方言是属性上的 `required: true`。
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
}
const hasUndefined = (value, path, out) => {
  if (value === undefined) { out.push(path); return }
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach((v, i) => hasUndefined(v, path + '[' + i + ']', out)); return }
  for (const [k, v] of Object.entries(value)) hasUndefined(v, path + '.' + k, out)
}
let checked = 0
for (const tool of registered) {
  const schema = tool.output?.schema
  if (!schema) { problems.push(tool.name + '：未声明 output.schema（引擎整值校验无从成立）'); continue }
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    problems.push(tool.name + '：output.schema 不自洽（要求 type=object + additionalProperties=false，实际 type='
      + JSON.stringify(schema.type) + ' additionalProperties=' + JSON.stringify(schema.additionalProperties) + '）')
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
      problems.push(tool.name + ' 分支#' + i + ' execute 抛错（工具必须返回错误对象而非抛异常）：' + (e && e.message))
      continue
    }
    checked += 1
    const violations = validateJsonSchemaValue(schema, value, 'value') ?? []
    for (const v of violations) problems.push(tool.name + ' 分支#' + i + '：' + (typeof v === 'string' ? v : JSON.stringify(v)))
    const undef = []
    hasUndefined(value, 'value', undef)
    if (undef.length > 0) problems.push(tool.name + ' 分支#' + i + '：返回值含 undefined 成员（' + undef.join(', ') + '）')
  }
}

// ── 插件侧深度测试（T1 交付的 test/tool-output-schema.test.mjs；存在即跑）─────
const pluginTest = join(PLUGIN, 'test', 'tool-output-schema.test.mjs')
if (existsSync(pluginTest)) {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, ['--test', pluginTest], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error((r.stdout ?? '') + (r.stderr ?? ''))
    problems.push('插件侧 test/tool-output-schema.test.mjs 未通过')
  } else {
    const summary = (r.stdout ?? '').split('\n').filter((x) => /^ℹ (tests|pass|fail)/.test(x)).join('  ')
    console.log('PASS  插件侧 test/tool-output-schema.test.mjs' + (summary ? '（' + summary + '）' : ''))
  }
} else {
  console.log('INFO  插件侧 test/tool-output-schema.test.mjs 尚未交付（T1 依赖，非本门禁阻塞项）')
}

console.log('运行时校验分支数: ' + checked)
if (problems.length > 0) {
  console.error('CHECK-TOOL-OUTPUT-SCHEMA FAILED（' + problems.length + ' 项）：')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('CHECK-TOOL-OUTPUT-SCHEMA PASSED')
