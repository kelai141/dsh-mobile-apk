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
// 依赖：node、python（Windows）/python3（Linux/WSL）在 PATH；插件/vendor 在 ROOT（apk 仓自包含布局下 ROOT 即 apk 仓根）；
//       scripts/plugin-dirs.json 与 scripts/profile-web.cordis.patch.yml 在场。
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, existsSync, rmSync, copyFileSync, cpSync, readFileSync, readdirSync } from 'node:fs'
import { assembleApk, verifyApks } from './build-apk-engine.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
/** Python 命令名：Windows 用 python，Linux/WSL 用 python3，与 build-snapshot-013.mjs 一致。 */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
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

// 门禁集（唯一声明处；check-release-gates.mjs 断言与 build-apk-013.ps1 的差集 = 0）
const GATE_SCRIPTS = [
  'check-patch-mirror.mjs',
  // 0.14.2 T6：补丁测试夹具必须与 contract.baseline 同代（夹具停在上一代 = 补丁回归结构性假绿）。
  'check-patch-fixtures.mjs',
  // 0.14.5 C-1：夹具同代不等于断言被跑过——把 26 个补丁回归全部纳入执行，已知失败用带理由白名单记账。
  'check-patch-test-manifest.mjs',
  // 0.14.2 D3 / B6：死 token 防漂移（我们 CSS 引用的 --dsw-* 对账上游现存令牌集合；上游树缺席即 SKIP 计数）。
  'check-dead-tokens.mjs',
  // review C6：适配层契约（bundle 行/构建产物/版本钉）。上游 dsh/ 与基线 node_modules 是本机只读
  // 产物（gitignore）——本链（云端自包含）对应小节 SKIP 计数；发布链以 --require 强制齐全。
  'check-contract.mjs',
  'check-snapshot-fingerprint.mjs',
  // 内嵌快照「真的能解压」门禁（0.14.7 / task-9 D-4）：指纹只自证「声明值与 tar 同批写出」，不解压。
  'check-snapshot-decode.mjs',
  // Delivery gate: every final APK must verify with v1, v2, and v3 before leaving out/.
  'check-apk-signatures.mjs',
  'check-manifest-hardening.mjs',
  // 0.14.8 堆下限：壳侧 shellEnv() 与快照内启动器必须给出同一 clamp 区间（单边漂移 = 部分路径仍 OOM）。
  'check-engine-heap-floor.mjs',
  'check-bounded-io.mjs',
  'check-api-route-auth.mjs',
  'check-protocol-v2.mjs',
  'check-tool-output-schema.mjs',
  'check-control-ops.mjs',
  'check-op-registry-parity.mjs',
  'check-tool-name-promises.mjs',
  'check-state-registry.mjs',
  'check-bridge-symmetry.mjs',
  'check-gate-skips.mjs',
  'check-engine-overlay.mjs',
  'check-patch-mounts.mjs',
  'check-inject-completeness.mjs',
  'check-combo-cache.mjs',
  'check-strip-noop.mjs',
  'check-kotlin-comments.mjs',
  'check-build-chain-abort.mjs',
  'check-snapshot-file-modes.mjs',
  'check-third-party.mjs',
  'check-snapshot-secrets.mjs',
  'elf-check.mjs',
  'check-runtime-assets.mjs',
  // H-1（0.14.2-fx-2）：MCP client 运行期依赖闭包必须在快照内可解析（用户自挂入口的面，
  // 正向闭包看不见它）。与本地链同一份实现，差集必须为 0（check-release-gates 断言）。
  'check-mcp-client-deps.mjs',
  'check-perf-instrumentation.mjs',
  // 模型面工具 wire 预算（0.14.0 §4.1 渐进披露）：注册集 + 初始可见集双口径（与本地链同一份实现）。
  'check-tool-surface-budget.mjs',
  // 插件单测（0.14.1 §1.1b 决策 1 / §2.4 前置项 1）：脚本自 0.14.0 起存在却从未被任何路径调用。
  // 与本地链同一份实现，差集必须为 0（check-release-gates 断言）——只加一侧即判红。
  'check-plugin-tests.mjs',
  // 冷启动预算（0.14.1 块F P0-2）：与本地链同一份实现（差集必须为 0）。
  'check-boot-budget.mjs',
  // 快照构建器产出面（0.14.1 P0 反回归）：与本地链同一份实现（差集必须为 0）。
  'check-snapshot-builder-output.mjs',
  // 浏览器语法下限（0.14.1 块C G-1）：与本地链同一份实现（差集必须为 0）。
  'check-browser-syntax-floor.mjs',
  // 构建并发上限（0.14.1 系统级约束）：不得吃满全部逻辑核（MuMu 模拟器/系统稳定）。
  'check-build-parallel-cap.mjs',
  // Kotlin 单测数量反回归（0.14.1 P0）：CI 不跑 Kotlin 单测 + 只按退出码判 = 防线删失仍绿。
  'check-kotlin-test-count.mjs',
  // 执行地图覆盖与锚点（0.14.2 D7）：输入在 apk 仓（app/src、plugins、EXECUTION-MAP.md）。
  'check-code-map.mjs',
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
  log('APK scheme and version suffix regression tests…')
  run(process.execPath, ['--test', gate('check-apk-signatures.test.mjs'), gate('resolve-version-suffix.test.mjs'), gate('build-apk-engine.test.mjs'), gate('build-hard-manifest.test.mjs'), gate('check-perf-instrumentation.test.mjs')])
  mkdirSync(OUT, { recursive: true })
  mkdirSync(work, { recursive: true })

  // ---- 1. 前置：基座/插件/vendor 在场 ----
  requires('snapshot 源', snapSrc)
  pluginDirs.forEach((p) => requires('插件', p))
  requires('vendor undo', join(undo, 'package.json'))
  requires('vendor market', join(market, 'package.json'))

  // ---- 2. 门禁（注入前；与 build-apk-013.ps1 同一份门禁集，0.13.8-b ST-06）----
  log('门禁：补丁镜像一致性…')
  run('node', [gate('check-patch-mirror.mjs')])
  log('门禁：补丁测试夹具随版（夹具代 == contract.baseline）…')
  run('node', [gate('check-patch-fixtures.mjs')])
  // 0.14.5 C-1：夹具同代**不等于**断言被跑过（26 个补丁回归此前只有 6 个有入口）。此处真的串行执行。
  log('门禁：补丁回归清单（全部 26 个文件必须被执行）…')
  run('node', [gate('check-patch-test-manifest.mjs')])
  // 0.14.2 D3 / B6：死 token 防漂移（我们 CSS 引用的 --dsw-* 对账上游现存令牌集合；上游树缺席即 SKIP 计数）。
  // 本轮实修：此前只登记进 GATE_SCRIPTS 声明数组、从未在此处调用——云端自包含链上这道门禁根本不跑。
  log('门禁：死 token 引用对账（--dsw-* vs 上游现存令牌）…')
  run('node', [gate('check-dead-tokens.mjs')])
  // review C6：适配层契约（上游 bundle 行引用 / 注入包 lib 产物 / 客户端槽位 / 版本钉台账）。
  log('门禁：适配层契约（bundle/构建产物/版本钉）…')
  run('node', [gate('check-contract.mjs')])
  log('门禁：快照指纹对账（预检）…')
  run('node', [gate('check-snapshot-fingerprint.mjs')])
  log('门禁：manifest 加固语义…')
  run('node', [gate('check-manifest-hardening.mjs')])
  // 0.14.8 堆下限：壳侧 shellEnv() 与快照内启动器必须给出同一 clamp 区间（单边漂移 = 部分路径仍 OOM）。
  log('门禁：引擎堆下限双源一致性…')
  run('node', [gate('check-engine-heap-floor.mjs')])
  log('门禁：Kotlin 注释嵌套…')
  run('node', [gate('check-kotlin-comments.mjs')])
  log('门禁：构建链中止语义（任一 ABI 被拒 = 非 0）…')
  run('node', [gate('check-build-chain-abort.mjs')])
  log('门禁：子进程有界读…')
  run('node', [gate('check-bounded-io.mjs')])
  log('门禁：/api 路由鉴权清单…')
  run('node', [gate('check-api-route-auth.mjs')])
  log('门禁：协议 V2 往返与体积…')
  run('node', [gate('check-protocol-v2.mjs')])
  log('门禁：工具输出 schema 契约…')
  run('node', [gate('check-tool-output-schema.mjs')])
  log('门禁：控制 op 六处登记链…')
  run('node', [gate('check-control-ops.mjs')])
  // 跨语言 op 清单对等（0.14.1）：引擎 REAL_SCREEN_CONTROL_OPS 与壳侧 REAL_SCREEN_OPS 必须逐条相同。
  // 漂移即「virtual-only 下点击生效校验/WebView ref 路径全不可用」（坑 162）。离线可跑。
  log('门禁：op 清单跨语言对等…')
  run('node', [gate('check-op-registry-parity.mjs')])
  // 工具名「承诺 vs 实现」（0.14.1）：指引里提到的 android_* 工具名必须真有声明位（坑 163 同族预防）。
  log('门禁：工具名承诺 vs 实现…')
  run('node', [gate('check-tool-name-promises.mjs')])
  // 插件单测门禁（0.14.1 §1.1b 决策 1 / §2.4 前置项 1）：脚本自 0.14.0 起存在却从未被调用。
  // 判据：有 test/*.test.mjs 必须真跑通且有效通过数 > 0（全 skip = 假绿）。需 plugins/*/lib 产物。
  log('门禁：插件单测（真跑，全 skip 即假绿）…')
  run('node', [gate('check-plugin-tests.mjs')])
  // 冷启动预算（0.14.1 块F P0-2；【0.14.1 P0-a 修复】原来写死 --self-test，使真检被结构性绕开——
  // 门禁对设备真产物会判红，但调用点只跑自证 → 判据真会红却永不执行。改为默认档：有真产物则真检
  // （超预算 exit 1 拒打包），无产物则 SKIP(real-data) 并退 --self-test。无产物不等于绿。）
  log('门禁：冷启动预算（有真产物则真检，否则退自证）…')
  run('node', [gate('check-boot-budget.mjs')])
  // 快照构建器产出面（0.14.1 P0 反回归）：锁「归档段是否还在」——被删会导致静默复用陈旧快照。
  log('门禁：快照构建器产出面（归档段 + 配置键闭合 + 路径同源）…')
  run('node', [gate('check-snapshot-builder-output.mjs')])
  // 构建并发上限（0.14.1 用户拍板系统级约束）：不得吃满全部逻辑核（MuMu 模拟器/系统稳定）。
  log('门禁：构建并发上限（固定 8 线程，不得吃满全部核心）…')
  run('node', [gate('check-build-parallel-cap.mjs')])
  // Kotlin 单测数量反回归（0.14.1 P0 / 0.14.2-fx-2 G.0 ⑤ 实修）：CI 从不跑 Kotlin 单测时，
  // 「只按退出码判」分不清「全绿」与「一个用例都没跑」；本门禁逐类比对基线 + 断言无缺席 + 结果新鲜。
  // **本轮去掉 --allow-missing**：它让「结果目录不存在」变成 SKIP⇒绿，正是 G.0 ⑤ 那条结构性脱节
  // （类被删/漏编译时 exit 仍 0）。真检点已挂到 apk CI 的 testDebugUnitTest **之后**（那里结果必在），
  // 云端 build-apk.yml 不产测试结果、不跑本门禁 ⇒ 该路径不再有「用 SKIP 冒充通过」的余地。
  log('门禁：Kotlin 单测数量反回归（逐类基线只许升 + 无缺席 + 结果新鲜）…')
  run('node', [gate('check-kotlin-test-count.mjs')])
  // 执行地图覆盖与锚点门禁（0.14.2 D7）：输入在 apk 仓，与本地链/发布链同一份实现。
  // 声明集合差集必须为 0 —— 只加一侧即被 check-release-gates 判红。
  log('门禁：执行地图覆盖与锚点（覆盖完整 + 锚点有效 + 编号一致）…')
  run('node', [gate('check-code-map.mjs')])
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
    // 浏览器语法下限：注入段降级（0.14.1 块C G-1，与本地链 build-apk-013.ps1:219-255 等价）
    //
    // 真因：注入进快照的 lib/client.js 若携带 Chromium 87 之后的语法（`?.` 等），老内核
    // （Android 10 / WebView 87，唯一在案的实测老内核 = 87.0.4280.101）解析期即失败 → 整个模块
    // 不执行。本链此前只有**注入后**的 `--scan`（下方第 4 段），却没有任何步骤把产物降到合规形态
    // → 云端自包含构建必判红（实测 `--scan vendor/dshmarketplace-plugin` 差分 1/1）。
    //
    // **为什么必须走暂存副本、禁止原地**：
    //   · `vendor/**/lib/` 是**入库跟踪**的（.gitignore 显式 `!vendor/...` 例外）→ 原地降级会写脏
    //     工作树，绊停发布链自身的 dirty 门禁，并让「产物可追溯到已提交源码」失效；
    //   · `plugins/*/lib/` 在 .gitignore 内，但原地降级会改写 lib/ 与包内 node_modules 副本 →
    //     与 apk 仓镜像产生无意义漂移，把 check-patch-mirror 判红（本地链实测踩到）。
    // 故：需要产物级降级的 vendor 三源先复制到 work 下的**暂存副本**再降级，并把暂存路径交给
    // combo 预计算与 inject-all（两处必须同一份，否则 combo 键与注入内容不一致）。
    // 我方 3 个带 client bundle 的包已在自己构建源里钉了 chrome87（tsdown.client.ts / build-client.mjs），
    // 不在此处重复降级（重复降级会制造镜像漂移，且无收益）。
    //
    // **顺序硬约束**：必须在 combo 预计算之前——combo 缓存键 = sha256(client.js)，实测同一棵树
    // 「先算 combo」与「降级后再算」的键集合仅 49/62 重叠（13 条键随降级改变）；顺序反了这 13 条
    // 必然 miss（fail-open 静默回退，启动收益归零）。
    // **权威判据仍在下游**：注入完成后的 `--scan <注入后 tar>` 才是判红点，本步只负责把产物改成合规形态。
    log('浏览器语法下限：注入段降级（暂存副本，chrome87）…')
    const degradeStaged = join(work, 'degrade-src')
    mkdirSync(degradeStaged, { recursive: true })
    // 默认指向**原源目录**（表示「不降级」）；只有真的降级成功才改指向暂存副本。
    // 无 lib/client.js 的源不复制、保持原路径。
    const degraded = new Map([
      ['undo', undo], ['market', market],
    ])
    for (const key of ['undo', 'market']) {
      const src = degraded.get(key)
      const leaf = key + '-degraded'
      if (!existsSync(join(src, 'lib', 'client.js'))) {
        log(`  跳过降级（无 lib/client.js）：${src}`)
        continue
      }
      const dst = join(degradeStaged, leaf)
      rmSync(dst, { recursive: true, force: true })
      // cpSync recursive 等价于本地链的 `robocopy /MIR`（整树复制；排除 .git 以免把版本库带进暂存树）
      cpSync(src, dst, { recursive: true, filter: (s) => !s.split(/[\\/]/).includes('.git') })
      run('node', [gate('check-browser-syntax-floor.mjs'), '--degrade', '--stage', dst])
      degraded.set(key, dst)
      log(`  暂存降级就位：${src} -> ${dst}`)
    }
    const undoDeg = degraded.get('undo')
    const marketDeg = degraded.get('market')
    log('单 pass 注入（@dsh-android + undo/market + 权威 patch，全部装配 profile）…')
    // ST-05：--all-profiles = 权威 patch 写给全部真实装配 profile（web+headless，负控 profile 除外）
    run(PYTHON, [
      join(ROOT, 'scripts', 'inject-all.py'), snapSrc, join(work, 'snap-final2.tar.xz'),
      join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'),
      '--dsh-android', ...pluginDirs,
      '--external', undoDeg, marketDeg,
      '--all-profiles',
    ])
    snapIn = join(work, 'snap-final2.tar.xz')
  } else {
    snapIn = snapSrc
    log('--skip-inject：直接用输入快照（dev 档；权限归一化只在注入链发生，禁止用于发布资产）')
  }

  // ---- 4. 门禁（注入后；与 build-apk-013.ps1 同一份门禁集）----
  log('门禁：patch 挂载集校验（双向差集）…')
  run('node', [gate('check-patch-mounts.mjs'), join(ROOT, 'scripts', 'profile-web.cordis.patch.yml'), ...pluginDirs, undo, market])
  // 注入面成员完整性（P0）：包内新增文件必须随注入进 tar，且相对导入不得悬空
  log('门禁：注入成员完整性（成员集合 + 相对导入可解析）…')
  run('node', [gate('check-inject-completeness.mjs'), snapIn])
  // combo 死缓存回流防护（0.14.2 撤销 A3 后反向）：产物里不得再出现 .combo-cache，构建链不得再调
  // combo-precompute——上游 rc.1 已把 combo 载荷改懒构造，5 MiB 预计算清单反而更慢（实测见补丁头注）。
  log('门禁：combo 死缓存不得回流产物…')
  run('node', [gate('check-combo-cache.mjs'), snapIn])
  // 浏览器语法下限（0.14.1 块C G-1）：入口 chunk 带 `static{}` 会让老内核（WebView <94）整模块不执行
  // → 纯白无字。判据 = 真实解析器 AST + esbuild 双 arm 逐字节差分（禁 grep），扫全清单。
  log('门禁：浏览器语法下限（AST + 双 arm 差分）…')
  run('node', [gate('check-browser-syntax-floor.mjs'), '--scan', snapIn])
  // 模型面工具 wire 预算（0.14.0 §4.1）：注册集（解锁后上限）+ 初始可见集（模型第一眼）双口径。
  // 前置于本步的插件 npm build 已产出 plugins/*/lib，门禁真跑各插件 apply() 采集工具定义。
  log('门禁：模型面工具 wire 预算（注册集 + 初始可见集）…')
  run('node', [gate('check-tool-surface-budget.mjs')])
  log('门禁：注入后 /api 路由鉴权 marker…')
  run('node', [gate('check-api-route-auth.mjs'), '--snapshot', snapIn])
  log('门禁：剥离清单后置断言（清单项必须不存在）…')
  run('node', [gate('check-strip-noop.mjs'), snapIn])
  log('门禁：快照权限模式…')
  const modes = spawnSync(process.execPath, [gate('check-snapshot-file-modes.mjs'), snapIn], { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' })
  if (modes.status !== 0) {
    if (SKIP_INJECT) log('警告：--skip-inject 档快照未做权限归一化（dev 专档，禁止发布）')
    else throw new Error('快照权限模式校验失败')
  }
  log('门禁：第三方许可…')
  run('node', [gate('check-third-party.mjs'), 'x', '--tar', snapIn, '--write-notices', join(ROOT, 'THIRD_PARTY_NOTICES.md')])
  log('门禁：机密（严格：归档不可读/成员为空即失败）…')
  run('node', [gate('check-snapshot-secrets.mjs'), snapIn, '--require'])
  log('门禁：ELF 架构…')
  run('node', [gate('elf-check.mjs'), snapIn, ABI])
  log('门禁：运行时补丁资产（严格，快照缺席即失败）…')
  run('node', [gate('check-runtime-assets.mjs'), ABI, '--require', '--snapshot', snapIn])
  // H-1（0.14.2-fx-2）：MCP client 运行期依赖闭包（该宿主不在我们装配的行面上，
  // check-engine-overlay 的正向闭包结构性看不见它——设备实测 boot 硬崩的正是这条）。
  log('门禁：MCP client 运行期依赖闭包（严格）…')
  run('node', [gate('check-mcp-client-deps.mjs'), ABI, '--require', '--snapshot', snapIn])
  // 严格产物检查：实际 P1 phase 探针、A1 profile 清单及退役 patchReload 不回流。
  log('门禁：实际 P1 phase 探针与 A1 profile 清单（严格）…')
  run('node', [gate('check-perf-instrumentation.mjs'), '--require', '--snapshot', snapIn, '--abi', ABI])

  // ---- 5. 许可资产（LICENSES + notices -> APK assets/licenses）----
  const licAssets = join(apkDir, 'app', 'src', 'main', 'assets', 'licenses')
  mkdirSync(licAssets, { recursive: true })
  for (const f of readdirSync(join(ROOT, 'LICENSES'))) if (f.endsWith('.txt')) copyFileSync(join(ROOT, 'LICENSES', f), join(licAssets, f))
  copyFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), join(licAssets, 'THIRD_PARTY_NOTICES.md'))
  log('许可资产就位')

  // ---- 6-8. Shared terminal stage: snapshot/fingerprint + Gradle + copy ----
  const name = `dsh-mobile-apk-v${VER}${SUFFIX}-${ABI}.apk`
  log('构建 APK…')
  const finalApk = assembleApk({
    snapshot: snapIn,
    apkDir,
    outputDir: OUT,
    artifactName: name,
    suffix: SUFFIX,
    clean: true,
    fingerprintGate: gate('check-snapshot-fingerprint.mjs'),
    log,
  }, (cmd, argv, opts) => spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts }))
  // 内嵌快照「真的能解压」门禁（0.14.7 / task-9 D-4）：必须紧跟 assembleApk —— 那时
  // assets/snapshot.tar.xz 正是本次被复制进 APK 的字节。判据与本地链同源（同一份脚本）。
  log('门禁：内嵌快照可解压（设备同源 streaming 解码器全量解压）…')
  run('node', [gate('check-snapshot-decode.mjs'), '--tar', join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz'), '--require'])
  run(process.execPath, [gate('check-apk-signatures.mjs'), '--self-test'])
  verifyApks({ signatureGate: gate('check-apk-signatures.mjs'), directories: [OUT], selfTest: false, log },
    (cmd, argv, opts) => spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts }))
  console.log(`=== 完成（${ABI} ${SUFFIX}）===\nAPK=${join(OUT, name)}`)
} catch (e) {
  console.error(`[build-apk/${ABI}] ${e.message}`)
  process.exit(1)
}
