// boot-third-party-isolation-g3.test.mjs — G3 补丁回归：第三方插件 boot 期失败隔离（0.14.1）。
//
// 真因（真实用户反馈 报错反馈/0.14.0/20260919-125714-engine-died-during-boot）：用户自装的
// dsh-live2d-pets 在 import 期抛 SyntaxError（上游 @deepseek-ai/dsh-settings 不再导出
// settingsNamespace）→ 整树 boot 失败、engine exit=1。
// boot-pending-G1 结构上无法覆盖：G1 锚点在 assertEntriesActivated（dsh-app-boot:1472-1505），
// 而 import 失败在更早的 boot:1552 → mountRootInclude:553 → loader EntryTree.update
// （cordis-plugin-loader:86/97）→ updateError('import')（:309）抛出，assertEntriesActivated:1555 不可达。
//
// 本测试：
//   ① 补丁幂等 / marker / node --check / 反 no-op（boot() 不再直接挂载 root include）；
//   ② 用抽取出的隔离器 + 桩 mountRootInclude 驱动全部判定分支：
//      第三方失败→隔离重试并点名；官方包与出厂移动侧包失败→仍响亮失败；无法识别→仍失败；
//      超过上限→仍失败并给完整清单；disabled patch 形状正确；被跳过清单挂到 globalThis；
//   ③ 与 G1 共存（同一文件里 G1 的 marker 与 deferred 逻辑不被破坏）。
//
// 用法：node scripts/patches/tests/boot-third-party-isolation-g3.test.mjs
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
/** 抽取 G3 的整块（常量 + 三个函数），供桩驱动。 */
function extractG3Block(source) {
  const start = source.indexOf('/* dsh-mobile third-party boot isolation (G3)')
  if (start < 0) throw new Error('G3 block not found')
  const anchor = source.indexOf('async function boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl) {')
  if (anchor < 0) throw new Error('boot() anchor not found')
  return source.slice(start, anchor)
}
/** 用桩 mountRootInclude 造一个隔离器实例。 */
function buildIsolator(source, mountStub) {
  const src = extractG3Block(source)
  const factory = new Function('mountRootInclude', 'console',
    src + '\nreturn { dshMobileMountRootIncludeTolerant, dshMobileCollectEntryFailures, dshMobileIsShippedPlugin, dshMobileIsIsolatableEntry, DSH_MOBILE_BOOT_SKIPPED_PLUGINS, DSH_MOBILE_BOOT_SKIP_LIMIT };')
  const warnings = []
  const api = factory(mountStub, { warn: (line) => warnings.push(String(line)), log: () => {}, error: () => {} })
  return { ...api, warnings }
}
/** 造一个与 loader updateError 同形态的失败错误（含 cause 链与 AggregateError 折叠）。 */
function loaderImportError(id, name) {
  const syntax = new SyntaxError(`The requested module '@deepseek-ai/dsh-settings' does not provide an export named 'settingsNamespace'`)
  const inner = new Error(`failed to import loader entry ${id} (${name}): ${syntax.message}`, { cause: syntax })
  return new Error(`failed to apply loader entry include (cordis:include): ${inner.message}`, { cause: inner })
}
const importErrorFor = (...pairs) => {
  const errors = pairs.map(([id, name]) => loaderImportError(id, name))
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, 'loader entries failed to apply')
}

const scratch = mkdtempSync(join(tmpdir(), 'g3-test-'))
try {
  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  // fixture 里 G1 已施加（存量形态）；本测试据此同时验证共存。
  writeFileSync(target, readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'))
  const beforePatch = readFileSync(target, 'utf8')
  check('前置：fixture 已含 boot-pending-G1（G3 必须与它共存）',
    beforePatch.includes('dsh-mobile boot tolerance (G1)') && beforePatch.includes('const deferred = [];'))

  const apply = () => spawnSync(process.execPath,
    [join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--apply', '--scope', 'engine', '--only', 'boot-third-party-isolation-G3'],
    { encoding: 'utf8' })
  const applied = apply()
  check('apply-patches exits 0（仅 G3，requires 为空所以不牵连 G1）', applied.status === 0,
    (applied.stdout || applied.stderr || '').trim().split('\n').slice(-2).join(' | '))
  const patched = readFileSync(target, 'utf8')
  check('G3 marker 在场', patched.includes('dsh-mobile third-party boot isolation (G3)'))
  check('隔离器与收集器在场',
    patched.includes('dshMobileMountRootIncludeTolerant') && patched.includes('dshMobileCollectEntryFailures'))
  check('反 no-op：boot() 不再直接挂载 root include',
    !patched.includes('\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl);')
    && patched.includes('await dshMobileMountRootIncludeTolerant(ctx, binName, absoluteConfigPath, patches, bareModuleBaseUrl);'))
  check('与 G1 共存未被破坏（G1 marker 与 deferred 仍在）',
    patched.includes('dsh-mobile boot tolerance (G1)') && patched.includes('const deferred = [];'))
  const parse = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched file parses', parse.status === 0, (parse.stderr || '').split('\n')[0])
  apply()
  check('re-apply is idempotent', readFileSync(target, 'utf8') === patched)

  // ── ② 决策逻辑：桩 mountRootInclude 记录收到哪些 disabled patch ──
  const mk = (failuresSpec, opts = {}) => {
    const calls = []
    let attempt = 0
    const mountStub = async (ctx, configPath, patches) => {
      calls.push({ patches: patches.map((p) => ({ ...p })) })
      attempt += 1
      // 第一次调用：按失败清单抛；后续调用（隔离重试）：默认成功。
      if (attempt === 1 && failuresSpec.length > 0) throw importErrorFor(...failuresSpec.map((f) => [f.id, f.name]))
      if (opts.throwEveryTime) throw importErrorFor(...failuresSpec.map((f) => [f.id, f.name]))
      return undefined
    }
    const iso = buildIsolator(patched, mountStub)
    return { iso, calls, run: () => iso.dshMobileMountRootIncludeTolerant({}, 'dsh', '/cfg/cordis.yml', [], undefined) }
  }

  // ① 第三方失败 → 隔离重试成功 + 点名告警
  {
    const { iso, calls, run } = mk([{ id: 'live2d-pet', name: 'dsh-live2d-pets' }])
    await run()
    check('② 第三方插件 import 失败：boot 不抛（引擎能起来）', true)
    check('② 重试时携带 disabled patch', calls.length === 2 && calls[1].patches.length === 1,
      'calls=' + calls.length + ' retryPatches=' + JSON.stringify(calls[1] && calls[1].patches))
    check('② disabled patch 形状正确（{id,name,disabled:true}）',
      calls[1] && calls[1].patches[0].id === 'live2d-pet' && calls[1].patches[0].name === 'dsh-live2d-pets'
      && calls[1].patches[0].disabled === true,
      JSON.stringify(calls[1] && calls[1].patches[0]))
    check('② 告警点名坏插件（可诊断）',
      iso.warnings.some((w) => w.includes('dsh-live2d-pets') && w.includes('skipped')),
      iso.warnings.join(' | ').slice(0, 200))
    check('② 被跳过清单挂到 globalThis（壳侧/诊断可读）',
      Array.isArray(globalThis.__dshMobileBootSkippedPlugins)
      && globalThis.__dshMobileBootSkippedPlugins.includes('dsh-live2d-pets'),
      JSON.stringify(globalThis.__dshMobileBootSkippedPlugins))
  }

  // ② 官方包失败 → 仍响亮失败（核心坏掉必须可见）
  {
    const { run } = mk([{ id: 'core-thing', name: '@deepseek-ai/dsh-settings' }])
    let threw = null
    try { await run() } catch (error) { threw = error }
    check('② 官方包（@deepseek-ai/*）失败：必须仍抛出（反向断言，不得被当成功）',
      threw !== null && /does not provide an export named/.test(threw.message), threw === null ? '未抛出' : threw.message.slice(0, 90))
  }
  // ③ 出厂移动侧包失败 → 仍响亮失败
  {
    const { run } = mk([{ id: 'android-bridge', name: '@dsh-android/dsh-android-bridge' }])
    let threw = null
    try { await run() } catch (error) { threw = error }
    check('② 出厂移动侧包（@dsh-android/*）失败：必须仍抛出', threw !== null, threw === null ? '未抛出' : '')
  }
  // ④ 出货具名第三方（dshmarketplace-plugin 等）失败 → 仍响亮失败
  {
    const { run } = mk([{ id: 'dshmarketplace', name: 'dshmarketplace-plugin' }])
    let threw = null
    try { await run() } catch (error) { threw = error }
    check('② 出货具名插件（dshmarketplace-plugin）失败：必须仍抛出', threw !== null, threw === null ? '未抛出' : '')
  }
  // ⑤ 无法识别的失败（没有 loader entry 形态）→ 原样抛出，不得误吞
  {
    const mountStub = async () => { throw new Error('some unrelated boot failure') }
    const iso = buildIsolator(patched, mountStub)
    let threw = null
    try { await iso.dshMobileMountRootIncludeTolerant({}, 'dsh', '/cfg/cordis.yml', [], undefined) } catch (error) { threw = error }
    check('② 无法识别的失败：原样抛出（不误吞、不空转重试）',
      threw !== null && /unrelated boot failure/.test(threw.message), threw === null ? '未抛出' : '')
  }
  // ⑥ 混合失败（第三方 + 官方）→ 必须整体失败，且不得为第三方做过任何 disable
  {
    const { calls, run } = mk([
      { id: 'live2d-pet', name: 'dsh-live2d-pets' },
      { id: 'core-thing', name: '@deepseek-ai/dsh-settings' },
    ])
    let threw = null
    try { await run() } catch (error) { threw = error }
    check('② 混合失败（第三方 + 官方）：整体仍失败（官方坏掉不得被第三方掩盖）', threw !== null)
    check('② 混合失败时不产生任何 disabled 重试（先判官方，不做半截隔离）',
      calls.length === 1, 'calls=' + calls.length)
  }
  // ⑦ 上限收敛：连续失败超过上限 → 仍失败且给完整清单
  {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: 'third-' + i, name: 'third-party-plugin-' + i }))
    let attempt = 0
    const mountStub = async (ctx, configPath, patches) => {
      attempt += 1
      const already = patches.length
      if (already >= 9) throw importErrorFor(...many.slice(already, already + 3).map((f) => [f.id, f.name]))
      throw importErrorFor(...many.slice(already, already + 1).map((f) => [f.id, f.name]))
    }
    const iso = buildIsolator(patched, mountStub)
    let threw = null
    try { await iso.dshMobileMountRootIncludeTolerant({}, 'dsh', '/cfg/cordis.yml', [], undefined) } catch (error) { threw = error }
    check('② 超过隔离上限（8）：仍失败（不允许无限容忍）',
      threw !== null && /isolation limit/.test(threw.message), threw === null ? '未抛出' : threw.message.slice(0, 120))
    check('② 超限错误给出完整坏插件清单', threw !== null && /third-party-plugin-/.test(threw.message),
      threw === null ? '' : threw.message.slice(0, 160))
  }
  // ⑧ 收集器能解析 AggregateError 折叠的多条与 loader 的行格式
  {
    const iso = buildIsolator(patched, async () => {})
    const parsed = iso.dshMobileCollectEntryFailures(importErrorFor(['a', 'pkg-a'], ['b', '@deepseek-ai/x']))
    check('② 收集器解析 AggregateError 多条失败',
      parsed.length === 2 && parsed[0].id === 'a' && parsed[1].name === '@deepseek-ai/x', JSON.stringify(parsed))
    check('② 收集器过滤掉 bootstrap include 行本身',
      iso.dshMobileCollectEntryFailures(new Error('failed to apply loader entry include (cordis:include): x')).length === 0)
    check('② 出货判据：官方与移动侧为 true，用户自装为 false',
      iso.dshMobileIsShippedPlugin('@deepseek-ai/dsh-x') === true
      && iso.dshMobileIsShippedPlugin('@dsh-android/dsh-android-bridge') === true
      && iso.dshMobileIsShippedPlugin('dshmarketplace-plugin') === true
      && iso.dshMobileIsShippedPlugin('dsh-live2d-pets') === false)
    // 归属必须**可证**：路径/URL 形态不是「用户自装包」的证据，一律不可隔离（否则产品自身的
      // 相对路径条目坏掉会被静默跳过——这正是反向断言抓到的缺陷）。
    check('② 归属可证性：裸包名可隔离；相对/绝对路径、file:/其它 scheme 一律不可隔离',
      iso.dshMobileIsIsolatableEntry('dsh-live2d-pets') === true
      && iso.dshMobileIsIsolatableEntry('@dsh-android/dsh-foo') === false
      && iso.dshMobileIsIsolatableEntry('./local-plugin.mjs') === false
      && iso.dshMobileIsIsolatableEntry('../up/plugin.mjs') === false
      && iso.dshMobileIsIsolatableEntry('/abs/plugin.mjs') === false
      && iso.dshMobileIsIsolatableEntry('file:///tmp/plugin.mjs') === false
      && iso.dshMobileIsIsolatableEntry('cordis:include') === false
      && iso.dshMobileIsIsolatableEntry('') === false,
      ['./local-plugin.mjs', '../up/plugin.mjs', '/abs/plugin.mjs', 'file:///tmp/p.mjs', 'cordis:include', '']
        .map((n) => n + '=' + iso.dshMobileIsIsolatableEntry(n)).join(' '))
  }
  // ⑨ 反向断言：相对路径条目失败 → 仍响亮失败（归属不可证，不得被隔离）
  {
    const { run } = mk([{ id: 'local-thing', name: './local-plugin.mjs' }])
    let threw = null
    try { await run() } catch (error) { threw = error }
    check('② 归属不可证的失败（./ 路径条目）：必须仍抛出，不得静默跳过',
      threw !== null && /does not provide an export named/.test(threw.message),
      threw === null ? '未抛出（缺陷：被误隔离）' : '')
  }

  console.log(failures.length === 0 ? '\nALL PASS' : '\nFAILED ' + failures.length + ': ' + failures.join('; '))
  process.exit(failures.length === 0 ? 0 : 1)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  delete globalThis.__dshMobileBootSkippedPlugins
}
