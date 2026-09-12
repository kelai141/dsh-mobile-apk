// build-apk.mjs — 跨平台 APK 编排（复用已平台化的 gate 脚本；Windows 走 WSL、Linux 原生）
//
// 对应本地 scripts/build-apk-013.ps1（PowerShell + wsl，仅 Windows）。本脚本是「可移植版」：
// 在云端的 GHA ubuntu（原生 Linux）跑，也可在本地 Windows 跑（gate 脚本自带平台感知）。
// 两树逐字节镜像（scripts/build-apk.mjs ⇄ dsh-mobile-apk/scripts/build-apk.mjs，check-patch-mirror 守）。
//
// 0.13.8-b ST-06 / F-ENV-04 真源化（此前是本链的三处陈旧字面量）：
//   ① 版本 = app/build.gradle.kts 的 versionName（此前写死 0.13.0 → 产物名与输出目录恒错）；
//   ② 注入集 = scripts/plugin-dirs.json（与本地链同一常量；此前 pluginDirs 少一个权威 patch
//      已挂载的插件 dsh-model-capability，且门禁集比本地链少一批）；
//   ③ 门禁集与 build-apk-013.ps1 逐项对齐（补 engine-overlay / snapshot-file-modes，机密门禁统一
//      check-snapshot-secrets.mjs 单实现），check-release-gates.mjs 断言两份编排器差集 = 0；
//   ④ `--dry-run` 只解析真源并打印产物名/注入集/门禁集，不写任何文件（验收 ① 的机器可读入口）。
//
// 用法：node scripts/build-apk.mjs --abi arm64|x86_64 [--suffix "-v3"] [--snapshot <snap.tar.xz>] [--skip-inject] [--dry-run]
// 依赖：node、python 在 PATH；插件/vendor 在 ROOT（apk 仓自包含布局下 ROOT 即 apk 仓根）；
//       scripts/plugin-dirs.json 与 scripts/profile-web.cordis.patch.yml 在场。
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, existsSync, rmSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
// apk 仓库目录：默认 ROOT/dsh-mobile-apk（协调仓布局）；云端 workflow 宿主若=apk 仓库（GITHUB_WORKSPACE），
// 用 DSH_APK_DIR 覆盖（此时 ROOT 指向作为依赖签出的协调库子目录）。
const apkDir = process.env.DSH_APK_DIR
  || (existsSync(join(ROOT, 'dsh-mobile-apk')) ? join(ROOT, 'dsh-mobile-apk') : ROOT)

// ---- 真源 ①：版本（app/build.gradle.kts 的 versionName；与本地链 `build-apk-013.ps1` 同源）----
const gradleCandidates = [
  join(apkDir, 'app', 'build.gradle.kts'),
  join(ROOT, 'app', 'build.gradle.kts'),
  join(ROOT, 'dsh-mobile-apk', 'app', 'build.gradle.kts'),
]
let VER = null
let VER_SRC = null
for (const gradle of gradleCandidates) {
  if (!existsSync(gradle)) continue
  const m = /versionName\s*=\s*"([^"]+)"/.exec(readFileSync(gradle, 'utf8'))
  if (m) { VER = m[1]; VER_SRC = gradle; break }
}
if (!VER) {
  console.error('版本真源缺失：未在任何 app/build.gradle.kts 找到 versionName（看过的路径：' + gradleCandidates.join(', ') + '）')
  process.exit(2)
}
const OUT = join(ROOT, 'out', 'v' + VER)
const SUFFIX_DEFAULT = '-ci'

// ---- 真源 ②：注入集（scripts/plugin-dirs.json；与本地链 build-apk-013.ps1 共用同一常量）----
const manifestPath = join(ROOT, 'scripts', 'plugin-dirs.json')
if (!existsSync(manifestPath)) { console.error('注入集真源缺失：' + manifestPath); process.exit(2) }
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const pluginDirs = manifest.dirs.map((d) => join(ROOT, d))
const externalDirs = manifest.externals.map((d) => join(ROOT, d))
const externalNamed = (name) => externalDirs.find((p) => p.replace(/\\/g, '/').endsWith('/' + name))
const undo = externalNamed('dsh-undo-savepoint')
const market = externalNamed('dshmarketplace-plugin')
const modelSync = externalNamed('dsh-model-sync')

// 门禁集（唯一声明处；check-release-gates.mjs 断言与 build-apk-013.ps1 的差集 = 0）
const GATE_SCRIPTS = [
  'check-patch-mirror.mjs',
  'check-snapshot-fingerprint.mjs',
  'check-manifest-hardening.mjs',
  'check-bounded-io.mjs',
  'check-protocol-v2.mjs',
  'check-tool-output-schema.mjs',
  'check-control-ops.mjs',
  'check-state-registry.mjs',
  'check-bridge-symmetry.mjs',
  'check-gate-skips.mjs',
  'check-engine-overlay.mjs',
  'check-patch-mounts.mjs',
  'check-inject-completeness.mjs',
  'check-strip-noop.mjs',
  'check-kotlin-comments.mjs',
  'check-snapshot-file-modes.mjs',
  'check-third-party.mjs',
  'check-snapshot-secrets.mjs',
  'elf-check.mjs',
  'check-runtime-assets.mjs',
  'check-perf-instrumentation.mjs',
]

// ---- 参数解析 ----
const args = process.argv.slice(2)
function opt(name, def) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? (args[i + 1] ?? def) : def
}
const ABI = opt('abi', 'arm64')
const SUFFIX = opt('suffix', SUFFIX_DEFAULT)
const SKIP_INJECT = args.includes('--skip-inject')
const DRY_RUN = args.includes('--dry-run')
const SNAP = opt('snapshot', '')

if (!['arm64', 'x86_64'].includes(ABI)) { console.error(`未知 ABI: ${ABI}`); process.exit(2) }

const work = join(ROOT, '.deploy-tmp', `build-${ABI}`)
const snapSrc = SNAP || join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')

function log(m) { console.log(`[build-apk/${ABI}] ${m}`) }
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} 失败 (${r.status})`)
  return r
}
function requires(name, p) { if (!existsSync(p)) { console.error(`缺 ${name}: ${p}`); process.exit(2) } }
const gate = (file) => join(ROOT, 'scripts', file)

// ---- 0. dry-run：只解析真源（不写文件、不跑 gradle）----
if (DRY_RUN) {
  log('版本真源: ' + VER_SRC + ' -> versionName=' + VER)
  log('输出目录: ' + OUT)
  log('产物名: dsh-mobile-apk-v' + VER + SUFFIX + '-' + ABI + '.apk')
  log('注入 dirs(' + pluginDirs.length + '): ' + manifest.dirs.join(', '))
  log('注入 externals(' + externalDirs.length + '): ' + manifest.externals.join(', '))
  log('门禁集(' + GATE_SCRIPTS.length + '): ' + GATE_SCRIPTS.join(' -> '))
  console.log('DRY_RUN OK version=' + VER + ' apk=dsh-mobile-apk-v' + VER + SUFFIX + '-' + ABI + '.apk')
  process.exit(0)
}

try {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(work, { recursive: true })

  // ---- 1. 前置：基座/插件/vendor 在场 ----
  requires('snapshot 源', snapSrc)
  pluginDirs.forEach((p) => requires('插件', p))
  requires('vendor undo', join(undo, 'package.json'))
  requires('vendor market', join(market, 'package.json'))
  requires('vendor model-sync', join(modelSync, 'lib', 'index.js'))

  // ---- 2. 门禁（注入前；与 build-apk-013.ps1 同一份门禁集，0.13.8-b ST-06）----
  log('门禁：补丁镜像一致性…')
  run('node', [gate('check-patch-mirror.mjs')])
  log('门禁：快照指纹对账（预检）…')
  run('node', [gate('check-snapshot-fingerprint.mjs')])
  log('门禁：manifest 加固语义…')
  run('node', [gate('check-manifest-hardening.mjs')])
  log('门禁：Kotlin 注释嵌套…')
  run('node', [gate('check-kotlin-comments.mjs')])
  log('门禁：子进程有界读…')
  run('node', [gate('check-bounded-io.mjs')])
  log('门禁：协议 V2 往返与体积…')
  run('node', [gate('check-protocol-v2.mjs')])
  log('门禁：工具输出 schema 契约…')
  run('node', [gate('check-tool-output-schema.mjs')])
  log('门禁：控制 op 六处登记链…')
  run('node', [gate('check-control-ops.mjs')])
  // 制度性门禁（0.13.8-b B2 ST-25/26/31）：与本地链同一份集合（差集 = 0 由 check-release-gates 断言）
  log('门禁：状态登记制（PR 模板四栏 + 登记表 evidence）…')
  run('node', [gate('check-state-registry.mjs')])
  log('门禁：桥面对称性（新增不对称即拒）…')
  run('node', [gate('check-bridge-symmetry.mjs')])
  log('门禁：门禁覆盖清单与 SKIP 纪律…')
  run('node', [gate('check-gate-skips.mjs')])
  log('门禁：引擎 overlay 抽验…')
  run('node', [gate('check-engine-overlay.mjs'), snapSrc])

  // ---- 3. 插件注入链（python，跨平台）----
  let snapIn
  if (!SKIP_INJECT) {
    // 统一补丁门禁（Phase 2a）：engine + vendor 补丁幂等施加与校验（registry.json）
    run('node', [join(ROOT, 'scripts', 'patches', 'apply-patches.mjs'), join(ROOT, 'vendor')])
    log('单 pass 注入（@dsh-android + undo/market + 权威 patch，全部装配 profile）…')
    // ST-05：--all-profiles = 权威 patch 写给全部真实装配 profile（web+headless，负控 profile 除外）
    run('python', [
      join(ROOT, 'scripts', 'inject-all.py'), snapSrc, join(work, 'snap-final2.tar.xz'),
      join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'),
      '--dsh-android', ...pluginDirs,
      '--external', undo, market, modelSync,
      '--all-profiles',
    ])
    snapIn = join(work, 'snap-final2.tar.xz')
  } else {
    snapIn = snapSrc
    log('--skip-inject：直接用输入快照（dev 档；权限归一化只在注入链发生，禁止用于发布资产）')
  }

  // ---- 4. 门禁（注入后；与 build-apk-013.ps1 同一份门禁集）----
  log('门禁：patch 挂载集校验（双向差集）…')
  run('node', [gate('check-patch-mounts.mjs'), join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'), ...pluginDirs, undo, market, modelSync])
  // 注入面成员完整性（P0）：包内新增文件必须随注入进 tar，且相对导入不得悬空
  log('门禁：注入成员完整性（成员集合 + 相对导入可解析）…')
  run('node', [gate('check-inject-completeness.mjs'), snapIn])
  log('门禁：剥离清单后置断言（清单项必须不存在）…')
  run('node', [gate('check-strip-noop.mjs'), snapIn])
  log('门禁：快照权限模式…')
  const modes = spawnSync(process.execPath, [gate('check-snapshot-file-modes.mjs'), snapIn], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
  if (modes.status !== 0) {
    if (SKIP_INJECT) log('警告：--skip-inject 档快照未做权限归一化（dev 专档，禁止发布）')
    else throw new Error('快照权限模式校验失败')
  }
  log('门禁：第三方许可…')
  run('node', [gate('check-third-party.mjs'), 'x', '--tar', snapIn])
  log('门禁：机密…')
  run('node', [gate('check-snapshot-secrets.mjs'), snapIn])
  log('门禁：ELF 架构…')
  run('node', [gate('elf-check.mjs'), snapIn, ABI])
  log('门禁：运行时补丁资产（严格，快照缺席即失败）…')
  run('node', [gate('check-runtime-assets.mjs'), ABI, '--require'])
  // A1 出厂声明值对账（P-AC-01，严格档）：注入后快照的 profile 清单必须带 patchReload 出厂值。
  log('门禁：性能度量入口与 A1 出厂值（严格）…')
  run('node', [gate('check-perf-instrumentation.mjs'), '--require', '--snapshot', snapIn, '--abi', ABI])

  // ---- 5. 许可资产（LICENSES + notices -> APK assets/licenses）----
  const licAssets = join(apkDir, 'app', 'src', 'main', 'assets', 'licenses')
  mkdirSync(licAssets, { recursive: true })
  for (const f of readdirSync(join(ROOT, 'LICENSES'))) if (f.endsWith('.txt')) copyFileSync(join(ROOT, 'LICENSES', f), join(licAssets, f))
  copyFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(licAssets, 'THIRD_PARTY_NOTICES.md'))
  log('许可资产就位')

  // ---- 6. 快照 + 指纹写入 assets（防增量叠加缓存：先清 intermediates/输出）----
  rmSync(join(apkDir, 'app', 'build', 'intermediates', 'assets'), { recursive: true, force: true })
  rmSync(join(apkDir, 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true, force: true })
  copyFileSync(snapIn, join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz'))
  const sha = createHash('sha256').update(readFileSync(snapIn)).digest('hex')
  writeFileSync(join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.sha256'), sha, 'ascii')
  log(`snapshot.sha256 = ${sha}`)
  // ST-04 严格复核：本 ABI 的 tar 与刚写入的声明值必须逐字节一致（--require：缺件即失败，不得 SKIP）。
  run('node', [gate('check-snapshot-fingerprint.mjs'), '--require'])

  // ---- 7. gradle assembleDebug（跨平台 gradlew）----
  log('构建 APK…')
  const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
  const gr = spawnSync(gradleCmd, [':app:assembleDebug', '--no-daemon', `-PversionNameSuffix=${SUFFIX}`], { cwd: apkDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (gr.status !== 0) { console.error(`gradle 失败 (${gr.status})`); process.exit(1) }

  // ---- 8. 产物拷贝（产物名与输出目录都来自 gradle 真源）----
  const name = `dsh-mobile-apk-v${VER}${SUFFIX}-${ABI}.apk`
  copyFileSync(join(apkDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), join(OUT, name))
  log(`产物: ${join(OUT, name)}`)
  console.log(`=== 完成（${ABI} ${SUFFIX}）===\nAPK=${join(OUT, name)}`)
} catch (e) {
  console.error(`[build-apk/${ABI}] ${e.message}`)
  process.exit(1)
}
