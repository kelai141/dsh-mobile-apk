// 截图工具不得**编造**设备物理分辨率（2026-10-28 自查，与 #745「未知值不得编造成 0」同族）。
//
// 修前：壳侧不回 width/height 时走 `data.width ?? 0`，于是同一个返回体里两套口径 ——
// 文案如实写「设备物理分辨率 ?x?」，而 `width`/`height` 谎报 `0`；而 schema 里这两个字段的
// 描述原文就是「截图像素坐标换算锚点」，模型拿 0 去做换算只会算出错的值，且无法区分
// 「真的 0」与「壳侧没回显」。
//
// 修后：只有**成对**拿到有限数值才带这两个键，文案与返回体永远同口径（都是 `?x?` 或都是真实值）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

function faceFor(screenshotData) {
  return {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend: 'a11y', reason: 'test-a11y' }),
    controlExec: async (op) => (op === 'screenshot' ? { ok: true, data: screenshotData } : { ok: true, data: {} }),
    execAdbShell: async () => ({ ok: true, stdout: '' }),
    execAdbLine: async () => ({ ok: true, stdout: '' }),
    screenAccess: () => ({ ok: true, screenId: 'real', displayId: 0, scope: 'all' }),
  }
}

async function shoot(data) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    // 取不到附件/模型面 ⇒ 走「返回路径」回退分支，返回体里能直接看到 width/height。
    get: () => undefined,
    androidPrivilege: faceFor(data),
  })
  const tool = tools.find((t) => t.name === 'android_screenshot')
  assert.ok(tool, 'android_screenshot 必须注册')
  return tool.execute({}, { agent: { session: 's1' } })
}

test('壳侧不回尺寸时不得编造 0：返回体里根本没有 width/height 键', async () => {
  const r = await shoot({ path: '/tmp/scan/shot.png' })
  assert.equal('width' in r, false, '不得回 width（0 会被当成合法的坐标换算锚点）')
  assert.equal('height' in r, false, '不得回 height')
  assert.match(String(r.text), /设备物理分辨率 \?x\?/, '文案必须如实说未知')
})

test('壳侧回尺寸时原样带上，且文案与返回体同口径', async () => {
  const r = await shoot({ path: '/tmp/scan/shot.png', width: 1080, height: 2400 })
  assert.equal(r.width, 1080)
  assert.equal(r.height, 2400)
  assert.match(String(r.text), /设备物理分辨率 1080x2400/)
})

test('只回一半时整对省略（文案不得一边说 1080 一边没有 width）', async () => {
  const r = await shoot({ path: '/tmp/scan/shot.png', width: 1080 })
  assert.equal('width' in r, false)
  assert.equal('height' in r, false)
  assert.match(String(r.text), /设备物理分辨率 \?x\?/, '只回一半也按未知处理，文案必须同步')
})

test('非有限数（NaN/Infinity）也不算拿到尺寸', async () => {
  const r = await shoot({ path: '/tmp/scan/shot.png', width: Number.NaN, height: Number.POSITIVE_INFINITY })
  assert.equal('width' in r, false, 'NaN/Infinity 不是合法 JSON 数值，不得上行')
  assert.equal('height' in r, false)
})
