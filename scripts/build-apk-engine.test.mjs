import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_TYPES, assembleApk, parseArgs, verifyApks, resolveEngineKeystoreCredentials } from './build-apk-engine.mjs'
import { evaluateBadging } from './check-apk-form.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-build-engine-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const apkDir = join(root, 'apk')
  const outputDir = join(root, 'out')
  const snapshot = join(root, 'snapshot.tar.xz')
  mkdirSync(apkDir, { recursive: true })
  writeFileSync(snapshot, Buffer.from('test-snapshot-bytes'))
  return { root, apkDir, outputDir, snapshot }
}

test('shared terminal engine installs snapshot and fingerprint, builds, then copies the caller-named artifact', (t) => {
  const f = fixture(t)
  const oldIntermediates = join(f.apkDir, 'app', 'build', 'intermediates', 'assets', 'stale')
  const oldOutput = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'release', 'stale.apk')
  mkdirSync(join(oldIntermediates, '..'), { recursive: true })
  mkdirSync(join(oldOutput, '..'), { recursive: true })
  writeFileSync(oldIntermediates, 'stale')
  writeFileSync(oldOutput, 'stale')
  const calls = []
  const runner = (command, args, options) => {
    calls.push({ command, args, options })
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 0 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) {
      const out = args[args.indexOf('--out') + 1]
      writeFileSync(out, JSON.stringify({ schema: 1, complete: true, fingerprint: 'fixture', entries: [{ id: 'factory', name: 'factory-plugin' }] }))
      return { status: 0 }
    }
    // issue #1077：终端阶段在拷贝进交付目录**之前**就对 Gradle 产物验签。
    // 这里断言它判的是 am build 的输出，而不是交付目录里那份尚未存在的拷贝。
    if (args[0]?.endsWith('check-apk-signatures.mjs')) {
      assert.equal(command, process.execPath)
      assert.ok(args.includes('--apk'), '签名段必须按文件验，不是按目录')
      assert.equal(args[args.indexOf('--apk') + 1], join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'))
      return { status: 0 }
    }
    // issue #1119：产物形态门禁（--self-test 与 --dir 两段）也在终端阶段里，同样要放行。
    if (args[0]?.endsWith('check-apk-form.mjs')) return { status: 0 }
    assert.equal(command, process.platform === 'win32' ? 'gradlew.bat' : './gradlew')
    // 发布资产从 release 变体产出（issue #1118）：debug 变体带 android:debuggable。
    assert.deepEqual(args, [':app:assembleRelease', '--no-daemon', '-PversionNameSuffix=-preview'])
    const built = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
    mkdirSync(join(built, '..'), { recursive: true })
    writeFileSync(built, Buffer.from('signed-test-apk'))
    return { status: 0 }
  }

  const result = assembleApk({
    snapshot: f.snapshot,
    apkDir: f.apkDir,
    outputDir: f.outputDir,
    artifactName: 'custom-name-x86_64.apk',
    suffix: '-preview',
    clean: true,
    fingerprintGate: '/tools/check-snapshot-fingerprint.mjs',
    log() {},
  }, runner)

  assert.equal(result, join(f.outputDir, 'custom-name-x86_64.apk'))
  assert.equal(readFileSync(join(f.apkDir, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz')).toString(), 'test-snapshot-bytes')
  assert.equal(readFileSync(join(f.apkDir, 'app', 'src', 'main', 'assets', 'snapshot.sha256'), 'utf8'),
    createHash('sha256').update(readFileSync(f.snapshot)).digest('hex'))
  assert.equal(readFileSync(result).toString(), 'signed-test-apk')
  assert.ok(existsSync(join(f.apkDir, 'app', 'src', 'main', 'assets', 'plugin-hard-manifest.json')))
  assert.equal(existsSync(oldIntermediates), false)
  // 5 段：hard-manifest -> fingerprint -> Gradle -> 验签 -> 产物形态
  // （#1077 把验签提到拷贝之前；#1119 在验签之后追加了产物形态一段。
  //  assembleApk 里 selfTest=false —— 调用方三路各自跑过 --self-test，这里不重复。）
  assert.equal(calls.length, 5)
  assert.equal(calls[0].args[0].endsWith('build-hard-manifest.mjs'), true)
  assert.equal(calls[0].args[calls[0].args.indexOf('--snapshot') + 1], resolve(f.snapshot))
  assert.equal(calls[0].args[calls[0].args.indexOf('--out') + 1], join(f.apkDir, 'app', 'src', 'main', 'assets', 'plugin-hard-manifest.json'))
  assert.equal(calls[0].options.cwd, resolve(fileURLToPath(new URL('.', import.meta.url))))
  assert.equal(calls[0].options.shell, false, 'Node build hooks execute directly on Windows')
  assert.deepEqual(calls[1].args.slice(-1), ['--require'])
  assert.equal(calls[1].options.cwd, resolve(fileURLToPath(new URL('.', import.meta.url))))
  assert.equal(calls[1].options.shell, false)
  assert.equal(calls[2].options.cwd, resolve(f.apkDir))
  assert.equal(calls[2].options.shell, process.platform === 'win32')
  assert.equal(calls[3].args[0].endsWith('check-apk-signatures.mjs'), true, '验签必须在拷贝之前')
  assert.equal(calls[4].args[0].endsWith('check-apk-form.mjs'), true, '产物形态（#1119）必须在拷贝之前')
  assert.equal(calls[4].options.cwd, resolve(fileURLToPath(new URL('.', import.meta.url))))
})

test('fingerprint rejection stops before Gradle and a Gradle failure does not copy an artifact', (t) => {
  const f = fixture(t)
  let gradleCalls = 0
  assert.throws(() => assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'failed.apk', fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => {
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 1 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) return { status: 0 }
    gradleCalls += 1
    return { status: 0 }
  }), /failed \(1\)/)
  assert.equal(gradleCalls, 0)

  assert.throws(() => assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'failed.apk', fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => args[0]?.endsWith('check-snapshot-fingerprint.mjs') ? { status: 0 }
    : args[0]?.endsWith('build-hard-manifest.mjs') ? { status: 0 } : { status: 7 }), /failed \(7\)/)
  assert.equal(existsSync(join(f.outputDir, 'failed.apk')), false)
})

test('release mode preserves existing intermediates when clean is not requested', (t) => {
  const f = fixture(t)
  const marker = join(f.apkDir, 'app', 'build', 'intermediates', 'assets', 'preserve-me')
  mkdirSync(join(marker, '..'), { recursive: true })
  writeFileSync(marker, 'existing')
  assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'release-arm64-v8a.apk', suffix: '', gradleCommand: 'custom-gradle', log() {},
  }, (command, args) => {
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 0 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) return { status: 0 }
    // #1077：终端阶段在拷贝前先验签，这一支不得被当成 gradle 调用。
    if (args[0]?.endsWith('check-apk-signatures.mjs')) return { status: 0 }
    // #1119：签名之后还有产物形态门禁，同样不是 gradle 调用。
    if (args[0]?.endsWith('check-apk-form.mjs')) return { status: 0 }
    assert.equal(command, 'custom-gradle')
    const built = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
    mkdirSync(join(built, '..'), { recursive: true })
    writeFileSync(built, 'release-apk')
    return { status: 0 }
  })
  assert.equal(readFileSync(marker, 'utf8'), 'existing')
})

test('every assemble removes stale APK output of the SELECTED variant before Gradle so a zero-work success cannot deliver it', (t) => {
  const f = fixture(t)
  const releaseOutput = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'release')
  const debugOutput = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'debug')
  mkdirSync(releaseOutput, { recursive: true })
  mkdirSync(debugOutput, { recursive: true })
  writeFileSync(join(releaseOutput, 'app-release.apk'), 'stale-release-apk')
  // 另一个变体的陈旧产物：既不得被当成本次交付物，也不该被误清（清理范围 = 所选变体）。
  writeFileSync(join(debugOutput, 'app-debug.apk'), 'stale-debug-apk')
  assert.throws(() => assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'fresh.apk', fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => args[0]?.endsWith('check-snapshot-fingerprint.mjs')
    ? { status: 0 }
    : { status: 0 }), /APK is missing/)
  assert.equal(existsSync(join(releaseOutput, 'app-release.apk')), false, '所选变体（release）的陈旧产物必须已被清掉')
  assert.equal(readFileSync(join(debugOutput, 'app-debug.apk'), 'utf8'), 'stale-debug-apk', '未选变体的目录不在清理范围内')
  assert.equal(existsSync(join(f.outputDir, 'fresh.apk')), false)
})

test('buildType selects both the Gradle task and the variant output directory', (t) => {
  const f = fixture(t)
  const seen = []
  assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'debug-variant.apk', buildType: 'debug',
    fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => {
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 0 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) return { status: 0 }
    seen.push(args)
    const built = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    mkdirSync(join(built, '..'), { recursive: true })
    writeFileSync(built, 'debug-variant-apk')
    return { status: 0 }
  })
  // 构建类型没有被写死成 release：这是「受控负控」与将来 official 变体可用的前提。
  assert.deepEqual(seen[0], [':app:assembleDebug', '--no-daemon', '-PversionNameSuffix='])
  assert.equal(readFileSync(join(f.outputDir, 'debug-variant.apk'), 'utf8'), 'debug-variant-apk')
})

test('an unknown buildType fails before Gradle runs instead of surfacing as a missing APK', (t) => {
  const f = fixture(t)
  let gradleCalls = 0
  assert.throws(() => assembleApk({
    snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
    artifactName: 'typo.apk', buildType: 'relese',
    fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
  }, (command, args) => {
    if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 0 }
    if (args[0]?.endsWith('build-hard-manifest.mjs')) return { status: 0 }
    gradleCalls += 1
    return { status: 0 }
  }), /unsupported buildType "relese"/)
  assert.equal(gradleCalls, 0, '拼错构建类型时不得先跑一次全量 Gradle 再报「APK is missing」')
})

test('assemble --build-type is parsed into the option the engine reads', () => {
  assert.equal(parseArgs(['assemble', '--build-type', 'debug']).buildType, 'debug')
  assert.deepEqual(BUILD_TYPES, ['release', 'debug'])
})

test('shared final-artifact stage self-tests and verifies signatures then form of the caller-selected scope', () => {
  const calls = []
  verifyApks({
    directories: ['/release/apk'],
    signatureGate: '/tools/check-apk-signatures.mjs',
    formGate: '/tools/check-apk-form.mjs',
    keystore: '/release/debug.keystore',
    log() {},
  }, (command, args, options) => { calls.push({ command, args, options }); return { status: 0 } })
  // Both judgements are properties of the delivered bytes, so they share one checkpoint:
  // self-test + verify for the signature gate, then self-test + verify for the form gate.
  assert.equal(calls.length, 4)
  assert.deepEqual(calls[0].args, ['/tools/check-apk-signatures.mjs', '--self-test'])
  // issue #1031：keystore 凭据必须显式传给检查器——门禁不再内置「猜一个默认值」的回落。
  assert.deepEqual(calls[1].args, ['/tools/check-apk-signatures.mjs', '--dir', resolve('/release/apk'), '--keystore', resolve('/release/debug.keystore'),
    '--keystore-alias', 'androiddebugkey', '--keystore-pass', 'android'])
  assert.deepEqual(calls[2].args, ['/tools/check-apk-form.mjs', '--self-test'])
  // --require: a build machine ships an SDK, so an unresolvable aapt2 must fail rather than skip.
  assert.deepEqual(calls[3].args, ['/tools/check-apk-form.mjs', '--dir', resolve('/release/apk'), '--require'])
  assert.equal(calls[0].command, process.execPath)
  assert.equal(calls[0].options.shell, false, 'signature gate must use Node directly on Windows')
  assert.equal(calls[1].options.shell, false, 'signature gate must use Node directly on Windows')
  assert.equal(calls[2].options.shell, false, 'form gate must use Node directly on Windows')
  assert.equal(calls[3].options.shell, false, 'form gate must use Node directly on Windows')
})

test('受控负控：把构建类型改回 debug 后，最终产物形态门禁必须判红并中止交付（release 同一路径判绿）', (t) => {
  // 双向受控负控：同一个 assemble + verify 终端段，只改 buildType 一个输入。
  // 判红不是「模拟一个失败」，而是把该变体真实的 badging 交给 check-apk-form.mjs 的**同一个判定函数**
  // （evaluateBadging）算出的结论 —— 判据与生产同源，不是测试自己另写一份。
  const releaseBadging = [
    "package: name='com.dsharnessmobile.shell' versionCode='53' versionName='0.14.9'",
    "minSdkVersion:'26'",
    "targetSdkVersion:'34'",
    "launchable-activity: name='com.dsharnessmobile.shell.MainActivity'  label='' icon=''",
  ].join('\n')
  const debugBadging = releaseBadging.replace('launchable-activity:', 'application-debuggable\nlaunchable-activity:')
  const releaseVerdict = evaluateBadging({ exitCode: 0, output: releaseBadging })
  const debugVerdict = evaluateBadging({ exitCode: 0, output: debugBadging })
  assert.equal(releaseVerdict.ok, true)
  assert.equal(debugVerdict.ok, false)

  const run = (buildType, verdict) => {
    const f = fixture(t)
    const delivered = assembleApk({
      snapshot: f.snapshot, apkDir: f.apkDir, outputDir: f.outputDir,
      artifactName: buildType + '.apk', buildType,
      fingerprintGate: '/tools/check-snapshot-fingerprint.mjs', log() {},
    }, (command, args) => {
      if (args[0]?.endsWith('check-snapshot-fingerprint.mjs')) return { status: 0 }
      if (args[0]?.endsWith('build-hard-manifest.mjs')) return { status: 0 }
      // Gradle 任务必须跟着 buildType 走：debug 档不得被 release 任务悄悄顶替。
      assert.equal(args[0], buildType === 'debug' ? ':app:assembleDebug' : ':app:assembleRelease')
      const built = join(f.apkDir, 'app', 'build', 'outputs', 'apk', buildType, 'app-' + buildType + '.apk')
      mkdirSync(join(built, '..'), { recursive: true })
      writeFileSync(built, buildType + '-variant')
      return { status: 0 }
    })
    const calls = []
    const verify = () => verifyApks({
      files: [delivered],
      signatureGate: '/tools/check-apk-signatures.mjs',
      formGate: '/tools/check-apk-form.mjs',
      keystore: '/release/debug.keystore',
      log() {},
    }, (command, args) => {
      calls.push(args)
      if (args[0] === '/tools/check-apk-form.mjs' && args.includes('--require')) return { status: verdict.ok ? 0 : 1 }
      return { status: 0 }
    })
    return { verify, calls, delivered }
  }

  // release 档：形态判绿，终端段正常返回，形态段确实以 --require 调过。
  const release = run('release', releaseVerdict)
  assert.doesNotThrow(release.verify)
  assert.deepEqual(release.calls.at(-1), ['/tools/check-apk-form.mjs', '--apk', resolve(release.delivered), '--require'])

  // debug 档：同一段必须判红中止 —— 否则「构建类型回退」会静默交付 debuggable 产物。
  const debug = run('debug', debugVerdict)
  assert.throws(debug.verify, /failed \(1\)/)
  assert.deepEqual(debug.calls.at(-1), ['/tools/check-apk-form.mjs', '--apk', resolve(debug.delivered), '--require'])
})

test('a debuggable form rejection aborts the terminal stage just like a bad signature', () => {
  // 签名全绿 + 形态判红：这正是 0.14.9 发布产物的真实形态（debug 变体但签名完全正确），
  // 故形态门禁判红必须与签名判红一样中止交付，而不是被前一步的绿掩盖。
  assert.throws(() => verifyApks({
    directories: ['/release/apk'],
    signatureGate: '/tools/check-apk-signatures.mjs',
    formGate: '/tools/check-apk-form.mjs',
    keystore: '/release/debug.keystore',
    log() {},
  }, (command, args) => (args[0] === '/tools/check-apk-form.mjs' ? { status: 1 } : { status: 0 })), /failed \(1\)/)
})

test('verify --skip-self-test is parsed as a boolean and skips the second self-test', () => {
  const options = parseArgs(['verify', '--dir', '/release/apk', '--skip-self-test'])
  assert.equal(options.skipSelfTest, true)
  const calls = []
  verifyApks({ directories: [options.dir], selfTest: !options.skipSelfTest, log() {} },
    (command, args) => { calls.push(args); return { status: 0 } })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], [
    fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
    '--dir', resolve('/release/apk'), '--keystore',
    fileURLToPath(new URL('../keystore/debug.keystore', import.meta.url)),
    // 仓库那份 debug keystore 的公开凭据（与 app/build.gradle.kts 的 repoDebug 同源）。
    '--keystore-alias', 'androiddebugkey', '--keystore-pass', 'android',
  ])
  assert.equal(calls[0].includes('--self-test'), false)
  // --skip-self-test 同时关掉两道门禁的自证，但两道门禁本身都必须真跑。
  assert.deepEqual(calls[1], [
    fileURLToPath(new URL('./check-apk-form.mjs', import.meta.url)),
    '--dir', resolve('/release/apk'), '--require',
  ])
  assert.equal(calls[1].includes('--self-test'), false)
})

test('local, portable, and release entry points all route their terminal stage through the shared engine', () => {
  const local = readFileSync(new URL('./build-apk-013.ps1', import.meta.url), 'utf8')
  const portable = readFileSync(new URL('./build-apk.mjs', import.meta.url), 'utf8')
  const release = readFileSync(new URL('./build-release.ps1', import.meta.url), 'utf8')
  const localArgsBlock = local.match(/\$engineArgs = @\([\s\S]*?\n\s*\)/)?.[0] ?? ''
  const releaseArgsBlock = release.match(/\$engineArgs = @\([\s\S]*?\n\s*\)/)?.[0] ?? ''
  assert.match(local, /build-apk-engine\.mjs[\s\S]*?"assemble"/)
  assert.match(local, /if \(-not \[string\]::IsNullOrEmpty\(\$Suffix\)\) \{ \$engineArgs \+= @\("--suffix", \$Suffix\) \}/)
  assert.doesNotMatch(localArgsBlock, /"--suffix", \$Suffix/)
  assert.match(local, /Get-ChildItem \$Out -Filter '\*\.apk' -File -Recurse \| Remove-Item -Force/)
  assert.match(local, /build-apk-engine\.mjs"\) verify --dir \$Out/)
  assert.match(portable, /import \{ assembleApk, verifyApks \} from '\.\/build-apk-engine\.mjs'/)
  assert.match(portable, /const finalApk = assembleApk\(/)
  assert.match(release, /build-apk-engine\.mjs[\s\S]*?"assemble"/)
  assert.match(release, /if \(-not \[string\]::IsNullOrEmpty\(\$VersionSuffix\)\) \{ \$engineArgs \+= @\("--suffix", \$VersionSuffix\) \}/)
  assert.doesNotMatch(releaseArgsBlock, /"--suffix", \$VersionSuffix/)
  assert.match(release, /Get-ChildItem \$apkDir -Filter '\*\.apk' -File -Recurse \| Remove-Item -Force/)
  assert.match(release, /build-apk-engine\.mjs"\) verify --dir \$apkDir/)
  assert.match(release, /--artifact-name[\s\S]*?dsh-mobile-apk-v[\s\S]*?\$abi\.n/)
  assert.doesNotMatch(release, /Copy-Item\s+\$abi\.f\s+\$assets/)
  assert.match(release, /"--snapshot", \$abi\.f/)
})

test('portable inject-all uses the host Python command just like the snapshot builder', () => {
  const portable = readFileSync(new URL('./build-apk.mjs', import.meta.url), 'utf8')
  assert.match(portable, /const PYTHON = process\.platform === 'win32' \? 'python' : 'python3'/)
  assert.match(portable, /run\(PYTHON,\s*\[\s*join\(ROOT, 'scripts', 'inject-all\.py'/)
  assert.doesNotMatch(portable, /run\('python',\s*\[\s*join\(ROOT, 'scripts', 'inject-all\.py'/)
})

// ─── issue #1031（后半）：keystore 凭据的优先级与「不改代码换钥」两条路 ────────────────
// 门禁本身零默认值；引擎是唯一同时选定 keystore 路径与凭据的地方。这三条钉住优先级，
// 因为「引擎恒传显式 flag」曾把调用方的环境变量压掉 —— 那条路会静默只剩 CLI 一条。

test('引擎凭据优先级：显式参数 > 环境变量 > 仓库 debug keystore 的公开凭据', () => {
  assert.deepEqual(resolveEngineKeystoreCredentials({ env: {} }), { alias: 'androiddebugkey', pass: 'android' })
  assert.deepEqual(
    resolveEngineKeystoreCredentials({ env: { DSH_APK_KEYSTORE_ALIAS: 'releasekey', DSH_APK_KEYSTORE_PASS: 'S3cret-Release' } }),
    { alias: 'releasekey', pass: 'S3cret-Release' })
  assert.deepEqual(
    resolveEngineKeystoreCredentials({ keystoreAlias: 'clikey', keystorePass: 'clipass',
      env: { DSH_APK_KEYSTORE_ALIAS: 'releasekey', DSH_APK_KEYSTORE_PASS: 'S3cret-Release' } }),
    { alias: 'clikey', pass: 'clipass' })
})

test('引擎把解析后的凭据逐字传给检查器（环境变量必须能穿透）', () => {
  const calls = []
  verifyApks({ directories: ['/release/apk'], signatureGate: '/tools/check-apk-signatures.mjs',
    formGate: '/tools/check-apk-form.mjs', keystore: '/release/debug.keystore', selfTest: false, log() {} },
  (command, args) => { calls.push(args); return { status: 0 } })
  const verify = calls.find((args) => args.includes('--keystore'))
  // 检查器拿到的必须是显式凭据：它自己不再有任何默认值可回落。
  assert.ok(verify.includes('--keystore-alias') && verify.includes('--keystore-pass'))
  assert.equal(verify[verify.indexOf('--keystore-alias') + 1], 'androiddebugkey')
  assert.equal(verify[verify.indexOf('--keystore-pass') + 1], 'android')
})

test('引擎显式凭据覆盖：换发布钥的调用方不必改代码', () => {
  const calls = []
  verifyApks({ directories: ['/release/apk'], signatureGate: '/tools/check-apk-signatures.mjs',
    formGate: '/tools/check-apk-form.mjs', keystore: '/release/release.keystore',
    keystoreAlias: 'releasekey', keystorePass: 'S3cret-Release', selfTest: false, log() {} },
  (command, args) => { calls.push(args); return { status: 0 } })
  const verify = calls.find((args) => args.includes('--keystore'))
  assert.equal(verify[verify.indexOf('--keystore-alias') + 1], 'releasekey')
  assert.equal(verify[verify.indexOf('--keystore-pass') + 1], 'S3cret-Release')
})
