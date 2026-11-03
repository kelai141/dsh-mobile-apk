// issue #1394：离线 seed 的 sha256 从不与 MANIFEST 交叉校验，却以「校验值」身份渲染。
//
// 修法三态：verified / unverified(旧 seed 无 manifestSha256、拉不到 MANIFEST、seed 不自洽) /
// mismatch(能证明不一致)。核心指控是「未验证却当已校验展示」，所以判据必须能区分这三态。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  apkDigestFromManifest, classifySeedDigest, digestStateKey, seedConsistency,
} from '../src/assets/digest.js'

const D1 = 'a'.repeat(64)
const D2 = 'b'.repeat(64)
const MANIFEST = [
  D1 + '  apk/app-arm64.apk  1000',
  D2 + '  apk/app-x86_64.apk  2000',
  '',
].join('\n')

/** 一份正常的 seed：摘要与 manifest 一致，且带 manifestSha256。 */
function goodSeed(over = {}) {
  return {
    tag: 'v1',
    publishedAt: '2026-01-01T00:00:00Z',
    generatedAt: '2026-01-01T01:00:00Z',
    assets: [{ name: 'app-arm64.apk', size: 1000 }, { name: 'app-x86_64.apk', size: 2000 }],
    sha256: { arm64: D1, x86_64: D2 },
    manifestSha256: 'c'.repeat(64),
    ...over,
  }
}

const pickApk = (tag, abi, assets) => {
  const want = abi === 'arm64' ? 'app-arm64.apk' : 'app-x86_64.apk'
  return assets.some((a) => a.name === want) ? want : null
}

test('#1394 正常：manifest 摘要与逐条摘要都对上 -> verified', () => {
  const seed = goodSeed()
  const state = classifySeedDigest({
    manifestSha256: seed.manifestSha256,
    computedManifestSha256: seed.manifestSha256,
    seedDigest: seed.sha256.arm64,
    manifestDigest: apkDigestFromManifest(MANIFEST, 'app-arm64.apk'),
    consistency: seedConsistency(seed, pickApk),
  })
  assert.equal(state, 'verified')
})

test('#1394 删掉 manifestSha256（旧 seed）-> unverified，不得判失败也不得算已校验', () => {
  const seed = goodSeed({ manifestSha256: undefined })
  const state = classifySeedDigest({
    manifestSha256: seed.manifestSha256,
    computedManifestSha256: 'c'.repeat(64),
    seedDigest: seed.sha256.arm64,
    manifestDigest: apkDigestFromManifest(MANIFEST, 'app-arm64.apk'),
    consistency: seedConsistency(seed, pickApk),
  })
  assert.equal(state, 'unverified', '旧 seed 缺字段必须落到「未验证」，不是失败')
})

test('#1394 手改一条摘要 -> mismatch（manifest 没变，seed 的 sha256 被改过）', () => {
  const seed = goodSeed({ sha256: { arm64: 'd'.repeat(64), x86_64: D2 } })
  const state = classifySeedDigest({
    manifestSha256: seed.manifestSha256,
    computedManifestSha256: seed.manifestSha256,
    seedDigest: seed.sha256.arm64,
    manifestDigest: apkDigestFromManifest(MANIFEST, 'app-arm64.apk'),
    consistency: seedConsistency(seed, pickApk),
  })
  assert.equal(state, 'mismatch')
})

test('#1394 manifest 本身被换掉（摘要对不上）-> mismatch', () => {
  const state = classifySeedDigest({
    manifestSha256: 'c'.repeat(64),
    computedManifestSha256: 'e'.repeat(64),
    seedDigest: D1,
    manifestDigest: D1,
    consistency: [],
  })
  assert.equal(state, 'mismatch')
})

test('#1394 拉不到 MANIFEST / 环境无 subtle -> unverified（不是 mismatch）', () => {
  const seed = goodSeed()
  assert.equal(classifySeedDigest({
    manifestSha256: seed.manifestSha256,
    computedManifestSha256: '',
    seedDigest: D1,
    manifestDigest: null,
    consistency: [],
  }), 'unverified')
})

test('#1394 辅修：摘要指向不存在的资产 / 发布时间晚于生成时间 -> 压到 unverified', () => {
  const orphan = goodSeed({ assets: [{ name: 'app-x86_64.apk', size: 2000 }] })
  assert.deepEqual(seedConsistency(orphan, pickApk), ['digest-without-asset:arm64'])
  assert.equal(classifySeedDigest({
    manifestSha256: 'c'.repeat(64),
    computedManifestSha256: 'c'.repeat(64),
    seedDigest: D1,
    manifestDigest: D1,
    consistency: seedConsistency(orphan, pickApk),
  }), 'unverified', 'seed 自身矛盾时不得判成 verified')

  const skewed = goodSeed({ publishedAt: '2026-01-02T00:00:00Z', generatedAt: '2026-01-01T00:00:00Z' })
  assert.deepEqual(seedConsistency(skewed, pickApk), ['published-after-generated'])
})

test('#1394 apkDigestFromManifest：只认唯一且格式合法的条目', () => {
  assert.equal(apkDigestFromManifest(MANIFEST, 'app-arm64.apk'), D1)
  assert.equal(apkDigestFromManifest(MANIFEST, 'apk/app-arm64.apk'), D1)
  assert.equal(apkDigestFromManifest(MANIFEST, 'missing.apk'), null)
  // 重复条目必须拒绝（不唯一就没有确定值）
  assert.equal(apkDigestFromManifest(MANIFEST + D2 + '  apk/app-arm64.apk  1000\n', 'app-arm64.apk'), null)
  assert.equal(apkDigestFromManifest('', 'app-arm64.apk'), null)
})

test('#1394 页面不得把未验证说成已校验：文案键必须分三态', () => {
  assert.equal(digestStateKey('verified'), 'digestVerified')
  assert.equal(digestStateKey('mismatch'), 'digestMismatch')
  assert.equal(digestStateKey('unverified'), 'digestUnverified')
  assert.equal(digestStateKey(undefined), 'digestUnverified', '未知状态必须按未验证处理')
  assert.notEqual(digestStateKey('unverified'), digestStateKey('verified'))
})

test('#1394 页面渲染与校验真的接上了（源码契约）', () => {
  const app = readFileSync(new URL('../src/assets/app.js', import.meta.url), 'utf8')
  assert.match(app, /digestStateKey\(state\.digestState\)/, 'SHA-256 行必须带三态标签')
  assert.match(app, /async function verifySeedDigest\(\)/, '必须有校验函数')
  assert.match(app, /classifySeedDigest\(\{/, '必须走 classifySeedDigest 判据')
  assert.match(app, /probeUrl\(state\.current\)/, '必须重新拉当前线路的 MANIFEST')
})
