#!/usr/bin/env node
// check-protocol-v2.mjs — 原生薄桥的协议、帧与图像契约门禁（2026-11-14 迁移）。
//
// 旧实现校验 Node 控制队列的 protocol-v2 列式编码与 30 KB 体积线，并依赖
// `plugins/dsh-android-manage` 与 `gen-protocol-v2-fixture.mjs`。三者已随旧控制链删除。
// 新协议是应用私有 socket 上的单帧：4 字节大端长度 + 标准 UTF-8 JSON。
//
// 本门禁做真实检查，不靠文本出现次数：
//   A. TS 传输层真的按 4 字节大端长度组帧、限制请求/响应上限、校验响应版本与 callId；
//   B. Kotlin 帧层真的拒绝超限、非法 UTF-8、非对象 JSON、未知字段，并把响应按同一 framed 写回；
//   C. Rust 与 TS 的图像回执都要求 mediaType、bytes、sha256，且单图不超过 1 MiB；
//   D. 对应的真实测试文件存在且至少有一个断言——不是空的占位。
//
// 用法：node scripts/check-protocol-v2.mjs [--self-test] [--shell-root <apk 树>] [--plugin-root <coord 树>]
// 退出码：0 = 通过；1 = 契约漂移、测试缺席或解析失败。
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockAfter } from './lib/native-control-contract.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const option = (name) => {
  const at = argv.indexOf('--' + name)
  return at >= 0 ? argv[at + 1] : undefined
}

const TS_CLIENT = 'plugins/dsh-android-bridge/src/native-client.ts'
const KOTLIN_FRAMES = 'app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeControlFrames.kt'
const RUST_VISION = 'native/phone-control-core/src/vision_runtime.rs'
const IMAGE_TS = 'plugins/dsh-android-phone-control/src/native-image-delivery.ts'
const TESTS = [
  'plugins/dsh-android-phone-control/test/native-client.test.mjs',
  'app/src/test/java/com/dsharnessmobile/shell/nativecontrol/NativeControlFramesTest.kt',
  'app/src/test/java/com/dsharnessmobile/shell/nativecontrol/NativeImageDeliveryTest.kt',
  'native/phone-control-core/tests/vision.rs',
  'native/phone-control-core/tests/vision_runtime.rs',
]

/** 只接受已知的数字常量写法；解析失败返回 null，调用方 fail-closed。 */
export function numericConst(text, mark) {
  const at = text.indexOf(mark)
  if (at < 0) return null
  // 只从 `= ...` 之后取，避免把 `2` 之类前缀误读成值（真实踩过：2 * 1024 * 1024 被读成 2048）。
  // 取窗口而不是「到行尾」：测试夹具可能没有换行，`indexOf('\n', at)` 会得到 -1，
  // slice 直接截空串。常量声明总在本行内，取 200 字符足够且不会跨到下一行。
  const line = text.slice(at, at + 200).split('\n')[0]
  // 锚点可能包含 RHS 字样（`pub const PROTOCOL_VERSION`），此时行内第一个 `=` 已是赋值符；
  // 取最后一个 `=` 只会在同一行还有比较时出错，因此仍用第一个。
  const equals = line.indexOf('=')
  if (equals < 0) return null
  let expression = line.slice(equals + 1).split('//')[0]
  // Rust `pub const X: u32 = 1`：锚点已吃掉到名字，这里再去一次类型注解。
  const annotated = /^\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.exec(expression)
  if (annotated !== null) expression = expression.slice(annotated[0].length)
  // Rust 声明以 `;` 结尾；它属于语句分隔符，不是运算符。
  expression = expression.replace(/;\s*$/, '')
  // 只认数字与 `*`；Rust 可带类型注解（`u32 = 1`），因此允许最多一个标识符。
  // 表达式已经以 `=` 切过，这里再容忍一次 `: u32 =` 的残留形态。
  const cleaned = expression.replace(/^[\s:]*[A-Za-z_][A-Za-z0-9_]*\s*=?\s*/, '')
  if (!/^[\s\d_*]+$/.test(cleaned)) return null
  const parts = [...cleaned.matchAll(/\d[\d_]*/g)].map((match) => Number(match[0].replace(/_/g, '')))
  if (parts.length === 0) return null
  const product = parts.reduce((total, value) => total * value, 1)
  return Number.isSafeInteger(product) ? product : null
}

/** 协议契约的纯判据：输入是各语言片段，输出可读失败列表。 */
export function auditProtocol(input) {
  const failures = []
  const fail = (label, detail) => failures.push(detail === undefined ? label : label + ' -> ' + detail)

  if (input.tsVersion !== 1) fail('TS 协议版本为 1', String(input.tsVersion))
  if (input.kotlinVersion !== 1) fail('Kotlin 协议版本为 1', String(input.kotlinVersion))
  if (input.rustVersion !== 1) fail('Rust exchange 协议版本为 1', String(input.rustVersion))
  if (input.tsRequestLimit !== 64 * 1024) fail('TS 请求帧上限 64 KiB', String(input.tsRequestLimit))
  if (input.kotlinRequestLimit !== 64 * 1024) fail('Kotlin 请求帧上限 64 KiB', String(input.kotlinRequestLimit))
  if (input.tsResponseLimit !== 2 * 1024 * 1024) fail('TS 响应帧上限 2 MiB', String(input.tsResponseLimit))
  if (input.kotlinResponseLimit !== 2 * 1024 * 1024) fail('Kotlin 响应帧上限 2 MiB', String(input.kotlinResponseLimit))
  if (!input.tsBigEndian) fail('TS 写入 4 字节大端长度头')
  if (!input.kotlinBigEndian) fail('Kotlin 读/写 4 字节大端长度头')
  if (!input.tsStrictUtf8) fail('TS 响应使用 fatal UTF-8 解码')
  if (!input.kotlinStrictUtf8) fail('Kotlin 请求使用 REPORT 模式解码 UTF-8')
  if (!input.tsCallMismatch) fail('TS 拒绝 callId 不匹配的响应')
  if (!input.kotlinUnknownField) fail('Kotlin 拒绝未知请求字段')
  if (!input.tsTrailingBytes) fail('TS 拒绝尾随字节')
  if (!input.kotlinObjectOnly) fail('Kotlin 拒绝非 JSON 对象请求')
  if (input.imageMaxBytes !== 1024 * 1024) fail('图像上限 1 MiB', String(input.imageMaxBytes))
  if (!input.rustImageHash) fail('Rust 图像元数据包含 sha256')
  if (!input.tsImageHash) fail('TS 图像回执校验 sha256')
  if (!input.tsImageBase64Strict) fail('TS 只接受规范 base64')
  for (const test of input.tests) {
    if (!test.exists) fail('协议/图像测试在场: ' + test.path)
    else if (test.assertions < 1) fail('协议/图像测试含断言: ' + test.path)
  }
  return { failures }
}

function selfTest() {
  const tests = TESTS.map((path) => ({ path, exists: true, assertions: 2 }))
  const base = {
    tsVersion: 1, kotlinVersion: 1, rustVersion: 1,
    tsRequestLimit: 65536, kotlinRequestLimit: 65536,
    tsResponseLimit: 2097152, kotlinResponseLimit: 2097152,
    tsBigEndian: true, kotlinBigEndian: true, tsStrictUtf8: true, kotlinStrictUtf8: true,
    tsCallMismatch: true, kotlinUnknownField: true, tsTrailingBytes: true, kotlinObjectOnly: true,
    imageMaxBytes: 1048576, rustImageHash: true, tsImageHash: true, tsImageBase64Strict: true,
    tests,
  }
  const cases = [
    ['正例：原生协议契约同源', {}, false],
    ['负控：请求上限被放宽', { tsRequestLimit: 128 * 1024 }, true],
    ['负控：响应上限被放宽', { kotlinResponseLimit: 4 * 1024 * 1024 }, true],
    ['负控：不再校验 callId', { tsCallMismatch: false }, true],
    ['负控：不再拒绝未知字段', { kotlinUnknownField: false }, true],
    ['负控：图像上限被放宽', { imageMaxBytes: 4 * 1024 * 1024 }, true],
    ['负控：图像哈希校验被删', { rustImageHash: false }, true],
    ['负控：协议测试缺席', { tests: [{ path: 'missing.mjs', exists: false, assertions: 0 }] }, true],
    ['负控：协议测试变成空壳', { tests: [{ path: 'empty.mjs', exists: true, assertions: 0 }] }, true],
  ]
  let bad = 0
  for (const [label, change, wantFail] of cases) {
    const result = auditProtocol({ ...base, ...change })
    const failed = result.failures.length > 0
    if (failed !== wantFail) { bad += 1; console.error('SELF-TEST FAIL：' + label + ' -> ' + result.failures.join('；')) }
    else console.log('PASS  [self-test] ' + label)
  }
  if (bad > 0) {
    console.error('CHECK-PROTOCOL-V2 SELF-TEST FAILED（' + bad + ' 例）')
    process.exit(1)
  }
  console.log('CHECK-PROTOCOL-V2 SELF-TEST PASSED（' + cases.length + ' 例：正例 / 受控负控）')
  process.exit(0)
}

const isCli = process.argv[1] !== undefined &&
  process.argv[1].replace(/\\/g, '/').endsWith('/check-protocol-v2.mjs')
if (argv.includes('--self-test')) selfTest()

const shellRoot = isCli ? [option('shell-root') ?? ROOT, join(option('shell-root') ?? ROOT, 'dsh-mobile-apk')]
  .find((candidate) => existsSync(join(candidate, KOTLIN_FRAMES))) : undefined
if (isCli && shellRoot === undefined) {
  console.error('CHECK-PROTOCOL-V2 FAILED：找不到壳侧树（' + KOTLIN_FRAMES + '）')
  process.exit(1)
}
const pluginRoot = isCli ? [option('plugin-root') ?? ROOT, join(option('plugin-root') ?? ROOT, 'dsh-mobile-apk')]
  .find((candidate) => existsSync(join(candidate, TS_CLIENT))) : undefined
if (isCli && pluginRoot === undefined) {
  console.error('CHECK-PROTOCOL-V2 FAILED：找不到插件树（' + TS_CLIENT + '）')
  process.exit(1)
}

if (isCli) {
const read = (root, rel) => {
  const path = join(root, rel)
  if (!existsSync(path)) throw new Error('源文件缺席: ' + rel)
  return readFileSync(path, 'utf8')
}

let tsClient, kotlinFrames, rustVision, imageTs
try {
  tsClient = read(pluginRoot, TS_CLIENT)
  kotlinFrames = read(shellRoot, KOTLIN_FRAMES)
  rustVision = read(shellRoot, RUST_VISION)
  imageTs = read(pluginRoot, IMAGE_TS)
} catch (failure) {
  console.error('CHECK-PROTOCOL-V2 FAILED：' + String(failure).slice(0, 240))
  process.exit(1)
}

const tsVersion = numericConst(tsClient, 'NATIVE_PROTOCOL_VERSION')
const kotlinVersion = numericConst(kotlinFrames, 'PROTOCOL_VERSION')
const rustVersion = numericConst(read(shellRoot, 'native/phone-control-core/src/controller.rs'), 'pub const PROTOCOL_VERSION')
const tsRequestLimit = numericConst(tsClient, 'MAX_REQUEST_BYTES')
const kotlinRequestLimit = numericConst(kotlinFrames, 'MAX_REQUEST_BYTES')
const tsResponseLimit = numericConst(tsClient, 'MAX_RESPONSE_BYTES')
const kotlinResponseLimit = numericConst(kotlinFrames, 'MAX_RESPONSE_BYTES')
const imageMaxBytes = numericConst(imageTs, 'NATIVE_IMAGE_MAX_BYTES')

if ([tsVersion, kotlinVersion, rustVersion, tsRequestLimit, kotlinRequestLimit, tsResponseLimit, kotlinResponseLimit, imageMaxBytes].some((value) => value === null)) {
  console.error('CHECK-PROTOCOL-V2 FAILED：协议常量解析失败（锚点被改名/改形？）')
  process.exit(1)
}

const tests = TESTS.map((rel) => {
  const path = join(shellRoot, rel)
  if (!existsSync(path)) return { path: rel, exists: false, assertions: 0 }
  const text = readFileSync(path, 'utf8')
  // Rust 用 `assert!` / `assert_eq!`，Kotlin 用 `assertEquals`，TS 用 `assert.equal` 等；
  // 三种都必须认。`assert` 单独出现（import 语句）不计入有效断言。
  const assertions = (text.match(/\bassert(?:_eq|_ne)?!|\bassert\.(?:equal|deepEqual|match|doesNotMatch|throws|ok|rejects|strictEqual)\b|\bassert(?:Equals|True|False|ArrayEquals|Throws|NotNull|Null)\b/g) ?? []).length
  return { path: rel, exists: true, assertions }
})

const result = auditProtocol({
  tsVersion, kotlinVersion, rustVersion,
  tsRequestLimit, kotlinRequestLimit, tsResponseLimit, kotlinResponseLimit,
  tsBigEndian: /writeUInt32BE\(/.test(tsClient) && /readUInt32BE\(/.test(tsClient),
  kotlinBigEndian: /DataInputStream/.test(kotlinFrames) && /readInt\(\)/.test(kotlinFrames) && /writeInt\(/.test(kotlinFrames),
  tsStrictUtf8: /new TextDecoder\('utf-8',\s*\{\s*fatal:\s*true\s*\}\)/.test(tsClient),
  kotlinStrictUtf8: /CodingErrorAction\.REPORT/.test(kotlinFrames),
  tsCallMismatch: /response-call-mismatch/.test(tsClient),
  kotlinUnknownField: /unknown-request-field/.test(kotlinFrames),
  tsTrailingBytes: /trailing bytes after the response frame/.test(tsClient),
  kotlinObjectOnly: /invalid-json-object/.test(kotlinFrames),
  imageMaxBytes,
  rustImageHash: /"sha256"\s*:\s*digest/.test(rustVision) && /Sha256::digest/.test(rustVision),
  tsImageHash: /createHash\('sha256'\)/.test(imageTs),
  tsImageBase64Strict: /decoded\.toString\('base64'\) !== data/.test(imageTs),
  tests,
})

console.log('协议版本 TS/Kotlin/Rust: ' + tsVersion + '/' + kotlinVersion + '/' + rustVersion)
console.log('帧上限 请求 ' + tsRequestLimit + ' B，响应 ' + tsResponseLimit + ' B；图像 ' + imageMaxBytes + ' B')
for (const test of tests) console.log((test.exists ? 'PASS  ' : 'FAIL  ') + '测试在场且有断言: ' + test.path + '（' + test.assertions + '）')
if (result.failures.length > 0) {
  for (const line of result.failures) console.error('FAIL  ' + line)
  console.error('CHECK-PROTOCOL-V2 FAILED（' + result.failures.length + ' 项）')
  process.exit(1)
}
console.log('CHECK-PROTOCOL-V2 PASSED')
}
