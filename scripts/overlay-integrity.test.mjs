// overlay-integrity.test.mjs — issue #1415 回归：overlay 包缺 sha512 时不得接受远端字节。
//
// 缺陷形态：判据写成 `if (dist.sha512 && createHash(...) !== dist.sha512)`——镜像不返回
// sha512（或只给 integrity=sha1-…）时整段短路，未校验的 tarball 被解压进引擎树。
//
// 判据选「缺摘要必须抛」，而不是「有没有告警」：告警拦不住构建。
// 另外钉住 integrity（SRI 形态 `sha512-<base64>`）这条合法回落路径，避免修复把正规镜像也拒了。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertOverlayDigest, expectedSha512 } from './lib/overlay-integrity.mjs'

const bytes = Buffer.from('overlay tarball bytes for #1415\n', 'utf8')
const good = createHash('sha512').update(bytes).digest('base64')
const bad = createHash('sha512').update(Buffer.from('tampered\n', 'utf8')).digest('base64')

test('sha512 匹配时放行', () => {
  assert.equal(assertOverlayDigest({ sha512: good }, bytes, 'pkg@1.0.0'), true)
})

test('sha512 不匹配时拒绝', () => {
  assert.throws(() => assertOverlayDigest({ sha512: bad }, bytes, 'pkg@1.0.0'), /sha512 不匹配/)
})

test('缺 sha512 但有 integrity=sha512-… 时按 integrity 比对', () => {
  assert.equal(assertOverlayDigest({ integrity: 'sha512-' + good }, bytes, 'pkg@1.0.0'), true)
  assert.throws(
    () => assertOverlayDigest({ integrity: 'sha512-' + bad }, bytes, 'pkg@1.0.0'),
    /sha512 不匹配/,
  )
})

test('integrity 里混有 sha1 时仍取 sha512 那条', () => {
  assert.equal(expectedSha512({ integrity: 'sha1-abc123 sha512-' + good }), good)
})

test('两种摘要都没有时拒绝（不得静默接受未校验字节）', () => {
  assert.throws(() => assertOverlayDigest({}, bytes, 'pkg@1.0.0'), /缺少完整性摘要/)
  assert.throws(() => assertOverlayDigest(undefined, bytes, 'pkg@1.0.0'), /缺少完整性摘要/)
  // 只有 sha1（部分镜像的旧形态）同样不够：引擎树里放的是被投毒的 tarball 时，sha1 拦不住。
  assert.throws(
    () => assertOverlayDigest({ integrity: 'sha1-abc123' }, bytes, 'pkg@1.0.0'),
    /缺少完整性摘要/,
  )
})
