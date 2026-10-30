#!/usr/bin/env node
// check-snapshot-fingerprint.mjs — 快照指纹对账门禁（0.13.8-b 批 B2 / ST-04，溯源 F-ENV-01）
//
// 缺的同步路径：全仓没有任何 `sha256(assets/snapshot.tar.xz) == assets/snapshot.sha256` 断言。
// 三个构建脚本会重写声明值，走完整链是安全的；**但「手工替换 tar」这一动作没有机器校验**
// （壳侧 EngineManager.snapshotFresh() 只做字符串比较，陈旧即跳过重解压，运行期也发现不了）。
//
// 断言：assets/snapshot.tar.xz 的实际 sha256（小写十六进制）== assets/snapshot.sha256 的声明值（逐字节）。
// 两个 ABI 各自构建时各自声明值与各自 tar 一致——不得再出现「入库值是单一 ABI 构建的事实」。
//
// issue #993（判据失效模式：vacuous pass——「在场」当成「可用」）：
//   Hard 插件清单（`assets/plugin-hard-manifest.json`）此前只判 `existsSync`。于是
//   `{"entries":[]}`（12 B）与 0 字节文件都 PASS，而运行期 `PluginMounts.ensureHard` 对它们
//   一律 `return null` → `REFUSAL_HARD_BUNDLE_SELECTION`，用户只看到「快照指纹不可用」这类抽象文案。
//   修法 = 判据从「文件在」提到「文件可解析且不是空壳」：`schema`/`entries` 必须存在，
//   `entries` 必须是**非空**数组且每项带非空 `id`/`name`，`profileEntries` 同理且必须是 `entries` 的子集
//   （这是壳侧 `cacheHard` 的同款前置；门禁挡在前面，运行期就不会拒绝启动）。
//
// 用法：node scripts/check-snapshot-fingerprint.mjs [--require] [--root <树>]
//   --require  构建链/发布链用：tar 缺席即失败（不得 SKIP exit 0）。也可用 DSH_REQUIRE_SNAPSHOT_FINGERPRINT=1。
//   --root     仅用于反向验证或非标准布局；缺省自动探测「含 app/src/main 的树」。
//   --self-test 判别力自证（含 issue #993 的空壳清单负控）。
// 退出码：0 = 通过（或 CI 净检出下明确计数并打印的 SKIP）；1 = 不一致 / 声明缺席 / 树定位失败 / 清单不可用。
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/**
 * Hard 插件清单的可核对性判据（纯函数，供 --self-test 直接钉住）。
 *
 * issue #993：这条判据的失效形态是「文件在、内容空」——`existsSync` 对它恒真。
 * 所以判定必须落在**解析后的结构**上，且每一条都有非空下限：
 *   - 不是合法 JSON ⇒ 红（运行期 JSONException 同样会拒绝）；
 *   - `schema` 必须是数字且 `entries` 必须是数组 ⇒ 红（结构缺失同上）；
 *   - `entries.length > 0` ⇒ 红（空数组 = 「没有可挂载的插件」= 引擎必拒启动）；
 *   - 每项 `id`/`name` 必须是非空字符串 ⇒ 红（壳侧 `cacheHard` 逐项校验同一组字段）；
 *   - `profileEntries` 非空且 ⊆ `entries` ⇒ 红（壳侧 `cacheHard` 的同款前置）。
 * `fingerprint` 只做「存在且形如 sha256」的弱校验：它与 `snapshot.sha256` 的强对账由上面的
 * 主判据负责，清单里那份是构建期冗余记录（两份可能来自不同 ABI 的同一 tar，不在这里比字节）。
 *
 * @param {string} text 清单文件原文。
 * @returns {{problems: string[], counts?: {entries: number, profileEntries: number}}}
 *          problems 为空 = 清单可用；counts 只在能解析出数组时给出。
 */
export const hardManifestProblem = (text) => {
  const problems = []
  let json = null
  try {
    json = JSON.parse(text)
  } catch (error) {
    return { problems: ['Hard 插件清单不是合法 JSON：' + String(error?.message ?? error)] }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { problems: ['Hard 插件清单的顶层不是对象（JSON=' + JSON.stringify(json).slice(0, 60) + '）'] }
  }
  if (typeof json.schema !== 'number') problems.push('Hard 插件清单缺 schema（壳侧 PluginMounts 按 schema=2 解析）')
  const entries = json.entries
  if (!Array.isArray(entries)) {
    problems.push('Hard 插件清单缺 entries 数组（运行期 ensureHard 直接返回 null）')
  } else if (entries.length === 0) {
    // 这正是 issue #993 的复现形态：文件在、12 B、PASS，而运行期拒绝启动引擎。
    problems.push('Hard 插件清单 entries 为空数组 —— 「文件在」不等于「可用」：运行期 ensureHard 返回 null，'
      + '引擎以 hard-bundle-selection-unverified 拒绝启动')
  } else {
    const badRows = entries.filter((entry) => entry === null || typeof entry !== 'object'
      || typeof entry.id !== 'string' || entry.id.trim() === ''
      || typeof entry.name !== 'string' || entry.name.trim() === '')
    if (badRows.length > 0) {
      problems.push('Hard 插件清单有 ' + badRows.length + ' 条 entry 缺非空 id/name（壳侧 cacheHard 会拒绝整份清单）')
    }
  }
  const profileEntries = json.profileEntries
  if (!Array.isArray(profileEntries)) {
    problems.push('Hard 插件清单缺 profileEntries 数组（壳侧 ensureHard 要求在场）')
  } else if (profileEntries.length === 0) {
    problems.push('Hard 插件清单 profileEntries 为空数组（壳侧 cacheHard 要求非空）')
  } else if (Array.isArray(entries)) {
    const keys = new Set(entries.map((entry) => JSON.stringify([entry?.id ?? null, entry?.name ?? null])))
    const outside = profileEntries.filter((entry) => !keys.has(JSON.stringify([entry?.id ?? null, entry?.name ?? null])))
    if (outside.length > 0) {
      problems.push('Hard 插件清单有 ' + outside.length + ' 条 profileEntry 不在 entries 里（壳侧 cacheHard 会拒绝）')
    }
  }
  const counts = {
    entries: Array.isArray(entries) ? entries.length : 0,
    profileEntries: Array.isArray(profileEntries) ? profileEntries.length : 0,
  }
  return { problems, counts }
}

// ── --self-test：判别力自证（2026-10-29 补；此前这条门禁零判别力面）──────────────────
//
// 这条门禁守的是「assets/snapshot.tar.xz 的 sha256 == snapshot.sha256 声明值」—— 手工替换 tar
// 的唯一机器校验。它本身支持 --root，所以自证可以造多棵临时树，把每个判据分支全打一遍：
// 匹配 / 不匹配 / 声明缺席 / 声明格式非法 / tar 缺席（SKIP）/ tar 缺席 + --require（硬失败）
// / Hard 清单缺席 / Hard 清单空壳（issue #993）。
if (process.argv.includes('--self-test')) {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { createHash: hashOf } = await import('node:crypto')
  const { tmpdir } = await import('node:os')

  const selfPath = fileURLToPath(import.meta.url)
  const runGate = (treeArgs) => {
    try {
      const out = execFileSync(process.execPath, [selfPath, ...treeArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    }
  }
  /**
   * #920 / #993：清单的默认夹具必须是**可用**形态（非空 entries + 子集 profileEntries），
   * 否则「缺清单」以外的用例会被清单判据连带判红，反证结论就不可信了。
   */
  const GOOD_MANIFEST = JSON.stringify({
    schema: 2,
    complete: true,
    fingerprint: 'a'.repeat(64),
    entries: [{ id: 'a@1.0.0', name: '@dsh-android/a' }],
    profileEntries: [{ id: 'a@1.0.0', name: '@dsh-android/a' }],
    factoryBundles: [],
    names: ['@dsh-android/a'],
  })
  const buildTree = (tag, opts) => {
    const dir = mkdtempSync(join(tmpdir(), 'snapfp-' + tag + '-'))
    mkdirSync(join(dir, 'app', 'src', 'main', 'assets'), { recursive: true })
    const bytes = opts.bytes ?? 'snapshot-bytes'
    if (opts.tar !== false) writeFileSync(join(dir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz'), bytes)
    if (opts.sha === 'auto') {
      writeFileSync(join(dir, 'app', 'src', 'main', 'assets', 'snapshot.sha256'), hashOf('sha256').update(bytes).digest('hex') + '\n')
    } else if (typeof opts.sha === 'string') {
      writeFileSync(join(dir, 'app', 'src', 'main', 'assets', 'snapshot.sha256'), opts.sha)
    }
    // #920：Hard 插件清单也是内嵌构建产物（.gitignore 忽略）。默认给可用形态，
    // 缺席场景由 noManifest 树覆盖，#993 的空壳场景由各自专门的树覆盖。
    if (opts.manifest !== false) {
      writeFileSync(join(dir, 'app', 'src', 'main', 'assets', 'plugin-hard-manifest.json'),
        opts.manifest === undefined ? GOOD_MANIFEST : opts.manifest)
    }
    return dir
  }

  const match = buildTree('match', { sha: 'auto' })
  const mismatch = buildTree('mismatch', { sha: 'f'.repeat(64) })
  const noSha = buildTree('nosha', {})
  const badSha = buildTree('badsha', { sha: 'NOT-A-SHA' })
  const noTar = buildTree('notar', { tar: false, sha: 'auto' })
  const noManifest = buildTree('nomanifest', { sha: 'auto', manifest: false })
  // issue #993：四种「文件在但不可用」的形态。
  const emptyEntries = buildTree('emptyentries', { sha: 'auto', manifest: '{"entries":[]}' })
  const zeroBytes = buildTree('zerobytes', { sha: 'auto', manifest: '' })
  const badJson = buildTree('badjson', { sha: 'auto', manifest: '{"entries":[' })
  const emptyProfile = buildTree('emptyprofile', {
    sha: 'auto',
    manifest: JSON.stringify({ schema: 2, entries: [{ id: 'a@1', name: '@dsh-android/a' }], profileEntries: [] }),
  })
  const profileOutside = buildTree('profileoutside', {
    sha: 'auto',
    manifest: JSON.stringify({
      schema: 2,
      entries: [{ id: 'a@1', name: '@dsh-android/a' }],
      profileEntries: [{ id: 'b@1', name: '@dsh-android/b' }],
    }),
  })

  const checks = [
    // #920：清单缺席 + --require 必须硬失败并点名文件（不能只证明「加上去就绿了」）
    ['Hard 插件清单缺席 + --require → FAILED 且点名 plugin-hard-manifest.json',
      runGate(['--root', noManifest, '--require']),
      (r) => r.code === 1 && r.out.includes('plugin-hard-manifest.json')],
    // #920：CI 净检出（无 tar，连带无清单）→ 仍 SKIP 且计数可见，不得静默绿
    ['净检出（无 tar）→ SKIP 且 SKIP=1 计数可见，不因清单缺席而 red',
      runGate(['--root', noTar]),
      (r) => r.code === 0 && r.out.includes('SKIP=1')],
    ['tar 与声明一致 → PASSED 且 exit 0', runGate(['--root', match]), (r) => r.code === 0 && r.out.includes('SNAPSHOT-FINGERPRINT CHECK PASSED')],
    ['声明与 tar 不一致 → FAILED 且指出「手工替换」', runGate(['--root', mismatch]), (r) => r.code === 1 && r.out.includes('指纹与快照不一致') && r.out.includes('手工替换')],
    ['声明缺席 → FAILED（无法对账）', runGate(['--root', noSha]), (r) => r.code === 1 && r.out.includes('指纹声明缺席')],
    ['声明格式非法 → FAILED（不是 64 位小写十六进制）', runGate(['--root', badSha]), (r) => r.code === 1 && r.out.includes('指纹声明格式非法')],
    ['tar 缺席（非 --require）→ SKIP 且 exit 0、带 SKIP=1', runGate(['--root', noTar]), (r) => r.code === 0 && r.out.includes('SKIP=1')],
    ['tar 缺席 + --require → 硬失败 exit 1', runGate(['--root', noTar, '--require']), (r) => r.code === 1 && r.out.includes('快照 tar 不在场')],
    // ── issue #993：空壳清单必须判红（旧实现这四条全 PASS）─────────────────────
    ['#993 entries 为空数组 → FAILED（文件在 ≠ 可用）', runGate(['--root', emptyEntries]), (r) => r.code === 1 && r.out.includes('entries 为空数组')],
    ['#993 0 字节清单 → FAILED（不是合法 JSON）', runGate(['--root', zeroBytes]), (r) => r.code === 1 && r.out.includes('不是合法 JSON')],
    ['#993 截断 JSON → FAILED', runGate(['--root', badJson]), (r) => r.code === 1 && r.out.includes('不是合法 JSON')],
    ['#993 profileEntries 为空 → FAILED', runGate(['--root', emptyProfile]), (r) => r.code === 1 && r.out.includes('profileEntries 为空数组')],
    ['#993 profileEntry 不在 entries 里 → FAILED', runGate(['--root', profileOutside]), (r) => r.code === 1 && r.out.includes('不在 entries 里')],
  ]
  let bad = 0
  for (const [label, result, verify] of checks) {
    const ok = verify(result)
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  -> exit=' + result.code + ' out=' + result.out.trim().slice(0, 200)))
    if (!ok) bad += 1
  }
  for (const dir of [match, mismatch, noSha, badSha, noTar, noManifest,
    emptyEntries, zeroBytes, badJson, emptyProfile, profileOutside]) {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(bad === 0
    ? 'SNAPSHOT_FP_SELF_TEST_PASSED（' + checks.length + ' 项）'
    : 'SNAPSHOT_FP_SELF_TEST_FAILED（' + bad + ' 项）')
  process.exit(bad === 0 ? 0 : 1)
}

const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const OVERRIDE = rootIdx >= 0 ? argv[rootIdx + 1] : process.env.DSH_APK_ROOT
const REQUIRE = argv.includes('--require') || process.env.DSH_REQUIRE_SNAPSHOT_FINGERPRINT === '1'

const fail = (msg) => {
  console.error('SNAPSHOT-FINGERPRINT CHECK FAILED：' + msg)
  process.exit(1)
}
const skip = (msg) => {
  console.log('SKIP  ' + msg + '（SKIP=1；发布链要求 SKIP=0，构建链以 --require 调用）')
  process.exit(0)
}

const hasAssets = (dir) => existsSync(join(dir, 'app', 'src', 'main', 'assets'))
const CANDIDATES = OVERRIDE
  ? [resolve(OVERRIDE)]
  : [ROOT, join(ROOT, 'dsh-mobile-apk'), resolve(join(ROOT, '..'))]
const APK_ROOT = CANDIDATES.find(hasAssets)
if (!APK_ROOT) {
  fail('找不到含 app/src/main/assets 的树（协调仓布局应为 <根>/dsh-mobile-apk，apk 仓自包含布局应为 <根> 本身）\n'
    + '  候选：' + CANDIDATES.join('、'))
}
const ASSETS = join(APK_ROOT, 'app', 'src', 'main', 'assets')
const TAR = join(ASSETS, 'snapshot.tar.xz')
const SHA_FILE = join(ASSETS, 'snapshot.sha256')
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

console.log('APK 树: ' + (relative(ROOT, APK_ROOT) || APK_ROOT))
if (!existsSync(TAR)) {
  const msg = '快照 tar 不在场（' + rel(TAR) + '）——净检出/CI 下 tar 被 .gitignore 忽略'
  if (REQUIRE) fail(msg + '\n  构建链要求在场：先跑 scripts/build-snapshot-013.mjs <abi>（或注入链），再跑本门禁')
  skip(msg)
}
if (!existsSync(SHA_FILE)) {
  fail('指纹声明缺席（' + rel(SHA_FILE) + '）——tar 在场却没有声明值，无法对账；'
    + '构建链会在拷贝 tar 后写入该文件（build-apk-013.ps1 / build-apk.mjs）')
}
const declared = readFileSync(SHA_FILE, 'utf8').trim().toLowerCase()
if (!/^[0-9a-f]{64}$/.test(declared)) {
  fail('指纹声明格式非法（' + rel(SHA_FILE) + '）：期望 64 位小写十六进制，实际 ' + JSON.stringify(declared.slice(0, 80)))
}
const actual = await new Promise((ok, bad) => {
  const h = createHash('sha256')
  createReadStream(TAR).on('data', (c) => h.update(c)).on('error', bad).on('end', () => ok(h.digest('hex')))
})
if (actual !== declared) {
  fail('指纹与快照不一致（手工替换 tar 的典型形态）\n'
    + '  ' + rel(TAR) + ' 实际 = ' + actual + '（' + statSync(TAR).size + ' B）\n'
    + '  ' + rel(SHA_FILE) + ' 声明 = ' + declared + '\n'
    + '  修复：重跑构建链（拷贝 tar 后自动重写声明值），勿手工编辑声明值')
}
console.log('PASS  ' + rel(TAR) + ' == ' + rel(SHA_FILE) + '（sha256=' + actual + '）')
// #920：同一族另一份内嵌资产。tar 在场即要求清单也在场 —— 缺失时运行期 EngineManager
// 会以 hard-bundle-selection-unverified 拒绝启动引擎，而用户只看到抽象文案（#908/#920）。
// #993：「在场」不够，还要**可用** —— 空 entries / 0 字节 / 结构缺失都在这里判红。
const HARD = join(ASSETS, 'plugin-hard-manifest.json')
if (!existsSync(HARD)) {
  fail('Hard 插件清单缺席（' + rel(HARD) + '）——tar 在场却没有该构建产物；运行期会以 hard-bundle-selection-unverified 拒绝启动引擎（#908/#920）；构建链会在拷贝 tar 后一并产出该文件（build-apk-013.ps1 / build-apk.mjs）')
}
const hardText = readFileSync(HARD, 'utf8')
const hard = hardManifestProblem(hardText)
if (hard.problems.length > 0) {
  fail('Hard 插件清单不可用（' + rel(HARD) + '，' + statSync(HARD).size + ' B）——'
    + '「文件存在」不等于「可用」，运行期会以 hard-bundle-selection-unverified 拒绝启动引擎（#908/#920/#993）：\n'
    + hard.problems.map((p) => '  - ' + p).join('\n'))
}
console.log('PASS  ' + rel(HARD) + ' 可用（Hard 插件清单，' + statSync(HARD).size + ' B；entries='
  + hard.counts.entries + ' profileEntries=' + hard.counts.profileEntries + '）')
console.log('SNAPSHOT-FINGERPRINT CHECK PASSED')
