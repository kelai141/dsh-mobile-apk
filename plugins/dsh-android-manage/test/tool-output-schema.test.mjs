// 0.14 工具输出契约回归（B0：FX-204.1/.2 + FX-204.3 + §5.3 D1-D11 + FX-206.1/.2/.3/.4 + FX-212.5）
//
// 校验器复用**引擎同款**：dsh/packages/core/tools/src/index.ts:1785 的 validateJsonSchemaValue
// （引擎在 snapshotToolValue 之后、render 之前调用；本测试经 @deepseek-ai/dsh-tools 导入同一个函数，
// 不另造校验器）。返回值还额外断言「递归不得有 undefined 成员」——含 undefined 的对象不是
// lossless JSON，引擎在 snapshotJsonValue 就会整条拒绝（与 schema 违规是两种不同的红）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)
const EXEC = { agent: { session: 's1' } }

/** 递归收集 undefined 成员路径（lossless-JSON 前置检查）。 */
function undefinedPaths(v, path = 'value', out = []) {
  if (v === undefined) { out.push(path); return out }
  if (Array.isArray(v)) { v.forEach((x, i) => undefinedPaths(x, `${path}[${i}]`, out)); return out }
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) undefinedPaths(x, `${path}.${k}`, out)
  }
  return out
}

/** 某工具返回值对「引擎同款校验器 + lossless JSON」的违规条数。 */
function violations(tool, value) {
  return [
    ...undefinedPaths(value).map((p) => `${p} is undefined (not lossless JSON)`),
    ...validateJsonSchemaValue(tool.output.schema, value, 'value'),
  ]
}

/** 去掉一条声明后的 schema（反向自证用：撤掉声明必须让同一返回值变红）。 */
function schemaWithout(tool, key) {
  const properties = { ...tool.output.schema.properties }
  delete properties[key]
  return { ...tool.output.schema, properties }
}

function applyManage(face) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  return { tools, byName: (n) => tools.find((t) => t.name === n) }
}

/**
 * 壳侧 V2 列式载荷桩：3 行、原始表 6 行。
 * `o: [0, 3, 5]` = 载荷行下标 → 原始行号——载荷第 2 行（id:n2，文本「设置」）对应**原始行 5**，
 * 用来钉死「句柄取映射而不是载荷下标」（FX-206.1）。
 */
function v2Payload({ gen = 7, truncated = false } = {}) {
  const p = {
    v: 2, gen, rot: 0, scr: [1080, 2400], raw: 6, view: 'all', n: 3,
    str: ['FrameLayout', 'com.android.settings', 'LinearLayout', 'Button', '设置'],
    d: [0, 1, 1],
    p: [-1, -1, -1],
    b: [0, 0, 1080, 2400, 100, 200, 300, 120, 120, 340, 260, 100],
    o: [0, 3, 5],
    f: [0, 1, 1],
    c: [0, 2, 3],
    k: [1, 1, 1],
    r: [-1, -1, -1],
    w: [-1, -1, -1],
    t: [-1, -1, 4],
    s: [-1, -1, -1],
  }
  if (truncated) p.truncated = true
  return p
}

/** 老壳 V1 载荷桩：没有 v=2、没有 gen，screen 还多带一个未声明键（D11 的构造法）。 */
function v1Snapshot({ screen = { w: 1080, h: 2400, density: 3 } } = {}) {
  const attrs = (extra) => ({
    bounds: '[0,0][1080,2400]', class: 'android.widget.FrameLayout', clickable: 'false',
    scrollable: 'false', editable: 'false', text: '', 'content-desc': '', ...extra,
  })
  return {
    rotation: 0,
    screen,
    nodes: [
      { id: '0', parentId: '', attrs: attrs({}) },
      { id: '0.0', parentId: '0', attrs: attrs({ bounds: '[100,200][500,320]', class: 'android.widget.Button', clickable: 'true', text: '设置', 'resource-id': 'com.x:id/btn' }) },
    ],
  }
}

function makeFace(opts = {}) {
  const calls = { control: [], adbShell: [], adbLine: [] }
  const face = {
    gateFor: opts.gateFor ?? (() => ({ ok: true })),
    audit: () => {},
    controlExec: async (op, args) => {
      calls.control.push({ op, args })
      if (op === 'snapshot') {
        const nth = calls.control.filter((c) => c.op === 'snapshot').length
        return { ok: true, data: opts.snapshotAt ? opts.snapshotAt(nth) : opts.snapshot }
      }
      if (op === 'state') return { ok: true, data: { gen: opts.stateGen ?? 7, invalidated: false } }
      if (op === 'click') return { ok: true, data: { x: 150, y: 260, via: 'performAction' } }
      if (op === 'webSnapshot') return { ok: true, data: opts.webSnapshot ?? { nodes: [] } }
      return { ok: true, data: {} }
    },
    execAdbShell: async (c) => { calls.adbShell.push(c); return { ok: true, stdout: opts.adbShellOut ?? '' } },
    execAdbLine: async (c) => { calls.adbLine.push(c); return { ok: true, stdout: 'Physical size: 1080x2400' } },
  }
  if (opts.controlDecision !== 'absent') {
    face.controlDecision = opts.controlDecision ?? (() => ({ backend: 'a11y', reason: 'test-a11y' }))
  }
  return { face, calls }
}

test('FX-204.1/.2（B0）：30s 内连续两次 dump，两条返回路径都过引擎同款校验器（违规条数 = 0）', async () => {
  const { face } = makeFace({ snapshotAt: (nth) => v2Payload({ gen: nth === 1 ? 7 : 9 }) })
  const { byName } = applyManage(face)
  const tool = byName('android_ui_dump')

  const first = await tool.execute({}, EXEC)   // 完整抓取路径：detailHandle/detailPath
  const second = await tool.execute({}, EXEC)  // 界面未变快路径：unchanged/gen
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.unchanged, true)
  assert.deepEqual(second.nodes, [])
  assert.equal(violations(tool, first).length, 0, '完整抓取返回值不得有任何违规：' + violations(tool, first).join('; '))
  assert.equal(violations(tool, second).length, 0, '未变快路径返回值不得有任何违规：' + violations(tool, second).join('; '))
  assert.equal(typeof first.detailHandle, 'string')

  // 反向自证（内嵌，无需改源码）：两条路径的键名不同（detailHandle vs unchanged），
  // 撤掉任一声明同一返回值立刻违规——这就是 FX-204.1 与 FX-204.2 必须同批的原因。
  const noHandle = validateJsonSchemaValue(schemaWithout(tool, 'detailHandle'), first, 'value')
  assert.ok(noHandle.length > 0 && noHandle[0].includes('detailHandle'), '撤掉 detailHandle 声明必须违规：' + JSON.stringify(noHandle))
  const noUnchanged = validateJsonSchemaValue(schemaWithout(tool, 'unchanged'), second, 'value')
  assert.ok(noUnchanged.length > 0 && noUnchanged[0].includes('unchanged'), '撤掉 unchanged 声明必须违规：' + JSON.stringify(noUnchanged))
})

test('D3：壳侧不报代次时 gen 整键不发（不是 gen: undefined，也不是 null）', async () => {
  const { face } = makeFace({ snapshot: v1Snapshot() })
  const { byName } = applyManage(face)
  const tool = byName('android_ui_dump')
  const first = await tool.execute({}, EXEC)
  const second = await tool.execute({}, EXEC)
  assert.equal(first.ok, true)
  assert.equal(second.unchanged, true, 'V1 分支同样有「界面未变」快路径')
  assert.equal(Object.hasOwn(second, 'gen'), false, 'gen 必须是整键缺席')
  assert.equal(violations(tool, first).length, 0)
  assert.equal(violations(tool, second).length, 0)
})

test('FX-206.1 + FX-206.2：无障碍点击的 row 句柄 = o 列映射回的原始行号（不是载荷下标）', async () => {
  const { face, calls } = makeFace({ snapshot: v2Payload() })
  const { byName } = applyManage(face)
  const dump = await byName('android_ui_dump').execute({}, EXEC)
  const node = dump.nodes.find((n) => n.text === '设置')
  assert.ok(node, 'V2 载荷的节点应进入清单')
  assert.equal(node.id, 'n2')
  assert.equal(node.origPath, '5', 'V2 缓存槽位承载行句柄 = 原始行号 5（载荷行下标是 2）')

  const r = await byName('android_ui_click').execute({ ref: 'id:n2' }, EXEC)
  assert.equal(r.ok, true)
  const call = calls.control.find((c) => c.op === 'click')
  assert.ok(call, '应走无障碍点击')
  assert.equal(call.args.row, 5, 'row 必须指回原始行号（错位修复的核心断言）')
  assert.equal(call.args.path, undefined, 'V2 不得再发 path（FX-206.2）')
  assert.equal(violations(byName('android_ui_click'), r).length, 0)
})

test('FX-206.3：未变快路径推进 gen/ts——其后动作带新代次，不被 requireFresh 拒', async () => {
  const { face, calls } = makeFace({ snapshotAt: (nth) => v2Payload({ gen: nth === 1 ? 7 : 9 }) })
  const { byName } = applyManage(face)
  await byName('android_ui_dump').execute({}, EXEC)
  const second = await byName('android_ui_dump').execute({}, EXEC)
  assert.equal(second.unchanged, true)
  assert.equal(second.gen, 9, '未变摘要必须报出本次载荷的代次')
  await byName('android_ui_click').execute({ nx: 0.5, ny: 0.5 }, EXEC)
  const call = calls.control.find((c) => c.op === 'click')
  assert.equal(call.args.gen, 9, '动作必须带第二次 dump 的代次（旧实现恒带 7 → 壳侧 requireFresh 拒）')
})

test('FX-206.4：截断状态按载荷真值渲染（不再写死「未截断」）', async () => {
  const on = await (async () => {
    const { face } = makeFace({ snapshot: v2Payload({ truncated: true }) })
    return applyManage(face).byName('android_ui_dump').execute({}, EXEC)
  })()
  assert.match(on.text, /已截断/, 'truncated=true 必须显式告知模型清单不完整')
  const off = await (async () => {
    const { face } = makeFace({ snapshot: v2Payload() })
    return applyManage(face).byName('android_ui_dump').execute({}, EXEC)
  })()
  assert.match(off.text, /未截断/)
  const v1 = await (async () => {
    const { face } = makeFace({ snapshot: v1Snapshot() })
    return applyManage(face).byName('android_ui_dump').execute({}, EXEC)
  })()
  assert.match(v1.text, /截断状态未知/, 'V1 载荷不带该字段——如实标未知，不得声称未截断')
})

test('FX-212.5：V2 下 parentId 由预序+深度重建——render 的 ^nX 与 ui_detail 的 parentLabel 不再恒空', async () => {
  const { face } = makeFace({ snapshot: v2Payload() })
  const { byName } = applyManage(face)
  const tool = byName('android_ui_dump')
  const v = await tool.execute({}, EXEC)
  const child = v.nodes.find((n) => n.id === 'n2')
  assert.equal(child.parentId, 'n0', 'V2 行必须带真实父 id（载荷 p 列口径不变）')
  const rendered = tool.output.render({}, v).map((b) => b.text).join('\n')
  assert.match(rendered, /\^n0/, '渲染面必须出现 ^n0 父引用')

  const r = await byName('android_ui_detail').execute({ ref: 'id:n2' }, EXEC)
  assert.equal(r.ok, true)
  assert.match(String(r.node.parentLabel ?? ''), /FrameLayout/, 'ui_detail 的 parentLabel 必须能反查到父节点')
  assert.equal(violations(byName('android_ui_detail'), r).length, 0)
})

test('D4：android_ui_detail 已注册（源码级 defineTool 集合 − 注册集合 = 空集，注册数 = 13）', async () => {
  const { face } = makeFace({ snapshot: v2Payload() })
  const { tools } = applyManage(face)
  const src = readFileSync(join(HERE, '..', 'src', 'index.ts'), 'utf8')
  const defined = new Set([...src.matchAll(/defineTool\(\{\s*name: '([^']+)'/g)].map((m) => m[1]))
  const registered = new Set(tools.map((t) => t.name))
  const missing = [...defined].filter((n) => !registered.has(n))
  assert.deepEqual(missing, [], 'defineTool 过但没进注册数组 = 死代码（提示文案还在引导模型调用）')
  assert.equal(registered.size, 13, '注册数必须为 13')
  assert.equal(defined.size, 13)
})

test('D5：策略答「ADB 不可用」→ 四个 ADB 专属工具动手前拒绝，且不碰设备', async () => {
  const { face, calls } = makeFace({
    controlDecision: (op, session, forceBackend) => (forceBackend === 'adb'
      ? { backend: 'deny', reason: '测试桩：ADB 未配对' }
      : { backend: 'a11y', reason: 'test-a11y' }),
  })
  const { byName } = applyManage(face)
  const cases = [
    ['android_ui_tree', {}],
    ['android_app_launch', { pkg: 'com.example' }],
    ['android_env_prepare', {}],
    ['android_act_input', { action: 'keyevent', keycode: 4 }],
  ]
  const texts = {}
  for (const [name, args] of cases) {
    const r = await byName(name).execute(args, EXEC)
    texts[name] = String(r.text ?? '')
    assert.equal(r.denied, true, name + ' 必须在动手前结构化拒绝')
    assert.match(texts[name], /需要 ADB 通道/, name + ' 文案必须点明「需要 ADB 通道」')
    assert.equal(violations(byName(name), r).length, 0, name + ' 拒绝返回值必须过自己的 schema')
  }
  assert.equal(calls.adbShell.length, 0, '拒绝路径不得发起 adb shell')
  assert.equal(calls.adbLine.length, 0, '拒绝路径不得发起 adb 行调用')
  assert.equal(calls.control.length, 0, '拒绝路径不得碰无障碍队列')
  assert.ok(!/环境准备完成/.test(texts.android_env_prepare), 'env_prepare 拒绝路径不得出现「环境准备完成」')
})

test('D5：旧 bridge（不认识 forceBackend）与策略面缺席都放行——不得误拒', async () => {
  for (const controlDecision of [() => ({ backend: 'a11y', reason: 'legacy-bridge' }), 'absent']) {
    const { face, calls } = makeFace(controlDecision === 'absent' ? {} : { controlDecision })
    const { byName } = applyManage(face)
    const r = await byName('android_act_input').execute({ action: 'keyevent', keycode: 4 }, EXEC)
    assert.equal(r.ok, true, '旧装配必须保持旧行为（放行）')
    assert.equal(calls.adbShell.length, 1, '旧装配下照旧走 ADB')
  }
})

test('D5：env_prepare 不再以「环境准备完成」收尾假成功（子步骤未生效必须显式说明）', async () => {
  const { face } = makeFace({})
  const { byName } = applyManage(face)
  const r = await byName('android_env_prepare').execute({}, EXEC)
  assert.equal(r.ok, false, '测试桩下动画未真正关闭 → 不得报成功')
  assert.ok(!/环境准备完成/.test(r.text), '不得出现「环境准备完成」')
  assert.match(r.text, /未成功/)
  assert.equal(violations(byName('android_env_prepare'), r).length, 0)
})

test('D8 + §5.3.3：13 个工具的未授权拒绝分支都带 denied=true 且过自己的 schema', async () => {
  const { face } = makeFace({ gateFor: () => ({ ok: false, guidance: '未授权（测试桩）' }) })
  const { tools } = applyManage(face)
  assert.equal(tools.length, 13)
  // 各工具的必填参数（defineTool 的参数面校验在 execute 之前，缺参会先抛 ToolArgsError）
  const args = {
    android_act_input: { action: 'keyevent', keycode: 4 },
    android_ui_scroll: { direction: 'down' },
    android_app_launch: { pkg: 'com.example' },
    android_ui_global: { action: 'back' },
  }
  for (const tool of tools) {
    const r = await tool.execute(args[tool.name] ?? {}, EXEC)
    const bad = violations(tool, r)
    assert.equal(r.denied, true, tool.name + ' 拒绝分支必须带 denied:true')
    assert.equal(bad.length, 0, tool.name + ' 拒绝返回值违规：' + bad.join('; '))
  }
})

test('D10/D6：web_dump 未声明键被白名单剔除；url/title 缺席时整键不发', async () => {
  const { face } = makeFace({
    webSnapshot: {
      nodes: [{ ref: 'w0', tag: 'button', text: '发送', editable: false, inView: true, bounds: [1, 2, 3, 4], nodeId: '不是声明键', x: 9, y: 9 }],
    },
  })
  const { byName } = applyManage(face)
  const tool = byName('android_web_dump')
  const r = await tool.execute({}, EXEC)
  assert.equal(r.ok, true)
  assert.equal(violations(tool, r).length, 0, '多带未声明键的节点不得再整值拒绝：' + violations(tool, r).join('; '))
  assert.deepEqual(Object.keys(r.nodes[0]).sort(), ['bounds', 'editable', 'inView', 'ref', 'tag', 'text'])
  assert.equal(Object.hasOwn(r, 'url'), false)
  assert.equal(Object.hasOwn(r, 'title'), false)

  const { face: face2 } = makeFace({ webSnapshot: { url: 'http://127.0.0.1:3080/', title: 'DSH', nodes: [] } })
  const r2 = await applyManage(face2).byName('android_web_dump').execute({}, EXEC)
  assert.equal(r2.url, 'http://127.0.0.1:3080/')
  assert.equal(r2.title, 'DSH')
  assert.equal(violations(byName('android_web_dump'), r2).length, 0)
})

test('D11：老壳 V1 载荷的 screen 多带未声明键不再连带拒绝（构造法；真老壳包需实测）', async () => {
  const { face } = makeFace({ snapshot: v1Snapshot() })
  const { byName } = applyManage(face)
  const tool = byName('android_ui_dump')
  const r = await tool.execute({ fresh: true }, EXEC)
  assert.equal(r.ok, true)
  assert.deepEqual(r.screen, { w: 1080, h: 2400 }, 'screen 必须按声明面显式重建（丢掉 density 等未声明键）')
  assert.equal(violations(tool, r).length, 0)
})

test('D7：只开无障碍（ADB 执行面缺席）时 android_ui_scroll 仍走语义滚动，且不碰 adb', async () => {
  const { face, calls } = makeFace({ snapshot: v2Payload() })
  delete face.execAdbLine      // 只开无障碍的部署：ADB 三道门未配对
  delete face.execAdbShell
  const { byName } = applyManage(face)
  const r = await byName('android_ui_scroll').execute({ direction: 'down', fraction: 0.5 }, EXEC)
  assert.equal(r.ok, true, '无障碍通道可用时不得被 ADB 面缺席挡住（旧实现卡在 ADB 检查上）')
  const call = calls.control.find((c) => c.op === 'scroll')
  assert.ok(call, '应走无障碍 scroll op')
  assert.equal(call.args.direction, 'down')
  assert.equal(calls.adbShell.length, 0)
  assert.equal(calls.adbLine.length, 0)
  assert.equal(violations(byName('android_ui_scroll'), r).length, 0)
})

test('D9：明细落盘失败时句柄不得停留在上一轮（detailHandle/detailPath 与本次返回一致）', async () => {
  const prevTmp = process.env.TMPDIR
  const okTmp = mkdtempSync(join(tmpdir(), 'dsh-mg-'))
  try {
    const { face } = makeFace({ snapshotAt: (nth) => v2Payload({ gen: nth === 1 ? 7 : 9 }) })
    const { byName } = applyManage(face)
    process.env.TMPDIR = okTmp
    const first = await byName('android_ui_dump').execute({ fresh: true }, EXEC)
    assert.equal(first.ok, true)
    assert.notEqual(first.detailHandle, '', '首轮落盘成功必须给出句柄')
    const detail1 = await byName('android_ui_detail').execute({ all: true }, EXEC)
    assert.equal(detail1.handle, first.detailHandle, 'ui_detail 必须用与本轮 dump 相同的句柄')

    // 制造落盘失败：TMPDIR 指向一个**文件**路径 → writeDetailStore 的 mkdirSync 抛 ENOTDIR
    process.env.TMPDIR = join(HERE, 'fixtures', 'ui-probe.xml')
    const second = await byName('android_ui_dump').execute({ fresh: true }, EXEC)
    assert.equal(second.ok, true, '落盘失败不得影响主结果')
    assert.equal(second.detailHandle, '', '落盘失败必须回空句柄')
    assert.equal(second.detailPath, '')
    const detail2 = await byName('android_ui_detail').execute({ all: true }, EXEC)
    assert.equal(detail2.handle, '', '模块级句柄不得停留在上一轮值（D9 的核心）')
    assert.equal(detail2.path, '')
    assert.equal(violations(byName('android_ui_dump'), second).length, 0)
  } finally {
    if (prevTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = prevTmp
    rmSync(okTmp, { recursive: true, force: true })
  }
})

test('output.schema 自洽：13 个工具都是 object 且 additionalProperties=false（拼写错误防线）', async () => {
  const { face } = makeFace({ snapshot: v2Payload() })
  const { tools } = applyManage(face)
  assert.equal(tools.length, 13)
  for (const tool of tools) {
    assert.equal(tool.output.schema.type, 'object', tool.name)
    assert.equal(tool.output.schema.additionalProperties, false, tool.name + ' 不得放宽 additionalProperties')
  }
})
