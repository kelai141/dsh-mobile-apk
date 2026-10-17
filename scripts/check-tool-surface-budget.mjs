#!/usr/bin/env node
// check-tool-surface-budget.mjs — 模型面工具 wire 预算门禁（0.14.0 §4.1 第一步）
//
// 模型面每轮会话都要携带全部 model-facing 工具的 name/description/parameters（引擎侧
// dsh/packages/core/tools/src/index.ts:1240-1257 的 projection 明确只上行这三项）。工具面
// 无节制增长 = 每会话固定烧掉数千 token。本门禁不靠静态扫源码，而是**真跑各插件 apply()**：
// 用桩 ctx 捕获 `ctx.tools.register(def)`，对每个 def 计算 JSON.stringify({name,description,
// parameters}) 的 UTF-8 字节数，汇总与基线比较，超阈值即拒。
//
// 用法：
//   node scripts/check-tool-surface-budget.mjs             # 门禁（超阈值 exit 1）
//   node scripts/check-tool-surface-budget.mjs --report    # 只打印分量明细
//   node scripts/check-tool-surface-budget.mjs --update    # 用当前实测重写基线（人工确认后）
//
// 退出码：0 = 通过；1 = 超预算或运行失败。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const reportOnly = argv.includes('--report')
const update = argv.includes('--update')
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const fail = (msg) => { console.error('CHECK-TOOL-SURFACE-BUDGET FAILED：' + msg); process.exit(1) }

/** 模型面工具名空间：只统计这些插件注册的工具。 */
const PLUGINS = [
  'dsh-android-bridge',
  'dsh-android-manage',
  'dsh-android-browser',
  'dsh-android-vdisplay',
  'dsh-android-file-open',
  'dsh-android-linux-env',
]

/** 预算：字节 + 允许的相对漂移；基线文件由 --update 生成。 */
const BASELINE_FILE = join(HERE, 'tool-surface-budget.json')

/** 递归桩：任意属性返回可调用桩，任意调用返回桩（不抛、不真执行）。 */
function makeStub() {
  const target = function () { return makeStub() }
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => ''
      if (prop === Symbol.iterator) return function* () {}
      return makeStub()
    },
    set() { return true },
    apply() { return makeStub() },
  })
}

/** 采集一个插件注册的模型面工具。 */
async function collect(plugin) {
  const lib = join(ROOT, 'plugins', plugin, 'lib', 'index.js')
  if (!existsSync(lib)) fail('构建产物缺席：' + rel(lib) + '\n  先构建：cd plugins/' + plugin + ' && npm install && npm run build')
  const mod = await import(pathToFileURL(lib).href)
  if (typeof mod.apply !== 'function') fail(rel(lib) + ' 未导出 apply()')
  const tools = []
  const base = {
    tools: {
      register(definition) {
        if (definition && typeof definition.name === 'string') tools.push(definition)
        return () => {}
      },
      restrict() { return () => {} },
      presentAs() { return () => {} },
      get() { return undefined },
      view() { return { visible: new Map(), restrictableNames: new Set() } },
    },
    effect(callback) { try { const r = callback(); return typeof r === 'function' ? r : () => {} } catch { return () => {} } },
    get() { return makeStub() },
    on() { return () => {} },
    logger: makeStub(),
  }
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return makeStub()
    },
  })
  mod.apply(ctx, {})
  return tools
}

function wireBytes(definition) {
  const projected = {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
  }
  // 与 handoff §4.1 的口径一致：JSON.stringify 结果的 UTF-16 码元数（中文字符计 1）。
  // 任何单一数字都只是「模型面固定开销」的代理量，用于防回归而非精确 token 计量。
  return JSON.stringify(projected).length
}

const perPlugin = {}
const perTool = []
let total = 0
const allNames = []
for (const plugin of PLUGINS) {
  const tools = await collect(plugin)
  let bytes = 0
  for (const tool of tools) {
    const size = wireBytes(tool)
    bytes += size
    allNames.push(tool.name)
    perTool.push({ plugin, name: tool.name, bytes: size })
  }
  perPlugin[plugin] = { count: tools.length, bytes }
  total += bytes
}

const duplicates = allNames.filter((n, i) => allNames.indexOf(n) !== i)
if (duplicates.length > 0) fail('模型面工具名重复：' + [...new Set(duplicates)].join('、'))

// ── 初始可见集口径（0.14.0 §4.1 渐进披露）────────────────────────────────────
// 上面的 total 是「插件注册集」= 解锁后的上限；渐进披露后模型**第一眼**只看得到
// 未被 capability gate 掩蔽的工具（外加常驻 facade）。两个口径都要守：只守注册集会漏掉
// 「解锁后工具面膨胀」，只守初始集则会漏掉「掩蔽组本身无限长胖」。
// 掩蔽组名单**从实现导出**（plugins/dsh-android-bridge 的 capability-gate），不在此另写一份——
// 否则门禁与实现漂移时门禁会假绿。
async function readMaskedGroups() {
  const lib = join(ROOT, 'plugins', 'dsh-android-bridge', 'lib', 'index.js')
  if (!existsSync(lib)) fail('构建产物缺席：' + rel(lib) + '\n  先构建：cd plugins/dsh-android-bridge && npm install && npm run build')
  const mod = await import(pathToFileURL(lib).href)
  const groups = mod.DEVICE_TOOL_GROUPS
  const facade = mod.CAPABILITY_TOOL_NAME
  if (groups === undefined || typeof groups !== 'object') {
    fail('capability-gate 未导出 DEVICE_TOOL_GROUPS（门禁无法推导初始可见集）')
  }
  if (typeof facade !== 'string' || facade === '') {
    fail('capability-gate 未导出 CAPABILITY_TOOL_NAME')
  }
  return { masked: new Set(Object.values(groups).flat()), groups, facade }
}
const { masked, groups: groupMap, facade } = await readMaskedGroups()
const initialTools = perTool.filter((t) => !masked.has(t.name))
const initialTotal = initialTools.reduce((sum, t) => sum + t.bytes, 0)
// 常驻 facade 必须在初始可见集里（否则模型没有任何入口去解锁能力组 = 设备能力全灭）。
if (!initialTools.some((t) => t.name === facade)) {
  fail('常驻 facade 不在初始可见集：' + facade + '（渐进披露后面模型无法解锁任何设备能力组）')
}
// 掩蔽组名必须真实存在于注册集：组名单漂移（改了实现没改清单）即失败，防「掩蔽了个不存在的名字」。
const unknownMasked = [...masked].filter((n) => !allNames.includes(n))
if (unknownMasked.length > 0) {
  fail('掩蔽清单里有未注册的工具名（组名单与实现漂移）：' + unknownMasked.slice(0, 8).join('、')
    + (unknownMasked.length > 8 ? ' 等 ' + unknownMasked.length + ' 个' : ''))
}
const measured = {
  baseline: total, perPlugin, initialVisible: initialTotal,
  maskedGroups: Object.keys(groupMap),
  /* G-3 的名字级判定记录：只守字节数会漏「塞进一个很小的新工具」——字节没涨过阈值，但模型
   * 第一眼多看见一个面。可见集逐名登记后，任何新增可见工具都必须过一次评审（--update 才会改）。 */
  visibleTools: initialTools.map((t) => t.name).sort(),
}

if (update) {
  writeFileSync(BASELINE_FILE, JSON.stringify(measured, null, 2) + '\n')
  console.log('已写入基线 ' + rel(BASELINE_FILE) + '：注册集 ' + total + ' B / 初始可见集 ' + initialTotal + ' B')
  process.exit(0)
}

if (reportOnly) {
  printReport()
  process.exit(0)
}

if (!existsSync(BASELINE_FILE)) {
  fail('缺少基线文件 ' + rel(BASELINE_FILE) + '（先运行 --update 并在评审中确认）')
}
const baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
const baselineBytes = typeof baseline.baseline === 'number' ? baseline.baseline : 0
if (baselineBytes <= 0) fail('基线文件缺少数字 baseline：' + rel(BASELINE_FILE))
const baselineInitial = typeof baseline.initialVisible === 'number' ? baseline.initialVisible : -1
if (baselineInitial < 0) {
  fail('基线文件缺少数字 initialVisible：' + rel(BASELINE_FILE)
    + '（渐进披露口径基线；运行 --update 重出后提交评审）')
}

// 阈值：允许 ±2% 漂移（工具文案微调），超过即视为工具面回归（新增工具必须显式更新基线并评审）。
const limit = Math.floor(baselineBytes * 1.02)
const limitInitial = Math.floor(baselineInitial * 1.02)
printReport()
console.log('预算（注册集 = 解锁后上限）：基线 ' + baselineBytes + ' B，阈值 ' + limit + ' B（+2%）')
console.log('预算（初始可见集 = 模型第一眼，§4.1 渐进披露后）：基线 ' + baselineInitial + ' B，阈值 ' + limitInitial + ' B（+2%）')
if (total > limit) {
  fail('模型面 wire 超预算（注册集）：实测 ' + total + ' B > 阈值 ' + limit + ' B\n'
    + '  新增工具或放大了 description/parameters；请合并/收敛工具面，或经评审后 --update 基线')
}
if (initialTotal > limitInitial) {
  fail('模型面 wire 超预算（初始可见集）：实测 ' + initialTotal + ' B > 阈值 ' + limitInitial + ' B\n'
    + '  初始工具表膨胀 = 每会话固定开销上涨（渐进披露的目的就是压低这一项）；'
    + '请把新工具归入能力组受掩蔽，或经评审后 --update 基线')
}
// 名字级：初始可见集 == 登记集（多一名 = 新工具未经判定就暴露在模型第一眼；少一名 = 已登记的工具
// 不再注册，要么实现被删要么被误归入掩蔽组）。掩蔽侧的方向（名单里的名字必须真注册）在 :149 已守。
const baselineVisible = Array.isArray(baseline.visibleTools) ? baseline.visibleTools : null
if (baselineVisible === null) {
  fail('基线缺 visibleTools 名单（G-3 名字级判定记录）：跑 --update 后把 diff 拿去评审')
} else {
  const nowVisible = initialTools.map((t) => t.name).sort()
  const newlyVisible = nowVisible.filter((n) => !baselineVisible.includes(n))
  const noLongerVisible = baselineVisible.filter((n) => !nowVisible.includes(n))
  if (newlyVisible.length > 0) {
    fail('模型第一眼新增工具（未经判定）：' + newlyVisible.join('、')
      + '\n  要么归入 capability gate 的能力组（默认掩蔽、按授权解锁），要么经评审后 --update 基线。'
      + '\n  注意：往 DEVICE_TOOL_GROUPS 加名字不算「判定完成」——那只是把它藏起来，解锁面要单独想。')
  }
  if (noLongerVisible.length > 0) {
    fail('已登记的可见工具不再注册：' + noLongerVisible.join('、')
      + '（实现被删？还是被归进掩蔽组？两者都是产品面变更，必须显式确认）')
  }
  if (newlyVisible.length === 0 && noLongerVisible.length === 0) {
    console.log('  可见集名单 == 登记（' + nowVisible.length + ' 名：' + nowVisible.join(', ') + '）')
  }
}

console.log('CHECK-TOOL-SURFACE-BUDGET PASSED（注册集 ' + total + ' B / 基线 ' + baselineBytes + ' B；'
  + '初始可见集 ' + initialTotal + ' B / 基线 ' + baselineInitial + ' B）')
process.exit(0)

function printReport() {
  const rows = Object.entries(perPlugin).sort((a, b) => b[1].bytes - a[1].bytes)
  console.log('模型面工具 wire 分量（JSON.stringify({name,description,parameters}) UTF-8 字节）：')
  for (const [plugin, value] of rows) {
    console.log('  ' + plugin.padEnd(24) + String(value.count).padStart(3) + ' 个  ' + String(value.bytes).padStart(6) + ' B')
  }
  console.log('  ' + '合计'.padEnd(22) + String(allNames.length).padStart(3) + ' 个  ' + String(total).padStart(6) + ' B')
  console.log('  ' + '（初始可见集'.padEnd(21) + String(initialTools.length).padStart(3) + ' 个  ' + String(initialTotal).padStart(6) + ' B；'
    + '被 capability gate 掩蔽 ' + (allNames.length - initialTools.length) + ' 个，组 = ' + Object.keys(groupMap).join('/') + '）')
  if (argv.includes('--detail')) {
    for (const tool of [...perTool].sort((a, b) => b.bytes - a.bytes)) {
      console.log('    ' + tool.plugin.padEnd(24) + tool.name.padEnd(28) + String(tool.bytes).padStart(6) + ' B')
    }
  }
}
