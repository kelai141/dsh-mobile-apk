// issue #1079：hot-push 丢弃 rm -rf / mkdir / am 三处下游状态。
//
// 缺陷形态：脚本只检查 `adb push` 与 `chmod` 的返回码，而 `rm -rf stage`、`mkdir -p stage`、
// 以及 --restart 的 `am force-stop` / `am start` 全部丢弃。后果分两类：
//  1) 清理失败 -> push 合并进残留目录 -> cp -r stage/lib/. 把插件 A 的文件搬进插件 B 的包，
//     仍打印 HOT-PUSH OK 并 exit 0；
//  2) 重启失败 -> 引擎是死的，而调用方以为已重启。
//
// 判据用注入的假 adb 驱动真实脚本：这是唯一能覆盖「状态被丢弃」的观测面——源码里有没有
// `if (status)` 只是手段，可断言的事实是失败时的退出码与文案。
//
// 为什么用注入而不是 PATH 上的假 adb：Windows 上 `spawnSync('adb')` 走 PATHEXT 优先命中
// `adb.exe`，不会选中 `adb.cmd`（实测：PATH 里放 adb.cmd，spawnSync('adb') 仍跑到真 adb）。
// PATH 级 shim 在 CI（Linux）与本地（Windows）行为不一致 = 假绿温床。注入点在源码里显式。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run } from './hot-push.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const LIB = join(ROOT, 'plugins', 'dsh-android-bridge', 'lib')

// 保证被测插件的 lib/ 在场。
//
// 为什么必须做：脚本在 lib/ 缺席时提前 exit 1，于是「失败必须非零退出」这类断言会因为
// 「根本没跑到那一步」而恒真——本文件第一版就是这样假绿的（三条反证全过，正控一跑就
// 暴露「构建产物缺席」）。先备好 lib/，反证才有意义。
// `plugins/*/lib/` 在 .gitignore 内，建出来不进版本库。
function ensureLib() {
  if (!existsSync(LIB)) {
    mkdirSync(LIB, { recursive: true })
    writeFileSync(join(LIB, 'index.js'), 'export {}', 'utf8')
  }
}

// 造一个假 adb：按 plan 里的 match 决定哪条子命令返回非零，其余一律 0。
function makeAdb(plan) {
  const calls = []
  const adb = (args) => {
    const joined = args.join(' ')
    calls.push(joined)
    for (const rule of plan) {
      if (joined.includes(rule.match)) {
        return { status: rule.code, stdout: rule.stdout || '', stderr: rule.stderr || '' }
      }
    }
    return { status: 0, stdout: 'OK', stderr: '' }
  }
  const factory = () => adb
  factory.calls = calls
  return factory
}

// 静默 io，避免测试输出污染。
const QUIET = { log: () => {}, err: () => {} }

function push(plan, extraArgs) {
  ensureLib()
  const factory = makeAdb(plan)
  const base = ['--serial', 'fake:1', '--plugin', 'plugins/dsh-android-bridge']
  const code = run(base.concat(extraArgs || []), factory, QUIET)
  return { code, calls: factory.calls }
}

test('#1079 反证：rm -rf stage 失败时必须判失败，且不得继续 push', () => {
  const r = push([{ match: 'rm -rf /data/local/tmp/dsh-hot-push', code: 1, stderr: 'rm: Permission denied' }])
  assert.notEqual(r.code, 0, '清理失败必须非零退出')
  assert.equal(r.calls.some((c) => c.startsWith('push')), false, '清理失败后不得继续 push（否则会合并进残留目录）')
})

test('#1079 反证：mkdir -p stage 失败时必须判失败，且不得 push', () => {
  const r = push([{ match: 'mkdir -p /data/local/tmp/dsh-hot-push', code: 1, stderr: 'mkdir: failed' }])
  assert.notEqual(r.code, 0, 'mkdir 失败必须非零退出')
  assert.equal(r.calls.some((c) => c.startsWith('push')), false, 'mkdir 失败后不得继续 push')
})

test('#1079 反证：--restart 时 am start 失败必须判失败', () => {
  const r = push([{ match: 'am start', code: 1, stderr: 'Error: Activity not started' }], ['--restart'])
  assert.notEqual(r.code, 0, 'am start 失败必须非零退出（否则调用方对着已停止的引擎做验证）')
})

test('#1079 正控：全部成功时退出 0，且清理 -> 建目录 -> push 顺序正确', () => {
  const r = push([])
  assert.equal(r.code, 0, '全成功必须 exit 0')
  const clean = r.calls.findIndex((c) => c.startsWith('shell rm -rf /data/local/tmp/dsh-hot-push'))
  const mk = r.calls.findIndex((c) => c.startsWith('shell mkdir -p'))
  const pushAt = r.calls.findIndex((c) => c.startsWith('push'))
  assert.ok(clean >= 0 && mk >= 0 && pushAt >= 0, '三步都必须发生')
  assert.ok(clean < pushAt && mk < pushAt, '清理与建目录必须在 push 之前')
})

test('#1079 反证：--pkg 空串必须拒绝（否则产出 node_modules//lib 并报 PASS）', () => {
  ensureLib()
  const factory = makeAdb([])
  const argv = ['--serial', 'fake:1', '--plugin', 'plugins/dsh-android-bridge', '--pkg', '']
  const code = run(argv, factory, QUIET)
  assert.notEqual(code, 0, '空 --pkg 必须非零退出')
})
