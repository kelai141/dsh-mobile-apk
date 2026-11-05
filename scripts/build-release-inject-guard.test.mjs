#!/usr/bin/env node
// build-release-inject-guard.test.mjs — 宿主注入「半写快照覆盖输入」判据（issue #1613）。
//
// 【为什么必须存在（实锤形态）】
// build-release.ps1 的 2c 段旧写法是：
//     python $injectPy $abi.f $outTmp @pkgArgs 2>&1 | Select-Object -Last 3
//     if (-not (Test-Path $outTmp)) { throw ... }
//     Move-Item $outTmp $abi.f -Force
// 管道把 python 的退出码完全丢弃，判据只剩「文件存在」。inject-snapshot.py 用 tarfile 流式写 .new，
// 中途抛错（磁盘满 / 条目损坏 / 权限）会留下一个**存在但截断**的 .new，紧接着 Move-Item 就把原输入
// 覆盖掉。一次注入失败 + 一次成功的下游重跑，输入位里就是那份截断件 —— 2f 的聚合门禁能拦「解不开」，
// 拦不掉「解得开、少了一批条目」。
//
// 【判据（三层，全部是行为判据）】
//   ① 从真实脚本里抽出**注入段整块**，用合成 python 驱动：
//        退出码非 0 + 写了半截 .new  -> 必须 throw，且输入逐字节不变、半写件被删除；
//        退出码 0 + 产物成员数变少    -> 必须 throw（退出码不是唯一失败面）；
//        退出码 0 + 产物成员数正常    -> 必须放行并 Move-Item（不得恒红）。
//   ② 反证（两条判据各自承重，分开证）：去掉退出码判据 -> 「非 0 但产物完整」被放行；
//      去掉成员数对账 -> 「退出码 0 但截断」被放行。
//   ③ 结构面：注入段不得回到「python ... | Select-Object」形态（管道会吞退出码）。
//
// **夹具必须是真 tar.xz**：首版用「一行一个成员名的文本文件」冒充快照，Windows 的 bsdtar 会
// 按成员清单读出来（看起来对），而 Linux 的 GNU tar 直接报「不是归档」——两边成员数都是 0，
// 于是成员数对账在 CI 上**静默通过**（实测：CI 上该例红、本地绿）。夹具本身成了判据的平台依赖。
// 现在用 python tarfile 造真归档：成员数是真读出来的，判据与平台无关。
//
// 需要 pwsh + python（注入段调用 python，ubuntu 默认只有 python3）。缺席时显式 skip 并打印原因。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'build-release.ps1')
const pwshUsable = (() => {
  try { return spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0 } catch { return false }
})()
/** 注入段调用的是 python（build-release.ps1 的既有约定）。ubuntu-latest 默认只有 python3，
 *  该链在 CI 上并不执行；这里如实探测，缺席就 skip 并打印原因，不静默当通过。 */
const pythonUsable = (() => {
  try { return spawnSync('python', ['-c', 'import tarfile, sys; sys.exit(0)'], { encoding: 'utf8' }).status === 0 } catch { return false }
})()
const skipReason = !pwshUsable
  ? 'pwsh 不可用（Linux CI 无 PowerShell）——本判据只在 Windows/pwsh 侧执行'
  : 'python 不可用（注入段调用 python；ubuntu 默认只有 python3）——本判据需要真解释器'
const canRun = pwshUsable && pythonUsable

/** 从真实脚本抽出 2c 注入段：从「$injectPy = ...」到「Write-Output ("  快照 OK: ...」那一行为止。 */
function extractInjectBlock() {
  const lines = readFileSync(SCRIPT, 'utf8').split(/\r?\n/)
  const start = lines.findIndex((l) => l.includes('$injectPy = Join-Path'))
  assert.ok(start >= 0, 'build-release.ps1 里找不到注入段起点（$injectPy = Join-Path）')
  const end = lines.findIndex((l, i) => i > start && l.includes('快照 OK:'))
  assert.ok(end > start, 'build-release.ps1 里找不到注入段终点（快照 OK 输出行）')
  return lines.slice(start, end + 1).join('\n')
}

/** 造真 tar.xz 的 python 夹具（成员数由 tarfile 真写，不是文本伪装）。 */
const MAKE_SNAP = [
  'import sys, tarfile, io',
  'out, n = sys.argv[1], int(sys.argv[2])',
  'with tarfile.open(out, "w:xz") as t:',
  '    for i in range(n):',
  '        data = ("member-%d" % i).encode()',
  '        info = tarfile.TarInfo("usr/lib/m%d.bin" % i)',
  '        info.size = len(data)',
  '        t.addfile(info, io.BytesIO(data))',
  '',
].join('\n')

/** 注入驱动：mode=truncated 只写前 k 条；mode=copy 全量复制；mode=copy-plus 再多注入一条。 */
const INJECT = [
  'import os, sys, tarfile, io',
  'src, out = sys.argv[1], sys.argv[2]',
  'mode = os.environ.get("INJECT_MODE", "copy")',
  'keep = int(os.environ.get("INJECT_KEEP", "0"))',
  'exit_code = int(os.environ.get("INJECT_EXIT", "0"))',
  'members = []',
  'with tarfile.open(src, "r:xz") as t:',
  '    for m in t.getmembers():',
  '        members.append((m, t.extractfile(m).read() if m.isfile() else None))',
  'with tarfile.open(out, "w:xz") as t:',
  '    if mode == "truncated":',
  '        members = members[:keep]',
  '    for m, data in members:',
  '        if data is None:',
  '            t.addfile(m)',
  '        else:',
  '            info = tarfile.TarInfo(m.name)',
  '            info.size = len(data)',
  '            t.addfile(info, io.BytesIO(data))',
  '    if mode == "copy-plus":',
  '        extra = b"injected"',
  '        info = tarfile.TarInfo("home/.dsh/profiles/web/node_modules/@dsh-android/x/lib/index.js")',
  '        info.size = len(extra)',
  '        t.addfile(info, io.BytesIO(extra))',
  'sys.exit(exit_code)',
  '',
].join('\n')

/** 用 python 造一个含 n 条成员的真 tar.xz。 */
const makeSnapshot = (file, n) => {
  const py = file + '.make.py'
  writeFileSync(py, MAKE_SNAP)
  const r = spawnSync('python', [py, file, String(n)], { encoding: 'utf8' })
  assert.equal(r.status, 0, '夹具快照必须造得出来：' + (r.stderr ?? ''))
  return file
}

test('注入段：python 退出码非 0 时不得用半写快照覆盖输入（issue #1613）', { skip: canRun ? false : skipReason }, (t) => {
  const work = mkdtempSync(join(tmpdir(), 'inject-guard-'))
  t.after(() => rmSync(work, { recursive: true, force: true }))
  const snap = makeSnapshot(join(work, 'snapshot-arm64.tar.xz'), 4)
  const original = readFileSync(snap)
  const injectPy = join(work, 'inject.py')
  writeFileSync(injectPy, INJECT)

  const block = extractInjectBlock()
  const runBlock = (mode, keep, exitCode, tag, mutate) => {
    const body = mutate === undefined ? block : mutate(block)
    const script = [
      '$ErrorActionPreference = "Stop"',
      '$root = ' + JSON.stringify(work),
      '$pluginSrcs = @()',
      '$abi = @{ n = "arm64"; f = ' + JSON.stringify(snap) + '; expect = "aarch64" }',
      body.replace(/\$injectPy = Join-Path \$root "[^"]*"/, '$injectPy = ' + JSON.stringify(injectPy)),
      '',
    ].join('\n')
    const p = join(work, 'run-' + tag + '.ps1')
    writeFileSync(p, script)
    return spawnSync('pwsh', ['-NoProfile', '-File', p], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, INJECT_MODE: mode, INJECT_KEEP: String(keep), INJECT_EXIT: String(exitCode) },
    })
  }

  // ① 失败驱动：写半截 .new 且退出码 1 -> 必须 throw，输入不变，半写件被删。
  writeFileSync(snap, original)
  const failed = runBlock('truncated', 2, 1, 'fail')
  const failedOut = (failed.stdout ?? '') + (failed.stderr ?? '')
  assert.notEqual(failed.status, 0, 'python 非 0 时必须中止（旧实现只看文件存在，会放行）：' + failedOut.slice(-400))
  assert.match(failedOut, /快照注入失败（inject-snapshot\.py exit 1）/, '判红理由必须点名退出码：' + failedOut.slice(-400))
  assert.deepEqual(readFileSync(snap), original, '输入快照必须逐字节不变（不得被半写件覆盖）')
  assert.equal(existsSync(snap + '.new'), false, '半写产物必须被删除，不能留在原地等下一次重跑覆盖输入')

  // ② 截断驱动：退出码 0 但成员数变少 -> 同样必须 throw（退出码不是唯一失败面）。
  writeFileSync(snap, original)
  const truncated = runBlock('truncated', 2, 0, 'truncated')
  const truncatedOut = (truncated.stdout ?? '') + (truncated.stderr ?? '')
  assert.notEqual(truncated.status, 0, '成员数少于输入时必须中止：' + truncatedOut.slice(-400))
  assert.match(truncatedOut, /成员数少于输入/, '判红理由必须点名成员数对账：' + truncatedOut.slice(-400))
  assert.deepEqual(readFileSync(snap), original, '输入快照必须逐字节不变')

  // ③ 正常驱动：退出码 0 且成员数只增不减 -> 必须放行并 Move-Item（判据不得恒红）。
  writeFileSync(snap, original)
  const good = runBlock('copy-plus', 0, 0, 'good')
  const goodOut = (good.stdout ?? '') + (good.stderr ?? '')
  assert.equal(good.status, 0, '正常注入必须放行：' + goodOut.slice(-600))
  const listed = spawnSync('tar', ['-tf', snap], { encoding: 'utf8' })
  assert.equal(listed.status, 0, '放行后的输入必须仍是可读归档')
  assert.match(listed.stdout, /@dsh-android\/x\/lib\/index\.js/, '正常注入的产物必须被 Move-Item 到输入位')

  /* ④ 反证（两条判据各自承重，分开证）：
   *   a) 「退出码非 0 但产物完整」——成员数对账看不见它，只有退出码判据能拦；
   *      去掉退出码判据后必须**放行**（否则说明是别处在拦，这条判据没有判别力）。
   *   b) 「退出码 0 但产物截断」——只有成员数对账能拦；去掉对账后必须**放行**。 */
  writeFileSync(snap, original)
  const completeButFailed = runBlock('copy', 0, 1, 'fail-complete')
  assert.notEqual(completeButFailed.status, 0, '退出码非 0 时即使产物完整也必须中止（a 判据）')
  assert.match((completeButFailed.stdout ?? '') + (completeButFailed.stderr ?? ''), /inject-snapshot\.py exit 1/)
  assert.deepEqual(readFileSync(snap), original, 'a 判据下输入必须不变')

  writeFileSync(snap, original)
  const withoutCodeGuard = runBlock('copy', 0, 1, 'noguard-code',
    (text) => text.replace(/if \(\$injectCode -ne 0\) \{[\s\S]*?\n    \}/, ''))
  assert.equal(withoutCodeGuard.status, 0,
    '去掉退出码判据后必须恢复放行（否则本判据不承重）：'
    + ((withoutCodeGuard.stdout ?? '') + (withoutCodeGuard.stderr ?? '')).slice(-400))

  writeFileSync(snap, original)
  const withoutCountGuard = runBlock('truncated', 2, 0, 'noguard-count',
    (text) => text.replace(/if \(\$outCount -lt \$inCount\) \{[\s\S]*?\n    \}/, ''))
  assert.equal(withoutCountGuard.status, 0,
    '去掉成员数对账后必须恢复放行（否则本判据不承重）：'
    + ((withoutCountGuard.stdout ?? '') + (withoutCountGuard.stderr ?? '')).slice(-400))
  const afterNoGuard = spawnSync('tar', ['-tf', snap], { encoding: 'utf8' })
  assert.doesNotMatch(afterNoGuard.stdout ?? '', /usr\/lib\/m3\.bin/, '反证下输入应被截断件覆盖（旧缺陷形态）')
  writeFileSync(snap, original)
})

test('注入段结构：不得回到「python ... | Select-Object」（管道吞退出码）', () => {
  const block = extractInjectBlock()
  const piped = block.split(/\r?\n/)
    .filter((l) => /\bpython\b/.test(l) && /\|\s*Select-Object/.test(l) && !/^\s*#/.test(l))
  assert.deepEqual(piped, [], '注入调用不得管道直连 Select-Object：' + piped.join(' | '))
  assert.match(block, /\$injectCode = \$LASTEXITCODE/, '必须先收退出码再判定')
  assert.match(block, /if \(\$injectCode -ne 0\)/, '退出码非 0 必须判红')
})
