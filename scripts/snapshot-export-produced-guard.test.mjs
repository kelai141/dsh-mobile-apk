#!/usr/bin/env node
// snapshot-export-produced-guard.test.mjs — 快照资产导出必须判「本轮产出」（issue #1616）。
//
// 【为什么必须存在（实锤形态）】
// build-apk-013.ps1 的导出段只看 `Test-Path $apkOut`，不看 `$producedAbis`；而
// `$rejectedAbis.Count -gt 0 → exit 1` 在文件末尾，**晚于** Copy-Item + 写 .sha256。
// 于是 arm64 在 assemble **之后**的门禁被拒（内嵌快照可解压 / build-apk-engine 验签）时：
// APK 已经落在 out/v<ver>/，导出段照样把 snapshot-arm64.tar.xz + .sha256 写进发布目录，
// 然后整链 exit 1。CI 侧 publish 不会跑，但文件确实留在了发布目录里。
// 原注释把「发布目录里有 snapshot-<abi>」定义成「已校验」，而它只等价于「APK 在场 + 快照一致」，
// 与「该 ABI 通过了全部门禁」不是同一件事。
//
// 【判据（行为判据）】
//   ① 从真实脚本抽出导出段，用临时 out/ 与临时快照驱动四种状态：
//        ABI 被拒（不在 $producedAbis）+ APK 在场  → 不得落盘（旧实现会落盘）；
//        ABI 被拒 + APK 不在场                    → 同样不得落盘；
//        ABI 已产出 + 校验通过                     → 必须落盘（判据不得恒红）。
//   ② 反证：把新加的那行守卫去掉，同一「被拒」状态必须恢复落盘（证明该行承重）。
//   ③ 结构面：守卫必须出现在 Copy-Item 之前。
//
// 需要 pwsh：Linux CI 无 pwsh 时显式 skip 并打印原因，不得静默当通过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'build-apk-013.ps1')
const pwshUsable = (() => {
  try { return spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0 } catch { return false }
})()
const skipReason = 'pwsh 不可用（Linux CI 无 PowerShell）——本判据只在 Windows/pwsh 侧执行'
const GUARD = 'if ($producedAbis -notcontains $abi)'

/** 抽出导出段：从 `if ($ExportSnapshots) {` 到其匹配的闭合行（按花括号深度，不按行号猜）。 */
function extractExportBlock() {
  const lines = readFileSync(SCRIPT, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => /^if \(\$ExportSnapshots\)/.test(l.trim()))
  assert.ok(start >= 0, 'build-apk-013.ps1 里找不到 if ($ExportSnapshots) 段')
  let depth = 0
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (depth === 0 && i > start) return lines.slice(start, i + 1).join('\n')
  }
  throw new Error('导出段花括号不闭合')
}

/** 在临时目录里跑导出段：真实 APK 用占位文件，check-snapshot-asset 用桩（判据只看落盘与否）。 */
function runExport(t, { produced, apkPresent, mutate }) {
  const work = mkdtempSync(join(tmpdir(), 'snapshot-export-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const out = join(work, 'out')
  const snapDir = join(work, 'snap')
  mkdirSync(out, { recursive: true })
  mkdirSync(snapDir, { recursive: true })
  const snapIn = join(snapDir, 'snap-final2.tar.xz')
  writeFileSync(snapIn, 'snapshot-bytes')
  const gradleVer = '0.15.0'
  const suffix = ''
  const apkOut = join(out, 'dsh-mobile-apk-v' + gradleVer + suffix + '-arm64.apk')
  if (apkPresent) writeFileSync(apkOut, 'apk-bytes')
  // 桩：check-snapshot-asset.ps1 恒通过（真判据由 check-snapshot-asset 自己的测试面守）。
  const stubDir = join(work, 'stub')
  mkdirSync(stubDir, { recursive: true })
  writeFileSync(join(stubDir, 'check-snapshot-asset.ps1'), 'exit 0\n')
  const block = mutate === undefined ? extractExportBlock() : mutate(extractExportBlock())
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$Root = ' + JSON.stringify(work),
    '$Out = ' + JSON.stringify(out),
    '$GradleVer = ' + JSON.stringify(gradleVer),
    '$Suffix = ' + JSON.stringify(suffix),
    '$OnlyAbi = ""',
    '$ExportSnapshots = $true',
    '$producedAbis = @(' + produced.map((a) => "'" + a + "'").join(',') + ')',
    '$rejectedAbis = @()',
    '$PSScriptRoot = ' + JSON.stringify(stubDir),
    // 导出段用 .deploy-tmp\build-\13-<abi>\snap-final2.tar.xz 推导输入；这里把该路径指到临时快照。
    '$snapInOverride = ' + JSON.stringify(snapIn),
    'function Deny-Abi([string]$Abi, [string]$Reason) { Write-Host "拒绝打包（$Abi）：$Reason"; $script:rejectedAbis += $Abi }',
    block.replace(/\$snapIn = Join-Path \$Root "[^"]*"/, '$snapIn = $snapInOverride'),
    '',
  ].join('\n')
  const p = join(work, 'run.ps1')
  writeFileSync(p, script)
  const r = spawnSync('pwsh', ['-NoProfile', '-File', p], { encoding: 'utf8', timeout: 120000 })
  return {
    status: r.status,
    output: (r.stdout ?? '') + (r.stderr ?? ''),
    exported: existsSync(join(out, 'snapshot-arm64.tar.xz')),
    exportedSha: existsSync(join(out, 'snapshot-arm64.tar.xz.sha256')),
  }
}

test('导出段：ABI 未通过全部门禁时不得落盘（即使 APK 已在目录里）', { skip: pwshUsable ? false : skipReason }, (t) => {
  const r = runExport(t, { produced: ['x86_64'], apkPresent: true })
  assert.equal(r.exported, false, '被拒 ABI 的快照资产不得写进发布目录：' + r.output.slice(-400))
  assert.equal(r.exportedSha, false, '被拒 ABI 的 .sha256 同样不得落盘')
  assert.match(r.output, /本轮未产出该 ABI/, '判红理由必须点名「本轮未产出」：' + r.output.slice(-400))
  assert.match(r.output, /拒绝打包（arm64）/, '被拒 ABI 必须记入 $rejectedAbis（否则末尾守卫看不见它）')
})

test('导出段：ABI 未产出且 APK 也不在场时同样不落盘', { skip: pwshUsable ? false : skipReason }, (t) => {
  const r = runExport(t, { produced: [], apkPresent: false })
  assert.equal(r.exported, false, '没有本轮产出就不得落盘：' + r.output.slice(-400))
  assert.equal(r.exportedSha, false)
})

test('导出段：ABI 已产出且校验通过时必须落盘（判据不得恒红）', { skip: pwshUsable ? false : skipReason }, (t) => {
  const r = runExport(t, { produced: ['arm64'], apkPresent: true })
  assert.equal(r.status, 0, '正常路径必须成功：' + r.output.slice(-400))
  assert.equal(r.exported, true, '已产出的 ABI 必须导出快照资产')
  assert.equal(r.exportedSha, true, '必须同时写 .sha256')
})

test('反证：去掉「本轮产出」守卫后，被拒 ABI 恢复落盘（该行承重）', { skip: pwshUsable ? false : skipReason }, (t) => {
  const r = runExport(t, {
    produced: ['x86_64'], apkPresent: true,
    mutate: (block) => block.replace(/^\s*if \(\$producedAbis -notcontains \$abi\)[^\n]*\n/m, ''),
  })
  assert.equal(r.exported, true, '去掉守卫后必须恢复「被拒 ABI 也落盘」的旧行为（否则本判据不承重）：' + r.output.slice(-400))
})

test('结构面：守卫必须在 Copy-Item 之前', () => {
  const block = extractExportBlock()
  const guardAt = block.indexOf(GUARD)
  const copyAt = block.indexOf('Copy-Item $snapIn $outSnap')
  assert.ok(guardAt >= 0, '导出段里找不到「本轮产出」守卫')
  assert.ok(copyAt >= 0, '导出段里找不到 Copy-Item')
  assert.ok(guardAt < copyAt, '守卫必须早于落盘（guard@' + guardAt + ' copy@' + copyAt + '）')
})
