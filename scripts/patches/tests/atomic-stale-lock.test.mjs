// atomic-stale-lock.test.mjs — F4 补丁回归：锚点命中 + 行为正确 + 幂等。
//
// 用 devices/引擎树同一版本的只读 fixture（fixtures/dsh-atomic-write-0.1.5-rc.1/lib/index.js）在临时
// 根目录复现「引擎树」形态，跑 apply-patches --apply --scope engine --only atomic-stale-lock-F4，
// 然后直接 import 打过补丁的 ESM 产物做行为断言：孤儿锁回收、活锁仍超时、垃圾内容不动锁。
//
// 为什么要有行为断言：锚点命中只证明文本被替换，不证明替换后的代码能跑
// （实测踩过：上游 `const deadline` 被赋值 → 补丁首版 TypeError: Assignment to constant variable）。
//
// 用法：node scripts/patches/tests/atomic-stale-lock.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js'
const FIXTURE = join(here, 'fixtures', 'dsh-atomic-write-0.1.5-rc.1', 'lib', 'index.js')

const failures = []
/** Assert one condition, recording the failure instead of throwing so every check reports. */
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/** Run apply-patches against `root` and return the spawned result. */
function applyPatches(root) {
  return spawnSync(process.execPath, [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), root, '--apply', '--scope', 'engine', '--only', 'atomic-stale-lock-F4'], { encoding: 'utf8' })
}

const scratch = mkdtempSync(join(tmpdir(), 'f4-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  // FX-E19：fixture 索引 LF 而工作树在 core.autocrlf=true 下是 CRLF——按 LF 归一后写夹具，
  // 否则多行锚点（带 \n）恒失配 → 本回归在 CRLF 工作树上「本机必红」（CI 的 LF 检出看不出）。
  writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

  const first = applyPatches(scratch)
  check('apply-patches exits 0', first.status === 0, (first.stderr || '').trim().split('\n').slice(-2).join(' '))
  const patched = readFileSync(target, 'utf8')
  check('marker present after apply', patched.includes('dsh-mobile stale-lock recovery (F4)'))
  check('readFile imported', patched.includes('import { lstat, mkdir, readFile, rename, rm, writeFile }'))
  check('deadline is reassignable', patched.includes('let deadline = Date.now()'))

  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', syntax.status === 0, (syntax.stderr || '').split('\n')[0])

  applyPatches(scratch)
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)

  const mod = await import(pathToFileURL(target).href)
  const statePath = join(scratch, 'state.yaml')
  const lockPath = statePath + '.lock'

  check('lock-free call runs the operation', await mod.withFileLock(statePath, async () => 'ran', { waitMs: 200 }) === 'ran')
  check('lock released after the operation', !existsSync(lockPath))

  // 孤儿锁：owner pid 已消失 -> 回收后成功
  writeFileSync(lockPath, '999999\n', { mode: 0o600 })
  check('orphaned lock recovered', await mod.withFileLock(statePath, async () => 'recovered', { waitMs: 60 }) === 'recovered')
  check('orphaned lock removed', !existsSync(lockPath))

  // 活锁：owner 是本进程 -> 仍然超时且锁保留
  writeFileSync(lockPath, String(process.pid) + '\n', { mode: 0o600 })
  let liveError = null
  try { await mod.withFileLock(statePath, async () => 'never', { waitMs: 60 }) } catch (error) { liveError = error.message }
  check('live lock still times out', typeof liveError === 'string' && liveError.includes('timed out waiting for the writer lock'))
  check('live lock is kept', existsSync(lockPath))

  // 垃圾内容：不解析 -> 不动锁
  writeFileSync(lockPath, 'not-a-pid\n', { mode: 0o600 })
  let garbageError = null
  try { await mod.withFileLock(statePath, async () => 'never', { waitMs: 60 }) } catch (error) { garbageError = error.message }
  check('unparseable lock is left alone', typeof garbageError === 'string' && existsSync(lockPath))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\natomic-stale-lock: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('\natomic-stale-lock: all checks passed')
