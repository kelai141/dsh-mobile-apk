import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { versionedFixture } from './lib/fixture.mjs'
import { patchRequestPreview, planRequestPreview, PREVIEW_LOCAL, PREVIEW_PI, PREVIEW_DEEPSEEK } from '../image-request-preview-P1.mjs'

const targets = [[PREVIEW_LOCAL, 'local'], [PREVIEW_PI, 'pi'], [PREVIEW_DEEPSEEK, 'deepseek']]
const files = {}
for (const [file] of targets) {
  const name = file.split('/').at(-3)
  files[file] = readFileSync(versionedFixture(name, 'lib/index.js'), 'utf8')
  files[file.replace(/lib\/index\.js$/, 'package.json')] = readFileSync(versionedFixture(name, 'package.json'), 'utf8')
}
function extract(source, name, injected = {}) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  const end = source.indexOf('\n}', start)
  const body = source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, end + 2)
  return Function(...Object.keys(injected), body + `; return ${name}`)(...Object.values(injected))
}

test('真实固定版本三包预检、幂等与语法检查；任一版本漂移拒绝', () => {
  const plan = planRequestPreview(file => files[file])
  assert.equal(plan.length, 3)
  for (const [index, { after }] of plan.entries()) {
    assert.equal(patchRequestPreview(after, targets[index][1]), after)
    assert.equal(patchRequestPreview(files[targets[index][0]].replace(/\n/g, '\r\n'), targets[index][1]).replace(/\r\n/g, '\n'), after)
    const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: after, encoding: 'utf8' })
    assert.equal(checked.status, 0, checked.stderr)
  }
  assert.throws(() => planRequestPreview(file => file.endsWith('package.json') ? files[file].replace('0.2.1-rc.3', '9.9.9') : files[file]), /requires pinned/)
  assert.throws(() => patchRequestPreview(files[PREVIEW_LOCAL].replace('const REQUEST_IMAGE_TRANSFORM_VERSION', 'const CHANGED'), 'local'), /anchor changed/)
})

test('Pi 竖屏横屏及小图：等比1600上限，不放大，不放宽路由像素/字节限制', () => {
  // Published geometry used by the real provider artifact, not a reimplementation.
  const attachment = readFileSync(versionedFixture('dsh-attachment', 'lib/index.js'), 'utf8')
  const requestImageDimensions = extract(attachment, 'requestImageDimensions')
  const project = extract(patchRequestPreview(files[PREVIEW_PI], 'pi'), 'requestImageTarget', { requestImageDimensions })
  const normal = { maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 }
  assert.deepEqual(project({ width: 1260, height: 2800 }, normal), { width: 720, height: 1600, maxBytes: 1048576 })
  assert.deepEqual(project({ width: 3200, height: 1440 }, normal), { width: 1600, height: 720, maxBytes: 1048576 })
  assert.deepEqual(project({ width: 480, height: 800 }, normal), { width: 480, height: 800, maxBytes: 1048576 })
  const strict = project({ width: 1260, height: 2800 }, { maxPixels: 640000, maxBytes: 250000 })
  assert.ok(strict.width * strict.height <= 640000)
  assert.equal(strict.maxBytes, 250000)
})

test('DeepSeek的编译产物中内联4096阈值也降至1600，文件上传不绕过预览', () => {
  const patched = patchRequestPreview(files[PREVIEW_DEEPSEEK], 'deepseek')
  const project = extract(patched, 'resolveRequestImageTarget', {
    DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET: 262144,
    REQUEST_IMAGE_MAX_DIMENSION: 1600,
    deepSeekRequestImageDimensions: (width, height) => ({ width, height }),
    longEdgeDimensions: (w, h, edge) => ({ width: Math.round(w * edge / Math.max(w, h)), height: Math.round(h * edge / Math.max(w, h)) }),
    resolveRequestImageMaxBytes: () => 2097152,
  })
  assert.deepEqual(project({}, { width: 1260, height: 2800 }), { width: 720, height: 1600, maxBytes: 1048576 })
})

test('小于预算的源图也进入真实压缩调用，绝不返回源字节', async () => {
  const calls = []
  const encoded = { data: new Uint8Array([5, 6]), mediaType: 'image/jpeg', width: 400, height: 800 }
  const create = extract(patchRequestPreview(files[PREVIEW_LOCAL], 'local'), 'createRequestImage', {
    pipeline: (ref, target) => { calls.push({ ref, target }); return 'pipeline' },
    encodingLadder: (pipe, alpha) => { assert.equal(pipe, 'pipeline'); assert.equal(alpha, false); return [] },
    encodeFirstWithinLimit: async () => encoded,
    isExhaustedEncoding: () => false,
  })
  const source = { ref: { width: 400, height: 800, mediaType: 'image/png' }, data: new Uint8Array([1, 2]) }
  const result = await create(source, { width: 400, height: 800, maxBytes: 1048576 }, false)
  assert.equal(result, encoded)
  assert.notEqual(result.data, source.data)
  assert.equal(calls.length, 1)
})

test('新变换版本不复用旧透传缓存；相同策略不随请求次数改变', () => {
  const getDescriptor = source => {
    const version = source.match(/const REQUEST_IMAGE_TRANSFORM_VERSION = "([^"]+)"/)[1]
    return extract(source, 'descriptor', { REQUEST_IMAGE_TRANSFORM_VERSION: version, IMAGE_ENCODING_QUALITIES: [85, 75, 60] })
  }
  const before = getDescriptor(files[PREVIEW_LOCAL])
  const after = getDescriptor(patchRequestPreview(files[PREVIEW_LOCAL], 'local'))
  const source = { attachmentId: 'sha256:' + 'a'.repeat(64) }, target = { width: 720, height: 1600, maxBytes: 1048576 }
  const hash = value => createHash('sha256').update(value).digest('hex')
  assert.notEqual(hash(before(source, target)), hash(after(source, target)))
  assert.equal(after(source, target), after(source, target))
})

test('真实补丁CLI完整预检、写回、重复应用与负控，不只验证辅助函数', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
  const temporary = join(root, '.deploy-tmp/image-preview-cli')
  mkdirSync(temporary, { recursive: true })
  const stage = mkdtempSync(join(temporary, 'stage-'))
  for (const [file, data] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, file)), { recursive: true })
    writeFileSync(join(stage, file), data)
  }
  const run = mode => spawnSync(process.execPath, [join(root, 'scripts/patches/apply-patches.mjs'), stage, mode, '--scope', 'engine', '--only', 'image-request-preview-P1,image-expiry-E1'], { encoding: 'utf8' })
  assert.equal(run('--check').status, 1)
  const applied = run('--apply')
  assert.equal(applied.status, 0, applied.stdout + applied.stderr)
  assert.equal(run('--check').status, 0)
  const again = run('--apply')
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.match(again.stdout, /changed=0/)
  writeFileSync(join(stage, PREVIEW_PI), readFileSync(join(stage, PREVIEW_PI), 'utf8').replace('1600 / Math.max(ref.width, ref.height)', '3200 / Math.max(ref.width, ref.height)'))
  assert.notEqual(run('--check').status, 0)
})
