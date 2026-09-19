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


// ── 0.14.0 真机实锤回归：screenId 必须同时进门（范围判定）与投递（壳侧执行）──

test('ui_dump 带 screenId=virtual-1 时，范围门与壳侧载荷都必须看到它', async () => {
  // 缺陷形态（用户两轮阻碍之一·实报）：模型传 screenId 却像没生效。
  // 真因有两处、必须同时修好：
  //   ① guard 收到的是**手搓子集**（历史上是 {}），screenId 在进门之前就被丢了 → 永远按 real 判定；
  //   ② 即便门放行，a11y 载荷里没有 screenId → 壳侧照旧在真实屏执行。
  // 只修一处会得到更糟的中间态：门按 virtual 放行、动作落在真实屏（比直接拒绝更难排查）。
  const { face, calls } = makeFace({ backend: 'a11y' })
  const seen = []
  face.screenAccess = (screenId) => {
    seen.push(screenId)
    return { ok: true, screenId: screenId ?? 'real', displayId: screenId === 'virtual-1' ? 25 : 0, scope: 'all' }
  }
  const { byName } = applyManage(face)
  const r = await byName('android_ui_dump').execute({ screenId: 'virtual-1' }, exec)
  assert.equal(r.ok, true)
  assert.deepEqual(seen, ['virtual-1'], '范围门必须看见模型传入的 screenId（而不是 undefined/real）')
  assert.equal(calls.control[0].op, 'snapshot')
  assert.equal(calls.control[0].args.screenId, 'virtual-1', '壳侧载荷必须带上 screenId（否则动作落在真实屏）')
})

test('不给 screenId 时不得凭空发键（保持真实屏语义与改造前逐字一致）', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  const seen = []
  face.screenAccess = (screenId) => { seen.push(screenId); return { ok: true, screenId: 'real', displayId: 0, scope: 'all' } }
  const { byName } = applyManage(face)
  await byName('android_ui_dump').execute({}, exec)
  assert.deepEqual(seen, [undefined], '缺省必须把 undefined 交给门（由门决定默认屏），不得工具层猜')
  assert.equal('screenId' in calls.control[0].args, false, '缺省不得发 screenId 键')
})


test('虚拟屏必须走**异步**解析面：同步 screenAccess 解析不了 virtual-N，会误判「尚未就绪」', async () => {
  // 缺陷形态（0.14.0 用户测试项目第一项实锤）：壳侧显示 displayId=32/state=active，
  // 但 android_ui_dump { screenId: 'virtual-1' } 回「虚拟屏幕 virtual-1 尚未就绪」。
  // 真因：虚拟屏别名 → 动态 displayId 的解析要问壳侧注册表（vdInfo），**只有异步面能做**；
  // 工具层却调同步 screenAccess()，后者拿不到 resolved id，于是对任何 virtual-N 恒判 not-ready。
  // 这条用「同步面必失败、异步面才成功」的夹具把该形态钉死：若有人改回同步，测试立刻变红。
  const { face } = makeFace({ backend: 'a11y' })
  face.screenAccess = (screenId) => (screenId === 'virtual-1'
    ? { ok: false, reason: 'screen-not-ready', guidance: '虚拟屏幕 virtual-1 尚未就绪', scope: 'all', screenId: 'virtual-1' }
    : { ok: true, screenId: 'real', displayId: 0, scope: 'all' })
  let asyncCalls = 0
  face.screenAccessResolved = async (screenId) => {
    asyncCalls++
    return screenId === 'virtual-1'
      ? { ok: true, screenId: 'virtual-1', displayId: 32, scope: 'all' }
      : { ok: true, screenId: 'real', displayId: 0, scope: 'all' }
  }
  const { byName } = applyManage(face)
  const r = await byName('android_ui_dump').execute({ screenId: 'virtual-1' }, exec)
  assert.ok(asyncCalls > 0, '必须调用异步解析面（否则 virtual-N 永远解析不出 displayId）')
  assert.notEqual(r.denied, true, '异步面已放行时不得判 denied: ' + JSON.stringify(r).slice(0, 200))
})
test('范围门拒绝时必须短路：不得把被拒的 screenId 投递到壳侧', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  face.screenAccess = () => ({ ok: false, reason: 'screen-out-of-scope', guidance: '当前范围不允许', scope: 'real-only', screenId: 'virtual-1' })
  const { byName } = applyManage(face)
  const r = await byName('android_ui_dump').execute({ screenId: 'virtual-1' }, exec)
  assert.equal(r.ok, false)
  assert.equal(r.denied, true)
  assert.equal(calls.control.length, 0, '被拒时不得触碰壳侧（fail-closed）')
})

test('screenId 必须覆盖到同族的每一条屏幕 op（不再有「碰巧抄进去了」的差异）', async () => {
  // 这条防的是**回归成「逐个补字段」**：漏一处就退回「有的工具能路由、有的不能」。
  // 断言对象 = 工具的 parameters 声明（模型可见面）；缺声明的工具直接不可用。
  const { face } = makeFace({ backend: 'a11y' })
  const { byName } = applyManage(face)
  for (const name of ['android_screenshot', 'android_ui_dump', 'android_ui_click', 'android_ui_scroll', 'android_ui_input', 'android_ui_global', 'android_app_launch']) {
    const tool = byName(name)
    assert.ok(tool, name + ' 必须注册')
    // 注册面是 JSON-schema 形状：参数名在 parameters.properties 下（不是顶层）。
    const props = (tool.parameters ?? {}).properties ?? {}
    assert.ok('screenId' in props, name + ' 必须声明 screenId 参数')
  }
})



test('dump 缓存 TTL 必须容得下「模型思考时间」（30s 太短会变成 dump/过期死循环）', async () => {
  // 0.14.0 模拟器实锤：审计时间戳显示 dump→click 间隔 57s（模型要读清单、比较、选目标），
  // 而 TTL 只有 30s → 缓存先过期 → 工具回「没有最近的控件清单」→ 模型重新 dump → 再过期。
  // 实测连续 6 轮卡死。正确性应由壳侧 gen 校验把关，墙钟 TTL 只是内存回收上限。
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const m = /const UI_CACHE_TTL = ([0-9_ *]+)/.exec(src)
  assert.ok(m, 'UI_CACHE_TTL 必须存在')
  const expr = m[1].trim()
  const value = expr.includes('*')
    ? expr.split('*').map((x) => Number(x.trim().replace(/_/g, ''))).reduce((a, b) => a * b, 1)
    : Number(expr.replace(/_/g, ''))
  assert.ok(value >= 5 * 60_000, 'TTL 必须 >= 5 分钟（实测模型思考耗时 57s，30s 会死循环）: ' + value)
})
test('虚拟屏上 nx/ny 必须被明确拒绝（归一化分母歧义会静默点到真屏）', async () => {
  // 0.14.0 模拟器实锤：模型对 virtual-1 传 nx/ny，工具放行 → 壳侧按**真实屏**(900x1600)换算 →
  // 实际注入 (203,1290)，点在真屏上；虚拟屏毫无变化，返回却说「已点击」。模型反复重试直到放弃。
  // 宁可明确拒绝，也不要静默点到另一块屏——后者难排查得多。
  const { face, calls } = makeFace({ backend: 'a11y' })
  face.screenAccessResolved = async (screenId) => ({ ok: true, screenId: screenId ?? 'real', displayId: 38, scope: 'all' })
  const { byName } = applyManage(face)
  const r = await byName('android_ui_click').execute({ nx: 0.225, ny: 0.806, screenId: 'virtual-1' }, exec)
  assert.equal(r.ok, false, '必须拒绝而不是放行: ' + JSON.stringify(r).slice(0, 200))
  assert.match(String(r.text), /x\/y/, '必须把模型指向无歧义的 x/y')
  assert.equal(calls.control.length, 0, '拒绝时不得触碰壳侧')
})

test('虚拟屏上绝对 x/y 走 vdInput（坐标基于该屏自身像素）', async () => {
  const { face } = makeFace({ backend: 'a11y' })
  face.screenAccessResolved = async (screenId) => ({ ok: true, screenId: screenId ?? 'real', displayId: 38, scope: 'all' })
  const seen = []
  face.controlExec = async (op, args) => { seen.push({ op, args }); return { ok: true, data: { ok: true, guidance: 'ok', displayId: 38, screenId: 'virtual-1' } } }
  const { byName } = applyManage(face)
  const r = await byName('android_ui_click').execute({ x: 180, y: 524, screenId: 'virtual-1' }, exec)
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200))
  assert.equal(seen[0].op, 'vdInput')
  assert.equal(seen[0].args.verb, 'tap')
  assert.equal(seen[0].args.x, 180)
  assert.equal(seen[0].args.y, 524)
  assert.equal(seen[0].args.target, 'virtual-1')
})
test('android_app_launch 指定虚拟屏时走 vdLaunchApp（monkey -p 没有屏幕维度）', async () => {
  // 缺口：`monkey -p <pkg>` 永远落在真实屏，于是「在虚拟屏里开应用」在工具面无法表达。
  const { face, calls } = makeFace({ backend: 'adb' })
  face.screenAccess = () => ({ ok: true, screenId: 'virtual-1', displayId: 25, scope: 'all' })
  const control = []
  face.controlExec = async (op, args) => { control.push({ op, args }); return { ok: true, data: { ok: true, guidance: '已在 virtual-1 拉起' } } }
  const { byName } = applyManage(face)
  const r = await byName('android_app_launch').execute({ pkg: 'com.example.app', screenId: 'virtual-1' }, exec)
  assert.equal(r.ok, true)
  assert.equal(control.length, 1, '必须经控制队列投递 vdLaunchApp')
  assert.equal(control[0].op, 'vdLaunchApp')
  assert.equal(control[0].args.pkg, 'com.example.app')
  assert.equal(control[0].args.target, 'virtual-1')
  assert.ok(!calls.adbShell.some((c) => /monkey/.test(c)), '虚拟屏路径不得用 monkey（无屏幕维度）')
})

test('android_screenshot 的 ADB 回落对虚拟屏必须传 SF token（不是 displayId）', async () => {
  // 0.14.0 设备实录：无障碍离线时截图走 ADB 回落，而该路径**完全忽略 screenId**——
  // 无参 screencap 只抓 display 0，模型对虚拟屏截图却拿到真实屏画面，据此误判「设置没开在虚拟屏上」。
  //
  // 0.14.1 块G F6（设备实测真因，见 vd-shot.ts 文件头）：0.14.0 的修法把 **displayId** 落到
  // `screencap -d` 上，但 `screencap -d` 吃的是 **SurfaceFlinger token**——设备上
  // `screencap -d <displayId>` 对虚拟屏恒 `Status: -2`（无文件），只有传 SF token 才出图。
  // 故本用例锁死：虚拟屏目标的 ADB 回落必须传 **SF token**，displayId 不得出现在 -d 上。
  const { face, calls } = makeFace({ backend: 'adb' })
  face.screenAccess = () => ({ ok: true, screenId: 'virtual-1', displayId: 25, scope: 'all' })
  face.screenAccessResolved = async () => ({ ok: true, screenId: 'virtual-1', displayId: 25, scope: 'all' })
  face.controlExec = async (op) => {
    if (op === 'vdInfo') return { ok: true, data: { screens: [{ alias: 'virtual-1', kind: 'virtual', displayId: 25, width: 360, height: 640 }] } }
    return { ok: true, data: { done: true } }
  }
  face.execAdbShell = async (cmd) => {
    calls.adbShell.push(cmd)
    // 真实设备形态夹具（MuMu x86_64 模拟器 / Android 15）：虚拟屏 token 与 name 成对。
    return { ok: true, stdout: 'Virtual Display 11529215046816944610\n    name="DSH virtual-1"\n' }
  }
  // 让截图像「已落地」：桩的 adbLine 回执需含文件名，否则工具走「未落地」分支提前返回。
  face.execAdbLine = async (line) => {
    calls.adbLine.push(line)
    return { ok: true, stdout: '/tmp/dsh-shot-1.png\n-rw-rw-rw- 1 shell shell 1234 dsh-shot-1.png' }
  }
  const { byName } = applyManage(face)
  const r = await byName('android_screenshot').execute({ screenId: 'virtual-1', textRedact: true }, exec)
  const line = calls.adbLine.find((l) => /screencap/.test(l))
  assert.ok(line, 'ADB 回落路径必须真的发起 screencap')
  assert.match(line, /screencap -p -d 11529215046816944610/, '必须把 SF token 落到 screencap 上')
  assert.ok(!/ -d 25 /.test(line), 'displayId 不得出现在 -d 上（对虚拟屏恒 Status -2）')
  assert.match(String(r.text ?? ''), /360x640/, '分辨率锚点必须是目标虚拟屏自己的像素')
  assert.match(String(r.text ?? ''), /SurfaceFlinger token/, '说明必须点名 token，避免模型按 displayId 排查')
})

test('android_screenshot 虚拟屏反查不到 SF token 时必须 fail-closed（不回落真实屏）', async () => {
  // 反证：反查命令不可达 / 别名未注册 → 必须**拒绝**，且**不得**回落 displayId 硬试、
  // **不得**回落无参 screencap（那会抓真实屏，正是 0.13.8 修过的「拿真实屏当虚拟屏」旧缺陷）。
  const { face, calls } = makeFace({ backend: 'adb' })
  face.screenAccess = () => ({ ok: true, screenId: 'virtual-1', displayId: 25, scope: 'all' })
  face.screenAccessResolved = async () => ({ ok: true, screenId: 'virtual-1', displayId: 25, scope: 'all' })
  // 反查失败：没有任何 DSH 虚拟屏行。
  face.execAdbShell = async (cmd) => { calls.adbShell.push(cmd); return { ok: true, stdout: '    name="mumuscreen000"\n' } }
  face.execAdbLine = async (line) => { calls.adbLine.push(line); return { ok: true, stdout: '' } }
  const { byName } = applyManage(face)
  const r = await byName('android_screenshot').execute({ screenId: 'virtual-1', textRedact: true }, exec)
  assert.ok(!calls.adbLine.some((l) => /screencap/.test(l)), '反查失败时不得发起任何 screencap')
  assert.match(String(r.text ?? ''), /SurfaceFlinger display token 解析不到/, '必须如实说明反查失败')
  assert.match(String(r.text ?? ''), /不会/, '必须显式声明不回落 displayId 或真实屏')
})

test('android_screenshot 不带 screenId 时抓默认屏（语义不变）', async () => {
  const { face, calls } = makeFace({ backend: 'adb' })
  const { byName } = applyManage(face)
  await byName('android_screenshot').execute({ textRedact: true }, exec)
  const line = calls.adbLine.find((l) => /screencap/.test(l))
  assert.ok(line, '应发起 screencap')
  assert.ok(!/-d \d+/.test(line), '未指定屏时不得注入 -d（保持真实屏默认语义）')
})

test('android_app_launch 漏传 screenId 时，兜底提示告知活跃虚拟屏与用法', async () => {
  // 0.14.0 设备实录：模型看到 screenId 是个无说明的字符串，直接忽略，于是把想要开到虚拟屏的 App
  // 拉到了真实屏，整轮在错误前提下排查。修法之一是**当场把另一种选择告诉它**，而不是等它事后读文档。
  const { face, calls } = makeFace({ backend: 'adb' })
  const control = []
  face.controlExec = async (op, args) => {
    control.push({ op, args })
    if (op === 'vdInfo') {
      return { ok: true, data: { screens: [{ alias: 'virtual-1', kind: 'virtual', displayId: 25 }] } }
    }
    return { ok: true, data: { done: true } }
  }
  const { byName } = applyManage(face)
  const r = await byName('android_app_launch').execute({ pkg: 'com.example.app', waitMs: 500 }, exec)
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200))
  assert.ok(calls.adbShell.some((c) => /monkey/.test(c)), '未传 screenId 时仍走 monkey（真实屏语义不变）')
  assert.match(String(r.text), /virtual-1/, '必须点出活跃虚拟屏别名')
  assert.match(String(r.text), /screenId/, '必须告诉模型怎么用该别名')
})

test('android_app_launch 无活跃虚拟屏时不追加兜底提示', async () => {
  const { face } = makeFace({ backend: 'adb' })
  face.controlExec = async (op) => {
    if (op === 'vdInfo') return { ok: true, data: { screens: [{ alias: 'real', kind: 'physical', displayId: 0 }] } }
    return { ok: true, data: { done: true } }
  }
  const { byName } = applyManage(face)
  const r = await byName('android_app_launch').execute({ pkg: 'com.example.app', waitMs: 500 }, exec)
  assert.equal(r.ok, true)
  assert.doesNotMatch(String(r.text), /活跃虚拟屏/, '没有虚拟屏就不该提这件事')
})

test('android_app_launch 的 screenId 参数必须带 description（模型可发现性）', () => {
  // 回归：此前 SCREEN_PARAM 刻意不写 description（wire 预算理由），结果模型完全忽略该参数。
  const { byName } = applyManage(makeFace({ backend: 'adb' }).face)
  const tool = byName('android_app_launch')
  const desc = tool.parameters?.properties?.screenId?.description
  assert.equal(typeof desc, 'string', 'screenId 必须有 description')
  assert.ok(desc.length > 0, 'screenId description 不得为空')
  assert.match(desc, /virtual-N/, 'description 必须点出虚拟屏别名取值')
  assert.match(String(tool.description), /screenId/, '工具描述必须说明跨屏用法')

  // 同一常量内联进多个工具：每个挂 screenId 的工具都要能看到取值，不能只修一处。
  for (const name of ['android_ui_dump', 'android_ui_click', 'android_screenshot']) {
    const t2 = byName(name)
    const d2 = t2?.parameters?.properties?.screenId?.description
    assert.equal(typeof d2, 'string', name + ' 的 screenId 也必须有 description')
  }
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


test('screen scope is enforced before either a11y or ADB can read the real screen', async () => {
  const { face, calls } = makeFace({ backend: 'adb' })
  face.screenScope = () => 'virtual-only'
  face.screenAccess = () => ({
    ok: false,
    reason: 'screen-out-of-scope',
    scope: 'virtual-only',
    screenId: 'real',
    guidance: 'real screen is outside the user scope',
  })
  const { byName } = applyManage(face)
  const blocked = await byName('android_screenshot').execute({}, exec)
  assert.equal(blocked.denied, true)
  assert.match(blocked.text, /outside the user scope/)
  assert.equal(calls.control.length, 0)
  assert.equal(calls.adbLine.length, 0)
  const listed = await byName('android_screen_list').execute({}, exec)
  assert.equal(listed.scope, 'virtual-only')
  assert.equal(listed.screens[0].inScope, false)
  assert.equal(listed.screens[1].screenId, 'virtual-1')
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

// ── 块G F3 / F4b（0.14.1）：screenId 残余丢参点 + web_dump 过度拦截 ────────────────────

test('F3：ui_click 的 a11y 首分支（ref 路径）必须把 screenId 投递到壳侧', async () => {
  // 丢参点的后果与「门放行但动作落真实屏」同源：门按 virtual-1 放行，执行却在真实屏上——
  // 比直接拒绝更难排查（0.14.0 已有同型实锤，见文件上方 screenId 双修用例）。
  const { face, calls } = makeFace({ backend: 'a11y' })
  face.screenAccess = () => ({ ok: true, screenId: 'virtual-1', displayId: 38, scope: 'virtual-only' })
  face.screenAccessResolved = async () => ({ ok: true, screenId: 'virtual-1', displayId: 38, scope: 'virtual-only' })
  const { byName } = applyManage(face)
  // 先 dump 拿 ref（同一屏），再按 ref 点击。
  const first = await byName('android_ui_dump').execute({ screenId: 'virtual-1' }, exec)
  const node = first.nodes.find((n) => n.text === '设置')
  assert.ok(node, '首次 dump 应给出节点清单')
  calls.control.length = 0
  const r = await byName('android_ui_click').execute({ ref: `id:${node.id}`, screenId: 'virtual-1' }, exec)
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200))
  const call = calls.control.find((c) => c.op === 'click')
  assert.ok(call, '应走无障碍点击')
  assert.equal(call.args.screenId, 'virtual-1', 'a11y 点击载荷必须带上目标屏（否则点在真实屏上）')
})

test('F3：nodeText 回读必须带上目标屏（校验的是同一块屏的聚焦框）', async () => {
  // 回读不带 screenId → 壳侧按真实屏读聚焦框，输入校验在同一块屏之外比较，会假报「未落地」。
  const { face, calls } = makeFace({ backend: 'adb' })
  face.execAdbShell = async (command) => { calls.adbShell.push(command); return { ok: true, stdout: '' } }
  const { byName } = applyManage(face)
  await byName('android_ui_input').execute({ text: 'hello', screenId: 'virtual-1' }, exec)
  const nt = calls.control.find((c) => c.op === 'nodeText')
  assert.ok(nt, 'ADBKeyboard 通道注入后必须回读断言')
  assert.equal(nt.args.screenId, 'virtual-1', 'nodeText 回读必须指向同一块屏')
})

test('F4b：virtual-only 下 android_web_dump 不得被屏幕范围门拒绝（它读的是壳自有 WebView）', async () => {
  // 过度拦截形态（块G §2.5）：web_dump ∈ SCREEN_ACTIONS，但该工具**没有 screenId 参数**，
  // guard 的 requested 恒为 undefined → decideScreenAccess 落到 real → virtual-only 下必然拒绝。
  // 被拦的能力根本不读设备屏：壳侧 handleWebSnapshot 走 MainActivity.webViewRef（DSH 自己的 Web UI）。
  // 这与 review C11 已记录的 device_info 判例同型（只读元数据/自有页面，不含设备屏内容）。
  const { face, calls } = makeFace({ backend: 'a11y' })
  let guardCalls = 0
  face.screenAccess = () => {
    guardCalls++
    return { ok: false, reason: 'screen-out-of-scope', scope: 'virtual-only', screenId: 'real', guidance: 'virtual-only 下不允许 real' }
  }
  face.screenAccessResolved = async () => face.screenAccess()
  face.controlExec = async (op, args) => {
    calls.control.push({ op, args })
    if (op === 'webSnapshot') return { ok: true, data: { ok: true, url: 'http://127.0.0.1:3080/', title: 'DSH', nodes: [] } }
    return { ok: true, data: {} }
  }
  const { byName } = applyManage(face)
  const r = await byName('android_web_dump').execute({}, exec)
  assert.equal(r.denied, false, 'web_dump 不读设备屏，不得被屏幕范围门拒：' + JSON.stringify(r).slice(0, 200))
  assert.equal(guardCalls, 0, 'web_dump 不该走屏幕目标判定（比照 device_info 判例移出 SCREEN_ACTIONS）')
  assert.ok(calls.control.some((c) => c.op === 'webSnapshot'), 'web_dump 必须真的取到 DOM 快照')
})

test('F4b：android_web_dump 仍然受会话档位门约束（移出范围判定不等于免门禁）', async () => {
  const { face, calls } = makeFace({ backend: 'a11y' })
  face.gateFor = () => ({ ok: false, guidance: '会话档位不是 danger-full-access' })
  const { byName } = applyManage(face)
  const r = await byName('android_web_dump').execute({}, exec)
  assert.equal(r.ok, false)
  assert.equal(r.denied, true)
  assert.match(String(r.text), /danger-full-access/)
  assert.equal(calls.control.length, 0, '被档位门拒时不得触碰壳侧')
})
