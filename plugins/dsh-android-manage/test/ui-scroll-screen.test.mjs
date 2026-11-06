// issue #1619 反证回归：ui_scroll 的 ADB 通道不得在非 real 屏上假装滑动。
//
// 缺陷形态（静态审查）：ui_scroll 在 SCREEN_ACTIONS 里，门按 virtual-N 放行；a11y 分支带 screenId
// 没问题，但 ADB 分支读的是**真实屏** `wm size` 且 `input swipe` 没有 `-d`。于是
// {direction:"down", screenId:"virtual-1"} 滑动的是真实屏，回执仍写「已滑动（down 60%）」——
// 模型看到「滑了但画面没变」，比直接拒绝更难排查。口径应与 ui_click 对 nx/ny 在虚拟屏上的拒绝一致。
//
// 判据设计（禁源码文本切片）：用真实 execute() 驱动，夹具记录**真正发给设备的 adb 命令行**。
//   - 非 real 屏 + ADB 通道 ⇒ 必须拒绝，且**不得发出任何 input swipe**；
//   - 真实屏 + ADB 通道 ⇒ 必须照旧发出 input swipe（防止「一刀切拒绝」也能过）；
//   - 非 real 屏 + a11y 通道 ⇒ 必须照旧走无障碍（这条本来就对，不能被误伤）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

/** 夹具：backend 决定 controlDecision 走 a11y 还是 adb；记录 adb 命令行与 control op。 */
function makeFace({ backend = 'adb' } = {}) {
  const calls = { control: [], adbShell: [], adbLine: [] }
  const face = {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend, reason: 'test-' + backend }),
    controlExec: async (op, args) => {
      calls.control.push({ op, args })
      if (op === 'snapshot') {
        return {
          ok: true,
          data: {
            gen: 7, rotation: 0, screen: { w: 1080, h: 2400 },
            nodes: [
              { id: '0', parentId: '', attrs: { bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false', scrollable: 'true', editable: 'false', text: '', 'content-desc': '' } },
            ],
          },
        }
      }
      return { ok: true, data: { done: true } }
    },
    execAdbShell: async (command) => { calls.adbShell.push(command); return { ok: true, stdout: '' } },
    execAdbLine: async (line) => { calls.adbLine.push(line); return { ok: true, stdout: 'Physical size: 1080x2400' } },
  }
  return { face, calls }
}

function applyManage(face) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  return { byName: (n) => tools.find((t) => t.name === n) }
}

const exec = { agent: { session: 's1' } }
const swipes = (calls) => calls.adbShell.filter((c) => /input\s+swipe/.test(c))

test('非 real 屏 + ADB 通道：必须拒绝，且不得向真实屏发出 input swipe', async () => {
  for (const screenId of ['virtual-1', 'virtual-7']) {
    const { face, calls } = makeFace({ backend: 'adb' })
    const { byName } = applyManage(face)
    const r = await byName('android_ui_scroll').execute({ direction: 'down', screenId }, exec)
    assert.notEqual(r.ok, true, screenId + ' 上 ADB 滑动不得回 ok:true（旧实现会滑真实屏并回「已滑动」）')
    assert.equal(swipes(calls).length, 0, screenId + ' 不得发出 input swipe（那是真实屏）')
    assert.match(String(r.text ?? ''), /android_vdisplay_input/, '拒绝必须指向真正能做的工具（否则模型无处可去）')
    assert.ok(String(r.text ?? '').includes(screenId), '回执必须点名是哪块屏（实际：' + String(r.text) + '）')
  }
})

test('真实屏 + ADB 通道：照旧发出 input swipe（防止一刀切拒绝也能过）', async () => {
  const { face, calls } = makeFace({ backend: 'adb' })
  const { byName } = applyManage(face)
  const r = await byName('android_ui_scroll').execute({ direction: 'down', screenId: 'real' }, exec)
  assert.equal(r.ok, true, '真实屏必须仍可滑动')
  assert.equal(swipes(calls).length, 1, '真实屏必须恰好发出一条 input swipe')
  // 不给 screenId 也必须保持改造前语义（默认真实屏）。
  const second = makeFace({ backend: 'adb' })
  const applied = applyManage(second.face)
  const r2 = await applied.byName('android_ui_scroll').execute({ direction: 'up' }, exec)
  assert.equal(r2.ok, true, '缺省 screenId 必须仍按真实屏滑动')
  assert.equal(swipes(second.calls).length, 1)
})

test('非 real 屏 + a11y 通道：不得被 ADB 面的拒绝误伤', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  const r = await byName('android_ui_scroll').execute({ direction: 'down', screenId: 'virtual-1' }, exec)
  assert.equal(r.ok, true, 'a11y 通道本来就带 screenId，必须照旧可用')
  assert.equal(swipes(calls).length, 0, 'a11y 通道不得发 adb swipe')
  const scroll = calls.control.find((c) => c.op === 'scroll')
  assert.ok(scroll, 'a11y 通道必须走壳侧 scroll op')
  assert.equal(scroll.args.screenId, 'virtual-1', 'a11y 载荷必须带上 screenId')
})
