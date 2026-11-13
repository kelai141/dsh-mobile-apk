// 原生截图回执 -> 既有 attachments.saveImage -> output.render 的单图内容。
//
// 接入：android_screenshot 的原生成功分支把回执交给 deliverNativeImage；
// 成功值直接沿用 screenshot.output.render，失败值按结构化 failure 返回。
// 本模块不写临时文件、不读路径、不做压缩或裁剪、不打印图像字节。

import { createHash } from 'node:crypto'

/** 原生交付的单张图像上限。 */
export const NATIVE_IMAGE_MAX_BYTES = 1024 * 1024

export type NativeExecuted = 'yes' | 'no' | 'unknown'

export interface NativeImageRegion {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface NativeImageFacts {
  imageId: string
  mediaType: string
  bytes: number
  sha256: string
  epoch: string
  screenId: string
  generation: string
  width: number
  height: number
  region: NativeImageRegion
}

/** 原生回执的 image 字段；data 是规范 base64，不接受 data URL 或空白。 */
export interface NativeImagePayload extends NativeImageFacts {
  data: string
}

/** 原生成功回执：字节在 image，耐久元数据在 data.image；旧测试入口也可使用单个 data.image。 */
export interface NativeImageReceipt {
  ok: boolean
  executed?: NativeExecuted | boolean
  screenId?: string | null
  image?: NativeImagePayload
  data?: { image?: NativeImageFacts | NativeImagePayload }
}

export interface NativeImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export interface AttachmentFace {
  imageLimits: {
    mediaTypes: readonly string[]
    maxImageBytes: number
    maxMessageImageBytes?: number
  }
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<NativeImageRef>
}

export interface LlmFace {
  resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ inputModalities?: readonly string[] }>
}

export interface NativeImageRoute {
  provider?: string
  model?: string
  signal?: AbortSignal
}

export interface NativeImageOptions {
  attachments?: AttachmentFace
  llm?: LlmFace
  route?: NativeImageRoute
  name?: string
}

export interface NativeImageSuccess {
  ok: true
  executed: 'yes'
  screenId: string
  denied: false
  imagePath: ''
  width: number
  height: number
  region: NativeImageRegion
  native: NativeImageFacts
  image: NativeImageRef
  preview: { width: number; height: number; bytes: number }
  text: string
}

export interface NativeImageFailure {
  ok: false
  executed: NativeExecuted
  screenId: string | null
  denied: false
  imagePath: ''
  text: string
  error: { code: string; message: string }
}

export type NativeImageDelivery = NativeImageSuccess | NativeImageFailure

export type RenderBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: NativeImageRef }

type ParsedReceipt = {
  executed: NativeExecuted
  screenId: string
  image: NativeImageFacts
  bytes: Uint8Array
}

type ParsedOrError = { ok: true; value: ParsedReceipt } | { ok: false; code: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function normalizeExecuted(value: unknown): NativeExecuted {
  if (value === true || value === 'yes') return 'yes'
  if (value === false || value === 'no') return 'no'
  return 'unknown'
}

function failure(
  executed: NativeExecuted,
  screenId: string | null,
  code: string,
  message: string,
): NativeImageFailure {
  return {
    ok: false,
    executed,
    screenId,
    denied: false,
    imagePath: '',
    text: '原生截图未交付（' + code + '）：' + message + '。',
    error: { code, message },
  }
}

function normalizeScreenId(receipt: NativeImageReceipt): string | null {
  return isNonEmptyString(receipt.screenId) ? receipt.screenId : null
}

function decodeStrictBase64(data: unknown, bytes: number): Uint8Array | null {
  if (typeof data !== 'string' || data.length === 0) return null
  if (data.length !== Math.ceil(bytes / 3) * 4) return null
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) return null
  const decoded = Buffer.from(data, 'base64')
  if (decoded.byteLength !== bytes) return null
  if (decoded.toString('base64') !== data) return null
  return new Uint8Array(decoded)
}

function isJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false
  let at = 2
  let sawFrame = false
  let sawScan = false
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return false
    while (at < bytes.length && bytes[at] === 0xff) at += 1
    if (at >= bytes.length) return false
    const marker = bytes[at]
    at += 1
    if (marker === 0xd9) return sawFrame && sawScan && at === bytes.length
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (at + 2 > bytes.length) return false
    const length = (bytes[at] << 8) | bytes[at + 1]
    if (length < 2 || at + length > bytes.length) return false
    const isFrame = (marker >= 0xc0 && marker <= 0xc3)
      || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb)
      || (marker >= 0xcd && marker <= 0xcf)
    if (isFrame) {
      if (length < 8) return false
      const height = (bytes[at + 3] << 8) | bytes[at + 4]
      const width = (bytes[at + 5] << 8) | bytes[at + 6]
      if (height === 0 || width === 0) return false
      sawFrame = true
    }
    at += length
    if (marker === 0xda) {
      sawScan = true
      while (at < bytes.length) {
        if (bytes[at] !== 0xff) {
          at += 1
          continue
        }
        let next = at + 1
        while (next < bytes.length && bytes[next] === 0xff) next += 1
        if (next >= bytes.length) return false
        const scanMarker = bytes[next]
        if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
          at = next + 1
          continue
        }
        break
      }
    }
  }
  return false
}

function parseReceipt(receipt: NativeImageReceipt): ParsedOrError {
  if (!isRecord(receipt)) return { ok: false, code: 'receipt-invalid', message: '回执不是对象' }
  if (receipt.ok !== true) return { ok: false, code: 'receipt-not-successful', message: '原生操作没有成功' }
  const executed = normalizeExecuted(receipt.executed)
  if (executed !== 'yes') return { ok: false, code: 'receipt-not-executed', message: '原生操作没有明确的已执行事实' }

  const top = isRecord(receipt.image) ? receipt.image : undefined
  const nested = isRecord(receipt.data) && isRecord(receipt.data.image) ? receipt.data.image : undefined
  if (top !== undefined && nested !== undefined) {
    if ('data' in nested) {
      return { ok: false, code: 'image-ambiguous', message: '回执同时携带两份图像，拒绝猜测' }
    }
    const fields = ['imageId', 'mediaType', 'bytes', 'sha256', 'epoch', 'screenId', 'generation', 'width', 'height'] as const
    if (fields.some((field) => top[field] !== nested[field])
      || !isRecord(top.region) || !isRecord(nested.region)
      || (['x1', 'y1', 'x2', 'y2'] as const).some((key) => top.region[key] !== nested.region[key])) {
      return { ok: false, code: 'image-receipt-mismatch', message: '图像与耐久回执的元数据不一致' }
    }
  }
  const image = top ?? nested
  if (image === undefined) return { ok: false, code: 'image-missing', message: '回执没有图像' }

  if (!isNonEmptyString(image.imageId)) return { ok: false, code: 'image-facts', message: 'imageId 缺失' }
  if (image.mediaType !== 'image/jpeg') {
    return { ok: false, code: 'image-media-type', message: '只接受原生 JPEG 单张图像' }
  }
  if (!isPositiveInt(image.bytes) || image.bytes > NATIVE_IMAGE_MAX_BYTES) {
    return { ok: false, code: 'image-bytes', message: '图像字节数缺失、非正整数或超过 1 MiB' }
  }
  if (typeof image.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(image.sha256)) {
    return { ok: false, code: 'image-digest', message: 'sha256 缺失或格式无效' }
  }
  if (!isNonEmptyString(image.epoch) || !isNonEmptyString(image.generation)) {
    return { ok: false, code: 'image-facts', message: 'epoch 或 generation 缺失' }
  }
  if (!isNonEmptyString(image.screenId)) return { ok: false, code: 'image-facts', message: 'image.screenId 缺失' }
  if (!isPositiveInt(image.width) || !isPositiveInt(image.height)) {
    return { ok: false, code: 'image-facts', message: '逻辑 width/height 缺失或不是正整数' }
  }
  if (!isRecord(image.region)) return { ok: false, code: 'image-region', message: 'region 缺失' }
  const x1 = image.region.x1
  const y1 = image.region.y1
  const x2 = image.region.x2
  const y2 = image.region.y2
  if (!Number.isSafeInteger(x1) || !Number.isSafeInteger(y1)
    || !Number.isSafeInteger(x2) || !Number.isSafeInteger(y2)
    || (x1 as number) < 0 || (y1 as number) < 0
    || (x2 as number) <= (x1 as number) || (y2 as number) <= (y1 as number)
    || (x2 as number) > image.width || (y2 as number) > image.height) {
    return { ok: false, code: 'image-region', message: 'region 超出逻辑屏幕范围或不是整数' }
  }

  const data = decodeStrictBase64('data' in image ? image.data : undefined, image.bytes)
  if (data === null) return { ok: false, code: 'image-base64', message: 'data 不是严格规范的 base64 或与 bytes 不符' }
  const digest = createHash('sha256').update(data).digest('hex')
  if (digest !== image.sha256.toLowerCase()) {
    return { ok: false, code: 'image-digest', message: 'sha256 与图像字节不一致' }
  }
  if (!isJpeg(data)) return { ok: false, code: 'image-jpeg', message: 'JPEG 结构不完整或已损坏' }

  const screenId = normalizeScreenId(receipt)
  if (screenId !== null && screenId !== image.screenId) {
    return { ok: false, code: 'image-target-mismatch', message: '回执 screenId 与图像 screenId 不一致' }
  }

  return {
    ok: true,
    value: {
      executed,
      screenId: image.screenId,
      image: {
        imageId: image.imageId,
        mediaType: image.mediaType,
        bytes: image.bytes,
        sha256: image.sha256.toLowerCase(),
        epoch: image.epoch,
        screenId: image.screenId,
        generation: image.generation,
        width: image.width,
        height: image.height,
        region: { x1: x1 as number, y1: y1 as number, x2: x2 as number, y2: y2 as number },
      },
      bytes: data,
    },
  }
}

function validImageRef(value: unknown): value is NativeImageRef {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value.attachmentId) || !isNonEmptyString(value.mediaType)) return false
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) return false
  if (!isPositiveInt(value.width) || !isPositiveInt(value.height)) return false
  return value.name === undefined || typeof value.name === 'string'
}

/**
 * 校验原生回执并保存一张附件。调用方只传回执与既有服务面；不传文件路径。
 * 保存失败只返回结构化 failure，调用次数恒为一次。
 */
export async function deliverNativeImage(
  receipt: NativeImageReceipt,
  options: NativeImageOptions,
): Promise<NativeImageDelivery> {
  return deliverImage(receipt, options)
}

type ReadyImageRoute = { attachments: AttachmentFace; maxBytes: number }

async function authorizeDelivery(options: NativeImageOptions): Promise<ReadyImageRoute | { code: string; message: string }> {
  const attachments = options.attachments
  if (attachments === undefined || !isRecord(attachments.imageLimits)) {
    return { code: 'attachments-unavailable', message: '附件服务不可用' }
  }
  const limits = attachments.imageLimits
  const maxBytes = Math.min(NATIVE_IMAGE_MAX_BYTES, limits.maxImageBytes,
    limits.maxMessageImageBytes ?? NATIVE_IMAGE_MAX_BYTES)
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { code: 'image-limit-unavailable', message: '附件字节上限不可用' }
  }
  if (!Array.isArray(limits.mediaTypes) || !limits.mediaTypes.includes('image/jpeg')) {
    return { code: 'unsupported-media-type', message: '本部署不接受 JPEG 附件' }
  }
  const route = options.route
  if (options.llm === undefined || !isNonEmptyString(route?.provider) || !isNonEmptyString(route?.model)) {
    return { code: 'model-image-capability-unconfirmed', message: '无法确认当前模型是否接受图像输入' }
  }
  try {
    const info = await options.llm.resolveModelInfo(route.provider, route.model, route.signal)
    if (Array.isArray(info.inputModalities) && info.inputModalities.includes('image')) {
      return { attachments, maxBytes }
    }
  } catch {
    // 模型信息读取失败与没有图像能力都在派发前关闭。
  }
  return { code: 'model-image-capability-unconfirmed', message: '当前模型未确认接受图像输入' }
}

/** 工具入口先确认能交付，再执行一次原生截图；拒绝时不读取屏幕。 */
export async function runNativeImage(
  screenId: string,
  options: NativeImageOptions,
  execute: () => Promise<NativeImageReceipt>,
): Promise<NativeImageDelivery> {
  const ready = await authorizeDelivery(options)
  if ('code' in ready) return failure('no', screenId, ready.code, ready.message)
  if (options.route?.signal?.aborted) return failure('no', screenId, 'operation-aborted', '截图调用已取消')
  let receipt: NativeImageReceipt
  try {
    receipt = await execute()
  } catch {
    return failure('unknown', screenId, 'native-image-result-unavailable', '未收到原生截图结果')
  }
  if (receipt.screenId !== screenId) {
    return failure(normalizeExecuted(receipt.executed), screenId, 'image-target-mismatch', '原生回执未绑定请求屏幕')
  }
  return deliverImage(receipt, options, ready)
}

async function deliverImage(
  receipt: NativeImageReceipt,
  options: NativeImageOptions,
  ready?: ReadyImageRoute,
): Promise<NativeImageDelivery> {
  const rawExecuted = isRecord(receipt) ? normalizeExecuted(receipt.executed) : 'unknown'
  const rawScreenId = isRecord(receipt) ? normalizeScreenId(receipt) : null

  let parsed: ParsedOrError
  try {
    parsed = parseReceipt(receipt)
  } catch {
    return failure(rawExecuted, rawScreenId, 'receipt-invalid', '回执无法读取')
  }
  if (!parsed.ok) return failure(rawExecuted, rawScreenId, parsed.code, parsed.message)

  const facts = parsed.value.image
  const delivery = ready ?? await authorizeDelivery(options)
  if ('code' in delivery) return failure('yes', parsed.value.screenId, delivery.code, delivery.message)
  if (facts.bytes > delivery.maxBytes) {
    return failure('yes', parsed.value.screenId, 'image-too-large', '图像超过本次附件可接受的字节上限')
  }

  const name = isNonEmptyString(options.name) ? options.name : undefined
  let saved: NativeImageRef
  try {
    saved = await delivery.attachments.saveImage({
      data: parsed.value.bytes,
      mediaType: facts.mediaType,
      ...(name === undefined ? {} : { name }),
    })
  } catch {
    return failure('yes', parsed.value.screenId, 'attachment-save-failed', '附件保存失败，未重试')
  }
  if (!validImageRef(saved)) {
    return failure('yes', parsed.value.screenId, 'attachment-invalid', '附件服务返回了无效引用')
  }

  const region = facts.region
  return {
    ok: true,
    executed: 'yes',
    screenId: parsed.value.screenId,
    denied: false,
    imagePath: '',
    width: facts.width,
    height: facts.height,
    region,
    native: facts,
    image: saved,
    preview: { width: saved.width, height: saved.height, bytes: saved.bytes },
    text: '原生截图已内联返回（逻辑尺寸 ' + facts.width + 'x' + facts.height
      + '，region ' + region.x1 + ',' + region.y1 + '-' + region.x2 + ',' + region.y2
      + '；附件编码尺寸 ' + saved.width + 'x' + saved.height + ' 仅用于预览，'
      + saved.bytes + ' 字节）。图像在本结果中；坐标换算使用逻辑 width/height 与 region。',
  }
}

/** 与既有 android_screenshot.output.render 同形：文字 + 最多一张图像。 */
export function renderNativeImage(value: NativeImageDelivery): RenderBlock[] {
  const blocks: RenderBlock[] = [{ type: 'text', text: value.text }]
  if (value.ok && value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
  return blocks
}
