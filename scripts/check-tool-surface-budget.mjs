#!/usr/bin/env node
// check-tool-surface-budget.mjs — 模型面工具 wire 预算门禁（0.14.0 §4.1 第一步）
//
// 模型面每轮会话都要携带全部 model-facing 工具的 name/description/parameters（引擎侧
// dsh/packages/core/tools/src/index.ts:1240-1257 的 projection 明确只上行这三项）。工具面
// 无节制增长 = 每会话固定烧掉数千 token。本门禁不靠静态扫源码，而是**真跑各插件 apply()**：
// 用桩 ctx 捕获 `ctx.tools.register(def[, opts])`，对每个 def 计算 JSON.stringify({name,
// description,parameters}) 的 UTF-16 码元数，汇总与基线比较，超阈值即拒。
//
// 两个口径（native 控制切流后改写，2026-11）：
//   - **注册集**（unlocked / 全部）= 每次 apply 实际注册的工具总和，含条件注册；
//   - **常驻集**（always-on）= 不带 `when` 条件的注册，模型每一步都能看到。
// 旧实现第二个口径读 bridge 的 `DEVICE_TOOL_GROUPS`（capability gate 掩蔽组）。切流后
// 手机工具改由 dsh-android-phone-control 注册，可用性由**原生能力**在每步判定（`when`
// 条件读 nativeControlCapabilities），bridge 只剩共享浏览器与通知，不再导出掩蔽组。
// 门禁因此改成读真实注册形态：`when` 在场 = 条件注册（原生决定这一步是否出现），
// 不在场 = 常驻。这样语义来自实现本身，门禁不另写一份名单。
//
// 用法：
//   node scripts/check-tool-surface-budget.mjs             # 门禁（超阈值 exit 1）
//   node scripts/check-tool-surface-budget.mjs --report    # 只打印分量明细
//   node scripts/check-tool-surface-budget.mjs --update    # 用当前实测重写基线（人工确认后）
//   node scripts/check-tool-surface-budget.mjs --root <dir> # 只给测试用：把插件树与基线换成临时目录
//
// 退出码：0 = 通过；1 = 超预算或运行失败。
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PLUGINS } from './lib/tool-surface-plugins.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
/** `--root <dir>` 只给测试用（把插件树与基线换成临时目录）；正常门禁不变。 */
const rootArgIdx = argv.indexOf('--root')
const ROOT = rootArgIdx >= 0 ? argv[rootArgIdx + 1] : dirname(HERE)
const reportOnly = argv.includes('--report')
const update = argv.includes('--update')
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const fail = (msg) => { console.error('CHECK-TOOL-SURFACE-BUDGET FAILED：' + msg); process.exit(1) }

/** 预算：字节 + 允许的相对漂移；基线文件由 --update 生成。 */
const BASELINE_FILE = join(ROOT, 'scripts', 'tool-surface-budget.json')

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

/**
 * 采集一个插件注册的模型面工具。
 *
 * `conditional` 的判据是**第二个参数里有没有 `when`**：这是宿主真正据以在每一步决定
 * 「这个工具今天出不出现」的钩子。门禁不去猜插件内部逻辑，只看最终注册形态。
 */
async function collect(plugin) {
  const lib = join(ROOT, 'plugins', plugin, 'lib', 'index.js')
  if (!existsSync(lib)) fail('构建产物缺席：' + rel(lib) + '\n  先构建：cd plugins/' + plugin + ' && npm install && npm run build')
  const mod = await import(pathToFileURL(lib).href)
  if (typeof mod.apply !== 'function') fail(rel(lib) + ' 未导出 apply()')
  const tools = []
  const base = {
    tools: {
      register(definition, options) {
        if (definition && typeof definition.name === 'string') {
          tools.push({ definition, conditional: options !== undefined && options !== null && options.when !== undefined })
        }
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
    const size = wireBytes(tool.definition)
    const name = tool.definition.name
    bytes += size
    allNames.push(name)
    perTool.push({ plugin, name, bytes: size, conditional: tool.conditional })
  }
  perPlugin[plugin] = {
    count: tools.length,
    bytes,
    conditional: tools.filter((t) => t.conditional).length,
  }
  total += bytes
}

const duplicates = allNames.filter((n, i) => allNames.indexOf(n) !== i)
if (duplicates.length > 0) fail('模型面工具名重复：' + [...new Set(duplicates)].join('、'))

// ── 常驻集口径 ───────────────────────────────────────────────────────────────
// 注册集 = 上界（真正会出现的工具全集）；常驻集 = 模型每一步都能看到的那部分。
// 两个口径都要守：只守注册集会漏掉「条件注册被写成了常驻」（每步固定开销上涨），
// 只守常驻集则会漏掉「条件分支里的工具无限长胖」。
const conditionalTools = perTool.filter((t) => t.conditional)
const initialTools = perTool.filter((t) => !t.conditional)
const initialTotal = initialTools.reduce((sum, t) => sum + t.bytes, 0)

const unknown = []
if (initialTools.length === 0) {
  fail('常驻集为空：所有工具都成了条件注册，模型每一步都看不到任何手机/浏览器工具面')
}
// 条件注册必须真的挂在手机控制插件上——否则「条件」只是绕过常驻集口径的写法。
for (const tool of conditionalTools) {
  if (tool.plugin !== 'dsh-android-phone-control') unknown.push(tool.plugin + ':' + tool.name)
}
if (unknown.length > 0) {
  fail('条件注册出现在手机控制插件之外（原生化后的可用性判定只由原生能力驱动）：' + unknown.slice(0, 8).join('、'))
}

const measured = {
  baseline: total,
  perPlugin,
  initialVisible: initialTotal,
  /** 条件注册的工具名：由原生能力在每步判定是否出现，不占常驻开销。 */
  conditionalTools: conditionalTools.map((t) => t.name).sort(),
  /**
   * 手机控制插件的工具清单（按名字排序）。
   *
   * 为什么要逐名登记而不是只记数量：数量相同但**换了工具**同样是产品面变更（例如把 IME 输入
   * 换成原生 keyEvent），只守计数会静默放行。清单与 baseline/visibleTools 一样，改一次就要过一次
   * 评审（--update 才会刷新）。
   */
  phoneTools: perTool.filter((t) => t.plugin === 'dsh-android-phone-control').map((t) => t.name).sort(),
  /* G-3 的名字级判定记录：只守字节数会漏「塞进一个很小的新工具」——字节没涨过阈值，但模型
   * 第一眼多看见一个面。常驻集逐名登记后，任何新增常驻工具都必须过一次评审（--update 才会改）。 */
  visibleTools: initialTools.map((t) => t.name).sort(),
}

if (update) {
  // 历史锚定：旧基线写进 history 再被新值取代。任何一次抬升都在文件里留痕，
  // 让「为了通过而改基线」在 diff 里无处可藏。
  const previous = existsSync(BASELINE_FILE)
    ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
    : {}
  const history = Array.isArray(previous.history) ? previous.history : []
  if (typeof previous.baseline === 'number' && previous.baseline !== measured.baseline) {
    history.push({
      baseline: previous.baseline,
      initialVisible: previous.initialVisible,
      at: new Date().toISOString().slice(0, 10),
      note: 'superseded by --update',
    })
  }
  writeFileSync(BASELINE_FILE, JSON.stringify({ ...measured, history }, null, 2) + '\n')
  console.log('已写入基线 ' + rel(BASELINE_FILE) + '：注册集 ' + total + ' B / 常驻集 ' + initialTotal + ' B')
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
    + '（常驻集口径基线；运行 --update 重出后提交评审）')
}
// 历史锚定不得被抹掉：基线文件里的历史值只许追加，不许删（删了就等于「历史上从没更贵过」）。
const history = Array.isArray(baseline.history) ? baseline.history : []
if (history.length === 0) {
  fail('基线缺 history：工具面基线的历史值必须留痕（退役带来的下降要能看出「历史更贵过」）。'
    + '\n  旧口径基线是 ' + baselineBytes + ' B 这一代之前没有 history 字段时可接受的例外；'
    + '但既然本文件已经带 history，删掉它就是抹审计痕迹。')
}

// 阈值：允许 ±2% 漂移（工具文案微调），超过即视为工具面回归（新增工具必须显式更新基线并评审）。
const limit = Math.floor(baselineBytes * 1.02)
const limitInitial = Math.floor(baselineInitial * 1.02)
printReport()
console.log('预算（注册集 = 全量上限）：基线 ' + baselineBytes + ' B，阈值 ' + limit + ' B（+2%）')
console.log('预算（常驻集 = 模型每一步都看到）：基线 ' + baselineInitial + ' B，阈值 ' + limitInitial + ' B（+2%）')
if (total > limit) {
  fail('模型面 wire 超预算（注册集）：实测 ' + total + ' B > 阈值 ' + limit + ' B\n'
    + '  新增工具或放大了 description/parameters；请合并/收敛工具面，或经评审后 --update 基线')
}
if (initialTotal > limitInitial) {
  fail('模型面 wire 超预算（常驻集）：实测 ' + initialTotal + ' B > 阈值 ' + limitInitial + ' B\n'
    + '  常驻工具表膨胀 = 每会话固定开销上涨；请把新工具改成条件注册（由原生能力判定），'
    + '或经评审后 --update 基线')
}
// 名字级：常驻集 == 登记集（多一名 = 新工具未经判定就常驻；少一名 = 已登记的常驻工具不再注册，
// 要么实现被删，要么被误改成条件注册）。条件注册侧的方向（登记过的名字必须真注册）见下。
const baselineVisible = Array.isArray(baseline.visibleTools) ? baseline.visibleTools : null
if (baselineVisible === null) {
  fail('基线缺 visibleTools 名单（G-3 名字级判定记录）：跑 --update 后把 diff 拿去评审')
} else {
  const nowVisible = initialTools.map((t) => t.name).sort()
  const newlyVisible = nowVisible.filter((n) => !baselineVisible.includes(n))
  const noLongerVisible = baselineVisible.filter((n) => !nowVisible.includes(n))
  if (newlyVisible.length > 0) {
    fail('模型每一步新增常驻工具（未经判定）：' + newlyVisible.join('、')
      + '\n  要么改成条件注册（由原生能力判定是否出现），要么经评审后 --update 基线。')
  }
  if (noLongerVisible.length > 0) {
    fail('已登记的常驻工具不再常驻：' + noLongerVisible.join('、')
      + '（实现被删？还是被改成条件注册？两者都是产品面变更，必须显式确认）')
  }
}
const baselineConditional = Array.isArray(baseline.conditionalTools) ? baseline.conditionalTools : null
if (baselineConditional === null) {
  fail('基线缺 conditionalTools 名单（条件注册的判定记录）：跑 --update 后把 diff 拿去评审')
} else {
  const nowConditional = conditionalTools.map((t) => t.name).sort()
  const added = nowConditional.filter((n) => !baselineConditional.includes(n))
  const gone = baselineConditional.filter((n) => !nowConditional.includes(n))
  if (added.length > 0) {
    fail('新增条件注册工具（未经判定）：' + added.join('、')
      + '\n  新工具要么常驻、要么由原生能力判定；两者都要过一次评审再 --update 基线。')
  }
  if (gone.length > 0) {
    fail('已登记的条件注册工具不再注册：' + gone.join('、')
      + '（原生不再提供该操作？还是被误删？必须显式确认）')
  }
}
const baselinePhone = Array.isArray(baseline.phoneTools) ? baseline.phoneTools : null
if (baselinePhone === null) {
  fail('基线缺 phoneTools 清单（手机工具面逐名判定记录）：跑 --update 后把 diff 拿去评审')
} else {
  const nowPhone = measured.phoneTools
  const added = nowPhone.filter((n) => !baselinePhone.includes(n))
  const removed = baselinePhone.filter((n) => !nowPhone.includes(n))
  if (added.length > 0 || removed.length > 0) {
    fail('手机工具面变更未登记（新增 ' + (added.join('、') || '无') + '；移除 ' + (removed.join('、') || '无') + '）'
      + '\n  工具数量相同也可能换了工具（例如 IME 输入改原生 keyEvent）；确认后跑 --update 并评审 diff。')
  }
}

console.log('CHECK-TOOL-SURFACE-BUDGET PASSED（注册集 ' + total + ' B / 基线 ' + baselineBytes + ' B；'
  + '常驻集 ' + initialTotal + ' B / 基线 ' + baselineInitial + ' B）')
process.exit(0)

function printReport() {
  const rows = Object.entries(perPlugin).sort((a, b) => b[1].bytes - a[1].bytes)
  console.log('模型面工具 wire 分量（JSON.stringify({name,description,parameters}) UTF-16 码元数）：')
  for (const [plugin, value] of rows) {
    console.log('  ' + plugin.padEnd(26) + String(value.count).padStart(3) + ' 个  '
      + String(value.bytes).padStart(6) + ' B（条件 ' + value.conditional + '）')
  }
  console.log('  ' + '合计'.padEnd(24) + String(allNames.length).padStart(3) + ' 个  ' + String(total).padStart(6) + ' B')
  console.log('  ' + '（常驻集'.padEnd(23) + String(initialTools.length).padStart(3) + ' 个  '
    + String(initialTotal).padStart(6) + ' B；条件注册 ' + conditionalTools.length + ' 个，由原生能力判定）')
  if (argv.includes('--detail')) {
    for (const tool of [...perTool].sort((a, b) => b.bytes - a.bytes)) {
      console.log('    ' + tool.plugin.padEnd(26) + tool.name.padEnd(30) + String(tool.bytes).padStart(6) + ' B'
        + (tool.conditional ? '  条件' : ''))
    }
  }
}
