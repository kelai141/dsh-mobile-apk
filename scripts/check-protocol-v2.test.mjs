import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { auditProtocol, numericConst } from './check-protocol-v2.mjs'

// 协议门禁守的是「原生帧 + 响应 + 图像」三条真实契约。旧 V2 生成器已删除，
// 所以这里不再造旧 fixture，而是直接驱动新判据与其常量解析器。

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SCRIPT = join(HERE, 'check-protocol-v2.mjs')

const base = {
  tsVersion: 1, kotlinVersion: 1, rustVersion: 1,
  tsRequestLimit: 64 * 1024, kotlinRequestLimit: 64 * 1024,
  tsResponseLimit: 2 * 1024 * 1024, kotlinResponseLimit: 2 * 1024 * 1024,
  tsBigEndian: true, kotlinBigEndian: true, tsStrictUtf8: true, kotlinStrictUtf8: true,
  tsCallMismatch: true, kotlinUnknownField: true, tsTrailingBytes: true, kotlinObjectOnly: true,
  imageMaxBytes: 1024 * 1024, rustImageHash: true, tsImageHash: true, tsImageBase64Strict: true,
  tests: [{ path: 'x.test.mjs', exists: true, assertions: 3 }],
}

const failures = (change) => auditProtocol({ ...base, ...change }).failures

test('正例：原生协议与图像契约同源', () => {
  assert.deepEqual(failures({}), [])
})
test('负控：请求上限被放宽', () => {
  assert.match(failures({ tsRequestLimit: 128 * 1024 }).join('\n'), /TS 请求帧上限 64 KiB/)
})
test('负控：响应上限被放宽', () => {
  assert.match(failures({ kotlinResponseLimit: 4 * 1024 * 1024 }).join('\n'), /Kotlin 响应帧上限 2 MiB/)
})
test('负控：callId 校验被删', () => {
  assert.match(failures({ tsCallMismatch: false }).join('\n'), /TS 拒绝 callId 不匹配/)
})
test('负控：未知请求字段被放行', () => {
  assert.match(failures({ kotlinUnknownField: false }).join('\n'), /Kotlin 拒绝未知请求字段/)
})
test('负控：尾随字节被放行', () => {
  assert.match(failures({ tsTrailingBytes: false }).join('\n'), /TS 拒绝尾随字节/)
})
test('负控：图像上限被放宽', () => {
  assert.match(failures({ imageMaxBytes: 4 * 1024 * 1024 }).join('\n'), /图像上限 1 MiB/)
})
test('负控：图像哈希校验被删', () => {
  assert.match(failures({ rustImageHash: false, tsImageHash: false }).join('\n'), /sha256/)
})
test('负控：协议测试缺席', () => {
  assert.match(failures({ tests: [{ path: 'missing.mjs', exists: false, assertions: 0 }] }).join('\n'), /测试在场/)
})
test('负控：协议测试变成空壳', () => {
  assert.match(failures({ tests: [{ path: 'empty.mjs', exists: true, assertions: 0 }] }).join('\n'), /含断言/)
})

test('常量解析：乘法表达式按完整乘积读取', () => {
  assert.equal(numericConst('const MAX_RESPONSE_BYTES = 2 * 1024 * 1024', 'MAX_RESPONSE_BYTES'), 2 * 1024 * 1024)
  assert.equal(numericConst('val MAX_REQUEST_BYTES = 64 * 1024', 'MAX_REQUEST_BYTES'), 64 * 1024)
  assert.equal(numericConst('const NATIVE_IMAGE_MAX_BYTES = 1024 * 1024', 'NATIVE_IMAGE_MAX_BYTES'), 1024 * 1024)
})
test('常量解析：锚点缺失返回 null（fail-closed）', () => {
  assert.equal(numericConst('const OTHER = 1', 'MAX_RESPONSE_BYTES'), null)
})

test('CLI：--self-test 通过', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' })
  const out = (result.stdout ?? '') + (result.stderr ?? '')
  assert.equal(result.status, 0, out)
  assert.match(out, /CHECK-PROTOCOL-V2 SELF-TEST PASSED/)
})

test('CLI：真实仓库通过，且旧 V2 生成器不再被要求', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  const out = (result.stdout ?? '') + (result.stderr ?? '')
  assert.equal(result.status, 0, out)
  assert.match(out, /CHECK-PROTOCOL-V2 PASSED/)
  assert.doesNotMatch(out, /gen-protocol-v2-fixture/)
})

test('CLI：Rust 协议版本锚点被改名时 fail-closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-protocol-'))
  try {
    mkdirSync(join(root, 'app/src/main/java/com/dsharnessmobile/shell/nativecontrol'), { recursive: true })
    mkdirSync(join(root, 'native/phone-control-core/src'), { recursive: true })
    mkdirSync(join(root, 'plugins/dsh-android-bridge/src'), { recursive: true })
    mkdirSync(join(root, 'plugins/dsh-android-phone-control/src'), { recursive: true })
    writeFileSync(join(root, 'app/src/main/java/com/dsharnessmobile/shell/nativecontrol/NativeControlFrames.kt'), '')
    writeFileSync(join(root, 'native/phone-control-core/src/controller.rs'), 'pub const NOT_PROTOCOL = 1;\n')
    writeFileSync(join(root, 'native/phone-control-core/src/vision_runtime.rs'), '')
    writeFileSync(join(root, 'plugins/dsh-android-bridge/src/native-client.ts'), '')
    writeFileSync(join(root, 'plugins/dsh-android-phone-control/src/native-image-delivery.ts'), '')
    const result = spawnSync(process.execPath, [SCRIPT, '--shell-root', root, '--plugin-root', root], { encoding: 'utf8' })
    const out = (result.stdout ?? '') + (result.stderr ?? '')
    assert.equal(result.status, 1, out)
    assert.match(out, /协议常量解析失败/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
