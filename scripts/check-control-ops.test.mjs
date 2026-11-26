import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { auditContract, parseToolInputs } from './check-control-ops.mjs'

// 本文件守两件事：
// 1. 契约判据本身有判别力（每条负控都能让 auditContract 变红）；
// 2. CLI 在真实仓库上可跑，且锚点被改名时 fail-closed，而不是静默放行。

const coord = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(coord, 'scripts', 'check-control-ops.mjs')

const catalog = [
  { name: 'snapshot', targetDomain: 'AndroidDisplay', backend: 'A11yPreferred', scope: 'ScreenContent', readsDisplay: true },
  { name: 'browserCaps', targetDomain: 'BrowserWorkspace', backend: 'BrowserHost', scope: 'NotScreenScoped', readsDisplay: false },
  { name: 'rootExec', targetDomain: 'PrivilegedShell', backend: 'RootRequired', scope: 'NotScreenScoped', readsDisplay: false },
  { name: 'vdCreate', targetDomain: 'VirtualDisplay', backend: 'ShizukuOrRoot', scope: 'VirtualNamespace', readsDisplay: false },
]

const base = {
  operations: catalog,
  phoneOps: ['snapshot', 'rootExec'],
  sharedBrowserOps: ['browserCaps'],
  kotlinImplements: ['snapshot', 'browserCaps', 'rootExec', 'vdCreate'],
  backendCoverage: { A11yPreferred: true, BrowserHost: true, RootRequired: true, ShizukuRequired: true, ShizukuOrRoot: true },
  privilegedOps: ['rootExec', 'shExec', 'termuxExec'],
  toolOperations: ['snapshot'],
  vdisplayOps: ['vdCreate'],
  rootAsShizuku: false,
  toolInputs: [{ name: 'android_ui_input', operations: ['setText'] }, { name: 'android_screen_list', operations: [] }],
  legacyRefs: [],
}

const failures = (patch) => auditContract({ ...base, ...patch }).failures

test('正例：三面同源通过', () => {
  assert.deepEqual(failures({}), [])
})

test('真实源码解析拒绝把输入的未知分支伪装成 setText', () => {
  const source = "defineTool({ name: 'android_ui_input', execute: (args) => invoke(args.key === undefined ? 'setText' : 'swipe', args) })"
  const inputs = parseToolInputs(source)
  assert.deepEqual(inputs[0].operations, ['setText', 'swipe'])
  assert.ok(failures({toolInputs: inputs}).some(value => value.includes('只承载文本或按键')))
  assert.deepEqual(parseToolInputs(source.replace("'swipe'", "'keyEvent'"))[0].operations, ['setText', 'keyEvent'])
})

test('负控：删掉全部 Kotlin adapter 必须判红', () => {
  assert.match(failures({ kotlinImplements: [] }).join('\n'), /无 adapter/)
})

test('负控：手机桥漏掉屏幕 op 必须判红', () => {
  assert.match(failures({ phoneOps: [] }).join('\n'), /手机薄桥覆盖/)
})

test('负控：Unsupported 进入桥面必须判红', () => {
  const operations = [...catalog, { name: 'vdMoveTask', targetDomain: 'VirtualDisplay', backend: 'Unsupported', scope: 'RegisteredVirtual', readsDisplay: false }]
  assert.match(failures({ operations, phoneOps: [...base.phoneOps, 'vdMoveTask'] }).join('\n'), /Unsupported op 不得进入任何桥面/)
})

test('负控：第二个输入工具必须判红', () => {
  const toolInputs = [{ name: 'android_ui_input', operations: ['setText'] }, { name: 'android_ui_input', operations: ['setText'] }]
  assert.match(failures({ toolInputs }).join('\n'), /恰有一个 android_ui_input/)
})

test('输入工具可承载文本与按键二选一，但不得夹带拖动', () => {
  const withKey = {
    operations: [...catalog, { name: 'keyEvent', targetDomain: 'AndroidDisplay', backend: 'ShizukuRequired', scope: 'ScreenContent', readsDisplay: false }],
    phoneOps: [...base.phoneOps, 'keyEvent'],
    kotlinImplements: [...base.kotlinImplements, 'keyEvent'],
    backendCoverage: { ...base.backendCoverage, ShizukuRequired: true },
  }
  assert.deepEqual(failures({ ...withKey, toolInputs: [{ name: 'android_ui_input', operations: ['setText', 'keyEvent'] }] }), [])
  assert.match(failures({ toolInputs: [{ name: 'android_ui_input', operations: ['setText', 'swipe'] }] }).join('\n'), /只承载文本或按键/)
})

test('负控：共享浏览器桥与 Rust 目录不一致必须判红', () => {
  assert.match(failures({ sharedBrowserOps: [] }).join('\n'), /共享浏览器桥 == Rust BrowserWorkspace/)
})

test('负控：rootExec 被声明成普通 Shizuku 必须判红', () => {
  const operations = catalog.map((row) => row.name === 'rootExec' ? { ...row, backend: 'ShizukuRequired' } : row)
  assert.match(failures({ operations }).join('\n'), /rootExec 的 Rust 后端应为 RootRequired/)
  assert.match(failures({ rootAsShizuku: true }).join('\n'), /uid 0 不得冒充普通 Shizuku/)
})

test('负控：旧控制链复活必须判红', () => {
  assert.match(failures({ legacyRefs: ['ControlCarrier@app/x.kt'] }).join('\n'), /旧注册链不可达/)
})

function isolatedTree({ rust = 'pub static OPERATIONS: &[OperationSpec] = &[\n    spec("snapshot", TargetDomain::AndroidDisplay, BackendRequirement::A11yPreferred, ScopePolicy::ScreenContent, true),\n];\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-contract-'))
  mkdirSync(join(root, 'native/phone-control-core/src'), { recursive: true })
  writeFileSync(join(root, 'native/phone-control-core/src/policy.rs'), rust)
  const shell = join(root, 'app/src/main/java/com/dsharnessmobile/shell/nativecontrol')
  mkdirSync(shell, { recursive: true })
  // CLI 先定位两棵树，再读 Rust；这里只制造「锚点改名」，两棵树都必须看起来完整。
  mkdirSync(join(root, 'plugins/dsh-android-phone-control/src'), { recursive: true })
  writeFileSync(join(root, 'plugins/dsh-android-phone-control/src/native-bridge.ts'), 'export const NATIVE_CONTROL_OPERATIONS = []\n')
  return root
}

test('CLI：Rust 锚点改名时 fail-closed', () => {
  const root = isolatedTree({ rust: 'pub static NOT_OPERATIONS = &[];\n' })
  try {
    const result = spawnSync(process.execPath, [script, '--shell-root', root, '--plugin-root', root], { encoding: 'utf8' })
    const out = (result.stdout ?? '') + (result.stderr ?? '')
    assert.equal(result.status, 1, out)
    assert.match(out, /解析不到 Rust OPERATIONS/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('CLI：真实仓库扫描通过', () => {
  const result = spawnSync(process.execPath, [script], { cwd: coord, encoding: 'utf8' })
  const out = (result.stdout ?? '') + (result.stderr ?? '')
  assert.equal(result.status, 0, out)
  assert.match(out, /CHECK-CONTROL-OPS PASSED/)
  assert.doesNotMatch(out, /FAIL {2}/)
})
