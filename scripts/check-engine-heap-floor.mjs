#!/usr/bin/env node
// check-engine-heap-floor.mjs — 引擎 V8 堆下限的**双源一致性**门禁（0.14.8）
//
// 背景（本缺陷：社区反馈「JavaScript 堆太小导致引擎启动失败」）：
// 修法是给引擎一个显式、可自适应的 V8 老生代下限，而**注入点有两个**：
//   ① 壳侧 EngineManager.shellEnv() 的 NODE_OPTIONS（覆盖引擎 + 经 shellEnv 派生的子进程）；
//   ② 快照内启动器 usr/libexec/dsh-node（覆盖**过滤 env** 的调用方，如 PTC 只放 6 个环境变量）。
// 两个源必须表达**同一个下限**。任何一方单独漂移都会造出「有的路径够用、有的路径还是很小」
// 这种最难查的形态：引擎起来了、`code run` 却仍然 OOM，而两处代码看上去都对。
//
// 判据（每条都可判红）：
//   A. 壳侧两个常量必须存在且为正值（512 / 4096），取值必须走 clamp 而不是裸除法；
//   B. 启动器必须在**设备上**按 MemTotal 自适应、且 clamp 到同一区间；
//   C. A 与 B 的上下限数字必须**逐值相等**（本门禁的核心判据）；
//   D. 启动器不得覆盖调用方已设置的 NODE_OPTIONS（显式值优先于默认值）；
//   E. 引擎 argv 不得出现堆标志（argv 会覆盖 NODE_OPTIONS，双来源必冲突）。
//
// 用法：node scripts/check-engine-heap-floor.mjs [--self-test]
//   --self-test  判别力自检：用合成样本（含故意做坏的样本）证明本门禁仍会判红，
//                不需要真实仓库状态。
// 退出码：0 = 通过；1 = 有失败项。
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { stripComments } from './lib/strip-comments.mjs'
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SELF_TEST = process.argv.includes("--self-test")
// --require（构建/发布链严格档）：输入缺席不得以 SKIP 结案。本门禁的两个输入都在仓内，
// 正常不缺席；该开关是为「文件被误删/路径漂移」时不至于静默跳过而留的收口。
const REQUIRE = process.argv.includes("--require")
let skipped = 0

const KOTLIN_REL = "app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt"
const WRAPPER_REL = "scripts/build-snapshot-013.mjs"

let failures = 0
const fail = (msg) => { failures += 1; console.log("FAIL  " + msg) }
const pass = (msg) => console.log("PASS  " + msg)
const skip = (msg) => { skipped += 1; console.log("SKIP(#" + skipped + ")  " + msg) }

/**
 * 从生成器 JS 里抽出嵌入的 shell 脚本，并剥掉 shell 注释（issue #1191）。
 *
 * 为什么需要单独一层：启动器不是独立 .sh 文件，而是 `build-snapshot-013.mjs` 里的
 * `+ '<shell 行>\n'` 字符串拼接。整份 JS 交给 JS 注释剥离器时，字符串字面量会被**原样保留**
 * —— 于是「把 shell 行注释掉」这个动作在 JS 层面看不见，判据仍然命中。
 *
 * 抽取：匹配 `+ '...'\n'` 形态（本仓实测 16 处），拼成完整 shell 文本。
 * 剥注释：按 shell 口径（`#` 行注释）走状态机，引号内的 `#` 不误判。
 *
 * 抽不到任何片段时退回「整份原文剥 JS 注释」：这样至少不会比旧实现更差，
 * 且调用方（自检）会覆盖抽取路径。
 *
 * @param {string} jsSrc 生成器 JS 源码
 * @returns {string} shell 代码面（注释已抹空）
 */
export function shellCodeOf(jsSrc) {
  // 只扫 `writeFileSync(...)` 那段拼接区，避免把整个生成器里无关的单引号字符串都算进来。
  // 形态有两种（实测都出现）：
  //   + 'export NODE_OPTIONS="--max-old-space-size=$__dsh_heap"\n'        （纯字面量）
  //   + 'export LD_LIBRARY_PATH="' + NEW_PREFIX + '/lib"\n'                 （中间插值）
  // 后者必须把插值两侧的片段都算进来，否则 'export LD_LIBRARY_PATH="' 会被漏掉。
  const start = jsSrc.indexOf('PTC_NODE_WRAPPER_REL')
  const region = start >= 0 ? jsSrc.slice(start, start + 8000) : jsSrc
  const parts = [...region.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
  if (parts.length === 0) return stripComments(jsSrc, { mode: 'c' })
  const shell = parts.join('\n')
  return stripComments(shell, { mode: 'powershell' })
}

/**
 * 从 `marker` 之后扫出**括号配平**的参数区（issue #1191 洞二）。
 *
 * 为什么不用正则惰性量词：`arrayOf\(([\s\S]{0,400}?)\)` 在第一个 `)` 就收尾，
 * 而 `bindPort.toString()` 里就有个 `)` —— 窗口在目标内容之前结束，之后追加的东西全看不见。
 *
 * 字符串字面量里的括号必须跳过，否则 `"foo)"` 会提前收尾（同一个坑换一种形态）。
 *
 * @param {string} src 源码（调用方负责先剥注释）
 * @param {string} marker 起始标记（如 'arrayOf('）
 * @returns {string|null} 括号内的原文；找不到标记或括号不配平时返回 null
 */
export function balancedArgs(src, marker) {
  const at = src.indexOf(marker)
  if (at < 0) return null
  const start = at + marker.length
  const DQ = String.fromCharCode(34)
  const SQ = String.fromCharCode(39)
  const BT = String.fromCharCode(96)
  let depth = 1
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === DQ || c === SQ || c === BT) {
      let j = i + 1
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j += 1
        j += 1
      }
      i = j + 1
      continue
    }
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) return src.slice(start, i)
    }
    i += 1
  }
  return null
}

/**
 * 纯分析函数（可被自检直接喂合成样本）。返回 { findings: [...], values: {...} }。
 * findings 为空数组 = 全部判据通过。
 */
export function analyze(kotlinSrcRaw, wrapperSrcRaw) {
  // issue #1191：**B/C/D 必须在剥过注释的代码面上判定**。
  //
  // 旧实现直接用文件原文做正则匹配，于是把启动器那 9 行逻辑整段注释掉（`# ` 前缀）后，
  // 正则仍能从注释里读到 `export NODE_OPTIONS=...`、`LD_LIBRARY_PATH`、`linker64`，
  // 三条判据全 PASS —— 设备上堆底线彻底缺失。
  //
  // **关键：wrapper 不是独立的 .sh 文件，而是嵌在 build-snapshot-013.mjs 里的 JS 字符串拼接。**
  // 所以不能只对整个 JS 文件剥 JS 注释 —— shell 代码在字符串字面量内部，JS 剥离器会原样保留。
  // 必须先把 shell 片段从 JS 字符串里**抽出来**，再按 shell 口径剥 `#` 注释。
  //
  // 抽取方式：`+ '<内容>\n'` 是这些片段的唯一拼接形态（本仓实测 16 处），
  // 按它抽出来拼成一段完整 shell 文本；抽不到时退回整份原文（此时 shell 注释无法剥，
  // 但至少 JS 注释能剥 —— 比完全不剥好，且下方的自检会覆盖抽取路径）。
  //
  // Kotlin 侧直接剥 C 系注释（`//` 与 `/* */`）。
  const kotlinSrc = stripComments(kotlinSrcRaw, { mode: 'c' })
  const wrapperSrc = shellCodeOf(wrapperSrcRaw)
  const findings = []
  const values = { floor: null, cap: null, clampLo: null, clampHi: null, divisor: null }

  // ── A/B：壳侧常量 + 取值形态 ──────────────────────────────────────────────
  const floorM = /ENGINE_HEAP_FLOOR_MB:\s*Int\s*=\s*(\d+)/.exec(kotlinSrc)
  const capM = /ENGINE_HEAP_CAP_MB:\s*Int\s*=\s*(\d+)/.exec(kotlinSrc)
  if (!floorM) findings.push("A: 壳侧缺 ENGINE_HEAP_FLOOR_MB 常量（下限无单一真源）")
  if (!capM) findings.push("A: 壳侧缺 ENGINE_HEAP_CAP_MB 常量（上限无单一真源）")
  if (floorM) values.floor = Number(floorM[1])
  if (capM) values.cap = Number(capM[1])
  if (values.floor !== null && values.floor <= 0) findings.push("A: 壳侧下限必须为正，实测 " + values.floor)
  if (values.cap !== null && values.cap <= 0) findings.push("A: 壳侧上限必须为正，实测 " + values.cap)
  if (values.floor !== null && values.cap !== null && values.floor > values.cap) {
    findings.push("A: 壳侧下限(" + values.floor + ")大于上限(" + values.cap + ")，clamp 区间为空")
  }
  if (!/coerceIn\(ENGINE_HEAP_FLOOR_MB,\s*ENGINE_HEAP_CAP_MB\)/.test(kotlinSrc)) {
    findings.push("A: 壳侧取值必须 clamp 到上下限（裸除法会让小内存设备推出危险值）")
  }
  if (!/if \(totalRamMb <= 0\) return ENGINE_HEAP_FLOOR_MB/.test(kotlinSrc)) {
    findings.push("A: 读不到设备内存时必须退回下限（未知不得当未知处理）")
  }

  // ── F：上限必须严格大于「重现 V8 自然上限所需的标志值」───────────────────────
  // 0.14.8 的真实缺陷：CAP 取 1024，与 V8 自然推导天花板（1120MB ⇒ 标志 1024）逐值相等，
  // 于是 totalRam/2 分支在每台真机上都被截断，取值退化成常量 1024、下限永不可达。
  // 判据不能只写「CAP > FLOOR」（1024 > 512 会放过这个缺陷），必须对 V8 自然档判。
  const naturalM = /ENGINE_HEAP_NATURAL_MAX_FLAG_MB:\s*Int\s*=\s*(\d+)/.exec(kotlinSrc)
  if (!naturalM) {
    findings.push("F: 壳侧缺 ENGINE_HEAP_NATURAL_MAX_FLAG_MB（无法判定上限是否向下覆盖了 V8 自然推导）")
  } else {
    values.naturalFlag = Number(naturalM[1])
    if (values.cap !== null && values.cap <= values.naturalFlag) {
      findings.push("F: 上限 " + values.cap + " ≤ V8 自然上限标志档 " + values.naturalFlag
        + "（自适应标志退化成对 V8 的向下覆盖；totalRam/2 分支在真机上恒被截断，下限永不可达——0.14.8 缺陷复现）")
    }
  }
  // 自适应必须真有可能落在区间内部：否则 clamp 只是恒返回某个端点。
  if (values.floor !== null && values.cap !== null && values.cap - values.floor < 1024) {
    findings.push("F: 区间 [" + values.floor + "," + values.cap + "] 过窄（<1024MB），"
      + "「总内存一半」几乎必然被某个端点吃掉，等于没有自适应")
  }

  // ── B：启动器侧自适应 ────────────────────────────────────────────────────
  if (!/\/proc\/meminfo/.test(wrapperSrc)) findings.push("B: 启动器未读 /proc/meminfo（无法在设备上自适应）")
  if (!/MemTotal:/.test(wrapperSrc)) findings.push("B: 启动器未解析 MemTotal")
  const divM = /__dsh_mem_kb\s*\/\s*(\d+)/.exec(wrapperSrc)
  if (!divM) findings.push("B: 启动器未对 MemTotal 取半（缺少 /<divisor> 形态）")
  else values.divisor = Number(divM[1])
  const loM = /\[ "\$__dsh_heap" -lt (\d+) \]/.exec(wrapperSrc)
  const hiM = /\[ "\$__dsh_heap" -gt (\d+) \]/.exec(wrapperSrc)
  if (!loM) findings.push("B: 启动器缺下限钳制（-lt）")
  if (!hiM) findings.push("B: 启动器缺上限钳制（-gt）")
  if (loM) values.clampLo = Number(loM[1])
  if (hiM) values.clampHi = Number(hiM[1])
  if (!/export NODE_OPTIONS="--max-old-space-size=\$__dsh_heap"/.test(wrapperSrc)) {
    findings.push("B: 启动器未导出 NODE_OPTIONS=--max-old-space-size=<自适应值>")
  }
  if (!/export LD_LIBRARY_PATH=/.test(wrapperSrc)) {
    findings.push("B: 启动器必须保留 LD_LIBRARY_PATH 导出（PTC 过滤 env 时唯一的库路径来源）")
  }
  if (!/exec \/system\/bin\/linker64/.test(wrapperSrc)) {
    findings.push("B: 启动器必须经 linker64 启动（app-data ELF 不可直接 exec）")
  }

  // ── C：双源逐值相等（核心判据）────────────────────────────────────────────
  if (values.floor !== null && values.clampLo !== null && values.floor !== values.clampLo) {
    findings.push("C: 下限不一致：壳侧 " + values.floor + " vs 启动器 " + values.clampLo
      + "（两条路径会给出不同的堆底线，引擎与 code run 行为分叉）")
  }
  if (values.cap !== null && values.clampHi !== null && values.cap !== values.clampHi) {
    findings.push("C: 上限不一致：壳侧 " + values.cap + " vs 启动器 " + values.clampHi)
  }
  if (values.divisor !== null && values.divisor !== 2048) {
    findings.push("C: 启动器除数为 " + values.divisor + "，与壳侧「总内存的一半」口径不符（应为 2048，即 KB→MB 后再 /2）")
  }

  // ── D：启动器不得覆盖调用方显式设置的值 ──────────────────────────────────
  if (!/if \[ -z "\$NODE_OPTIONS" \]/.test(wrapperSrc)) {
    findings.push("D: 启动器必须只在 NODE_OPTIONS 未设置时才填（显式值优先，否则覆盖 PTC/用户的 max-old-space-size）")
  }

  // ── E：argv 不得出现堆标志 ───────────────────────────────────────────────
  // issue #1191 洞二：**不能靠惰性量词截窗口**。
  //
  // 旧实现 `arrayOf\(([\s\S]{0,400}?)\)` 在第一个 `)` 就收尾 —— 而 `bindPort.toString()`
  // 里就有个 `)`，扫描窗口在堆标志之前就结束了，之后追加的 `"--max-old-space-size=256",`
  // 完全不可见。
  //
  // 改成**括号配平**扫描：从 `arrayOf(` 开始数括号，配平处才是真正的收尾。
  // 字符串里的括号要跳过（否则 `"foo)"` 会提前收尾，同一个坑换一种形态）。
  const argvArgs = balancedArgs(kotlinSrc, 'arrayOf(')
  if (argvArgs === null) findings.push("E: 找不到引擎 argv（锚点失效，判据无法生效）")
  else if (/max-old-space-size|max_old_space_size/.test(argvArgs)) {
    findings.push("E: 引擎 argv 出现堆标志（argv 覆盖 NODE_OPTIONS，堆来源必须唯一）")
  }

  return { findings, values }
}

// ── 判别力自检：合成样本必须能判红 ────────────────────────────────────────────
const GOOD_KOTLIN = [
  "internal const val ENGINE_HEAP_FLOOR_MB: Int = 512",
  "internal const val ENGINE_HEAP_CAP_MB: Int = 4096",
  "internal const val ENGINE_HEAP_NATURAL_MAX_FLAG_MB: Int = 1024",
  "  if (totalRamMb <= 0) return ENGINE_HEAP_FLOOR_MB",
  "  return (totalRamMb / 2).coerceIn(ENGINE_HEAP_FLOOR_MB, ENGINE_HEAP_CAP_MB)",
  "  val args = arrayOf(nodeBin.absolutePath, \"--expose-internals\", dshBin.absolutePath)",
  "  \"NODE_OPTIONS\" to heapOptionFrom(engineHeapMb(deviceTotalRamMb())),",
].join("\n")
const GOOD_WRAPPER = [
  "  done < /proc/meminfo",
  "if [ -z \"$NODE_OPTIONS\" ]; then",
  "  if [ \"$__dsh_key\" = \"MemTotal:\" ]; then __dsh_mem_kb=$__dsh_val; break; fi",
  "  __dsh_heap=$(( __dsh_mem_kb / 2048 ))",
  "  [ \"$__dsh_heap\" -lt 512 ] && __dsh_heap=512",
  "  [ \"$__dsh_heap\" -gt 4096 ] && __dsh_heap=4096",
  "  export NODE_OPTIONS=\"--max-old-space-size=$__dsh_heap\"",
  "fi",
  "export LD_LIBRARY_PATH=\"/x/lib\"",
  "exec /system/bin/linker64 \"/x/bin/node\" \"$@\"",
].join("\n")

function selfTest() {
  let stFail = 0
  const expect = (label, src, wrapperSrc, shouldFail) => {
    const r = analyze(src, wrapperSrc)
    const got = r.findings.length > 0
    if (got !== shouldFail) {
      stFail += 1
      console.log("SELFTEST FAIL  " + label + "（期望 " + (shouldFail ? "判红" : "通过") + "，实际 " + (got ? "判红" : "通过") + "）")
      r.findings.forEach((f) => console.log("      " + f))
    } else {
      console.log("SELFTEST PASS  " + label + " → " + (got ? "判红" : "通过"))
    }
  }

  // 正样本：必须通过（否则门禁会对正确实现误报）
  expect("基线样本（正确实现）", GOOD_KOTLIN, GOOD_WRAPPER, false)

  // 受控负控：每一项对应一条真判据，证明它**仍然会判红**
  expect("负控 A1：壳侧下限被删", GOOD_KOTLIN.replace(/ENGINE_HEAP_FLOOR_MB: Int = \d+/, ""), GOOD_WRAPPER, true)
  expect("负控 A2：壳侧改为裸除法（无 clamp）", GOOD_KOTLIN.replace(/\.coerceIn\(ENGINE_HEAP_FLOOR_MB,\s*ENGINE_HEAP_CAP_MB\)/, ""), GOOD_WRAPPER, true)
  expect("负控 B1：启动器不再自适应（写死 meminfo 读取删除）", GOOD_KOTLIN, GOOD_WRAPPER.replace("/proc/meminfo", "/dev/null"), true)
  expect("负控 C1：启动器下限与壳侧不一致（512 vs 256）", GOOD_KOTLIN, GOOD_WRAPPER.replace(/-lt 512/, "-lt 256"), true)
  expect("负控 C2：启动器除数被改成 1024（只取 1/4）", GOOD_KOTLIN, GOOD_WRAPPER.replace("2048", "1024"), true)
  expect("负控 D1：启动器无条件覆盖 NODE_OPTIONS", GOOD_KOTLIN, GOOD_WRAPPER.replace('if [ -z "$NODE_OPTIONS" ]; then', "if true; then"), true)
  expect("负控 E1：argv 混入堆标志", GOOD_KOTLIN.replace('"--expose-internals"', '"--expose-internals", "--max-old-space-size=256"'), GOOD_WRAPPER, true)
  expect("负控 C3：壳侧上限被改坏（与启动器分叉）", GOOD_KOTLIN.replace("ENGINE_HEAP_CAP_MB: Int = 4096", "ENGINE_HEAP_CAP_MB: Int = 2048"), GOOD_WRAPPER, true)
  // C3 的变异体会让壳侧 2048 与启动器 4096 分叉，同时触发 F —— 这里单独锁 F 的**独立**判别力：
  // 双源一致（都是 1024）却正好等于 V8 自然档，正是 0.14.8 的原始缺陷形态，必须判红。
  expect("负控 F1：双源一致但上限=1024（正好向下覆盖 V8 自然推导，即 0.14.8 原缺陷）",
    GOOD_KOTLIN.replace("ENGINE_HEAP_CAP_MB: Int = 4096", "ENGINE_HEAP_CAP_MB: Int = 1024"),
    GOOD_WRAPPER.replace(/-gt 4096/, "-gt 1024").replace("=4096", "=1024"),
    true)
  // F2 抬「自然标志档」而不是抬上限：抬上限仍 >1024 属合法放宽，不应判红（那不是缺陷）。
  // 真正要判红的是「上限 ≤ 自然标志档」，故把 N 抬到与 CAP 相等。
  expect("负控 F2：上限正好等于自然标志档（cap ≤ N，无向下覆盖余量）",
    GOOD_KOTLIN.replace("ENGINE_HEAP_NATURAL_MAX_FLAG_MB: Int = 1024", "ENGINE_HEAP_NATURAL_MAX_FLAG_MB: Int = 4096"),
    GOOD_WRAPPER,
    true)
  expect("负控 F3：区间过窄（上限仅比下限高 512MB，自适应必然被端点吃掉）",
    GOOD_KOTLIN.replace("ENGINE_HEAP_CAP_MB: Int = 4096", "ENGINE_HEAP_CAP_MB: Int = 1024")
      .replace("ENGINE_HEAP_NATURAL_MAX_FLAG_MB: Int = 1024", "ENGINE_HEAP_NATURAL_MAX_FLAG_MB: Int = 768"),
    GOOD_WRAPPER.replace(/-gt 4096/, "-gt 1024").replace("=4096", "=1024"),
    true)

  if (stFail > 0) { console.log("CHECK-ENGINE-HEAP-FLOOR SELF-TEST FAILED（" + stFail + " 项）"); process.exit(1) }
  console.log("CHECK-ENGINE-HEAP-FLOOR SELF-TEST PASSED（正样本 1 + 受控负控 11）")
  process.exit(0)
}

if (SELF_TEST) selfTest()

// ── 真实仓库检查 ─────────────────────────────────────────────────────────────
const kPath = join(ROOT, KOTLIN_REL)
const wPath = join(ROOT, WRAPPER_REL)
// 缺件有两档语义：非严格档显式计数并跳过（本仓布局下这两件必然在场，正常不会走到），
// 严格档（--require）判红——否则「输入被删」会表现成一次静默的绿。
let missing = 0
if (!existsSync(kPath)) { missing += 1; skip("缺 " + KOTLIN_REL + "（壳侧堆取值不可核对）") }
if (!existsSync(wPath)) { missing += 1; skip("缺 " + WRAPPER_REL + "（启动器堆下限不可核对）") }
if (missing > 0) {
  if (REQUIRE) { console.log("CHECK-ENGINE-HEAP-FLOOR FAILED（--require 档不得 SKIP，缺件 " + missing + "）"); process.exit(1) }
  console.log("CHECK-ENGINE-HEAP-FLOOR PASSED（SKIP=" + skipped + "；缺件 " + missing + " 处，非严格档）")
  process.exit(0)
}

const { findings, values } = analyze(readFileSync(kPath, "utf8"), readFileSync(wPath, "utf8"))
if (findings.length === 0) {
  pass("壳侧下限/上限 = " + values.floor + "/" + values.cap + "，启动器钳制 = " + values.clampLo + "/" + values.clampHi + "（逐值一致）")
  pass("启动器自适应除数为 " + values.divisor + "（MemTotal KB → 一半的 MB）")
  pass("argv 未携带堆标志，堆来源唯一")
  console.log("CHECK-ENGINE-HEAP-FLOOR PASSED（SKIP=" + skipped + "）")
  process.exit(0)
}
findings.forEach(fail)
console.log("CHECK-ENGINE-HEAP-FLOOR FAILED（" + failures + " 项）")
process.exit(1)