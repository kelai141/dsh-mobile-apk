import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  buildVerifyArgs, buildApksignerCommand, evaluateVerification, readSchemes, readCertificateDigests,
  evaluateCertificateAnchor, loadCertificateAnchor, crossCheckKeystore, parseCertificateAnchor,
  PINNED_EXPECTED_CERT_SHA256, EXPECTED_CERT_FIXTURE,
} from './check-apk-signatures.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
    '--apk', 'final.apk', '--keystore', 'keystore/debug.keystore', '--apksigner', join(tmpdir(), 'no-such-apksigner-xyz'),
  ], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr, /期望证书锚/)
  assert.match(result.stderr, /apksigner not found/)
})
