#!/usr/bin/env node
// check-release-gates.mjs — 门禁聚合入口（0.13.8-b 批 B2：#208.E2 + F-ENV-13）
//
// 为什么需要它：issue #208 的根因是「同一批门禁在四条路径上有四份实现」——云端链只调 4 项、
// 两仓 CI 未接、发布链只跑机密与 elf。各自再写一份必然第三次漂移。本脚本是**唯一声明处**：
//   1) 声明本迭代要求的门禁集合（GATES），并断言每条接线路径实际调用 ⊇ 该集合；
//   2) 断言 build-release.ps1 走本聚合入口（`--run`），即发布链跑的是与打包同源的门禁集；
//   3) 断言 build-release.ps1 的 $pluginSrcs ⊇ build-apk-013.ps1 的 $pluginDirs（差集须显式声明理由）。
//
// 用法：
//   node scripts/check-release-gates.mjs                      # 静态接线断言（CI 可直接跑）
//   node scripts/check-release-gates.mjs --list               # 打印声明的门禁集合
//   node scripts/check-release-gates.mjs --run [--snapshot-dir <dir>]   # 顺序执行门禁集（发布链用）
//   node scripts/check-release-gates.mjs --self-test                   # 构建 canonical 路由的正控 / 负控自证
// 退出码：0 = 通过；1 = 接线缺口 / 门禁失败 / 树定位失败。
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const RUN = argv.includes('--run')
const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

/**
 * 2026-10-28 政策：构建脚本以 dsh-mobile-apk 为准，协调仓副本只作历史回退，字节差异属正常。
 * 本判据只守三件事：
 *   1. 协调仓布局下父入口真的委派 APK canonical（参数 / 退出码透传）；
 *   2. canonical 仍保留 #677 的 Kotlin 单测前置；
 *   3. canonical 不得回退到 --allow-missing。
 * 父副本与 canonical 的字节差异不再判红（旧实现正是因此让主线 Fast 恒红）。
 */
const evaluateBuildCanonicalPolicy = ({ parentPs1 = '', parentMjs = '', canonicalPs1 = null, requireDelegation = true }) => {
  const failures = []
  const norm = (s) => String(s ?? '').replace(/\\/g, '/')
  if (requireDelegation) {
    const ps1 = norm(parentPs1)
    if (!ps1.includes('dsh-mobile-apk/scripts/build-apk-013.ps1')) failures.push('build-apk-013.ps1 未委派 APK canonical 入口')
    if (!ps1.includes('LASTEXITCODE')) failures.push('build-apk-013.ps1 委派未透传退出码')
    const mjs = norm(parentMjs)
    if (!mjs.includes("'dsh-mobile-apk'") || !mjs.includes('build-apk.mjs')) failures.push('build-apk.mjs 未委派 APK canonical 入口')
    if (!mjs.includes('process.exit')) failures.push('build-apk.mjs 委派未透传退出码')
  }
  if (canonicalPs1 !== null) {
    const canonical = norm(canonicalPs1)
    if (!canonical.includes(':app:testDebugUnitTest')) failures.push('APK canonical 缺 #677 单测前置（:app:testDebugUnitTest）')
    // 只认真正的调用行：canonical 的注释里会解释「此前带 --allow-missing」，那不是回退。
    const allowMissingCall = canonical.split(/\r?\n/).find((line) => (
      line.includes('check-kotlin-test-count.mjs') && line.includes('--allow-missing') && !/^\s*#/.test(line)
    ))
    if (allowMissingCall !== undefined) failures.push('APK canonical 回退到 --allow-missing')
  }
  return failures
}

// L1 门禁自证：政策正控（脚本差异正常）与负控（委派缺失 / #677 前置回退）各两例。
if (argv.includes('--self-test')) {
  const delegatePs1 = "if (Test-Path $canonical) { & pwsh -File dsh-mobile-apk/scripts/build-apk-013.ps1; exit $LASTEXITCODE }"
  const delegateMjs = "const c = join(ROOT, 'dsh-mobile-apk', 'scripts', 'build-apk.mjs'); process.exit(r.status)"
  const canonical = "& $gradlew ':app:testDebugUnitTest' --no-daemon; node scripts/check-kotlin-test-count.mjs"
  const cases = [
    { name: '正控：父入口委派 + canonical 保留 #677', input: { parentPs1: delegatePs1, parentMjs: delegateMjs, canonicalPs1: canonical }, want: 0 },
    { name: '正控：父副本与 canonical 字节不同（政策允许）', input: { parentPs1: delegatePs1 + '\n# 本仓历史副本差异', parentMjs: delegateMjs + '\n// historical copy drift', canonicalPs1: canonical }, want: 0 },
    { name: '负控：父 PowerShell 入口缺委派', input: { parentPs1: 'node scripts\\check-x.mjs', parentMjs: delegateMjs, canonicalPs1: canonical }, want: 1 },
    { name: '负控：父 Node 入口缺委派', input: { parentPs1: delegatePs1, parentMjs: 'const GATE_SCRIPTS = []', canonicalPs1: canonical }, want: 1 },
    { name: '负控：canonical 缺 #677 单测前置', input: { parentPs1: delegatePs1, parentMjs: delegateMjs, canonicalPs1: 'node scripts/check-kotlin-test-count.mjs' }, want: 1 },
    { name: '负控：canonical 回退 --allow-missing', input: { parentPs1: delegatePs1, parentMjs: delegateMjs, canonicalPs1: canonical + '\nnode scripts/check-kotlin-test-count.mjs --allow-missing' }, want: 1 },
  ]
  let bad = 0
  for (const c of cases) {
    const failuresForCase = evaluateBuildCanonicalPolicy(c.input)
    const ok = c.want === 0 ? failuresForCase.length === 0 : failuresForCase.length > 0
    console.log((ok ? 'PASS  ' : 'FAIL  ') + 'self-test ' + c.name + (ok ? '' : ' -> ' + failuresForCase.join('；')))
    if (!ok) bad += 1
  }
  console.log('CHECK-RELEASE-GATES SELF-TEST ' + (bad === 0 ? 'PASSED' : 'FAILED'))
  process.exit(bad === 0 ? 0 : 1)
}


/**
 * 本迭代要求的门禁集合（唯一声明处）。
 *
 * **归属口径（2026-09-21 用户拍板重构）**：每条门禁只跑在**拥有其输入**的那一侧——
 *   - `ciApk`：输入在 apk 仓（壳侧 Kotlin / 引擎 op 两份清单 / bridge 对称基线 / 状态登记表…）⇒ 由 apk 仓 CI 跑；
 *   - `ciCoord`：输入在协调仓（plugins、scripts、patches、vendor）⇒ 由协调仓 CI 跑；
 *   - 两者皆 false：需要**两棵树都在场**（快照产物、跨仓逐字节镜像一致性、聚合发布面）⇒ 只由本地链与发布链
 *     （`build-apk-013.ps1` / `build-release.ps1 --run --require`，SKIP=0）执行。
 * 为什么不再要求「两仓 CI 都跑全量」：协调仓 CI 为跑那些 apk 侧门禁不得不跨仓检出对端，由此长出两个
 * 脆弱面并被实测咬过——① 对端分支名写死，迭代一过就检错分支；② 镜像副本含构建产物（lib/），而 CI 在
 * 构建前比对，必然判「清单不一致」。跨仓一致性交给两棵树都在场的链上执行，CI 只守本仓自包含面。
 * needsSnapshot=true 的门禁由构建/发布链调用，CI 不跑。
 */
const GATES = [
  { script: 'check-patch-mirror.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  // 0.14.2 D3/B6：死 token 防漂移——我们自己 CSS 引用的 --dsw-* 必须在上游现存令牌集合里
  // （引用不存在的令牌 ⇒ var(--dsw-x, 亮色回退) 整条声明失效 ⇒ 深色主题白底白字，D3 实锤）。
  // 输入在协调仓（我们的 CSS + 上游样式目录）⇒ 由协调仓 CI 与两条构建链跑；上游树不在场时 SKIP 计数。
  { script: 'check-dead-tokens.mjs', ciApk: false, ciCoord: true, needsSnapshot: false },
  // 0.14.2 T6：补丁测试的夹具必须与 contract.baseline 同代——夹具停在上一代时「补丁回归」是结构性假绿
  // （rc.1 实测：真树断 9 条而 16 个补丁测试全绿）。
  { script: 'check-patch-fixtures.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  // 0.14.5（上游对齐审计 C-1）：夹具同代**不等于**断言被跑过——26 个补丁回归里此前只有 6 个有入口，
  // 其余只被 node --check 解析过。本门禁把全部 26 个真的串行跑起来，并对已知失败采用**带理由的显式白名单**：
  // 存量失败如实记账，任何**新增**失败立刻判红。实测它当场逮到 ptc-android-native-A1 读 fixture 里不存在的 src/*.ts。
  { script: 'check-patch-test-manifest.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  // 0.14.8 堆下限：引擎 V8 老生代下限有**两个注入点**（壳侧 shellEnv() 的 NODE_OPTIONS +
  // 快照内启动器 usr/libexec/dsh-node），两处必须表达同一个 clamp 区间。单边漂移会造出
  // 「引擎起来了、code run 却仍 OOM」这类最难查的形态（启动器要覆盖被过滤 env 的调用方）。
  // 输入均在 apk 仓（EngineManager.kt + build-snapshot-013.mjs）⇒ 由 apk 仓 CI 跑；
  // 自身带 --self-test（1 正样本 + 8 受控负控），证明每条判据仍会判红。
  { script: 'check-engine-heap-floor.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-manifest-hardening.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-bounded-io.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  // #222：所有 mobile-owned /api exact/prefix 路由必须在登记表中，并有本地 auth guard 或窄公开白名单。
  { script: 'check-api-route-auth.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-snapshot-fingerprint.mjs', ciApk: true, ciCoord: false, needsSnapshot: true },
  // 0.14.7 / task-9 D-4：内嵌快照「真的能解压」门禁。输入 = APK 树内嵌 assets/snapshot.tar.xz（构建期就位），
  // 判据 = 用与设备同一套 streaming 解码器完整解压一遍（两条构建链在 assemble 之后真跑；CI 无 jar 缓存时
  // 显式 SKIP 计数，发布链 --require 判红）。needsSnapshot=false：它读的是 APK 树内嵌资产，不是 .deploy-tmp 的 tar。
  // releaseSink=false：**不能**放在发布链的 2f 段（--run）——那一段跑在注入后快照上，而内嵌资产要等
  // build-apk-engine.mjs assemble 复制进 APK 树才有；在 2f 跑它验的是上一次构建的残留甚至缺席。
  // 真实执行点是本地链 assemble 之后的 per-ABI 段（见 scripts/build-apk-013.ps1），sink 断言会核验它确实被调用。
  { script: 'check-snapshot-decode.mjs', ciApk: true, ciCoord: false, needsSnapshot: false, releaseSink: false, sink: 'local-chain' },
  // G.3（0.14.2-fx-2）下沉：它的输入是 plugins/*/lib（源码面产物），**不是发布 tar** ⇒ 留在发布链上
  // 只是把 43.3s 重复付一遍（apk CI 已真跑，见 pr-gate.yml「工具 output.schema」步）。releaseSink:false
  // 只把它从**发布链的 --run 段**移出，声明仍在（不删门禁），由 apk CI 承担执行。
  { script: 'check-tool-output-schema.mjs', ciApk: true, ciCoord: false, needsSnapshot: false, releaseSink: false, sink: 'apk-ci' },
  { script: 'check-protocol-v2.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-control-ops.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  // 「会读设备屏的 op」两份清单的跨语言对等（0.14.1）：引擎 `REAL_SCREEN_CONTROL_OPS` 与壳侧
  // `REAL_SCREEN_OPS` 必须逐条相同。设备实测缺陷 B4 的根因就是它们不一致——壳侧那份是
  // `A11Y_OPS` 后端能力清单的陈旧拷贝，多带 `state`/`webSnapshot`/`webAction` 三条**不读设备屏**的 op，
  // 于是这三条在缺省范围 virtual-only 下被壳侧范围门拦死：android_web_dump、WebView ref 路径、
  // 以及点击生效校验（verifyClick 读 `state`）在缺省范围下全不可用，而引擎侧毫无察觉。
  { script: 'check-op-registry-parity.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  // 镜像前缀表双真源一致性（本轮调查发现）：壳侧 UpdateChecker.MIRROR_PREFIXES 与下载站
  // webpages/src/assets/release.js 的 MIRROR_TEMPLATES 必须逐条同序。两份表曾漂移成 3 条 vs 4 条
  // （壳侧缺 ghproxy.net），后果是「应用内下载」与「浏览器下载」走不同的线路集合，而没有任何一层
  // 为不一致负责。顺序即回退优先级，故判据**不排序**：位置对调也算差异。
  { script: 'check-mirror-parity.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-runtime-assets.mjs', ciApk: false, ciCoord: false, needsSnapshot: true },
  // 机密门禁（review C3）：归档不可读/成员为空 = 硬失败（旧实现垃圾文件也 PASS 的假绿）；严格档 --require。
  { script: 'check-snapshot-secrets.mjs', ciApk: false, ciCoord: false, needsSnapshot: true },
  // 适配层契约（review C6）：上游 bundle 行引用 / 注入包构建产物 / 客户端槽位 / 版本钉台账。
  // 上游 `dsh/` 与基线 node_modules 是 gitignore 的本机只读产物——CI 与云端自包含树跑不全
  // （SKIP 计数），由两条构建链与发布链（--run --require，强制 SKIP=0）实际执行。
  { script: 'check-contract.mjs', ciApk: false, ciCoord: false, needsSnapshot: false },
  // 0.13.8-b B2（ST-25/26/31 + §7.2 度量）：制度性门禁与性能度量入口一并进声明集合，
  // 由本聚合入口保证两条链 + 两仓 CI 都跑到（接线面只此一处）。
  { script: 'check-state-registry.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-bridge-symmetry.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-gate-skips.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  { script: 'check-perf-instrumentation.mjs', ciApk: true, ciCoord: true, needsSnapshot: true },
  // 注入面成员完整性（P0：包内新增文件曾被静默丢弃 → ERR_MODULE_NOT_FOUND/引擎启动即死）：
  // 需要「注入后」tar，故 CI 不跑，由两条构建链在注入步骤之后调用 + 发布链按快照面跑。
  { script: 'check-inject-completeness.mjs', ciApk: false, ciCoord: false, needsSnapshot: true },
  // Kotlin 块注释嵌套静态检查（KDoc 里写 node_modules/** 会吞掉整个文件；dev-shell 实测）。
  { script: 'check-kotlin-comments.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  { script: 'check-i18n-parity.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  // 构建链中止语义（任一 ABI 被拒 = 整链非 0；0.13.8-b 实锤：arm64 被拒后仍 exit 0 交付单 ABI 产物）。
  { script: 'check-build-chain-abort.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  // 剥离清单后置断言（ST-16）：清单项在产物里必须不存在 + 反 no-op（基座命中的必须消失）。
  { script: 'check-strip-noop.mjs', ciApk: false, ciCoord: false, needsSnapshot: true },
  // combo 缓存覆盖（0.14.0 启动性能 P1-2 / 引擎树补丁 combo-cache-A3）：注入后快照的每条
  // client.js 必须有 sha256 命中的缓存条目，否则运行期回退现场生成会吞掉全部启动收益。
  { script: 'check-combo-cache.mjs', ciApk: false, ciCoord: false, needsSnapshot: true },
  // 模型面工具 wire 预算（0.14.0 §4.1 渐进披露）：注册集（解锁后上限）+ 初始可见集（模型第一眼）
  // 双口径。掩蔽组名单从 capability-gate 实现导出，门禁不另写一份（防清单漂移假绿）。
  // 离线可跑（真跑各插件 apply()，只需 plugins/*/lib 构建产物）-> CI 与两条链都跑。
  { script: 'check-tool-surface-budget.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  // 工具名「承诺 vs 实现」（0.14.1）：指引里提到的 `android_*` 工具名必须真有声明位。
  // 设备实测缺陷 B2 的原形是 `android_vdisplay_input` 被三处模型可见文案与 Skill 文档承诺，却从未
  // `defineTool`——模型照指引调用只拿到 `unknown tool`，且会把这当成自己参数写错而反复重试。
  // 判据零启发式：声明位字面量集合 ⊇ 全仓 `android_*` 提及集合（白名单为空，加任何一条都要被质疑）。
  { script: 'check-tool-name-promises.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  // 插件单测（0.14.1 §1.1b 决策 1 / §2.4 前置项 1）：该脚本自 0.14.0 起就存在，却**从未被任何
  // 路径调用**（不在 GATES、不在接线断言、两条链与两仓 CI 均无引用）——7 个插件的 34 个测试文件
  // 全部没人跑，「已新增该门禁」的声明与事实不符。此处接入声明集合即同时被两条构建链与两仓 CI
  // 覆盖（check-gate-skips.mjs 会断言声明集合被两条链逐项调用）。离线可跑，只需 plugins/*/lib。
  // G.3（0.14.2-fx-2）下沉：7 个插件的单测（103.1s，是全场最贵的一项）输入同样是 plugins/*/lib，
  // 与发布 tar 无关；apk CI 已真跑（pr-gate.yml「插件单测」步）。移出发布链 --run 段，声明保留。
  { script: 'check-plugin-tests.mjs', ciApk: true, ciCoord: false, needsSnapshot: false, releaseSink: false, sink: 'apk-ci' },
  // 冷启动预算 C1~C6（0.14.1 块F P0-2）：把口径从「LISTEN 达标」换成「首个 HTTP 响应 + 无 >2s
  // 同步块」——只判 LISTEN 会系统性假绿（设备实测 LISTEN 2981ms 达标而 compose 2795ms 挡住首个响应）。
  // 判据全部为数值算术断言 + 自带反向对照（--self-test）。
  // **真数据来源（2026-09-19 修复「只跑 self-test 就算过」）**：
  //   a. 默认档（无参数）——按 `--segments/--probe` > `DSH_BOOT_SEGMENTS`/`DSH_BOOT_PROBE` >
  //      `.deploy-tmp/boot-budget/{boot-segments.log,engine.log}` 顺序发现**设备原始产物**；
  //      有产物即**真检**（超预算 exit 1），无产物则明确标 `SKIP(real-data)` 并退 `--self-test`
  //      自证（**绝不冒充绿**）。
  //   b. `--pull <serial>`——直接 `adb ... run-as <pkg> cat files/{boot-segments.log,engine.log}`
  //      拉取真产物再真检（自动化半边，免人手导出）。
  //   c. `--require-real`（发布前设备门禁）——产物缺席即判红，禁止「无产物 = 通过」。
  //   此前四处调用点一律传 `--self-test`，真检**永不执行**（判据真会红却被结构性绕开）；现全部改默认档。
  { script: 'check-boot-budget.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  // 快照构建器**产出面**结构断言（0.14.1 P0 反回归）：0849579 曾把 §8 归档整段删掉，构建器跑到
  // 瘦身就 exit 0、**从不产出 tar**，而打包链只判「tar 是否存在」→ 静默复用陈旧快照、全链零报错。
  // 判据 = 产出面构造在场 + slim.json 配置键消费者闭合（死键即某步被删的第一手信号）+ 与打包链路径同源。
  // 离线可跑（只读源码与配置），故 CI 与两条链都跑。
  { script: 'check-snapshot-builder-output.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  // 浏览器语法下限（0.14.1 块C G-1）：老设备（WebView <94）白屏的产物级真因——入口 chunk 带
  // ES2022 类静态块 `static{}`，解析期语法错误 → 整模块不执行 → 纯白无字。判据为**真实解析器 AST**
  // + esbuild 双 arm 逐字节差分（禁 grep 文本在场），自带四向自证。真检需快照/构建树，CI 跑 --self-test。
  { script: 'check-browser-syntax-floor.mjs', ciApk: true, ciCoord: false, needsSnapshot: true },
  // 构建并发上限（0.14.1 用户拍板的系统级约束）：构建期压缩/解压不得吃满全部逻辑核（原为 `xz -T0`
  // = 16 线程），否则开发机被撑满 → MuMu 模拟器卡顿/系统不稳（「模拟器优先」是铁律 2，两者常并行）。
  // 判据 = 上限来自单一常量且默认 8 + 构建链真的消费它 + 设备侧同受限 + 注释不自伤。离线可跑。
  { script: 'check-build-parallel-cap.mjs', ciApk: true, ciCoord: true, needsSnapshot: false },
  // Kotlin 单测数量反回归（0.14.1 P0）：审计发现两处同源缺口——① CI 从不跑 Kotlin 单测
  // （pr-gate 只跑 compileDebugKotlin）→ 417 例契约断言只在本地手动跑过；② 即使跑起来，
  // 只按退出码判也分不清「全绿」与「一个用例都没跑」（测试类被删/改名/漏编译时 exit 仍 0）。
  // 本门禁逐类比对基线（只许升）+ 断言无缺席 + 结果新鲜，抓「防线被删却仍然绿」。
  // ci:false 是刻意的：云端 CI 无 gradle 产物环境，故本项由本地链/发布链跑；
  // 无结果时显式 SKIP(#1) 计数（不计入绿），绝不冒充通过。
  // G.0 ⑤ 结构性脱节 + G.3 下沉（0.14.2-fx-2）：apk CI 此前跑 testDebugUnitTest 却**从不**调本门禁，
  // 而云端链传 --allow-missing ⇒ 「测试类被删」时 CI 仍绿。本轮把它挂到 apk CI 的 testDebugUnitTest
  // **之后**（同 job，结果目录已就位、无 SKIP），并去掉 build-apk.mjs 的 --allow-missing。
  // 发布链不再 --run 它（51.1s）：发布产物不含测试结果，判据在 CI 才是真检。
  { script: 'check-kotlin-test-count.mjs', ciApk: false, ciCoord: false, needsSnapshot: false, releaseSink: false, sink: 'apk-ci' },
  // Execution-map coverage and anchor checks (0.14.2 D7). Its inputs are APK source and docs,
  // so this gate belongs to APK CI and both APK build chains, not coordination CI. The shared
  // script remains in MIRROR_TOP so coordinated builds use the same source-line expectations.
  // It also runs before packaging; needsSnapshot=false because it reads the tree and docs only.
  // The APK workflow invokes this gate after Kotlin compilation and before package checks.
  { script: 'check-code-map.mjs', ciApk: true, ciCoord: false, needsSnapshot: false },
  // MCP client 运行期依赖闭包（0.14.2-fx-2 H-1）：真实用户诊断包 engine.log:138 六世代全崩在
  // `Cannot find package '@modelcontextprotocol/client'`——它**不在我们装配的行面上**（用户自己挂的
  // entry），故 check-engine-overlay 的正向闭包结构性看不见它。判据 = 宿主包运行期依赖的**闭包**
  // 在快照内全部可解析；上游再换包名/加依赖即判红。输入在快照面 ⇒ needsSnapshot=true。
  { script: 'check-mcp-client-deps.mjs', ciApk: false, ciCoord: false, needsSnapshot: true },
]
const CI_COORD_GATES = GATES.filter((g) => g.ciCoord).map((g) => g.script)
const CI_APK_GATES = GATES.filter((g) => g.ciApk).map((g) => g.script)
const ALL_GATES = GATES.map((g) => g.script)
// ── G.3（0.14.2-fx-2）发布路径最小充分集 ──────────────────────────────────────
// 用户原话：「优化所有构建链的校验链路削减无必要环节避免浪费性能资源（现在的校验比命还长，
// 打包都用不了那么久）」。G.0 实测：发布链 --run 的冷跑合计 322.2s，其中若干条门禁的**输入根本不是
// 发布 tar**（plugins/*/lib、Kotlin 测试结果），把它们的耗时重复付在发布路径上并不增加任何判别力
// ——它们的真检点在 CI（那里才有对应输入）。
//
// 下沉规则（**不删门禁**，只改「谁来跑」）：
//   · releaseSink !== false ⇒ 发布链 --run 段执行（默认）；
//   · releaseSink === false ⇒ 从发布链 --run 段移出，**必须在 sink 字段写明接管方**，
//     且下方断言会核验该接管方真的调用了它（否则就是「移出去就没人跑」= 静默降级防线）。
// 声明集合本身不变（33 项）：check-gate-skips 仍逐项要求两条构建链调用，故「移出发布段」不等于「移出防线」。
const RELEASE_GATES = GATES.filter((g) => g.releaseSink !== false).map((g) => g.script)
const RELEASE_EXCLUDED = GATES.filter((g) => g.releaseSink === false)
/**
 * sink 类型表（下沉门的接管方在哪、是否依赖 apk 树）。
 *   apkSide=true  ⇒ 路径相对 **apk 仓树根**解析（协调仓布局下可能整树缺席 ⇒ 降级 SKIP）
 *   needsApkTree  ⇒ 该 sink 的证据只存在于 apk 仓，apk 树缺席时不得判红、也不得回落取证
 */
const SINK_KINDS = {
  'apk-ci': { rel: join('.github', 'workflows', 'pr-gate.yml'), apkSide: true, needsApkTree: true },
  'coord-ci': { rel: join('.github', 'workflows', 'pr-gate.yml'), apkSide: false, needsApkTree: false },
  'cloud-chain': { rel: join('scripts', 'build-apk.mjs'), apkSide: true, needsApkTree: true },
  'local-chain': { rel: join('scripts', 'build-apk-013.ps1'), apkSide: false, needsApkTree: false },
}

/** 来源审计链（`.github/workflows/build-apk-source.yml`）的**专有**门禁。
 *  它们**刻意不进 GATES**：`ALL_GATES = GATES.map(...)`，一旦进册就会要求本地链与云端链
 *  也调用它们，而那两条链不跑来源链（口径是「只跑在拥有其输入的那一侧」，第三条链同理）。
 *  此前这 5 条不在任何清单里：删掉 workflow 里的调用点，本地链 / 云端链 / 协调仓 CI 全绿，
 *  而它们从未真跑——正是本文件要防的「有人加了一道门禁但没人接线」。 */
const SOURCE_GATES = [
  'check-package-lock-roots.mjs',
  'check-dsh-runtime-dependencies.mjs',
  'check-android-native-runtime-packages.mjs',
  'check-dsh-source-snapshot.mjs',
  'check-dsh-source-snapshot-gate.mjs',
]

if (argv.includes('--list')) {
  for (const g of GATES) {
    // 真检档标注：让「怎么真验」有唯一入口，不靠人记（F 门禁的真数据路径见文首注释与详档 §5.1）。
    const note = g.script === 'check-boot-budget.mjs' ? '  [真检需 --require-real + 设备产物；见详档 §5.1]' : ''
    // G.3：下沉门在清单里显式标出「不进发布 --run 段」及其接管方，避免「看着在清单里其实没人跑」。
    const sink = g.releaseSink === false ? '  [下沉->' + g.sink + '；不进发布 --run]' : ''
    console.log(g.script.padEnd(34) + (g.ci ? 'CI+构建' : '仅构建/发布') + (g.needsSnapshot ? ' 需要快照' : '') + note + sink)
  }
  console.log('-- 发布链 --run 段实际执行: ' + RELEASE_GATES.length + ' / 声明 ' + GATES.length + ' 项；下沉 ' + RELEASE_EXCLUDED.length + ' 项')
  process.exit(0)
}

const failures = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
/** 布局无关解析：协调仓根用 `dsh-mobile-apk/...`；apk 仓自包含根落到同名相对路径。 */
const resolveRel = (p) => {
  const cands = p.startsWith('dsh-mobile-apk/') ? [p, p.slice('dsh-mobile-apk/'.length)] : [p]
  return cands.find((c) => existsSync(join(ROOT, c)))
}
const readOrFail = (p) => {
  const hit = resolveRel(p)
  if (!hit) { check('接线面存在: ' + p, false, '文件缺席（协调仓根与 apk 仓根布局均未命中）'); return null }
  return readFileSync(join(ROOT, hit), 'utf8')
}

// ── 1. 接线面（§8.3 C 的五位置 + apk 仓同版）────────────────────────────────
const POSITIONS = [
  { id: 'local-chain', file: 'scripts/build-apk-013.ps1', gates: ALL_GATES, kind: 'gate-names' },
  { id: 'cloud-chain', file: 'dsh-mobile-apk/scripts/build-apk.mjs', gates: ALL_GATES, kind: 'gate-names' },
  // 归属口径：ci-coord 只见于协调仓布局（apk 自包含树里该文件就是本仓自己的 workflow，
  // 拿它去满足 ciCoord 集合等于自我循环，故布局缺席时**显式 SKIP 并计数**）。
  { id: 'ci-coord', file: '.github/workflows/pr-gate.yml', gates: CI_COORD_GATES, kind: 'gate-names', onlyWithCoordLayout: true },
  // apk 侧两态：协调仓布局看 `dsh-mobile-apk/.github/workflows/pr-gate.yml`；apk 自包含布局看本仓同名文件
  // （resolveRel 已处理）。协调仓布局下 apk 树可能不在场（净检出/自包含 CI）——那时**显式 SKIP 并计数**，
  // 绝不回落到本仓自己的 workflow 去满足 ciApk 集合（那是自我循环，会让断言失去判别力）。
  { id: 'ci-apk', file: 'dsh-mobile-apk/.github/workflows/pr-gate.yml', gates: CI_APK_GATES, kind: 'gate-names', needsApkTree: true },
  // 第三条链：来源审计链有自己的专有门禁（含它临时接管 overlay 门禁用的适配器）。与 ci-apk 同源
  // 理由——该 workflow 只存在于 apk 仓，协调仓布局下 apk 树不在场时显式 SKIP 并计数（绝不回落到
  // 别的 workflow 去满足集合，那会变成自我循环、让断言失去判别力）。
  { id: 'source-chain', file: 'dsh-mobile-apk/.github/workflows/build-apk-source.yml', gates: SOURCE_GATES, kind: 'gate-names', needsApkTree: true },
  { id: 'release-coord', file: 'scripts/build-release.ps1', gates: ALL_GATES, kind: 'aggregator' },
  { id: 'release-apk', file: 'dsh-mobile-apk/scripts/build-release.ps1', gates: ALL_GATES, kind: 'aggregator' },
]
const coordLayout = existsSync(join(ROOT, 'dsh-mobile-apk'))
/** apk 自包含布局判定：只有 apk 仓有 app/src/main/AndroidManifest.xml（协调仓没有）。 */
const apkSelfContained = existsSync(join(ROOT, 'app', 'src', 'main', 'AndroidManifest.xml'))
/**
 * apk 仓树根（显式解析，**不经过 resolveRel 的回落候选**）。
 *
 * 为什么必须显式：`resolveRel('dsh-mobile-apk/.github/...')` 在协调仓布局下会回落到
 * `.github/workflows/pr-gate.yml`（**协调仓自己的** workflow）——用它去满足 apk 侧集合是**自我循环**，
 * 断言会恒真。apk 侧证据只能来自 apk 仓。
 *   · apk 自包含布局（ROOT 就是 apk 仓）      ⇒ apk 树根 = ROOT；
 *   · 协调仓布局                            ⇒ apk 树根 = <root>/dsh-mobile-apk（CI 里常整个缺席）。
 * `--apk-tree <dir>` 供「两方向实测」把对端指到受控位置（不存在 ⇒ 验降级；指向改过的副本 ⇒ 验判别力）。
 */
const apkTreeArg = argOf('apk-tree')
const APK_TREE = apkSelfContained ? ROOT : (apkTreeArg ? resolve(apkTreeArg) : join(ROOT, 'dsh-mobile-apk'))
/** apk 树是否在场：以 apk 仓自己的 pr-gate workflow 为锚（协调仓布局缺席时为 false）。 */
const apkTreePresent = existsSync(join(APK_TREE, '.github', 'workflows', 'pr-gate.yml'))
/**
 * 布局降级 SKIP 计数器（静态档）。
 *
 * 为什么要有它：协调仓是**独立布局**，`dsh-mobile-apk/` 是独立 git 仓且在协调仓里被 gitignore
 * ⇒ 协调仓 CI 的检出里**根本没有 apk 树**。凡「需要 apk 树才能核验」的断言，在该布局下都不能硬判红，
 * 必须**显式 SKIP 并计数**（可见、不冒充绿）；且**不得**回落到协调仓自己的同名文件去「找到」证据
 * ——那会让断言恒真、失去判别力（CI 实测：PR #68 因为漏了这条降级而必红）。
 */
let staticSkipTotal = 0
const skipStatic = (what, why) => {
  staticSkipTotal += 1
  console.log('SKIP(#' + staticSkipTotal + ')  ' + what + '：' + why)
}
for (const pos of POSITIONS) {
  if (pos.onlyWithCoordLayout && !coordLayout) {
    skipStatic(pos.id + ' 门禁集', '本布局无协调仓侧 workflow（apk 自包含树）；跨仓面由链上守')
    continue
  }
  if (pos.needsApkTree && !apkTreePresent) {
    // 协调仓布局且 apk 树不在场：`.github/workflows/pr-gate.yml` 会解析到**本仓自己的** workflow，
    // 拿它去满足 ciApk 集合是自我循环 ⇒ 显式 SKIP 并计数（apk 侧由 apk 仓 CI 自检，链上另有全量）。
    skipStatic(pos.id + ' 门禁集', '协调仓布局下 apk 树不在场（自包含 CI）')
    continue
  }
  const text = readOrFail(pos.file)
  if (text === null) continue
  if (pos.kind === 'aggregator') {
    const hasEntry = text.includes('check-release-gates.mjs') && text.includes('--run')
    check(pos.id + ' 走聚合入口（check-release-gates.mjs --run，与打包同源门禁集）', hasEntry,
      '缺聚合入口调用：发布链不得只跑机密/elf 门禁')
    continue
  }
  const missing = pos.gates.filter((g) => !text.includes(g))
  check(pos.id + ' 门禁集 ⊇ 声明集合（' + pos.gates.length + ' 项）', missing.length === 0,
    '未接线: ' + missing.join(', '))
}

// ── 2. $pluginSrcs ⊇ $pluginDirs（构建/发布章 F-ENV-13）────────────────────
const GAPS_PATH = join(ROOT, 'scripts', 'release-plugin-src-gaps.json')
const gaps = existsSync(GAPS_PATH) ? (JSON.parse(readFileSync(GAPS_PATH, 'utf8')).gaps ?? []) : []
const buildPs1 = readFileSync(join(ROOT, 'scripts', 'build-apk-013.ps1'), 'utf8')
const releasePs1 = readFileSync(join(ROOT, 'scripts', 'build-release.ps1'), 'utf8')
// 注入集单一常量（0.13.8-b ST-06 / F-ENV-04）：$pluginDirs 已外提到 scripts/plugin-dirs.json，
// 本地链与云端链 build-apk.mjs 共用同一份（旧实现两处各写一份，云端少一个包且无从发现）。
const pluginManifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'plugin-dirs.json'), 'utf8'))
const pluginDirs = new Set(pluginManifest.dirs.map((p) => p.split('/').pop()))
const pluginSrcs = new Set((releasePs1.match(/\$pluginSrcs\s*=\s*@\(([^)]*)\)/) ?? [,''])[1]
  .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean).map((p) => p.split('/').pop()))
check('$pluginDirs / $pluginSrcs 可解析', pluginDirs.size > 0 && pluginSrcs.size > 0,
  'pluginDirs=' + pluginDirs.size + ' pluginSrcs=' + pluginSrcs.size)

const missingFromSrcs = [...pluginDirs].filter((p) => !pluginSrcs.has(p)).sort()
const undeclared = missingFromSrcs.filter((p) => !gaps.some((g) => (g.plugin ?? '').split('/').pop() === p))
const badGap = gaps.filter((g) => !g.reason || !String(g.reason).trim())
const staleGap = gaps.filter((g) => !missingFromSrcs.includes((g.plugin ?? '').split('/').pop()))
for (const g of gaps) console.log('WARN  $pluginSrcs 差集显式声明: ' + g.plugin + ' -> ' + g.reason)
check('build-release.ps1 $pluginSrcs ⊇ build-apk-013.ps1 $pluginDirs（差集须显式声明理由）',
  undeclared.length === 0 && badGap.length === 0,
  '未声明或空理由: ' + [...undeclared, ...badGap.map((g) => g.plugin)].join(', '))
check('release-plugin-src-gaps.json 无过期条目', staleGap.length === 0,
  '已不再缺失却仍声明: ' + staleGap.map((g) => g.plugin).join(', '))

// ── 3. 构建脚本 canonical 路由（2026-10-28 政策）────────────────────────────
// 两仓构建脚本不再要求逐字节同版：dsh-mobile-apk 是 canonical，协调仓只留历史副本。
// 这里改守「父入口委派 + canonical 的 #677 前置仍在」，避免副本回退被静默接受。
{
  const canonicalPs1 = apkSelfContained
    ? join(ROOT, 'scripts', 'build-apk-013.ps1')
    : join(APK_TREE, 'scripts', 'build-apk-013.ps1')
  if (apkSelfContained) {
    const failuresForCanonical = evaluateBuildCanonicalPolicy({
      canonicalPs1: readFileSync(canonicalPs1, 'utf8'),
      requireDelegation: false,
    })
    check('APK canonical build-apk-013.ps1 保留 #677 单测前置（无 --allow-missing 回退）',
      failuresForCanonical.length === 0, failuresForCanonical.join('；'))
  } else if (existsSync(canonicalPs1)) {
    const failuresForRouting = evaluateBuildCanonicalPolicy({
      parentPs1: readFileSync(join(ROOT, 'scripts', 'build-apk-013.ps1'), 'utf8'),
      parentMjs: readFileSync(join(ROOT, 'scripts', 'build-apk.mjs'), 'utf8'),
      canonicalPs1: readFileSync(canonicalPs1, 'utf8'),
    })
    check('父构建入口委派 APK canonical，且 canonical 保留 #677 单测前置（脚本差异不判红）',
      failuresForRouting.length === 0, failuresForRouting.join('；'))
    console.log('APK-CANONICAL  构建脚本以 ' + rel(canonicalPs1) + ' 为准；本仓 scripts/build-apk-013.ps1 / build-apk.mjs 副本差异属正常')
  } else {
    skipStatic('构建脚本 canonical 路由', '协调仓布局下 apk 树不在场（自包含 CI 各自核 canonical）')
  }
}

// ── 3a. 构建/门禁脚本必须可被 node 解析（0.14.2 补线）─────────────────────
// 真因（本轮实锤）：`check-patch-mirror` 只判**逐字节相等**，一份语法坏掉的 build-snapshot
// 会「镜像一致 PASSED」地同步到两棵树，而所有静态门禁都不解析它——直到真正跑构建才炸，
// 于是本地一次、CI 一次、发布链一次，三处都白等。语法是最廉价的判据，放在这里当自动挡。
{
  // 扫描面**递归**覆盖 scripts/ 全树：旧实现只列 scripts/ 与 scripts/lib 两层，
  // 于是 scripts/source-build/（来源链 24 个）、patches/、perf/、golden/、tests/
  // 以及 patches/tests/ 深处的 .mjs 共 47 个从未被解析过——而这道判据的立项理由正是
  // 「一次语法错要等本地、CI、发布链三处白等」。
  const candidates = []
  const collect = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) collect(path)
      else if (entry.isFile() && entry.name.endsWith('.mjs')) candidates.push(path)
    }
  }
  if (existsSync(join(ROOT, 'scripts'))) collect(join(ROOT, 'scripts'))
  const broken = []
  for (const p of candidates) {
    const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' })
    if (r.status !== 0) broken.push(rel(p) + ': ' + ((r.stderr || '').split('\n').find((l) => l.includes('Error')) ?? '解析失败'))
  }
  check('构建/门禁脚本全部可解析（node --check，' + String(candidates.length) + ' 个）', broken.length === 0,
    broken.join(' | '))
}

// ── 3a-1. 公共库模块必须有真实消费者（0.14.8 D-6 补线）────────────────────────
// 真因（本轮实锤）：scripts/lib/tar-extract-cache.mjs 立项于 0.14.2-fx-2 G.3（「12 条门禁各自解
// 同一个 148MB 快照、合计 411.5 s」），134 行 + 13 单测 + 1 集成测试全绿，**消费者数为 0**——
// 上线两个版本无人发现，因为「模块自带测试全绿」看起来与「模块在起作用」没有区别。
//
// 为什么现在才查出来（两个盲区叠加）：
//   · check-patch-mirror 的 MIRROR_TOP 只断言「两仓同版」，不断言「有人用」——0 消费者的模块照样 PASS；
//   · 唯一的「门禁被调用」断言（3a-2 / 3b）覆盖的是 GATES/RELEASE_GATES 里的**门禁脚本**，
//     scripts/lib/** 这类**被 import 的基础设施**不在任何断言面上。
//
// 判据（结构性的，不是「提到过」）：scripts/lib/*.mjs 的基线名必须至少出现在一个
//   ① 其他 scripts/*.mjs 或 scripts/**/*.mjs 的 import/from 行里；或
//   ② 非注释代码行里点名（例：check-build-parallel-cap 断言 lib/shell.mjs 的常量）。
// 豁免面必须**具名且带理由**（ALLOW_NO_CONSUMER），不得用模式批量放行——豁免表就是这条断言的判别力边界。
const PUBLIC_LIB = join(ROOT, 'scripts', 'lib')
const LIB_NO_CONSUMER_ALLOW = {
  // 目前为空：本条断言上线时 scripts/lib 全部模块都有真实消费者（tar-extract-cache 已退役删除）。
  // 新增条目必须写明「谁在用 / 为什么现在没有可判定的消费者」，否则等于把断言改松。
}
{
  let libFiles = []
  try {
    libFiles = readdirSync(PUBLIC_LIB).filter((f) => f.endsWith('.mjs')).sort()
  } catch { /* scripts/lib 缺席：由 3a 的可解析面兜底，不在此处判红 */ }
  if (libFiles.length > 0) {
    // 扫描面：scripts/ 全树（排除 lib 自身与 tests/，tests 是模块的测试面不是消费者面）。
    const consumers = []
    const collect = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const p = join(dir, entry.name)
        if (entry.isDirectory()) { if (p !== PUBLIC_LIB && entry.name !== 'tests') collect(p); continue }
        if (entry.isFile() && entry.name.endsWith('.mjs')) consumers.push(p)
      }
    }
    collect(join(ROOT, 'scripts'))
    const texts = consumers.map((p) => ({ p, lines: readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n') }))
    const orphans = []
    for (const f of libFiles) {
      if (LIB_NO_CONSUMER_ALLOW[f] !== undefined) continue
      const base = f.replace(/\.mjs$/, '')
      // 判定：模块名必须出现在**非注释**代码行里，形如 lib/<base>.mjs。两侧真实用法各一：
      //   import { TAR } from './lib/shell.mjs'          （import 形态）
      //   const CAP_MODULE = 'scripts/lib/shell.mjs'     （断言形态，check-build-parallel-cap）
      // 前置字符限定为行首 / ' " ` ( 或 /——避免把 my-lib/x.mjs 这类子串误判成消费者（松断言）。
      const needle = 'lib/' + base + '.mjs'
      const refHit = (line) => {
        let i = line.indexOf(needle)
        while (i >= 0) {
          const prev = i === 0 ? '' : line[i - 1]
          if (prev === '' || prev === '/' || prev === "'" || prev === '"' || prev === '`' || prev === '(') return true
          i = line.indexOf(needle, i + 1)
        }
        return false
      }
      const hit = texts.some(({ lines }) => lines.some((l) => {
        const t = l.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false   // 注释不算消费者
        return refHit(l)
      }))
      if (!hit) orphans.push(f)
    }
    check('scripts/lib 公共模块均有真实消费者（' + String(libFiles.length) + ' 个模块，豁免 '
      + String(Object.keys(LIB_NO_CONSUMER_ALLOW).length) + ' 个）', orphans.length === 0,
      '零消费者（死基础设施；要么接线，要么按退役流程删除并解除镜像面注册）: ['
      + orphans.join(', ') + ']　处置先例（退役：删模块 + 解注册镜像面）见 docs/0.14.8-DELIVERY-PLAN-2026-10-14.md §2.2')
  }
}

// ── 3a-2. 下沉门的接管方断言（G.3，0.14.2-fx-2）─────────────────────────────
// 移出发布链 --run 段的门禁**必须**在其声明的 sink 里被真实调用，否则就是「防线静默消失」。
// 这是下沉动作的安全绳：任何 releaseSink:false 项若没人接管，本断言立刻判红。
//
// 【协调仓布局降级（CI 实修，PR #68 事故）】本断言第一版漏了布局降级：协调仓是**独立布局**，
// `dsh-mobile-apk/` 是独立 git 仓且在协调仓被 gitignore ⇒ 协调仓 CI 检出里没有 apk 树，而
// apk-ci / cloud-chain 两类 sink 的证据**只在 apk 仓里**。第一版直接硬判红（CI 三条 FAIL）。
// 正确纪律与上面 `ci-apk` 位置断言完全一致：
//   · apk 树不在场 ⇒ **显式 SKIP 并计数**（可见、不冒充绿）；
//   · **绝不**回落到协调仓自己的同名文件去「找到」调用点——那是自我循环，断言会恒真、失去判别力
//     （协调仓的 workflow 满足不了「apk 侧 CI 接管」这个命题）。
// apk 树在场时（本地 / apk 自包含布局 / apk 仓 CI）断言**保持全判别力**，会真的判红。
{
  for (const g of RELEASE_EXCLUDED) {
    if (!g.sink || !SINK_KINDS[g.sink]) {
      check('下沉门有合法接管方: ' + g.script, false, 'sink 字段缺失或未知: ' + String(g.sink))
      continue
    }
    const kind = SINK_KINDS[g.sink]
    // 需要 apk 树的 sink：apk 树不在场 ⇒ 降级 SKIP（不得回落、不得判红）。
    if (kind.needsApkTree && !apkTreePresent) {
      skipStatic('下沉门接管方断言: ' + g.script + ' @ ' + g.sink,
        '协调仓布局下 apk 树不在场（' + rel(APK_TREE) + ' 无 apk 仓）——该 sink 的证据只在 apk 仓里；'
        + '不在协调仓内回落取证（自我循环），由 apk 仓 CI/链自检')
      continue
    }
    // 解析 sink 文件：apk 侧一类**一律从 APK_TREE 出发**（不经过 resolveRel 的跨布局回落）。
    const sinkPath = kind.apkSide ? join(APK_TREE, kind.rel) : join(ROOT, kind.rel)
    if (!existsSync(sinkPath)) {
      // 契约要求在场的文件却缺席 ⇒ 判红（这不是布局降级，是真缺口）。
      check('下沉门接管方文件在场: ' + g.script + ' @ ' + g.sink, false,
        '缺文件: ' + rel(sinkPath) + '（apkTreePresent=' + apkTreePresent + '）')
      continue
    }
    const text = readFileSync(sinkPath, 'utf8')
    // 接管方必须真的点名这条门禁（CI 里是 `node scripts/check-x.mjs`；链里是 gate('check-x.mjs')）
    check('下沉门被接管方调用: ' + g.script + ' @ ' + g.sink, text.includes(g.script),
      '在 ' + rel(sinkPath) + ' 中找不到 ' + g.script + ' —— 移出发布链却无人接管 = 防线静默消失')
  }
}

// ── 3b. 两份编排器门禁集差集 = 0（0.13.8-b ST-06 / F-ENV-04 ④）────────────────
// 本地链（PowerShell）与云端链（node）必须调用同一组门禁：任一链少一道 = 该路径缺防线。
const parseGateSetFromPs1 = (text) => new Set(
  [...text.matchAll(/scripts\\(check-[a-z0-9-]+\.mjs|elf-check\.mjs)/g)].map((m) => m[1]),
)
const parseGateSetFromMjs = (text) => {
  const i = text.indexOf('const GATE_SCRIPTS = [')
  if (i < 0) return null
  const j = text.indexOf(']', i)
  return new Set([...text.slice(i, j).matchAll(/'([a-z0-9-]+\.mjs)'/g)].map((m) => m[1]))
}
const mjsRel = resolveRel('dsh-mobile-apk/scripts/build-apk.mjs')
const mjsText = mjsRel ? readFileSync(join(ROOT, mjsRel), 'utf8') : null
const ps1Gates = parseGateSetFromPs1(buildPs1)
const mjsGates = mjsText ? parseGateSetFromMjs(mjsText) : null
if (!mjsGates) {
  check('云端编排器门禁集可解析（dsh-mobile-apk/scripts/build-apk.mjs 的 GATE_SCRIPTS）', false,
    mjsRel ? 'GATE_SCRIPTS 数组缺席' : '文件在两仓布局下均未命中')
} else {
  const onlyPs1 = [...ps1Gates].filter((g) => !mjsGates.has(g)).sort()
  const onlyMjs = [...mjsGates].filter((g) => !ps1Gates.has(g)).sort()
  check('两份编排器门禁集差集 = 0（本地链 ' + ps1Gates.size + ' 项 / 云端链 ' + mjsGates.size + ' 项）',
    onlyPs1.length === 0 && onlyMjs.length === 0,
    '仅本地链: [' + onlyPs1.join(', ') + ']；仅云端链: [' + onlyMjs.join(', ') + ']')
}

if (!RUN) {
  if (failures.length > 0) {
    console.error('CHECK-RELEASE-GATES FAILED（' + failures.length + ' 项接线缺口）：' + failures.join('；'))
    process.exit(1)
  }
  console.log('CHECK-RELEASE-GATES PASSED（静态接线断言；声明门禁集 ' + ALL_GATES.length + ' 项）')
  process.exit(0)
}

// ── 4. --run：顺序执行声明门禁集（发布链唯一入口；失败即中止）────────────────
if (failures.length > 0) {
  console.error('CHECK-RELEASE-GATES FAILED（接线缺口先修）：' + failures.join('；'))
  process.exit(1)
}
const STRICT = argv.includes('--require')
const snapshotDir = argOf('snapshot-dir')
const abis = ['arm64', 'x86_64'].filter((abi) => {
  if (snapshotDir) return existsSync(join(resolve(snapshotDir), 'snapshot-' + abi + '.tar.xz'))
  return existsSync(join(ROOT, '.deploy-tmp', 'snapshot-013', abi, 'snapshot.tar.xz'))
})
console.log('发布门禁集（--run 段 ' + RELEASE_GATES.length + ' 项；声明 ' + GATES.length + ' 项，下沉 ' + RELEASE_EXCLUDED.length + ' 项）：' + RELEASE_GATES.join(' → '))
for (const g of RELEASE_EXCLUDED) {
  console.log('下沉(不进发布 --run)  ' + g.script + ' -> ' + g.sink + '（输入非发布产物；由接管方真检，见 3a-2 断言）')
}
console.log('快照面：' + (abis.length > 0 ? abis.join(', ') : '（无：snapshot-fingerprint/runtime-assets 将按 --require 失败）'))
let ran = 0
// SKIP 合计（ST-31 / ST-16）：逐门禁捕获输出并解析 SKIP=n；发布链（--require）要求合计 = 0。
let skipTotal = 0
const perGateSkips = {}
/**
 * 逐门禁耗时记账（0.14.8 门禁优化 P1）。
 *
 * 为什么需要它：在本次改动之前，全仓关于「门禁多慢」的唯一事实是 2026-09-26 的一次性测量
 * （发布链 --run 冷跑 322.2s、12 条产物门禁单跑 411.5s）。那组数字既过期（两个月），又是在
 * 不同机器负载与不同快照下测的，**无法回归**——任何「优化后更快」的说法都只能靠一次性探针。
 *
 * 判据口径（避免把测量本身变成噪声源）：
 *   · 只计**墙钟**（wall-clock），不做 CPU 时间——门禁的痛点就是等待，不是算力；
 *   · 每条门禁**单独计时**（含其子进程 spawn 与全部输出）；
 *   · 同时记录该门禁本次的 stdout+stderr 字节数——「耗时 / 产出」比才是优化的判据，
 *     单独看耗时会把「本来就该慢的活」误判成浪费（实测 check-snapshot-secrets 67.7s 只产出 56 B）。
 *   · 落盘 JSON 供回归对比，**不参与任何判据**（不设耗时阈值：阈值会把慢机器变成假红）。
 */
const gateTimings = []
const runGate = (argvFor, label) => {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, argvFor, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  const elapsedMs = Date.now() - t0
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  const m = /SKIP=(\d+)/.exec((r.stdout || '') + (r.stderr || ''))
  perGateSkips[label] = m !== null ? Number(m[1]) : 0
  if (m) skipTotal += Number(m[1])
  const outBytes = Buffer.byteLength(r.stdout || '', 'utf8') + Buffer.byteLength(r.stderr || '', 'utf8')
  gateTimings.push({ gate: label, ms: elapsedMs, exit: r.status, outBytes })
  console.log('  [timing] ' + label.padEnd(46) + String(elapsedMs).padStart(8) + ' ms   out=' + outBytes + ' B')
  if (r.status !== 0) {
    console.error('CHECK-RELEASE-GATES FAILED：' + label + ' 退出码 ' + r.status + '，中止组装')
    writeGateTimings('failed')
    process.exit(1)
  }
}
/**
 * 落盘逐门禁耗时（供回归对比）。
 * 位置可用 DSH_GATE_TIMINGS_OUT 覆盖；缺省写到 .deploy-tmp/gate-timings/<时间戳>.json。
 * 落盘失败**不影响判据**（只打印 WARN）——记账是观测面，不得成为新的失败点。
 */
function writeGateTimings(outcome) {
  try {
    const out = process.env.DSH_GATE_TIMINGS_OUT
      || join(ROOT, '.deploy-tmp', 'gate-timings', new Date().toISOString().replace(/[:.]/g, '-') + '.json')
    mkdirSync(dirname(out), { recursive: true })
    const totalMs = gateTimings.reduce((s, g) => s + g.ms, 0)
    const totalOut = gateTimings.reduce((s, g) => s + g.outBytes, 0)
    writeFileSync(out, JSON.stringify({
      at: new Date().toISOString(), outcome, strict: STRICT, snapshotDir: snapshotDir ?? null,
      abis, totalMs, totalOutBytes: totalOut, gates: gateTimings,
    }, null, 2))
    console.log('  [timing] 合计 ' + totalMs + ' ms / ' + gateTimings.length + ' 条门禁，输出 ' + totalOut + ' B -> ' + relative(ROOT, out).replace(/\\/g, '/'))
  } catch (e) {
    console.log('  [timing] WARN 耗时记账落盘失败（不影响判据）：' + String(e && e.message).slice(0, 120))
  }
}
const snapshotTar = (abi) => join(resolve(snapshotDir), 'snapshot-' + abi + '.tar.xz')
for (const gate of RELEASE_GATES) {
  const argvFor = [join('scripts', gate)]
  // 严格档（发布链 --require）：凡支持 --require 的门禁一律传，SKIP 即失败（ST-31：发布链 SKIP=0）。
  // check-tool-output-schema 自 0.14.1 W1 起支持 --require：宿主缺 peer 依赖（净检出无 node_modules 的
  // 必然后果）在严格档下判红——此前该情形是**未捕获异常直接终止进程**，聚合链在第 6 条就死，
  // 后面 20 多条一条没跑，而没有任何一层把它报成失败。
  if (STRICT && ['check-snapshot-fingerprint.mjs', 'check-perf-instrumentation.mjs', 'check-snapshot-secrets.mjs', 'check-contract.mjs', 'check-tool-output-schema.mjs', 'check-dead-tokens.mjs'].includes(gate)) argvFor.push('--require')
  // 冷启动预算（0.14.1 块F P0-2）：真检需要**设备原始产物**（boot-segments.log + 引擎探针输出），
  // 冷启动预算（0.14.1 块F P0-2）：**不再强制 --self-test**。默认档会先找设备真产物
  // （`--segments/--probe` > `DSH_BOOT_SEGMENTS`/`DSH_BOOT_PROBE` > `.deploy-tmp/boot-budget/`）：
  // 有产物就**真检**（超预算 exit 1），无产物才明确标 `SKIP(real-data)` 并退 --self-test 自证
  // （绝不冒充绿）。四条调用点已同改为默认档，本聚合入口与它们口径一致。
  // 注意：这里**不自动加 `--require-real`**——构建机/CI 无设备，强加会让发布链必然失败；
  // 「发布前必须在设备上真检」由设备门禁显式跑 `--require-real`（无产物即判红）承担。
  // 内嵌快照可解压门禁（0.14.7 / task-9 D-4）：输入是 **APK 树内嵌** assets/snapshot.tar.xz。
  // 发布链这里有一个时序陷阱：2f 段（--run --require）跑在「注入后快照」上，而内嵌资产要等
  // build-apk-engine.mjs assemble 复制进去才有；本聚合入口若在那段跑，验的是**上一次**构建的残留。
  // 故：严格档显式要求内嵌资产在场（缺席即判红，不得以 SKIP 结案）；非严格档按其自身计数 SKIP。
  if (gate === 'check-boot-budget.mjs') {
    runGate([join('scripts', gate)], gate + '(real-or-skip)')
    ran += 1
    console.log('PASS  ' + gate + '（真实数据来源：设备产物优先真检；无产物则 SKIP + self-test 自证，不算绿。'
      + '发布前设备门禁请显式跑 --require-real）')
    continue
  }
  // 浏览器语法下限（0.14.1 块C）：主模式 --scan 需要一个构建树/快照；有快照面就真扫，没有就退到
  // --self-test（四向自证：反向必红 / 正向必绿 / 载荷不触发 / 工具链在场）——**不得静默跳过**。
  if (gate === 'check-browser-syntax-floor.mjs') {
    if (snapshotDir && abis.length > 0) runGate([join('scripts', gate), '--scan', snapshotTar(abis[0])], gate + '(scan ' + abis[0] + ')')
    else runGate([join('scripts', gate), '--self-test'], gate + '(self-test)')
    ran += 1
    console.log('PASS  ' + gate + '（' + (snapshotDir && abis.length > 0 ? 'scan ' + abis[0] : '--self-test 四向自证') + '）')
    continue
  }
  if (gate === 'check-runtime-assets.mjs') {
    if (snapshotDir && abis.length > 0) {
      for (const abi of abis) runGate([join('scripts', gate), abi, '--require', '--snapshot', snapshotTar(abi)], gate + '(' + abi + ')')
      ran += 1
      console.log('PASS  ' + gate + '（' + abis.join(', ') + '）')
      continue
    }
    argvFor.push(...(abis.length > 0 ? [abis[0]] : ['arm64']), ...(STRICT ? ['--require'] : []))
  }
  if (gate === 'check-snapshot-secrets.mjs') {
    if (snapshotDir && abis.length > 0) {
      for (const abi of abis) runGate([join('scripts', gate), snapshotTar(abi), ...(STRICT ? ['--require'] : [])], gate + '(' + abi + ')')
      ran += 1
      console.log('PASS  ' + gate + '（' + abis.join(', ') + '）')
      continue
    }
    if (STRICT) {
      console.error('CHECK-RELEASE-GATES FAILED：' + gate + ' 需要 --snapshot-dir 的快照面，严格发布档不得只验空集')
      process.exit(1)
    }
    // 【0.14.1 W1】无快照面的非严格档：**计数的 SKIP 并继续**，而不是把子门禁当无参调用（它按用法错误
    // exit 2）——那会让整条链停在这里，后面 20 多条一条不跑（与「插件 peer 依赖崩在入口」同一形态：
    // 失败点发生在**聚合器**，而不是被判据拒绝）。SKIP 已计数、发布链 --require 仍判红，不构成掩盖。
    skipTotal += 1
    console.log('SKIP(#' + skipTotal + ')  ' + gate + '：无快照面（--snapshot-dir 未给且 .deploy-tmp/snapshot-013 无 tar）；'
      + '本档不给快照，机密门禁无从真检——发布链 --require 下此项判红')
    ran += 1
    continue
  }
  if (gate === 'check-api-route-auth.mjs') {
    if (snapshotDir && abis.length > 0) {
      // 0.14.2 D2：本门禁自本轮起含「上游路由面审计」独立段，它在**上游树缺席**时按 SKIP 计数
      // 结案（apk 自包含树不含 dsh/）。发布链必须真检，故严格档把 --require 一并传下去：
      // 否则发布链在有快照面时走这一支、永远收不到 --require，上游面缺席也能以 SKIP 过关
      // ——「发布环境必须显式判定上游面」这条就只写在注释里，没有执行者。
      for (const abi of abis) runGate([join('scripts', gate), '--snapshot', snapshotTar(abi), ...(STRICT ? ['--require'] : [])], gate + '(' + abi + ')')
      ran += 1
      console.log('PASS  ' + gate + '（' + abis.join(', ') + ' post-injection artifact）')
      continue
    }
    if (STRICT) {
      console.error('CHECK-RELEASE-GATES FAILED：' + gate + ' 需要 --snapshot-dir 的双 ABI 注入产物，严格发布档不得只验证源码')
      process.exit(1)
    }
  }
  // 需要「产物 tar」的门禁（P0 注入完整性 / 剥离清单后置断言）：发布链有快照面时按 ABI 跑；
  // 没有则计一条 SKIP —— 严格档随后判红（不得以 SKIP 结案）。
  if (['check-inject-completeness.mjs', 'check-strip-noop.mjs', 'check-combo-cache.mjs'].includes(gate)) {
    if (snapshotDir && abis.length > 0) {
      for (const abi of abis) runGate([join('scripts', gate), snapshotTar(abi)], gate + '(' + abi + ')')
      ran += 1
      console.log('PASS  ' + gate + '（' + abis.join(', ') + '）')
      continue
    }
    skipTotal += 1
    console.log('SKIP(#' + skipTotal + ')  ' + gate + '：发布链未提供快照面（--snapshot-dir 下无 tar）')
    ran += 1
    continue
  }
  runGate(argvFor, gate)
  ran += 1
  console.log('PASS  ' + gate)
}
// 具名声明（2026-09-21）：发布链上并非所有 SKIP 都是「取不到判据」——有些是该输入在发布链时序里
// 必然不在场（例：注入阶段才打的探针补丁）。这类必须**逐门禁具名申报理由**（scripts/gate-skips-declared.json），
// 未声明或超额的 SKIP 照旧判红；已声明的不算绿，只是不再让整条链停在同一个结构性缺口上。
const declaredPath = join(ROOT, 'scripts', 'gate-skips-declared.json')
const declared = existsSync(declaredPath) ? (JSON.parse(readFileSync(declaredPath, 'utf8')).gates ?? {}) : {}
let overBudget = []
for (const [gate, info] of Object.entries(perGateSkips)) {
  // 标签可能带模式后缀（例：`check-boot-budget.mjs(real-or-skip)`）——声明表按脚本名归一化匹配。
  const d = declared[gate] ?? declared[gate.replace(/\(.*\)$/, '')]
  if (d === undefined) { if (info > 0) overBudget.push(gate + '=' + info + '（未声明）'); continue }
  if (info > (d.max ?? 0)) overBudget.push(gate + '=' + info + ' > 声明 ' + (d.max ?? 0))
  else if (info > 0) console.log('DECLARED-SKIP  ' + gate + '：' + info + ' 处（已声明理由：' + String(d.why || '').slice(0, 80) + '…）')
}
console.log('SKIP=' + skipTotal + ' 合计' + (STRICT ? '（发布链：须全部具名声明）' : ''))
if (STRICT && overBudget.length > 0) {
  console.error('CHECK-RELEASE-GATES FAILED：SKIP 未声明或超额 -> ' + overBudget.join('; '))
  process.exit(1)
}
// （原「发布链要求 SKIP=0」的总量检查已由上面的**具名声明**取代：ST-31/ST-16 的意图是「不得以 SKIP 结案」，
//  具名申报同样满足——未声明或超额的 SKIP 一律判红，已声明的必须写明理由与上限。）
// G.3：报「本次 --run 段实际执行数 / 该段应有的项数」，并显式列出下沉项——
// 用 ALL_GATES.length 作分母会把已下沉的门禁算成「没执行」，读日志的人会误判成漏跑。
console.log('CHECK-RELEASE-GATES --run PASSED（已执行 ' + ran + '/' + RELEASE_GATES.length + ' 项（发布段），SKIP=' + skipTotal
  + '；另有 ' + RELEASE_EXCLUDED.length + ' 项已下沉、不在本段：' + RELEASE_EXCLUDED.map((g) => g.script + '->' + g.sink).join(', ') + '）')
// 0.14.8 P1：成功路径也落盘耗时（失败路径已在 runGate 内落盘）。
writeGateTimings('passed')

