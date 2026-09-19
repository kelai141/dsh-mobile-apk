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
// 退出码：0 = 通过；1 = 接线缺口 / 门禁失败 / 树定位失败。
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const RUN = argv.includes('--run')
const argOf = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

/** 本迭代要求的门禁集合（唯一声明处）。needsSnapshot=true 的门禁由构建/发布链调用，CI 不跑。 */
const GATES = [
  { script: 'check-patch-mirror.mjs', ci: true, needsSnapshot: false },
  { script: 'check-manifest-hardening.mjs', ci: true, needsSnapshot: false },
  { script: 'check-bounded-io.mjs', ci: true, needsSnapshot: false },
  // #222：所有 mobile-owned /api exact/prefix 路由必须在登记表中，并有本地 auth guard 或窄公开白名单。
  { script: 'check-api-route-auth.mjs', ci: true, needsSnapshot: false },
  { script: 'check-snapshot-fingerprint.mjs', ci: true, needsSnapshot: true },
  { script: 'check-tool-output-schema.mjs', ci: true, needsSnapshot: false },
  { script: 'check-protocol-v2.mjs', ci: true, needsSnapshot: false },
  { script: 'check-control-ops.mjs', ci: true, needsSnapshot: false },
  { script: 'check-runtime-assets.mjs', ci: false, needsSnapshot: true },
  // 机密门禁（review C3）：归档不可读/成员为空 = 硬失败（旧实现垃圾文件也 PASS 的假绿）；严格档 --require。
  { script: 'check-snapshot-secrets.mjs', ci: false, needsSnapshot: true },
  // 适配层契约（review C6）：上游 bundle 行引用 / 注入包构建产物 / 客户端槽位 / 版本钉台账。
  // 上游 `dsh/` 与基线 node_modules 是 gitignore 的本机只读产物——CI 与云端自包含树跑不全
  // （SKIP 计数），由两条构建链与发布链（--run --require，强制 SKIP=0）实际执行。
  { script: 'check-contract.mjs', ci: false, needsSnapshot: false },
  // 0.13.8-b B2（ST-25/26/31 + §7.2 度量）：制度性门禁与性能度量入口一并进声明集合，
  // 由本聚合入口保证两条链 + 两仓 CI 都跑到（接线面只此一处）。
  { script: 'check-state-registry.mjs', ci: true, needsSnapshot: false },
  { script: 'check-bridge-symmetry.mjs', ci: true, needsSnapshot: false },
  { script: 'check-gate-skips.mjs', ci: true, needsSnapshot: false },
  { script: 'check-perf-instrumentation.mjs', ci: true, needsSnapshot: true },
  // 注入面成员完整性（P0：包内新增文件曾被静默丢弃 → ERR_MODULE_NOT_FOUND/引擎启动即死）：
  // 需要「注入后」tar，故 CI 不跑，由两条构建链在注入步骤之后调用 + 发布链按快照面跑。
  { script: 'check-inject-completeness.mjs', ci: false, needsSnapshot: true },
  // Kotlin 块注释嵌套静态检查（KDoc 里写 node_modules/** 会吞掉整个文件；dev-shell 实测）。
  { script: 'check-kotlin-comments.mjs', ci: true, needsSnapshot: false },
  // 构建链中止语义（任一 ABI 被拒 = 整链非 0；0.13.8-b 实锤：arm64 被拒后仍 exit 0 交付单 ABI 产物）。
  { script: 'check-build-chain-abort.mjs', ci: true, needsSnapshot: false },
  // 剥离清单后置断言（ST-16）：清单项在产物里必须不存在 + 反 no-op（基座命中的必须消失）。
  { script: 'check-strip-noop.mjs', ci: false, needsSnapshot: true },
  // combo 缓存覆盖（0.14.0 启动性能 P1-2 / 引擎树补丁 combo-cache-A3）：注入后快照的每条
  // client.js 必须有 sha256 命中的缓存条目，否则运行期回退现场生成会吞掉全部启动收益。
  { script: 'check-combo-cache.mjs', ci: false, needsSnapshot: true },
  // 模型面工具 wire 预算（0.14.0 §4.1 渐进披露）：注册集（解锁后上限）+ 初始可见集（模型第一眼）
  // 双口径。掩蔽组名单从 capability-gate 实现导出，门禁不另写一份（防清单漂移假绿）。
  // 离线可跑（真跑各插件 apply()，只需 plugins/*/lib 构建产物）-> CI 与两条链都跑。
  { script: 'check-tool-surface-budget.mjs', ci: true, needsSnapshot: false },
  // 插件单测（0.14.1 §1.1b 决策 1 / §2.4 前置项 1）：该脚本自 0.14.0 起就存在，却**从未被任何
  // 路径调用**（不在 GATES、不在接线断言、两条链与两仓 CI 均无引用）——7 个插件的 34 个测试文件
  // 全部没人跑，「已新增该门禁」的声明与事实不符。此处接入声明集合即同时被两条构建链与两仓 CI
  // 覆盖（check-gate-skips.mjs 会断言声明集合被两条链逐项调用）。离线可跑，只需 plugins/*/lib。
  { script: 'check-plugin-tests.mjs', ci: true, needsSnapshot: false },
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
  { script: 'check-boot-budget.mjs', ci: true, needsSnapshot: false },
  // 快照构建器**产出面**结构断言（0.14.1 P0 反回归）：0849579 曾把 §8 归档整段删掉，构建器跑到
  // 瘦身就 exit 0、**从不产出 tar**，而打包链只判「tar 是否存在」→ 静默复用陈旧快照、全链零报错。
  // 判据 = 产出面构造在场 + slim.json 配置键消费者闭合（死键即某步被删的第一手信号）+ 与打包链路径同源。
  // 离线可跑（只读源码与配置），故 CI 与两条链都跑。
  { script: 'check-snapshot-builder-output.mjs', ci: true, needsSnapshot: false },
  // 浏览器语法下限（0.14.1 块C G-1）：老设备（WebView <94）白屏的产物级真因——入口 chunk 带
  // ES2022 类静态块 `static{}`，解析期语法错误 → 整模块不执行 → 纯白无字。判据为**真实解析器 AST**
  // + esbuild 双 arm 逐字节差分（禁 grep 文本在场），自带四向自证。真检需快照/构建树，CI 跑 --self-test。
  { script: 'check-browser-syntax-floor.mjs', ci: true, needsSnapshot: true },
  // 构建并发上限（0.14.1 用户拍板的系统级约束）：构建期压缩/解压不得吃满全部逻辑核（原为 `xz -T0`
  // = 16 线程），否则开发机被撑满 → MuMu 模拟器卡顿/系统不稳（「模拟器优先」是铁律 2，两者常并行）。
  // 判据 = 上限来自单一常量且默认 8 + 构建链真的消费它 + 设备侧同受限 + 注释不自伤。离线可跑。
  { script: 'check-build-parallel-cap.mjs', ci: true, needsSnapshot: false },
  // Kotlin 单测数量反回归（0.14.1 P0）：审计发现两处同源缺口——① CI 从不跑 Kotlin 单测
  // （pr-gate 只跑 compileDebugKotlin）→ 417 例契约断言只在本地手动跑过；② 即使跑起来，
  // 只按退出码判也分不清「全绿」与「一个用例都没跑」（测试类被删/改名/漏编译时 exit 仍 0）。
  // 本门禁逐类比对基线（只许升）+ 断言无缺席 + 结果新鲜，抓「防线被删却仍然绿」。
  // ci:false 是刻意的：云端 CI 无 gradle 产物环境，故本项由本地链/发布链跑；
  // 无结果时显式 SKIP(#1) 计数（不计入绿），绝不冒充通过。
  { script: 'check-kotlin-test-count.mjs', ci: false, needsSnapshot: false },
]
const CI_GATES = GATES.filter((g) => g.ci).map((g) => g.script)
const ALL_GATES = GATES.map((g) => g.script)

if (argv.includes('--list')) {
  for (const g of GATES) {
    // 真检档标注：让「怎么真验」有唯一入口，不靠人记（F 门禁的真数据路径见文首注释与详档 §5.1）。
    const note = g.script === 'check-boot-budget.mjs' ? '  [真检需 --require-real + 设备产物；见详档 §5.1]' : ''
    console.log(g.script.padEnd(34) + (g.ci ? 'CI+构建' : '仅构建/发布') + (g.needsSnapshot ? ' 需要快照' : '') + note)
  }
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
  { id: 'ci-coord', file: '.github/workflows/pr-gate.yml', gates: CI_GATES, kind: 'gate-names' },
  { id: 'ci-apk', file: 'dsh-mobile-apk/.github/workflows/pr-gate.yml', gates: CI_GATES, kind: 'gate-names' },
  { id: 'release-coord', file: 'scripts/build-release.ps1', gates: ALL_GATES, kind: 'aggregator' },
  { id: 'release-apk', file: 'dsh-mobile-apk/scripts/build-release.ps1', gates: ALL_GATES, kind: 'aggregator' },
]
for (const pos of POSITIONS) {
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

// ── 3. 两树同版（同源文件逐字节由 check-patch-mirror 守；此处守本次新增/改动的接线文件）──
for (const f of ['scripts/build-release.ps1', 'scripts/build-apk-013.ps1']) {
  const a = join(ROOT, f)
  const b = join(ROOT, 'dsh-mobile-apk', f)
  if (!existsSync(b)) { check('两树同版: ' + f, true, '（对端缺席，跳过）'); continue }
  const same = readFileSync(a).equals(readFileSync(b))
  check('两树同版: ' + f, same, '逐字节不一致（autocrlf 噪声也会计入——请同步镜像）')
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
console.log('发布门禁集：' + ALL_GATES.join(' → '))
console.log('快照面：' + (abis.length > 0 ? abis.join(', ') : '（无：snapshot-fingerprint/runtime-assets 将按 --require 失败）'))
let ran = 0
// SKIP 合计（ST-31 / ST-16）：逐门禁捕获输出并解析 SKIP=n；发布链（--require）要求合计 = 0。
let skipTotal = 0
const runGate = (argvFor, label) => {
  const r = spawnSync(process.execPath, argvFor, { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  const m = /SKIP=(\d+)/.exec((r.stdout || '') + (r.stderr || ''))
  if (m) skipTotal += Number(m[1])
  if (r.status !== 0) {
    console.error('CHECK-RELEASE-GATES FAILED：' + label + ' 退出码 ' + r.status + '，中止组装')
    process.exit(1)
  }
}
const snapshotTar = (abi) => join(resolve(snapshotDir), 'snapshot-' + abi + '.tar.xz')
for (const gate of ALL_GATES) {
  const argvFor = [join('scripts', gate)]
  // 严格档（发布链 --require）：凡支持 --require 的门禁一律传，SKIP 即失败（ST-31：发布链 SKIP=0）。
  if (STRICT && ['check-snapshot-fingerprint.mjs', 'check-perf-instrumentation.mjs', 'check-snapshot-secrets.mjs', 'check-contract.mjs'].includes(gate)) argvFor.push('--require')
  // 冷启动预算（0.14.1 块F P0-2）：真检需要**设备原始产物**（boot-segments.log + 引擎探针输出），
  // 冷启动预算（0.14.1 块F P0-2）：**不再强制 --self-test**。默认档会先找设备真产物
  // （`--segments/--probe` > `DSH_BOOT_SEGMENTS`/`DSH_BOOT_PROBE` > `.deploy-tmp/boot-budget/`）：
  // 有产物就**真检**（超预算 exit 1），无产物才明确标 `SKIP(real-data)` 并退 --self-test 自证
  // （绝不冒充绿）。四条调用点已同改为默认档，本聚合入口与它们口径一致。
  // 注意：这里**不自动加 `--require-real`**——构建机/CI 无设备，强加会让发布链必然失败；
  // 「发布前必须在设备上真检」由设备门禁显式跑 `--require-real`（无产物即判红）承担。
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
  }
  if (gate === 'check-api-route-auth.mjs') {
    if (snapshotDir && abis.length > 0) {
      for (const abi of abis) runGate([join('scripts', gate), '--snapshot', snapshotTar(abi)], gate + '(' + abi + ')')
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
console.log('SKIP=' + skipTotal + ' 合计' + (STRICT ? '（发布链要求 0）' : ''))
if (STRICT && skipTotal > 0) {
  console.error('CHECK-RELEASE-GATES FAILED：发布链要求 SKIP=0，实测 ' + skipTotal + ' —— 不得以 SKIP 结案（ST-31/ST-16）')
  process.exit(1)
}
console.log('CHECK-RELEASE-GATES --run PASSED（已执行 ' + ran + '/' + ALL_GATES.length + ' 项，SKIP=' + skipTotal + '）')
