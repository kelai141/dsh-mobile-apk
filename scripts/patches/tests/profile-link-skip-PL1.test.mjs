// profile-link-skip-PL1.test.mjs — profile 第三方软链不可读时的跳过与告警。
//
// 症状：profile 的 node_modules 里一个本地链接目标被删、权限变化或指向普通文件，
// linkedProfileRoots() 的 realpath/stat 抛出 EACCES/EPERM/ENOENT/ENOTDIR，整份 profile
// 的运行时解析失败，其余插件一起不可用。
//
// 本测试：
//   ① 补丁在真实 0.2.1-rc.2 夹具上命中、可解析、幂等；marker 不完整与锚点漂移必须拒绝；
//   ② 四种「链接不可用」错误逐个验证：跳过该链接、其余链接保留、告警一次；
//   ③ 合法外部链接与 @scope 链接保留；profiles 树内、活动 profile 内、文件目标仍排除；
//   ④ 非预期异常（EIO/EMFILE）与不带回调的读取失败仍然抛出；
//   ⑤ 告警按 名称+错误码 去重，且不泄露 error.message；
//   ⑥ 真实文件系统上的 junction/symlink 与合法链接组合。
//
// 用法：node scripts/patches/tests/profile-link-skip-PL1.test.mjs
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_LINK_SKIP_MARKER,
  hasProfileLinkSkip,
  patchProfileLinkSkip,
} from '../data/profile-link-skip-PL1.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const FIXTURE = versionedFixture('dsh-app-boot', 'lib', 'index.js')
const pristine = readFileSync(FIXTURE, 'utf8')

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
/** 抽出补丁块（常量 + 四个函数），供桩与真实文件系统驱动。 */
function extractBlock(source) {
  const start = source.indexOf('const DSH_MOBILE_PROFILE_LINK_SKIP_CODES')
  if (start < 0) throw new Error('PL1 constants not found')
  const links = extractFunction(source, 'function linkedProfileRoots(profile, profilesDir) {')
  const end = source.indexOf(links, start) + links.length
  return source.slice(start, end)
}
/**
 * 用注入的文件系统与告警收集器构建被测实现。
 * @param source - 已施加补丁的产物文本。
 * @param io - existsSync/readdirSync/realModuleDirectory/statSync 的替身。
 */
function buildHarness(source, io = {}) {
  const block = extractBlock(source)
  const warnings = []
  const consoleStub = {
    warn(line) { warnings.push(String(line)) },
    log() {},
    error() {},
  }
  const factory = new Function(
    'existsSync', 'readdirSync', 'realModuleDirectory', 'statSync', 'join', 'relative', 'sep', 'resolve', 'console',
    block + '\nreturn { linkedProfileRoots, symlinksUnder, dshMobileProfileLinkSkip };',
  )
  const api = factory(
    io.existsSync ?? existsSync,
    io.readdirSync ?? (() => { throw new Error('readdirSync not stubbed') }),
    io.realModuleDirectory ?? ((path) => resolve(path)),
    io.statSync ?? (() => { throw new Error('statSync not stubbed') }),
    join, relative, sep, resolve, consoleStub,
  )
  return { ...api, warnings }
}
/** 造一条目录项的替身（Dirent 形状）。 */
const dir = (name) => ({ name, isSymbolicLink: () => false, isDirectory: () => true })
const link = (name) => ({ name, isSymbolicLink: () => true, isDirectory: () => false })
const fsError = (code, message = 'stub failure') => Object.assign(new Error(message), { code })

// ── ① 补丁面：命中、解析、幂等、拒绝 ──
const patched = patchProfileLinkSkip(pristine)
check('fixture is pristine before patching', !pristine.includes(PROFILE_LINK_SKIP_MARKER))
check('marker present after patch', patched.includes(PROFILE_LINK_SKIP_MARKER))
check('hasProfileLinkSkip recognizes the patched text', hasProfileLinkSkip(patched))
check('re-apply is idempotent (same object)', patchProfileLinkSkip(patched) === patched)
{
  const scratch = mkdtempSync(join(tmpdir(), 'pl1-parse-'))
  try {
    const target = join(scratch, 'index.mjs')
    writeFileSync(target, patched)
    const parsed = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
    check('patched file parses', parsed.status === 0, (parsed.stderr || '').split('\n')[0])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
{
  const tampered = patched.replace('function symlinksUnder(modules, onSkip) {', 'function symlinksUnder(modules) {')
  let threw = false
  try { patchProfileLinkSkip(tampered) } catch { threw = true }
  check('marker with an incomplete structure is refused', threw)
}
{
  const drift = pristine.replace('const links = symlinksUnder(modules);', 'const links = symlinksUnder(modules, undefined);')
  let message = ''
  try { patchProfileLinkSkip(drift) } catch (error) { message = String(error.message) }
  check('anchor drift is refused with a hit-count diagnostic', /期望恰好命中 1 处/.test(message), message)
}
{
  const duplicate = pristine + '\n' + pristine.slice(
    pristine.indexOf('/** Top-level and scoped entries'),
    pristine.indexOf('function pointsInto'),
  )
  let threw = false
  try { patchProfileLinkSkip(duplicate) } catch { threw = true }
  check('a second scan site makes the anchor ambiguous and is refused', threw)
}

// ── ② 单条链接的四种错误：跳过、保留其余、告警一次 ──
const modules = join('C:', 'profiles', 'work', 'node_modules')
const profileDir = join('C:', 'profiles', 'work')
const profilesDir = join('C:', 'profiles')
const healthyPath = join('C:', 'linked', 'healthy')
const brokenPath = join('C:', 'linked', 'broken')
function runSingleLinkFailure(code, stage) {
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: () => [link('broken'), link('healthy')],
    realModuleDirectory: (path) => {
      if (path === modules || path === profileDir || path === profilesDir) return path
      if (path.endsWith('broken')) {
        if (stage === 'realpath') throw fsError(code, 'secret-token-1234: C:\\Users\\alice\\private')
        return brokenPath
      }
      return healthyPath
    },
    statSync: (path) => {
      if (path === brokenPath && stage === 'stat') throw fsError(code, 'secret-token-1234')
      return { isDirectory: () => true }
    },
  })
  return { roots: harness.linkedProfileRoots({ dir: profileDir }, profilesDir), warnings: harness.warnings }
}
for (const code of ['EACCES', 'EPERM', 'ENOENT', 'ENOTDIR']) {
  const run = runSingleLinkFailure(code, 'realpath')
  check(code + ' at realpath: broken link skipped, healthy link kept',
    run.roots.length === 1 && run.roots[0].name === 'healthy',
    JSON.stringify(run.roots))
  check(code + ' at realpath: exactly one warning naming the link and code',
    run.warnings.length === 1 && run.warnings[0].includes('"broken"') && run.warnings[0].includes(code),
    JSON.stringify(run.warnings))
  check(code + ' at realpath: warning leaks neither the message nor a full path',
    !run.warnings.join(' ').includes('secret-token-1234')
    && !run.warnings.join(' ').includes('alice'),
    JSON.stringify(run.warnings))
}
for (const code of ['ENOENT', 'ENOTDIR']) {
  const run = runSingleLinkFailure(code, 'stat')
  check(code + ' after realpath (target vanished/replaced): skipped, healthy kept',
    run.roots.length === 1 && run.roots[0].name === 'healthy' && run.warnings.length === 1,
    JSON.stringify(run))
}

// ── ③ 合法链接与既有排除口径 ──
{
  const root = join('/home', 'dsh', 'profiles', 'work', 'node_modules')
  const trees = {
    profiles: join('/home', 'dsh', 'profiles'),
    profile: join('/home', 'dsh', 'profiles', 'work'),
    shared: join('/home', 'dsh', 'profiles', 'work', 'vendor', 'shared'),
    file: join('/home', 'dsh', 'linked', 'notes.txt'),
    external: join('/home', 'dsh', 'linked', 'external'),
    scoped: join('/home', 'dsh', 'linked', 'scoped-pkg'),
  }
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: (path) => path === root
      ? [link('external'), link('inside'), link('self'), link('file'), dir('@scope')]
      : (path === join(root, '@scope') ? [link('pkg')] : []),
    realModuleDirectory: (path) => {
      const map = {
        [trees.profiles]: trees.profiles,
        [trees.profile]: trees.profile,
        [join(root, 'external')]: trees.external,
        [join(root, 'inside')]: trees.shared,
        [join(root, 'self')]: join(trees.profile, 'packages', 'self'),
        [join(root, 'file')]: trees.file,
        [join(root, '@scope', 'pkg')]: trees.scoped,
      }
      return path in map ? map[path] : resolve(path)
    },
    statSync: (path) => ({ isDirectory: () => path !== trees.file }),
  })
  const roots = harness.linkedProfileRoots({ dir: trees.profile }, trees.profiles)
  const names = roots.map((entry) => entry.name)
  check('legitimate external and scoped links are collected',
    names.length === 2 && names.includes('external') && names.includes('@scope/pkg'),
    JSON.stringify(names))
  check('links inside the profiles tree, inside the profile, and file targets stay excluded',
    !names.includes('inside') && !names.includes('self') && !names.includes('file'), JSON.stringify(names))
  check('legitimate exclusions produce no warning', harness.warnings.length === 0, JSON.stringify(harness.warnings))
}

// ── ④ 非预期异常仍抛出；无回调的读取失败仍抛出 ──
{
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: () => [link('broken')],
    realModuleDirectory: (path) => {
      if (path === modules || path === profileDir || path === profilesDir) return path
      throw fsError('EIO', 'device fault')
    },
    statSync: () => ({ isDirectory: () => true }),
  })
  let code
  try { harness.linkedProfileRoots({ dir: profileDir }, profilesDir) } catch (error) { code = error.code }
  check('EIO at realpath is not swallowed', code === 'EIO', String(code))
}
{
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: () => [link('broken')],
    realModuleDirectory: (path) => path === modules ? modules : brokenPath,
    statSync: () => { throw fsError('EMFILE', 'too many open files') },
  })
  let code
  try { harness.linkedProfileRoots({ dir: profileDir }, profilesDir) } catch (error) { code = error.code }
  check('EMFILE at stat is not swallowed', code === 'EMFILE', String(code))
}
{
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: () => { throw fsError('EACCES', 'denied') },
  })
  const skipped = harness.symlinksUnder(modules, () => {})
  check('unreadable node_modules is skipped only when a sink is supplied',
    Array.isArray(skipped) && skipped.length === 0)
  let code
  try { harness.symlinksUnder(modules) } catch (error) { code = error.code }
  check('symlinksUnder without a sink still throws (removeLinkProjections path unchanged)', code === 'EACCES', String(code))
}
{
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: (path) => {
      if (path === modules) return [dir('@scope'), link('healthy')]
      throw fsError('EIO', 'scope unreadable')
    },
    realModuleDirectory: (path) => path,
    statSync: () => ({ isDirectory: () => true }),
  })
  let code
  try { harness.linkedProfileRoots({ dir: profileDir }, profilesDir) } catch (error) { code = error.code }
  check('an unexpected error while reading a scope still propagates', code === 'EIO', String(code))
}
{
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: (path) => {
      if (path === modules) return [dir('@scope'), link('healthy')]
      throw fsError('EACCES', 'scope denied')
    },
    realModuleDirectory: (path) => {
      if (path === modules || path === profileDir || path === profilesDir) return path
      return healthyPath
    },
    statSync: () => ({ isDirectory: () => true }),
  })
  const roots = harness.linkedProfileRoots({ dir: profileDir }, profilesDir)
  check('an unreadable scope is skipped and its sibling link survives',
    roots.length === 1 && roots[0].name === 'healthy' && harness.warnings.length === 1,
    JSON.stringify({ roots, warnings: harness.warnings }))
}

// ── ⑤ 去重 ──
{
  let failCode = 'EACCES'
  const harness = buildHarness(patched, {
    existsSync: () => true,
    readdirSync: () => [link('broken')],
    realModuleDirectory: (path) => {
      if (path === modules || path === profileDir || path === profilesDir) return path
      throw fsError(failCode, 'denied')
    },
    statSync: () => ({ isDirectory: () => true }),
  })
  harness.linkedProfileRoots({ dir: profileDir }, profilesDir)
  harness.linkedProfileRoots({ dir: profileDir }, profilesDir)
  check('repeated resolution warns only once per name and code', harness.warnings.length === 1, JSON.stringify(harness.warnings))
  failCode = 'ENOENT'
  harness.linkedProfileRoots({ dir: profileDir }, profilesDir)
  check('a different code for the same name warns again', harness.warnings.length === 2, JSON.stringify(harness.warnings))
}

// ── ⑥ 真实文件系统 ──
{
  const scratch = mkdtempSync(join(tmpdir(), 'pl1-real-'))
  try {
    const profilesReal = join(scratch, 'dsh', 'profiles')
    const profileReal = join(profilesReal, 'work')
    const modulesReal = join(profileReal, 'node_modules')
    mkdirSync(modulesReal, { recursive: true })
    const external = join(scratch, 'linked', 'external')
    const scoped = join(scratch, 'linked', 'scoped-pkg')
    mkdirSync(external, { recursive: true })
    mkdirSync(scoped, { recursive: true })
    let linked = 0
    const tryLink = (target, path) => {
      try {
        symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
        linked += 1
        return true
      } catch {
        return false
      }
    }
    tryLink(external, join(modulesReal, 'external'))
    mkdirSync(join(modulesReal, '@scope'), { recursive: true })
    tryLink(scoped, join(modulesReal, '@scope', 'pkg'))
    const danglingOk = tryLink(join(scratch, 'linked', 'gone'), join(modulesReal, 'vanished'))
    if (linked === 0) {
      console.log('SKIP  真实文件系统链接（本机无权创建符号链接/junction）')
    } else {
      const warnings = []
      const factory = new Function(
        'existsSync', 'readdirSync', 'realModuleDirectory', 'statSync', 'join', 'relative', 'sep', 'resolve', 'console',
        extractBlock(patched) + '\nreturn { linkedProfileRoots };',
      )
      const api = factory(
        existsSync, readdirSync, (path) => realpathSync.native(path), statSync,
        join, relative, sep, resolve, { warn: (line) => warnings.push(String(line)) },
      )
      const roots = api.linkedProfileRoots({ dir: profileReal }, profilesReal)
      const names = roots.map((entry) => entry.name)
      check('real fs: external and scoped links resolve',
        names.includes('external') && names.includes('@scope/pkg'), JSON.stringify(names))
      if (danglingOk) {
        check('real fs: dangling link is skipped without failing the scan',
          !names.includes('vanished'), JSON.stringify(names))
        check('real fs: dangling link produced one warning',
          warnings.length === 1 && warnings[0].includes('vanished'), JSON.stringify(warnings))
      }
      const second = api.linkedProfileRoots({ dir: profileReal }, profilesReal)
      check('real fs: repeated scan is unchanged', JSON.stringify(second) === JSON.stringify(roots))
      check('real fs: repeated scan does not repeat the warning',
        danglingOk ? warnings.length === 1 : true, JSON.stringify(warnings))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

console.log('')
if (failures.length) {
  console.error('PROFILE-LINK-SKIP PL1 FAILED (' + failures.length + '):')
  for (const failure of failures) console.error('  - ' + failure)
  process.exitCode = 1
} else {
  console.log('PROFILE-LINK-SKIP PL1 PASSED')
}
