#!/usr/bin/env node
// check-patch-mirror.mjs — 两树补丁镜像一致性门禁（0.13.8 PR-A1；apk issue #171 残留防线）
//
// 背景：scripts/patches/** 是双仓镜像面（协调仓 = 权威源；dsh-mobile-apk/scripts/patches =
// 云端自包含构建 .github/workflows/build-apk.yml 检出的副本）。单边演进 = 云端构建的快照
// 静默缺引擎树补丁（幽灵缺陷：编译与门禁全绿但功能缺失，apk #171 的实锤成因）。
//
// 断言两层：
//   A 自包含一致性（任一仓单独可跑）：registry.json 的补丁 id 集合 == apply-patches.mjs
//     IMPLS 的实现 id 集合（双向），防「登记了没实现 / 实现了没登记」。
//   B 镜像一致性（对端树在场时）：registry.json / apply-patches.mjs / README.md 逐字节一致
//     （CRLF 归一后比对）；tests/ 递归文件清单一致，共有文件逐字节一致。
//
// 对端树定位顺序：--peer <dir> > 环境变量 DSH_MIRROR_PEER > <root>/dsh-mobile-apk >
// <root>/..（该目录含 scripts/patches 即认）。对端缺席时镜像层跳过并提示（CI 单仓
// checkout 场景应显式 checkout 对端后运行，见两仓 pr-gate.yml）。
//
// 2026-10-28 政策：构建 / 门禁 / 校验脚本以 dsh-mobile-apk 仓为准，本仓只留历史副本。
// 因此 `scripts/**` 的脚本条目不再逐字节比对（差异属正常）；真正的镜像面仍是
// `scripts/patches/**`（本文件 A/B 两层照旧）与插件 / 子仓镜像目录。
//
// 用法：node scripts/check-patch-mirror.mjs [--self] [--peer <dir>] [--self-test]
// 退出码：0 = 全部通过；1 = 失败（构建链与 CI 以此拒打包/拒合并）。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const peerArgIdx = argv.indexOf('--peer')
const PEER_OVERRIDE = peerArgIdx >= 0 ? argv[peerArgIdx + 1] : process.env.DSH_MIRROR_PEER
const SELF_ONLY = argv.includes('--self')
// review C7：CI 跨仓检出必须硬失败——对端缺席不得以 SKIP 结案（否则检出步骤一旦被软化，
// 镜像防线静默消失）。CI / 发布链一律带 --require-peer。
const REQUIRE_PEER = argv.includes('--require-peer')

// L1 门禁自证入口：政策正控（脚本差异正常）与负控（patch / plugin 漂移必须判红）
// 都在配套的 check-patch-mirror.test.mjs 里。这里只做转接，避免把判据复制成第二份。
if (argv.includes('--self-test')) {
  const result = spawnSync(process.execPath, ['--test', join(HERE, 'check-patch-mirror.test.mjs')], { stdio: 'inherit' })
  process.exit(result.status === 0 ? 0 : 1)
}

const failures = []
// ST-31：任何 SKIP 必须计数（发布链要求 SKIP=0；本门禁的 SKIP 只有一种合法形态——
// 单仓 checkout 无对端 / 对端确无该镜像文件）。
let skipped = 0
const skip = (msg) => {
  skipped += 1
  console.log('SKIP(#' + skipped + ')  ' + msg)
}
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
/**
 * 本仓 .gitignore 是否忽略了这个镜像面路径——用于区分「本仓缺席但按设计如此」与「条目失效」。
 *
 * 背景（issue #156 C 组，2026-10-27）：`dsh-shell-termux` / `dsh-host-web-compat` /
 * `dsh-client-ui-responsive` 在协调仓是 **由本地 Junction（Windows）/ 符号链接提供的镜像面**，
 * 路径本身写进协调仓 .gitignore。正常本地布局下它们天然在场且天然同源；但在**裸检出**
 * （干净 clone / git worktree / CI 未检出对端）下它们必然缺席。
 *
 * 修复前：这种缺席被判 FAILED，导致「用干净检出跑 --require-peer」这个标准验证场景恒红，
 * 任何人做镜像体检都要先踩一次假红（本次诊断就踩了）。修复后：仅当
 *   ① 本仓路径确实不存在，**且**
 *   ② 该路径被本仓 .gitignore 忽略（说明缺席是按设计，不是条目写错），**且**
 *   ③ 对端确实带着这个路径（说明镜像面本身健康，只是本侧由链接提供）
 * 三条同时成立才记具名 SKIP。**任一条不成立仍然 FAILED**——目录存在但内容不同、
 * 对端也没有、或条目根本不在 gitignore 里（= MIRROR_TOP 条目确实失效），一律照旧判红。
 *
 * @param rel 镜像面相对路径（MIRROR_TOP 条目）。
 * @returns 该路径是否被本仓 .gitignore 忽略。
 */
function ignoredByOwnRepo(rel) {
  const gitignore = join(ROOT, '.gitignore')
  if (!existsSync(gitignore)) return false
  const target = rel.replace(/\\/g, '/').replace(/\/+$/, '')
  for (const rawLine of readFileSync(gitignore, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    // 只认「目录形态」的忽略规则：/name/ 或 /name 或 name/。其余（通配、反选）一律不认，
    // 宁可判红也不放过真漂移。
    const m = /^\/?([A-Za-z0-9._-]+)\/?$/.exec(line)
    if (m === null) continue
    if (m[1] === target) return true
  }
  return false
}

/** 比较结果：same = 原始字节一致；eol = 仅行尾差异（工作树 autocrlf 噪声，告警不拦）；
 *  content = 归一后仍不同（真实漂移，FAIL）。 */
const cmp = (a, b) => {
  const ba = readFileSync(a)
  const bb = readFileSync(b)
  if (ba.equals(bb)) return 'same'
  const norm = (buf) => Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
  return norm(ba).equals(norm(bb)) ? 'eol' : 'content'
}

// ── A 自包含一致性 ──────────────────────────────────────────────
const regPath = join(ROOT, 'scripts', 'patches', 'registry.json')
const implPath = join(ROOT, 'scripts', 'patches', 'apply-patches.mjs')
let regIds = []
let implIds = []
try {
  regIds = JSON.parse(readFileSync(regPath, 'utf8')).patches.map((p) => p.id)
} catch (e) {
  check('registry.json 可解析', false, String(e).slice(0, 200))
}
try {
  const src = readFileSync(implPath, 'utf8')
  implIds = [...src.matchAll(/^  '([^']+)':\s*\{/gm)].map((m) => m[1])
  check('apply-patches.mjs IMPLS 条目非空', implIds.length > 0, `解析到 ${implIds.length} 条`)
} catch (e) {
  check('apply-patches.mjs 可读', false, String(e).slice(0, 200))
}
if (regIds.length > 0 && implIds.length > 0) {
  const regSet = new Set(regIds)
  const implSet = new Set(implIds)
  const missingImpl = regIds.filter((id) => !implSet.has(id))
  const missingReg = implIds.filter((id) => !regSet.has(id))
  check('registry id 集合 == IMPLS id 集合',
    missingImpl.length === 0 && missingReg.length === 0,
    `登记缺实现: [${missingImpl.join(', ')}]；实现缺登记: [${missingReg.join(', ')}]`)
}

// ── B 镜像一致性 ────────────────────────────────────────────────
let peer = null
if (!SELF_ONLY) {
  const candidates = []
  if (PEER_OVERRIDE) candidates.push(PEER_OVERRIDE)
  candidates.push(join(ROOT, 'dsh-mobile-apk'))
  candidates.push(dirname(ROOT))
  for (const c of candidates) {
    if (c === ROOT) continue
    try {
      if (statSync(join(c, 'scripts', 'patches', 'registry.json')).isFile()) { peer = c; break }
    } catch { /* 下一候选 */ }
  }
}

if (!SELF_ONLY && !peer) {
  if (REQUIRE_PEER) {
    check('--require-peer：对端树必须在场（镜像比对不得以 SKIP 结案）', false,
      'CI 跨仓检出失败或未做——先修检出（PAT）再谈镜像防线')
  } else {
    skip('镜像层：对端树不在场（CI 单仓场景请 checkout 对端后运行，或传 --peer/--self）')
  }
}
if (peer) {
  console.log(`镜像对端: ${relative(dirname(ROOT), peer) || peer}`)
  const eolWarns = []
  const MIRROR_FILES = ['registry.json', 'apply-patches.mjs', 'README.md']
  for (const f of MIRROR_FILES) {
    const mine = join(ROOT, 'scripts', 'patches', f)
    const theirs = join(peer, 'scripts', 'patches', f)
    try {
      const r = cmp(mine, theirs)
      check(`镜像一致: scripts/patches/${f}`, r !== 'content', r === 'eol' ? '仅行尾差异（见告警）' : undefined)
      if (r === 'eol') eolWarns.push(`scripts/patches/${f}`)
    } catch (e) {
      check(`镜像一致: scripts/patches/${f}`, false, String(e).slice(0, 200))
    }
  }
  // data/ 注入片段也是 scripts/patches/** 的权威源；逐递归清单和内容比对，避免新片段漏镜像。
  const walkFiles = (dir, prefix = '') => {
    const out = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) out.push(...walkFiles(full, rel))
      else out.push(rel)
    }
    return out
  }
  try {
    const mineData = walkFiles(join(ROOT, 'scripts', 'patches', 'data'))
    const peerData = walkFiles(join(peer, 'scripts', 'patches', 'data'))
    const onlyMine = mineData.filter((r) => !peerData.includes(r))
    const onlyPeer = peerData.filter((r) => !mineData.includes(r))
    check('data/ 文件清单一致', onlyMine.length === 0 && onlyPeer.length === 0,
      `本仓独有: [${onlyMine.join(', ')}]；对端独有: [${onlyPeer.join(', ')}]`)
    const bad = mineData.filter((r) => peerData.includes(r) && cmp(join(ROOT, 'scripts', 'patches', 'data', r), join(peer, 'scripts', 'patches', 'data', r)) === 'content')
    check('data/ 共有文件逐字节一致', bad.length === 0, `内容漂移: [${bad.join(', ')}]`)
  } catch (e) { check('data/ 目录可枚举', false, String(e).slice(0, 200)) }
  // tests/ 递归清单 + 共有文件逐字节
  // **递归**列清单：0.14.3 实锤——旧实现只列 tests/ 的一层，于是 `fixtures` 被当成一个dir 条目，
  // 里面的 31 个夹具目录从未参与比对。协调仓已把夹具换到 0.2.0-rc.2，APK 侧仍留着 0.1.7-rc.2 的旧夹具，
  // 本地镜像门禁却全绿，直到 APK CI 的 check-patch-fixtures 判红 93 项才暴露。
  const walk = (dir, prefix = '', out = new Map()) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (statSync(full).isDirectory()) {
        out.set(rel, 'dir')
        walk(full, rel, out)
      } else out.set(rel, 'file')
    }
    return out
  }
  let mineTests, peerTests
  try {
    mineTests = walk(join(ROOT, 'scripts', 'patches', 'tests'))
    peerTests = walk(join(peer, 'scripts', 'patches', 'tests'))
    const mineFiles = [...mineTests.entries()].filter(([, k]) => k === 'file').map(([r]) => r)
    const peerFiles = [...peerTests.entries()].filter(([, k]) => k === 'file').map(([r]) => r)
    const onlyMine = mineFiles.filter((r) => !peerTests.has(r))
    const onlyPeer = peerFiles.filter((r) => !mineTests.has(r))
    check('tests/ 文件清单一致',
      onlyMine.length === 0 && onlyPeer.length === 0,
      `本仓独有: [${onlyMine.join(', ')}]；对端独有: [${onlyPeer.join(', ')}]`)
    let badContent = []
    for (const rel of mineFiles) {
      if (!peerTests.has(rel)) continue
      try {
        const r = cmp(join(ROOT, 'scripts', 'patches', 'tests', rel), join(peer, 'scripts', 'patches', 'tests', rel))
        if (r === 'content') badContent.push(rel)
        else if (r === 'eol') eolWarns.push(`tests/${rel}`)
      } catch { badContent.push(rel) }
    }
    check('tests/ 共有文件逐字节一致', badContent.length === 0, `内容漂移: [${badContent.join(', ')}]`)
  } catch (e) {
    check('tests/ 目录可枚举', false, String(e).slice(0, 200))
  }
  // 以下构建 / 门禁脚本条目自 2026-10-28 政策起以 APK 仓为准：本文件会按 scripts/ 前缀
  // 跳过它们的字节比对（见下方 isApkCanonicalScript），保留清单只为记录历史镜像面。
  // 真正仍逐字节守的是 scripts/patches/** 与插件 / 子仓目录。
  const MIRROR_TOP = [
    'scripts/build-apk-013.ps1',
    // Shared per-ABI terminal build stage, used by both the local and portable
    // APK chains as well as the local release assembler.
    'scripts/build-apk-engine.mjs',
    'scripts/build-apk-engine.test.mjs',
    'scripts/build-hard-manifest.mjs',
    'scripts/build-hard-manifest.test.mjs',
    'scripts/check-third-party.mjs',
    'scripts/check-third-party.test.mjs',
    'scripts/third-party-licenses.json',
    'LICENSES/Shizuku-API-MIT.txt',
    'THIRD_PARTY_NOTICES.md',
    'scripts/build-apk.mjs',
    // Shared delivery gates and version normalization are invoked from the
    // mirrored local build entrypoint; keep their implementation and tests in sync.
    'scripts/check-apk-signatures.mjs',
    'scripts/check-apk-signatures.test.mjs',
    'scripts/gen-model-catalog.mjs',
    'scripts/resolve-version-suffix.mjs',
    'scripts/resolve-version-suffix.test.mjs',
    // 自指条目按 2026-10-28 政策同样不比字节（APK 为 canonical）：本仓副本可以落后，
    // 但本门禁仍会守住 patches 与插件面。旧实现把自身列入逐字节比对，已随政策修正。
    'scripts/check-patch-mirror.mjs',
    // The UI provider E2E helper accepts credential material; its secrecy guards
    // and extracted-function regression must not drift in the APK mirror.
    'scripts/e2e-provider-ui.ps1',
    'scripts/tests/e2e-provider-ui-security.test.ps1',
    // ST-06 纳入镜像面：云端自包含构建链自身也是「单边演进 = 幽灵缺陷」面（此前只在 apk 仓存在、
    // 被镜像检查显式 SKIP）；注入集单一常量 + 契约/门禁脚本同批纳入（0.13.8-b 批 B1）。
    'scripts/build-apk.mjs',
    'scripts/plugin-dirs.json',
    'scripts/contract.json',
    'scripts/contract-pin-gaps.json',
    'scripts/check-patch-mounts.mjs',
    'scripts/check-contract.mjs',
    'scripts/check-snapshot-secrets.mjs',
    'scripts/inject-all.py',
    'scripts/ci-verify-snapshot.py',
    'scripts/test_ci_verify_snapshot.py',
    'scripts/build-snapshot-013.mjs',
    'scripts/lib/shell.mjs',
    // 0.14.1：软链自净化模块（快照归档前归一化旧 Termux 前缀软链）同样双仓同源。
    // build-snapshot-013.mjs 已在镜像面，其依赖模块若不入册就会出现「构建脚本同源、依赖单边演进」
    // —— 云端自包含构建跑旧净化逻辑，产物照样带 111/113 条设备必然丢弃的软链。
    'scripts/lib/symlink-sanitize.mjs',
    // 0.14.2（apk#247）：git 编译期 SHELL_PATH 等长重定位模块。build-snapshot-013.mjs 的第 7d2 步
    // import 它；构建脚本已在镜像面而依赖模块不在 ⇒ 单边演进 = 一侧仍按旧逻辑扫白名单/跟随软链，
    // 产物照样带 12 处应用域不可达的 SHELL_PATH。**实测两个方向**：本文件不登记时门禁输出里
    // 连 "git-shell-path" 都不会出现（漂移不可见）；登记后让对端漂移一行即判红。
    // 同批：check-prefix-residue.sh 是它的设备端判据（P4b 静态 / P4c 功能），两树同源同样必要
    // —— 它是纯手动设备脚本（不在声明集/快照/APK assets），未登记不会造成自动门禁假绿，故列在其后。
    'scripts/lib/git-shell-path.mjs',
    'scripts/check-prefix-residue.sh',
    // 0.14.1 W1：产物新鲜度的**重建哈希裁决**模块。check-tool-output-schema 与 check-protocol-v2
    // 两条门禁共用它——单边演进即「一侧仍按纯 mtime 判（假阳性 SKIP 或假阳性判红），另一侧按内容判」，
    // 同一份工作树在两个仓里得出不同结论，正是镜像面要防的形态。
    'scripts/lib/product-freshness.mjs',
    // 0.14.1 W1：Git Data API 重放的**安全预检**（逐文件比对「我的基线 blob vs 远端现状」，
    // 防重放静默回退别人的内容）。两个仓都可能作为重放源，脚本必须同源——单边演进 = 一侧拿旧判据
    // 放行一次会覆盖别人的重放，且该次事故不可逆（远端历史已被改写）。
    'scripts/replay-guard.mjs',
    // 0.14.1：Kotlin 单测数量回归门禁。apk 仓的 check-release-gates.mjs 已把它列进清单，
    // 但脚本此前**只存在于协调仓** → apk 侧聚合门禁会因「脚本缺席」判红（云端自包含构建同理）。
    // 门禁脚本自身 = 防线，必须与产物面同源。
    'scripts/check-kotlin-test-count.mjs',
    // ── 基线 JSON 刻意**不**入镜像面（2026-10-27，issue #156；PR #158 / #159 实测后移除）──
    // 别再把它加回来。它和上面那个门禁脚本不是同一类东西：
    //   - **apk 仓是唯一真源**。它是「Kotlin 单测只许升不许降」的计数基线，由 apk 仓的
    //     check-kotlin-test-count.mjs 消费。协调仓既没有 Kotlin 测试源目录
    //     （app/src/test/java/com/dsharnessmobile/shell 缺席，跑该门禁直接 exit 2），
    //     也没有任何门禁读它（check-release-gates.mjs 里该条是 ciApk:false / ciCoord:false
    //     / sink:'apk-ci'，即只在 apk 仓 CI 跑）。
    //   - 它**每合一个带 Kotlin 单测的 PR 就变一次**（2026-10-27 上午就变了 5 次）。
    //     纳入逐字节比对的实际效果只有周期性假红：当天已空转两次——#158 刚把协调仓追平到
    //     1859，apk 侧下一个 PR 立刻推到 1865，镜像门禁再次判红。
    //   - 这种「纯镜像载体」留在逐字节比对面里等于给真漂移制造噪音背景：红得越频繁，
    //     真红越容易被当作「又是那个基线」而放过。
    // 结论：门禁脚本镜像（上面那条保留），基线不镜像（本条移除）。要在协调仓核 Kotlin
    // 用例数，去 apk 仓看，别在本仓留副本。
    // 0.13.8-b 批 B2（ST-25/26/31 + §7.2）：制度性门禁、度量入口与 A1 seed 模块同样双仓同源
    // （云端自包含构建会跑它们；单边演进 = 云端跑旧门禁/旧 seed）。
    'scripts/check-state-registry.mjs',
    'scripts/state-registry.json',
    'scripts/check-bridge-symmetry.mjs',
    'scripts/bridge-symmetry-baseline.json',
    // 0.15.0 中英文案一致性门禁（2026-10-27，issue #156 / PR #157）：权威源在 apk 仓
    // （判据输入 app/src/main/res 与 dsh-client-ui-responsive 都在 apk 布局里）。
    // 但 check-release-gates.mjs 是双仓逐字节镜像的聚合清单、必然声明本门禁，所以它必须两仓都在场；
    // 一旦两仓各有一份而不入册，就复制了「单边改判据、镜像门禁看不见」的老路（#156 A 组 11 个文件的漂移）。
    // 故纳入镜像面：两仓逐字节同源。协调仓无 Android 树时走具名 SKIP 并计数，apk 仓照常真跑判据。
    'scripts/check-i18n-parity.mjs',
    'scripts/check-gate-skips.mjs',
    'scripts/check-perf-instrumentation.mjs',
    'scripts/check-perf-instrumentation.test.mjs',
    'scripts/perf-instrumentation-gaps.json',
    'scripts/perf/count-compose.mjs',
    'scripts/perf/measure-steady.ps1',
    'scripts/lib/profile-seed.mjs',
    // 0.13.8-b 新插件 + 本轮新增跨包边的 file-open：自包含副本与协调仓同源是既有铁律（AGENTS §4
    // robocopy src + package.json + lib 产物）。**目录级**比对（递归，排除 node_modules）——只点
    // package.json + lib/index.js 会在单边改 lib/facts.js、test/*.test.mjs、新导出面时假绿
    // （本轮实测：browser 副本曾落后 4 文件 / 5 文件内容不同；file-open 曾落后 test/auth.test.mjs）。
    // **CI 面提醒（0.14.0 CI/CD 修复 C-1）**：dsh-host-web-compat / dsh-client-ui-responsive 是
    // **独立 git 仓库**，在协调仓 .gitignore 里（净检出永远缺席）。因此 CI 必须在跑本门禁前把它们
    // 检出到这两个路径（见 .github/workflows/pr-gate.yml 的「检出镜像对端三面」步骤）——否则首条
    // 「镜像面源文件在场」即 FAIL，协调仓 main 自 2026-09-13 起一直红。本地工作树天然在场，无需处理。
    // apk 仓那一侧同理（同名副本随 apk 仓提交，故 CI 检出 apk 仓即得）。
    'dsh-host-web-compat',
    'dsh-client-ui-responsive',
    // 0.14.1 P0-c 补线：注入集（scripts/plugin-dirs.json 的 dirs）里凡在此缺席的目录 = 无门禁可拦的
    // 镜像漂移面。本轮实测三处漏项：manage 曾单边演进 35 行（含块G F6 的 vd-shot SF token 反查
    // 接线），apk 副本缺该接线而**编译与门禁全绿**——正是幽灵缺陷的定义形态（铁律 5）。
    // 故把注入集全量对齐 MIRROR_TOP，而不是只补这一个。
    'plugins/dsh-android-bridge',
    'plugins/dsh-android-manage',
    'dsh-shell-termux',
    'plugins/dsh-android-linux-env',
    'plugins/dsh-android-browser',
    'plugins/dsh-android-vdisplay',
    'plugins/dsh-android-file-open',
    'plugins/dsh-session-delete',
    'scripts/build-release.ps1',
    'scripts/check-manifest-hardening.mjs',
    'scripts/check-bounded-io.mjs',
    'scripts/check-api-route-auth.mjs',
    'scripts/api-route-auth-policy.json',
    'vendor/dsh-undo-savepoint/PATCHES.md',
    'vendor/dshmarketplace-plugin/PATCHES.md',
    // vendor/dsh-model-sync（@aiwayds/dsh-model-sync 固化副本）随插件于 0.14.1 **整体摘除**（用户裁定，
    // 理由见 scripts/profile-web.cordis.patch.yml 的注释），故这里的镜像条目同批移除——
    // 留着会让门禁对端缺失而 SKIP，看起来像「仍有一个 vendor 面在守」。
    'scripts/check-protocol-v2.mjs',
    'scripts/check-runtime-assets.mjs',
    'scripts/check-snapshot-fingerprint.mjs',
    // 0.14.7 / task-9 D-4：内嵌快照「真的能解压」门禁。它是两条构建链与 apk 仓 CI 的**同一执行面**
    // （本地链 per-ABI 段、云端链 assemble 之后、apk CI 在 gradle 之后各调一次），单边演进即
    // 「一侧按旧判据/对端缺文件」——与 ST-17 同型，必须逐字节同源。
    'scripts/check-snapshot-decode.mjs',
    'scripts/check-tool-output-schema.mjs',
    'scripts/check-control-ops.mjs',
    'scripts/check-release-gates.mjs',
    'scripts/control-ops-known-gaps.json',
    'scripts/control-ops-pending.json',
    'scripts/check-inject-completeness.mjs',
    'scripts/check-kotlin-comments.mjs',
    // 0.14.2 D7：执行地图门禁纳入聚合并声明集合，它就必须与产物面同源 ——
    // 单边演进会让协调仓与 apk 仓对同一棵工作树给出不同的地图结论。
    'scripts/check-code-map.mjs',
    // 0.14.5（上游对齐审计 C-1）：补丁回归清单门禁。它读 scripts/patches/tests/**（已镜像）并调 node:test，
    // 两端结论必须同源；单边演进会让一仓判红、另一仓判绿。
    'scripts/check-patch-test-manifest.mjs',
    'scripts/check-strip-noop.mjs',
    // combo 缓存（0.14.0 启动性能 P1-2 / A3）：预计算模块与覆盖门禁是双仓构建链的同一执行面——
    // 云端自包含构建会用 apk 仓副本（单边演进 = 云端算出的缓存与协调仓门禁口径不一致）。
    'scripts/check-combo-cache.mjs',
    // 云端链与 CI 都跑它（build-apk.mjs GATE_SCRIPTS），此前不在镜像面 = 单边演进可绕过（ST-17 顺路收口）
    'scripts/check-engine-overlay.mjs',
    // H-1（0.14.2-fx-2）：MCP client 依赖闭包门禁。云端自包含链会跑 apk 仓副本——
    // 单边演进 = 云端跑旧判据（或对端缺文件）而本地链判绿，与 ST-17 同型。
    'scripts/check-mcp-client-deps.mjs',
    'scripts/check-build-chain-abort.mjs',
    'scripts/release-plugin-src-gaps.json',
    'scripts/gen-protocol-v2-fixture.mjs',
    'scripts/profile-web.cordis.patch.yml',
    'scripts/snapshot-config/engine-overlay.json',
    // 快照瘦身清单（0.14.2 T2）：slim.json 是**供给侧数据面**——两条构建链
    // （协调仓本地链 + apk 仓云端自包含链）都读它（build-snapshot-013.mjs:61 的 readCfg('slim.json')），
    // 却长期不在镜像面：单边演进 = 本地链删了 man/.d.ts 而云端链没删，且门禁完全看不见
    // （幽灵缺陷形态，正是铁律 6 要防的那一类）。0.14.2 T2 的 recon 实测发现此缺口并在此登记。
    'scripts/snapshot-config/slim.json',
    // 模型面工具 wire 预算门禁（0.14.0 §4.1）：脚本 + 基线双仓同源——只有一侧更新基线会让
    // 另一侧以旧阈值判红/判绿（基线是「事实值」，单边演进即口径分裂）。
    'scripts/check-tool-surface-budget.mjs',
    'scripts/tool-surface-budget.json',
    // 插件单测门禁（0.14.1 §1.1b 决策 1 / §2.4）：声明集合新增它之后必须同批进镜像面——否则
    // 单边演进可让云端链跑到旧副本（或对端缺文件）而本地链/CI 判绿，与 ST-17 同型缺陷。
    'scripts/check-plugin-tests.mjs',
    // 冷启动预算门禁（0.14.1 块F P0-2）：脚本 + 其消费的探针口径实现都双仓同源——只有一侧更新
    // 判据会让另一侧以旧口径判绿（设备实测的 -1 正是「口径不同步」类事故）。
    'scripts/check-boot-budget.mjs',
    // 快照构建器产出面门禁（0.14.1 P0 反回归）：条目保留；按 2026-10-28 政策，
    // 脚本差异不比字节（APK canonical），它自身的产出面 / 路径同源判据仍由聚合链执行。
    'scripts/check-snapshot-builder-output.mjs',
    // 浏览器语法下限门禁（0.14.1 块C G-1）：构建期降级原语 + 判据都双仓同源——云端自包含构建会用
    // apk 仓副本跑降级与判据，单边演进 = 两侧对「发往浏览器的 bundle 语法下限」口径分裂。
    'scripts/check-browser-syntax-floor.mjs',
    // 构建并发上限门禁（0.14.1 系统级约束）：它断言 lib/shell.mjs 的常量与三处消费面；单边演进
    // 会让一侧仍吃满全部核心（MuMu 卡顿/系统不稳），故脚本 + 上限模块都进镜像面。
    'scripts/check-build-parallel-cap.mjs',
    // 屏幕范围判定的跨语言 fixture 同步器（0.14.1 审查 §8.3/§8.3b 收口）：它把插件侧权威源
    // 复制成壳侧单测资源，是「引擎侧第一道门」与「壳侧执行点第二道门」等价的唯一真值链。
    // 脚本单边演进 = 一侧按旧规则生成/校验副本，等价性无声失效。
    'scripts/gen-screen-scope-fixture.mjs',
    // 死 token 门禁（0.14.2 D3 / B6）：它是两条构建链与协调仓 CI 的同一执行面——单边演进会让
    // 云端自包含构建跑到旧副本（对端缺文件即 SKIP），与 ST-17 同型缺陷。
    'scripts/check-dead-tokens.mjs',
    // 开发期热推（0.14.2 rc.2 纳入）：apk 仓 AGENTS.md §2 明文教这条命令，而脚本此前**只存在于
    // 协调仓** —— apk 自包含树里那条文档指向一个不存在的文件（实测 ABSENT）。文档承诺与可执行面
    // 不同源，正是镜像面要防的形态；纳入后任一侧漂移即判红。
    'scripts/hot-push.mjs',
  ]
  /** 递归列出目录下所有文件（相对路径；node_modules/.git 排除）——目录级镜像面用。 */
  const walkAll = (dir, prefix = '') => {
    const out = []
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue
      const full = join(dir, name)
      const relPath = prefix ? prefix + '/' + name : name
      if (statSync(full).isDirectory()) out.push(...walkAll(full, relPath))
      else out.push(relPath)
    }
    return out
  }
  /**
   * 目录级比对中**按设计逐侧不同**的生成物——它们不是镜像漂移，计入比对会让该目录永久判红
   * （假红），反而失去「挡住真漂移」的判别力。两类，逐条具名（排除面刻意极小）：
   *   - `*.tgz`：打包产物，子仓 .gitignore 已忽略；各自打包时按本侧源码生成，两侧本就不同源。
   *   - `lib/catalog-snapshot.json`：由 build-snapshot-013.mjs 按**本次构建的 ABI 引擎树**生成
   *     （engineRootHint 使用快照内相对路径；数据仍来自各 ABI 的真实引擎树），是构建期数据，
   *     不属于铁律 5 的「src + package.json + lib 产物」镜像面。
   * 除外：src/、test/、package.json 等源码仍全量逐字节比对。
   */
  const MIRROR_SKIP = [
    /\.tgz$/,
  ]
  const mirrorKept = (rel, x) => !MIRROR_SKIP.some((re) => re.test(rel + '/' + x))
  /**
   * 2026-10-28 政策：构建 / 门禁 / 校验脚本由 dsh-mobile-apk 维护，协调仓副本不再要求同步。
   * `scripts/patches/**` 不在此面（它由上方 MIRROR_FILES / data / tests 段单独逐字节守），
   * 这里只排除可执行脚本扩展名；共享 JSON/YAML 配置继续比对，不能因目录名而被一起排除。
   */
  const isApkCanonicalScript = (rel) => rel.startsWith('scripts/') &&
    !rel.startsWith('scripts/patches/') && /\.(?:mjs|cjs|js|py|ps1|sh)$/.test(rel)
  let canonicalSkipped = 0
  for (const rel of MIRROR_TOP) {
    if (isApkCanonicalScript(rel)) {
      canonicalSkipped += 1
      continue
    }
    const mine = join(ROOT, rel)
    const theirs = join(peer, rel)
    if (!existsSync(mine)) {
      // 三条同时成立才 SKIP（细则见 ignoredByOwnRepo 注释）；否则仍然是 FAILED。
      const peerHasIt = existsSync(theirs) || existsSync(join(peer, rel.split('/')[0]))
      if (ignoredByOwnRepo(rel) && peerHasIt) {
        skip(`镜像面目录在裸检出下缺席: ${rel}（本仓 .gitignore 忽略，正常本地布局由 Junction / 符号链接指向对端提供）`)
      } else {
        check(`镜像面源文件在场: ${rel}`, false, '本仓缺席（MIRROR_TOP 条目失效：既未被本仓 .gitignore 忽略，对端也没有）')
      }
      continue
    }
    if (statSync(mine).isDirectory()) {
      if (!existsSync(theirs)) { skip(`镜像目录: ${rel}（对端无此目录）`); continue }
      const mineFiles = walkAll(mine).filter((x) => mirrorKept(rel, x))
      const peerFiles = walkAll(theirs).filter((x) => mirrorKept(rel, x))
      const onlyMine = mineFiles.filter((x) => !peerFiles.includes(x))
      const onlyPeer = peerFiles.filter((x) => !mineFiles.includes(x))
      check(`镜像目录清单一致: ${rel}（${mineFiles.length} 文件）`,
        onlyMine.length === 0 && onlyPeer.length === 0,
        '本仓独有: [' + onlyMine.slice(0, 5).join(', ') + ']；对端独有: [' + onlyPeer.slice(0, 5).join(', ') + ']')
      const badContent = []
      for (const x of mineFiles) {
        if (!peerFiles.includes(x)) continue
        const r = cmp(join(mine, x), join(theirs, x))
        if (r === 'content') badContent.push(x)
        else if (r === 'eol') eolWarns.push(rel + '/' + x)
      }
      check(`镜像目录内容一致: ${rel}`, badContent.length === 0, '内容漂移: [' + badContent.slice(0, 5).join(', ') + ']')
      continue
    }
    if (!existsSync(theirs)) { skip(`镜像一致: ${rel}（对端无此文件）`); continue }
    try {
      const r = cmp(mine, theirs)
      check(`镜像一致: ${rel}`, r !== 'content', r === 'eol' ? '仅行尾差异（见告警）' : undefined)
      if (r === 'eol') eolWarns.push(rel)
    } catch (e) {
      check(`镜像一致: ${rel}`, false, String(e).slice(0, 200))
    }
  }
  if (eolWarns.length > 0) {
    console.log(`WARN  仅行尾差异（git blob 层一致则无碍；本机为工作树 autocrlf 噪声）: [${eolWarns.join(', ')}]`)
  }
  if (canonicalSkipped > 0) {
    console.log(`APK-CANONICAL  ${canonicalSkipped} 项 scripts/ 脚本条目按 2026-10-28 政策不比字节（以 dsh-mobile-apk 为准；不计 SKIP）`)
  }
}

if (failures.length > 0) {
  console.error(`CHECK-PATCH-MIRROR FAILED（${failures.length} 项）：${failures.join('；')}`)
  process.exit(1)
}
console.log('CHECK-PATCH-MIRROR PASSED（SKIP=' + skipped + '）')
