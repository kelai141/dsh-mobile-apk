import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { versionedFixture } from './lib/fixture.mjs'
import { IMAGE_HISTORY_CORE, IMAGE_BATCH_FUNCTION, patchImageBatchOffload, planImageHistory } from '../image-history-batch-offload-I1.mjs'

const core = readFileSync(versionedFixture('dsh-llm', 'lib/index.js'), 'utf8')
const offload = readFileSync(versionedFixture('dsh-compaction-image-offload', 'lib/index.js'), 'utf8')
const manifestFile = IMAGE_HISTORY_CORE.replace(/lib\/index\.js$/, 'package.json')
const files = {
  [IMAGE_HISTORY_CORE]: core,
  [manifestFile]: readFileSync(versionedFixture('dsh-llm', 'package.json'), 'utf8'),
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = file => { assert.ok(file in files, file); return files[file] }
function sourceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  const end = source.indexOf('\n}', start)
  assert.ok(end > start, name)
  return source.slice(start, end + 2)
}
function fn(source, name, injected = {}) {
  return Function(...Object.keys(injected), sourceFunction(source, name) + `; return ${name};`)(...Object.values(injected))
}
class LlmError extends Error { constructor(message, code) { super(message); this.code = code } }
const patched = patchImageBatchOffload(core)
const batch = fn(patched, 'offloadedImagePrefixCount', { LlmError })
const budget = { maxBytes: 100, maxImages: 100 }

// Real published functions are extracted from the pinned artifact; only framework I/O is stubbed.
test('单文件固定版本补丁可重入，预算之外的请求及历史投影逻辑不改', () => {
  const plan = planImageHistory(read)
  assert.equal(plan.length, 1)
  assert.equal(plan[0].after, patched)
  assert.equal(patchImageBatchOffload(patched), patched)
  assert.equal(sourceFunction(patched, 'requiredImageOffload'), sourceFunction(core, 'requiredImageOffload'))
  assert.equal(sourceFunction(patched, 'projectOffloadedImages'), sourceFunction(core, 'projectOffloadedImages'))
  const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: patched, encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)
})

test('低于90%不淘汰；正好到90%一次淘汰最旧40%并向上取整', () => {
  assert.equal(batch(Array(8).fill(10), budget), 0)
  assert.equal(batch(Array(9).fill(10), budget), 4)
  assert.equal(batch(Array(10).fill(10), budget), 4)
})

test('数量上限与字节上限独立触发；旧 quantum 不叠加覆盖40%策略', () => {
  assert.equal(batch(Array(9).fill(1), { maxImages: 10 }), 4)
  assert.equal(batch(Array(8).fill(1), { maxImages: 10 }), 0)
  assert.equal(batch(Array(9).fill(10), { maxBytes: 100, byteQuantum: 10000, countQuantum: 10000 }), 4)
  assert.equal(batch(Array(9).fill(10), {}), 0)
})

test('旧小图释放40%仍不够时继续淘汰，保留最新图片', () => {
  const lengths = [1, 1, 1, 1, 1, 80, 10]
  const removed = batch(lengths, { maxBytes: 100 })
  assert.equal(removed, 6)
  assert.equal(lengths.slice(removed).reduce((a, b) => a + b, 0), 10)
  assert.equal(batch([50, 50], { maxBytes: 100 }), 1)
})

test('不淘汰唯一可用观察；最新单图自身超硬上限时明确报错且不篡改历史', () => {
  assert.equal(batch([], budget), 0)
  assert.equal(batch([95], budget), 0)
  const lengths = Object.freeze([10, 101])
  assert.throws(() => batch(lengths, budget), error => error.code === 'INVALID_REQUEST')
  assert.deepEqual(lengths, [10, 101])
})

test('实际 requiredImageOffload 按每次出现计数及 Base64 后字节触发', () => {
  const base64Length = fn(core, 'base64Length')
  const visitImageBlocks = fn(core, 'visitImageBlocks')
  const required = fn(patched, 'requiredImageOffload', { base64Length, visitImageBlocks, offloadedImagePrefixCount: batch })
  const content = Array.from({ length: 9 }, () => ({ type: 'image', attachment: { bytes: 3 } }))
  const history = [{ role: 'user', content: content.slice(0, 2) }, { role: 'tool', content: content.slice(2) }]
  assert.equal(required(history, { representation: 'raw', maxBytes: 40 }, () => 3), 0)
  assert.equal(required(history, { representation: 'base64', maxBytes: 40 }, () => 3), 4)
  assert.equal(required(history, { representation: 'raw', maxImages: 10 }, () => 3), 4)
  const marked = history.map(m => ({ ...m, content: m.content.map(b => ({ ...b, offloaded: true })) }))
  assert.equal(required(marked, { representation: 'base64', maxBytes: 40 }, () => { throw new Error('already omitted') }), 0)
})

test('真实淘汰执行器只记录一个批次的最旧图片，最新图不入淘汰清单', () => {
  const select = fn(offload, 'offloadOldestImages')
  const events = Array.from({ length: 9 }, (_, index) => ({ type: 'tool/result', seq: index + 1,
    message: { role: 'tool', content: [{ type: 'image', attachment: { attachmentId: String(index) } }] } }))
  const recorded = []
  const session = { eventAt: seq => events[seq - 1], deriveEventMessage: event => event.message,
    append: (type, data) => recorded.push({ type, data }) }
  const count = batch(Array(9).fill(10), budget)
  assert.equal(select(session, events.map(event => event.seq), count), true)
  assert.deepEqual(recorded, [{ type: 'image/offload', data: { targets: [1, 2, 3, 4].map(seq => ({ seq, imageIndexes: [0] })) } }])
})

test('连续请求受控对照：批量释放后留出稳定窗口，非服务端缓存命中率测试', () => {
  const old = fn(core, 'offloadedImagePrefixCount')
  function simulate(policy) {
    let lengths = []; const rounds = []
    for (let turn = 1; turn <= 40; turn++) {
      lengths.push(10)
      const drop = policy(lengths, { maxBytes: 100 })
      if (drop > 0) { rounds.push({ turn, drop }); lengths = lengths.slice(drop) }
      assert.ok(lengths.length > 0 && lengths.reduce((a, b) => a + b, 0) <= 100)
    }
    return rounds
  }
  const before = simulate(old); const after = simulate(batch)
  assert.equal(before.length, 30)
  assert.equal(after.length, 8)
  assert.deepEqual(after.slice(0, 3), [{ turn: 9, drop: 4 }, { turn: 13, drop: 4 }, { turn: 17, drop: 4 }])
})

test('错版本、错包身份、漂移和伪 marker 拒绝', () => {
  const manifest = JSON.parse(files[manifestFile])
  for (const changed of [{ ...manifest, version: '0.0.0' }, { ...manifest, name: 'wrong' }]) {
    assert.throws(() => planImageHistory(file => file === manifestFile ? JSON.stringify(changed) : read(file)), /requires/)
  }
  assert.throws(() => patchImageBatchOffload(core.replace('const countQuantum = budget.countQuantum ?? 1;', 'const changed = 1;')), /anchors changed/)
  assert.throws(() => patchImageBatchOffload(patched.replace(IMAGE_BATCH_FUNCTION, IMAGE_BATCH_FUNCTION.replace('return removed;', 'return 0;'))), /anchors changed/)
})

test('runner 未施加负控、施加、重复幂等和被破坏的策略均可识别', () => {
  const staging = join(root, '.deploy-tmp', 'image-history-batch-test')
  mkdirSync(staging, { recursive: true })
  const stage = mkdtempSync(join(staging, 'stage-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, file)), { recursive: true }); writeFileSync(join(stage, file), content)
  }
  const run = mode => spawnSync(process.execPath, [join(root, 'scripts/patches/apply-patches.mjs'), stage,
    mode, '--scope', 'engine', '--only', 'image-history-batch-offload-I1'], { encoding: 'utf8' })
  assert.equal(run('--check').status, 1)
  const applied = run('--apply')
  assert.equal(applied.status, 0, applied.stdout + applied.stderr)
  assert.equal(run('--check').status, 0)
  assert.match(run('--apply').stdout, /changed=0/)
  writeFileSync(join(stage, IMAGE_HISTORY_CORE), patched.replace(IMAGE_BATCH_FUNCTION, IMAGE_BATCH_FUNCTION.replace('return removed;', 'return 0;')))
  assert.notEqual(run('--check').status, 0)
})
