#!/usr/bin/env node
// check-build-chain-abort.mjs — 构建链「任一 ABI 被拒 = 整链非 0」门禁（0.13.8-b 实锤；review C2 收紧）。
//
// 背景：build-apk-013.ps1 -Suffix '' 空跑发版链时，arm64 侧 overlay 门禁判红 -> 打印「拒绝打包（arm64）」
// 并 continue，随后照常打印「=== 完成 ===」并以 exit 0 结束，产物目录只剩 x86_64 的 APK
// => 静默交付单 ABI 产物（发版时 = 缺 ABI 的 release 而无人察觉）。
//
// review C2（2026-09-14）实锤：门禁曾只 grep 中文文案 `拒绝打包（$abi）`，而机密 / 运行时资产 / A1
// 三处拒绝路径的文案不含该括号形态且**不记 $rejectedAbis**，恰好在盲区（实测 PASS 12 处，漏 3 处）。
// 收紧后的判据全部走**机器标识**：
//   A. 构建链只允许在 `function Deny-Abi` 内自增 $rejectedAbis（全文件恰好一处）；
//   B. 每个含 `continue` 的拒绝行必须调用 `Deny-Abi`（白名单只放 $OnlyAbi 的正常跳过）；
//   C. elf-check 必须捕获退出码再判定（不得管道直连 Select-Object 吞掉 $LASTEXITCODE）。
//   D. 云端链 build-apk.mjs 不得有「门禁失败仅打印后继续」的 per-ABI 静默跳过。
//   E. 动态（--self-test）：用真实脚本抽出的 Deny-Abi + 尾部守卫驱动：
//      被拒非空 -> 非 0；全部产出 -> 0；零产出 -> 非 0；去掉守卫 -> 0（守卫承重）；
//      并逐条驱动**真实调用行**（机密 / 运行时资产 / A1 三处原盲区）→ 全部必须非 0。
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
let helper = ''
if (!ps1Rel) { check('本地链脚本在场: scripts/build-apk-013.ps1', false) } else {
  ps1Text = readFileSync(join(ROOT, ps1Rel), 'utf8')
  const lines = ps1Text.split('\n')

  // ── A. 唯一自增点：Deny-Abi helper ─────────────────────────────────────────
  const helperStart = ps1Text.indexOf('function Deny-Abi(')
  const helperEnd = helperStart >= 0 ? ps1Text.indexOf('\n}', helperStart) + 2 : -1
  helper = helperStart >= 0 && helperEnd > helperStart ? ps1Text.slice(helperStart, helperEnd) : ''
  check('统一拒绝函数 Deny-Abi 在场', helperStart >= 0)
  const increments = [...ps1Text.matchAll(/\$(?:[A-Za-z]+:)?rejectedAbis \+= \$abi/gi)]
  check('$rejectedAbis 只在 Deny-Abi 内自增一次（全文件命中 ' + increments.length + ' 处）',
    increments.length === 1 && /\$script:rejectedAbis \+= \$Abi/i.test(helper),
    increments.length === 1 ? 'helper 内未见 $script:rejectedAbis += $Abi' : '多处自增点 = 记账纪律被绕')
  const rejectEmits = [...ps1Text.matchAll(/Write-Host "拒绝打包（/g)]
  check('拒绝输出只由 Deny-Abi 发射（Write-Host "拒绝打包（ 命中 ' + rejectEmits.length + ' 处）',
    rejectEmits.length === 1)

  // ── B. 每个 continue 拒绝行必须走 Deny-Abi ─────────────────────────────────
  const bareContinue = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ l }) => /\bcontinue\b/.test(l))
    .filter(({ l }) => !/^\s*#/.test(l))                   // 注释行不算
    .filter(({ l }) => !/Deny-Abi/.test(l))
    .filter(({ l }) => !/\$OnlyAbi -ne \$abi/.test(l))   // 白名单：-OnlyAbi 的正常跳过，不是拒绝
  check('含 continue 的拒绝行全部调用 Deny-Abi（裸 continue ' + bareContinue.length + ' 处）',
    bareContinue.length === 0, '未记账行: [' + bareContinue.map(({ n }) => 'L' + n).join(', ') + ']')
  const denyCalls = lines.filter((l) => /Deny-Abi \$abi/.test(l))
  check('per-ABI 拒绝路径存在（断言有对象）', denyCalls.length > 0, '找到 ' + denyCalls.length + ' 处')

  // ── C. 门禁脚本不得管道直连 Select-Object ──────────────────────────────────
  //
  // issue #1075：判据 C 此前**按脚本名**写死成 /elf-check\.mjs/，于是同文件里另外两处
  // 同形状的写法（check-patch-mounts @ :388、check-third-party @ :439）溜了过去。
  // 其中 check-third-party 正是 GPL 许可合规门禁：失败时打印「THIRD-PARTY CHECK FAILED」
  // 加 N 行明细，N >= 4 就超过 Select-Object -First 4 的对象数 =>
  //   上游 node 被提前终止 => $LASTEXITCODE 变成 $null => `-ne 0` 为 True 但那是空值比较，
  //   实测语义上 Deny-Abi 不会按预期触发，该 ABI 被计为「已产出」，链打印「=== 完成 ===」并 exit 0。
  //
  // 改成**任何** check-*.mjs 直连 Select-Object 都判红：这个坑与具体是哪道门禁无关，
  // 只与「用管道截断输出」这个动作有关。要截断就先把退出码捕获到变量再截（见 elf-check 的写法）。
  const gatePiped = lines.filter((l) => /check-[a-z0-9-]+\.mjs/.test(l) && /\|\s*Select-Object/.test(l))
  check('check-*.mjs 门禁不得管道直连 Select-Object（会吞退出码语义）', gatePiped.length === 0,
    gatePiped.map((l) => l.trim()).join(' | '))
  check('elf-check 退出码被捕获并判定（$elfCode + Deny-Abi）',
    /\$elfCode\s*=\s*\$LASTEXITCODE/.test(ps1Text) && /\$elfCode -ne 0[^\n]*Deny-Abi/.test(ps1Text))

  // ── C2. 预清理只针对本次产出的 ABI（issue #1078）─────────────────────────────
  //
  // 旧写法 `Get-ChildItem $Out -Filter '*.apk' -Recurse | Remove-Item` 在 ABI 循环之前无条件跑，
  // 于是跑过一次完整构建后再用 -OnlyAbi / -Fast 跑单 ABI 会把另一个 ABI 已验签的产物也删掉，
  // 本次只产 1 个 ABI、两条尾部守卫都过、exit 0，而发布目录只剩 1/2 ABI。
  // 判据：预清理必须按「本次产出 ABI」过滤，不得对 $Out 无条件递归删。
  const unconditionalWipe = lines.filter((l) => /Get-ChildItem\s+\$Out/.test(l)
    && /Remove-Item/.test(l) && !/\$abisThisRun/.test(l) && !/^\s*#/.test(l))
  check('预清理不得无条件删除 $Out 下所有 APK（#1078：会删掉另一个 ABI 的产物）',
    unconditionalWipe.length === 0, unconditionalWipe.map((l) => l.trim()).join(' | '))
  check('预清理按本次产出 ABI 过滤（$abisThisRun）',
    /\$abisThisRun\s*=/.test(ps1Text) && /\$abisThisRun/.test(ps1Text))

  // ── C3. 发布快照资产先校验后落盘（issue #1080）───────────────────────────────
  //
  // 旧顺序：Copy-Item 拷进 out/ -> 再 check-snapshot-asset；缺 APK 只打警告并跳过校验。
  // 于是上一次运行的旧 tar 可以带着 .sha256 躺进发布目录，而一致性校验从未发生。
  // 判据：`Copy-Item $snapIn $outSnap` 必须出现在 check-snapshot-asset 调用**之后**；
  //       且「缺 APK」分支必须是 Deny-Abi，不得是「警告 + 跳过」。
  const copyIdx = lines.findIndex((l) => /Copy-Item\s+\$snapIn\s+\$outSnap/.test(l))
  const verifyIdx = lines.findIndex((l) => /check-snapshot-asset\.ps1/.test(l))
  check('发布快照资产必须先校验再拷入（#1080：Copy-Item 必须在 check-snapshot-asset 之后）',
    copyIdx === -1 || verifyIdx === -1 || verifyIdx < copyIdx,
    copyIdx === -1 ? '未找到 Copy-Item $snapIn $outSnap' : ('verify L' + (verifyIdx + 1) + ' vs copy L' + (copyIdx + 1)))
  const warnSkip = lines.filter((l) => !/^\s*#/.test(l) && /缺 APK/.test(l) && /警告|跳过/.test(l))
  check('缺 APK 时不得只警告并跳过一致性校验（#1080：必须 Deny-Abi）',
    warnSkip.length === 0, warnSkip.map((l) => l.trim()).join(' | '))

  // ── 尾部守卫 ──────────────────────────────────────────────────────────────
  check('含「已产出 / 被拒 ABI」汇总行', /汇总。已产出 ABI/.test(ps1Text))
  check('被拒非空 -> exit 1', /if \(\$rejectedAbis\.Count -gt 0\)[^\n]*exit 1 \}/.test(ps1Text))
  check('产出为空 -> exit 1', /if \(\$producedAbis\.Count -eq 0\)[^\n]*exit 1 \}/.test(ps1Text))
  check('成功路径记入 $producedAbis', /\$producedAbis \+= \$abi/.test(ps1Text))
}

// ── D. 云端链 ────────────────────────────────────────────────────────────────
const mjsRel = resolveRepoPath('dsh-mobile-apk/scripts/build-apk.mjs')
if (!mjsRel) { check('云端链脚本在场: dsh-mobile-apk/scripts/build-apk.mjs', false) } else {
  const text = readFileSync(join(ROOT, mjsRel), 'utf8')
  const silent = text.split('\n').filter((l) => /拒绝打包|拒绝发布/.test(l) && /continue/.test(l) && !/throw|process\.exit/.test(l))
  check('云端链无「打印后 continue」式静默跳过', silent.length === 0, '可疑行: ' + silent.length)
  check('云端链失败路径抛错/非 0 退出', /throw new Error|process\.exit\(1\)/.test(text))
}

// ── D2. 快照包名一致性门禁（ci-verify-snapshot.py）必须真接线 ────────────────
// 背景（2026-10-27，issue #154 / apk #480 第 1 条）：该门禁自存在起从未被任何链调用，只能在 CI
// 工作流里手动跑——与 :56 记的 check-dead-tokens「只登记未接线」是同型缺陷。接线之后必须有人守，
// 否则下一个人删掉那行调用不会有任何东西报警，直接退回原始状态。
//
// 判据取「调用点 + 快照变量」两个要素，且只认**真实调用形态**（不认注释、不认声明数组字符串）：
//   - 调用点：没出现 = 线被拆了；
//   - 快照变量：调用必须把「本次构建的快照路径」作为实参传进去（ps1 的 $snapIn / mjs 的 snapIn）。
//     否则有人传常量或空串也能「通过」，门禁等于没验本次产物。
// 两个仓同一份脚本，故 ps1 侧判据在协调仓（本仓）与 apk 仓都适用；mjs 侧按 resolveRepoPath 解析。
{
  // 注意：不要用跨行块注释正则去「净���」整个文件——本仓 build-apk.mjs 第 25 行有 /** ... */,
  // 贪婪跨行匹配会把中间整段（含真实调用行）一起吞掉，断言会假红。改成只剔除以 // 开头的整行注释。
  const dropLineComments = (text) => text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  // ps1：python (Join-Path $Root "scripts\ci-verify-snapshot.py") $snapIn $abi @pluginDirs
  // 反引号/引号内是脚本名，实参紧随其后；要求同一行里既有脚本名又有 $snapIn。
  const ps1Call = ps1Text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => /ci-verify-snapshot\.py/.test(l))
  const ps1Wired = ps1Call.filter((l) => /\$snapIn\b/.test(l))
  check('本地链真调用快照包名门禁（ci-verify-snapshot.py + $snapIn 实参）',
    ps1Wired.length === 1,
    ps1Call.length === 0 ? '未找到调用行（门禁未接线或调用被删）'
      : (ps1Wired.length === 0 ? '调用行未传 $snapIn（验的不是本次快照）: ' + ps1Call[0].trim()
        : '调用点应恰好 1 处，实得 ' + ps1Wired.length + ' 处'))
  // 云端链文件在三类布局下的位置不同：apk 仓根（云端）/ 协调仓根 + 嵌套 dsh-mobile-apk / 只有本仓。
  // resolveRepoPath 已按这两条候选解析；解析不到就说明两侧都没这个文件（不是「未接线」，要分开报）。
  const mjsRelCands = ['dsh-mobile-apk/scripts/build-apk.mjs', 'scripts/build-apk.mjs']
  const mjsRelResolved = mjsRelCands.find((c) => existsSync(join(ROOT, c))) ?? null
  if (!mjsRelResolved) {
    check('云端链脚本在场（dsh-mobile-apk/scripts/build-apk.mjs 或 scripts/build-apk.mjs）', false)
  } else {
    const mjsText = dropLineComments(readFileSync(join(ROOT, mjsRelResolved), 'utf8'))
    const mjsCall = mjsText
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .filter((l) => /ci-verify-snapshot\.py/.test(l))
      // 真实执行形态：run(PYTHON, [gate('ci-verify-snapshot.py'), snapIn, ABI, ...pluginDirs])
      .filter((l) => /\brun\s*\(/.test(l))
    const mjsWired = mjsCall.filter((l) => /\bsnapIn\b/.test(l) && /\bABI\b/.test(l))
    check('云端链真调用快照包名门禁（run(ci-verify-snapshot.py, snapIn, ABI, ...)）',
      mjsWired.length === 1,
      mjsCall.length === 0 ? '未找到 run(...) 调用行（门禁未接线或调用被删）'
        : (mjsWired.length === 0 ? '调用行未同时传 snapIn 与 ABI: ' + mjsCall[0].trim()
          : '调用点应恰好 1 处，实得 ' + mjsWired.length + ' 处'))
  }
}

// ── E. 动态自检 ──────────────────────────────────────────────────────────────
if (!argv.includes('--self-test')) {
  console.log('（默认模式：仅静态断言；动态自检用 --self-test）')
} else if (process.platform !== 'win32') {
  skip('动态自检需要 Windows/PowerShell')
} else if (!ps1Text || !helper) {
  skip('本地链脚本不可读或 Deny-Abi 不能抽取，无法做动态验证')
} else {
  const tail = ps1Text.split('\n')
    .filter((l) => /producedList|rejectedList|汇总。已产出 ABI|rejectedAbis\.Count|producedAbis\.Count/.test(l))
    .join('\n')
  // 真实调用行（原盲区三处 + 其它，抽出驱动）：Deny-Abi 后 continue 的整行取子句（函数调用本身）。
  const realCallLines = ps1Text.split('\n')
    .filter((l) => /Deny-Abi \$abi/.test(l) && /continue/.test(l))
    .map((l) => (/(Deny-Abi \$abi "[^"]*")/.exec(l) || [])[1])
    .filter(Boolean)
  const blindSpotCalls = realCallLines.filter((l) => /机密|运行时补丁|A1 出厂值/.test(l))
  check('动态用例有对象：原盲区三处（机密/运行时资产/A1）调用行被抽出', blindSpotCalls.length === 3,
    '抽出 ' + blindSpotCalls.length + ' 条: ' + blindSpotCalls.join(' | '))

  const work = mkdtempSync(join(tmpdir(), 'chainabort-'))
  const q = (s) => "'" + s + "'"
  const runTail = (rejected, produced, opts = {}) => {
    const body = opts.useGuard === false ? tail
      .replace(/if \(\$rejectedAbis\.Count -gt 0\)[^\n]*exit 1 \}/, '')
      .replace(/if \(\$producedAbis\.Count -eq 0\)[^\n]*exit 1 \}/, '') : tail
    const script = [
      '$rejectedAbis = @(' + rejected.map(q).join(',') + ')',
      '$producedAbis = @(' + produced.map(q).join(',') + ')',
      "$abi = 'arm64'",
      helper,
      ...(opts.calls ?? []),
      body,
    ].join('\n')
    const tag = (rejected.join('') || 'none') + '-' + (produced.join('') || 'none') + (opts.tag ?? '')
    const p = join(work, 'tail-' + tag + '.ps1')
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
  const rNG = runTail(['arm64'], ['x86_64'], { useGuard: false })
  check('动态（反证）：去掉尾部守卫后同状态 exit 0（守卫承重，实得 ' + rNG.status + '）', rNG.status === 0)
  // 原盲区三处：直接跑真实调用行 —— 任一未记账都会让被拒集合为空并 exit 0（review C2 的核心回归）。
  for (const call of blindSpotCalls) {
    const r = runTail([], ['x86_64'], { calls: [call + ';'], tag: '-blind' })
    const out = (r.stdout || '') + (r.stderr || '')
    check('动态（原盲区）：' + call.slice(0, 40) + '... -> 非 0 且记入被拒', r.status !== 0 && out.includes('被拒 ABI: [arm64]'),
      'status=' + r.status + ' out=' + out.split('\n').find((l) => l.includes('汇总')) || '')
  }
  rmSync(work, { recursive: true, force: true })
}

if (skips > 0) console.log('SKIP=' + skips)
if (failures.length > 0) {
  console.error('CHECK-BUILD-CHAIN-ABORT FAILED（' + failures.length + ' 项）：' + failures.slice(0, 5).join('；'))
  process.exit(1)
}
console.log('CHECK-BUILD-CHAIN-ABORT PASSED（Deny-Abi 唯一记账 + 每个 continue 拒绝走 Deny-Abi + elf 退出码判定'
  + (argv.includes('--self-test') ? '；动态自检含原盲区三处驱动与反证' : '') + '）')
