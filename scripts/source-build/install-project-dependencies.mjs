#!/usr/bin/env node
// CI resolves the stale transitive graph before npm ci, then records the actual lock bytes.
// Source-only adaptation updates declarations, not fabricated resolved graphs or hashes.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPackageLockRoot } from './check-package-lock-roots.mjs'

/**
 * 两个 lock 之间的**图差异**（issue #1615）。
 *
 * 判红只说「哈希变了」不够用：维护者需要一眼看出是**哪些包**被网络补齐/改了版本。
 * 判据口径 = packages 段的 name@version 集合（lock v2/v3 的解析图本体），
 * 缺失项与新增项分别列出；解析不了就如实说「无法解析」而不是抛错（判红理由已在调用方）。
 *
 * @param beforeText 提交进仓的 lock 原文。
 * @param afterText  npm install --package-lock-only 重写后的 lock 原文。
 * @returns 可直接拼进错误信息的多行字符串。
 */
export const lockGraphDiff = (beforeText, afterText) => {
  const entries = (text) => {
    try {
      const parsed = JSON.parse(text)
      const out = new Map()
      for (const [path, meta] of Object.entries(parsed.packages ?? {})) {
        if (path === '') continue
        out.set(path, String(meta?.version ?? '?') + (meta?.resolved ? '' : ' (no resolved)'))
      }
      return out
    } catch {
      return null
    }
  }
  const before = entries(beforeText)
  const after = entries(afterText)
  if (before === null || after === null) return '  (unparseable lock; raw sha256 differs)\n'
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k))
  const line = (label, keys, pick) => (keys.length === 0 ? '' : '  ' + label + ' (' + keys.length + '): '
    + keys.slice(0, 20).map(pick).join(', ') + (keys.length > 20 ? ' ...' : '') + '\n')
  const out = line('added by CI', added, (k) => k + '@' + after.get(k))
    + line('removed', removed, (k) => k)
    + line('changed', changed, (k) => k + ' ' + before.get(k) + ' -> ' + after.get(k))
  return out.length > 0 ? out : '  (package graph unchanged; only metadata bytes differ)\n'
}

/**
 * 判据本体（issue #1615）：重写后的 lock 必须与提交进仓的**逐字节相同**。
 *
 * 为什么不能只看图差异：lock 缺 resolved/integrity 时图可能一模一样（包名与版本都没变），
 * 只有字节不同 —— 那正是「提交的 lock 不完整、CI 从 registry 补齐」的可判形态。
 * 反过来，字节相同就必然没被重写，不必再看图。
 *
 * @returns null = 通过；否则是给维护者看的完整错误文案（含图差异面）。
 */
export const lockRewriteProblem = ({ inputSha256, resolvedSha256, inputText, resolvedText, directoryArg }) => {
  if (inputSha256 === resolvedSha256) return null
  return 'npm install --package-lock-only rewrote the committed package-lock.json ('
    + String(inputSha256).slice(0, 16) + ' -> ' + String(resolvedSha256).slice(0, 16) + ').\n'
    + 'The committed lock is incomplete (missing resolved/integrity, or stale), and CI must not silently '
    + 'resolve it from the registry and install that graph.\n'
    + 'Lock graph diff (committed -> resolved):\n' + lockGraphDiff(inputText, resolvedText)
    + 'Fix: update and commit the lock in a PR — (cd ' + directoryArg + ' && npm install --package-lock-only --ignore-scripts).'
}

/* issue #1615：CLI 段必须有 main 守卫。
 *
 * 旧写法把「读 argv / 跑 npm / 写报告」全部放在模块顶层，于是 `import` 本模块（为了单测
 * 判据本体）会当场执行 npm install —— 单测根本拿不到判据，只能靠整条来源链去间接验。
 * 守卫之后：被 import 时只导出纯函数，直接跑时才执行 CLI。
 */
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) run()

function run() {
  const [directoryArg, reportArg] = process.argv.slice(2)
  if (!directoryArg || !reportArg || process.argv.length !== 4) {
    throw new Error('usage: node install-project-dependencies.mjs <package-directory> <lock-resolution-report.json>')
  }
  const directory = resolve(directoryArg)
  const manifestPath = join(directory, 'package.json')
  const lockPath = join(directory, 'package-lock.json')
  if (!existsSync(manifestPath) || !existsSync(lockPath)) throw new Error('project package manifest/lock missing: ' + directoryArg)
  const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  /** 提交进仓的 lock 原文（issue #1615：重写后要能打印**差异面**，不能只说「哈希变了」）。 */
  const inputLockText = readFileSync(lockPath, 'utf8')
  const inputLockSha256 = sha256(lockPath)
  const manifestSha256 = sha256(manifestPath)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // --ignore-scripts resolves metadata without executing lifecycle scripts; npm ci follows only this realized graph.
  execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' })
  if (sha256(manifestPath) !== manifestSha256) throw new Error('lock-only resolution unexpectedly modified package.json')
  const errors = checkPackageLockRoot(directory)
  if (errors.length) throw new Error(errors.join('\n'))
  const resolvedLockSha256 = sha256(lockPath)
  /* issue #1615：`npm install --package-lock-only` **就地重写**了仓内的 package-lock.json，而旧实现
   * 对「重写前后是否相同」只记不判：inputLockSha256（提交进仓的那份）与 resolvedLockSha256
   * 同时写进报告，两者不等时没有任何失败 —— 于是提交的 lock 缺 resolved/integrity（手改、合并冲突
   * 解错、--package-lock-only 产物漏提交）时，CI 会静默从 registry 补齐并照着**被网络重写出来的图**安装，
   * 而整条链是绿的。报告里两个哈希不同，但没人看报告。
   *
   * 与 check-vendor-provenance 的立论同源：锁图**可以**变，但必须显式、可见 —— 先在 PR 里更新 lock。
   * 判据 = 重写后字节必须与提交进仓的字节相同；不同即判红并打印差异面（哪些包被补/被改），
   * 让「网络补齐」这件事当场暴露，而不是变成一次绿构建。 */
  const lockRewrite = lockRewriteProblem({
    inputSha256: inputLockSha256,
    resolvedSha256: resolvedLockSha256,
    inputText: inputLockText,
    resolvedText: readFileSync(lockPath, 'utf8'),
    directoryArg,
  })
  if (lockRewrite !== null) throw new Error(lockRewrite)
  execFileSync(npm, ['ci', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' })
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
}
