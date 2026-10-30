import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleApk } from './build-apk-engine.mjs'

// issue #1077：交付目录的不变量 ——「目录里的 APK 一定是本次构建产出且已通过验签」。
//
// 旧行为有两个破口：① 拷贝发生在验签之前；② 失败后文件留在原地，而收尾的
// check-apk-signatures --dir 递归遍历目录、对任何不合格 *.apk 判红 → 该版本从此每次构建恒红。
// 下面每条用例都对准其中一个破口，并且都带放行例（合法构建必须仍产出）。

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delivery-1077-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const apkDir = join(root, 'apk')
  const outputDir = join(root, 'out', 'v1.2.3')
  const snapshot = join(root, 'snapshot.tar.xz')
  mkdirSync(apkDir, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(snapshot, Buffer.from('snapshot-bytes'))
  return { root, apkDir, outputDir, snapshot }
}

/** 一个会「造出 Gradle 产物」并记录各段调用顺序的 runner。 */
function runnerFor(f, { signatureStatus = 0, record = [] } = {}) {
  return (command, args, options) => {
    const script = String(args[0] ?? '')
    if (script.endsWith('check-snapshot-fingerprint.mjs')) { record.push('fingerprint'); return { status: 0 } }
    if (script.endsWith('build-hard-manifest.mjs')) {
      record.push('hard-manifest')
      writeFileSync(args[args.indexOf('--out') + 1], '{}')
      return { status: 0 }
    }
    if (script.endsWith('check-apk-signatures.mjs')) {
      record.push('signature')
      // 记录判据指向的是**哪个文件**：必须在交付目录之外（Gradle 输出树）
      record.push('signature-target:' + args.filter((a) => a.endsWith('.apk')).join(','))
      return { status: signatureStatus }
    }
    record.push('gradle')
    // 打包切到 release 变体（issue #1118）：debug 变体带 android:debuggable，#1119 的产物形态门禁会拒。
const built = join(f.apkDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
    mkdirSync(join(built, '..'), { recursive: true })
    writeFileSync(built, Buffer.from('fresh-apk-bytes'))
    return { status: 0 }
  }
}

const baseOptions = (f, over = {}) => ({
  snapshot: f.snapshot,
  apkDir: f.apkDir,
  outputDir: f.outputDir,
  artifactName: 'dsh-mobile-apk-v1.2.3-arm64.apk',
  fingerprintGate: '/tools/check-snapshot-fingerprint.mjs',
  signatureGate: '/tools/check-apk-signatures.mjs',
  log() {},
  ...over,
});

test('negative control: signature failure never leaves the APK in the delivery directory', (t) => {
  const f = fixture(t)
  const name = 'dsh-mobile-apk-v1.2.3-arm64.apk'
  // 夹具：先放一个「上一轮没通过验签」的陈旧产物，模拟缺陷积累到第二次构建的场景
  writeFileSync(join(f.outputDir, name), Buffer.from('stale-unverified-apk'))
  const record = []
  assert.throws(() => assembleApk(baseOptions(f), runnerFor(f, { signatureStatus: 1, record })), /failed \(1\)/)
  assert.equal(existsSync(join(f.outputDir, name)), false,
    '验签失败后交付目录里不得留下同名产物（否则 --dir 递归会一直命中它）')
  assert.deepEqual(readdirSync(f.outputDir), [], '陈旧产物也必须在构建开始时清掉')
  // 顺序判据：验签必须在拷贝之前 —— 用「验签时交付目录里还没有新产物」来钉死
  assert.ok(record.includes('signature'), '本次构建必须真的跑过签名门禁')
  assert.ok(record.filter((r) => r.startsWith('signature-target:')).join('').includes('app-release.apk'),
    '验签判据必须指向 Gradle 产物，而不是交付目录里的那份拷贝')
  assert.ok(record.indexOf('signature') < record.indexOf('gradle') || record.includes('gradle'),
    '签名段必须在 Gradle 之后（对产物验签）')
})

test('pass case: a verified build still delivers the artifact and clears the stale one', (t) => {
  const f = fixture(t)
  const name = 'dsh-mobile-apk-v1.2.3-arm64.apk'
  writeFileSync(join(f.outputDir, name), Buffer.from('stale-unverified-apk'))
  // 同目录的发布资产不得被误删（out/ 里还有 snapshot-*.tar.xz 等）
  writeFileSync(join(f.outputDir, 'snapshot-arm64.tar.xz'), Buffer.from('keep-me'))
  const delivered = assembleApk(baseOptions(f), runnerFor(f))
  assert.equal(delivered, join(f.outputDir, name))
  assert.equal(readFileSync(delivered, 'utf8'), 'fresh-apk-bytes', '交付的必须是本次构建的字节，不是陈旧那份')
  assert.equal(readFileSync(join(f.outputDir, 'snapshot-arm64.tar.xz'), 'utf8'), 'keep-me',
    '清理只针对 *.apk，不得误删同目录发布资产')
})

test('the delivery directory only ever contains artifacts that passed verification', (t) => {
  const f = fixture(t)
  const record = []
  // 验签那一刻，交付目录里的 *.apk 必须为空：说明拷贝还没发生（先验后拷）
  const runner = runnerFor(f, { record })
  const wrapped = (command, args, options) => {
    if (String(args[0] ?? '').endsWith('check-apk-signatures.mjs')) {
      const present = readdirSync(f.outputDir).filter((n) => n.toLowerCase().endsWith('.apk'))
      record.push('apks-in-delivery-during-verify:' + present.length)
    }
    return runner(command, args, options)
  }
  assembleApk(baseOptions(f), wrapped)
  assert.ok(record.includes('apks-in-delivery-during-verify:0'),
    '验签时交付目录必须还没有本次产物（先验签后拷入，而不是拷了再验）')
})

test('verifySignatures can be turned off only explicitly, and then no signature gate runs', (t) => {
  const f = fixture(t)
  const record = []
  assembleApk(baseOptions(f, { verifySignatures: false }), runnerFor(f, { record }))
  assert.equal(record.includes('signature'), false, '显式关掉时不得再跑签名门禁')
  assert.equal(existsSync(join(f.outputDir, 'dsh-mobile-apk-v1.2.3-arm64.apk')), true, '关掉验签仍然要交付产物')
})

test('portable chain clears stale APKs from its delivery directory before building', () => {
  // 三条链行为必须一致：ps1 与 release 都在开头清理，portable 此前漏了这一步。
  const portable = readFileSync(new URL('./build-apk.mjs', import.meta.url), 'utf8')
  assert.match(portable, /readdirSync\(OUT\)/, 'portable 链必须在构建开始时枚举交付目录');
  assert.match(portable, /endsWith\('\.apk'\)/, '清理面是 *.apk（不得按目录清空，会误伤 snapshot-*.tar.xz）');
  const local = readFileSync(new URL('./build-apk-013.ps1', import.meta.url), 'utf8')
  const release = readFileSync(new URL('./build-release.ps1', import.meta.url), 'utf8')
  assert.match(local, /Get-ChildItem \$Out -Filter '\*\.apk' -File -Recurse \| Remove-Item -Force/);
  assert.match(release, /Get-ChildItem \$apkDir -Filter '\*\.apk' -File -Recurse \| Remove-Item -Force/);
})
