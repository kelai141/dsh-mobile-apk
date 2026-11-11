#!/usr/bin/env node
// check-input-config-changes.mjs — 外接输入设备（键盘/鼠标）插拔不得重建 Activity
//
// 背景（issue #1719）：Android 在 `Configuration` 的 `keyboard` / `navigation` 发生变化时，
// 只把变化交给声明了对应 `android:configChanges` 的 Activity；没声明就销毁重建。外接键鼠
// 插拔（含 Type-C 扩展坞）正是这两项变化的来源，重建会让 WebView 重建、启动流重跑，
// 表现成用户可见的"引擎重启/界面重载"。
//
// 判据：`MainActivity` / `ConsoleActivity` / `RepairActivity` 的 `configChanges` 必须同时
// 声明 `keyboard` 与 `navigation`（`keyboardHidden` 只表示软键盘是否展开，覆盖不了设备插拔）。
//
// 用法：
//   node scripts/check-input-config-changes.mjs [--root <tree>]   真实树检查
//   node scripts/check-input-config-changes.mjs --self-test       正/负夹具自测
// 退出码：0 = 通过；1 = 失败；2 = 树/文件缺失（无法判定）
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const OVERRIDE = rootIdx >= 0 ? argv[rootIdx + 1] : process.env.DSH_APK_ROOT
const SELF_TEST = argv.includes('--self-test')

/** 必须守住的 Activity 与它必须声明的配置项。 */
const REQUIRED = [
  { name: 'MainActivity', must: ['keyboard', 'navigation'] },
  { name: 'ConsoleActivity', must: ['keyboard', 'navigation'] },
  { name: 'RepairActivity', must: ['keyboard', 'navigation'] },
]

const hasApkTree = (dir) => existsSync(join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'))
const CANDIDATES = OVERRIDE
  ? [resolve(OVERRIDE)]
  : [ROOT, join(ROOT, 'dsh-mobile-apk'), resolve(join(ROOT, '..'))]

/** 取 <activity name=...> 节点的 configChanges 声明（结构解析，不是整行 grep）。 */
export function activityConfigChanges(manifestText, activityName) {
  const re = new RegExp('<activity\\b[^>]*?>', 'g')
  const matches = manifestText.match(re) ?? []
  for (const tag of matches) {
    const nameMatch = tag.match(/android:name\s*=\s*"([^"]+)"/)
    if (!nameMatch) continue
    const name = nameMatch[1]
    const tail = name.split('.').pop()
    if (tail !== activityName) continue
    const cc = tag.match(/android:configChanges\s*=\s*"([^"]*)"/)
    return cc ? cc[1].split('|').map((s) => s.trim()).filter(Boolean) : []
  }
  return null
}

/** 返回缺失项列表；空数组 = 通过。 */
export function evaluate(manifestText) {
  const missing = []
  for (const { name, must } of REQUIRED) {
    const declared = activityConfigChanges(manifestText, name)
    if (declared === null) {
      missing.push({ activity: name, reason: 'activity 节点不在场' })
      continue
    }
    const absent = must.filter((key) => !declared.includes(key))
    if (absent.length) missing.push({ activity: name, reason: 'configChanges 缺 ' + absent.join(' / '), declared })
  }
  return missing
}

function runRealCheck() {
  const apkRoot = CANDIDATES.find(hasApkTree)
  if (!apkRoot) {
    console.error('INPUT-CONFIG-CHANGES FAILED：找不到含 app/src/main/AndroidManifest.xml 的树')
    return 2
  }
  const manifest = join(apkRoot, 'app', 'src', 'main', 'AndroidManifest.xml')
  const missing = evaluate(readFileSync(manifest, 'utf8'))
  if (!missing.length) {
    console.log('CHECK-INPUT-CONFIG-CHANGES PASSED（插拔外接键鼠不会重建 Activity）')
    return 0
  }
  console.error('CHECK-INPUT-CONFIG-CHANGES FAILED（' + missing.length + ' 项）：')
  for (const item of missing) {
    console.error('  - ' + item.activity + '：' + item.reason)
  }
  console.error('  说明：外接键鼠插拔会改变 Configuration.keyboard / navigation；未声明就重建 Activity，')
  console.error('        重建会重跑启动流并被当成引擎重启（issue #1719）。请补 keyboard|navigation。')
  return 1
}

function makeFixture(dir, configChanges) {
  mkdirSync(join(dir, 'app', 'src', 'main'), { recursive: true })
  const activity = (name) =>
    '<activity android:name=".' + name + '" android:configChanges="' + configChanges + '" />'
  writeFileSync(
    join(dir, 'app', 'src', 'main', 'AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application>'
      + activity('MainActivity')
      + activity('ConsoleActivity')
      + activity('RepairActivity')
      + '</application></manifest>',
  )
}

function runSelfTest() {
  const base = mkdtempSync(join(tmpdir(), 'input-config-'))
  try {
    const good = join(base, 'good')
    makeFixture(good, 'orientation|screenSize|screenLayout|keyboardHidden|keyboard|navigation|uiMode')
    const goodMissing = evaluate(readFileSync(join(good, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8'))
    if (goodMissing.length) throw new Error('正例不应判红：' + JSON.stringify(goodMissing))

    const bad = join(base, 'bad')
    makeFixture(bad, 'orientation|screenSize|screenLayout|keyboardHidden|uiMode')
    const badMissing = evaluate(readFileSync(join(bad, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8'))
    if (badMissing.length !== REQUIRED.length) throw new Error('负例应判 3 项，实际 ' + badMissing.length)

    console.log('CHECK-INPUT-CONFIG-CHANGES SELF-TEST PASSED（正例放行、负例逐项判红）')
    return 0
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

if (SELF_TEST) process.exit(runSelfTest())
process.exit(runRealCheck())
