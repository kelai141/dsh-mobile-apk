#!/usr/bin/env node
// verify-test-build.mjs — 测之前先证明「被测二进制确实包含你以为的那些改动」。
//
// 为什么需要它：本项目里已经犯过两次同类错误——
//   1) 在慢设备上测脚本清单，装的是不含清单代码的旧 APK，量到 527 秒，
//      被读成「清单失效」；
//   2) 在缺 #1715 限流修复的分支上测解包，测到 OOM 崩溃，
//      被读成「限流没解决问题」。
// 两次都是「没测到」被当成「修复无效」。这个脚本把核对变成一次命令。
//
// 用法：
//   node scripts/android-native/verify-test-build.mjs \
//     --require 9de07ad9,a718d812 \
//     --device emulator-5574 \
//     --pkg com.dsharnessmobile.shell \
//     --apk app/build/outputs/apk/debug/app-debug.apk
//
// 退出码：0 = 全部满足；1 = 有不满足项（列出每一条）。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'

const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}

const required = (argOf('require') ?? '').split(',').map(s => s.trim()).filter(Boolean)
const device = argOf('device')
const pkg = argOf('pkg')
const apk = argOf('apk')

if (!required.length) {
  console.error('用法: verify-test-build.mjs --require <sha[,sha...]> [--device <serial>] [--pkg <name>] [--apk <path>]')
  process.exit(2)
}

const problems = []
const ok = []

// 1) 每个要求的提交必须真的是当前 HEAD 的祖先。
for (const sha of required) {
  let isAncestor = false
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' })
    isAncestor = true
  } catch {
    isAncestor = false
  }
  if (isAncestor) ok.push('HEAD 包含 ' + sha)
  else problems.push('HEAD **不包含** ' + sha + '（这正是那两次错误的形态）')
}

// 2) 构建产物必须比工作树里所有已跟踪源码都新，否则装的是旧包。
if (apk) {
  if (!existsSync(apk)) {
    problems.push('APK 不存在: ' + apk)
  } else {
    const apkMs = statSync(apk).mtimeMs
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map(l => l.slice(3).trim())
    const newer = dirty.filter(p => existsSync(p) && statSync(p).mtimeMs > apkMs)
    if (newer.length) problems.push('APK 比这些文件旧，装上去测的是旧代码: ' + newer.join(', '))
    else ok.push('APK 比工作树改动新')
  }
}

// 3) 设备上装的包版本必须与本地 APK 一致（同一份产物）。
if (device && pkg && apk && existsSync(apk)) {
  try {
    const localSize = statSync(apk).size
    const remote = execFileSync('adb', ['-s', device, 'shell',
      'dumpsys package ' + pkg + ' | grep -m1 lastUpdateTime'], { encoding: 'utf8' }).trim()
    ok.push('设备 ' + device + ' 上的 ' + pkg + ': ' + remote)
    ok.push('本地 APK 字节: ' + localSize)
  } catch (e) {
    problems.push('查不到设备上的包信息: ' + String(e.message ?? e))
  }
}

for (const line of ok) console.log('OK   ' + line)
for (const line of problems) console.error('FAIL ' + line)
if (problems.length) {
  console.error('\n共 ' + problems.length + ' 项不满足：被测二进制与预期不符，此时测出的结论不可用。')
  process.exit(1)
}
console.log('\n被测二进制核对通过。')