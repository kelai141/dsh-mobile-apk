import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  buildVerifyArgs, buildApksignerCommand, evaluateVerification, readSchemes, readCertificateDigests,
  evaluateCertificateAnchor, loadCertificateAnchor, crossCheckKeystore, parseCertificateAnchor,
  PINNED_EXPECTED_CERT_SHA256, EXPECTED_CERT_FIXTURE,
  KEYSTORE_CREDENTIAL_ENV, KeystoreCredentialsError, describeMissingKeystoreCredentials,
  resolveKeystoreCredentials, buildKeytoolExportArgs, readKeystoreCertificate,
} from './check-apk-signatures.mjs'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const full = [
  'Verifies',
  'Verified using v1 scheme (JAR signing): true',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Verified using v3 scheme (APK Signature Scheme v3): true',
  'Number of signers: 1',
].join('\n')
const expectedCertificate = '12'.repeat(32)
const signed = full + '\nSigner #1 certificate SHA-256 digest: ' + expectedCertificate

test('accepts successful apksigner output only when v1, v2, and v3 are true', () => {
  assert.deepEqual(readSchemes(full), { v1: true, v2: true, v3: true })
  assert.equal(evaluateVerification({ exitCode: 0, output: signed, expectedCertificateSha256: expectedCertificate }).ok, true)
})

test('fails closed when the expected signing identity is absent', () => {
  const result = evaluateVerification({ exitCode: 0, output: signed })
  assert.equal(result.ok, false)
  assert.equal(result.certificateMatches, false)
})

test('verifies v1 against the lowest SDK supported by the generated SHA-256 JAR signature', () => {
  assert.deepEqual(buildVerifyArgs('final.apk'), [
    'verify', '--verbose', '--print-certs', '--min-sdk-version', '18', 'final.apk',
  ])
})

test('Windows SDK verification keeps APK paths as arguments without passing them through a command shell', () => {
  const apk = 'a directory/package & data (1).apk'
  const tool = path.join('SDK directory', 'build-tools', '37.0.0', 'apksigner.bat')
  const command = buildApksignerCommand(tool, buildVerifyArgs(apk), 'win32')
  assert.match(command.executable, /java(?:\.exe)?$/)
  assert.deepEqual(command.args, ['-jar', path.join(path.dirname(tool), 'lib', 'apksigner.jar'), ...buildVerifyArgs(apk)])
  assert.deepEqual(buildApksignerCommand('/sdk/apksigner', buildVerifyArgs(apk), 'linux'), { executable: '/sdk/apksigner', args: buildVerifyArgs(apk) })
})

for (const scheme of ['v1', 'v2', 'v3']) {
  test(`rejects APK when only ${scheme} is absent`, () => {
    const output = signed.replace(new RegExp(`^Verified using ${scheme} scheme.*(?:\\r?\\n|$)`, 'im'), '')
    const result = evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: expectedCertificate })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [scheme])
  })

  test(`rejects APK when only ${scheme} is false`, () => {
    const output = signed.replace(new RegExp(`(Verified using ${scheme} scheme \\([^\\r\\n]*?\\):\\s*)true`, 'i'), '$1false')
    const result = evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: expectedCertificate })
    assert.equal(result.ok, false)
    assert.deepEqual(result.missing, [scheme])
  })
}

test('rejects nonzero apksigner exit even when all scheme lines claim true', () => {
  assert.equal(evaluateVerification({ exitCode: 1, output: signed, expectedCertificateSha256: expectedCertificate }).ok, false)
})

test('rejects absent scheme lines and noisy output', () => {
  const result = evaluateVerification({ exitCode: 0, output: 'Verification failed\n', expectedCertificateSha256: expectedCertificate })
  assert.equal(result.ok, false)
  assert.deepEqual(result.missing, ['v1', 'v2', 'v3'])
})

test('requires the repository signing identity independently of valid signature schemes', () => {
  const expected = expectedCertificate
  const cert = `V2 Signer: certificate SHA-256 digest: ${expected}`
  assert.deepEqual(readCertificateDigests(cert), [expected])
  assert.equal(evaluateVerification({ exitCode: 0, output: full + '\n' + cert, expectedCertificateSha256: expected }).ok, true)
  for (const output of [full, full + '\n' + cert.replace(expected, '34'.repeat(32)), full + '\n' + cert + '\nSigner #2 certificate SHA-256 digest: ' + '56'.repeat(32)]) {
    const result = evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: expected })
    assert.equal(result.ok, false)
    assert.equal(result.certificateMatches, false)
    assert.deepEqual(result.missing, [])
  }
})

test('normalizes certificate fingerprints across build-tools output formats', () => {
  const expected = 'ab'.repeat(32)
  const output = full + '\nSigner #1 certificate SHA-256 digest: ' + Array(32).fill('AB').join(':') + '\r\n'
  assert.equal(evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: expected }).ok, true)
  assert.equal(evaluateVerification({ exitCode: 0, output, expectedCertificateSha256: 'invalid' }).ok, false)
})

test('an explicit keystore option cannot silently disable identity verification when its value is missing', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)), '--apk', 'final.apk', '--keystore'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /missing value for --keystore/)
})

test('APK verification rejects an omitted keystore before looking for apksigner', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)), '--apk', 'final.apk'], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--keystore is required for APK verification/)
  assert.doesNotMatch(result.stderr, /apksigner not found/)
})

test('Gradle debug and release variants explicitly use the all-schemes signing config', () => {
  const candidates = [new URL('../app/build.gradle.kts', import.meta.url), new URL('../dsh-mobile-apk/app/build.gradle.kts', import.meta.url)]
  const gradlePath = candidates.find((candidate) => existsSync(candidate))
  assert.ok(gradlePath, 'app/build.gradle.kts must exist in the APK tree')
  const gradle = readFileSync(gradlePath, 'utf8')
  const signing = /create\("repoDebug"\)\s*\{([\s\S]*?)\n\s*\}/.exec(gradle)?.[1] ?? ''
  for (const scheme of ['V1', 'V2', 'V3']) assert.match(signing, new RegExp(`enable${scheme}Signing\\s*=\\s*true`))
  assert.match(gradle, /release\s*\{\s*isMinifyEnabled\s*=\s*false\s*signingConfig\s*=\s*signingConfigs\.getByName\("repoDebug"\)/)
  assert.match(gradle, /debug\s*\{\s*signingConfig\s*=\s*signingConfigs\.getByName\("repoDebug"\)/)
})
// ─── 期望证书的独立锚（issue #1031 的另一半）────────────────────────────────
// 真因：此前「期望证书」就是 --keystore 那把钥匙本身，锚与被检对象同源 —— 换个 --keystore
// 就能把 rogue 钥匙签的包判绿（本地实测 exit 0，见 PR 复现）。这一组钉住「锚是独立夹具」。

test('锚文件里的摘要必须等于已 pin 的不变量常量', () => {
  assert.match(PINNED_EXPECTED_CERT_SHA256, /^[0-9a-f]{64}$/)
  assert.equal(PINNED_EXPECTED_CERT_SHA256, '1dde9d980f62b715f29c20b421063f1d3d796085adf7de7e9907dd16d845bcbd')
  const anchor = loadCertificateAnchor()
  assert.equal(anchor.ok, true, anchor.problems.join(' '))
  assert.equal(anchor.digest, PINNED_EXPECTED_CERT_SHA256)
  // 锚必须落在仓内固定路径上：路径可被 --expected-cert 覆盖，但默认值不能漂。
  assert.equal(path.resolve(EXPECTED_CERT_FIXTURE), path.resolve(fileURLToPath(new URL('./fixtures/apk-expected-cert.sha256', import.meta.url))))
})

test('锚文件是已发布产物的不变量：注释里必须写明「不得因构建改动而更新」', () => {
  const text = readFileSync(EXPECTED_CERT_FIXTURE, 'utf8')
  // 注释不是装饰：改了摘要的人在 diff 里必须看到「这是已发布产物」，否则改动看起来像例行维护。
  assert.match(text, /不得因构建改动而更新/)
  assert.match(text, /docs\/AGENTS\/gotchas\.md/)
  assert.equal((text.match(/^[0-9a-f]{64}$/gm) ?? []).length, 1, '锚文件必须恰好一行摘要')
})

test('负控 A：锚被改成别的 64 位摘要 -> 判红并点名「期望证书锚被改动」', () => {
  const rogue = 'd1ac53258a3490dc7b532cfdadc0191327a57a627e00996b8d0162f44a26063d'
  const result = evaluateCertificateAnchor({ text: rogue + '\n' })
  assert.equal(result.ok, false)
  assert.match(result.problems.join(' '), /期望证书锚被改动/)
  assert.match(result.problems.join(' '), new RegExp(rogue))
})

test('负控 B：锚文件缺失 / 格式非法 -> 判红，且不退化成「没有期望值」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apkcert-'))
  try {
    const missing = loadCertificateAnchor(join(dir, 'absent.sha256'))
    assert.equal(missing.ok, false)
    assert.match(missing.problems.join(' '), /锚文件缺失或不可读/)

    const bad = [
      ['长度 63', 'a'.repeat(63)],
      ['长度 65', 'a'.repeat(65)],
      ['非十六进制', 'g'.repeat(64)],
      ['大写', 'A'.repeat(64)],
      ['两行摘要', PINNED_EXPECTED_CERT_SHA256 + '\n' + PINNED_EXPECTED_CERT_SHA256],
      ['只有注释', '# nothing here\n'],
      ['空文件', ''],
    ]
    for (const [label, text] of bad) {
      const file = join(dir, label + '.sha256')
      writeFileSync(file, text)
      const result = loadCertificateAnchor(file)
      assert.equal(result.ok, false, `${label} 必须判红`)
      assert.ok(result.problems.length > 0)
      assert.equal(result.digest, null)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('放行例：锚值正确时（含注释与空行）仍绿', () => {
  const ok = parseCertificateAnchor('# 注释\n\n' + PINNED_EXPECTED_CERT_SHA256 + '\n')
  assert.equal(ok.ok, true)
  assert.equal(ok.digest, PINNED_EXPECTED_CERT_SHA256)
  assert.equal(evaluateCertificateAnchor({ text: PINNED_EXPECTED_CERT_SHA256 }).ok, true)
})

test('keystore 现算只作交叉核对：与锚不一致判红，但不得反过来替代锚', () => {
  assert.equal(crossCheckKeystore({ anchorDigest: PINNED_EXPECTED_CERT_SHA256, keystoreDigest: PINNED_EXPECTED_CERT_SHA256 }).ok, true)
  const mismatch = crossCheckKeystore({ anchorDigest: PINNED_EXPECTED_CERT_SHA256, keystoreDigest: 'cd'.repeat(32) })
  assert.equal(mismatch.ok, false)
  assert.match(mismatch.detail, /keystore/)
  assert.match(mismatch.detail, /锚/)
})

test('CLI 负控：--expected-cert 指向被改过的锚 -> exit 1 且点名锚被改动（apksigner 之前就红）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'apkcert-'))
  try {
    const file = join(dir, 'tampered.sha256')
    writeFileSync(file, 'cd'.repeat(32) + '\n')
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
      '--apk', 'final.apk', '--keystore', 'keystore/debug.keystore', '--expected-cert', file,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /期望证书锚被改动/)
    assert.match(result.stderr, /拒绝在「没有独立锚」的状态下核验签名/)
    assert.doesNotMatch(result.stderr, /apksigner not found/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI 负控：--expected-cert 指向不存在的文件 -> exit 1（锚缺席不得放行）', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
    '--apk', 'final.apk', '--keystore', 'keystore/debug.keystore',
    '--expected-cert', join(tmpdir(), 'definitely-absent-' + Date.now() + '.sha256'),
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /锚文件缺失或不可读/)
})

test('CLI 放行例：默认锚可用时不会因锚判红（只在缺 apksigner 处止步）', () => {
  // 本机/CI 净检出通常没有 Android SDK：那条红是环境面，不是锚面 —— 用它证明锚这一关确实过了。
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
    '--apk', 'final.apk', '--keystore', 'keystore/debug.keystore', '--keystore-alias', 'androiddebugkey',
    '--keystore-pass', 'android', '--apksigner', join(tmpdir(), 'no-such-apksigner-xyz'),
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, /期望证书锚/)
  assert.match(result.stderr, /apksigner not found/)
})

// ─── keystore alias/口令不再有默认值（issue #1031 的后半）─────────────────────────
// 真因：`process.env.DSH_APK_KEYSTORE_ALIAS || 'androiddebugkey'` / `|| 'android'` 只对仓库自带
// 那把 debug keystore 成立。换成任何一把真实发布钥（alias 不同、口令不同）时 keytool 导出必然
// 失败，门禁报「cannot export the repository signing certificate」——而那份 APK 的签名完全合法、
// 期望证书锚也已按文档正确同步。判据本身没问题，是「猜一个默认值」把「调用方没声明凭据」
// 伪装成了「钥匙坏了」。下面这组钉住新语义：凭据必须显式，缺席即红且点名补法。

test('负控（本 issue 的核心）：缺省凭据绝不回落到 androiddebugkey / android', () => {
  // 环境清空后必须是「缺席」，而不是某个内置字面量。
  const absent = resolveKeystoreCredentials({ env: {} })
  assert.equal(absent.ok, false)
  assert.equal(absent.alias, null)
  assert.equal(absent.pass, null)
  assert.deepEqual(absent.missing.map((m) => m.key), ['alias', 'pass'])
  // 只给一半也算缺席：缺口令与缺 alias 是同一类错误，不能只报一个。
  assert.deepEqual(resolveKeystoreCredentials({ alias: 'releasekey', env: {} }).missing.map((m) => m.key), ['pass'])
  assert.deepEqual(resolveKeystoreCredentials({ pass: 'S3cret-Release', env: {} }).missing.map((m) => m.key), ['alias'])
})

test('负控：报错必须点名缺哪一项、以及用哪个开关或环境变量补', () => {
  const message = describeMissingKeystoreCredentials(resolveKeystoreCredentials({ env: {} }).missing)
  assert.match(message, /--keystore-alias/)
  assert.match(message, /--keystore-pass/)
  assert.match(message, new RegExp(KEYSTORE_CREDENTIAL_ENV.alias))
  assert.match(message, new RegExp(KEYSTORE_CREDENTIAL_ENV.pass))
  // 报错里必须写明「本门禁不提供默认值」，否则读者会以为是钥匙坏了而去换钥匙。
  assert.match(message, /不提供默认值/)
  assert.match(message, /#1031/)
})

test('正控：显式凭据（CLI 参数优先于环境变量）逐字采用，不做任何替换', () => {
  const explicit = resolveKeystoreCredentials({ alias: 'releasekey', pass: 'S3cret-Release', env: {} })
  assert.deepEqual([explicit.ok, explicit.alias, explicit.pass], [true, 'releasekey', 'S3cret-Release'])
  const fromEnv = resolveKeystoreCredentials({
    env: { [KEYSTORE_CREDENTIAL_ENV.alias]: 'envkey', [KEYSTORE_CREDENTIAL_ENV.pass]: 'envpass' },
  })
  assert.deepEqual([fromEnv.ok, fromEnv.alias, fromEnv.pass], [true, 'envkey', 'envpass'])
  const cliWins = resolveKeystoreCredentials({
    alias: 'clikey', pass: 'clipass',
    env: { [KEYSTORE_CREDENTIAL_ENV.alias]: 'envkey', [KEYSTORE_CREDENTIAL_ENV.pass]: 'envpass' },
  })
  assert.deepEqual([cliWins.alias, cliWins.pass], ['clikey', 'clipass'])
})

test('keytool 导出参数：alias 与口令逐字进 argv，且不含任何内置默认值', () => {
  const args = buildKeytoolExportArgs({ keystore: 'release-like.keystore', alias: 'releasekey', pass: 'S3cret-Release' })
  assert.deepEqual(args, ['-exportcert', '-rfc', '-keystore', path.resolve('release-like.keystore'),
    '-alias', 'releasekey', '-storepass', 'S3cret-Release'])
  assert.doesNotMatch(args.join(' '), /androiddebugkey/)
})

test('readKeystoreCertificate：凭据缺席时抛 KeystoreCredentialsError，且根本不去 spawn keytool', () => {
  const calls = []
  assert.throws(
    () => readKeystoreCertificate('release-like.keystore', { env: {} }, (...args) => { calls.push(args); return { status: 0 } }),
    (error) => error instanceof KeystoreCredentialsError && /不提供默认值/.test(error.message))
  // 关键：一次都不 spawn。旧实现会带着 androiddebugkey/android 去试，然后把「钥匙不对」报成导出失败。
  assert.deepEqual(calls, [])
})

test('readKeystoreCertificate：显式凭据真的进到 keytool 命令行（非默认 alias/口令）', () => {
  const calls = []
  const fakeCert = '-----BEGIN CERTIFICATE-----\n' + [
    'MIIBkTCB+wIJAJ8Y0m0m0m0mMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxvY2Fs',
    '-----END CERTIFICATE-----',
  ].join('\n')
  // 只断言「参数被送进去了」，不伪造证书：返回码非 0 时抛的是导出失败，正好可以在这里区分。
  assert.throws(() => readKeystoreCertificate('release-like.keystore',
    { alias: 'releasekey', pass: 'S3cret-Release' },
    (executable, args) => { calls.push({ executable, args }); return { status: 1, stdout: fakeCert } }),
    /cannot export the repository signing certificate from release-like\.keystore/)
  assert.equal(calls.length, 1)
  const { args } = calls[0]
  assert.ok(args.includes('-alias') && args[args.indexOf('-alias') + 1] === 'releasekey')
  assert.ok(args.includes('-storepass') && args[args.indexOf('-storepass') + 1] === 'S3cret-Release')
  assert.doesNotMatch(args.join(' '), /androiddebugkey|\sandroid(?:\s|$)/)
})

test('CLI 负控：不带任何凭据 -> exit 1，点名缺 alias/口令，且不回落到 androiddebugkey/android', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
    '--apk', 'final.apk', '--keystore', 'keystore/debug.keystore',
  ], { encoding: 'utf8', env: { ...process.env, DSH_APK_KEYSTORE_ALIAS: '', DSH_APK_KEYSTORE_PASS: '' } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /需要显式声明的 keystore 凭据/)
  assert.match(result.stderr, /--keystore-alias/)
  assert.match(result.stderr, /--keystore-pass/)
  // 旧实现的红是「cannot export…」—— 那句会让人去查钥匙。新语义必须先把「你没声明」说清楚。
  assert.doesNotMatch(result.stderr, /cannot export the repository signing certificate/)
  // 凭据判据排在 apksigner 之前：缺凭据是调用方的错，不该先探 SDK。
  assert.doesNotMatch(result.stderr, /apksigner not found/)
})

test('CLI 负控：只给 alias 不给口令 -> 仍 exit 1（不得因为给了一半就放行）', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
    '--apk', 'final.apk', '--keystore', 'keystore/debug.keystore', '--keystore-alias', 'androiddebugkey',
  ], { encoding: 'utf8', env: { ...process.env, DSH_APK_KEYSTORE_ALIAS: '', DSH_APK_KEYSTORE_PASS: '' } })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /--keystore-pass/)
  assert.doesNotMatch(result.stderr, /--keystore-alias 或 DSH_APK_KEYSTORE_ALIAS/)
})

test('CLI 负控：--keystore-alias / --keystore-pass 缺值即用法错误', () => {
  for (const option of ['--keystore-alias', '--keystore-pass']) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
      '--apk', 'final.apk', '--keystore', 'keystore/debug.keystore', option,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 1, option + ' 缺值必须判红')
    assert.match(result.stderr, new RegExp('missing value for ' + option))
  }
})

// ─── 端到端：证书合法的「真实发布钥」不再假红（本 issue 的核心判据）────────────────
// 这一组是唯一能证明「假红真的没了」的证据，故它真的用 keytool 造一把非默认 alias/口令的
// keystore，再走完整 CLI。环境无 JDK 时显式 SKIP 并计数（不冒充通过）。

/**
 * 最小 stored（不压缩）ZIP：探针包只需要一个能被 apksigner 读到的条目。
 * 手写而不是调外部 zip 工具，是为了让端到端用例在任何机器上都只依赖 node + JDK。
 */
const storedZip = (entries) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name)
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const centralSize = centrals.reduce((sum, buffer) => sum + buffer.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

const javaToolPath = (name) => {
  const exe = process.platform === 'win32' ? name + '.exe' : name
  const configured = process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', exe)
  return configured && existsSync(configured) ? configured : null
}

test('端到端正控：非默认 alias/口令的 keystore + 证书合法的 APK -> 不再假红（exit 0）', (t) => {
  const keytool = javaToolPath('keytool')
  const java = javaToolPath('java')
  const apksignerJar = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Android', 'Sdk')]
    .filter(Boolean)
    .flatMap((root) => {
      const tools = join(root, 'build-tools')
      if (!existsSync(tools)) return []
      return readdirSync(tools).sort().map((v) => join(tools, v, 'lib', 'apksigner.jar'))
    })
    .filter((candidate) => existsSync(candidate)).at(-1)
  if (!keytool || !java || !apksignerJar) {
    t.skip('本机无 JDK/apksigner，端到端换钥正控无法执行（此处不计为通过）')
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'apk-rotate-'))
  try {
    const alias = 'releasekey'
    const pass = 'S3cret-Release'
    const keystore = join(dir, 'release-like.keystore')
    const genkey = spawnSync(keytool, ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12',
      '-alias', alias, '-storepass', pass, '-keypass', pass, '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10000', '-dname', 'CN=Release Like Key, O=DSH, C=CN'], { encoding: 'utf8' })
    assert.equal(genkey.status, 0, 'keytool -genkeypair 必须成功：' + (genkey.stderr ?? ''))
    // 探针包：纯文本 manifest，故 apksigner 需要显式 min-sdk-version。
    const probeZip = join(dir, 'probe.zip')
    writeFileSync(probeZip, storedZip([{ name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') }]))
    const signed = join(dir, 'release-like-signed.apk')
    const sign = spawnSync(java, ['-jar', apksignerJar, 'sign', '--min-sdk-version', '18',
      '--v1-signing-enabled', 'true', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',
      '--ks', keystore, '--ks-pass', 'pass:' + pass, '--ks-key-alias', alias, '--out', signed, probeZip],
    { encoding: 'utf8' })
    assert.equal(sign.status, 0, 'apksigner sign 必须成功：' + (sign.stderr ?? ''))
    /**
     * 换钥的**正确路径**（文档要求的那条）：夹具与不变量常量同时同步到新指纹。
     * 单改夹具必须判红（那是洗白通道，见上面「负控 A」），所以这里照规矩把脚本副本里的
     * PINNED 常量也一并同步——正是「换发布钥是一次单独的发布决策」在测试里的等价形态。
     */
    const digest = readKeystoreCertificate(keystore, { alias, pass })
    const gateDir = join(dir, 'gate')
    mkdirSync(join(gateDir, 'fixtures'), { recursive: true })
    const gate = join(gateDir, 'check-apk-signatures.mjs')
    writeFileSync(gate, readFileSync(fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)), 'utf8')
      .replaceAll(PINNED_EXPECTED_CERT_SHA256, digest))
    writeFileSync(join(gateDir, 'fixtures', 'apk-expected-cert.sha256'), digest + '\n')
    // 改动前的实现在这里必然 exit 1（keytool 用 androiddebugkey/android 导出失败）——这就是本 issue。
    const result = spawnSync(process.execPath, [gate, '--apk', signed, '--keystore', keystore,
      '--keystore-alias', alias, '--keystore-pass', pass,
      '--apksigner', join(dirname(apksignerJar), '..', process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')],
    { encoding: 'utf8', env: { ...process.env, DSH_APK_KEYSTORE_ALIAS: '', DSH_APK_KEYSTORE_PASS: '' } })
    const combined = (result.stdout ?? '') + (result.stderr ?? '')
    assert.equal(result.status, 0, '非默认 alias/口令的合法签名 APK 必须放行，实际输出：\n' + combined +
      '\n[debug] status=' + result.status + ' signal=' + result.signal + ' error=' + (result.error?.message ?? 'none'))
    assert.match(combined, /PASS /)
    // 凭据来源必须可见：这条判据曾因「猜默认值」对真实发布钥必然假红，来源不明会再隐形。
    assert.match(combined, /Keystore cross-check credentials: alias=releasekey/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('端到端负控：同一把非默认 keystore，不给凭据 -> 明确判红（不是「钥匙坏了」）', (t) => {
  const keytool = javaToolPath('keytool')
  if (!keytool) { t.skip('本机无 JDK，端到端负控无法执行（此处不计为通过）'); return }
  const dir = mkdtempSync(join(tmpdir(), 'apk-rotate-red-'))
  try {
    const keystore = join(dir, 'release-like.keystore')
    const genkey = spawnSync(keytool, ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12',
      '-alias', 'releasekey', '-storepass', 'S3cret-Release', '-keypass', 'S3cret-Release',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Release Like Key'],
    { encoding: 'utf8' })
    assert.equal(genkey.status, 0)
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)),
      '--apk', 'final.apk', '--keystore', keystore,
    ], { encoding: 'utf8', env: { ...process.env, DSH_APK_KEYSTORE_ALIAS: '', DSH_APK_KEYSTORE_PASS: '' } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /需要显式声明的 keystore 凭据/)
    assert.doesNotMatch(result.stderr, /cannot export the repository signing certificate/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─── --self-test 不得静默忽略其它参数（issue #1031 次要项）─────────────────────────
// 旧实现：`if (options.selfTest) return runSelfTest()` 排在参数校验之前，于是
// `--self-test --apk x.apk` exit 0 —— 看上去验了产物，实际一条没验。

test('负控：--self-test 与产物参数同用 -> 判用法错误，不静默忽略', () => {
  for (const extra of [['--apk', 'x.apk'], ['--dir', 'out'], ['--keystore', 'keystore/debug.keystore'],
    ['--expected-cert', 'x.sha256'], ['--keystore-alias', 'androiddebugkey'], ['--print-expected-cert']]) {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)), '--self-test', ...extra,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 1, '--self-test ' + extra.join(' ') + ' 必须判红')
    assert.match(result.stderr, /--self-test 不与产物参数同用/)
    // 报错必须点名被拒绝的那个参数，读者才知道自己写的那行哪里错了。
    assert.match(result.stderr, new RegExp(extra[0].replace(/-/g, '\-')))
    // 判红时不得先打印一份自证通过的样子（那正是「看起来验了」的来源）。
    assert.doesNotMatch(result.stdout, /signature gate self-tests/)
  }
})

test('正控：--self-test 单独用照旧 exit 0 且全部通过', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('./check-apk-signatures.mjs', import.meta.url)), '--self-test',
  ], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /PASS \d+\/\d+ signature gate self-tests/)
  // 自证例数只许升不许降（本 issue 前是 25 例）。
  const total = Number(/PASS (\d+)\/(\d+) signature gate self-tests/.exec(result.stdout)?.[2] ?? '0')
  assert.ok(total >= 25, '自证例数不得减少（当前 ' + total + '，改动前 25）')
})
