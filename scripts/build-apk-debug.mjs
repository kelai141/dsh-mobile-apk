#!/usr/bin/env node
// build-apk-debug.mjs — 云端可复现的「调试包（dev）」编排：随机 8 位 ASCII 后缀 + versionCode 取当前
// release 绑定值 +1 + debug 变体（application-debuggable 是**期望值**，不是缺陷）。
//
// 为什么单独一条链（与 build-apk.mjs / build-apk-dev-fast.mjs 的分工）：
//   · build-apk.mjs / build-apk-013.ps1 是**发布链**：assembleRelease + 产物形态门禁（禁 debuggable）
//     + 全套发布门禁，产物可进 Release 资产。它们的排他判据正是调试包要的东西的反面。
//   · build-apk-dev-fast.mjs 是**本机**开发自测通道：复用仓内既有 snapshot.tar.xz、不重建快照、
//     产物名固定、无 CLI；它跑不到云端，也不该由它决定云端版本号。
//   · 本脚本 = 云端（GitHub Actions）产出「可 dev 的包」的编排层：版本号来自真源（当前树的
//     versionName 基线 + 已发布 release 绑定的 versionCode），快照来自**本次 commit** 的快照构建
//     （构建链上游 build-snapshot-013.mjs 的产物），终端阶段仍走共享引擎 build-apk-engine.mjs。
//
// 版本号规则（本脚本唯一负责的两条事实）：
//   ① versionName = <当前树 gradle 的 versionName 基线>-<随机 8 位 ASCII 字母数字>-dev
//      例：0.15.0-x7K2mQ9z-dev。随机段用 crypto.randomInt，字符集 A-Za-z0-9（62 位，约 2.18e14 组合）；
//      **刻意不用全可打印 ASCII**：产物名会进 URL、adb 命令、tar 成员名与 GHA artifact 名，
//      空格/引号/glob 字符只会制造转义事故，换不来任何熵。
//   ② versionCode = 该 release **绑定的** versionCode + 1（绑定值 = release tag 那份
//      app/build.gradle.kts 的 versionCode 默认值）。v0.14.11 绑 70 ⇒ 调试包 71，可覆盖安装已发布版；
//      而当前 main 的默认值（80）留给下一次发布，于是「调试包装得上已发布版、后续正式版又盖得住调试包」。
//
// 解析不到绑定值时**硬失败**，绝不回落到当前树的默认值：静默回落会让调试包的 versionCode 恰好等于
// 下一个正式版，装机时表现为 INSTALL_FAILED_VERSION_DOWNGRADE 或反向覆盖，而构建日志全绿。
//
// 快照 ABI 与 APK ABI 是硬不变量（AGENTS.md §6 雷点 1）：x86_64 快照装到 arm64 真机上 exec 直接
// CANNOT LINK EXECUTABLE houdini64，而 `am start -W` 仍报 Status: ok。故本脚本对**快照字节**显式跑
// elf-check 门禁（读 usr/bin/node 的 e_machine 与 --abi 交叉），不接受「让 Gradle 自己决定」。
//
// 用法：
//   node scripts/build-apk-debug.mjs --abi arm64|x86_64 [--snapshot <tar>] [--from-release [tag]]
//        [--release-tag <tag>] [--suffix <8位>] [--version-code <n>]
//        [--out <dir>] [--report <file>] [--dry-run] [--print-facts] [--self-test]
//   --print-facts  只输出一行 JSON（ABI -> snapshotAbi / nativeControlAbis / rustTarget / NDK / rustc），
//                  CI 用它取真源事实，避免在 workflow yaml 里抄第二份 ABI 表
// 退出码：0 = 成功（或 dry-run / self-test 通过）；1 = 失败；2 = 用法错误。
import { spawnSync } from 'node:child_process'
import { createHash, randomInt } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleApk } from './build-apk-engine.mjs'
import { resolveVersionSuffix } from './resolve-version-suffix.mjs'
// check-apk-form.mjs 的 main() 只在被直接执行时运行（尾部 process.argv[1] 判定），故可安全 import：
// 这里复用它的 parseBadging / resolveAapt2 —— 调试包要的是**同一条判据的相反结论**（必须是 debuggable），
// 自己再写一份 badging 解析就会出现「两个门禁两套语法」的漂移。
import { parseBadging, resolveAapt2 } from './check-apk-form.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const apkDir = process.env.DSH_APK_DIR || (existsSync(join(ROOT, 'dsh-mobile-apk')) ? join(ROOT, 'dsh-mobile-apk') : ROOT)
const gradleFile = join(apkDir, 'app', 'build.gradle.kts')

/** 随机段长度与字符集（见文件头 ①）。两者都是契约的一部分：测试与文档同源引用。 */
export const SUFFIX_LENGTH = 8
export const SUFFIX_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
/** dev 命名标记；versionName 必须以此结尾。 */
export const DEV_MARKER = 'dev'
/** versionCode 上限：Play 与 Gradle int 同口径（2100000000）。 */
export const MAX_VERSION_CODE = 2100000000
/** 产物包名：产物名里的包名必须与 app/build.gradle.kts 的 namespace 一致。 */
export const PACKAGE_NAME = 'com.dsharnessmobile.shell'
/** 受支持 ABI（与 build-apk.mjs / elf-check.mjs 同一口径）。 */
export const SUPPORTED_ABIS = ['arm64', 'x86_64']
/** snapshot 内 usr/bin/node 的 ELF machine 名（elf-check.mjs 的判据口径）。 */
export const SNAPSHOT_ABI_NAME = { arm64: 'aarch64', x86_64: 'x86_64' }
/** Gradle 的 -PnativeControlAbis 取值（native/phone-control-core/build-config.json 的 abis 键）。 */
export const NATIVE_CONTROL_ABI = { arm64: 'arm64-v8a', x86_64: 'x86_64' }

/** 用法错误：与运行期失败分开，退出码 2。 */
class UsageError extends Error {}

/** 随机 dev 段。nextInt 可注入，测试用它钉住字符集与长度（生产走 crypto.randomInt）。 */
export function randomSuffix(length = SUFFIX_LENGTH, nextInt = (max) => randomInt(0, max)) {
  if (!Number.isInteger(length) || length < 1) throw new UsageError('随机段长度必须是正整数，实得 ' + String(length))
  let out = ''
  for (let i = 0; i < length; i += 1) out += SUFFIX_CHARSET[nextInt(SUFFIX_CHARSET.length)]
  return out
}

/**
 * 校验一个调用方给定的 dev 段。
 *
 * 只接受**恰好 SUFFIX_LENGTH 位 [A-Za-z0-9]**：长度不同会让 `<base>-<段>-dev` 的段位不可预期，
 * 带分隔符的段则可能与版本号语义（-rc / -fx-N 是修订链的一环）撞车。
 */
export function validateRandomPart(text) {
  const value = String(text ?? '')
  if (!new RegExp('^[A-Za-z0-9]{' + SUFFIX_LENGTH + '}$').test(value)) {
    throw new UsageError('--suffix 必须是恰好 ' + SUFFIX_LENGTH + ' 位 ASCII 字母或数字（实得 ' + JSON.stringify(value) + '）')
  }
  return value
}

/** release 绑定的 versionCode + 1（见文件头 ②）。非法输入硬失败，不猜。 */
export function bumpVersionCode(base) {
  const text = String(base ?? '').trim()
  if (!/^[1-9][0-9]*$/.test(text)) {
    throw new Error('release 绑定的 versionCode 不可用（实得 ' + JSON.stringify(base) + '）：需要正整数；'
      + '解析不到就在 npm/gradle 真源里找，不得回落到当前树默认值')
  }
  const next = Number(text) + 1
  if (!Number.isSafeInteger(next) || next > MAX_VERSION_CODE) {
    throw new Error('release 绑定的 versionCode ' + text + ' 加一后越界（上限 ' + MAX_VERSION_CODE + '）')
  }
  return next
}

/** 组装 versionName：`<base>-<8位>-dev`。 */
export function composeVersionName(baseVersion, randomPart) {
  return baseVersion + '-' + validateRandomPart(randomPart) + '-' + DEV_MARKER
}

/** 产物名（与发布链同形，只多一个 -dev 段；Release 资产名匹配器不会命中它）。 */
export function artifactNameFor({ versionName, abi }) {
  if (!SUPPORTED_ABIS.includes(abi)) throw new UsageError('未知 ABI: ' + String(abi))
  return 'dsh-mobile-apk-v' + versionName + '-' + abi + '.apk'
}

/** 从 app/build.gradle.kts 文本解析 versionCode 默认值（只认 gradleProperty 形态，见文件头）。 */
export function parseGradleDefaultVersionCode(text) {
  const m = /providers\.gradleProperty\("versionCode"\)\.getOrElse\("([1-9][0-9]*)"\)/.exec(String(text ?? ''))
  return m ? m[1] : null
}

/** 从 app/build.gradle.kts 文本解析 versionName 基线（与 build-apk.mjs:43 同一正则口径）。 */
export function parseGradleBaseVersionName(text) {
  const m = /versionName\s*=\s*"([^"]+)"/.exec(String(text ?? ''))
  if (!m) return null
  const value = m[1]
  return /^\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(value) ? value : null
}

/** ABI 交叉断言（文件头「快照 ABI 与 APK ABI 是硬不变量」）。 */
export function assertSnapshotAbi(abi, snapshotAbi) {
  if (!SUPPORTED_ABIS.includes(abi)) throw new UsageError('未知 ABI: ' + String(abi))
  const want = SNAPSHOT_ABI_NAME[abi]
  if (snapshotAbi !== want) {
    throw new Error('快照 ABI 是 ' + String(snapshotAbi) + '，但目标是 ' + abi + '（期望 ' + want + '）：'
      + '错 ABI 的快照装到真机上 exec 直接 CANNOT LINK EXECUTABLE，且 am start -W 仍报 Status: ok —— '
      + '任何基于这种包的测量都是废的。换成本 ABI 的快照，或改 --abi')
  }
  return true
}

/** ABI -> -PnativeControlAbis 取值。 */
export function nativeControlAbiFor(abi) {
  if (!SUPPORTED_ABIS.includes(abi)) throw new UsageError('未知 ABI: ' + String(abi))
  return NATIVE_CONTROL_ABI[abi]
}

/**
 * 读 native/phone-control-core/build-config.json（原生库编译器/NDK/ABI 的**唯一**真源）。
 *
 * CI 要用其中的 rustTarget 去 `rustup toolchain install --target`：把那张 ABI 表抄一份进 workflow
 * yaml，就会在「仓里改了 ABI 键、yaml 没跟着改」时表现为 runner 上装了一个没人用的 target 而
 * 真正需要的那个缺席（报错点离真因很远）。故一律读真源，抄写只保留 arm64 -> arm64-v8a 这一处映射
 * （它就是 build-config.json 的键名，且下面会校验它真的在表里）。
 */
export function readNativeBuildConfig(dir = apkDir) {
  const path = join(dir, 'native', 'phone-control-core', 'build-config.json')
  if (!existsSync(path)) throw new Error('原生库配置真源缺失: ' + path)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error('原生库配置不可解析 ' + path + '：' + error.message)
  }
}

/** ABI -> build-config.json 里的 rustTarget（CI 装 rustup target 用）。 */
export function rustTargetFor(abi, config) {
  const key = nativeControlAbiFor(abi)
  const entry = config && config.abis ? config.abis[key] : undefined
  if (!entry || typeof entry.rustTarget !== 'string' || entry.rustTarget === '') {
    throw new Error('native/phone-control-core/build-config.json 里没有 ' + key + ' 的 rustTarget'
      + '（已知键：' + Object.keys((config && config.abis) || {}).join(', ') + '）')
  }
  return entry.rustTarget
}

/** 调试包的产物形态判据：与 check-apk-form.mjs **相反**（必须 debuggable，且版本号字段必须与声明一致）。 */
export function evaluateDebugBadging({ exitCode, output, spawnError, expected }) {
  if (spawnError) return { ok: false, why: 'aapt2 无法启动：' + String(spawnError.message ?? spawnError) }
  const text = String(output ?? '')
  if (exitCode !== 0) return { ok: false, why: 'aapt2 退出码 ' + String(exitCode ?? 'null') + '（badging 未产出，不得当成通过）' }
  if (text.trim() === '') return { ok: false, why: 'aapt2 输出为空（不得当成通过）' }
  const parsed = parseBadging(text)
  if (!parsed.packageName) return { ok: false, why: 'aapt2 输出不可解析（缺 package 行，输出可能被截断）' }
  if (parsed.packageName !== PACKAGE_NAME) return { ok: false, parsed, why: '包名不是 ' + PACKAGE_NAME + '（实得 ' + parsed.packageName + '）' }
  if (parsed.debuggable !== true) return { ok: false, parsed, why: '产物不含 application-debuggable：这不是调试包（assembleRelease 打出来的？）' }
  if (parsed.versionName !== expected.versionName) {
    return { ok: false, parsed, why: 'versionName 不一致：期望 ' + expected.versionName + '，产物 ' + String(parsed.versionName) }
  }
  if (String(parsed.versionCode) !== String(expected.versionCode)) {
    return { ok: false, parsed, why: 'versionCode 不一致：期望 ' + String(expected.versionCode) + '，产物 ' + String(parsed.versionCode) }
  }
  return { ok: true, parsed }
}

/** GITHUB_OUTPUT 的写入形态（单行 key=value；值里有换行会让后续 key 变成垃圾）。 */
export function formatGithubOutput(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => key + '=' + String(value).replace(/[\r\n]/g, ' '))
    .join('\n') + '\n'
}

/**
 * 解析发布仓 MANIFEST.txt 的一行，取出指定资产名对应的 sha256 与字节数。
 *
 * 行格式（实测 v0.14.11）：`<sha256>  <仓库内路径>  <字节数>`，路径带目录前缀
 * （`snapshot/snapshot-arm64.tar.xz`、`apk/dsh-mobile-apk-v0.14.11-arm64.apk`）。
 *
 * 三个判据都不能省：
 *   · **按 basename 比对而不是 endsWith**：行尾是字节数，`endsWith('snapshot-arm64.tar.xz')`
 *     恒不命中（第一版就这么写的，云端实测报「MANIFEST.txt 里没有 snapshot-arm64.tar.xz 条目」，
 *     而条目明明在 —— 这种「自己写错解析却像是资产缺失」的报错最费时间）；
 *   · 目录前缀必须取 basename 后再比，不能要求整行路径等于资产名；
 *   · 返回字节数供调用方核对大小：摘要能对上但大小对不上意味着读到的是另一份同摘要文件，
 *     概率极低，但大小几乎免费，顺手断言。
 */
export function parseManifestEntry(text, assetName) {
  for (const row of String(text ?? '').split(/\r?\n/)) {
    const parts = row.trim().split(/\s+/)
    if (parts.length < 2) continue
    const [sha, pathPart, sizePart] = parts
    if (!/^[0-9a-f]{64}$/.test(sha)) continue
    if (basename(pathPart) !== assetName) continue
    const size = sizePart === undefined ? null : Number(sizePart)
    return { sha256: sha, path: pathPart, size: Number.isSafeInteger(size) ? size : null }
  }
  return null
}

/** sha256 of a file：分块读（快照 160 MB 以上，不整体进内存）。 */
export function sha256File(path, chunkBytes = 8 * 1024 * 1024) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes)
    let read = 0
    while ((read = readSync(fd, buffer, 0, chunkBytes, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts })
  if (result.error) throw new Error(cmd + ' ' + argv.join(' ') + ' 起不来：' + result.error.message)
  if (result.status !== 0) throw new Error(cmd + ' ' + argv.join(' ') + ' 失败（exit ' + result.status + '）')
  return result
}

function capture(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', ...opts })
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim(), error: result.error }
}

const gate = (file) => join(ROOT, 'scripts', file)

export function parseArgs(argv) {
  const options = { abi: '', snapshot: '', fromRelease: null, releaseTag: '', suffix: '', versionCode: '', out: '', report: '', dryRun: false, printFacts: false, selfTest: false }
  const take = (i, name) => {
    const value = argv[i + 1]
    if (value === undefined || String(value).startsWith('--')) throw new UsageError(name + ' 需要一个值')
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--abi') options.abi = take(i++, '--abi')
    else if (arg === '--snapshot') options.snapshot = take(i++, '--snapshot')
    else if (arg === '--from-release') {
      // 可选值形态：后面紧跟参数时表示「用最新已发布 release 的快照」
      const next = argv[i + 1]
      options.fromRelease = next === undefined || String(next).startsWith('--') ? '' : argv[++i]
    } else if (arg === '--release-tag') options.releaseTag = take(i++, '--release-tag')
    else if (arg === '--suffix') options.suffix = take(i++, '--suffix')
    else if (arg === '--version-code') options.versionCode = take(i++, '--version-code')
    else if (arg === '--out') options.out = take(i++, '--out')
    else if (arg === '--report') options.report = take(i++, '--report')
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--print-facts') options.printFacts = true
    else if (arg === '--self-test') options.selfTest = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new UsageError('未知参数: ' + arg)
  }
  return options
}

/** 解析 versionCode 的真源 tag：显式 > 已发布 release（gh）> 本地 tag（git，带来源标注）。 */
export function resolveReleaseTag({ explicit = '', ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN } = {}) {
  if (explicit) return { tag: explicit, source: 'explicit' }
  // GH_TOKEN 只在真的有时才注入：注入空串会把 gh 自己的登录态压掉，于是「本地能用」的读取在 CI 之外恒失败。
  const gh = capture('gh', ['release', 'view', '--json', 'tagName', '--jq', '.tagName'],
    ghToken ? { env: { ...process.env, GH_TOKEN: ghToken } } : {})
  if (gh.status === 0 && /^v?\d+\.\d+\.\d+/.test(gh.stdout)) return { tag: gh.stdout.split('\n')[0], source: 'gh-release' }
  const tags = capture('git', ['tag', '--list', 'v*', '--sort=-v:refname'])
  const first = tags.status === 0 ? (tags.stdout.split('\n')[0] || '').trim() : ''
  if (first) return { tag: first, source: 'git-tag' }
  throw new Error('解析不到 versionCode 的绑定来源：gh release view 失败（' + (gh.stderr || gh.status) + '），git tag 也没有 v* 标签。'
    + '--release-tag 显式指定该 release 标签后重跑；不得回落到当前树的默认 versionCode')
}

/** 读某个 tag 的 app/build.gradle.kts（真源），返回 versionCode 默认值与 versionName 基线。 */
export function readVersionFactsFromTag(tag) {
  const rel = 'app/build.gradle.kts'
  const shown = capture('git', ['show', tag + ':' + rel])
  if (shown.status !== 0) throw new Error('读不到 ' + tag + ' 的 ' + rel + '（' + (shown.stderr || shown.status) + '）：tag 不存在或该 tag 没有这份文件')
  const versionCode = parseGradleDefaultVersionCode(shown.stdout)
  if (!versionCode) {
    throw new Error(tag + ' 的 ' + rel + ' 里没有 providers.gradleProperty("versionCode").getOrElse("<n>") 形态的默认值；'
      + '不得猜测绑定值——补上该形态，或用 --version-code 显式声明')
  }
  return { versionCode, baseVersionName: parseGradleBaseVersionName(shown.stdout) }
}

/** 下载 release 附带的 snapshot 资产并校验 MANIFEST 里的 sha256。 */
function downloadReleaseSnapshot({ tag, abi, dir }) {
  mkdirSync(dir, { recursive: true })
  const assetName = 'snapshot-' + abi + '.tar.xz'
  run('gh', ['release', 'download', tag, '--pattern', assetName, '--pattern', 'MANIFEST.txt', '--dir', dir, '--clobber'])
  const tar = join(dir, assetName)
  const manifest = join(dir, 'MANIFEST.txt')
  if (!existsSync(tar)) throw new Error('下载后仍没有 ' + tar)
  if (!existsSync(manifest)) throw new Error('下载后仍没有 ' + manifest + '：没有 MANIFEST 就无法独立核对字节')
  const entry = parseManifestEntry(readFileSync(manifest, 'utf8'), assetName)
  if (!entry) {
    throw new Error('MANIFEST.txt 里没有 ' + assetName + ' 条目：无法核对摘要'
      + '（该 release 也许没把快照作为资产附上；资产清单见 gh release view ' + tag + ' --json assets）')
  }
  const digest = sha256File(tar)
  if (entry.sha256 !== digest) {
    throw new Error(assetName + ' 摘要不符：MANIFEST 声明 ' + entry.sha256 + '，实际 ' + digest + '（下载被截断或资产被替换）')
  }
  if (entry.size !== null && entry.size !== statSync(tar).size) {
    throw new Error(assetName + ' 字节数不符：MANIFEST 声明 ' + entry.size + '，实际 ' + statSync(tar).size)
  }
  return { path: tar, digest, manifestSource: 'release:' + tag }
}

/**
 * 解析快照来源。`download: false` 时只算落点、不取字节——dry-run 必须不写任何文件
 * （与 build-apk.mjs 的 --dry-run 同一纪律：它是验收的机器可读入口，不能有副作用）。
 */
function resolveSnapshotSource(options, abi, { download = true } = {}) {
  if (options.fromRelease !== null && options.snapshot) {
    throw new UsageError('--snapshot 与 --from-release 互斥：一个构建只能有一个快照来源（错源 = 错 ABI/过期引擎）')
  }
  if (options.snapshot) {
    const path = resolve(options.snapshot)
    if (!existsSync(path)) throw new Error('快照不在场: ' + path + '（先跑 node scripts/build-snapshot-013.mjs ' + abi + '）')
    return { path, origin: 'explicit', coverageGate: true }
  }
  if (options.fromRelease !== null) {
    const tag = options.fromRelease || resolveReleaseTag({ explicit: options.releaseTag || '' }).tag
    const dir = join(ROOT, '.deploy-tmp', 'dev-snapshot', tag)
    if (!download) {
      return { path: join(dir, 'snapshot-' + abi + '.tar.xz'), origin: 'release:' + tag, coverageGate: false, pending: true }
    }
    const downloaded = downloadReleaseSnapshot({ tag, abi, dir })
    return { path: downloaded.path, origin: 'release:' + tag, coverageGate: false, digest: downloaded.digest }
  }
  const path = join(ROOT, '.deploy-tmp', 'snapshot-013', abi, 'snapshot.tar.xz')
  if (!existsSync(path)) {
    throw new Error('默认快照不在场: ' + path + '\n先在本 commit 上构建快照：node scripts/build-snapshot-013.mjs ' + abi
      + '\n或显式给 --snapshot <tar>，或用 --from-release 取已发布 release 的快照（会打印「不做覆盖对账」的理由）')
  }
  return { path, origin: 'tree', coverageGate: true }
}

function dirtyTrackedFiles() {
  const result = capture('git', ['status', '--porcelain', '--untracked-files=no'])
  if (result.status !== 0) return null
  return result.stdout === '' ? [] : result.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

function selfTest() {
  const testFile = join(HERE, 'build-apk-debug.test.mjs')
  if (!existsSync(testFile)) throw new Error('自检文件不在场: ' + testFile)
  run(process.execPath, ['--test', testFile])
  console.log('SELF-TEST OK ' + basename(testFile))
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log('用法: node scripts/build-apk-debug.mjs --abi arm64|x86_64 [--snapshot <tar>] [--from-release [tag]] [--release-tag <tag>]')
    console.log('       [--suffix <8位>] [--version-code <n>] [--out <dir>] [--report <file>]')
    console.log('       [--dry-run] [--print-facts] [--self-test]')
    return 0
  }
  if (options.selfTest) { selfTest(); return 0 }
  if (!SUPPORTED_ABIS.includes(options.abi)) {
    throw new UsageError('--abi 必填且只接受 ' + SUPPORTED_ABIS.join('|') + '（实得 ' + JSON.stringify(options.abi) + '）')
  }
  const abi = options.abi
  // --print-facts：只吐一行 JSON（stdout 必须只有 JSON，故不打印任何日志）。CI 用它取 rustTarget
  // 等真源事实，避免在 workflow yaml 里抄一份 ABI 表。
  if (options.printFacts) {
    const nativeConfig = readNativeBuildConfig()
    process.stdout.write(JSON.stringify({
      abi,
      snapshotAbi: SNAPSHOT_ABI_NAME[abi],
      nativeControlAbis: nativeControlAbiFor(abi),
      rustTarget: rustTargetFor(abi, nativeConfig),
      ndkVersion: nativeConfig.ndk ? nativeConfig.ndk.version : null,
      rustcVersion: nativeConfig.compiler ? nativeConfig.compiler.rustc : null,
      packageName: PACKAGE_NAME,
      gradleTask: ':app:assembleDebug',
    }) + '\n')
    return 0
  }
  const log = (m) => console.log('[build-apk-debug/' + abi + '] ' + m)

  // ---- 1. 版本号两条事实 ----
  if (!existsSync(gradleFile)) throw new Error('版本真源缺失: ' + gradleFile)
  const treeGradle = readFileSync(gradleFile, 'utf8')
  const baseVersionName = parseGradleBaseVersionName(treeGradle)
  if (!baseVersionName) throw new Error('当前树的 ' + gradleFile + ' 里没有可用的 versionName 基线')

  // versionCode 的绑定 tag：显式 --release-tag > --from-release 给的 tag > gh/git 解析到的已发布 release。
  // 取 --from-release 的 tag 是刻意的：那时快照与被绑定的版本号来自**同一个** release，
  // 「用 v0.14.10 的快照 + v0.14.11 的 versionCode」这种混搭没有任何可解释的语义。
  const boundTag = options.releaseTag
    || (typeof options.fromRelease === 'string' && options.fromRelease !== '' ? options.fromRelease : '')
  const tagInfo = resolveReleaseTag({ explicit: boundTag })
  const releaseFacts = readVersionFactsFromTag(tagInfo.tag)
  const releaseBoundVersionCode = releaseFacts.versionCode
  const versionCode = options.versionCode
    ? validateExplicitVersionCode(options.versionCode)
    : bumpVersionCode(releaseBoundVersionCode)

  const randomPart = options.suffix ? validateRandomPart(options.suffix) : randomSuffix()
  // 复用发布链的同一套命名规则（不是再造一份）：suffix 形如 -<8位>-dev，versionName = base + suffix。
  // 刻意**不**提供「直接给整个 versionName」的开关：那会让「随机段」与「版本名」成为两条可分别给定
  // 的事实，而它们必须是同一个值（randomPart 会被写进产物名并被下游按 -<段>-dev 解析）。
  const resolved = resolveVersionSuffix(baseVersionName, '', '-' + randomPart + '-' + DEV_MARKER)
  const versionName = resolved.version
  const suffix = resolved.suffix
  const artifactName = artifactNameFor({ versionName, abi })
  const outDir = options.out ? resolve(options.out) : join(ROOT, 'out', 'v' + versionName)
  const apkPath = join(outDir, artifactName)

  log('versionName = ' + versionName + '（基线 ' + baseVersionName + '，随机段 ' + randomPart + '）')
  log('versionCode = ' + versionCode + '（release ' + tagInfo.tag + ' 绑定 ' + releaseBoundVersionCode + ' + 1；来源 ' + tagInfo.source + '）')
  log('产物 = ' + apkPath)

  // ---- 2. 快照来源与 ABI ----
  // dry-run 先返：它只解析真源并打印（不下载 160 MB、不写任何文件），
  // 于是「版本号算得对不对」可以在任何机器上几秒钟看清。
  if (options.dryRun) {
    const planned = resolveSnapshotSource(options, abi, { download: false })
    log('快照（计划）= ' + planned.path + '（来源 ' + planned.origin + (planned.pending ? '，dry-run 不下载' : '') + '）')
    log('-PnativeControlAbis = ' + nativeControlAbiFor(abi) + '（由 --abi 派生）')
    console.log('DRY_RUN OK versionName=' + versionName + ' versionCode=' + versionCode + ' apk=' + apkPath
      + ' snapshot=' + planned.path + ' releaseTag=' + tagInfo.tag)
    return 0
  }
  const snapshot = resolveSnapshotSource(options, abi)
  log('快照 = ' + snapshot.path + '（来源 ' + snapshot.origin + '）')
  // ABI 门禁：elf-check 读快照内 usr/bin/node 的 e_machine，与 --abi 交叉。
  //
  // 这一行**捕获而不直传 stdio**，是为了把门禁打印出的 machine 名再喂给 assertSnapshotAbi 做一次
  // 同源交叉：elf-check 的退出码只说明「它判过了」，而它读到的 machine 名与我们要的目标 ABI
  // 是否同一件事，此前没有任何一处断言过（改错它内部的 EXPECT 表不会被任何测试抓到）。
  const elf = spawnSync(process.execPath, [gate('elf-check.mjs'), snapshot.path, abi], { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(elf.stdout || '')
  process.stderr.write(elf.stderr || '')
  if (elf.status !== 0) throw new Error('快照 ABI 门禁判红（elf-check exit ' + elf.status + '）：快照不是 ' + abi + ' 的字节')
  const machineName = (/machine:\s*([A-Za-z0-9_]+)/.exec(elf.stdout || '') || [])[1] || null
  if (!machineName) throw new Error('elf-check 通过但没打印 machine 名（输出被截断？）：无法与 --abi 交叉核对')
  assertSnapshotAbi(abi, machineName)
  log('ABI 交叉核对：快照 node machine = ' + machineName + '，目标 = ' + abi)

  // ---- 3. 插件注入 + 快照覆盖对账（注入实现与发布链同一份，见文件头）----
  //
  // **顺序硬约束**：注入在前、覆盖对账在后。
  // check-snapshot-packages.mjs 比对的是 engine-overlay.json / plugin-dirs.json 里的包与插件目录
  // 是否**真的在 tar 里**，而未注入的快照（build-snapshot-013.mjs 的产物）恰恰一个插件都没有 ——
  // 先跑它必然恒红，且红的是「还没轮到注入」这个事实，不是快照有问题。已发布 release 的快照是
  // 注入后的形态，但登记面在本 commit 又往前走了（实测 v0.14.11 快照缺 phone-control 目录），
  // 于是那一档同样不该用本判据（见下面 else 分支）。
  let assembledSnapshot = snapshot.path
  if (snapshot.coverageGate) {
    // 输入快照是**未注入**的。注入与注入后门禁全部由发布链的 build-apk.mjs 负全责
    // （--emit-snapshot 在「注入后门禁全部通过」与 Gradle 之间把快照交出来），这里不重写一份：
    // 两份注入实现 = 两个插件树，而设备上只表现为某个插件行为不一致。
    const injectedDir = join(ROOT, '.deploy-tmp', 'dev-inject', abi)
    mkdirSync(injectedDir, { recursive: true })
    assembledSnapshot = join(injectedDir, 'snapshot.tar.xz')
    log('注入 + 注入后门禁（复用 build-apk.mjs --emit-snapshot）…')
    run(process.execPath, [gate('build-apk.mjs'), '--abi', abi, '--snapshot', snapshot.path, '--emit-snapshot', assembledSnapshot])
    if (!existsSync(assembledSnapshot)) throw new Error('注入链没有交出快照: ' + assembledSnapshot)
    log('注入后快照 = ' + assembledSnapshot + '（sha256 ' + sha256File(assembledSnapshot) + '）')
    log('门禁：快照包覆盖（overlay 引擎包 + 插件登记，作用于**注入后**的 tar）…')
    run(process.execPath, [gate('check-snapshot-packages.mjs'), '--snapshot', assembledSnapshot])
  } else {
    // 为什么不做覆盖对账：该门禁比对的是**当前树**的 engine-overlay.json / plugin-dirs.json 与该快照内容。
    // 已发布 release 的快照必然早于 main 上的登记变化（实测 v0.14.11 快照缺
    // @dsh-android/dsh-android-phone-control，而它在本 commit 已登记），此时判据只会产出永久假红。
    // 这类快照的等价保障是「发布时的字节 + MANIFEST sha256 已核对 + ABI 已核对」，不是树内对账。
    // 同理不再注入：release 资产已经是**注入后**的形态（发布链导出的是 out/ 里那份），
    // 再注入一遍会把两轮装配叠在一起。
    log('跳过注入与覆盖对账（快照来自 ' + snapshot.origin + '：已是发布链注入后的字节，'
      + '等价保障 = MANIFEST sha256 已核对 + ABI 已核对）')
  }

  // ---- 4. 签名门禁自证 + 构建 ----
  run(process.execPath, [gate('check-apk-signatures.mjs'), '--self-test'])
  // ABI <-> nativeControlAbis 由**本脚本**单点派生并注入 Gradle 环境：写成两条独立事实
  // （workflow env 一处、脚本一处）就会出现「arm64 包带 x86_64 .so」这种只能靠反编译发现的分裂。
  process.env.ORG_GRADLE_PROJECT_nativeControlAbis = nativeControlAbiFor(abi)
  log('-PnativeControlAbis = ' + process.env.ORG_GRADLE_PROJECT_nativeControlAbis + '（由 --abi 派生）')
  log('构建调试变体（:app:assembleDebug；application-debuggable 是本产物的期望值）…')
  const built = assembleApk({
    snapshot: assembledSnapshot,
    apkDir,
    outputDir: outDir,
    artifactName,
    suffix,
    versionCode,
    buildType: 'debug',
    clean: true,
    abi,
    fingerprintGate: gate('check-snapshot-fingerprint.mjs'),
    signatureGate: gate('check-apk-signatures.mjs'),
    // 引擎默认会在交付前跑发布链的产物形态门禁（判据 = **不得**含 application-debuggable）。
    // 对 debug 变体那条判据恒红，而恒红的正确处置不是删判据、也不是让判据变绿：是**反向断言**。
    // 这里关掉发布链那一档，紧接着（下面 ---- 5. ----）自己断言「必须含 application-debuggable，
    // 且 versionName/versionCode/包名逐字相符」。签名门禁不关 —— debug 与 release 同一把 key。
    verifyForm: false,
    log,
  }, (cmd, argv2, opts) => spawnSync(cmd, argv2, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit', ...opts }))

  // ---- 4b. 内嵌快照真的能解压（与发布链同一道门禁，须紧跟 assemble）----
  //
  // 位置与 build-apk.mjs:537 同理：此刻 assets/snapshot.tar.xz **正是**被复制进 APK 的那份字节，
  // 跑它验的是本次产物；早于 assemble 跑则验的是上一次构建的残留。判据 = 用与设备同一套
  // streaming 解码器完整解压一遍，证明「摘要自洽但字节流解不开」这种形态进不了调试包。
  log('门禁：内嵌快照可解压（设备同源 streaming 解码器全量解压）…')
  run(process.execPath, [gate('check-snapshot-decode.mjs'), '--tar', join(apkDir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz'), '--require'])

  // ---- 5. 产物形态：必须是 debuggable，且版本字段与声明逐字相同 ----
  const aapt2 = resolveAapt2(process.env.DSH_AAPT2)
  if (!aapt2) throw new Error('找不到 aapt2（--aapt2 / ANDROID_HOME / ANDROID_SDK_ROOT / 默认 SDK 布局）：'
    + '刚打完包的机器必有 SDK，缺件是真缺陷而不是「跳过」的理由')
  log('产物形态判据：aapt2=' + aapt2)
  const badging = capture(aapt2, ['dump', 'badging', built], { maxBuffer: 32 * 1024 * 1024 })
  const verdict = evaluateDebugBadging({
    exitCode: badging.error ? 0 : badging.status,
    output: badging.stdout + badging.stderr,
    spawnError: badging.error,
    expected: { versionName, versionCode },
  })
  if (!verdict.ok) throw new Error('DEBUG APK FORM CHECK FAILED：' + verdict.why)
  log('PASS 产物是 debuggable 变体，versionName=' + verdict.parsed.versionName + ' versionCode=' + verdict.parsed.versionCode)
  const apkSha256 = sha256File(built)

  // ---- 6. 报告 + GitHub 输出/摘要 ----
  const dirty = dirtyTrackedFiles()
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    abi,
    versionName,
    versionCode,
    versionCodeSource: { releaseTag: tagInfo.tag, releaseBoundVersionCode, tagSource: tagInfo.source },
    baseVersionName,
    randomPart,
    devMarker: DEV_MARKER,
    artifactName,
    apk: built,
    apkSha256,
    apkBytes: statSync(built).size,
    packageName: verdict.parsed.packageName,
    debuggable: verdict.parsed.debuggable,
    minSdk: verdict.parsed.minSdk,
    targetSdk: verdict.parsed.targetSdk,
    snapshot: {
      source: snapshot.path,
      origin: snapshot.origin,
      coverageGate: snapshot.coverageGate,
      assembled: assembledSnapshot,
      assembledSha256: assembledSnapshot === snapshot.path ? (snapshot.digest || sha256File(assembledSnapshot)) : sha256File(assembledSnapshot),
    },
    nativeControlAbis: process.env.ORG_GRADLE_PROJECT_nativeControlAbis,
    commit: (capture('git', ['rev-parse', 'HEAD']).stdout || '') || null,
    dirtyTrackedFiles: dirty,
  }
  const reportPath = options.report ? resolve(options.report) : join(outDir, 'dev-build-report.json')
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8')
  log('报告 = ' + reportPath)

  const outputFile = process.env.GITHUB_OUTPUT
  if (outputFile) {
    appendFileSync(outputFile, formatGithubOutput({
      version_name: versionName,
      version_code: versionCode,
      release_tag: tagInfo.tag,
      release_version_code: releaseBoundVersionCode,
      random_part: randomPart,
      artifact_name: artifactName,
      apk_path: built,
      apk_sha256: apkSha256,
      report_path: reportPath,
      abi,
    }))
  }
  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    const rows = [
      ['ABI', abi],
      ['versionName', versionName],
      ['versionCode', String(versionCode) + '（release ' + tagInfo.tag + ' 绑定 ' + releaseBoundVersionCode + ' + 1）'],
      ['包名', verdict.parsed.packageName],
      ['minSdk / targetSdk', String(verdict.parsed.minSdk) + ' / ' + String(verdict.parsed.targetSdk)],
      ['debuggable', 'true（调试包期望值）'],
      ['nativeControlAbis', String(process.env.ORG_GRADLE_PROJECT_nativeControlAbis)],
      ['快照来源', snapshot.path + '（' + snapshot.origin + '）'],
      ['装配用快照', assembledSnapshot],
      ['APK 字节', String(report.apkBytes)],
      ['APK SHA-256', apkSha256],
    ]
    appendFileSync(summaryFile, '\n### 调试包（' + abi + '）\n\n| 项 | 值 |\n| --- | --- |\n'
      + rows.map(([k, v]) => '| ' + k + ' | ' + String(v).replace(/\|/g, '\\|') + ' |').join('\n') + '\n')
  }
  console.log('=== 完成（' + abi + ' 调试包）===\nAPK=' + built + '\nversionName=' + versionName + ' versionCode=' + versionCode)
  return 0
}

/** 显式 --version-code：与 +1 语义无关，但仍要同一套边界校验。 */
function validateExplicitVersionCode(text) {
  const value = Number(String(text).trim())
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERSION_CODE) {
    throw new UsageError('--version-code 必须是 1..' + MAX_VERSION_CODE + ' 的整数（实得 ' + JSON.stringify(text) + '）')
  }
  return value
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error('[build-apk-debug] 用法错误：' + error.message)
      process.exitCode = 2
    } else {
      console.error('[build-apk-debug] ' + (error && error.message ? error.message : String(error)))
      process.exitCode = 1
    }
  }
}
