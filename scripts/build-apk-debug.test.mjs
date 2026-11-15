#!/usr/bin/env node
// build-apk-debug.test.mjs — 调试包命名/版本号/ABI/产物形态判据的回归（纯函数，无网络、无 SDK、无快照）。
//
// 为什么这些判据必须被单测钉住（每条对应一类「构建全绿但产物是错的」）：
//   · versionCode：回落成当前树默认值 + 静默成功 → 装机 INSTALL_FAILED_VERSION_DOWNGRADE，
//     或调试包的号恰好等于下一个正式版，反向覆盖。故「解析不到就抛」本身是判据。
//   · 随机段：长度/字符集漂移 → 版本串不再是 <base>-<8位>-dev，产物名匹配与文档全部失真。
//   · ABI：错 ABI 快照的包能装、能 am start -W 报 Status: ok，引擎却起不来（AGENTS.md §6 雷点 1）。
//   · 产物形态：调试包必须是 debuggable；把发布包的判据（禁 debuggable）套上来是恒红，
//     去掉判据则是恒绿 —— 两种都让「这是不是一个调试包」失去判定。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEV_MARKER,
  MAX_VERSION_CODE,
  NATIVE_CONTROL_ABI,
  PACKAGE_NAME,
  SUFFIX_CHARSET,
  SUFFIX_LENGTH,
  artifactNameFor,
  assertSnapshotAbi,
  bumpVersionCode,
  composeVersionName,
  evaluateDebugBadging,
  formatGithubOutput,
  nativeControlAbiFor,
  parseArgs,
  parseGradleBaseVersionName,
  parseGradleDefaultVersionCode,
  parseManifestEntry,
  randomSuffix,
  validateRandomPart,
} from './build-apk-debug.mjs'
import { resolveVersionSuffix } from './resolve-version-suffix.mjs'

// ── 随机段 ────────────────────────────────────────────────────────────────
test('随机段：长度恒为 8 且只含 A-Za-z0-9', () => {
  assert.equal(SUFFIX_LENGTH, 8)
  assert.equal(SUFFIX_CHARSET.length, 62)
  for (let i = 0; i < 500; i += 1) {
    const value = randomSuffix()
    assert.equal(value.length, 8)
    assert.match(value, /^[A-Za-z0-9]{8}$/)
  }
})

test('随机段：nextInt 注入后逐位钉住（生产用 crypto.randomInt，最大值是字符集长度）', () => {
  const calls = []
  const nextInt = (max) => { calls.push(max); return max - 1 }
  assert.equal(randomSuffix(8, nextInt), '99999999'.replace(/9/g, SUFFIX_CHARSET[61]))
  assert.deepEqual([...new Set(calls)], [62])
  assert.equal(calls.length, 8)
})

test('随机段：非正长度直接拒绝（空段会产出 <base>--dev 这种不可解析的名字）', () => {
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => randomSuffix(bad), /随机段长度必须是正整数/)
  }
})

test('随机段：调用方给定的段必须恰好 8 位字母数字', () => {
  assert.equal(validateRandomPart('x7K2mQ9z'), 'x7K2mQ9z')
  for (const bad of ['', 'short', 'toolongpart', 'x7K2mQ9-', 'x7K2mQ9_', 'x7K2mQ z', '../etc/x', 'x7K2mQ9z\n']) {
    assert.throws(() => validateRandomPart(bad), /恰好 8 位 ASCII 字母或数字/, '应拒绝 ' + JSON.stringify(bad))
  }
})

// ── versionCode ───────────────────────────────────────────────────────────
test('versionCode：release 绑定值 + 1（v0.14.11 绑 70 -> 调试包 71）', () => {
  assert.equal(bumpVersionCode('70'), 71)
  assert.equal(bumpVersionCode(70), 71)
  assert.equal(bumpVersionCode('1'), 2)
  assert.equal(bumpVersionCode(String(MAX_VERSION_CODE - 1)), MAX_VERSION_CODE)
})

test('versionCode：解析不到绑定值时硬失败，绝不回落（这条是判据，不是防御）', () => {
  for (const bad of ['', '  ', '0', '-1', '7.1', 'abc', null, undefined, '08x']) {
    assert.throws(() => bumpVersionCode(bad), /release 绑定的 versionCode 不可用/, '应拒绝 ' + JSON.stringify(bad))
  }
})

test('versionCode：加一后越界即拒绝（不得溢出成负数）', () => {
  assert.throws(() => bumpVersionCode(String(MAX_VERSION_CODE)), /越界/)
})

test('versionCode 真源：只认 providers.gradleProperty("versionCode").getOrElse("<n>") 形态', () => {
  const real = 'versionCode = providers.gradleProperty("versionCode").getOrElse("70").toInt()'
  assert.equal(parseGradleDefaultVersionCode(real), '70')
  // 负控：注释里出现过数字、或形态不同（println/硬编码），都不得被当默认值
  assert.equal(parseGradleDefaultVersionCode('// 0.14.11：versionCode 70'), null)
  assert.equal(parseGradleDefaultVersionCode('versionCode = 70'), null)
  assert.equal(parseGradleDefaultVersionCode(''), null)
})

test('versionName 基线：从 gradle 真源取，非法形态返回 null', () => {
  assert.equal(parseGradleBaseVersionName('    versionName = "0.15.0" + snapshotSuffix'), '0.15.0')
  assert.equal(parseGradleBaseVersionName('    versionName = "0.14.11" + snapshotSuffix'), '0.14.11')
  assert.equal(parseGradleBaseVersionName('// versionName = "not-a-version"'), null)
  assert.equal(parseGradleBaseVersionName(''), null)
})

// ── 版本名组装 ────────────────────────────────────────────────────────────
test('versionName = <基线>-<8位>-dev', () => {
  assert.equal(composeVersionName('0.15.0', 'x7K2mQ9z'), '0.15.0-x7K2mQ9z-dev')
  assert.equal(composeVersionName('0.15.0', 'x7K2mQ9z').endsWith('-' + DEV_MARKER), true)
})

test('versionName 与发布链同一套命名规则（复用 resolve-version-suffix，不另造一份）', () => {
  const suffix = '-x7K2mQ9z-' + DEV_MARKER
  const viaSuffix = resolveVersionSuffix('0.15.0', '', suffix)
  assert.deepEqual(viaSuffix, { version: composeVersionName('0.15.0', 'x7K2mQ9z'), suffix })
  // 显式给整个 versionName 时也必须落到同一个值（两条输入路径不得分叉）
  const viaVersion = resolveVersionSuffix('0.15.0', '0.15.0-x7K2mQ9z-dev', suffix)
  assert.equal(viaVersion.version, '0.15.0-x7K2mQ9z-dev')
  // 负控：与基线不同的 versionName 必须被拒，而不是被悄悄采纳
  assert.throws(() => resolveVersionSuffix('0.15.0', '0.14.99', suffix), /does not equal base/)
})

test('versionName 含非法随机段时整体拒绝（不得进入 Gradle 的 -P）', () => {
  assert.throws(() => composeVersionName('0.15.0', 'bad part'), /恰好 8 位/)
})

// ── 产物名 ────────────────────────────────────────────────────────────────
test('产物名：与发布链同形，只多一个 -dev 段；Release 资产匹配器不会命中它', () => {
  const name = artifactNameFor({ versionName: '0.15.0-x7K2mQ9z-dev', abi: 'arm64' })
  assert.equal(name, 'dsh-mobile-apk-v0.15.0-x7K2mQ9z-dev-arm64.apk')
  // UpdateChecker.assetNameCandidates(tag, abi) 产出 dsh-mobile-apk-v<tag>-<abi>.apk（tag 无 v 前缀）；
  // 调试包名里多出 -<段>-dev，故两者不可能相等 —— 调试包不会被应用内更新当成正式版。
  const releaseWanted = 'dsh-mobile-apk-v0.15.0-arm64.apk'
  assert.notEqual(name, releaseWanted)
  assert.ok(name.endsWith('-arm64.apk'))
})

test('产物名：未知 ABI 直接拒绝', () => {
  for (const bad of ['', 'arm', 'aarch64', 'x86']) {
    assert.throws(() => artifactNameFor({ versionName: '0.15.0-x7K2mQ9z-dev', abi: bad }), /未知 ABI/)
  }
})

// ── ABI 不变量 ────────────────────────────────────────────────────────────
test('ABI：快照 machine 名必须与目标 ABI 一致（错 ABI 的包能装但引擎起不来）', () => {
  assert.equal(assertSnapshotAbi('arm64', 'aarch64'), true)
  assert.equal(assertSnapshotAbi('x86_64', 'x86_64'), true)
  assert.throws(() => assertSnapshotAbi('arm64', 'x86_64'), /快照 ABI 是 x86_64，但目标是 arm64/)
  assert.throws(() => assertSnapshotAbi('x86_64', 'aarch64'), /快照 ABI 是 aarch64，但目标是 x86_64/)
  assert.throws(() => assertSnapshotAbi('arm64', 'unknown-0x28'), /快照 ABI 是 unknown-0x28/)
})

test('ABI -> -PnativeControlAbis：与 native/phone-control-core/build-config.json 的 abis 键同源', () => {
  assert.deepEqual(NATIVE_CONTROL_ABI, { arm64: 'arm64-v8a', x86_64: 'x86_64' })
  assert.equal(nativeControlAbiFor('arm64'), 'arm64-v8a')
  assert.equal(nativeControlAbiFor('x86_64'), 'x86_64')
  assert.throws(() => nativeControlAbiFor('armeabi-v7a'), /未知 ABI/)
})

// ── 产物形态判据（调试包 = 发布判据的相反结论）────────────────────────────
const badging = ({ debuggable = true, versionName = '0.15.0-x7K2mQ9z-dev', versionCode = '71', pkg = PACKAGE_NAME } = {}) => [
  "package: name='" + pkg + "' versionCode='" + versionCode + "' versionName='" + versionName + "' platformBuildVersionName='16'",
  "minSdkVersion:'26'",
  "targetSdkVersion:'34'",
  ...(debuggable ? ['application-debuggable'] : []),
  "application: label='DeepCode' icon='res/mipmap-anydpi-v26/ic_launcher.xml'",
  "launchable-activity: name='com.dsharnessmobile.shell.MainActivity'  label='' icon=''",
].join('\n')

const expected = { versionName: '0.15.0-x7K2mQ9z-dev', versionCode: 71 }

test('产物形态：调试包必须是 debuggable 且版本字段逐字相符', () => {
  const verdict = evaluateDebugBadging({ exitCode: 0, output: badging(), spawnError: null, expected })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.parsed.debuggable, true)
  assert.equal(verdict.parsed.versionName, expected.versionName)
})

test('产物形态负控：发布变体（无 application-debuggable）必须判红', () => {
  const verdict = evaluateDebugBadging({ exitCode: 0, output: badging({ debuggable: false }), spawnError: null, expected })
  assert.equal(verdict.ok, false)
  assert.match(verdict.why, /不含 application-debuggable/)
})

test('产物形态负控：versionName / versionCode / 包名任一不符即判红', () => {
  const wrongName = evaluateDebugBadging({ exitCode: 0, output: badging({ versionName: '0.15.0' }), spawnError: null, expected })
  assert.equal(wrongName.ok, false)
  assert.match(wrongName.why, /versionName 不一致/)
  const wrongCode = evaluateDebugBadging({ exitCode: 0, output: badging({ versionCode: '80' }), spawnError: null, expected })
  assert.equal(wrongCode.ok, false)
  assert.match(wrongCode.why, /versionCode 不一致/)
  const wrongPkg = evaluateDebugBadging({ exitCode: 0, output: badging({ pkg: 'com.example.other' }), spawnError: null, expected })
  assert.equal(wrongPkg.ok, false)
  assert.match(wrongPkg.why, /包名不是/)
})

test('产物形态负控：拿不到 badging 不得当成通过（aapt2 缺席 / 退出码 / 空输出）', () => {
  const spawnFailed = evaluateDebugBadging({ spawnError: new Error('ENOENT'), exitCode: 0, output: '', expected })
  assert.equal(spawnFailed.ok, false)
  assert.match(spawnFailed.why, /无法启动/)
  const nonZero = evaluateDebugBadging({ exitCode: 1, output: '', spawnError: null, expected })
  assert.equal(nonZero.ok, false)
  assert.match(nonZero.why, /退出码 1/)
  const empty = evaluateDebugBadging({ exitCode: 0, output: '   \n', spawnError: null, expected })
  assert.equal(empty.ok, false)
  assert.match(empty.why, /输出为空/)
  const unparsable = evaluateDebugBadging({ exitCode: 0, output: 'garbage', spawnError: null, expected })
  assert.equal(unparsable.ok, false)
  assert.match(unparsable.why, /不可解析/)
})

// ── 参数解析 ──────────────────────────────────────────────────────────────
test('参数：--from-release 的值可选（缺省 = 最新已发布 release）', () => {
  assert.equal(parseArgs(['--abi', 'arm64', '--from-release']).fromRelease, '')
  assert.equal(parseArgs(['--abi', 'arm64', '--from-release', 'v0.14.11']).fromRelease, 'v0.14.11')
  // 后面紧跟另一个开关时必须判成「没给值」，不得把开关名吃成 tag
  const parsed = parseArgs(['--abi', 'arm64', '--from-release', '--dry-run'])
  assert.equal(parsed.fromRelease, '')
  assert.equal(parsed.dryRun, true)
  assert.equal(parseArgs(['--abi', 'x86_64']).fromRelease, null)
})

test('参数：缺值/未知参数是用法错误（退出码 2 的那一类）', () => {
  assert.throws(() => parseArgs(['--abi']), /需要一个值/)
  assert.throws(() => parseArgs(['--abi', '--dry-run']), /需要一个值/)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

// ── GITHUB_OUTPUT ─────────────────────────────────────────────────────────
test('GITHUB_OUTPUT：单行 key=value，换行被压平（否则后续 key 变成垃圾）', () => {
  const text = formatGithubOutput({ a: '1', b: 'x\ny', c: undefined, d: null, e: 0 })
  assert.equal(text, 'a=1\nb=x y\ne=0\n')
  assert.ok(text.endsWith('\n'))
})

// ── MANIFEST 解析 ─────────────────────────────────────────────────────────
// 发布仓的 MANIFEST.txt 行格式是 `<sha256>  <仓库内路径>  <字节数>`（路径带 snapshot/ 或 apk/ 前缀）。
// 第一版用 `row.trim().endsWith(assetName)` 找条目：行尾是字节数，恒不命中，云端报的是
// 「MANIFEST.txt 里没有 snapshot-arm64.tar.xz 条目」——而条目就在那儿。这类「自己的解析写错、
// 报错却像资产缺失」最容易让人往错方向查，故把它钉进单测。
const REAL_MANIFEST = [
  '29d03d34df269e7d270ef8616d83b8cf54cd54403ea732ce5f37ecfcda708f66  apk/dsh-mobile-apk-v0.14.11-arm64.apk  166650240',
  '1f41ead47d1854fd3a134964115dc7d0dbeb04365a1d888e102b839fc4d21eb8  snapshot/snapshot-arm64.tar.xz  162287688',
  '375808b597dc7203623213d1aa459eb22bb1c22b9ab50407298356984e53bafa  snapshot/snapshot-x86_64.tar.xz  158790724',
].join('\n')

test('MANIFEST：按 basename 命中带目录前缀的条目，并取回 sha256 与字节数', () => {
  assert.deepEqual(parseManifestEntry(REAL_MANIFEST, 'snapshot-arm64.tar.xz'), {
    sha256: '1f41ead47d1854fd3a134964115dc7d0dbeb04365a1d888e102b839fc4d21eb8',
    path: 'snapshot/snapshot-arm64.tar.xz',
    size: 162287688,
  })
  assert.equal(parseManifestEntry(REAL_MANIFEST, 'snapshot-x86_64.tar.xz').size, 158790724)
})

test('MANIFEST 负控：不存在的资产、被截断的行、非十六进制摘要都不命中', () => {
  assert.equal(parseManifestEntry(REAL_MANIFEST, 'snapshot-armv7.tar.xz'), null)
  // 只有摘要没有路径的行：不得当成命中（否则会取到 undefined 路径再崩在别处）。
  assert.equal(parseManifestEntry('1f41ead47d1854fd3a134964115dc7d0dbeb04365a1d888e102b839fc4d21eb8', 'snapshot-arm64.tar.xz'), null)
  // 摘要不是 64 位十六进制：跳过，不得因为 basename 对上就采信。
  assert.equal(parseManifestEntry('sha256:whatever  snapshot/snapshot-arm64.tar.xz  1', 'snapshot-arm64.tar.xz'), null)
  // 大小字段缺失时 size=null（调用方据此跳过字节数断言，而不是与 undefined 比较后误判）。
  assert.equal(parseManifestEntry('1f41ead47d1854fd3a134964115dc7d0dbeb04365a1d888e102b839fc4d21eb8  snapshot/snapshot-arm64.tar.xz', 'snapshot-arm64.tar.xz').size, null)
})
