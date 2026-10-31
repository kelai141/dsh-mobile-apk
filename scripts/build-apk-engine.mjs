#!/usr/bin/env node
// Shared per-ABI APK terminal engine.
// The local PowerShell chain, portable Node chain, and release assembler keep
// their own gates and snapshot preparation, then converge here for the exact
// snapshot -> fingerprint -> Gradle -> artifact -> signature sequence.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function execute(command, args, options = {}, runner = spawnSync) {
  const result = runner(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    // Direct executables such as process.execPath must bypass cmd.exe on Windows;
    // shell:true splits paths like "C:\\Program Files\\nodejs\\node.exe".
    // Batch Gradle launchers opt into a shell at their call site below.
    shell: options.shell ?? false,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? 'null'})`)
  }
  return result
}

/**
 * Build types the terminal stage knows how to drive.
 *
 * Why an explicit list instead of "whatever string the caller passed": the build
 * type decides BOTH the Gradle task (`:app:assemble<Type>`) and the directory
 * Gradle writes into (`app/build/outputs/apk/<type>`). A typo would otherwise
 * surface three steps later as "Gradle succeeded but APK is missing", after a
 * full build. `release` is the production default (issue #1118); `debug` stays
 * selectable because the variant negative-control test needs it, and because a
 * future `official`-style type must be addable without rewriting this function.
 */
export const BUILD_TYPES = ['release', 'debug']

/**
 * Run the common APK assembly terminal stage. Callers own ABI selection,
 * gates, injection and artifact naming; this function owns assets, Gradle,
 * copying and strict fingerprint verification.
 *
 * `buildType` selects the Gradle variant and defaults to `release` (issue #1118).
 * It is a parameter rather than a literal because the variant is exactly the thing
 * that must stay testable: a regression that flips it back to `debug` has to be
 * catchable by a test, and that test needs to be able to ask for `debug` on purpose.
 */
export function assembleApk(options, runner = spawnSync) {
  const {
    snapshot,
    apkDir,
    outputDir,
    artifactName,
    suffix = '',
    buildType = 'release',
    gradleCommand,
    clean = false,
    log = console.log,
    fingerprintGate = join(SCRIPT_DIR, 'check-snapshot-fingerprint.mjs'),
    /** 签名门禁脚本；供 verify-back-before-delivery 与测试注入。 */
    signatureGate = join(SCRIPT_DIR, 'check-apk-signatures.mjs'),
    /** 交付前是否验签（默认 true）。关掉只有一种正当理由：分阶段构建里签名由别处负全责。 */
    verifySignatures = true,
  } = options
  if (!snapshot || !apkDir || !outputDir || !artifactName) {
    throw new Error('assemble requires snapshot, apkDir, outputDir, and artifactName')
  }
  const sourceSnapshot = resolve(snapshot)
  const resolvedApkDir = resolve(apkDir)
  const resolvedOutputDir = resolve(outputDir)
  if (!existsSync(sourceSnapshot)) throw new Error(`snapshot not found: ${sourceSnapshot}`)

  const assetDir = join(resolvedApkDir, 'app', 'src', 'main', 'assets')
  const assetSnapshot = join(assetDir, 'snapshot.tar.xz')
  const fingerprint = join(assetDir, 'snapshot.sha256')
  const intermediates = join(resolvedApkDir, 'app', 'build', 'intermediates', 'assets')
  // 发布资产必须来自 release 变体（issue #1118）：assembleDebug 的产物带
  // android:debuggable，会开放 adb attach 与 WebView 远程调试，部分 ROM 也会拒装。
  // 签名配置在 release / debug 两边同为 repoDebug，所以切变体不换证书，
  // 现有用户的覆盖升级不受影响（实测 -r 安装无 INSTALL_FAILED_UPDATE_INCOMPATIBLE）。
  //
  // 变体由 buildType 单点派生：Gradle 任务、陈旧产物清理目录、取产物目录三处必须
  // 同一个值。此前这三处是各自写死 'release' 的字面量，改变体要改三处且漏一处不会
  // 当场报错——只会表现为「清掉了 A 目录却从 B 目录取产物」这种假绿。
  if (!BUILD_TYPES.includes(buildType)) {
    throw new Error(`unsupported buildType "${buildType}" (expected one of: ${BUILD_TYPES.join(', ')})`)
  }
  const variantOutput = join(resolvedApkDir, 'app', 'build', 'outputs', 'apk', buildType)
  const builtApk = join(variantOutput, `app-${buildType}.apk`)
  const deliveredApk = join(resolvedOutputDir, artifactName)

  mkdirSync(assetDir, { recursive: true })
  mkdirSync(resolvedOutputDir, { recursive: true })
  // Never let a successful no-op/incremental Gradle invocation reuse an older APK.
  // Release mode preserves unrelated intermediates, but the terminal APK output is always fresh.
  rmSync(variantOutput, { recursive: true, force: true })
  // 交付目录里**同名**的旧产物也一并清掉（issue #1077）。
  //
  // 只清本函数负责的那一个名字，不碰目录里的其他文件：多 ABI 构建共用同一交付目录，
  // 按目录清空会删掉本轮另一个 ABI 刚产出的包（那正是「先传后删」类事故的形态）。
  // 清掉它的意义是让「文件存在」等价于「本次构建产出且已验签」——否则一次失败构建
  // 留下的旧文件会一直被当成这一轮的交付物。
  rmSync(deliveredApk, { force: true })
  if (clean) {
    rmSync(intermediates, { recursive: true, force: true })
  }
  copyFileSync(sourceSnapshot, assetSnapshot)
  const sha = createHash('sha256').update(readFileSync(sourceSnapshot)).digest('hex')
  writeFileSync(fingerprint, sha, 'ascii')
  log(`snapshot.sha256 = ${sha}`)

  // Generate exact product ownership only from the final injected archive. The
  // separately packaged manifest binds itself to this tar hash, avoiding a hash cycle.
  const hardManifest = join(assetDir, 'plugin-hard-manifest.json')
  execute(process.execPath, [join(SCRIPT_DIR, 'build-hard-manifest.mjs'), '--snapshot', sourceSnapshot, '--out', hardManifest],
    { cwd: SCRIPT_DIR }, runner)

  execute(process.execPath, [fingerprintGate, '--require'], { cwd: SCRIPT_DIR }, runner)

  const gradle = gradleCommand ?? (process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
  const gradleArgs = [`:app:assemble${buildType === 'release' ? 'Release' : 'Debug'}`, '--no-daemon', `-PversionNameSuffix=${suffix}`]
  log(`Gradle: ${gradle} ${gradleArgs.join(' ')}`)
  execute(gradle, gradleArgs, { cwd: resolvedApkDir, shell: process.platform === 'win32' }, runner)

  if (!existsSync(builtApk)) throw new Error(`Gradle succeeded but APK is missing: ${builtApk} (buildType=${buildType})`)

  // 验签必须在**拷进交付目录之前**（issue #1077）。
  //
  // 真因：此前这里直接 `copyFileSync(builtApk, deliveredApk)`，签名判定只在调用方、且发生在
  // 整个 ABI 循环收尾之后。于是有两个后果：
  //   ① 从这次拷贝到门禁判红之间，交付目录里存在一个**未通过验签**的 APK——中间任何一步
  //      （上传、清单、别的门禁扫目录）都会把它当成产物；
  //   ② 门禁抛出后该文件**不会**被删，下一次构建 `check-apk-signatures --dir` 递归又会命中它，
  //      于是这个版本从此每次构建恒红，哪怕当前产物是好的。
  // 把验签挪进终端阶段（拷贝之前）后，「交付目录里的 APK 都是验过的」由构造保证，
  // 不再依赖调用方记得在哪一步调门禁。调用方的 --dir 复扫保留（它还能兜住陈旧文件）。
  if (verifySignatures) {
    const keystorePath = options.keystore ?? join(SCRIPT_DIR, '..', 'keystore', 'debug.keystore')
    verifyApks({
      files: [builtApk],
      keystore: keystorePath,
      signatureGate,
      // 调用方各自会跑 --self-test（本地/portable/发布三路都跑过），这里不重复。
      selfTest: false,
      log,
    }, runner)
  }
  copyFileSync(builtApk, deliveredApk)
  log(`产物: ${deliveredApk}`)
  return deliveredApk
}

/**
 * Validate the exact output scope used by a caller (directory or files).
 *
 * Two judgements share this single "final artifact" checkpoint because both are
 * properties of the delivered bytes, not of the build inputs:
 *   - signature: v1/v2/v3 all true, signing certificate == the repository keystore;
 *   - form: `aapt2 dump badging` must not contain `application-debuggable`.
 * Why they belong together: a correct signature says nothing about the variant.
 * The 0.14.9 release artifacts were debug variants (the chain ran
 * `:app:assembleDebug` while debug and release share signingConfigs.repoDebug), so
 * they passed the signature gate with v1/v2/v3 all true and were still debuggable.
 * Since issue #1118 the chain builds `:app:assembleRelease` by default, so the form
 * stage is now a regression guard rather than a permanently-red assertion — and it
 * stays the thing that catches a build type silently flipped back to `debug`.
 * The form stage runs with `--require`: on a machine that just built an APK the SDK
 * is necessarily present, so an unresolvable aapt2 is a real defect, not an excuse
 * to skip the judgement.
 */
/**
 * issue #1031（后半）：keystore 的 alias 与口令**没有任何内置兜底**，必须由调用方显式声明。
 *
 * 病灶形态：旧实现在检查器里写 `process.env.DSH_APK_KEYSTORE_ALIAS || 'androiddebugkey'`。
 * 这两个字面量只对仓库自带的那把 debug keystore 成立，而检查器要被任意 `--keystore` 调用——
 * 于是换成任何一把真实发布钥（alias/口令都不同）时 keytool 必然导出失败，报
 * 「cannot export the repository signing certificate」，而那份 APK 的签名完全合法、
 * 锚也已按文档同步。实测：证书合法 + alias=releasekey + 非默认口令 -> exit 1。
 *
 * 修法分两层，职责不同：
 *   - 检查器（check-apk-signatures.mjs）：**零默认值**。凭据缺席即判红并点名补法，
 *     绝不回落到任何字面量。它不知道调用方拿的是哪把钥匙，也就没有资格猜。
 *   - 本引擎：它是**唯一**同时选定 keystore 路径与凭据的地方（默认 `keystore/debug.keystore`
 *     配下面这份公开凭据）。配对关系写在一处、可被读见，不是散落的猜测。
 * 换发布钥的调用方有两条路且都不必改代码：`--keystore-alias/--keystore-pass`，或
 * `DSH_APK_KEYSTORE_ALIAS/DSH_APK_KEYSTORE_PASS`（优先级：CLI > 环境变量 > 本常量）。
 */
export const REPO_DEBUG_KEYSTORE_CREDENTIALS = Object.freeze({ alias: 'androiddebugkey', pass: 'android' })

/** 凭据优先级：显式参数 > 环境变量 > 仓库 debug keystore 的公开凭据。 */
export function resolveEngineKeystoreCredentials({ keystoreAlias, keystorePass, env = process.env } = {}) {
  return {
    alias: keystoreAlias ?? (env?.DSH_APK_KEYSTORE_ALIAS || REPO_DEBUG_KEYSTORE_CREDENTIALS.alias),
    pass: keystorePass ?? (env?.DSH_APK_KEYSTORE_PASS || REPO_DEBUG_KEYSTORE_CREDENTIALS.pass),
  }
}

export function verifyApks({ directories = [], files = [], signatureGate = join(SCRIPT_DIR, 'check-apk-signatures.mjs'), formGate = join(SCRIPT_DIR, 'check-apk-form.mjs'), keystore = join(SCRIPT_DIR, '..', 'keystore', 'debug.keystore'), keystoreAlias, keystorePass, selfTest = true, log = console.log }, runner = spawnSync) {
  const targets = [...directories.flatMap((directory) => ['--dir', resolve(directory)]),
    ...files.flatMap((file) => ['--apk', resolve(file)])]
  if (!targets.length) throw new Error('signature verification requires at least one directory or APK')
  // 环境变量必须能穿透本引擎：否则引擎恒传显式 flag 会把调用方的环境变量压掉，
  // 那条「不改代码就能换钥」的路就只剩 CLI 一条（实测过这个缺口）。
  const { alias, pass } = resolveEngineKeystoreCredentials({ keystoreAlias, keystorePass })
  log('验证最终输出 APK 的 v1/v2/v3 签名…')
  if (selfTest) execute(process.execPath, [signatureGate, '--self-test'], { cwd: SCRIPT_DIR }, runner)
  execute(process.execPath, [signatureGate, ...targets, '--keystore', resolve(keystore),
    '--keystore-alias', alias, '--keystore-pass', pass], { cwd: SCRIPT_DIR }, runner)
  log('验证最终输出 APK 的产物形态（不得含 application-debuggable）…')
  if (selfTest) execute(process.execPath, [formGate, '--self-test'], { cwd: SCRIPT_DIR }, runner)
  execute(process.execPath, [formGate, ...targets, '--require'], { cwd: SCRIPT_DIR }, runner)
}

export function parseArgs(argv) {
  const [action, ...rest] = argv
  const options = { action, clean: false }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--clean') options.clean = true
    else if (arg === '--skip-self-test') options.skipSelfTest = true
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      options[key] = rest[++i] ?? ''
    } else throw new Error(`unexpected argument: ${arg}`)
  }
  return options
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.action === 'assemble') {
    assembleApk({ ...options, gradleCommand: options.gradle })
    return
  }
  if (options.action === 'verify') {
    verifyApks({
      directories: options.dir ? [options.dir] : [],
      files: options.apk ? [options.apk] : [],
      keystore: options.keystore ? resolve(options.keystore) : undefined,
      // issue #1031：显式覆盖 keystore 凭据（换发布钥的调用方走这里，不必改代码）。
      keystoreAlias: options.keystoreAlias,
      keystorePass: options.keystorePass,
      selfTest: !options.skipSelfTest,
      signatureGate: options.signatureGate ? resolve(options.signatureGate) : undefined,
      formGate: options.formGate ? resolve(options.formGate) : undefined,
    })
    return
  }
  throw new Error('usage: node scripts/build-apk-engine.mjs assemble|verify [options]'
    + ' (assemble: --snapshot --apk-dir --output-dir --artifact-name [--suffix] [--build-type release|debug] [--clean] [--gradle])')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`APK build engine failed: ${error.message}`)
    process.exitCode = 1
  }
}
