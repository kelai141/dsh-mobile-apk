// file-upload-restart-r1.test.mjs — R1 补丁回归：锚点命中 + 守卫消失 + 同槽覆盖语义 + 幂等。
//
// 背景（2026-09-28 模拟器 5556 实锤）：cordis `Fiber._reload()` 的顺序是「先跑新实例 body、
// 再 `_unload()` 释放旧 effect」。于是 session-controller 因 `agent-default-model` 条目 config
// 被改写（例如在设置里换一次默认模型）而重启时，新 `SessionController` 构造里的
// `ctx.effect(() => ctx.fileUploads.registerAgentResolver(...))` 撞上上游单槽守卫
// ⇒ 新 fiber 判 FAILED、旧 fiber 随后释放 ⇒ `sessionController` 永久缺席
//   （客户端恒报 `session/control: active Service "sessionController" is unavailable`）。
//
// 本测试做四件事：
//   ① 用同版本只读 fixture 跑 apply-patches（锚点未命中即报错，而不是静默通过）；
//   ② 断言守卫消失、补丁标记在场、disposer 的身份判据仍在、且没有引入第二个槽；
//   ③ 把打过补丁的 `registerAgentResolver` 逐字抽出做行为断言——同槽覆盖、旧 disposer 不误清新注册、
//      新 disposer 仍能清槽。第 ③ 步是必需的：只 grep 标记证明不了重启语义真的成立；
//   ④ 幂等：再施加一次必须零改写。
//
// 用法：node scripts/patches/tests/file-upload-restart-r1.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { versionedFixture } from './lib/fixture.mjs'

/** Node on Android is entered through the dynamic linker, so `process.execPath` reports
 *  /apex/com.android.runtime/bin/linker64 rather than the interpreter; argv0 carries the real
 *  binary there and is the bare name on desktop POSIX, so prefer it only when it is absolute. */
const NODE = process.argv0 && isAbsolute(process.argv0) ? process.argv0 : process.execPath

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-file-upload/lib/index.js'
const FIXTURE = versionedFixture('dsh-client-file-upload', 'lib', 'index.js')
const PATCH_ID = 'file-upload-restart-R1'

const failures = []
/** Assert one condition, recording the failure instead of throwing so every check reports. */
function check(label, ok, detail) {
  console.log((ok ? '[PASS] ' : '[FAIL] ') + label + (ok || detail === undefined ? '' : ' -- ' + detail))
  if (!ok) failures.push(label)
}

/** Extract one member's source verbatim by brace matching.
 *  The parameter list is consumed first: a default value carrying braces would otherwise be
 *  mistaken for the body opening by a plain "first brace after the signature" scan. */
function extractFunction(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('function not found: ' + signature)
  let parens = 0
  let bodyStart = -1
  for (let i = source.indexOf('(', start); i < source.length; i += 1) {
    if (source[i] === '(') parens += 1
    else if (source[i] === ')') {
      parens -= 1
      if (parens === 0) { bodyStart = source.indexOf('{', i); break }
    }
  }
  if (bodyStart < 0) throw new Error('body not found for ' + signature)
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}

// 反证（夹具侧）：本回归的判别力来自「补丁前该守卫真的会拒绝重注册」。夹具必须带着守卫，
// 否则「守卫已移除」这条断言对任何文件都成立。
const fixtureSource = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n')
check('夹具带守卫（补丁前状态）', fixtureSource.includes('Agent resolver is already registered'))

const scratch = mkdtempSync(join(tmpdir(), 'r1-test-'))
let patched
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  // fixture 索引 LF，而工作树在 core.autocrlf=true 下可能是 CRLF——按 LF 归一后写夹具，
  // 否则多行锚点恒失配，本回归会「本机必红」并失去信号。
  writeFileSync(target, fixtureSource)

  const args = [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--scope', 'engine', '--only', PATCH_ID]
  const applied = spawnSync(NODE, [...args, '--apply'], { encoding: 'utf8' })
  check('apply-patches exits 0', applied.status === 0, (applied.stderr || applied.stdout || '').trim().split('\n').slice(-2).join(' '))
  patched = readFileSync(target, 'utf8')

  // ④ 幂等：同一棵已打过补丁的树再跑一次必须零改写。
  const again = spawnSync(NODE, [...args, '--apply'], { encoding: 'utf8' })
  check('再次施加幂等（changed=0）', again.status === 0 && /changed=0/.test(again.stdout || ''), (again.stdout || '').trim().split('\n').slice(-2).join(' '))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// ② 静态面
check('锚点命中：守卫已移除', !patched.includes('Agent resolver is already registered'))
check('补丁标记在场', patched.includes('dsh-mobile file-upload resolver replace (R1)'))
check('未引入第二个槽', (patched.match(/this\.agentResolution\.resolver = resolve/g) || []).length === 1)
check('disposer 保留身份判据',
  patched.includes('if (this.agentResolution.resolver === resolve) this.agentResolution.resolver = void 0;'))

// ③ 行为面：把打过补丁的成员逐字抽出，装进最小宿主跑重启语义
const member = extractFunction(patched, 'registerAgentResolver(resolve) {')
const factory = new Function('return { agentResolution: { resolver: void 0 }, ' + member + ' };')

{
  const svc = factory()
  const first = () => 'first'
  const second = () => 'second'
  const disposeFirst = svc.registerAgentResolver(first)
  check('首次注册写入槽', svc.agentResolution.resolver === first)

  let threw = null
  let disposeSecond = null
  try { disposeSecond = svc.registerAgentResolver(second) } catch (error) { threw = error }
  check('重启（同槽重注册）不再抛错', threw === null, threw && threw.message)
  check('同槽覆盖：槽指向新 resolver', svc.agentResolution.resolver === second)

  // cordis 的顺序：新实例先注册，旧 fiber 的 disposer 随后才跑 ⇒ 它绝不能清掉新注册。
  if (disposeFirst) disposeFirst()
  check('旧 disposer 不误清新注册', svc.agentResolution.resolver === second)

  if (disposeSecond) disposeSecond()
  check('新 disposer 仍能清槽', svc.agentResolution.resolver === undefined)
}

// ③ 反证：把**补丁前**的同一成员抽出跑一遍——它必须在重注册时抛错，
// 否则「不再抛错」这条断言对任何实现都成立。
{
  const original = extractFunction(fixtureSource, 'registerAgentResolver(resolve) {')
  const bareFactory = new Function('return { agentResolution: { resolver: void 0 }, ' + original + ' };')
  const svc = bareFactory()
  svc.registerAgentResolver(() => 'first')
  let threw = null
  try { svc.registerAgentResolver(() => 'second') } catch (error) { threw = error }
  check('反证：补丁前实现确实拒绝重注册', threw !== null && /already registered/.test(String(threw && threw.message)))
}
console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
