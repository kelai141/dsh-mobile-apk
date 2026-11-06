// fs-local-link-f8.test.mjs — F8 补丁回归：锚点命中 + 站点接线 + 等价实现行为正确。
//
// 背景（apk issue #246）：dsh-fs-observation-policy 对「未观察过 / 确认不存在」的路径判写意图
// createIfAbsent，dsh-fs-local 的 writeFileAtomic 拿到该意图后只能用 link(2) 做 no-replace 发布，
// 失败即抛、该分支没有任何回退；Android 应用域恒拒 hardlink（EACCES，denial 被 dontaudit 静默）
// ⇒ 真机上 write 工具建不了任何新文件（覆盖已存在文件走 else 的 rename，正常）——症状是「只能改不能建」。
// 与坑位 #77 / attach-durable-F2 / spj-migration-link-F5 同一 sepolicy 限制，本文件是它的第 4 个站点。
//
// 本测试做三件事：① 用同版本只读 fixture 跑 apply-patches（锚点命中）；② 断言站点接线与标记；
// ③ 把打过补丁的 dshMobilePublishExclusive 逐字抽出做行为断言——占位成功即 rename 发布、
// 占位 EEXIST 走原拒绝路径且不 rename/不回收、rename 失败回收占位并原样抛出。
// 第 ③ 步是必需的：本补丁不是「把 link 换成 rename」那么简单——直接换会丢掉 link 的独占语义
// （静默覆盖并发创建者的文件），断言必须证明独占语义与失败回收都还在。
//
// `--asset <file>`（review C1）：跳过补丁施加，直接对**运行时资产正文本体**跑同一组断言
// （check-runtime-assets.mjs 的行为回归以该模式调用）。
//
// 用法：node scripts/patches/tests/fs-local-link-f8.test.mjs [--asset <asset.js>]
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
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js'
const FIXTURE = versionedFixture('dsh-fs-local', 'lib', 'index.js')

const failures = []
/** Assert one condition, recording the failure instead of throwing so every check reports. */
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/** Extract one function's source verbatim by brace matching.
 *  The parameter list is consumed first: a default value such as `internals = {}` carries braces
 *  that a plain "first brace after the signature" scan would mistake for the body opening. */
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

const assetIdx = process.argv.indexOf('--asset')
const ASSET = assetIdx >= 0 ? process.argv[assetIdx + 1] : null

let patched
if (ASSET) {
  patched = readFileSync(ASSET, 'utf8')
  check('资产正文本体在场且非空', patched.length > 0, ASSET)
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'f8-test-'))
  try {
    const target = join(scratch, TARGET)
    mkdirSync(dirname(target), { recursive: true })
    // fixture 索引 LF 而工作树在 core.autocrlf=true 下是 CRLF——按 LF 归一后写夹具，
    // 否则多行锚点（带 \n）恒失配 → 本回归「本机必红」且后续补丁回归全部失去信号。
    writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

    const applied = spawnSync(NODE, [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'fs-local-link-F8'], { encoding: 'utf8' })
    check('apply-patches exits 0', applied.status === 0, (applied.stderr || '').trim().split('\n').slice(-2).join(' '))
    patched = readFileSync(target, 'utf8')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

  // ② 标记与站点接线
  check('站点带 F8 回退标记', (patched.match(/dsh-mobile link->rename fallback \(F8\)/g) || []).length === 1)
  check('等价实现带 F8 标记', patched.includes('dsh-mobile exclusive create (F8)'))
  check('等价实现被定义且被站点调用', (patched.match(/dshMobilePublishExclusive\(/g) || []).length === 2)
  const F8_PREDICATE = '(error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP" || error.code === "ENOSYS")'
  check('F8站点的精确predicate包含ENOSYS', patched.includes(F8_PREDICATE))
  check('非权限错误仍走原拒绝路径',
    patched.includes('await throwGuardedCreateFailure(error, absolutePath, displayPath, inspectPublicationTarget);'))
  check('站点把 internals 透传给等价实现',
    patched.includes('await dshMobilePublishExclusive(tempPath, absolutePath, displayPath, inspectPublicationTarget, internals);'))
  check('等价实现用 O_EXCL 占位（保住 no-replace 语义）', patched.includes('await openFile(absolutePath, "wx");'))
  check('未把 link 站点直接改成裸 rename', !patched.includes('\t\t\tawait rename(tempPath, absolutePath);\n\t\t} catch (error) {\n\t\t\t/* dsh-mobile'))

  // Execute the exact runtime catch predicate: unsupported links may fall back,
  // unrelated IO/refusal failures must preserve their original path.
  const predicate = /if \(!\((error instanceof Error && "code" in error && \(error\.code === "EACCES"[^\n]+?)\)\) \{/.exec(patched)?.[1]
  check('runtime catch predicate extracted', typeof predicate === 'string')
  if (predicate) {
    const eligible = new Function('error', 'return (' + predicate + ')')
    for (const code of ['EACCES', 'EPERM', 'ENOTSUP', 'ENOSYS']) {
      check(code + ' routes to exclusive publication fallback', eligible(Object.assign(new Error(code), { code })) === true)
    }
    for (const code of ['EIO', 'EEXIST', 'ENOENT']) {
      check(code + ' preserves original refusal', eligible(Object.assign(new Error(code), { code })) === false)
    }
  }

  // ②-a 从旧版已打 F8 的资产升级：只升级 F8 predicate，重复应用必须字节幂等。
  if (!ASSET) {
    const scratch = mkdtempSync(join(tmpdir(), 'f8-upgrade-test-'))
    try {
      const target = join(scratch, TARGET)
      mkdirSync(dirname(target), { recursive: true })
      const olderPredicate = '(error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP")'
      const oldAsset = patched.replace(F8_PREDICATE, olderPredicate) + '\n// unrelated copy of expected-looking text must not suppress the F8 upgrade.\n// ' + F8_PREDICATE
      writeFileSync(target, oldAsset)
      const apply = () => spawnSync(NODE, [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'fs-local-link-F8'], { encoding: 'utf8' })
      const upgraded = apply()
      const once = readFileSync(target, 'utf8')
      check('旧F8资产升级命令成功', upgraded.status === 0)
      check('旧F8资产只升级到精确predicate', once.includes(F8_PREDICATE) && (once.match(/dsh-mobile link->rename fallback \(F8\)/g) || []).length === 1 && once.includes('// ' + F8_PREDICATE))
      const repeated = apply()
      check('已升级F8资产再次应用成功', repeated.status === 0)
      check('已升级F8资产重复应用字节幂等', readFileSync(target).equals(Buffer.from(once)))
    } finally { rmSync(scratch, { recursive: true, force: true }) }
  }

  // Execute the actual generated link catch block, not a separately retyped predicate.
  {
    const site = /\t\t\tif \(!\(error instanceof Error[\s\S]*?\n\t\t\t\}\n\t\t\}/.exec(patched)
    check('F8实际link catch块可提取', !!site)
    if (site) {
      const block = site[0].replaceAll('displayPath', 'displayPath')
      const call = new Function('linkFile', 'throwGuardedCreateFailure', 'dshMobilePublishExclusive', 'tempPath', 'absolutePath', 'displayPath', 'inspectPublicationTarget', 'internals',
        'return async function run() { try { await linkFile(tempPath, absolutePath); } catch (error) {' + block + '\n}')
      const invoke = (link, events) => call(link,
        async (e) => { events.push('guard:' + e.code); throw e },
        async () => { events.push('fallback') }, 'tmp', 'dst', 'dst', async () => undefined, {})
      const events = []
      await invoke(async () => { throw Object.assign(new Error('synthetic'), { code: 'ENOSYS' }) }, events)()
      check('真实ENOSYS link调用路径进入exclusive fallback', events.join(',') === 'fallback', events.join(','))
      const deniedEvents = []
      try { await invoke(async () => { throw Object.assign(new Error('synthetic'), { code: 'EIO' }) }, deniedEvents)() } catch {}
      check('真实EIO link调用路径保留原guard且不fallback', deniedEvents.join(',') === 'guard:EIO', deniedEvents.join(','))
    }
  }

  // ③ 行为：把等价实现逐字抽出，注入桩件跑三条路径
  const source = extractFunction(patched, 'async function dshMobilePublishExclusive(')
  const factory = new Function('open', 'rename', 'rm', 'throwGuardedCreateFailure',
    source + '\nreturn dshMobilePublishExclusive;')

  // ③-a 占位成功 => rename 发布，且不回收、句柄已关闭
  {
    const calls = { rename: [], rm: [], closed: 0 }
    const helper = factory(
      async () => ({ close: async () => { calls.closed += 1 } }),
      async (from, to) => { calls.rename.push([from, to]) },
      async (path, opts) => { calls.rm.push([path, opts]) },
      async () => { throw new Error('guard must not run') })
    await helper('/tmp/t1', '/tmp/d1', 'd1', async () => undefined)
    check('占位成功 => rename 发布', calls.rename.length === 1 && calls.rename[0][0] === '/tmp/t1' && calls.rename[0][1] === '/tmp/d1',
      JSON.stringify(calls.rename))
    check('占位成功 => 不回收占位', calls.rm.length === 0)
    check('占位成功 => 句柄已关闭', calls.closed === 1, 'closed=' + calls.closed)
  }

  // ③-b 占位 EEXIST（并发创建者赢了）=> 走原拒绝路径，不 rename、不回收
  {
    const calls = { rename: [], rm: [], guard: [] }
    const eexist = Object.assign(new Error('EEXIST: file already exists, open ...'), { code: 'EEXIST' })
    let refused = null
    const helper = factory(
      async () => { throw eexist },
      async (from, to) => { calls.rename.push([from, to]) },
      async (path, opts) => { calls.rm.push([path, opts]) },
      async (error, absolutePath, displayPath) => { refused = error; calls.guard.push(displayPath); throw new Error('REFUSED') })
    let threw = null
    try { await helper('/tmp/t2', '/tmp/d2', 'd2', async () => undefined) } catch (error) { threw = error }
    check('占位 EEXIST => 交给原拒绝路径', refused === eexist && calls.guard[0] === 'd2', String(refused && refused.code))
    check('占位 EEXIST => 不 rename（独占语义保住）', calls.rename.length === 0)
    check('占位 EEXIST => 不回收（那是赢家的文件）', calls.rm.length === 0)
    check('占位 EEXIST => 对外抛出', threw !== null)
  }

  // ③-c rename 失败 => 回收占位（force）并原样抛出，防 0 字节残留
  {
    const calls = { rm: [] }
    const eio = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    const helper = factory(
      async () => ({ close: async () => {} }),
      async () => { throw eio },
      async (path, opts) => { calls.rm.push([path, opts]) },
      async () => { throw new Error('guard must not run') })
    let threw = null
    try { await helper('/tmp/t3', '/tmp/d3', 'd3', async () => undefined) } catch (error) { threw = error }
    check('rename 失败 => 回收占位', calls.rm.length === 1 && calls.rm[0][0] === '/tmp/d3', JSON.stringify(calls.rm))
    check('rename 失败 => 回收用 force', !!(calls.rm[0] && calls.rm[0][1] && calls.rm[0][1].force === true))
    check('rename 失败 => 原样抛出', threw === eio)
  }

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
