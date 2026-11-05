import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { versionedFixture } from './lib/fixture.mjs'
import { patchImageExpiry, EXPIRED_IMAGE_TEXT } from '../image-expiry-E1.mjs'
import { patchRequestPreview } from '../image-request-preview-P1.mjs'

function extract(source, name, injected = {}) {
  let start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  const end = source.indexOf('\n}', start)
  if (source.slice(start - 6, start) === 'async ') start -= 6
  return Function(...Object.keys(injected), source.slice(start, end + 2) + `; return ${name}`)(...Object.values(injected))
}
const packages = [['dsh-attachment-local', 'local'], ['dsh-llm-pi-ai', 'pi'], ['dsh-llm-deepseek', 'deepseek']]
const patched = new Map()
for (const [name, kind] of packages) patched.set(kind, patchImageExpiry(readFileSync(versionedFixture(name, 'lib/index.js'), 'utf8'), kind))

test('清理兼容补丁可重入，可与压缩补丁按两种顺序组合，三包语法正确', () => {
  for (const [name, kind] of packages) {
    const source = readFileSync(versionedFixture(name, 'lib/index.js'), 'utf8')
    const after = patched.get(kind)
    assert.equal(patchImageExpiry(after, kind), after)
    const windows = patchImageExpiry(source.replace(/\n/g, '\r\n'), kind)
    assert.equal(windows.replace(/\r\n/g, '\n'), after)
    assert.equal(patchImageExpiry(patchRequestPreview(source, kind), kind), patchRequestPreview(after, kind))
    const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: after, encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr)
  }
})

test('两种协议均将已清理图片替换为同一稳定占位，保留文字/当前图/已有淘汰记录且不改历史', () => {
  for (const kind of ['pi', 'deepseek']) {
    const project = extract(patched.get(kind), 'dshProjectMissingImages')
    const history = [{ role: 'user', content: [{ type: 'text', text: '继续' }, { type: 'image', attachment: { attachmentId: 'old' } }, { type: 'image', attachment: { attachmentId: 'current' } }, { type: 'image', offloaded: true, attachment: { attachmentId: 'offloaded' } }] }]
    const before = structuredClone(history), versions = new Map([['current', { bytes: 20 }]])
    const actual = project(history, versions)
    assert.deepEqual(history, before)
    assert.deepEqual(actual[0].content[1], { type: 'text', text: EXPIRED_IMAGE_TEXT })
    assert.deepEqual(actual[0].content[2], history[0].content[2])
    assert.deepEqual(actual[0].content[3], history[0].content[3])
    assert.deepEqual(project(history, versions), actual)
  }
})

test('Pi真实准备器只容忍已清理文件；解码/权限故障必须继续如实失败', async () => {
  const collectImageRefs = extract(patched.get('pi'), 'collectImageRefs')
  const prepare = extract(patched.get('pi'), 'prepareRequestImages', { collectImageRefs, requestImageTarget: () => ({ width: 720, height: 1600, maxBytes: 1048576 }) })
  const history = [{ role: 'tool', content: [{ type: 'image', attachment: { attachmentId: 'old' } }, { type: 'image', attachment: { attachmentId: 'current' } }] }]
  const store = { readImageRequest: async ref => { if (ref.attachmentId === 'old') throw Object.assign(new Error('gone'), { code: 'ATTACHMENT_NOT_FOUND' }); return { bytes: 3 } } }
  assert.deepEqual([...await prepare(history, store, {})], [['current', { bytes: 3 }]])
  await assert.rejects(prepare(history, { readImageRequest: async () => { throw Object.assign(new Error('broken'), { code: 'ATTACHMENT_CORRUPT' }) } }, {}), error => error.code === 'ATTACHMENT_CORRUPT')
})
