#!/usr/bin/env node
// CI resolves the stale transitive graph before npm ci, then records the actual lock bytes.
// Source-only adaptation updates declarations, not fabricated resolved graphs or hashes.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { checkPackageLockRoot, lockDiffSummary, lockRewriteProblem } from './check-package-lock-roots.mjs'

const [directoryArg, reportArg] = process.argv.slice(2)
if (!directoryArg || !reportArg || process.argv.length !== 4) {
  throw new Error('usage: node install-project-dependencies.mjs <package-directory> <lock-resolution-report.json>')
}
const directory = resolve(directoryArg)
const manifestPath = join(directory, 'package.json')
const lockPath = join(directory, 'package-lock.json')
if (!existsSync(manifestPath) || !existsSync(lockPath)) throw new Error('project package manifest/lock missing: ' + directoryArg)
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const inputLockRaw = readFileSync(lockPath, 'utf8')
const inputLockSha256 = sha256(lockPath)
const manifestSha256 = sha256(manifestPath)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
/**
 * 取件器可注入（**只给测试用**，正式链一律不设）：`DSH_NPM_TEST_STUB` 指向一个 node 脚本时，
 * 所有 npm 调用改成 `node <stub> <args…>`。
 *
 * 为什么需要这条缝：issue #1615 的判据是「锁文件被就地重写时**在 npm ci 之前**中止」。
 * 这条判据有两个面——判得对（纯函数可证）与**判在装之前**（顺序，只有真跑才能证）。
 * Windows 上 Node 拒绝不经 shell 地 spawn npm.cmd，真 npm 起不来；有了这条缝，
 * 测试可以给一个「会改写 lock 的假 npm」，并记录它到底有没有被以 ci 调用过 ——
 * 顺序就此变成可断言的事实，而不是读源码位置得出的结论。
 */
const NPM_STUB = process.env.DSH_NPM_TEST_STUB
const runNpm = (args, opts) => (NPM_STUB
  ? execFileSync(process.execPath, [NPM_STUB, ...args], opts)
  : execFileSync(npm, args, opts))
// --ignore-scripts resolves metadata without executing lifecycle scripts; npm ci follows only this realized graph.
runNpm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' })
if (sha256(manifestPath) !== manifestSha256) throw new Error('lock-only resolution unexpectedly modified package.json')
const errors = checkPackageLockRoot(directory)
if (errors.length) throw new Error(errors.join('\n'))
const resolvedLockSha256 = sha256(lockPath)
/**
 * issue #1615：`npm install --package-lock-only` 会**就地重写**仓内的 package-lock.json。
 * 旧实现只把 inputLockSha256 / resolvedLockSha256 记进报告（「只记不判」），于是「提交的 lock 缺
 * resolved/integrity」时 CI 从 registry 补齐后照单 `npm ci`，报告里两个哈希不同而链是绿的。
 * 这里在 `npm ci` **之前**判红：锁文件可以变，但必须先在 PR 里显式更新并提交，不能由 CI 静默补。
 * 顺序很重要 —— 先判后装，避免照着一张没人审过的图装出一棵树。
 */
const rewriteProblem = lockRewriteProblem({ inputLockSha256, resolvedLockSha256 })
if (rewriteProblem !== null) {
  // 把「重写了什么」打到日志里：差异只活在一个哈希里时，排查者无法判断影响面。
  try {
    const diff = lockDiffSummary(JSON.parse(inputLockRaw), JSON.parse(readFileSync(lockPath, 'utf8')))
    console.error('lock 差异: 新增 ' + diff.counts.added + ' 条 / 删除 ' + diff.counts.removed + ' 条 / 变更 ' + diff.counts.changed + ' 条')
    if (diff.added.length > 0) console.error('  新增(前 ' + diff.added.length + '): ' + diff.added.join(', '))
    if (diff.removed.length > 0) console.error('  删除(前 ' + diff.removed.length + '): ' + diff.removed.join(', '))
    if (diff.changed.length > 0) console.error('  变更(前 ' + diff.changed.length + '): ' + diff.changed.join(', '))
  } catch (e) {
    console.error('lock 差异无法解析: ' + String(e.message).split('\n')[0])
  }
  throw new Error(rewriteProblem)
}
runNpm(['ci', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' })
if (sha256(lockPath) !== resolvedLockSha256 || sha256(manifestPath) !== manifestSha256) {
  throw new Error('npm ci modified its resolved input manifest/lock')
}
const reportPath = resolve(reportArg)
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { packages: {} }
const key = relative(process.cwd(), directory).replaceAll('\\', '/')
report.packages[key] = {
  manifestSha256, inputLockSha256, resolvedLockSha256,
  lockfileVersion: JSON.parse(readFileSync(lockPath, 'utf8')).lockfileVersion,
  resolution: 'npm install --package-lock-only --ignore-scripts; npm ci',
  nodeVersion: process.version,
}
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log('resolved project lock: ' + key + ' ' + resolvedLockSha256)
