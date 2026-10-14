#!/usr/bin/env node
// check-snapshot-decode.mjs — 内嵌快照「真的能解压」门禁（0.14.7 / task-9 D-4）。
//
// 缺的同步路径（真机实证）：build-apk-013.ps1:487 自己写出 assets/snapshot.sha256 声明值，
// check-snapshot-fingerprint.mjs 只断言 sha256(tar) == 该声明值（**自证**：声明值与 tar 由同一条构建
// 步骤产生），check-snapshot-asset.ps1 只比对 APK 内嵌与传入的 xz —— **两者都不解压**。
// 于是「tar 的摘要自洽、但字节流解不开」这种资产可以一路打包进 APK，直到用户真机上才以
// `org.tukaani.xz.CorruptedInputException: Compressed data is corrupt` 的形式爆出来
// （用户真机 logcat 实证：0.14.5-fx-2 与 0.14.6 都启动失败，栈顶即该异常）。
//
// 本门禁的判据：用**与设备同一套解码器**（org.tukaani:xz + commons-compress 的 streaming 解压）
// 把 assets/snapshot.tar.xz **完整流式解压一遍**，要求
//   ① 全程无异常（xz 块校验、tar 结构、条目头都要过）；
//   ② 条目数 > 0（空归档不得冒充通过）；
//   ③ 实读字节数 > 0 且 == 各条目声明 size 之和（**结尾完整**：截断/丢尾会让两者不等或被解码器拒绝）。
//
// 与「坏文件会被拦住」的反证：`node scripts/check-snapshot-decode.mjs --tar <坏文件>` 必须 exit 1。
// 实测（0.14.7 task-9）：把 assets/snapshot.tar.xz 复制一份、翻转偏移 97309312 处一个字节，本门禁
// 以 `CorruptedInputException: Compressed data is corrupt` 判红（exit 1）。
//
// 用法：
//   node scripts/check-snapshot-decode.mjs                 # 解压 <apk树>/app/src/main/assets/snapshot.tar.xz
//   node scripts/check-snapshot-decode.mjs --tar <xz>      # 指定文件（反证/受控输入用）
//   node scripts/check-snapshot-decode.mjs --require       # 严格档：tar 或解码器不齐即判红（不得 SKIP）
//   node scripts/check-snapshot-decode.mjs --self-test     # 纯判据离线自检，不需要 Java/Gradle 缓存
//   node scripts/check-snapshot-decode.mjs --self-test-runtime # 合成小归档的真实解码/损坏/指纹反证
//   node scripts/check-snapshot-decode.mjs --root <树>     # 非标准布局
// 退出码：0 = 通过（或明确计数并打印的 SKIP）；1 = 解压失败/判据不满足；2 = 前置不满足（用法/树定位）。
//
// 环境变量（受控注入，供反证与 CI 覆盖）：
//   DSH_JAVA            java 可执行文件（缺省 $JAVA_HOME/bin/java，再退 PATH 上的 java）
//   DSH_XZ_JAR          org.tukaani:xz 的 jar（缺省在 Gradle 缓存里按版本发现）
//   DSH_COMPRESS_JAR    commons-compress 的 jar
//   DSH_IO_JAR          commons-io 的 jar
//   DSH_LANG3_JAR       commons-lang3 的 jar
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const REQUIRE = argv.includes('--require') || process.env.DSH_REQUIRE_SNAPSHOT_DECODE === '1'
const SELF_TEST = argv.includes('--self-test')
const SELF_TEST_RUNTIME = argv.includes('--self-test-runtime')
const OVERRIDE_ROOT = argOf('root', process.env.DSH_APK_ROOT)
const EXPLICIT_TAR = argOf('tar', null)

let skipTotal = 0
const fail = (msg) => {
  console.error('SNAPSHOT-DECODE CHECK FAILED：' + msg)
  console.error('SKIP=' + skipTotal)
  process.exit(1)
}
/** SKIP 必须计数且可见（check-gate-skips.mjs 的 SKIP 纪律）：严格档下 SKIP 即判红。 */
const skip = (why) => {
  skipTotal += 1
  console.log('SKIP(#' + skipTotal + ')  ' + why + (REQUIRE ? ' —— --require 档不得 SKIP' : ''))
  if (REQUIRE) {
    console.log('SKIP=' + skipTotal)
    process.exit(1)
  }
}

/** 与设备同源的解码判据（纯函数，便于 --self-test 与「受控输入」两用）。 */
export function decideDecode(result) {
  if (result.error) return { ok: false, why: 'java/解码器无法启动：' + result.error }
  const out = (result.stdout ?? '') + (result.stderr ?? '')
  if (result.status !== 0) {
    const klass = /([A-Za-z_$][\w$]*(?:Exception|Error))/.exec(out)
    return { ok: false, why: '解压失败（' + (klass ? klass[1] : 'exit ' + result.status) + '）：' + out.trim().split('\n').slice(0, 3).join(' | ') }
  }
  const m = /XZ_DECODE_OK\s+entries=(\d+)\s+bytes=(\d+)\s+declared=(\d+)/.exec(out)
  if (!m) return { ok: false, why: '解码器未输出判据行（输出被截断或探针未运行）：' + out.trim().split('\n').slice(0, 3).join(' | ') }
  const entries = Number(m[1]); const bytes = Number(m[2]); const declared = Number(m[3])
  if (entries <= 0) return { ok: false, why: '归档条目数为 0（空归档不得冒充通过）' }
  if (bytes <= 0) return { ok: false, why: '解压出的字节数为 0' }
  if (bytes !== declared) return { ok: false, why: '解压字节数与条目声明 size 之和不符（结尾不完整/截断）：实读 ' + bytes + ' vs 声明 ' + declared }
  return { ok: true, detail: 'entries=' + entries + ' bytes=' + bytes }
}

/** 探针源码：与设备同一套 streaming 解码器（XZCompressorInputStream + TarArchiveInputStream）。 */
const PROBE_SOURCE = [
  'import java.io.*;',
  'import org.apache.commons.compress.archivers.tar.*;',
  'import org.apache.commons.compress.compressors.xz.XZCompressorInputStream;',
  '',
  'public class SnapshotDecodeProbe {',
  '  public static void main(String[] args) throws Exception {',
  '    long total = 0, declared = 0, entries = 0;',
  '    try (InputStream fin = new FileInputStream(args[0]);',
  '         XZCompressorInputStream xz = new XZCompressorInputStream(fin);',
  '         TarArchiveInputStream tar = new TarArchiveInputStream(xz)) {',
  '      byte[] buf = new byte[64 * 1024];',
  '      TarArchiveEntry e;',
  '      while ((e = tar.getNextEntry()) != null) {',
  '        entries++;',
  '        declared += e.getSize();',
  '        int n;',
  '        while ((n = tar.read(buf)) >= 0) total += n;',
  '      }',
  '      // TAR end markers can precede XZ padding, checksums, index and footer.',
  '      // Closing the stream does not validate unread compressed bytes.',
  '      while (xz.read(buf) != -1) {}',
  '    }',
  '    System.out.println("XZ_DECODE_OK entries=" + entries + " bytes=" + total + " declared=" + declared);',
  '  }',
  '}',
].join('\n')

/** 生成小型有效 fixture；解码仍由上面的设备同源 probe 执行。 */
const FIXTURE_SOURCE = [
  'import java.io.*;',
  'import java.nio.charset.StandardCharsets;',
  'import org.apache.commons.compress.archivers.tar.*;',
  'import org.apache.commons.compress.compressors.xz.XZCompressorOutputStream;',
  '',
  'public class SnapshotDecodeFixture {',
  '  public static void main(String[] args) throws Exception {',
  '    byte[] data = "snapshot decoder self-test\\n".repeat(1024).getBytes(StandardCharsets.UTF_8);',
  '    ByteArrayOutputStream archive = new ByteArrayOutputStream();',
  '    try (TarArchiveOutputStream tar = new TarArchiveOutputStream(archive)) {',
  '      TarArchiveEntry entry = new TarArchiveEntry("self-test.txt");',
  '      entry.setSize(data.length);',
  '      tar.putArchiveEntry(entry);',
  '      tar.write(data);',
  '      tar.closeArchiveEntry();',
  '    }',
  '    try (XZCompressorOutputStream xz = new XZCompressorOutputStream(new FileOutputStream(args[0]))) {',
  '      xz.write(archive.toByteArray());',
  '      if (args.length > 1) xz.write(new byte[1024 * 1024]);',
  '    }',
  '  }',
  '}',
].join('\n')

const hasAssets = (dir) => existsSync(join(dir, 'app', 'src', 'main', 'assets'))
const CANDIDATES = OVERRIDE_ROOT
  ? [resolve(OVERRIDE_ROOT)]
  : [ROOT, join(ROOT, 'dsh-mobile-apk'), resolve(join(ROOT, '..'))]

/** java 可执行文件：DSH_JAVA > $JAVA_HOME/bin/java > PATH 上的 java。 */
function resolveJava() {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java'
  if (process.env.DSH_JAVA && existsSync(process.env.DSH_JAVA)) return process.env.DSH_JAVA
  const home = process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', exe)
  if (home && existsSync(home)) return home
  const probe = spawnSync('java', ['-version'], { encoding: 'utf8' })
  return probe.error ? null : 'java'
}

/** 在 Gradle 模块缓存里按「最高版本」发现某个 group:artifact 的 jar。 */
function findJar(groupPath, artifactPrefix) {
  const base = join(process.env.GRADLE_USER_HOME || join(homedir(), '.gradle'), 'caches', 'modules-2', 'files-2.1', groupPath)
  if (!existsSync(base)) return null
  let best = null
  for (const version of readdirSync(base)) {
    const dir = join(base, version)
    let entries = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const hash of entries) {
      const hashDir = join(dir, hash)
      let files = []
      try { files = readdirSync(hashDir) } catch { continue }
      for (const f of files) {
        if (!f.startsWith(artifactPrefix) || !f.endsWith('.jar')) continue
        const hit = { path: join(hashDir, f), version }
        if (best === null || compareVersions(version, best.version) > 0) best = hit
      }
    }
  }
  return best
}
/** 版本比较（够用：按点分段数字比较，非数字段按字符串）。 */
function compareVersions(a, b) {
  const pa = String(a).split('.'); const pb = String(b).split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = Number(pa[i] ?? 0); const y = Number(pb[i] ?? 0)
    if (Number.isFinite(x) && Number.isFinite(y)) { if (x !== y) return x - y; continue }
    const sx = String(pa[i] ?? ''); const sy = String(pb[i] ?? '')
    if (sx !== sy) return sx < sy ? -1 : 1
  }
  return 0
}

/**
 * 解析本次要用的解码器 classpath。
 *
 * 为什么必须**与设备同版本**：本门禁的价值就是「在打包期用设备那套解码器跑一遍」。
 * 版本对不上时它证明的是别的解码器，属结构性假绿——故版本直接对齐 app/build.gradle.kts
 * （org.tukaani:xz 与 org.apache.commons:commons-compress），并把它打印出来供核对。
 */
function resolveDecoder() {
  const xz = process.env.DSH_XZ_JAR || findJar(join('org.tukaani', 'xz'), 'xz-')?.path
  const compress = process.env.DSH_COMPRESS_JAR || findJar(join('org.apache.commons', 'commons-compress'), 'commons-compress-')?.path
  const io = process.env.DSH_IO_JAR || findJar(join('commons-io', 'commons-io'), 'commons-io-')?.path
  const lang3 = process.env.DSH_LANG3_JAR || findJar(join('org.apache.commons', 'commons-lang3'), 'commons-lang3-')?.path
  const missing = [['xz', xz], ['commons-compress', compress], ['commons-io', io], ['commons-lang3', lang3]]
    .filter(([, p]) => !p || !existsSync(p)).map(([n]) => n)
  return { jars: [xz, compress, io, lang3].filter((p) => p && existsSync(p)), missing }
}

/** 把「声明版本」与「实际用到的 jar」对账（版本漂移 = 该门禁证明的不是设备那套解码器）。 */
function declaredVersions() {
  const gradle = [join(ROOT, 'dsh-mobile-apk', 'app', 'build.gradle.kts'), join(ROOT, 'app', 'build.gradle.kts')]
    .find((p) => existsSync(p))
  if (!gradle) return null
  const text = readFileSync(gradle, 'utf8')
  const pick = (artifact) => {
    const m = new RegExp(artifact + ':([0-9][^"\']*)').exec(text)
    return m ? m[1] : null
  }
  return { xz: pick('org.tukaani:xz'), compress: pick('org.apache.commons:commons-compress') }
}

function runJavaSource(java, classpath, filename, source, args) {
  const work = mkdtempSync(join(tmpdir(), 'snapshot-decode-'))
  try {
    // JDK 11+ 的单文件源码启动：不需要 javac，也不在此处留构建产物。
    const sourcePath = join(work, filename)
    writeFileSync(sourcePath, source)
    return spawnSync(java, ['-Xmx256m', '--class-path', classpath, sourcePath, ...args],
      { encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function runProbe(java, classpath, tar) {
  return runJavaSource(java, classpath, 'SnapshotDecodeProbe.java', PROBE_SOURCE, [tar])
}

// ── 自测：纯判据离线测试；--self-test-runtime 另加真实 Java 解码器/指纹反证 ─────
if (SELF_TEST || SELF_TEST_RUNTIME) {
  const cases = []
  const check = (label, ok) => { cases.push({ label, ok }); console.log((ok ? 'PASS  ' : 'FAIL  ') + label) }
  if (SELF_TEST_RUNTIME) {
    const java = resolveJava()
    const decoder = resolveDecoder()
    if (!java) fail('解码器运行时自测需要 Java；不接受纯模拟 PASS')
    if (decoder.missing.length > 0) fail('解码器运行时自测缺少 Gradle 缓存依赖：' + decoder.missing.join(', '))
    const classpath = decoder.jars.join(process.platform === 'win32' ? ';' : ':')
    const actualVersions = decoder.jars.map((p) => p.split(/[\\/]/).slice(-1)[0]).join(', ')
    const declared = declaredVersions()
    if (declared?.xz && !actualVersions.includes('xz-' + declared.xz + '.jar')) fail('自测 xz jar 与设备版本不一致：声明 ' + declared.xz + '；实际 ' + actualVersions)
    if (declared?.compress && !actualVersions.includes('commons-compress-' + declared.compress + '.jar')) fail('自测 commons-compress jar 与设备版本不一致：声明 ' + declared.compress + '；实际 ' + actualVersions)

    const work = mkdtempSync(join(tmpdir(), 'snapshot-decode-self-test-'))
    try {
      const validTar = join(work, 'valid.tar.xz')
      const fixture = runJavaSource(java, classpath, 'SnapshotDecodeFixture.java', FIXTURE_SOURCE, [validTar])
      if (fixture.error || fixture.status !== 0 || !existsSync(validTar)) {
        fail('无法生成自测用 tar.xz：' + ((fixture.stderr ?? '') + (fixture.stdout ?? '')).trim())
      }
      const valid = decideDecode(runProbe(java, classpath, validTar))
      check('正向：设备同源 Java 解码器完整解开合成归档', valid.ok && valid.detail.includes('bytes='))

      const validBytes = readFileSync(validTar)
      const truncatedTar = join(work, 'truncated.tar.xz')
      writeFileSync(truncatedTar, validBytes.subarray(0, validBytes.length - 1))
      const truncated = decideDecode(runProbe(java, classpath, truncatedTar))
      check('反向：实际解码器拒绝截断的 XZ 尾部', !truncated.ok)

      const flippedTar = join(work, 'byte-flipped.tar.xz')
      const flippedBytes = Buffer.from(validBytes)
      const footerCrcOffset = flippedBytes.length - 12
      flippedBytes[footerCrcOffset] ^= 0x01
      writeFileSync(flippedTar, flippedBytes)
      const flipped = decideDecode(runProbe(java, classpath, flippedTar))
      check('反向：实际解码器拒绝校验字节被翻转的 XZ 尾部', !flipped.ok)

      const paddedTar = join(work, 'padded.tar.xz')
      const paddedFixture = runJavaSource(java, classpath, 'SnapshotDecodeFixture.java', FIXTURE_SOURCE, [paddedTar, 'padding'])
      if (paddedFixture.error || paddedFixture.status !== 0) fail('padded fixture generation failed')
      check('valid TAR with long trailing padding passes', decideDecode(runProbe(java, classpath, paddedTar)).ok)
      const paddedBytes = readFileSync(paddedTar)
      const paddedCorrupt = join(work, 'padded-corrupt.tar.xz')
      const paddedFlipped = Buffer.from(paddedBytes)
      paddedFlipped[paddedFlipped.length - 12] ^= 0x01
      writeFileSync(paddedCorrupt, paddedFlipped)
      check('corrupt footer after TAR EOF and long padding is rejected', !decideDecode(runProbe(java, classpath, paddedCorrupt)).ok)
      const paddedTruncated = join(work, 'padded-truncated.tar.xz')
      writeFileSync(paddedTruncated, paddedBytes.subarray(0, paddedBytes.length - 1))
      check('truncated footer after TAR EOF and long padding is rejected', !decideDecode(runProbe(java, classpath, paddedTruncated)).ok)

      const fingerprintRoot = join(work, 'fingerprint-root')
      const assets = join(fingerprintRoot, 'app', 'src', 'main', 'assets')
      mkdirSync(assets, { recursive: true })
      const fingerprintTar = join(assets, 'snapshot.tar.xz')
      const fingerprintFile = join(assets, 'snapshot.sha256')
      writeFileSync(fingerprintTar, validBytes)
      const actualHash = createHash('sha256').update(validBytes).digest('hex')
      writeFileSync(fingerprintFile, actualHash + '\n')
      const fingerprintGate = join(ROOT, 'scripts', 'check-snapshot-fingerprint.mjs')
      const matchingHash = spawnSync(process.execPath, [fingerprintGate, '--require', '--root', fingerprintRoot], { encoding: 'utf8' })
      check('正向：实际指纹门禁接受匹配的 SHA-256', matchingHash.status === 0 && matchingHash.stdout.includes('SNAPSHOT-FINGERPRINT CHECK PASSED'))
      writeFileSync(fingerprintFile, '0'.repeat(64) + '\n')
      const wrongHash = spawnSync(process.execPath, [fingerprintGate, '--require', '--root', fingerprintRoot], { encoding: 'utf8' })
      check('反向：实际指纹门禁拒绝错误 SHA-256', wrongHash.status === 1 && (wrongHash.stderr + wrongHash.stdout).includes('指纹与快照不一致'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  // 纯判据反证仍保留，覆盖探针异常、空归档与实读/声明不一致分支。
  check('正向：解码 OK 行 -> 通过', decideDecode({ status: 0, stdout: 'XZ_DECODE_OK entries=49521 bytes=710586232 declared=710586232' }).ok)
  const corrupt = decideDecode({ status: 1, stderr: 'Exception in thread "main" org.tukaani.xz.CorruptedInputException: Compressed data is corrupt\n\tat org.tukaani.xz.lz.LZDecoder.repeat(LZDecoder.java:83)' })
  check('反向：CorruptedInputException -> 判红且点名异常类', !corrupt.ok && corrupt.why.includes('CorruptedInputException'))
  check('反向：条目数 0（空归档）-> 判红', !decideDecode({ status: 0, stdout: 'XZ_DECODE_OK entries=0 bytes=0 declared=0' }).ok)
  check('反向：实读字节数与声明 size 之和不符（截断）-> 判红',
    !decideDecode({ status: 0, stdout: 'XZ_DECODE_OK entries=10 bytes=999 declared=1000' }).ok)
  check('反向：无判据行（探针没跑）-> 判红', !decideDecode({ status: 0, stdout: 'noise' }).ok)
  check('反向：java 无法启动 -> 判红', !decideDecode({ error: new Error('spawn java ENOENT') }).ok)
  const bad = cases.filter((c) => !c.ok)
  console.log('SNAPSHOT-DECODE ' + (SELF_TEST_RUNTIME ? 'RUNTIME ' : '') + 'SELF-TEST ' + (bad.length === 0 ? 'PASSED' : 'FAILED') + '（' + cases.length + ' 项）')
  process.exit(bad.length === 0 ? 0 : 1)
}

// ── 定位快照 tar ─────────────────────────────────────────────────────────────
let tarPath
if (EXPLICIT_TAR) {
  tarPath = resolve(EXPLICIT_TAR)
  if (!existsSync(tarPath)) fail('指定的快照 tar 不存在：' + tarPath)
} else {
  const APK_ROOT = CANDIDATES.find(hasAssets)
  if (!APK_ROOT) {
    fail('找不到含 app/src/main/assets 的树（协调仓布局应为 <根>/dsh-mobile-apk，apk 仓自包含布局应为 <根> 本身）'
      + '\n  候选：' + CANDIDATES.join('、'))
  }
  tarPath = join(APK_ROOT, 'app', 'src', 'main', 'assets', 'snapshot.tar.xz')
  console.log('APK 树: ' + (relative(ROOT, APK_ROOT) || APK_ROOT))
  if (!existsSync(tarPath)) {
    skip('内嵌快照不在场（' + relative(ROOT, tarPath).replace(/\\/g, '/') + '）——净检出/CI 下 tar 被 .gitignore 忽略；'
      + '构建链要求在场：先跑 build-snapshot-013.mjs 或注入链')
    console.log('SNAPSHOT-DECODE CHECK SKIPPED')
    console.log('SKIP=' + skipTotal)
    process.exit(0)
  }
}

// ── 解析解码器（与设备同版本）────────────────────────────────────────────────
const java = resolveJava()
if (!java) skip('找不到 java（DSH_JAVA / JAVA_HOME / PATH 都未命中）——无法用设备同源解码器真检')
const decoder = resolveDecoder()
if (decoder.missing.length > 0) {
  skip('Gradle 模块缓存里缺解码器 jar：' + decoder.missing.join(', ')
    + '（用 DSH_XZ_JAR / DSH_COMPRESS_JAR / DSH_IO_JAR / DSH_LANG3_JAR 可显式指定；'
    + '它们与 app/build.gradle.kts 同版本，缺件时本门禁证明不了设备那套解码器）')
}

const declared = declaredVersions()
const actualVersions = decoder.jars.map((p) => p.split(/[\\/]/).slice(-1)[0]).join(', ')
console.log('解码器（与设备同源）: ' + actualVersions)
if (declared) {
  const want = []
  if (declared.xz) want.push('xz=' + declared.xz)
  if (declared.compress) want.push('commons-compress=' + declared.compress)
  const drift = []
  if (declared.xz && !actualVersions.includes('xz-' + declared.xz + '.jar')) drift.push('xz 期望 ' + declared.xz)
  if (declared.compress && !actualVersions.includes('commons-compress-' + declared.compress + '.jar')) drift.push('commons-compress 期望 ' + declared.compress)
  if (drift.length > 0) {
    fail('解码器版本与 app/build.gradle.kts 声明不同（本条门禁的价值就是「用设备那套解码器跑」）：'
      + drift.join('；') + '\n  实际：' + actualVersions
      + '\n  处理：让 Gradle 缓存与 build.gradle.kts 同版（跑一次 :app:compileDebugKotlin 即可解析），或用 DSH_*_JAR 显式指定')
  }
  console.log('版本对账: build.gradle.kts 声明 ' + want.join(', ') + ' -> 命中')
}

const size = statSync(tarPath).size
console.log('快照: ' + relative(ROOT, tarPath).replace(/\\/g, '/') + '（' + size + ' B），开始完整流式解压…')
const t0 = Date.now()
const result = runProbe(java, decoder.jars.join(process.platform === 'win32' ? ';' : ':'), tarPath)
const verdict = decideDecode(result)
const elapsed = Math.round((Date.now() - t0) / 1000)
if (!verdict.ok) {
  fail('内嵌快照无法用设备同源解码器完整解压（' + relative(ROOT, tarPath).replace(/\\/g, '/') + '，' + size + ' B，' + elapsed + 's）\n  '
    + verdict.why + '\n  含义：这份资产一旦打进 APK，设备侧只会在解码器内部以异常形式爆出（用户真机实测形态）'
    + '\n  修复：重跑构建链产出新快照，勿手工替换 tar')
}
console.log('PASS  ' + relative(ROOT, tarPath).replace(/\\/g, '/') + ' 完整解压通过（' + verdict.detail + '，' + elapsed + 's）')
console.log('SNAPSHOT-DECODE CHECK PASSED')
console.log('SKIP=' + skipTotal)
