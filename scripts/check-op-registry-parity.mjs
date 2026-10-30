#!/usr/bin/env node
// check-op-registry-parity.mjs —— 跨语言 op 清单对等门禁（0.14.1 块N）。
//
// 为什么需要（0.14.1 设备实测缺陷 B4 的直接根因）：
//   「会读设备屏的 op」有**两份**清单——引擎 `plugins/dsh-android-bridge/src/screen-scope.ts` 的
//   `REAL_SCREEN_CONTROL_OPS` 与壳侧 `app/src/main/java/com/dsharnessmobile/shell/DeviceControlService.kt`
//   的 `REAL_SCREEN_OPS`。两份不一致时没有任何一层为不一致负责：
//   壳侧曾把 `state`/`webSnapshot`/`webAction` 也算成真实屏 op（那是 `A11Y_OPS` 后端能力清单的陈旧拷贝），
//   而这三条都不带 `screenId` ⇒ 默认 real ⇒ 在缺省范围 virtual-only 下被壳侧范围门拦死。
//   后果：android_web_dump、android_ui_click/ui_input 的 WebView ref 路径、以及点击生效校验
//   （verifyClick 读 `state`）**在缺省范围下全部不可用**，而引擎侧毫无察觉。
//
// 本门禁把这份一致性变成机械可判的红线：两份清单必须**逐条相同**（排序后比对）。
// 修改任一侧都要同批改另一侧——这是跨语言契约，不是实现细节。
//
// 用法：
//   node scripts/check-op-registry-parity.mjs            # 两仓布局自适应（apk 仓 / 协调仓根）
//   node scripts/check-op-registry-parity.mjs --self-test # 判别力自证（正例 / 反例 / 缺锚）
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APK_ROOT = resolve(HERE, '..')

/** 两个布局下的相对坐标（apk 仓自包含 / 协调仓带子目录）。 */
function locate(name) {
  const candidates = name === 'engine'
    ? [join(APK_ROOT, 'plugins', 'dsh-android-bridge', 'src', 'screen-scope.ts'),
       join(APK_ROOT, '..', 'plugins', 'dsh-android-bridge', 'src', 'screen-scope.ts')]
    : [join(APK_ROOT, 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'DeviceControlService.kt'),
       join(APK_ROOT, 'dsh-mobile-apk', 'app', 'src', 'main', 'java', 'com', 'dsharnessmobile', 'shell', 'DeviceControlService.kt')]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(`找不到${name === 'engine' ? '引擎' : '壳侧'}清单源文件：` + candidates.join(' | '))
}

/** 引擎面：`export const REAL_SCREEN_CONTROL_OPS: readonly string[] = [ 'a', 'b', ]` */
export function parseEngineOps(text) {
  const m = /REAL_SCREEN_CONTROL_OPS[^=]*=\s*\[([\s\S]*?)\]/.exec(text)
  if (m === null) return null
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2])
}

/** 壳侧面：`private val REAL_SCREEN_OPS = setOf( "a", "b", )` */
export function parseShellOps(text) {
  const m = /REAL_SCREEN_OPS\s*=\s*setOf\(([\s\S]*?)\)/.exec(text)
  if (m === null) return null
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])
}

const sorted = (list) => [...list].sort()

export function compare(engineOps, shellOps) {
  const a = sorted(engineOps)
  const b = sorted(shellOps)
  const missingInShell = a.filter((x) => !b.includes(x))
  const extraInShell = b.filter((x) => !a.includes(x))
  return { ok: missingInShell.length === 0 && extraInShell.length === 0, missingInShell, extraInShell }
}

function selfTest() {
  const cases = [
    ['正例：两边同 8 条', ['snapshot', 'click'], ['click', 'snapshot'], true],
    ['反例：壳侧多 3 条（0.14.1 缺陷原形）', ['snapshot'], ['snapshot', 'state', 'webSnapshot', 'webAction'], false],
    ['反例：壳侧少一条', ['snapshot', 'click'], ['snapshot'], false],
    ['反例：同名不同序不算差异', ['b', 'a'], ['a', 'b'], true],
  ]
  let failed = 0
  for (const [name, engine, shell, expect] of cases) {
    const r = compare(engine, shell)
    if (r.ok !== expect) {
      failed += 1
      console.error(`SELF-TEST FAIL：${name} 期望 ${expect} 实得 ${r.ok}`)
    }
  }
  // 解析器判别力：反例文本必须解析出预期条数，锚点缺失必须返回 null（fail-closed）。
  const engSample = "export const REAL_SCREEN_CONTROL_OPS: readonly string[] = [\n  'a', 'b',\n]"
  const shellSample = 'private val REAL_SCREEN_OPS = setOf(\n  "a", "b", "c",\n)'
  const e = parseEngineOps(engSample)
  const s = parseShellOps(shellSample)
  if (e === null || e.length !== 2) { failed += 1; console.error('SELF-TEST FAIL：引擎解析器') }
  if (s === null || s.length !== 3) { failed += 1; console.error('SELF-TEST FAIL：壳侧解析器') }
  if (parseEngineOps('const X = 1') !== null) { failed += 1; console.error('SELF-TEST FAIL：引擎锚点缺失未 fail-closed') }
  if (parseShellOps('val X = listOf("a")') !== null) { failed += 1; console.error('SELF-TEST FAIL：壳侧锚点缺失未 fail-closed') }
  if (failed > 0) {
    console.error(`CHECK-OP-REGISTRY-PARITY SELF-TEST FAILED（${failed} 例）`)
    process.exit(1)
  }
  console.log(`CHECK-OP-REGISTRY-PARITY SELF-TEST PASSED（${cases.length + 4} 例：正/反/锚点缺失）`)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const enginePath = locate('engine')
  const shellPath = locate('shell')
  const engineOps = parseEngineOps(readFileSync(enginePath, 'utf8'))
  const shellOps = parseShellOps(readFileSync(shellPath, 'utf8'))
  if (engineOps === null) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：引擎侧 REAL_SCREEN_CONTROL_OPS 未解析到（锚点被改名/改形？）\n  ' + enginePath)
    process.exit(1)
  }
  if (shellOps === null) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：壳侧 REAL_SCREEN_OPS 未解析到（锚点被改名/改形？）\n  ' + shellPath)
    process.exit(1)
  }
  // issue #1047：旧实现只比两侧差集，于是**两侧同时清空**也会「逐条相同」通过（vacuous pass）。
  // 空清单不表示一致，表示锚点被改名或正则失配 —— 任一侧为空必须判红。
  if (engineOps.length === 0 || shellOps.length === 0) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：清单解析为空（引擎 ' + engineOps.length + ' 条，壳侧 ' + shellOps.length + ' 条）——')
    console.error('  空清单不等于「一致」：多半是锚点被改名或正则失配。')
    console.error('  引擎 ' + enginePath)
    console.error('  壳侧 ' + shellPath)
    process.exit(1)
  }
  // issue #1047：旧实现只比差集，两侧同时清空也会「逐条相同」通过（vacuous）。
  // 空清单不表示一致，表示锚点/正则坏了 —— 任一侧为空必须判红。
  if (engineOps.length === 0 || shellOps.length === 0) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：清单解析为空（引擎 ' + engineOps.length + ' 条，壳侧 ' + shellOps.length + ' 条）——')
    console.error('  空清单不等于「一致」：多半是锚点被改名或正则失配。')
    process.exit(1)
  }
  const r = compare(engineOps, shellOps)
  if (!r.ok) {
    console.error('CHECK-OP-REGISTRY-PARITY FAILED：两份「会读设备屏的 op」清单不一致——')
    console.error('  引擎 ' + enginePath)
    console.error('  壳侧 ' + shellPath)
    if (r.missingInShell.length > 0) console.error('  壳侧缺少（引擎有、壳侧无）：' + r.missingInShell.join(', '))
    if (r.extraInShell.length > 0) {
      console.error('  壳侧多出（**这些 op 会被壳侧范围门按「真实屏」拦掉**）：' + r.extraInShell.join(', '))
      console.error('  修法二选一：① 该 op 确实读设备屏 → 加进引擎清单；② 它不读设备屏（元数据/自有 WebView）→ 从壳侧移除。')
      console.error('  先例：0.14.1 的 state/webSnapshot/webAction 属情形②，移除后 virtual-only 下的点击校验与 WebView 路径才恢复。')
    }
    process.exit(1)
  }
  console.log(`CHECK-OP-REGISTRY-PARITY PASSED（两份清单逐条相同，共 ${engineOps.length} 条：${sorted(engineOps).join(', ')}）`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
