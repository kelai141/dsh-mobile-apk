#!/usr/bin/env node
// hot-push.mjs — 开发期热更新：把本地构建产物推进设备快照树并重启引擎，无需重新打包 APK。
//
// 为什么需要它：只改「快照内 runtime」（插件 lib/*.js、client.js、引擎树）时，重新打包 APK
// （全量门禁 + 双 ABI + 装机 + 快照重解压）要十几分钟，而本脚本是秒级循环：
//   本地 npm run build -> adb push -> run-as cp 进快照树 -> 重启引擎 -> 验证 -> 满意后再正式打包。
//
// 适用面：仅「已可注入、且引擎从快照树读取」的产物（@dsh-android 插件 lib/**、client.js）。
// 不适用：壳侧 Kotlin（.kt 必须重新编译打包）——那类改动只能走 build-apk-013.ps1。
//
// 用法：
//   node scripts/hot-push.mjs --serial 127.0.0.1:16416 --plugin dsh-android-vdisplay
//   node scripts/hot-push.mjs --serial 127.0.0.1:16416 --plugin dsh-client-ui-responsive --pkg @dsh-android/dsh-client-ui-responsive
//   node scripts/hot-push.mjs ... --restart            # 推进后重启引擎
//   node scripts/hot-push.mjs ... --dry-run            # 只打印将要复制的文件
//
// 退出码：0 = 全部推送成功；非 0 = 失败（不静默）。
//
// issue #1079：本脚本曾丢弃 rm -rf / mkdir -p / am 三处下游状态，只检查 push 与 chmod。
// 后果：清理失败 -> push 合并进残留目录 -> cp -r 把插件 A 的文件搬进插件 B 的包，仍打印
// HOT-PUSH OK 并 exit 0；--restart 失败则引擎是死的，而调用方以为已重启。
// 修法：每一处 adb 调用都判 status，失败即 fail-fast 并给出该步的真因。
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/** 真 adb：绑定 serial。注入点，供测试替换（见 hot-push-status.test.mjs）。 */
export function realAdb(serial) {
  return (args, opts = {}) => spawnSync('adb', ['-s', serial, ...args], { encoding: 'utf8', ...opts })
}

/** 把 adb 调用结果格式化成一行可读真因。 */
function detail(r) {
  return String((r && (r.stderr || r.stdout)) || '').trim()
}

/**
 * 跑一次热推。
 *
 * @param argv  命令行参数（不含 node/script）
 * @param adbAt 注入的 adb 工厂：(serial) => (args) => {status, stdout, stderr}
 * @param io    输出通道（便于测试静默）
 * @returns 退出码
 */
export function run(argv, adbAt = realAdb, io = { log: console.log, err: console.error }) {
  const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
  const SERIAL = argOf('serial')
  const PLUGIN = argOf('plugin')
  const PKG = argOf('pkg')
  const RESTART = argv.includes('--restart')
  const DRY = argv.includes('--dry-run')
  const APP_ID = argOf('app') ?? 'com.dsharnessmobile.shell'

  if (!SERIAL || !PLUGIN) {
    io.err('用法: node scripts/hot-push.mjs --serial <adb-serial> --plugin <dir> [--pkg @scope/name] [--restart] [--dry-run]')
    return 2
  }
  // issue #1079：--pkg '' (空串) 曾绕过 ?? 默认值，产出 node_modules//lib 并报 PASS。
  if (PKG !== undefined && String(PKG).trim() === '') {
    io.err('--pkg 不能为空串（留空请直接省略该参数）')
    return 2
  }
  // 包名默认从「插件目录名」推导：plugins/dsh-android-bridge -> @dsh-android/dsh-android-bridge。
  const PLUGIN_BASE = basename(String(PLUGIN).replace(/[\\/]+$/, ''))
  const PKG_NAME = PKG ?? '@dsh-android/' + PLUGIN_BASE
  const SRC = join(ROOT, PLUGIN)
  const LIB = join(SRC, 'lib')
  if (!existsSync(LIB)) {
    io.err('构建产物缺席：' + relative(ROOT, LIB) + '（先在该目录 npm run build）')
    return 1
  }

  const adb = adbAt(SERIAL)
  /** 快照内该包的落点（两个 profile 都要覆盖：引擎按会话装配 profile 读树）。 */
  const PROFILE_ROOTS = [
    'files/home/.dsh/profiles/web/node_modules/' + PKG_NAME,
    'files/home/.dsh/profiles/headless/node_modules/' + PKG_NAME,
  ]

  function walk(dir, prefix = '') {
    const out = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? prefix + '/' + name : name
      if (statSync(full).isDirectory()) out.push(...walk(full, rel))
      else out.push(rel)
    }
    return out
  }
  const files = walk(LIB)
  io.log('待推送 ' + files.length + ' 个文件：' + PLUGIN + '/lib -> ' + PKG_NAME)
  for (const f of files) io.log('  ' + f)
  if (DRY) { io.log('（--dry-run：未执行任何复制）'); return 0 }

  const stage = '/data/local/tmp/dsh-hot-push'
  // issue #1079：清理与建目录的 status 曾整段丢弃。残留目录会让 push 合并、把插件 A 的
  // 文件搬进插件 B 的包，却仍打印 HOT-PUSH OK——「共享 stage」的隔离前提就是先清干净。
  const clean = adb(['shell', 'rm -rf ' + stage])
  if (clean.status !== 0) {
    io.err('stage 清理失败（共享目录残留会让多次热推的文件混在一起）：' + detail(clean))
    return 1
  }
  const mk = adb(['shell', 'mkdir -p ' + stage])
  if (mk.status !== 0) {
    io.err('stage 创建失败：' + detail(mk))
    return 1
  }
  const push = adb(['push', LIB, stage + '/lib'])
  if (push.status !== 0) {
    io.err('adb push 失败：' + (push.stderr || push.stdout || ''))
    return 1
  }
  /* 实修（0.14.2 rc.2）：adb push 在 /data/local/tmp 建的目录权限是 0771（drwxrwx--x）——others 只有
   * 「可穿越」没有「可读」，而下面用 `cp -r <stage>/lib/.` 复制时 cp 必须**列目录内容**，于是以 run-as
   * 身份（u0_aXX，属 others）读 stage 恒得 EACCES：
   *   cp: /data/local/tmp/dsh-hot-push/lib/.: Permission denied
   * 本脚本因此长期「自称可用、实际每个落点必失败」——本轮 adb 实测暴露。
   * 修法：把 stage 放开到 0755（只读拷贝源，不需要写权限给 run-as）。 */
  const chmod = adb(['shell', 'chmod -R 755 ' + stage])
  if (chmod.status !== 0) {
    io.err('stage 权限放开失败：' + (chmod.stderr || chmod.stdout || ''))
    return 1
  }

  let failures = 0
  for (const root of PROFILE_ROOTS) {
    const target = root + '/lib'
    // 用 run-as 复制到应用私有目录（adb push 无法直接写 /data/data）。
    const script = 'rm -rf ' + target + ' && mkdir -p ' + target + ' && cp -r ' + stage + '/lib/. ' + target + '/ && echo OK'
    const r = adb(['shell', 'run-as ' + APP_ID + ' sh -c ' + JSON.stringify(script)])
    const ok = r.status === 0 && String(r.stdout).includes('OK')
    io.log((ok ? 'PASS  ' : 'FAIL  ') + target)
    if (!ok) { failures++; io.err('  ' + detail(r)) }
  }
  adb(['shell', 'rm -rf ' + stage])
  if (failures > 0) { io.err('HOT-PUSH FAILED（' + failures + ' 个落点）'); return 1 }
  io.log('HOT-PUSH OK（' + files.length + ' 文件 × ' + PROFILE_ROOTS.length + ' profile）')

  if (RESTART) {
    io.log('重启应用以让引擎重读快照树…')
    // issue #1079：这两步的 status 也曾丢弃——am start 失败时引擎是死的，而后续验证
    // 会在 exit 0 的前提下对着一个已停止的引擎做，等于把「没起来」当成「起来了」。
    const stop = adb(['shell', 'am force-stop ' + APP_ID])
    if (stop.status !== 0) {
      io.err('am force-stop 失败：' + detail(stop))
      return 1
    }
    const start = adb(['shell', 'am start -n ' + APP_ID + '/.MainActivity'])
    if (start.status !== 0) {
      io.err('am start 失败，应用未重启（引擎仍是旧进程或已停止）：' + detail(start))
      return 1
    }
    io.log('已重启（等引擎 LISTEN 后自行验证）')
  }
  return 0
}

// 仅在被直接调用时执行（被 import 做测试时不跑）。
const invokedDirectly = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] } catch { return false }
})()
if (invokedDirectly) process.exit(run(process.argv.slice(2)))
