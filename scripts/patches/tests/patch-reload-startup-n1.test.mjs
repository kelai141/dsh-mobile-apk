// patch-reload-startup-n1.test.mjs — N1 补丁回归：patchReload=startup 出厂默认 + 存量升级归一化。
//
// 背景（性能 A1，docs/ANDROID-RUNTIME-PERF-2026-09-12.md §A1，实测冷启动 24.9s -> 16.6s）：
// Android 上 live patch reload 不可用（坑 19），却让引擎额外挂 timer/hmr 并反复现场重算客户端
// combo。修法两处：① web 模板默认 live -> startup（全新安装与键缺失的升级用户）；
// ② normalizeShippedProfile 在 installation-owned 元组下把已显式写入的旧默认 live 一并归一化
// （上游只在键**缺失**时写回模板默认，存量设备永不归一化 —— P-AC-24）。
//
// 本测试：① 对只读 fixture 跑 apply-patches（幂等 + 可解析 + marker 数 = 2）；
// ② 断言 web 模板已改；③ 把打过补丁的 normalizeShippedProfile 逐字抽出、注入桩，跑五个分支。
//
// 用法：node scripts/patches/tests/patch-reload-startup-n1.test.mjs
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
const FIXTURE = join(here, 'fixtures', 'dsh-app-boot-0.1.5-rc.1', 'lib', 'index.js')

const failures = []
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
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

const scratch = mkdtempSync(join(tmpdir(), 'n1-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  // FX-E19：fixture 索引 LF 而工作树在 core.autocrlf=true 下是 CRLF——按 LF 归一后写夹具。
  writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'perf-patch-reload-N1'],
    { encoding: 'utf8' })
  const applied = apply()
  check('apply-patches exits 0', applied.status === 0, (applied.stderr || '').trim().split('\n').slice(-2).join(' '))
  const patched = readFileSync(target, 'utf8')
  check('marker 数 = 2（模板 + 归一化）', (patched.match(/dsh-mobile patchReload normalization \(N1\)/g) || []).length === 2,
    'count=' + ((patched.match(/dsh-mobile patchReload normalization \(N1\)/g) || []).length))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])

  const webIndex = patched.indexOf('\tweb: {')
  const webBlock = patched.slice(webIndex, patched.indexOf('\n\t},', webIndex))
  check('web 模板 patchReload = startup', /patchReload: "startup"/.test(webBlock), webBlock.replace(/\n/g, ' | ').slice(0, 160))
  check('DEFAULT_PROFILE_PATCH_RELOAD 未被误改（自定义 profile 仍 live）', patched.includes('const DEFAULT_PROFILE_PATCH_RELOAD = "live";'))

  apply()
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)

  // ── 行为：抽出打过补丁的 normalizeShippedProfile，注入桩驱动五个分支 ──
  const src = extractFunction(patched, 'function normalizeShippedProfile(name, dir, manifest) {')
  const WEB = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  const HEADLESS = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
  const sameBundles = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const written = []
  const factory = new Function('INSTALLATION_OWNED_PROFILE_TUPLES', 'PROFILE_TEMPLATES', 'sameBundles', 'writeProfileManifest',
    src + '\nreturn normalizeShippedProfile;')
  const normalize = factory(
    { headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'] },
    { web: { bundles: WEB, patchReload: 'startup' }, headless: { bundles: HEADLESS, patchReload: 'startup' } },
    sameBundles,
    (dir, manifest) => written.push({ dir, manifest }),
  )
  const reloadOf = (manifest) => manifest.dsh.profile.patchReload

  const c1 = normalize('web', '/p', { dsh: { profile: { bundles: WEB } } })
  check('全新安装/键缺失：写入 startup', reloadOf(c1) === 'startup', JSON.stringify(reloadOf(c1)))
  check('全新安装：确实写回磁盘', written.length === 1)

  const c2 = normalize('web', '/p', { dsh: { profile: { bundles: WEB, patchReload: 'live' } } })
  check('存量升级（显式 live + 当前元组）：归一化为 startup（P-AC-24）', reloadOf(c2) === 'startup', JSON.stringify(reloadOf(c2)))

  const before = written.length
  const c3 = normalize('web', '/p', { dsh: { profile: { bundles: WEB, patchReload: 'startup' } } })
  check('已是 startup：不写回（幂等）', reloadOf(c3) === 'startup' && written.length === before)

  const c4 = normalize('web', '/p', { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } } })
  check('用户自建元组：一律不动', JSON.stringify(c4) === JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } } }),
    JSON.stringify(c4))

  const c5 = normalize('headless', '/p', { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless'], patchReload: 'live' } } })
  check('退役元组迁移：live 也归一化为 startup', reloadOf(c5) === 'startup', JSON.stringify(reloadOf(c5)))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
process.exit(failures.length === 0 ? 0 : 1)
