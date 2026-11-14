#!/usr/bin/env node
// check-op-registry-parity.mjs — 读屏 op 清单的跨语言对等门禁（2026-11-14 迁移）。
//
// 旧实现比对 `screen-scope.ts` 的 `REAL_SCREEN_CONTROL_OPS` 与 Kotlin
// `DeviceControlService.REAL_SCREEN_OPS`。两条源都已删除；新的单一真值是 Rust
// `native/phone-control-core/src/policy.rs` 的 `OPERATIONS` 条目，其中
// `reads_device_display=true` 的集合就是「会读设备屏」的权威清单。
//
// 断言：
//   A. Rust 目录可解析，读屏集合非空且无重复；
//   B. 每个读屏 op 都被至少一个 Kotlin adapter 接受（否则模型面承诺可用、真机落空）；
//   C. 两个手机屏幕 adapter 只能接 AndroidDisplay 域，不能夹带浏览器或 Root 操作；
//   D. 读屏 op 必须被手机薄桥转发；浏览器 / WebView / 特权 shell 不在此集合。
//
// 用法：node scripts/check-op-registry-parity.mjs [--shell-root <含 app/src/main 的树>] [--self-test]
// 退出码：0 = 通过；1 = 漂移或解析失败。
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { missingFrom, parseRustOperations, parseTsArray, sorted, unique } from './lib/native-control-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf('--' + name)
  return at >= 0 ? argv[at + 1] : undefined
}

export function compare(reads, implemented) {
  const missing = missingFrom(reads, implemented)
  const extra = missingFrom(implemented, reads)
  return { ok: missing.length === 0 && extra.length === 0, missing, extra }
}

function selfTest() {
  const cases = [
    ['正例：读屏集合一致', ['snapshot', 'screenshot'], ['screenshot', 'snapshot'], true],
    ['负控：壳侧少一个读屏 op', ['snapshot', 'screenshot'], ['snapshot'], false],
    ['负控：壳侧多一个非读屏 op', ['snapshot'], ['snapshot', 'state'], false],
  ]
  let failed = 0
  for (const [label, rust, kotlin, want] of cases) {
    const result = compare(rust, kotlin)
    if (result.ok !== want) { failed += 1; console.error('SELF-TEST FAIL：' + label) }
  }
  // 用模板字面量写夹具，避免在 patch 文本里再叠一层转义；内容与真实源码同形。
  const sample = [
    'pub static OPERATIONS: &[OperationSpec] = &[',
    '  spec("snapshot", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),',
    '];',
  ].join('\n')
  // `sample` 由多个字符串拼接而来，末尾 `];` 只截到第一个 `]` 是设计如此；解析器错在这里时
  // 必须显式报出实际结果，便于区分「夹具写错」与「解析器失效」。
  const parsed = parseRustOperations(sample)
  if (parsed === null) console.error('SELF-TEST sample:', JSON.stringify(sample))
  if (parsed === null || parsed.length !== 1) { failed += 1; console.error('SELF-TEST FAIL：Rust 目录解析') }
  if (parseRustOperations('const X = []') !== null) { failed += 1; console.error('SELF-TEST FAIL：锚点缺失未 fail-closed') }
  const tsSample = "export const NATIVE_CONTROL_OPERATIONS = [\n  'snapshot', 'click',\n] as const\n"
  if (JSON.stringify(parseTsArray(tsSample, 'NATIVE_CONTROL_OPERATIONS')) !== JSON.stringify(['snapshot', 'click'])) {
    failed += 1; console.error('SELF-TEST FAIL：TS 清单解析')
  }
  if (failed > 0) {
    console.error('CHECK-OP-REGISTRY-PARITY SELF-TEST FAILED（' + failed + ' 例）')
    process.exit(1)
  }
  console.log('CHECK-OP-REGISTRY-PARITY SELF-TEST PASSED（' + (cases.length + 3) + ' 例：正例 / 负控 / 锚点缺失）')
  process.exit(0)
}

if (argv.includes('--self-test')) selfTest()

function findShellRoot(start) {
  for (const candidate of [start, join(start, 'dsh-mobile-apk')]) {
    if (existsSync(join(candidate, 'native', 'phone-control-core', 'src', 'policy.rs'))) return candidate
  }
  return null
}

const shellRoot = findShellRoot(option('shell-root') ?? ROOT)
if (shellRoot === null) {
  console.error('CHECK-OP-REGISTRY-PARITY FAILED：找不到壳侧树（native/phone-control-core/src/policy.rs）')
  process.exit(1)
}
const policy = readFileSync(join(shellRoot, 'native/phone-control-core/src/policy.rs'), 'utf8')
const operations = parseRustOperations(policy)
if (operations === null) {
  console.error('CHECK-OP-REGISTRY-PARITY FAILED：解析不到 Rust OPERATIONS（锚点被改名/改形？）')
  process.exit(1)
}
const reads = unique(operations.filter((row) => row.readsDisplay).map((row) => row.name))
if (reads.length === 0) {
  console.error('CHECK-OP-REGISTRY-PARITY FAILED：Rust 目录没有任何 reads_device_display=true 的 op')
  process.exit(1)
}
if (new Set(operations.map((row) => row.name)).size !== operations.length) {
  console.error('CHECK-OP-REGISTRY-PARITY FAILED：Rust OPERATIONS 有重复名字')
  process.exit(1)
}

// Kotlin 真实执行面：只读 adapter 的 `implements` 接受的屏幕 op。这里用与 check-control-ops
// 同一份解析口径，避免两份判据各自漂移。
const { kotlinReachable, stripComments } = await import('./check-control-ops.mjs')
const shellDir = join(shellRoot, 'app/src/main/java/com/dsharnessmobile/shell/nativecontrol')
const kotlin = {}
if (existsSync(shellDir)) {
  for (const name of readdirSync(shellDir)) {
    if (name.endsWith('.kt')) kotlin[name] = readFileSync(join(shellDir, name), 'utf8')
  }
}
const implemented = kotlinReachable(kotlin).filter((op) => op !== 'backend' && op !== 'operation' && op !== 'target')
const notImplemented = missingFrom(reads, implemented)
// Kotlin 的 implements 会被复用做虚拟屏/按键参数分派；判定必须用 Rust 目录的语义，
// 而不是「是否出现在某个 setOf 里」。只把 Rust 目录里 reads_device_display=false
// 且 target 不是 AndroidDisplay 的 op 视为越界。
const phoneAdapters = Object.fromEntries(Object.entries(kotlin).filter(([name]) =>
  /^Native(?:A11y|Shizuku)Execution\.kt$/.test(name)))
if (Object.keys(phoneAdapters).length !== 2) {
  console.error('CHECK-OP-REGISTRY-PARITY FAILED：手机屏幕 adapter 缺席')
  process.exit(1)
}
const nonReadOps = kotlinReachable(phoneAdapters).filter(op => {
  const row = operations.find(entry => entry.name === op)
  return row !== undefined && row.targetDomain !== 'AndroidDisplay'
})

if (notImplemented.length > 0) {
  console.error('CHECK-OP-REGISTRY-PARITY FAILED：Rust 读屏 op 没有 Kotlin 执行面')
  console.error('  壳侧缺少: [' + notImplemented.join(', ') + ']')
  process.exit(1)
}
if (nonReadOps.length > 0) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：Kotlin 把非屏幕域 op 暴露在屏幕执行面')
  console.error('  不应出现: [' + sorted(unique(nonReadOps)).join(', ') + ']')
  process.exit(1)
}

// 传输层同样必须承载全部读屏 op。手机薄桥与共享浏览器桥都由 check-control-ops 校验，
// 这里额外核对手机桥，因为读屏 op 只能经它到达模型。
const bridgePath = join(ROOT, 'plugins/dsh-android-phone-control/src/native-bridge.ts')
if (!existsSync(bridgePath)) {
  console.error('CHECK-OP-REGISTRY-PARITY FAILED：手机薄桥源文件缺席')
  process.exit(1)
}
{
  const phoneOps = parseTsArray(readFileSync(bridgePath, 'utf8'), 'NATIVE_CONTROL_OPERATIONS')
  if (phoneOps === null) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：解析不到手机薄桥 NATIVE_CONTROL_OPERATIONS')
    process.exit(1)
  }
  const unforwarded = missingFrom(reads, phoneOps)
  if (unforwarded.length > 0) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：读屏 op 未被手机薄桥转发: [' + unforwarded.join(', ') + ']')
    process.exit(1)
  }
}

console.log('CHECK-OP-REGISTRY-PARITY PASSED（读屏 ' + reads.length + ' 条，Rust 目录 ' + operations.length + ' 条：' + sorted(reads).join(', ') + '）')
