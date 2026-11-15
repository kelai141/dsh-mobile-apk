// native-image-delivery.test.mjs — 原生截图回执到附件/工具内容的纯边界回归。
// 直接运行 TS 源码（Node 24 erasable TypeScript），不依赖构建产物或额外依赖。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  NATIVE_IMAGE_MAX_BYTES,
  deliverNativeImage,
  renderNativeImage,
  runNativeImage,
} from '../src/native-image-delivery.ts'

// 2x3 的真实 JPEG（System.Drawing 编码），确保坏图用例不是靠文件头猜测。
const JPEG_BASE64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5iooortPlD//Z'

const JPEG = Buffer.from(JPEG_BASE64, 'base64')
const JPEG_SHA = createHash('sha256').update(JPEG).digest('hex')

test('模型或附件无法交付时不执行原生截图', async () => {
  let invoked = 0
  const execute = async () => { invoked++; return receipt() }
  for (const options of [harness({ modalities: ['text'] }).options, { ...harness().options, attachments: undefined }]) {
    const result = await runNativeImage('real', options, execute)
    assert.equal(result.ok, false)
    assert.equal(result.executed, 'no')
  }
  assert.equal(invoked, 0)
})

test('截图前只查一次模型，成功后只交付一张且不会接受其它屏', async () => {
  const h = harness()
  let lookups = 0
  let invocations = 0
  h.options.llm.resolveModelInfo = async () => { lookups++; return { inputModalities: ['image'] } }
  const result = await runNativeImage('real', h.options, async () => { invocations++; return receipt() })
  assert.equal(result.ok, true)
  assert.equal(lookups, 1)
  assert.equal(invocations, 1)
  assert.equal(h.calls.length, 1)
  const rejected = await runNativeImage('virtual-1', h.options, async () => receipt())
  assert.equal(rejected.error.code, 'image-target-mismatch')
  assert.equal(h.calls.length, 1)
})

function receipt(overrides = {}) {
  return {
    ok: true,
    executed: 'yes',
    screenId: 'real',
    image: {
      imageId: 'a'.repeat(64),
      mediaType: 'image/jpeg',
      bytes: JPEG.length,
      sha256: JPEG_SHA,
      epoch: '7',
      screenId: 'real',
      generation: '42',
      width: 1080,
      height: 2400,
      region: { x1: 0, y1: 0, x2: 1080, y2: 2400 },
      data: JPEG_BASE64,
      ...overrides,
    },
  }
}

function harness({ save, modalities = ['text', 'image'], route = { provider: 'p', model: 'm' } } = {}) {
  const calls = []
  const attachments = {
    imageLimits: {
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxImageBytes: 50 * 1024 * 1024,
      maxMessageImageBytes: 200 * 1024 * 1024,
    },
    async saveImage(input) {
      calls.push(input)
      if (save !== undefined) return save(input)
      // 附件编码尺寸故意不同于原生逻辑尺寸，验证两套口径不互相覆盖。
      return { attachmentId: 'sha256:' + JPEG_SHA, mediaType: 'image/jpeg', bytes: 77, width: 2, height: 3, name: input.name }
    },
  }
  const llm = {
    async resolveModelInfo() {
      return modalities === undefined ? {} : { inputModalities: modalities }
    },
  }
  return { calls, options: { attachments, llm, route } }
}

test('一张图：保存一次、保留原生逻辑尺寸/region，render 只带一张图', async () => {
  const h = harness()
  const out = await deliverNativeImage(receipt(), h.options)
  assert.equal(out.ok, true)
  assert.equal(out.executed, 'yes')
  assert.equal(h.calls.length, 1, '只能保存一次')
  assert.deepEqual(Buffer.from(h.calls[0].data), JPEG, '传给附件的字节必须与回执完全一致')
  assert.equal(h.calls[0].mediaType, 'image/jpeg')
  assert.equal(out.width, 1080)
  assert.equal(out.height, 2400)
  assert.deepEqual(out.region, { x1: 0, y1: 0, x2: 1080, y2: 2400 })
  assert.deepEqual(out.preview, { width: 2, height: 3, bytes: 77 })

  const blocks = renderNativeImage(out)
  assert.equal(blocks.filter((block) => block.type === 'image').length, 1)
  assert.equal(blocks[0].type, 'text')
  assert.equal(blocks[1].attachment.attachmentId, 'sha256:' + JPEG_SHA)
})

test('unicode 与大 u64 字符串原样保留，不被数值化', async () => {
  const epoch = '9007199254740993'
  const generation = '18446744073709551615'
  const screenId = '虚拟-屏-一'
  const base = receipt({ epoch, generation, screenId })
  const out = await deliverNativeImage(
    { ...base, screenId },
    harness().options,
  )
  assert.equal(out.ok, true)
  assert.equal(out.native.epoch, epoch)
  assert.equal(out.native.generation, generation)
  assert.equal(out.native.screenId, screenId)
  assert.equal(out.screenId, screenId)
  assert.equal(typeof out.native.generation, 'string', '超出安全整数的代次必须保持字符串')
})

test('原生逻辑尺寸与附件编码尺寸互相隔离', async () => {
  const out = await deliverNativeImage(
    receipt({ width: 1440, height: 3200, region: { x1: 10, y1: 20, x2: 700, y2: 900 } }),
    harness().options,
  )
  assert.equal(out.ok, true)
  assert.equal(out.width, 1440)
  assert.equal(out.height, 3200)
  assert.deepEqual(out.region, { x1: 10, y1: 20, x2: 700, y2: 900 })
  assert.equal(out.preview.width, 2)
  assert.equal(out.preview.height, 3)
  assert.equal(out.image.width, 2)
  assert.equal(out.image.height, 3)
  assert.match(out.text, /1440×3200/)
  assert.doesNotMatch(out.text, /2[x×]3/)
})

test('失败不回退到 Read：不保存、不给路径、不提示 read_image', async () => {
  const h = harness()
  const out = await deliverNativeImage(receipt({ data: JPEG_BASE64.slice(0, -2) }), h.options)
  assert.equal(out.ok, false)
  assert.equal(h.calls.length, 0)
  assert.equal(out.imagePath, '')
  assert.equal(out.executed, 'yes', '附件失败也要保留已执行事实')
  assert.doesNotMatch(out.text, /read_image/)
})

test('坏 JPEG 拒绝，即使摘要与声明字节自洽', async () => {
  const broken = Buffer.from(JPEG.subarray(0, JPEG.length - 2))
  const data = broken.toString('base64')
  const out = await deliverNativeImage(
    receipt({ data, bytes: broken.length, sha256: createHash('sha256').update(broken).digest('hex') }),
    harness().options,
  )
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'image-jpeg')
})

test('摘要不符拒绝', async () => {
  const out = await deliverNativeImage(receipt({ sha256: 'b'.repeat(64) }), harness().options)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'image-digest')
})

test('附件保存失败只调用一次，不重试', async () => {
  const h = harness({ save: async () => { throw new Error('disk full') } })
  const out = await deliverNativeImage(receipt(), h.options)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'attachment-save-failed')
  assert.equal(h.calls.length, 1, '失败后不得重试')
  assert.equal(out.executed, 'yes')
  assert.equal(out.imagePath, '')
})

test('模型能力不明时不保存附件', async () => {
  for (const modalities of [undefined, ['text']]) {
    const h = harness()
    h.options.llm = {
      async resolveModelInfo() {
        return modalities === undefined ? {} : { inputModalities: modalities }
      },
    }
    const out = await deliverNativeImage(receipt(), h.options)
    assert.equal(out.ok, false)
    assert.equal(out.error.code, 'model-image-capability-unconfirmed')
    assert.equal(h.calls.length, 0)
  }
})

test('超过 1 MiB 在保存前拒绝', async () => {
  const h = harness()
  const out = await deliverNativeImage(receipt({ bytes: NATIVE_IMAGE_MAX_BYTES + 1 }), h.options)
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'image-bytes')
  assert.equal(h.calls.length, 0)
})

test('data.image 嵌套形态可用；两份图像并存则拒绝', async () => {
  const flat = receipt()
  const nested = { ok: true, executed: 'yes', screenId: 'real', data: { image: flat.image } }
  const ok = await deliverNativeImage(nested, harness().options)
  assert.equal(ok.ok, true)

  const h = harness()
  const both = await deliverNativeImage({ ...flat, data: { image: flat.image } }, h.options)
  assert.equal(both.ok, false)
  assert.equal(both.error.code, 'image-ambiguous')
  assert.equal(h.calls.length, 0)
})

test('原生 IPC 的单份字节与耐久元数据一起交付，不重复存图', async () => {
  const flat = receipt()
  const { data, ...metadata } = flat.image
  const h = harness()
  const result = await deliverNativeImage({ ...flat, data: { image: metadata } }, h.options)
  assert.equal(result.ok, true)
  assert.equal(h.calls.length, 1)
  assert.equal(renderNativeImage(result).filter((block) => block.type === 'image').length, 1)
  for (const altered of [{ ...metadata, sha256: '0'.repeat(64) },
    { ...metadata, region: { ...metadata.region, x2: metadata.region.x2 - 1 } }]) {
    const mismatch = await deliverNativeImage({ ...flat, data: { image: altered } }, h.options)
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.error.code, 'image-receipt-mismatch')
  }
  assert.equal(h.calls.length, 1)
})

test('薄插件只注册一套截图工具，并使用实际工具渲染单图', async () => {
  const { registerPhoneControlTools } = await import('../lib/index.js')
  const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools')
  const h = harness()
  const nativeCalls = []
  const tools = []
  const session = { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }
  let oldCalls = 0
  const context = {
    tools: { register: (tool) => tools.push(tool) },
    get: (service) => h.options[service],
    androidPrivilege: {
      nativeControlCapabilities: async () => ({ ok: true }),
      nativeControlExecute: async (operation, screenId, args, source) => {
        nativeCalls.push({ operation, screenId, args, source })
        return receipt({ region: args })
      },
      controlExec: async () => { oldCalls++; throw new Error('old screenshot executed') },
      gateFor: () => ({ ok: false, guidance: 'legacy path must not run' }),
      audit: () => {},
    },
  }
  registerPhoneControlTools(context, context.androidPrivilege)
  assert.equal(tools.filter((tool) => tool.name === 'android_screenshot').length, 1)
  const region = tools.find((tool) => tool.name === 'android_read_region')
  assert.ok(region)
  const args = { x1: 2, y1: 3, x2: 7, y2: 8 }
  const result = await region.execute({ screenId: 'real', ...args }, { agent: { session } })
  assert.deepEqual(validateJsonSchemaValue(region.output.schema, result, 'value') ?? [], [])
  assert.equal(result.ok, true)
  assert.equal(result.width, 1080)
  assert.deepEqual(result.region, args)
  assert.deepEqual(nativeCalls, [{ operation: 'readRegion', screenId: 'real', args, source: session }])
  assert.equal(region.output.render(args, result).filter((block) => block.type === 'image').length, 1)
  assert.equal(h.calls.length, 1)
  assert.equal(oldCalls, 0)
  h.options.llm.resolveModelInfo = async () => ({ inputModalities: ['text'] })
  const rejected = await region.execute({ screenId: 'real', ...args }, { agent: { session } })
  assert.deepEqual(validateJsonSchemaValue(region.output.schema, rejected, 'value') ?? [], [])
  assert.equal(rejected.executed, 'no')
  assert.equal(nativeCalls.length, 1)
})
