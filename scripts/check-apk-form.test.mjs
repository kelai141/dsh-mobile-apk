import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBadging, evaluateBadging } from './check-apk-form.mjs'

// 真实 aapt2 dump badging 形态（0.14.9 产物实测样本节选）。
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

// 同一份产物加上 debug 变体独有的那一行（实测：debug APK 的 badging 第 112 行）。
const debugBadging = releaseBadging.replace('launchable-activity:', 'application-debuggable\nlaunchable-activity:')

const GATE = fileURLToPath(new URL('./check-apk-form.mjs', import.meta.url))

const gate = (args, options = {}) => spawnSync(process.execPath, [GATE, ...args], { encoding: 'utf8', ...options })


test('parses the evidence fields of a real badging dump', () => {
  const parsed = parseBadging(releaseBadging)
  assert.equal(parsed.packageName, 'com.dsharnessmobile.shell')
  assert.equal(parsed.versionCode, '53')
  assert.equal(parsed.versionName, '0.14.9')
  assert.equal(parsed.minSdk, '26')
  assert.equal(parsed.targetSdk, '34')
  assert.equal(parsed.launchableActivity, 'com.dsharnessmobile.shell.MainActivity')
  assert.equal(parsed.debuggable, false)
})

test('reports the debuggable flag only when it is its own line', () => {
  assert.equal(parseBadging(debugBadging).debuggable, true)
  assert.equal(parseBadging(releaseBadging).debuggable, false)
  // 删掉那一行就该转绿、加回即红（受控负控的纯函数级形态）。
  const withoutFlag = debugBadging.replace(/^application-debuggable\r?\n/m, '')
  assert.equal(parseBadging(withoutFlag).debuggable, false)
  assert.equal(parseBadging(withoutFlag.replace('launchable-activity:', 'application-debuggable\nlaunchable-activity:')).debuggable, true)
})

test('accepts the flag line with surrounding indentation and trailing blanks', () => {
  for (const text of ['application-debuggable\n', '  application-debuggable\n', '\tapplication-debuggable\n',
    'application-debuggable   \n', 'application-debuggable\r\n', 'x\napplication-debuggable\ny\n']) {
    assert.equal(parseBadging(text).debuggable, true, JSON.stringify(text))
  }
})

test('does not mistake the same word inside labels, quotes, or longer tokens for the flag', () => {
  const decoys = [
    // 只出现在 label 字符串里（本仓 87 个 locale 变体就是这种形态）
    "application-label:'application-debuggable'\napplication-label-ja:'application-debuggable'\n",
    "application: label='application-debuggable' icon='ic.png'\n",
    // 整行被引号包住：不是 aapt2 的 flag 行形态
    '"application-debuggable"\n',
    "'application-debuggable'\n",
    // 带后缀 / 前缀粘连 / 中间有空格 / 带冒号
    'application-debuggable-extra\n',
    'xapplication-debuggable\n',
    'application-debuggable: true\n',
    'application -debuggable\n',
    // 只作为别的字段的值出现
    "package: name='application-debuggable.app'\n",
  ]
  for (const text of decoys) assert.equal(parseBadging(text).debuggable, false, JSON.stringify(text))
})

test('an unparseable or empty dump reports null fields instead of throwing', () => {
  const parsed = parseBadging('')
  assert.equal(parsed.packageName, null)
  assert.equal(parsed.minSdk, null)
  assert.equal(parsed.debuggable, false)
  assert.equal(parseBadging("package: name='x'\n").minSdk, null)
})

test('a normal dump passes and a debuggable dump fails', () => {
  assert.equal(evaluateBadging({ exitCode: 0, output: releaseBadging }).ok, true)
  const failed = evaluateBadging({ exitCode: 0, output: debugBadging })
  assert.equal(failed.ok, false)
  assert.match(failed.why, /application-debuggable/)
})

test('missing badging never counts as a pass', () => {
  // aapt2 非 0 退出：输出就算看起来正常也不得判绿
  assert.equal(evaluateBadging({ exitCode: 1, output: releaseBadging }).ok, false)
  assert.equal(evaluateBadging({ exitCode: 1, output: '' }).ok, false)
  // 空输出 / 只有空白
  assert.equal(evaluateBadging({ exitCode: 0, output: '' }).ok, false)
  assert.equal(evaluateBadging({ exitCode: 0, output: '  \r\n\t' }).ok, false)
  // 输出被截断（缺 package 行）
  assert.equal(evaluateBadging({ exitCode: 0, output: "minSdkVersion:'26'\n" }).ok, false)
  // aapt2 无法启动
  assert.equal(evaluateBadging({ spawnError: new Error('spawn ENOENT') }).ok, false)
})


test('an absent aapt2 is a counted SKIP, and --require turns it red', () => {
  const missingTool = ['--apk', GATE, '--aapt2', join(tmpdir(), '__dsh_no_such_aapt2__', 'aapt2')]

  const soft = gate(missingTool)
  assert.equal(soft.status, 0)
  assert.match(soft.stdout, /SKIP\(#1\)/)
  assert.match(soft.stdout, /SKIP=1/)
  assert.doesNotMatch(soft.stdout, /^PASS 全部/m)

  const strict = gate([...missingTool, '--require'])
  assert.equal(strict.status, 1)
  assert.match(strict.stdout, /SKIP\(#1\)/)
  assert.match(strict.stdout, /SKIP=1/)
})

test('an empty target set is a counted SKIP, never a silent pass', (t) => {
  // 目录存在但里面没有 *.apk：这是「没验到」，不是「验过了」。
  const emptyDir = mkdtempSync(join(tmpdir(), 'dsh-apk-form-empty-'))
  t.after(() => rmSync(emptyDir, { recursive: true, force: true }))
  const soft = gate(['--dir', emptyDir, '--aapt2', GATE])
  assert.equal(soft.status, 0)
  assert.match(soft.stdout, /SKIP=\d+/)
  assert.match(soft.stdout, /SKIP\(#1\)/)
  assert.doesNotMatch(soft.stdout, /^PASS 全部/m)

  // --dir 指向不存在的路径是用法错误（与 check-apk-signatures.mjs 同口径），不是 SKIP。
  const notADir = gate(['--dir', join(tmpdir(), '__dsh_no_such_apk_dir__'), '--aapt2', GATE])
  assert.equal(notADir.status, 1)
  assert.match(notADir.stderr, /not a directory/)
})


/**
 * 用一个「假 aapt2」驱动**真实 CLI 路径**（spawn -> 判定 -> 退出码）：
 * aapt2 就是 node 自身，首个参数 "dump" 从 spawn 的 cwd 解析成一个写进临时目录的脚本。
 * 于是同一份 check-apk-form.mjs 会真的 spawn 子进程、真的读它的 stdout 与退出码。
 */
function fakeAapt2(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-apk-form-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'dump'), [
    'const mode = process.env.DSH_FAKE_AAPT2_MODE',
    "if (mode === 'fail') { process.stderr.write('ERROR: not a valid APK\\n'); process.exit(2) }",
    "if (mode === 'silent') process.exit(0)",
    "process.stdout.write(process.env.DSH_FAKE_AAPT2_BADGING ?? '')",
  ].join('\n'))
  return dir
}

test('the CLI passes a clean badging dump and fails a debuggable one end to end', (t) => {
  const cwd = fakeAapt2(t)
  const run = (mode, badging) => gate(
    ['--apk', GATE, '--aapt2', process.execPath],
    { cwd, env: { ...process.env, DSH_FAKE_AAPT2_MODE: mode, DSH_FAKE_AAPT2_BADGING: badging } },
  )

  const clean = run('ok', releaseBadging)
  assert.equal(clean.status, 0, clean.stdout + clean.stderr)
  assert.match(clean.stdout, /application-debuggable=false/)
  assert.match(clean.stdout, /PASS .*无 application-debuggable/)
  // 证据面：同一次 badging 的版本/SDK/入口一并打印（不参与判红）
  assert.match(clean.stdout, /package=com\.dsharnessmobile\.shell versionCode=53 versionName=0\.14\.9 minSdk=26 targetSdk=34/)

  const debug = run('ok', debugBadging)
  assert.equal(debug.status, 1, debug.stdout + debug.stderr)
  assert.match(debug.stderr, /FAIL .*application-debuggable/)

  // 同一份输入只改一行（删掉 flag 行）即可从红转绿——控制变量，证明判红的正是这一行。
  const removed = run('ok', releaseBadging)
  assert.equal(removed.status, 0)
})

test('the CLI fails when aapt2 exits nonzero or prints nothing', (t) => {
  const cwd = fakeAapt2(t)
  const run = (mode, badging) => gate(
    ['--apk', GATE, '--aapt2', process.execPath],
    { cwd, env: { ...process.env, DSH_FAKE_AAPT2_MODE: mode, DSH_FAKE_AAPT2_BADGING: badging ?? '' } },
  )

  const nonzero = run('fail', releaseBadging)
  assert.equal(nonzero.status, 1)
  assert.match(nonzero.stderr, /aapt2 退出码 2/)

  const silent = run('silent', releaseBadging)
  assert.equal(silent.status, 1)
  assert.match(silent.stderr, /输出为空/)
})

test('CLI argument errors are rejected instead of silently ignored', () => {
  const missing = gate(['--apk'])
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /missing value for --apk/)
  const unknown = gate(['--nope'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown argument/)
})

test('--self-test reports every case and exits zero', () => {
  const result = gate(['--self-test'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /PASS \d+\/\d+ APK form gate self-tests/)
  assert.doesNotMatch(result.stdout, /^FAIL/m)
})
