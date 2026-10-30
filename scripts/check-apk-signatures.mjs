#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { X509Certificate } from 'node:crypto'

/** issue #1032：递归收集 `.apk`，**跟随符号链接**（Dirent 对链接两种判定都为 false）。 */
export const collectApkFiles = (dir) => {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null
  const out = []
  const pending = [path.resolve(dir)]
  while (pending.length) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current)) {
      const candidate = path.join(current, entry)
      let stat = null
      try { stat = fs.statSync(candidate) } catch { continue }
      if (stat.isDirectory()) pending.push(candidate)
      else if (stat.isFile() && entry.toLowerCase().endsWith('.apk')) out.push(candidate)
    }
  }
  return out
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * issue #1031：期望证书必须有一个**独立锚**。
 *
 * 真因：此前 `expectedCertificateSha256` 是由 `--keystore` 现算出来的，锚与被检对象同源——
 * 换一个 `--keystore` 就能让另一把钥匙签出的 APK 判绿（假绿），而任何真实发布钥都会被判红。
 * 现在期望值来自 `scripts/fixtures/apk-expected-cert.sha256`（与 keystore 解耦的只读夹具），
 * 同时把同一摘要作为**不变量常量**留在本脚本里：读取结果必须与常量逐字相等。
 *
 * 为什么要留这个常量：只靠夹具文件的话，「改文件里的摘要」就成了洗白通道（把期望值改成
 * rogue 钥匙的指纹，门禁立刻放行）。常量与文件双向比对，两条路必须同时成立才放行——
 * 单改文件即判红，且报错点名「期望证书锚被改动」。真要换发布密钥，必须同时改常量并附
 * 已发布资产的迁移证据，那是一次单独的发布决策，不属于任何构建修复。
 */
export const PINNED_EXPECTED_CERT_SHA256 = '1dde9d980f62b715f29c20b421063f1d3d796085adf7de7e9907dd16d845bcbd'
export const EXPECTED_CERT_FIXTURE = path.join(SCRIPT_DIR, 'fixtures', 'apk-expected-cert.sha256')

/** 锚文件格式：`#` 开头的注释行与空行忽略，其余**恰好一行**小写十六进制 64 位。 */
export function parseCertificateAnchor(text) {
  const values = []
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    values.push(line)
  }
  if (values.length === 0) {
    return { ok: false, digest: null, problems: ['期望证书锚文件里没有摘要行（只有注释与空行）——锚缺席等于没有判据'] }
  }
  if (values.length > 1) {
    return { ok: false, digest: null, problems: [`期望证书锚文件里有 ${values.length} 个摘要行，锚必须唯一（多行会让判据取决于取哪一行）`] }
  }
  const value = values[0]
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return { ok: false, digest: null, problems: [`期望证书锚格式非法：要求小写十六进制 64 位，实际 ${JSON.stringify(value.length > 96 ? value.slice(0, 96) + '…' : value)}（长度 ${value.length}）`] }
  }
  return { ok: true, digest: value, problems: [] }
}

/** 把锚值与不变量常量对账；两者不同即「锚被改动」，不放行。 */
export function evaluateCertificateAnchor({ text, pinned = PINNED_EXPECTED_CERT_SHA256 }) {
  const parsed = parseCertificateAnchor(text)
  if (!parsed.ok) return { ok: false, digest: null, problems: parsed.problems }
  if (parsed.digest !== String(pinned).toLowerCase()) {
    return {
      ok: false,
      digest: parsed.digest,
      problems: [`期望证书锚被改动：文件值 ${parsed.digest} 与不变量 ${pinned} 不一致。这个摘要是已发布产物的签名身份，` +
        '不得因构建改动而更新；改文件来放行另一把钥匙会被本条拦下'],
    }
  }
  return { ok: true, digest: parsed.digest, problems: [] }
}

/**
 * 读取锚文件并判红/判绿。文件缺失同样是红：删掉锚等于回到「没有锚」的假绿状态，
 * 不能因为「没有期望值」就跳过证书身份判据（坑 357 的同型复发）。
 */
export function loadCertificateAnchor(filePath = EXPECTED_CERT_FIXTURE, pinned = PINNED_EXPECTED_CERT_SHA256) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    return { ok: false, digest: null, filePath, problems: [`期望证书锚文件缺失或不可读：${filePath}（${error.code ?? error.message}）——锚缺席必须判红，不得退化成「无期望值」`] }
  }
  const result = evaluateCertificateAnchor({ text, pinned })
  return { ...result, filePath }
}

/**
 * keystore 现算只作为**交叉核对**：它证明「仓库那把钥匙仍是已发布身份」，
 * 但不得替代锚——锚是判据，keystore 是被检对象之一。
 */
export function crossCheckKeystore({ anchorDigest, keystoreDigest }) {
  const normalized = String(keystoreDigest).replaceAll(':', '').toLowerCase()
  if (normalized === anchorDigest) return { ok: true, detail: null }
  return {
    ok: false,
    detail: `仓库 keystore 与期望证书锚不一致：keystore 导出 ${normalized}，锚 ${anchorDigest}。` +
      'keystore 只是交叉核对面，锚才是已发布产物的签名身份——keystore 换了不等于发布钥换了',
  }
}

const REQUIRED = ['v1', 'v2', 'v3']
// The produced APKs use SHA-256 for JAR/v1 signatures. apksigner defaults
// verification's minimum SDK from the APK manifest (26), where it omits v1
// from its compatibility report. API 18 supports this v1 digest, so verify
// against that floor to assert the actual signature block consistently.
const VERIFY_MIN_SDK = 18

function javaTool(name) {
  const executable = process.platform === 'win32' ? name + '.exe' : name
  const configured = process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', executable)
  return configured && fs.existsSync(configured) ? configured : executable
}

export function buildApksignerCommand(apksigner, args, platform = process.platform) {
  if (platform === 'win32' && /\.(?:bat|cmd)$/i.test(apksigner)) {
    // Invoke the SDK's actual jar without cmd.exe; APK paths remain separate arguments, including spaces/metacharacters.
    return { executable: javaTool('java'), args: ['-jar', path.join(path.dirname(apksigner), 'lib', 'apksigner.jar'), ...args] }
  }
  return { executable: apksigner, args }
}

export function buildVerifyArgs(apk) {
  return ['verify', '--verbose', '--print-certs', '--min-sdk-version', String(VERIFY_MIN_SDK), apk]
}

export function readSchemes(output) {
  const schemes = {}
  for (const scheme of REQUIRED) {
    const match = output.match(new RegExp(`^[ \\t]*Verified using ${scheme} scheme \\([^\\r\\n]*?\\):[ \\t]*(true|false)[ \\t]*$`, 'im'))
    schemes[scheme] = match ? match[1].toLowerCase() === 'true' : false
  }
  return schemes
}

export function readCertificateDigests(output) {
  return [...output.matchAll(/^[^\r\n]*certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/gim)]
    .map(match => match[1].replaceAll(':', '').toLowerCase())
    .filter(digest => /^[0-9a-f]{64}$/.test(digest))
}

export function evaluateVerification({ exitCode, output, expectedCertificateSha256 }) {
  const schemes = readSchemes(output)
  const missing = REQUIRED.filter((scheme) => !schemes[scheme])
  const certificates = readCertificateDigests(output)
  const expected = expectedCertificateSha256?.replaceAll(':', '').toLowerCase()
  const certificateMatches = /^[0-9a-f]{64}$/.test(expected ?? '') &&
    certificates.length > 0 && certificates.every(digest => digest === expected)
  return { ok: exitCode === 0 && missing.length === 0 && certificateMatches, exitCode, schemes, missing, certificates, certificateMatches }
}

export function readKeystoreCertificate(keystore) {
  // issue #1031：alias/口令此前硬编码，只对自带 debug keystore 成立；改为可覆盖。
const KEYSTORE_ALIAS = process.env.DSH_APK_KEYSTORE_ALIAS || 'androiddebugkey'
const KEYSTORE_PASS = process.env.DSH_APK_KEYSTORE_PASS || 'android'

const keytool = javaTool('keytool')
  const result = spawnSync(keytool, ['-exportcert', '-rfc', '-keystore', path.resolve(keystore),
    '-alias', KEYSTORE_ALIAS, '-storepass', KEYSTORE_PASS], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('cannot export the repository signing certificate from ' + keystore)
  const pem = result.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0]
  if (!pem) throw new Error('keytool did not return a certificate')
  return new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase()
}

function fail(message) {
  console.error(`APK signature gate: FAIL: ${message}`)
  process.exitCode = 1
}

function resolveApksigner(explicit) {
  if (explicit) return explicit
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'))
    roots.push(path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Android', 'Sdk'))
  } else {
    roots.push(path.join(process.env.HOME ?? '', 'Android', 'Sdk'), '/usr/local/lib/android/sdk')
  }
  const candidates = []
  for (const root of roots.filter(Boolean)) {
    const buildTools = path.join(root, 'build-tools')
    if (!fs.existsSync(buildTools)) continue
    for (const version of fs.readdirSync(buildTools).sort()) {
      const candidate = path.join(buildTools, version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner')
      if (fs.existsSync(candidate)) candidates.push(candidate)
      const extensionless = path.join(buildTools, version, 'apksigner')
      if (process.platform === 'win32' && fs.existsSync(extensionless)) candidates.push(extensionless)
    }
  }
  return candidates.at(-1)
}

function parseArgs(args) {
  const parsed = { apks: [], dirs: [], apksigner: undefined }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (['--apk', '--dir', '--apksigner', '--keystore', '--expected-cert'].includes(arg) && (!args[i + 1] || args[i + 1].startsWith('--'))) {
      throw new Error('missing value for ' + arg)
    }
    if (arg === '--apk') parsed.apks.push(args[++i])
    else if (arg === '--dir') parsed.dirs.push(args[++i])
    else if (arg === '--apksigner') parsed.apksigner = args[++i]
    else if (arg === '--keystore') parsed.keystore = args[++i]
    else if (arg === '--expected-cert') parsed.expectedCert = args[++i]
    else if (arg === '--self-test') parsed.selfTest = true
    // 给 workflow 一类调用方取真源值用：锚只有一份，别的地方要这串 hex 就来这里读。
    else if (arg === '--print-expected-cert') parsed.printExpectedCert = true
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return parsed
}

function runSelfTest() {
  const expectedCertificate = 'ab'.repeat(32)
  const certificateOutput = '\nSigner #1 certificate SHA-256 digest: ' + expectedCertificate
  const full = [
    'Verifies',
    'Verified using v1 scheme (JAR signing): true',
    'Verified using v2 scheme (APK Signature Scheme v2): true',
    'Verified using v3 scheme (APK Signature Scheme v3): true',
  ].join('\n') + certificateOutput
  const cases = [
    ['all schemes present', 0, full, true],
    ['v1 absent', 0, full.replace(/^Verified using v1 scheme.*(?:\r?\n|$)/im, ''), false],
    ['v2 absent', 0, full.replace(/^Verified using v2 scheme.*(?:\r?\n|$)/im, ''), false],
    ['v3 absent', 0, full.replace(/^Verified using v3 scheme.*(?:\r?\n|$)/im, ''), false],
    ['nonzero apksigner exit', 1, full, false],
    ['matching signing identity', 0, full, true, expectedCertificate],
    ['absent signing identity', 0, full.replace(certificateOutput, ''), false, expectedCertificate],
    ['wrong signing identity', 0, full.replace(expectedCertificate, 'cd'.repeat(32)), false, expectedCertificate],
  ]
  let failures = 0
  const total = { count: 0 }
  const assert = (name, actual, expected) => {
    total.count += 1
    const ok = actual === expected
    console.log(`${ok ? 'PASS' : 'FAIL'} self-test ${name}: expected=${expected} actual=${actual}`)
    if (!ok) failures += 1
  }
  for (const [name, exitCode, output, expected, expectedCertificateSha256] of cases) {
    assert(name,
      evaluateVerification({ exitCode, output, expectedCertificateSha256: expectedCertificateSha256 ?? expectedCertificate }).ok,
      expected)
  }
  // 期望证书锚（issue #1031）：锚必须独立于 keystore，且改锚即判红。
  const pin = 'ab'.repeat(32)
  const other = 'cd'.repeat(32)
  const anchorCases = [
    ['锚：只有一行摘要', pin, true],
    ['锚：带注释与空行仍可解析', '# 来源：已发布资产\n\n' + pin + '\n', true],
    ['锚：被改成别的摘要必须判红', other, false],
    ['锚：大写十六进制不认（格式定义为小写）', pin.toUpperCase(), false],
    ['锚：长度不足 64 位判红', pin.slice(0, 63), false],
    ['锚：长度超过 64 位判红', pin + 'a', false],
    ['锚：含非十六进制字符判红', 'zz' + pin.slice(2), false],
    ['锚：多个摘要行判红（取哪一行都会让判据漂移）', pin + '\n' + pin + '\n', false],
    ['锚：只有注释判红（锚缺席不得当作无期望值）', '# 只有注释\n\n', false],
    ['锚：空文件判红', '', false],
  ]
  for (const [name, text, expected] of anchorCases) {
    assert(name, evaluateCertificateAnchor({ text, pinned: pin }).ok, expected)
  }
  const changed = evaluateCertificateAnchor({ text: other, pinned: pin })
  assert('锚：改锚时报错点名「期望证书锚被改动」', /期望证书锚被改动/.test(changed.problems.join(' ')), true)
  const missing = loadCertificateAnchor(path.join(SCRIPT_DIR, 'fixtures', 'does-not-exist-cert.sha256'), pin)
  assert('锚：锚文件缺失判红（不得退化成无期望值）', missing.ok, false)
  assert('锚：缺失时说明文件路径', /does-not-exist-cert\.sha256/.test(missing.problems.join(' ')), true)
  // 交叉核对：keystore 现算只是第二意见，不等于锚。
  assert('交叉核对：keystore 与锚一致放行', crossCheckKeystore({ anchorDigest: pin, keystoreDigest: pin.replaceAll(':', '') }).ok, true)
  assert('交叉核对：keystore 与锚不一致判红', crossCheckKeystore({ anchorDigest: pin, keystoreDigest: other }).ok, false)
  // 仓库里那份真锚：值必须等于不变量常量（本 self-test 在 CI/本地都会跑）。
  const real = loadCertificateAnchor()
  assert('仓库锚文件在场且等于不变量常量', real.ok, true)
  assert('仓库锚文件摘要等于已 pin 的值', real.digest, PINNED_EXPECTED_CERT_SHA256)
  if (failures) process.exitCode = 1
  else console.log(`PASS ${total.count}/${total.count} signature gate self-tests`)
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    return fail(error.message)
  }
  if (options.help) {
    console.log('Usage: node scripts/check-apk-signatures.mjs (--apk FILE | --dir DIR)+ --keystore FILE [--expected-cert FILE] [--apksigner PATH] [--self-test] [--print-expected-cert]')
    return
  }
  if (options.selfTest) return runSelfTest()
  // 只打印锚值（供 workflow 的构建前自证取真源）：锚不可用时同样判红并 exit 1，
  // 免得调用方拿到空串继续往下跑。
  if (options.printExpectedCert) {
    const anchor = loadCertificateAnchor(options.expectedCert ?? EXPECTED_CERT_FIXTURE)
    if (!anchor.ok) {
      for (const problem of anchor.problems) console.error('APK signature gate: ' + problem)
      return fail('期望证书锚不可用，无法提供期望指纹')
    }
    console.log(anchor.digest)
    return
  }
  if (!options.apks.length && !options.dirs.length) return fail('provide at least one --apk or --dir')
  // 期望证书来自独立锚文件，**不**由 --keystore 现算（issue #1031：锚与被检对象同源 = 没有锚）。
  const anchor = loadCertificateAnchor(options.expectedCert ?? EXPECTED_CERT_FIXTURE)
  if (!anchor.ok) {
    for (const problem of anchor.problems) console.error('APK signature gate: ' + problem)
    return fail('期望证书锚不可用，拒绝在「没有独立锚」的状态下核验签名')
  }
  const expectedCertificateSha256 = anchor.digest
  if (!options.keystore) return fail('--keystore is required for APK verification')
  const apksigner = resolveApksigner(options.apksigner)
  if (!apksigner || !fs.existsSync(apksigner)) return fail('apksigner not found; pass --apksigner or set ANDROID_HOME/ANDROID_SDK_ROOT')
  // keystore 现算只作交叉核对：它证明「仓库这把钥匙仍是已发布身份」，替代不了锚。
  let keystoreCertificateSha256
  try { keystoreCertificateSha256 = readKeystoreCertificate(options.keystore) }
  catch (error) { return fail(error.message) }
  const crossCheck = crossCheckKeystore({ anchorDigest: expectedCertificateSha256, keystoreDigest: keystoreCertificateSha256 })
  if (!crossCheck.ok) return fail(crossCheck.detail)
  const files = [...options.apks]
  for (const dir of options.dirs) {
    const found = collectApkFiles(dir)
    if (found === null) return fail(`not a directory: ${dir}`)
    files.push(...found)
  }
  const unique = [...new Set(files.map((file) => path.resolve(file)))].sort()
  if (!unique.length) return fail('no APK files found in the supplied paths')
  let failures = 0
  console.log(`APK signature gate: apksigner=${apksigner}`)
  console.log('Required APK signature schemes: v1=true, v2=true, v3=true')
  // 把锚来源打进输出：判据的来源必须是可读的，不是「代码里某个常量」（那正是本 issue 的病）。
  const anchorPath = anchor.filePath ?? EXPECTED_CERT_FIXTURE
  const anchorShown = path.isAbsolute(anchorPath) && path.relative(process.cwd(), anchorPath).startsWith('..')
    ? anchorPath : path.relative(process.cwd(), anchorPath)
  console.log('Required signing certificate SHA-256: ' + expectedCertificateSha256 +
    ` (独立锚 ${anchorShown}，与 --keystore 交叉核对一致)`)
  for (const apk of unique) {
    if (!fs.existsSync(apk) || !fs.statSync(apk).isFile()) {
      console.error(`FAIL ${apk}: file does not exist`)
      failures += 1
      continue
    }
    const args = buildVerifyArgs(apk)
    const command = buildApksignerCommand(apksigner, args)
    console.log(`\n$ ${command.executable} ${command.args.join(' ')}`)
    const result = spawnSync(command.executable, command.args, { encoding: 'utf8', windowsHide: true })
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    console.log(output.trimEnd())
    const status = evaluateVerification({ exitCode: result.status, output, expectedCertificateSha256 })
    console.log(`apksigner exit-code=${result.status ?? 'null'}; schemes v1=${status.schemes.v1} v2=${status.schemes.v2} v3=${status.schemes.v3}`)
    if (result.error || !status.ok) {
      if (result.error) console.error(`spawn error: ${result.error.message}`)
      console.error(`FAIL ${apk}: required schemes missing/false: ${status.missing.join(', ') || 'none'}; exit=${result.status ?? 'null'}`)
      if (!status.certificateMatches) console.error(`FAIL ${apk}: signing certificate differs from the pinned expected certificate anchor (scripts/fixtures/apk-expected-cert.sha256) or is absent`)
      failures += 1
    } else console.log(`PASS ${apk}`)
  }
  if (failures) return fail(`${failures}/${unique.length} APK(s) failed verification`)
  console.log(`PASS all ${unique.length} final APK(s) have v1, v2, and v3 signatures`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
