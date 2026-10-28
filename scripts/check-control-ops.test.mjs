import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `check-control-ops.mjs` 是「六处登记链」的一致性门禁，但此前**零测试面**：
// 把它任意一条断言写坏（或整条删掉），CI 不会有任何反应 —— 门禁本身没有任何东西守着。
// 这里用 `--shell-root` / `--plugin-root` / `--ledger` / `--gaps` 把六个面 + 台账 + 豁免面
// 全部换成一棵临时树跑，既能逐条做负控，也不会碰到仓库里的真实文件（无自指陷阱）。
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'check-control-ops.mjs')

const KOTLIN_HEAD = 'package com.dsharnessmobile.shell\n\n'

const BASE = {
  'shell/app/src/main/java/com/dsharnessmobile/shell/DeviceControlService.kt': KOTLIN_HEAD + `class DeviceControlService {
  fun handle(op: String, args: JSONObject): JSONObject = when (op) {
    "click" -> click(args)
    "scroll" -> scroll(args)
    else -> error("unsupported op: " + op)
  }
}
`,
  'shell/app/src/main/java/com/dsharnessmobile/shell/ControlProtocolV2.kt': KOTLIN_HEAD + `object ControlProtocolV2 {
  val SUPPORTED_OPS = listOf(
    "click",
    "scroll",
  )
}
`,
  'shell/app/src/main/java/com/dsharnessmobile/shell/ControlCarrier.kt': KOTLIN_HEAD + `object ControlCarrier {
  val BROWSER_OPS = setOf("browserOpen")
  val VD_OPS = setOf("vdTap")
  val SHELL_OPS = setOf("shellExec")
}
`,
  'plugin/plugins/dsh-android-bridge/src/control-policy.ts': `export type ControlOp = 'click' | 'scroll'

export const A11Y_OPS: readonly ControlOp[] = [
  'click', 'scroll',
]
`,
  'plugin/plugins/dsh-android-bridge/src/index.ts': `const ROUTE_OPS: ControlOp[] = ['click']
`,
  'plugin/plugins/dsh-android-manage/src/index.ts': `async function tools() {
  await a11yExec('click', {})
  await controlExec('scroll', {})
}
`,
}

/** 起一棵临时树跑一次门禁。`overrides` 里值为 null 表示删掉该文件。 */
function run(overrides = {}, { gaps = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'control-ops-'))
  try {
    const files = { ...BASE, ...overrides }
    for (const [rel, body] of Object.entries(files)) {
      if (body === null) continue
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body)
    }
    const ledger = join(dir, 'ledger.json')
    writeFileSync(ledger, JSON.stringify({ families: [], pending: [] }))
    const gapsPath = join(dir, 'gaps.json')
    writeFileSync(gapsPath, JSON.stringify({ gaps }))
    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--shell-root', join(dir, 'shell'),
      '--plugin-root', join(dir, 'plugin'),
      '--ledger', ledger,
      '--gaps', gapsPath,
    ], { encoding: 'utf8' })
    return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('六处登记一致的树通过', () => {
  const { status, out } = run()
  assert.equal(status, 0, out)
  assert.match(out, /CHECK-CONTROL-OPS PASSED/)
})

test('handle 少一个 when 分支会被逐条点名', () => {
  const { status, out } = run({
    'shell/app/src/main/java/com/dsharnessmobile/shell/DeviceControlService.kt': KOTLIN_HEAD + `class DeviceControlService {
  fun handle(op: String, args: JSONObject): JSONObject = when (op) {
    "click" -> click(args)
    else -> error("unsupported op: " + op)
  }
}
`,
  })
  assert.equal(status, 1, out)
  assert.match(out, /FAIL  handle 分支 == SUPPORTED_OPS/)
  assert.match(out, /SUPPORTED_OPS 独有=\[scroll\]/)
})

test('引擎 ControlOp 少一个会被点名（差集两侧都印）', () => {
  const { status, out } = run({
    'plugin/plugins/dsh-android-bridge/src/control-policy.ts': `export type ControlOp = 'click'

export const A11Y_OPS: readonly ControlOp[] = [
  'click', 'scroll',
]
`,
  })
  assert.equal(status, 1, out)
  assert.match(out, /FAIL  ControlOp == SUPPORTED_OPS/)
  assert.match(out, /SUPPORTED_OPS 独有=\[scroll\]/)
})

test('A11Y_OPS 多一个会被点名（这一面决定 op 是否走无障碍通道）', () => {
  const { status, out } = run({
    'plugin/plugins/dsh-android-bridge/src/control-policy.ts': `export type ControlOp = 'click' | 'scroll'

export const A11Y_OPS: readonly ControlOp[] = [
  'click', 'scroll', 'longClick',
]
`,
  })
  assert.equal(status, 1, out)
  assert.match(out, /FAIL  A11Y_OPS == ControlOp/)
  assert.match(out, /A11Y_OPS 独有=\[longClick\]/)
})

test('manage 工具面用了未登记的 op 会被点名', () => {
  const { status, out } = run({
    'plugin/plugins/dsh-android-manage/src/index.ts': `async function tools() {
  await a11yExec('click', {})
  await controlExec('scroll', {})
  await a11yExec('bogus', {})
}
`,
  })
  assert.equal(status, 1, out)
  assert.match(out, /FAIL  manage 工具面 == SUPPORTED_OPS/)
  assert.match(out, /manage 独有=\[bogus\]/)
})

test('ROUTE_OPS 越界会被点名（诊断面只允许子集）', () => {
  const { status, out } = run({
    'plugin/plugins/dsh-android-bridge/src/index.ts': `const ROUTE_OPS: ControlOp[] = ['click', 'bogus']
`,
  })
  assert.equal(status, 1, out)
  assert.match(out, /FAIL  ROUTE_OPS ⊂ ControlOp/)
  assert.match(out, /越界=\[bogus\]/)
})

test('known-gaps 里声明过的缺口降级 WARN 而不是 FAIL', () => {
  const { status, out } = run({
    'plugin/plugins/dsh-android-bridge/src/control-policy.ts': `export type ControlOp = 'click'

export const A11Y_OPS: readonly ControlOp[] = [
  'click',
]
`,
  }, { gaps: [{ op: 'scroll', faces: ['ControlOp'], reason: '用例：只验豁免生效' }] })
  assert.equal(status, 0, out)
  assert.match(out, /WARN  ControlOp 豁免 scroll/)
  assert.match(out, /CHECK-CONTROL-OPS PASSED/)
})

test('源文件形态变了要报「解析不到」而不是静默放行', () => {
  const { status, out } = run({
    'shell/app/src/main/java/com/dsharnessmobile/shell/DeviceControlService.kt': KOTLIN_HEAD + `class DeviceControlService {
  fun handleSomethingElse(op: String, args: JSONObject): JSONObject = when (op) {
    "click" -> click(args)
    else -> error("unsupported op: " + op)
  }
}
`,
  })
  assert.equal(status, 1, out)
  assert.match(out, /解析不到 DeviceControlService\.handle/)
})
