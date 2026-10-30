#!/usr/bin/env node
// check-apk-form.mjs — APK 产物形态门禁（最终产物不得是 debuggable 变体）。
//
// 背景（实测，0.14.9 产物）：整条链此前跑 `:app:assembleDebug`（build-apk-engine.mjs 的 Gradle 参数、
// build-apk-dev-fast.mjs 同款），而 app/build.gradle.kts 里 debug/release 共用 signingConfigs.repoDebug。
// 于是「发布产物」本质就是 debug 变体：对 out/v0.14.9/dsh-mobile-apk-v0.14.9-arm64.apk 跑
// `aapt2 dump badging`，第 112 行正是 `application-debuggable`。它意味着应用可被任意调试器
// attach（run-as / jdwp / 调试端口），而**签名门禁对此完全无感**——它只看 v1/v2/v3 与证书身份，
// 一份「签名完全正确」的 debug 变体照样全绿。本门禁守的就是这条产物形态。
//
// 判据（只有一条）：最终产物 `aapt2 dump badging` 的 application 段不得出现独立行
// `application-debuggable`。
// **为什么不是裸子串 grep**：同名单词会出现在 package 名、application-label（本仓 87 个 locale
// 变体）、甚至别的元数据里，裸 grep 既会漏（只认 `application-debuggable:` 之类变体）也会误判。
// 判据因此做成 `parseBadging()` 纯函数：**只认行首（允许缩进）整行就是这个 flag**，单测逐形态钉住
// （行首 / 带缩进 / 被引号包住 / 只出现在 label 字符串里 / 带后缀）。
//
// 顺带证据（不参与判红）：同一次 badging 的 package / versionCode / versionName / minSdk /
// targetSdk / launchable-activity 一并打印——判红时能一眼确认验的是哪一份产物，不必回翻日志。
// **只对 debuggable 判红**：其余字段只是证据，本门禁不为它们新增判据（那是别的门禁的面）。
//
// 缺席纪律（与 scripts/check-snapshot-decode.mjs、scripts/check-gate-skips.mjs 的约定一致）：
//   · aapt2 找不到、或没有任何目标 APK ⇒ **不得当成通过**：SKIP(#n) 计数 + 结尾打印 SKIP=<n>；
//   · `--require`（发布链严格档）⇒ 缺席即判红（退出码 1）。
//   · aapt2 **在场**时不存在「跳过」：非 0 退出 / 输出为空 / 输出不可解析都是**判红**
//     ——拿不到判据不等于判据通过（这是本类门禁最容易长出来的假绿形态）。
//
// 用法：
//   node scripts/check-apk-form.mjs --apk <file> [--apk <file> ...]
//   node scripts/check-apk-form.mjs --dir <dir> [--dir <dir> ...]   # 递归收集 *.apk（跟随符号链接）
//   node scripts/check-apk-form.mjs --aapt2 <path>                  # 显式指定（缺省按 SDK 解析最新）
//   node scripts/check-apk-form.mjs --require                       # 严格档：缺席即判红
//   node scripts/check-apk-form.mjs --self-test                     # 纯判据离线自检（不需要 SDK/APK）
//   node scripts/check-apk-form.mjs --help
// 退出码：0 = 通过（或明确计数并打印的 SKIP）；1 = 判据不满足（含严格档下的缺席）。
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * debuggable flag 行：行首（允许空格/制表符缩进）**整行**就只有这一个 flag。
 *
 * 刻意不用 \s：它包含换行，会让 `application-debuggable\n...` 这类相邻行参与匹配，
 * 在跨行文本上产生难以解释的边界行为。行内空白只允许空格与制表符。
 */
const DEBUGGABLE_FLAG_RE = /^[ \t]*application-debuggable[ \t]*$/m

const firstLines = (text, n) => String(text ?? '').trim().split(/\r?\n/).slice(0, n).join(' | ')

/**
 * 解析 `aapt2 dump badging` 文本（纯函数：自测与生产同一条路径）。
 *
 * 只做「读事实」，不做判定——判定在 evaluateBadging()，两件事分开才能各自被单测钉住。
 * 缺字段一律返回 null（不抛错）：输出被截断时由 evaluateBadging 以「缺 package 行」判红。
 */
export function parseBadging(text) {
  const src = String(text ?? '')
  // versionCode / versionName 只从 package 行取：badging 里别处也可能是同名字段。
  const pkgLine = (/^package: .*$/m.exec(src) ?? [null])[0]
  const quoted = (name) => {
    if (pkgLine === null) return null
    const m = new RegExp('\\b' + name + "='([^']*)'").exec(pkgLine)
    return m ? m[1] : null
  }
  const one = (re) => { const m = re.exec(src); return m ? m[1] : null }
  return {
    packageName: (/^package: name='([^']*)'/m.exec(src) ?? [null, null])[1],
    versionCode: quoted('versionCode'),
    versionName: quoted('versionName'),
    minSdk: one(/^minSdkVersion:'([^']*)'/m),
    targetSdk: one(/^targetSdkVersion:'([^']*)'/m),
    launchableActivity: one(/^launchable-activity: name='([^']*)'/m),
    debuggable: DEBUGGABLE_FLAG_RE.test(src),
  }
}

/**
 * aapt2 一次运行的判定（纯函数）。
 *
 * 顺序刻意如此：先排「拿不到 badging」（spawn 失败 / 非 0 退出 / 空输出 / 缺 package 行），
 * 再看 debuggable——否则「aapt2 报错、输出为空」会被读成「没有 debuggable 行 = 通过」。
 */
export function evaluateBadging({ exitCode, output, spawnError }) {
  if (spawnError) return { ok: false, why: 'aapt2 无法启动：' + String(spawnError.message ?? spawnError) }
  const text = String(output ?? '')
  if (exitCode !== 0) {
    return { ok: false, why: 'aapt2 退出码 ' + String(exitCode ?? 'null') + '（badging 未产出，不得当成通过）：' + firstLines(text, 2) }
  }
  if (text.trim() === '') return { ok: false, why: 'aapt2 输出为空（不得当成通过）' }
  const parsed = parseBadging(text)
  if (!parsed.packageName) return { ok: false, why: 'aapt2 输出不可解析（缺 package 行，输出可能被截断）：' + firstLines(text, 2) }
  if (parsed.debuggable) return { ok: false, parsed, why: 'badging 含独立行 application-debuggable（产物是 debuggable 变体）' }
  return { ok: true, parsed }
}

/** 递归收集 `.apk`，**跟随符号链接**（Dirent 对链接两种判定都为 false；与签名门禁同口径）。 */
export function collectApkFiles(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null
  const out = []
  const pending = [path.resolve(dir)]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current)) {
      const candidate = path.join(current, entry)
      let stat = null
      try { stat = fs.statSync(candidate) } catch { continue }
      if (stat.isDirectory()) pending.push(candidate)
      else if (stat.isFile() && entry.toLowerCase().endsWith('.apk')) out.push(candidate)
    }
  }
  return out
}

/**
 * 按 SDK 布局解析 aapt2（与 check-apk-signatures.mjs 的 resolveApksigner 同写法）：
 * ANDROID_HOME / ANDROID_SDK_ROOT / LOCALAPPDATA\Android\Sdk / USERPROFILE\...，
 * 每个根下 build-tools/<version>/aapt2 全部收集，取**排序最后**的一个（即最新 build-tools）。
 */
export function resolveAapt2(explicit, platform = process.platform) {
  if (explicit) return explicit
  const name = platform === 'win32' ? 'aapt2.exe' : 'aapt2'
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  if (platform === 'win32') {
    roots.push(path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'))
    roots.push(path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Android', 'Sdk'))
  } else {
    roots.push(path.join(process.env.HOME ?? '', 'Android', 'Sdk'), '/usr/local/lib/android/sdk')
  }
  const candidates = []
  for (const root of roots.filter(Boolean)) {
    const buildTools = path.join(root, 'build-tools')
    if (!fs.existsSync(buildTools)) continue
    for (const version of fs.readdirSync(buildTools).sort()) {
      const candidate = path.join(buildTools, version, name)
      if (fs.existsSync(candidate)) candidates.push(candidate)
    }
  }
  return candidates.at(-1)
}

export function parseArgs(args) {
  const parsed = { apks: [], dirs: [], aapt2: undefined, require: false, selfTest: false, help: false }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (['--apk', '--dir', '--aapt2'].includes(arg) && (!args[i + 1] || args[i + 1].startsWith('--'))) {
      throw new Error('missing value for ' + arg)
    }
    if (arg === '--apk') parsed.apks.push(args[++i])
    else if (arg === '--dir') parsed.dirs.push(args[++i])
    else if (arg === '--aapt2') parsed.aapt2 = args[++i]
    else if (arg === '--require') parsed.require = true
    else if (arg === '--self-test') parsed.selfTest = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return parsed
}

const USAGE = 'Usage: node scripts/check-apk-form.mjs --apk <file> | --dir <dir> [--aapt2 <path>] [--require] [--self-test]'

let skipTotal = 0
let failures = 0

/**
 * 缺席（不是判据结论）必须计数且可见：`SKIP(#n)` + 结尾 `SKIP=<n>`（scripts/check-gate-skips.mjs 的 SKIP 纪律）。
 * `--require` 严格档下缺席即判红——发布链不允许「没验」以 SKIP 结案。
 */
function skip(why) {
  skipTotal += 1
  console.log('SKIP(#' + skipTotal + ')  ' + why + (strict ? ' —— --require 档不得 SKIP' : ''))
  if (strict) failures += 1
}

let strict = false

function fail(message) {
  console.error('APK form gate: FAIL: ' + message)
  failures += 1
}

function finish(checked) {
  console.log('SKIP=' + skipTotal)
  if (failures > 0) {
    console.error('APK-FORM CHECK FAILED：' + failures + '/' + checked + ' 个 APK 未通过产物形态判据（SKIP=' + skipTotal + '）')
    process.exit(1)
  }
  if (skipTotal > 0) {
    console.log('APK-FORM CHECK 未作判定（SKIP=' + skipTotal + '；严格档 --require 下这会是红）')
    process.exit(0)
  }
  console.log('PASS 全部 ' + checked + ' 个最终 APK 均不含 application-debuggable')
  process.exit(0)
}

function runSelfTest() {
  const releaseBadging = [
    "package: name='com.dsharnessmobile.shell' versionCode='53' versionName='0.14.9' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'",
    "minSdkVersion:'26'",
    "targetSdkVersion:'34'",
    "application-label:'DeepCode'",
    "application-label-ja:'DeepCode'",
    "application: label='DeepCode' icon='res/mipmap-anydpi-v26/ic_launcher.xml'",
    "launchable-activity: name='com.dsharnessmobile.shell.MainActivity'  label='' icon=''",
    "feature-group: label=''",
    '  uses-feature: name=\'android.hardware.faketouch\'',
  ].join('\n')
  const debugBadging = releaseBadging.replace(
    "launchable-activity:",
    'application-debuggable\nlaunchable-activity:',
  )
  const cases = [
    // 判据本体：flag 行各种真实/诱导形态
    ['行首独立行 = debuggable', parseBadging(debugBadging).debuggable, true],
    ['无该行的正常产物 = 非 debuggable', parseBadging(releaseBadging).debuggable, false],
    ['带缩进的 flag 行同样判出', parseBadging('  application-debuggable\n').debuggable, true],
    ['带行尾空白/CRLF 同样判出', parseBadging('application-debuggable \r\n').debuggable, true],
    ['只出现在 application-label 里不算', parseBadging("application-label:'application-debuggable'\n").debuggable, false],
    ['被引号整行包住不算（不是 flag 行）', parseBadging('"application-debuggable"\n').debuggable, false],
    ['带后缀的短语不算', parseBadging('application-debuggable-extra\n').debuggable, false],
    ['前缀粘连不算', parseBadging('xapplication-debuggable\n').debuggable, false],
    // 字段解析（证据面）
    ['package 字段解析', [parseBadging(releaseBadging).packageName, parseBadging(releaseBadging).versionCode, parseBadging(releaseBadging).versionName].join('|'), 'com.dsharnessmobile.shell|53|0.14.9'],
    ['sdk 字段解析', [parseBadging(releaseBadging).minSdk, parseBadging(releaseBadging).targetSdk].join('|'), '26|34'],
    ['launchable-activity 解析', parseBadging(releaseBadging).launchableActivity, 'com.dsharnessmobile.shell.MainActivity'],
    ['缺字段返回 null（不抛错）', parseBadging('package: name=\'x\'\n').minSdk, null],
    // 判定：拿不到 badging 一律不得当成通过
    ['正常输出判绿', evaluateBadging({ exitCode: 0, output: releaseBadging }).ok, true],
    ['debuggable 判红', evaluateBadging({ exitCode: 0, output: debugBadging }).ok, false],
    ['aapt2 非 0 退出判红', evaluateBadging({ exitCode: 1, output: releaseBadging }).ok, false],
    ['aapt2 空输出判红', evaluateBadging({ exitCode: 0, output: '   \n' }).ok, false],
    ['缺 package 行判红（截断输出）', evaluateBadging({ exitCode: 0, output: "minSdkVersion:'26'\n" }).ok, false],
    ['aapt2 无法启动判红', evaluateBadging({ spawnError: new Error('ENOENT') }).ok, false],
  ]
  let bad = 0
  for (const [name, actual, expected] of cases) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    console.log((ok ? 'PASS' : 'FAIL') + ' self-test ' + name + ': expected=' + JSON.stringify(expected) + ' actual=' + JSON.stringify(actual))
    if (!ok) bad += 1
  }
  if (bad > 0) {
    console.error('APK-FORM SELF-TEST FAILED（' + bad + '/' + cases.length + ' 项）')
    process.exit(1)
  }
  console.log('PASS ' + cases.length + '/' + cases.length + ' APK form gate self-tests')
  process.exit(0)
}

/** 用法错误：判红并立刻收尾（退出码 1，末尾仍有 SKIP= 汇总行）。 */
function abort(message) {
  fail(message)
  return finish(0)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    return abort(error.message)
  }
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.selfTest) return runSelfTest()
  strict = options.require

  const files = [...options.apks]
  for (const dir of options.dirs) {
    const found = collectApkFiles(dir)
    if (found === null) return abort('not a directory: ' + dir)
    files.push(...found)
  }
  const unique = [...new Set(files.map((file) => path.resolve(file)))].sort()

  const aapt2 = resolveAapt2(options.aapt2)
  if (!aapt2) {
    skip('未找到 aapt2（--aapt2 / ANDROID_HOME / ANDROID_SDK_ROOT / LOCALAPPDATA\\Android\\Sdk / USERPROFILE），产物形态无从判定')
    return finish(0)
  }
  if (!fs.existsSync(aapt2)) {
    skip('指定的 aapt2 不存在：' + aapt2 + '（产物形态无从判定）')
    return finish(0)
  }
  if (!unique.length) {
    skip('未找到任何 APK（--apk/--dir 未给出或目录里没有 *.apk），产物形态无从判定')
    return finish(0)
  }

  console.log('APK form gate: aapt2=' + aapt2)
  console.log('判据：badging 不得含独立行 application-debuggable（只此一条判红）')
  for (const apk of unique) {
    if (!fs.existsSync(apk) || !fs.statSync(apk).isFile()) {
      console.error('FAIL ' + apk + ': file does not exist')
      failures += 1
      continue
    }
    console.log('\n$ ' + aapt2 + ' dump badging ' + apk)
    const result = spawnSync(aapt2, ['dump', 'badging', apk], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    const output = (result.stdout ?? '') + (result.stderr ?? '')
    const status = evaluateBadging({ exitCode: result.error ? 0 : result.status, output, spawnError: result.error })
    if (status.parsed) {
      const p = status.parsed
      console.log('package=' + p.packageName + ' versionCode=' + p.versionCode + ' versionName=' + p.versionName
        + ' minSdk=' + p.minSdk + ' targetSdk=' + p.targetSdk + ' launchable=' + p.launchableActivity)
      console.log('application-debuggable=' + p.debuggable)
    }
    console.log('aapt2 exit-code=' + String(result.status ?? 'null'))
    if (!status.ok) {
      console.error('FAIL ' + apk + ': ' + status.why)
      failures += 1
    } else console.log('PASS ' + apk + '（无 application-debuggable）')
  }
  return finish(unique.length)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
