/** terminal-shell-candidates-T1 回归：Android 上的系统 cmd 不进 shell 列表。纯字符串变换。 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { hasTerminalShellCandidates, patchTerminalShellCandidates } from '../data/terminal-shell-candidates-T1.mjs'

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
