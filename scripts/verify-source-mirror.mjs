#!/usr/bin/env node
// verify-source-mirror.mjs — 一键换源的设备层判据（issue：移动端手动改源门槛高）。
//
// 契约（见 SourceMirror / SourceSettings 注释）：换源必须**双写**：
//   sources.list（立即生效）+ chosen_mirrors 单镜像软链（锁住后续 pkg 不被随机覆盖）。
// 只写前者的实测后果：用户下一次 pkg update 会把源换成随机镜像（实测被换成 mirror.mephi.ru）。
//
// 判据全部来自设备事实：
//   1) sources.list 指向镜像清单里的某个源，且格式是 pkg 认的那一行；
//   2) chosen_mirrors 是**指向同一镜像**的软链（双写），相对链接而非绝对；
//   3) apt 索引确实刷新（var/lib/apt/lists 里有该 host 的 Packages）。
//
// 用法：node scripts/verify-source-mirror.mjs --serial 127.0.0.1:16416 [--expect tuna]

import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const argOf = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? def) : def }
const SERIAL = argOf('serial', '')
const PKG = argOf('pkg', 'com.dsharnessmobile.shell')
const EXPECT = argOf('expect', '')
if (!SERIAL) { console.error('用法：--serial <adb-serial>'); process.exit(2) }

const fail = (m) => { console.error('SOURCE-MIRROR FAILED: ' + m); process.exit(1) }
const ok = (m, d) => console.log('PASS ' + m + (d === undefined ? '' : '  -> ' + d))

const runas = (args) => spawnSync('adb', ['-s', SERIAL, 'shell', 'run-as', PKG, ...args], { encoding: 'utf8' })

const marker = runas(['cat', 'files/.snapshot-transaction'])
if ((marker.status ?? 1) === 0 && (marker.stdout || '').trim() !== '') {
  fail('快照事务仍在进行，此刻不可做设备判据')
}

const list = runas(['cat', 'files/usr/etc/apt/sources.list'])
const listText = (list.stdout || '').trim()
if (!listText.startsWith('deb ')) fail('sources.list 不是 apt 认的 deb 行：' + JSON.stringify(listText))
ok('sources.list 可解析', listText)

const url = listText.split(/\s+/)[1] || ''
if (!/^https?:\/\/.+/.test(url)) fail('sources.list 里的源地址不是 http(s)：' + JSON.stringify(url))

if (EXPECT && !url.includes(EXPECT)) fail('期望源含 ' + EXPECT + '，实际是 ' + url)
if (EXPECT) ok('源已切到期望值', EXPECT)

// 双写判据：chosen_mirrors 必须是软链，且指向与 sources.list 同一个镜像。
// 但出厂快照里它**本来就不存在**（用户从没换过源），那是正确状态、不是缺陷。
// 区分方式：出厂 sources.list 指向的是快照自带的源；只要用户在本 App 里换过源，
// 就必然是双写写入的，此时链接必须存在。--expect 指定了期望源 = 本轮换过源。
const link = runas(['ls', '-l', 'files/usr/etc/termux/chosen_mirrors'])
const linkText = (link.stdout || '').trim()
const linkExists = (link.status ?? 1) === 0 && linkText !== ''
if (!linkExists) {
  if (EXPECT) {
    fail('换过源却没有 chosen_mirrors——只写 sources.list 会被用户下一次 pkg update 随机覆盖（实测被换成 mirror.mephi.ru）')
  }
  console.log('PASS 未换过源：chosen_mirrors 不存在（出厂状态，正确）')
  console.log('VERIFY-SOURCE-MIRROR PASSED')
  process.exit(0)
}
if (!linkText.includes('->')) fail('chosen_mirrors 不是符号链接：' + JSON.stringify(linkText))
ok('chosen_mirrors 是符号链接', linkText.split('->').pop().trim())

const target = linkText.split('->').pop().trim()
// 必须是相对链接：快照目录整体搬迁时绝对链接会断。
if (target.startsWith('/')) fail('chosen_mirrors 用了绝对路径，快照搬迁后会变成断链：' + target)
ok('chosen_mirrors 是相对链接（搬迁安全）')

const host = (/^https?:\/\/([^/]+)/.exec(url) || [])[1] || ''
if (!target.includes(host)) {
  fail('双写不一致：sources.list 指向 ' + host + '，chosen_mirrors 指向 ' + target + '（下次 pkg 会把源换掉）')
}
ok('双写一致：两处指向同一镜像', host)

// 索引刷新判据：lists 目录里必须有该 host 的 Packages 索引。
const lists = runas(['ls', 'files/usr/var/lib/apt/lists'])
const listsText = lists.stdout || ''
if (!listsText.includes(host)) {
  fail('apt 索引里没有 ' + host + ' 的记录；换源后必须跑一次 apt-get update（否则 install 报 Unable to locate package）')
}
ok('apt 索引已按新源刷新', host)

console.log('VERIFY-SOURCE-MIRROR PASSED')
