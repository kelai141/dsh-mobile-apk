#!/usr/bin/env node
// check-build-chain-abort.mjs — 构建链「任一 ABI 被拒 = 整链非 0」门禁（0.13.8-b 实锤）。
//
// 背景：build-apk-013.ps1 -Suffix '' 空跑发版链时，arm64 侧 overlay 门禁判红 -> 打印「拒绝打包（arm64）」
// 并 continue，随后照常打印「=== 完成 ===」并以 exit 0 结束，产物目录只剩 x86_64 的 APK
// => 静默交付单 ABI 产物（发版时 = 缺 ABI 的 release 而无人察觉）。
//
// 断言：
//   A. 静态（默认，CI 可跑）：build-apk-013.ps1 每处 per-ABI 拒绝都必须把该 ABI 记入 $rejectedAbis；
//      脚本必须含「已产出/被拒 ABI」汇总行 + 两条非 0 退出守卫（被拒非空 / 产出为空）。
//   B. 静态：云端链 build-apk.mjs 不得有「门禁失败仅打印后继续」的 per-ABI 静默跳过。
//   C. 动态（--self-test）：抽出真实文件的尾部守卫块，用合成状态驱动：
//      被拒非空 -> 非 0；全部产出 -> 0（不误伤）；零产出 -> 非 0；去掉守卫的副本 -> 0（守卫承重）。
//      （不做整链空跑：真实链会被前置门禁先行拦下，与本守卫无关，见坑 94。）
//
// 用法：node scripts/check-build-chain-abort.mjs [--self-test] [--require]
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const resolveRepoPath = (rel) => {
  const cands = String(rel).startsWith('dsh-mobile-apk/') ? [rel, String(rel).slice('dsh-mobile-apk/'.length)] : [rel]
  return cands.find((c) => existsSync(join(ROOT, c))) ?? null
}
const failures = []
let skips = 0
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
const require0 = argv.includes('--require')
const skip = (why) => {
  skips += 1
  console.log('SKIP(#' + skips + ')  ' + why + (require0 ? ' —— --require 档不得 SKIP' : ''))
  if (require0) failures.push('SKIP: ' + why)
}

const ps1Rel = resolveRepoPath('scripts/build-apk-013.ps1')
let ps1Text = ''
if (!ps1Rel) { check('本地链脚本在场: scripts/build-apk-013.ps1', false) } else {
  ps1Text = readFileSync(join(ROOT, ps1Rel), 'utf8')
  const rejection = ps1Text.split('\n').map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /拒绝打包（\$abi）|拒绝发布组装（\$abi）/.test(l))
  check('本地链存在 per-ABI 拒绝路径（断言有对象）', rejection.length > 0, '找到 ' + rejection.length + ' 处')
  const unrecorded = rejection.filter(({ l }) => !/\$rejectedAbis \+= \$abi/.test(l))
  check('每处 per-ABI 拒绝都记入 $rejectedAbis（' + rejection.length + ' 处）', unrecorded.length === 0,
    '未记账行: [' + unrecorded.map(({ n }) => 'L' + n).join(', ') + ']')
  check('含「已产出 / 被拒 ABI」汇总行', /汇总。已产出 ABI/.test(ps1Text))
  check('被拒非空 -> exit 1', /if \(\$rejectedAbis\.Count -gt 0\)[^\n]*exit 1 \}/.test(ps1Text))
  check('产出为空 -> exit 1', /if \(\$producedAbis\.Count -eq 0\)[^\n]*exit 1 \}/.test(ps1Text))
  check('成功路径记入 $producedAbis', /\$producedAbis \+= \$abi/.test(ps1Text))
}

const mjsRel = resolveRepoPath('dsh-mobile-apk/scripts/build-apk.mjs')
if (!mjsRel) { check('云端链脚本在场: dsh-mobile-apk/scripts/build-apk.mjs', false) } else {
  const text = readFileSync(join(ROOT, mjsRel), 'utf8')
  const silent = text.split('\n').filter((l) => /拒绝打包|拒绝发布/.test(l) && /continue/.test(l) && !/throw|process\.exit/.test(l))
  check('云端链无「打印后 continue」式静默跳过', silent.length === 0, '可疑行: ' + silent.length)
  check('云端链失败路径抛错/非 0 退出', /throw new Error|process\.exit\(1\)/.test(text))
}

if (!argv.includes('--self-test')) {
  console.log('（默认模式：仅静态断言；动态自检用 --self-test）')
} else if (process.platform !== 'win32') {
  skip('动态自检需要 Windows/PowerShell')
} else if (!ps1Text) {
  skip('本地链脚本不可读，无法做尾部块动态验证')
} else {
  const tail = ps1Text.split('\n')
    .filter((l) => /producedList|rejectedList|汇总。已产出 ABI|rejectedAbis\.Count|producedAbis\.Count/.test(l))
    .join('\n')
  const work = mkdtempSync(join(tmpdir(), 'chainabort-'))
  const q = (s) => "'" + s + "'"
  const runTail = (rejected, produced, useGuard = true) => {
    const body = useGuard ? tail
      : tail.replace(/if \(\$rejectedAbis\.Count -gt 0\)[^\n]*exit 1 \}/, '')
        .replace(/if \(\$producedAbis\.Count -eq 0\)[^\n]*exit 1 \}/, '')
    const script = ['$rejectedAbis = @(' + rejected.map(q).join(',') + ')',
      '$producedAbis = @(' + produced.map(q).join(',') + ')', body].join('\n')
    const p = join(work, 'tail-' + (rejected.join('') || 'none') + '-' + (produced.join('') || 'none') + (useGuard ? '' : '-noguard') + '.ps1')
    writeFileSync(p, script)
    return spawnSync('pwsh', ['-NoProfile', '-File', p], { cwd: ROOT, encoding: 'utf8', timeout: 120000 })
  }
  const rA = runTail(['arm64'], ['x86_64'])
  check('动态：被拒 ABI 非空 -> 尾部块非 0（实得 ' + rA.status + '）', rA.status !== 0)
  const outA = (rA.stdout || '') + (rA.stderr || '')
  check('动态：汇总行列出被拒 ABI', outA.includes('被拒 ABI: [arm64]'),
    (rA.stdout || '').split('\n').find((l) => l.includes('汇总')) || '')
  const rB = runTail([], ['arm64', 'x86_64'])
  check('动态：全部产出 -> exit 0（不误伤成功路径，实得 ' + rB.status + '）', rB.status === 0)
  const rC = runTail([], [])
  check('动态：零产出且无被拒 -> 非 0（实得 ' + rC.status + '）', rC.status !== 0)
  const rNG = runTail(['arm64'], ['x86_64'], false)
  check('动态（反证）：去掉尾部守卫后同状态 exit 0（守卫承重，实得 ' + rNG.status + '）', rNG.status === 0)
  rmSync(work, { recursive: true, force: true })
}

if (skips > 0) console.log('SKIP=' + skips)
if (failures.length > 0) {
  console.error('CHECK-BUILD-CHAIN-ABORT FAILED（' + failures.length + ' 项）：' + failures.slice(0, 5).join('；'))
  process.exit(1)
}
console.log('CHECK-BUILD-CHAIN-ABORT PASSED（per-ABI 拒绝已记账 + 汇总 + 非 0 退出守卫'
  + (argv.includes('--self-test') ? '；动态自检含反证' : '') + '）')
