#!/usr/bin/env node
// check-snapshot-archive-exit-code.test.mjs — 归档段的退出码判据（issue #1074）。
//
// 【为什么必须存在（实锤）】
// 构建器归档段旧写法是 `tar -c … 2>/dev/null | xz -T8 -6 > snapshot.tar.xz`。没开 pipefail
// 时管道状态 = **最后一段**（xz）的状态；xz 对「读到的残缺流」照样 exit 0。于是 tar 层面的
// 失败（成员缺失 / 文件不可读 / 读到一半被改）全部不可见：残缺归档被算 sha256、写进
// snapshot.sha256，再作为构建输入发布出去，全链零报错。
//
// 【判据分三层，缺一层就留假绿余地】
//   ① 纯函数层：换行归一化不得吃掉续行反斜杠；pipefail 默认加且幂等、可显式退出。
//   ② 真实 shell 层（负控 + 放行例）：真的跑段化归档，用缺成员的 stage 造 tar 失败。
//      负控要求非 0（旧一行管道是 0）；放行例要求完整 stage 仍 0 且成员读得出来。
//   ③ 源码形状层：构建器 archive 段不得回退成「tar 直接接管道」，且两段都取退出码。
//
// ② 需要 bash + tar + xz：Linux 原生跑；Windows 经 WSL 跑（与构建器 sh() 同一路径）。
// 拿不到 shell 时**显式 skip 并打印原因**，不得静默当通过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shStatus, toOneLine, withPipefail, wslPath } from './lib/shell.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILDER = join(ROOT, 'scripts', 'build-snapshot-013.mjs')
// 反斜杠刻意不写字面量：本文件要断言的正是「续行反斜杠没被吃掉」，而多层转义在
// 模板串 / JSON 往返里极易被吞（仓内已有实锤）。用字符码构造，读起来也不歧义。
const BS = String.fromCharCode(92)

// ── ① 纯函数层 ─────────────────────────────────────────────────────────
test('toOneLine keeps continuation backslashes and only joins blank-line-separated commands', () => {
  // 真因：旧实现把「反斜杠 + 换行」一起替换成空格，模板串的续行符被孤立成 '&& \ ; '，
  // bash 把孤立反斜杠当空命令——实测每调用一次吐一句 "bash: line 1:  : command not found"。
  const multi = 'cd /x && ' + BS + '\n  tar -c usr > out.tar && ' + BS + '\n  ls -lh out.tar'
  const one = toOneLine(multi)
  assert.equal(one.includes('&& ' + BS + ' '), false, '续行反斜杠不得被孤立');
  assert.equal(one.includes('&& ' + BS + ' ; '), false, '续行反斜杠后不得插进 " ; "');
  assert.match(one, /^cd \/x &&\s+tar -c usr > out\.tar &&\s+ls -lh out\.tar$/);
  // 真正的「两行独立命令」仍要按 ' ; ' 保序连成一行（Windows CreateProcess 不接受裸换行）
  assert.equal(toOneLine('echo a\n\necho b'), 'echo a ; echo b');
})

test('withPipefail is default-on, idempotent, and can be opted out explicitly', () => {
  assert.equal(withPipefail('tar -c . | xz > a'), 'set -o pipefail; tar -c . | xz > a');
  // 幂等：已带前缀的命令不得再叠一层（否则调用点写法被掩盖，也读不出「谁加的」）
  const already = 'set -o pipefail; tar -c . | xz > a';
  assert.equal(withPipefail(already), already);
  // 知情退出：只有显式 false 才不加（少数调用点确实只看最后一段）
  assert.equal(withPipefail('find . | wc -l', false), 'find . | wc -l');
})

// ── ② 真实 shell 层 ────────────────────────────────────────────────────
const shellAvailable = (() => {
  const probe = 'command -v tar >/dev/null && command -v xz >/dev/null && echo ok'
  const r = process.platform === 'win32'
    ? spawnSync('wsl.exe', ['-e', 'bash', '-lc', probe], { encoding: 'utf8' })
    : spawnSync('/bin/bash', ['-c', probe], { encoding: 'utf8' })
  return String(r.stdout ?? '').includes('ok')
})()
const needsShell = { skip: shellAvailable ? false : '本机没有 bash + tar + xz，该层无法取证（不得当通过）' }

test('sh() defaults to pipefail so a failing first pipe segment is not masked by the last one', needsShell, () => {
  // 这是 #1074 的**最底层**判据：管道里第一段失败必须冒出来。
  // 只有这一条能证明「默认值」本身没被悄悄改回 false —— 段化归档不走管道，测不到它。
  const failingFirstSegment = 'tar -c --mtime=@1 /nonexistent-member-dsh-1074 2>/dev/null | xz -T2 -6 > /dev/null'
  assert.notEqual(shStatus(failingFirstSegment).status, 0,
    '默认档必须带 pipefail：否则 tar 失败被 xz 的 0 掩盖（缺陷本体）')
  // 知情退出仍是合法写法（少数调用点确实只看最后一段）——但必须显式写出来
  assert.equal(shStatus(failingFirstSegment, { pipefail: false }).status, 0,
    '显式 pipefail:false 仍应保留「只看最后一段」的旧语义，供确实需要它的调用点使用')
  // 放行例：健康管道在默认档下照样 0（防「一律拒」）
  assert.equal(shStatus('echo hi | cat').status, 0, '健康管道不得因 pipefail 默认值被误判')
})

/** 段化归档：tar 取自己的退出码，xz 再单独压。与构建器改后的形状一一对应。 */
const runArchive = (stageRoot, archive) => {
  const tarTo = archive + '.tar'
  const tarStage = shStatus('cd "' + wslPath(stageRoot) + '" && tar -c --mtime=@1704067200 usr home/.dsh home/.gitconfig > "' + wslPath(tarTo) + '"')
  if (tarStage.status !== 0) return { status: tarStage.status, stage: 'tar', stderr: tarStage.stderr }
  const xzStage = shStatus('xz -T8 -6 -c "' + wslPath(tarTo) + '" > "' + wslPath(archive) + '"')
  return { status: xzStage.status, stage: 'xz', stderr: xzStage.stderr }
}

const makeStage = (root, { gitconfig }) => {
  const stage = join(root, 'stage', 'root')
  mkdirSync(join(stage, 'usr', 'share', 'LICENSES'), { recursive: true })
  mkdirSync(join(stage, 'home', '.dsh'), { recursive: true })
  // 4 个 LICENSES + home/.dsh 足以让归档后的三道自检（licCount>=4、0 条旧前缀软链、
  // profile 清单）**全部放行**——这正是 #1074 的要害：只有 tar 自己的退出码能发现成员缺失。
  for (const n of ['A', 'B', 'C', 'D']) writeFileSync(join(stage, 'usr', 'share', 'LICENSES', n + '.txt'), n)
  writeFileSync(join(stage, 'home', '.dsh', 'settings.yaml'), 'settings\n')
  if (gitconfig) writeFileSync(join(stage, 'home', '.gitconfig'), '[safe]\n\tdirectory = *\n')
  return stage
}

test('negative control: a missing archive member fails the tar stage and names the member', needsShell, () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-exit-'))
  try {
    const stage = makeStage(root, { gitconfig: false })
    const result = runArchive(stage, join(root, 'snapshot.tar.xz'))
    assert.notEqual(result.status, 0, 'tar 缺成员必须以非 0 结束（旧管道写法这里报 0）')
    assert.equal(result.stage, 'tar', '失败必须发生在 tar 段，不能被 xz 段掩盖')
    assert.match(result.stderr, /gitconfig/, '报错必须指向真因（缺的那个成员），不能只说「失败」')
    // 缺陷本体反证：同一份 stage 走旧的一行管道，退出码是 0 —— 证明判据不是空转。
    const legacyCmd = 'cd "' + wslPath(stage) + '" && tar -c --mtime=@1704067200 usr home/.dsh home/.gitconfig 2>/dev/null | xz -T8 -6 > "' + wslPath(join(root, 'legacy.tar.xz')) + '"'
    const legacy = shStatus(legacyCmd, { pipefail: false })
    assert.equal(legacy.status, 0, '旧写法（无 pipefail）对残缺归档报 0：缺陷仍可复现，判据有判别力')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('pass case: a complete stage still archives successfully and keeps every member', needsShell, () => {
  const root = mkdtempSync(join(tmpdir(), 'archive-ok-'))
  try {
    const stage = makeStage(root, { gitconfig: true })
    const archive = join(root, 'snapshot.tar.xz')
    const result = runArchive(stage, archive)
    assert.equal(result.status, 0, '完整 stage 必须归档成功（防「一律拒」的粗暴实现）: ' + result.stderr)
    // 放行例不能只看退出码：成员必须真能列出来（含负控里缺掉的那个）
    const list = shStatus('tar -tf "' + wslPath(archive) + '"')
    assert.equal(list.status, 0)
    assert.match(list.stdout, /home\/\.gitconfig/)
    assert.match(list.stdout, /usr\/share\/LICENSES\/A\.txt/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── ③ 源码形状层 ───────────────────────────────────────────────────────
test('builder archives tar and xz as two stages that each report their own exit code', () => {
  const text = readFileSync(BUILDER, 'utf8')
  const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  // 负控（源码形状）：任何「tar -c … | …」行都判红 —— 那正是缺陷本体
  const piped = code.split('\n').filter((l) => /tar\s+-c\b[^\n]*\|/.test(l))
  assert.deepEqual(piped, [], '归档 tar 不得直接接管道：管道退出码归最后一段，tar 的失败会被吞掉')
  // 正向：两段都在，且各自取退出码、非 0 必须中止
  assert.match(code, /tar\s+-c[^\n]*>\s*"\$\{wslPath\(archiveTar\)\}"/, 'tar 段必须落中间件并以自己的退出码为准')
  assert.match(code, /shStatus\(`[^`]*archiveTar/, 'tar 段必须经 shStatus 取状态（sh() 只看抛不抛异常）')
  assert.match(code, /xz\s+-T\$\{XZ_THREADS\}[^\n]*-c[^\n]*archiveTar/, 'xz 段必须单读中间件再压')
  assert.match(code, /tarRun\.status\s*!==\s*0/, 'tar 非 0 必须显式中止')
  assert.match(code, /xzRun\.status\s*!==\s*0/, 'xz 非 0 必须显式中止')
})
