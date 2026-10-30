/** terminal-shell-candidates-T1 回归：Android 上的系统 cmd 不进 shell 列表。
 *
 * 0.14.11 / issue #1005：旧版只在一段手写 SNIPPET 上跑字符串变换，fixtures 引用数为 0。
 * 现在真夹具（引擎产物）上必须能打成功，片段继续钉变换细节。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { hasTerminalShellCandidates, patchTerminalShellCandidates } from '../data/terminal-shell-candidates-T1.mjs'
import { versionedFixture } from './lib/fixture.mjs'

/** 上游 discoverShells 收编段的最小片段（缩进与产物一致：两个制表符）。 */
const SNIPPET = [
  'async function discoverShells(subprocess, configured, candidates, signal) {',
  '\tfor (const shell of [preferred, ...found]) {',
  '\t\tif (shell === void 0) continue;',
  '\t\tconst kind = shellKind(shell.path);',
  '\t\tif (!shells.has(kind)) shells.set(kind, shell);',
  '\t}',
  '}',
].join('\n')

/**
 * 读当前引擎代的真产物（未打补丁的引擎字节）。
 *
 * @returns dsh-api-terminal-controller 的 lib/index.js 全文。
 */
function realArtifact() {
  return readFileSync(versionedFixture('dsh-api-terminal-controller', 'lib', 'index.js'), 'utf8')
}

test('真夹具（引擎产物）里锚点确实存在，且补丁能打成功', () => {
  const source = realArtifact()
  // 锚点是收编段的 shellKind(shell.path) 那一处：补丁在它后面插 cmd 判据。
  assert.ok(source.includes('shellKind(shell.path)'), '引擎产物里必须存在 shellKind(shell.path) 锚点')
  assert.ok(source.includes('shells.set(kind, shell)'), '引擎产物里必须存在 shells.set 收编语句')
  assert.equal(hasTerminalShellCandidates(source), false, '未打补丁的引擎产物不该已带判据')

  const patched = patchTerminalShellCandidates(source)
  assert.equal(hasTerminalShellCandidates(patched), true, '打过补丁的真产物必须被 check 认出')
  assert.ok(
    patched.includes('if (kind === "cmd" && !/cmd\\.exe$/i.test(shell.path)) continue;'),
    '真产物上必须插入了 cmd 判据',
  )
  // 判据必须落在收编之前，否则 cmd 已经进表。
  assert.ok(
    patched.indexOf('shellKind(shell.path)') < patched.indexOf('shells.set(kind, shell)'),
    '收编顺序不变',
  )
  // 幂等由 hasTerminalShellCandidates 前置检查承担，不是 patch 函数自身幂等。
})

test('真夹具上补丁前后字节长度增加', () => {
  const source = realArtifact()
  const patched = patchTerminalShellCandidates(source)
  assert.ok(patched.length > source.length, '补丁必须真的插入内容')
})

test('收编段插入 cmd 判据：非 .exe 的 cmd 直接跳过', () => {
  const out = patchTerminalShellCandidates(SNIPPET)
  assert.ok(out.includes('if (kind === "cmd" && !/cmd\\.exe$/i.test(shell.path)) continue;'))
  // 判据必须在 set 之前，否则 cmd 已经进表了
  assert.ok(out.indexOf('cmd.exe') < out.indexOf('shells.set(kind, shell)'))
})

test('Windows 的 cmd.exe 仍保留（判据只排除没有 .exe 的同名二进制）', () => {
  const out = patchTerminalShellCandidates(SNIPPET)
  const re = /if \(kind === "cmd" && !\/(cmd\\\.exe\$)\/i\.test\(shell\.path\)\) continue;/
  assert.match(out, re)
})

test('幂等：check 先行，已打过的输入可识别', () => {
  const once = patchTerminalShellCandidates(SNIPPET)
  assert.equal(hasTerminalShellCandidates(once), true)
  assert.equal(hasTerminalShellCandidates(SNIPPET), false)
})

test('锚点缺失时抛错，拒绝写半成品', () => {
  assert.throws(() => patchTerminalShellCandidates('const x = 1;'), /锚点未命中/)
})
