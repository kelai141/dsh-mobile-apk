// 无障碍后端路由回归（0.13.5 W4）：
// 策略说 a11y → 工具走 controlExec（不发 ADB）；策略说 adb → 工具走 ADB 且不碰队列。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

function makeFace({ backend = 'a11y' } = {}) {
  const calls = { control: [], adbShell: [], adbLine: [] }
  const face = {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => (backend === 'a11y'
      ? { backend: 'a11y', reason: 'test-a11y' }
      : { backend: 'adb', reason: 'test-adb' }),
    controlExec: async (op, args) => {
      calls.control.push({ op, args })
      if (op === 'snapshot') {
        return {
          ok: true,
          data: {
            gen: 7,
            rotation: 0,
            screen: { w: 1080, h: 2400 },
            nodes: [
              { id: '0', parentId: '', attrs: { bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false', scrollable: 'false', editable: 'false', text: '', 'content-desc': '' } },
              { id: '0.0', parentId: '0', attrs: { bounds: '[100,200][500,320]', class: 'android.widget.Button', clickable: 'true', scrollable: 'false', editable: 'false', text: '设置', 'content-desc': '', 'resource-id': 'com.x:id/btn' } },
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
    // 截图内联路径先取附件/模型面（inlineShot）；桩返回 undefined 即走「返回路径」回退分支。
    get: () => undefined,
    androidPrivilege: face,
  })
  const byName = (n) => tools.find((t) => t.name === n)
  return { tools, byName }
}

const exec = { agent: { session: 's1' } }

test('a11y 通道：ui_dump 走 controlExec 并把壳侧节点剪枝成同一节点模型', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  const r = await byName('android_ui_dump').execute({}, exec)
  assert.equal(r.ok, true)
  assert.equal(calls.control.length, 1)
  assert.equal(calls.control[0].op, 'snapshot')
  // a11y 分支仍会经 execAdbLine 探前台真值（dumpsys）——断言收敛到「不得触发 uiautomator dump」
  // （按命令行内容判定，不按条数：条数会随前台探测实现变化，过严会让这条一直假红）。
  assert.ok(!calls.adbLine.some((l) => /uiautomator/.test(l)), 'a11y 通道不应触发 uiautomator dump')
  assert.deepEqual(r.screen, { w: 1080, h: 2400 })
  const button = r.nodes.find((n) => n.text === '设置')
  assert.ok(button, '壳侧节点应进入语义清单')
  assert.equal(button.clickable, true)
})

test('a11y 通道：ui_click 按原始路径回指壳侧节点', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  // 第二次 dump 命中「界面未变」快路径会返回 nodes: []（0.13.8 P0-4，语义正确）——
  // 节点清单取首次 dump 的结果。
  const first = await byName('android_ui_dump').execute({}, exec)
  const node = first.nodes.find((n) => n.text === '设置')
  assert.ok(node, '首次 dump 应给出节点清单')
  const click = byName('android_ui_click')
  const r = await click.execute({ ref: `id:${node.id}` }, exec)
  assert.equal(r.ok, true)
  const call = calls.control.find((c) => c.op === 'click')
  assert.ok(call, '应走无障碍点击')
  assert.equal(call.args.path, '0.0', '必须回指原始路径而不是公开 id')
  assert.equal(call.args.gen, 7)
  assert.equal(calls.adbShell.length, 0, '不应回退 input tap')
})

test('a11y 通道：ui_input 走 setText 并带上 clear 语义', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  const first = await byName('android_ui_dump').execute({}, exec)
  const node = first.nodes.find((n) => n.text === '设置')
  assert.ok(node, '首次 dump 应给出节点清单')
  const r = await byName('android_ui_input').execute({ text: '你好', ref: `id:${node.id}` }, exec)
  assert.equal(r.ok, true)
  assert.equal(r.channel, 'a11y')
  const call = calls.control.find((c) => c.op === 'setText')
  assert.deepEqual({ text: call.args.text, clear: call.args.clear, path: call.args.path }, { text: '你好', clear: false, path: '0.0' })
  assert.equal(calls.adbShell.length, 0, '不应走 ADBKeyboard 广播')
})

test('a11y 通道：ui_scroll 走语义滚动（无坐标 swipe）', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  const r = await byName('android_ui_scroll').execute({ direction: 'down', fraction: 0.5 }, exec)
  assert.equal(r.ok, true)
  const call = calls.control.find((c) => c.op === 'scroll')
  assert.deepEqual({ direction: call.args.direction, fraction: call.args.fraction }, { direction: 'down', fraction: 0.5 })
  assert.equal(calls.adbShell.length, 0)
})

test('ADB 通道：策略判 adb 时走原路径且不碰队列', async () => {
  const { face, calls } = makeFace({ backend: 'adb' })
  const { byName } = applyManage(face)
  const r = await byName('android_ui_dump').execute({}, exec)
  assert.equal(calls.control.length, 0, 'ADB 通道不得调用无障碍队列')
  assert.ok(calls.adbLine.length > 0, '应走 uiautomator 路径')
  assert.equal(r.ok, false, '测试桩没有真实 XML 文件 → 失败关闭（与旧行为一致）')
})

test('a11y 通道：nx/ny 点击不依赖 dump 缓存（屏幕尺寸由壳侧换算）', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  // 不先 dump：缓存为空也应成功（实机踩坑：旧实现因 30s 缓存过期把 nx/ny 点击误拒）
  const r = await byName('android_ui_click').execute({ nx: 0.5, ny: 0.5 }, exec)
  assert.equal(r.ok, true)
  const call = calls.control.find((c) => c.op === 'click')
  assert.deepEqual({ nx: call.args.nx, ny: call.args.ny }, { nx: 0.5, ny: 0.5 })
  assert.equal(call.args.path, undefined)
  assert.equal(calls.adbShell.length, 0)
})

test('a11y 通道：ui_dump 的模型可见文本包含节点清单（含控件类型/rid，复杂界面可辨识）', async () => {
  const { face } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  const tool = byName('android_ui_dump')
  const value = await tool.execute({}, exec)
  const rendered = tool.output.render({}, value).map((b) => b.text).join('\n')
  assert.match(rendered, /n\d+ \S+/, '节点清单必须出现在渲染文本里')
  assert.match(rendered, /Button/, '控件类型必须可见（用户指出的复杂界面辨识要点）')
  assert.match(rendered, /com\.x:id\/btn/, 'resource-id 必须可见')
  assert.match(rendered, /"设置"/, '文本必须可见')
})

test('a11y 通道：screenshot 走无障碍截屏（API 30+，不依赖 ADB screencap）', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  face.controlExec = async (op, args) => {
    calls.control.push({ op, args })
    if (op === 'screenshot') return { ok: true, data: { path: '/data/user/0/com.dsharnessmobile.shell/files/control-shots/shot-1.png', width: 900, height: 1600 } }
    return { ok: true, data: {} }
  }
  const { byName } = applyManage(face)
  const r = await byName('android_screenshot').execute({}, exec)
  assert.equal(r.denied, false)
  assert.match(r.imagePath, /control-shots/)
  assert.equal(r.width, 900)
  assert.equal(calls.adbLine.length, 0, '不应走 adb screencap')
})

test('无障碍通道失败时工具返回明确错误，不静默降级到 ADB', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  face.controlExec = async (op, args) => { calls.control.push({ op, args }); return { ok: false, error: '无障碍服务未开启' } }
  const { byName } = applyManage(face)
  const r = await byName('android_ui_dump').execute({}, exec)
  assert.equal(r.ok, false)
  assert.match(r.text, /无障碍取树失败/)
  assert.equal(calls.adbLine.length, 0, '不得静默回落 ADB（降级由策略决定，不由工具猜测）')
})
