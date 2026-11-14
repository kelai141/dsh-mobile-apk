// patch-apply-resolve-throw-1578.test.mjs — issue #1578 回归：目标解析抛错不得穿出主循环。
//
// 缺陷形态（改前）：resolveEnginePatchFile 在 targetDiscovery 目录缺失/锚点不唯一时 throw，
// 该调用位于 try 之外 ⇒ 异常穿出 for 循环，既不打 [fail] 诊断，也跳过 failed 计数与整树回滚。
// 判据：失败必须是受控诊断行（[fail] <id>: 目标解析/读取失败），且进程不得以未捕获异常退出。
//
// 制造失败：暂存树里不放 terminal-inspector-android-D1 的 targetDiscovery 目录
// （usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib）。
// 用法：node scripts/patches/tests/patch-apply-resolve-throw-1578.test.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const patchRunner = join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs')
const NODE_BIN = process.execPath.endsWith('linker64') ? 'node' : process.execPath
const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const root = mkdtempSync(join(tmpdir(), 'patch-resolve-throw-1578-'))
try {
  const run = spawnSync(NODE_BIN, [patchRunner, root, '--apply', '--scope', 'engine', '--only', 'terminal-inspector-android-D1'], {
    encoding: 'utf8',
    cwd: repoRoot,
  })
  const out = (run.stdout ?? '') + (run.stderr ?? '')
  check('解析失败以非零退出', run.status === 1, String(run.status))
  check('失败走受控诊断行（[fail] …目标解析/读取失败），而不是穿出循环',
    out.includes('[fail] terminal-inspector-android-D1: 目标解析/读取失败'), out.slice(-1500))
  check('不得出现未捕获异常堆栈', !/\n\s+at .+\(.+\)/.test(run.stderr ?? '') || out.includes('[fail]'), (run.stderr ?? '').slice(0, 800))
  check('汇总行报告失败计数', out.includes('失败 1'), out.slice(-800))
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\npatch-apply-resolve-throw-1578: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('\npatch-apply-resolve-throw-1578: all checks passed')
