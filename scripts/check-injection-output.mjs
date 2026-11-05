#!/usr/bin/env node
// check-injection-output.mjs — 注入产物完整性门禁（issue #1613）。
//
// 缺陷形态：build-release.ps1 的注入段此前是
//   python $injectPy $abi.f $outTmp @pkgArgs 2>&1 | Select-Object -Last 3
//   if (-not (Test-Path $outTmp)) { throw ... }
//   Move-Item $outTmp $abi.f -Force
// 两个问题叠在一起：
//   ① 管道直连 Select-Object 吞掉了 $LASTEXITCODE —— python 的退出码被**完全丢弃**；
//   ② 唯一判据是「文件存在」。inject-snapshot.py 用 tarfile 流式写 .new，中途抛错（磁盘满 /
//      条目损坏 / 权限）会留下一个**存在但截断**的 .new，紧接着 Move-Item 就把原输入覆盖掉。
//      一次注入失败 + 一次成功的下游重跑，输入位里就是那份截断件。
//      下游 2f 的聚合门禁拦得住「解不开」，拦不住「解得开、少了一批条目」。
//
// 本门禁补的就是「解得开但少条目」这一层：用**另一个解码器**（系统 tar，不是写它的 python tarfile）
// 把两份都列一遍成员，产物条目数必须不少于输入，且两份都能完整读出成员清单。
//
// 用法：
//   node scripts/check-injection-output.mjs <input.tar.xz> <output.tar.xz>
//   node scripts/check-injection-output.mjs --self-test
// 退出码：0 = 产物完整；1 = 判红（截断/少条目/读不出）；2 = 用法错误。
//
// 自证（--self-test）：在临时目录里造三份真实 tar.xz ——
//   ① 完好产物（条目数 == 输入）→ 必须绿；
//   ② 截断产物（只留一半成员）→ 必须红（这正是 python 中途失败留下的形态）；
//   ③ 被截断到解不开的产物 → 必须红（下游 2f 拦得住的那种，本门禁同样要拦）。
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TAR = process.platform === 'win32' && existsSync('C:\\Windows\\System32\\tar.exe')
  ? 'C:\\Windows\\System32\\tar.exe'
  : 'tar'

/** 成员清单（失败返回 null —— 调用方必须把「读不出」当成判红，不是当成空集）。 */
export const listMembers = (tarPath) => {
  try {
    return execFileSync(TAR, ['-tf', tarPath], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 判据本体（纯函数，供 --self-test 直接钉住双向判别力）。
 *
 * @param inputMembers  输入快照的成员清单；null = 读不出。
 * @param outputMembers 注入产物的成员清单；null = 读不出（截断到解不开）。
 * @returns null = 通过；否则为判红理由。
 */
export const injectionOutputProblem = (inputMembers, outputMembers) => {
  if (!Array.isArray(inputMembers) || inputMembers.length === 0) {
    return '输入快照读不出成员清单（tar -tf 失败或为空）——无法判定产物完整性，拒绝覆盖'
  }
  if (outputMembers === null || !Array.isArray(outputMembers)) {
    return '注入产物读不出成员清单（tar -tf 失败）——产物被截断或不是合法 tar，拒绝覆盖原快照'
  }
  if (outputMembers.length < inputMembers.length) {
    return '注入产物条目数 ' + outputMembers.length + ' < 输入 ' + inputMembers.length
      + '（少 ' + (inputMembers.length - outputMembers.length) + ' 条）——流式写入中途失败留下的半份，拒绝覆盖'
  }
  return null
}

const selfTest = () => {
  const work = mkdtempSync(join(tmpdir(), 'injection-output-'))
  const failures = []
  const check = (label, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
    if (!ok) failures.push(label)
  }
  try {
    // 造一棵有 8 个文件的目录，打成 tar.xz 当「输入快照」。
    const tree = join(work, 'tree')
    execFileSync('node', ['-e', 'const fs=require("fs"),p=require("path");const d=' + JSON.stringify(tree)
      + ';fs.mkdirSync(d,{recursive:true});for(let i=0;i<8;i++)fs.writeFileSync(p.join(d,"f"+i+".txt"),"x".repeat(64))'],
    { stdio: 'inherit' })
    const input = join(work, 'input.tar.xz')
    execFileSync(TAR, ['-cJf', input, '-C', tree, '.'])
    const inputMembers = listMembers(input)
    check('自证前置：输入快照可列出成员（' + (inputMembers?.length ?? 0) + ' 条）', (inputMembers?.length ?? 0) >= 8)

    // ① 完好产物：整份复制（条目数相同）——必须绿。
    const good = join(work, 'good.tar.xz')
    writeFileSync(good, readFileSync(input))
    check('正控：条目数相同的产物必须放行', injectionOutputProblem(inputMembers, listMembers(good)) === null)

    // ② 截断产物：只装一半成员 —— 必须红（python 中途失败的典型形态：解得开、少一批条目）。
    const half = join(work, 'half')
    execFileSync('node', ['-e', 'const fs=require("fs"),p=require("path");const s=' + JSON.stringify(tree)
      + ',d=' + JSON.stringify(half) + ';fs.mkdirSync(d,{recursive:true});'
      + 'fs.readdirSync(s).slice(0,3).forEach(f=>fs.copyFileSync(p.join(s,f),p.join(d,f)))'], { stdio: 'inherit' })
    const short = join(work, 'short.tar.xz')
    execFileSync(TAR, ['-cJf', short, '-C', half, '.'])
    const shortProblem = injectionOutputProblem(inputMembers, listMembers(short))
    check('负控：少条目的产物必须判红（截断件形态）', shortProblem !== null && /条目数/.test(shortProblem), String(shortProblem))

    // ③ 解不开的产物：把 xz 砍掉一半 —— 必须红，且理由说「读不出」而不是「少条目」。
    const broken = join(work, 'broken.tar.xz')
    const bytes = readFileSync(good)
    writeFileSync(broken, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))))
    const brokenProblem = injectionOutputProblem(inputMembers, listMembers(broken))
    check('负控：解不开的产物必须判红（读不出成员清单）', brokenProblem !== null && /读不出/.test(brokenProblem), String(brokenProblem))

    // ④ 输入读不出时不得放行（否则「两边都读不出」会被当成「一样」）。
    check('负控：输入读不出时不得放行', injectionOutputProblem(null, []) !== null)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  if (failures.length > 0) {
    console.error('CHECK-INJECTION-OUTPUT SELF-TEST FAILED（' + failures.length + ' 项）')
    process.exit(1)
  }
  console.log('CHECK-INJECTION-OUTPUT SELF-TEST PASSED（1 正控 + 3 负控）')
  process.exit(0)
}

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) selfTest()

const [inputPath, outputPath] = argv
if (!inputPath || !outputPath) {
  console.error('用法: node scripts/check-injection-output.mjs <input.tar.xz> <output.tar.xz> [--self-test]')
  process.exit(2)
}
if (!existsSync(inputPath)) {
  console.error('CHECK-INJECTION-OUTPUT 无法判定：输入快照不存在 ' + inputPath)
  process.exit(2)
}
if (!existsSync(outputPath)) {
  console.error('CHECK-INJECTION-OUTPUT FAILED：注入产物不存在 ' + outputPath)
  process.exit(1)
}
const problem = injectionOutputProblem(listMembers(inputPath), listMembers(outputPath))
if (problem !== null) {
  console.error('CHECK-INJECTION-OUTPUT FAILED：' + problem)
  process.exit(1)
}
console.log('CHECK-INJECTION-OUTPUT PASSED（产物 ' + listMembers(outputPath).length + ' 条 >= 输入 '
  + listMembers(inputPath).length + ' 条）')
