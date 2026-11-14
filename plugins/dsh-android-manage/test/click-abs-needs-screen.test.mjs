// #1586：android_ui_click 收下 x/y（绝对像素）却不要求 screenId —— 守卫放行、执行落空。
//
// 缺陷形态：useAbs 只看 x/y 是否有限，于是「漏传 screenId」或「显式传 real」都通过守卫；
// 而真正的像素分支要求 screenId 非 real。结果掉进下面的 nx/ny 分支：
//   · 无障碍通道：payload.nx/ny 是 undefined（JSON 序列化后整键消失 = 无目标点击），
//     成功返回时 nx!.toFixed(3) 直接抛 TypeError；
//   · ADB 通道：Math.round(nx! * size.w) 得 NaN ⇒ 下发 input tap NaN NaN。
// 守卫自己的错误文案早已写着「x/y（绝对像素，需配 screenId）」，检查却没实现它。
//
// 判据：① 不抛异常；② 明确拒绝并给出可执行指引；③ 绝不真的下发带 NaN 的 input tap，
// 也绝不向无障碍通道发一条 nx/ny 双双缺席的 click。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

const text = (r) => String(r.text ?? '')

function makeFace({ backend = 'a11y' } = {}) {
  const calls = { control: [], adbShell: [], adbLine: [] }
  const face = {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend, reason: 'test-' + backend }),
    controlExec: async (op, args) => {
      calls.control.push({ op, args })
      if (op !== 'snapshot') return { ok: true, data: { done: true, x: 540, y: 1200 } }
      return {
        ok: true,
        data: {
          gen: 7, rotation: 0, screen: { w: 1080, h: 2400 },
          nodes: [
            { id: '0', parentId: '', attrs: { bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false', text: '' } },
          ],
        },
      }
    },
    execAdbShell: async (cmd) => { calls.adbShell.push(cmd); return { ok: true, stdout: '' } },
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

const EXEC = { agent: { session: 's1' } }

for (const backend of ['a11y', 'adb']) {
  test('#1586（' + backend + ' 通道）：x/y 缺 screenId 必须明确拒绝并给指引，不得崩溃/下发 NaN', async () => {
    const { face, calls } = makeFace({ backend })
    const { byName } = applyManage(face)
    const click = byName('android_ui_click')

    // 修前：a11y 通道抛 TypeError（nx!.toFixed），adb 通道下发 input tap NaN NaN。
    const r = await click.execute({ x: 300, y: 700 }, EXEC)

    assert.equal(r.ok, false, '缺 screenId 的 x/y 不得被当成执行成功')
    assert.equal(r.denied, false, '这是参数错误，不是权限拒绝')
    assert.match(text(r), /screenId/, '指引必须点名 screenId：' + text(r))
    assert.match(text(r), /nx\/ny|x\/y/, '指引必须指出去路（nx/ny 或带 screenId 的 x/y）：' + text(r))

    // 反向：不得真的下发
    const taps = calls.adbShell.filter((c) => String(c).includes('input tap'))
    for (const tap of taps) assert.doesNotMatch(String(tap), /NaN/, '绝不允许下发 input tap NaN NaN：' + tap)
    assert.equal(taps.length, 0, '被拒绝的调用不得向 ADB 下发任何 tap：' + JSON.stringify(taps))
    const a11yClicks = calls.control.filter((c) => c.op === 'click' || c.op === 'longClick')
    assert.equal(a11yClicks.length, 0, '被拒绝的调用不得向无障碍通道发 click：' + JSON.stringify(a11yClicks))
  })
}

test('#1586 反证：带 screenId 的 x/y 仍要走虚拟屏坐标分支（不能把好路一起堵死）', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  const click = byName('android_ui_click')
  face.controlExec = async (op, args) => {
    calls.control.push({ op, args })
    return { ok: true, data: { ok: true, guidance: 'ok', displayId: 38, screenId: 'virtual-1' } }
  }
  const r = await click.execute({ x: 180, y: 524, screenId: 'virtual-1' }, EXEC)
  assert.equal(r.ok, true, '带 screenId 的绝对像素必须照常执行：' + text(r))
  const vd = calls.control.find((c) => c.op === 'vdInput')
  assert.ok(vd, '必须走壳侧 vdInput')
  assert.deepEqual({ x: vd.args.x, y: vd.args.y, target: vd.args.target }, { x: 180, y: 524, target: 'virtual-1' })
})

test('#1586 反证：nx/ny（归一化）不受影响，仍走正常点击', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  const click = byName('android_ui_click')
  const r = await click.execute({ nx: 0.5, ny: 0.5 }, EXEC)
  assert.equal(r.ok, true, '归一化坐标必须仍可点：' + text(r))
  const call = calls.control.find((c) => c.op === 'click')
  assert.ok(call, '应发出 a11y click')
  assert.deepEqual({ nx: call.args.nx, ny: call.args.ny }, { nx: 0.5, ny: 0.5 })
})
