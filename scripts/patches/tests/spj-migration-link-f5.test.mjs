// spj-migration-link-f5.test.mjs — F5 补丁回归：锚点命中 + 两处站点 + 行为正确。
//
// 背景（apk issue #154）：0.1.5 起会话格式推到 v3，旧会话（header version:0）首次打开必走 v0→v3 迁移，
// 最后一步 publishCurrentExclusive() 用 link(2) 原子发布；Android 应用域 SELinux 拒绝 hardlink（EACCES，
// dontaudit 静默）→ 升级前写入的会话全部打不开。同文件 materialize 路径早有回退，此处漏打。
//
// 本测试做三件事：① 用同版本只读 fixture 跑 apply-patches（锚点命中）；② 断言两处站点都带标记且
// rename 已导入；③ 把打过补丁的 publishCurrentExclusive 逐字抽出做行为断言——link 正常时发布成功、
// link 抛 EACCES 时改走 rename、其它错误原样抛出（防止「只替换了文本但代码跑不起来」）。
//
// 用法：node scripts/patches/tests/spj-migration-link-f5.test.mjs
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js'
const FIXTURE = join(here, 'fixtures', 'dsh-session-persistence-jsonl-0.1.5-rc.1', 'lib', 'index.js')

const failures = []
/** Assert one condition, recording the failure instead of throwing so every check reports. */
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/** Extract one function's source verbatim by brace matching. */
function extractFunction(source, signature) {
  const start = source.indexOf(signature)
  if (start < 0) throw new Error('function not found: ' + signature)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces for ' + signature)
}

const scratch = mkdtempSync(join(tmpdir(), 'f5-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(FIXTURE, target)

  const applied = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'spj-migration-link-F5'], { encoding: 'utf8' })
  check('apply-patches exits 0', applied.status === 0, (applied.stderr || '').trim().split('\n').slice(-2).join(' '))
  const patched = readFileSync(target, 'utf8')
  const markers = (patched.match(/dsh-mobile link->rename fallback/g) || []).length
  check('两处 link 站点都带回退标记', markers === 2, 'markers=' + markers)
  check('rename 已导入（internals.fs 不暴露该成员）', patched.includes('realpath, rename, rm'))
  check('迁移发布站点使用顶层 rename', patched.includes('await rename(staged, currentPath);'))
  check('materialize 站点使用顶层 rename', patched.includes('await rename(tmp, finalPath);'))
  check('未使用 internals.fs.rename', !patched.includes('internals.fs.rename'))

  // Behavior: run the patched publishCurrentExclusive with stubbed dependencies.
  const source = extractFunction(patched, 'async function publishCurrentExclusive(')
  const calls = { rename: [] }
  const factory = new Function('isEEXIST', 'syncDirectory', 'dirname', 'rename',
    source + '\nreturn publishCurrentExclusive;')
  const publish = factory(
    (error) => error && error.code === 'EEXIST',
    async () => {},
    (p) => String(p).replace(/\/[^/]*$/, ''),
    async (from, to) => { calls.rename.push([from, to]) },
  )
  const internals = (linkImpl) => ({ platform: 'linux', fs: { link: linkImpl }, publishNewWin32: null })

  const okPublish = await publish('/tmp/staged', '/tmp/current', internals(async () => {}))
  check('link 正常时发布成功且不触发 rename', okPublish === true && calls.rename.length === 0, 'rename=' + calls.rename.length)

  const eacces = Object.assign(new Error('EACCES: permission denied, link ...'), { code: 'EACCES' })
  const fallbackPublish = await publish('/tmp/staged2', '/tmp/current2', internals(async () => { throw eacces }))
  check('link 抛 EACCES 时改走 rename 且发布成功',
    fallbackPublish === true && calls.rename.length === 1 && calls.rename[0][0] === '/tmp/staged2',
    JSON.stringify(calls.rename))

  const eexist = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
  const collision = await publish('/tmp/staged3', '/tmp/current3', internals(async () => { throw eexist }))
  check('link 抛 EEXIST 时返回 false（独占语义不变）', collision === false)

  const eio = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
  let threw = null
  try { await publish('/tmp/staged4', '/tmp/current4', internals(async () => { throw eio })) } catch (error) { threw = error }
  check('其它文件系统错误原样抛出', threw === eio)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
