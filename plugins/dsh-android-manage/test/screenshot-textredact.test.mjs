// `textRedact` 是死参数（2026-10-28 自查）：schema 与工具描述承诺「获得文本脱敏摘要
// （避免敏感屏幕内容进入上下文）」，实现里读完就丢——传 true 与不传的返回值**逐字相同**
// （同样返回 imagePath + 图像 + 宽高、同样调 screenshot op 且不带脱敏参数）。
// 于是模型以为已脱敏、把完整截图读进上下文。本工具没有 OCR/文本提取能力，做不到脱敏，
// 故 fail-closed：明确拒绝并给替代路径，而不是静默返回图像。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { apply } = await import('../lib/index.js')

const SHOT = '/data/app/shot-secret.png'

/** 桩：无障碍通道返回一张「敏感截图」，并记录实际调了哪些 op。 */
function makeTool() {
  const calls = []
  const face = {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend: 'a11y', reason: 'probe' }),
    controlExec: async (op, args) => {
      calls.push([op, args])
      if (op === 'screenshot') return { ok: true, data: { path: SHOT, width: 1080, height: 2400 } }
      return { ok: true, data: {} }
    },
    execAdbShell: async () => ({ ok: true, stdout: '' }),
    execAdbLine: async () => ({ ok: true, stdout: '' }),
    screenAccess: () => ({ ok: true, screenId: 'real', displayId: 0, scope: 'all' }),
  }
  const tools = []
  apply({
    logger: () => ({ warn() {}, debug() {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  return { shot: tools.find((t) => t.name === 'android_screenshot'), calls }
}

test('textRedact:true 必须拒绝，且不得触碰任何截屏通道', async () => {
  const { shot, calls } = makeTool()
  const r = await shot.execute({ textRedact: true }, { agent: { session: 's' } })
  assert.deepEqual(calls, [], '拒绝路径不得调用 screenshot op（否则截图已经发生，脱敏无从谈起）')
  assert.equal(r.imagePath, '')
  assert.equal(r.image, undefined)
  assert.match(r.text, /尚未实现/)
  assert.match(r.text, /android_ui_dump/)
})

test('缺省参数仍照常截图（回归护栏）', async () => {
  const { shot, calls } = makeTool()
  const r = await shot.execute({}, { agent: { session: 's' } })
  assert.deepEqual(calls.map((c) => c[0]), ['screenshot'])
  assert.equal(r.imagePath, SHOT)
})

test('textRedact:false 等同缺省（只有 true 才拒绝）', async () => {
  const { shot, calls } = makeTool()
  const r = await shot.execute({ textRedact: false }, { agent: { session: 's' } })
  assert.deepEqual(calls.map((c) => c[0]), ['screenshot'])
  assert.equal(r.imagePath, SHOT)
})
