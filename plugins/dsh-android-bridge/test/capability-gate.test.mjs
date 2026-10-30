// 渐进披露门（0.14.0 §4.1）：常驻 facade + agent 作用域掩蔽 + skill 目录条目。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  installCapabilityGate,
  CAPABILITY_TOOL_NAME,
  DEVICE_TOOLS,
  DEVICE_TOOL_GROUPS,
} from '../lib/capability-gate.js'

/**
 * 每个用例一个**隔离的内存解锁态存储**。
 *
 * 为什么必须注入：installCapabilityGate 的第三个参数默认是**真文件存储**（落在 DSH_HOME）。
 * 测试不注入 => 解锁会写进开发者本机真实的 ~/.dsh，并且**第二次运行会读到上次的解锁记录**，
 * 让「启动时三组全锁」这条既有断言在重复运行下变红（实现期实测踩到，已清理泄漏文件）。
 * 测试必须自封闭：这里注入内存实现，绝不碰真实文件系统。
 */
function isolatedStore() {
  let saved = []
  return { read: () => [...saved], write: (groups) => { saved = [...groups] } }
}

/**
 * 单测桩：按**引擎语义**回放 tools.restrict（issue #1030 的负控前提）。
 *
 * 为什么必须让桩校验名字：修前这里只 `denies.push(filter.deny)`，从不校验，于是
 * 「组里有一个名字未注册 -> 引擎整次抛错 -> 门禁整组不掩蔽」这条真实分支**永远走不到**，
 * 缺陷因此一直没有测试面。引擎判据见 dsh-tools 的 `restrict()`：对 deny 里**每个名字**
 * 逐个查 `restrictableNames`，有一个不在集合里就整次 throw。
 *
 * @param options.known 当前「已注册的全局工具名」集合；默认全部设备工具（既有用例保持原语义）。
 */
function harness(options = {}) {
  const known = new Set(options.known ?? DEVICE_TOOLS)
  const registered = []
  const skills = []
  const events = []
  const denies = []
  const warns = []
  const scopedCtx = {
    tools: {
      restrict: (filter) => {
        const unknown = filter.deny.filter((name) => !known.has(name))
        if (unknown.length > 0) {
          // 与引擎同形的报文（EngineToolRegistry.restrict）。
          throw new Error('tools.restrict() names unknown global tool'
            + (unknown.length > 1 ? 's' : '') + ' ' + unknown.map((name) => '"' + name + '"').join(', ')
            + '; known global tools: ' + [...known].sort().join(', '))
        }
        denies.push(filter.deny)
        return () => { state.disposeCount += 1 }
      },
    },
  }
  const agent = {
    ctx: {
      inject: (_deps, callback) => {
        callback(scopedCtx)
        return { dispose: () => { state.disposeCount += 1 } }
      },
    },
  }
  const state = { disposeCount: 0, agent }
  const ctx = {
    tools: { register: (tool) => { registered.push(tool) } },
    get: (name) => (name === 'skills' ? { register: (skill) => { skills.push(skill) } } : undefined),
    on: (event, handler) => { events.push([event, handler]) },
    logger: { warn: (message) => { warns.push(message) } },
  }
  return { ctx, registered, skills, events, state, denies, warns, known }
}

test('facade 常驻注册且名字固定', () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11y: false }), isolatedStore())
  assert.equal(h.registered.length, 1)
  assert.equal(h.registered[0].name, CAPABILITY_TOOL_NAME)
  assert.equal(DEVICE_TOOLS.includes(CAPABILITY_TOOL_NAME), false)
})

test('skill 目录登记三个能力组（发现 + 先调 facade 指引）', () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11y: false }), isolatedStore())
  const names = h.skills.map((s) => s.name).sort()
  assert.deepEqual(names, ['android-ai-browser', 'android-phone-control', 'android-virtual-display'])
  for (const skill of h.skills) {
    assert.match(skill.content, new RegExp(CAPABILITY_TOOL_NAME))
  }
})

test('agent/created 时按组分别掩蔽；facade 调用后逐组解锁并如实回报', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11y: true, shizuku: false }), isolatedStore())
  const handler = h.events.find(([event]) => event === 'agent/created')?.[1]
  assert.equal(typeof handler, 'function')
  handler({ agent: h.state.agent })
  const masked = h.denies.flat().sort()
  assert.deepEqual(masked, [...DEVICE_TOOLS].sort())
  assert.equal(h.denies.length, Object.keys(DEVICE_TOOL_GROUPS).length)
  // 只解锁 browser：phone / virtual-display 仍在锁内
  const one = await h.registered[0].execute({ group: 'browser' }, { agent: h.state.agent })
  assert.deepEqual(one.unlocked, ['browser'])
  assert.deepEqual([...one.locked].sort(), ['phone', 'virtual-display'])
  assert.deepEqual(one.channels, { a11y: true, shizuku: false })
  assert.match(one.text, /未就绪/)
  assert.equal(h.state.disposeCount, 1)
  // 再解锁 all：剩下两组解锁，locked 清空
  const rest = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual([...rest.unlocked].sort(), ['phone', 'virtual-display'])
  assert.deepEqual(rest.locked, [])
})

test('skill 条目必须带 source（上游 SkillSummary 必填；缺了会在加载时抛错）', () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11y: false }), isolatedStore())
  for (const skill of h.skills) {
    assert.equal(typeof skill.source, 'string')
    assert.ok(skill.source.length > 0)
    assert.equal(typeof skill.content, 'string')
  }
})

test('缺失 skills 服务或作用域注入时降级不抛（fail-open 到今天的可见性）', () => {
  const registered = []
  installCapabilityGate({ tools: { register: (tool) => { registered.push(tool) } } }, () => ({ a11y: false }), isolatedStore())
  assert.equal(registered.length, 1)
})

// ── A1（0.14.1 设备实测缺陷）：Shizuku 通道三态 ──────────────────────────────
//
// 设备实录：工具面报「Shizuku 特权通道：未就绪（**虚拟屏建屏需要它**）」，状态区同一时刻显示
// 「已授权」且虚拟屏确实建成了；模型据此判定「建不了虚拟屏」而放弃了一个可用能力。
// 真因：caps 只随控制 op 的回执抵达，而 android_capabilities 自己不入队 ⇒ 首次询问必然缺席，
// 旧实现把这个「缺席」渲染成「未就绪」。以下用例钉住三态语义。

test('A1：未探测（键缺席）不得渲染成「未就绪」，且必须给出可执行动作', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11y: true }), isolatedStore())
  const one = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual(one.channels, { a11y: true })
  assert.equal('shizuku' in one.channels, false, '未探测必须是键缺席，不能是 false')
  const line = one.text.split('\n').find((l) => l.startsWith('- Shizuku'))
  assert.doesNotMatch(line, /未就绪/, '「未知」不得渲染成「未就绪」：' + line)
  assert.match(line, /状态未知/)
  assert.match(line, /android_vdisplay_create/, '未知必须指向「直接试一次」这个可执行动作')
})

test('A1：三态必须是三条互不相同的文案（就绪 / 实测未就绪 / 未知）', async () => {
  const seen = []
  for (const facts of [{ a11y: true, shizuku: true }, { a11y: true, shizuku: false }, { a11y: true }]) {
    const h = harness()
    installCapabilityGate(h.ctx, () => facts, isolatedStore())
    const one = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
    seen.push(one.text.split('\n').find((l) => l.startsWith('- Shizuku')))
  }
  assert.match(seen[0], /就绪（shell 执行/)
  assert.match(seen[1], /未就绪（已实测/)
  assert.match(seen[2], /状态未知/)
  assert.equal(new Set(seen).size, 3, '三态折叠成同一句话就是这个缺陷本身：' + JSON.stringify(seen))
})

test('A1：channels 允许异步（引擎补探），门禁必须 await 得到事实而非 Promise', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return { a11y: true, shizuku: true }
  }, isolatedStore())
  const one = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual(one.channels, { a11y: true, shizuku: true })
  assert.match(one.text, /Shizuku 特权通道：就绪/)
})

test('a11y probe failures remain unknown instead of becoming confirmed disabled', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, async () => { throw new Error('probe unavailable') }, isolatedStore())
  const one = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual(one.channels, {})
  assert.doesNotMatch(JSON.stringify(one), /undefined/)
  const line = one.text.split('\n').find((l) => l.startsWith('- 无障碍通道'))
  assert.match(line, /状态未确认/)
  assert.match(line, /直接尝试目标操作/)
  assert.doesNotMatch(line, /未开启/)
})

test('stale a11y heartbeat is reported as uncertain with its age', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11ySource: 'stale', a11yHeartbeatAgeMs: 45_000 }), isolatedStore())
  const one = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual(one.channels, { a11ySource: 'stale', a11yHeartbeatAgeMs: 45_000 })
  const line = one.text.split('\n').find((l) => l.startsWith('- 无障碍通道'))
  assert.match(line, /心跳已过期 45 秒/)
  assert.match(line, /服务状态未确认/)
  assert.match(line, /直接尝试目标操作/)
  assert.doesNotMatch(line, /未开启/)
})

test('missing stale heartbeat age remains a stale state instead of becoming unknown', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11ySource: 'stale' }), isolatedStore())
  const one = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual(one.channels, { a11ySource: 'stale' })
  const line = one.text.split('\n').find((l) => l.startsWith('- 无障碍通道'))
  assert.match(line, /心跳缺失/)
  assert.match(line, /服务状态未确认/)
  assert.doesNotMatch(line, /状态未知|未开启/)
})

test('explicit a11y disablement remains a distinct confirmed state', async () => {
  const h = harness()
  installCapabilityGate(h.ctx, () => ({ a11y: false }), isolatedStore())
  const one = await h.registered[0].execute({ group: 'all' }, { agent: h.state.agent })
  assert.deepEqual(one.channels, { a11y: false })
  const line = one.text.split('\n').find((l) => l.startsWith('- 无障碍通道'))
  assert.match(line, /已确认关闭/)
})

// ── issue #1030：能力门禁 fail-open ───────────────────────────────────────────
//
// 现象：手机控制组（phone，17 个名字）分布在两个插件里——dsh-android-manage 14 个、
// dsh-android-bridge 3 个（android_shell_exec / android_termux_channel_exec /
// android_privilege_status）。用户禁用/加载失败 manage 后，phone 组的 deny 里含 14 个
// 未注册名字；引擎 tools.restrict 是**逐个名字**校验（有一个不在 restrictableNames 就整次
// throw），修前一次性传整组 -> throw -> catch 只 warn -> **整组（含 bridge 那 3 个）都不掩蔽**，
// 于是用户从未解锁 phone 组，android_shell_exec 依然可调用。
//
// 修法：整组先整次尝试（正常路径仍是**一次** restrict，形态与修前一致）；引擎报「名字未注册」
// 时退化为逐名字先探后用——只把当前确实已注册的名字放进 deny，未注册的跳过。分片后一个都没
// 剩下 = 该组本来就没东西可掩蔽，跳过即可（既不必 throw，也不得 fail-open 掉整组）。

/** phone 组里属于 dsh-android-manage 的 14 个名字（另一个插件注册的那部分）。 */
const PHONE_NAMES_FROM_MANAGE = [
  'android_screen_list',
  'android_screenshot',
  'android_ui_tree',
  'android_device_info',
  'android_act_input',
  'android_ui_dump',
  'android_ui_click',
  'android_ui_scroll',
  'android_ui_input',
  'android_web_dump',
  'android_env_prepare',
  'android_app_launch',
  'android_ui_global',
  'android_ui_detail',
]

/** phone 组里属于 dsh-android-bridge 的 3 个特权工具（用户禁用 manage 后仅剩这三个）。 */
const PHONE_NAMES_FROM_BRIDGE = [
  'android_shell_exec',
  'android_termux_channel_exec',
  'android_privilege_status',
]

/** 用户禁用 dsh-android-manage 后「已注册的全局工具」集合：phone 组只剩 bridge 那三个。 */
function knownWithoutManage() {
  const removed = new Set(PHONE_NAMES_FROM_MANAGE)
  return DEVICE_TOOLS.filter((name) => !removed.has(name))
}

test('#1030 禁止 manage 后仍必须锁住 bridge 的三个特权工具（不得整组 fail-open）', () => {
  const h = harness({ known: knownWithoutManage() })
  installCapabilityGate(h.ctx, () => ({ a11y: true }), isolatedStore())
  const handler = h.events.find(([event]) => event === 'agent/created')?.[1]
  assert.equal(typeof handler, 'function')
  handler({ agent: h.state.agent })

  // 核心断言：用户从未解锁 phone 组，本插件那三个特权工具必须真的被掩蔽。
  // 修前这三个名字一个都不在掩蔽名单里（整组因 14 个未注册名字 throw 而漏掩蔽）。
  const masked = h.denies.flat()
  for (const name of PHONE_NAMES_FROM_BRIDGE) {
    assert.ok(
      masked.includes(name),
      '用户从未解锁 phone 组，' + name + ' 必须仍在掩蔽名单里；实际掩蔽：' + JSON.stringify(h.denies),
    )
  }
  // 未注册的 14 个名字绝不能进 deny（引擎会因它们整次 throw）。
  for (const name of PHONE_NAMES_FROM_MANAGE) {
    assert.equal(masked.includes(name), false, '未注册的名字绝不能进 deny（引擎会整次 throw）：' + name)
  }
  // 不是「整组 fail-open」：没有一次掩蔽落进外层 catch 的告警分支。
  assert.deepEqual(h.warns, [], '修后不得再落进 catch 的 fail-open 分支：' + JSON.stringify(h.warns))
})

test('#1030 反向断言：未注册名字被逐个跳过，剩下的已注册名字照常掩蔽', async () => {
  const h = harness({ known: knownWithoutManage() })
  installCapabilityGate(h.ctx, () => ({ a11y: true }), isolatedStore())
  const handler = h.events.find(([event]) => event === 'agent/created')?.[1]
  handler({ agent: h.state.agent })

  // phone 组的掩蔽被分片成「每个已注册名字一条」，合起来恰好等于该组里当前已注册的三个名字。
  const phoneDenies = h.denies.filter((deny) => deny.some((name) => PHONE_NAMES_FROM_BRIDGE.includes(name)))
  assert.ok(phoneDenies.length > 0, 'phone 组必须仍然被掩蔽')
  const phoneMasked = [...new Set(phoneDenies.flat())].sort()
  assert.deepEqual(phoneMasked, [...PHONE_NAMES_FROM_BRIDGE].sort(),
    '掩蔽集合必须恰好等于「该组里当前已注册的名字」，未注册的跳过而不是整组放弃')

  // 全部名字都注册时（另外两组）保持修前的整组形态：组数与掩蔽总数不变。
  const otherDenies = h.denies.filter((deny) => !deny.some((name) => PHONE_NAMES_FROM_BRIDGE.includes(name)))
  assert.equal(otherDenies.length, 2, '其余两组各一条整组掩蔽；实际：' + JSON.stringify(otherDenies))

  // 解锁 phone 后，那三个名字重新可见：解锁语义不受分片影响。
  const one = await h.registered[0].execute({ group: 'phone' }, { agent: h.state.agent })
  assert.deepEqual(one.unlocked, ['phone'])
  assert.equal(one.locked.includes('phone'), false)
})

test('#1030 掩蔽回调是异步的：锁表登记不得依赖回调已跑完（否则解锁会变成空操作）', async () => {
  // cordis 的 ctx.inject 回调在**下一个微任务**才执行（fiber.ts 的 _reload 先 await 一个
  // 微任务）。任何「回调里算出掩蔽了几个名字 -> 回来做同步判断」的写法都会看到空结果，
  // 真实后果是锁表被清空、facade 报「已解锁」而工具其实从未被掩蔽。这里把 inject 桩做成
  // **延迟执行**，钉住「登记锁表早于回调执行」这一条。
  const denies = []
  const registered = []
  const pending = []
  const state = { disposeCount: 0 }
  const agent = {
    ctx: {
      inject: (_deps, callback) => {
        // 不立刻调用：模拟 cordis 的异步装配。
        pending.push(() => callback({ tools: { restrict: (filter) => {
          denies.push(filter.deny)
          return () => { state.disposeCount += 1 }
        } } }))
        return { dispose: () => { state.disposeCount += 1 } }
      },
    },
  }
  let created
  const ctx = {
    tools: { register: (tool) => { registered.push(tool) } },
    get: () => undefined,
    on: (event, handler) => { if (event === 'agent/created') created = handler },
    logger: { warn: () => {} },
  }
  installCapabilityGate(ctx, () => ({ a11y: true }), isolatedStore())
  assert.equal(pending.length, 0, 'installCapabilityGate 自身不得主动 lock（没有 agent 事件前不动）')

  // 触发 agent 事件：三组都各自登记一次作用域注入，但掩蔽尚未真正发生。
  created({ agent })
  assert.equal(pending.length, Object.keys(DEVICE_TOOL_GROUPS).length,
    '三组都必须登记作用域注入（锁表在回调执行前就已登记）')
  assert.deepEqual(denies, [], '此刻掩蔽确实还没发生（桩尚未回调）')

  // 装配完成：掩蔽生效。
  for (const run of pending) run()
  assert.equal(denies.length, Object.keys(DEVICE_TOOL_GROUPS).length, '回调执行后三组各一次整组掩蔽')

  // 关键断言：此时锁表里仍须有全部三组。若把「掩蔽了几个名字」当成同步结果来判断
  // （异步回调里赋值 -> 回来永远是空），锁表会被清空，下面就会误报「同时解锁了 phone」。
  const gate = registered[0]
  const after = await gate.execute({ group: 'browser' }, { agent })
  assert.deepEqual(after.unlocked, ['browser'])
  assert.deepEqual([...after.locked].sort(), ['phone', 'virtual-display'],
    '锁表必须完整保留未解锁的两组（异步回调不得被当成同步判断依据）')
})

test('#1030 该组一个名字都没注册时跳过掩蔽，不抛错也不误伤别的组', () => {
  const withoutVdisplay = DEVICE_TOOLS.filter((name) => !DEVICE_TOOL_GROUPS['virtual-display'].includes(name))
  const h = harness({ known: withoutVdisplay })
  installCapabilityGate(h.ctx, () => ({ a11y: true }), isolatedStore())
  const handler = h.events.find(([event]) => event === 'agent/created')?.[1]
  handler({ agent: h.state.agent })

  const vdisplayNames = new Set(DEVICE_TOOL_GROUPS['virtual-display'])
  const vdisplayDenies = h.denies.filter((deny) => deny.some((name) => vdisplayNames.has(name)))
  assert.deepEqual(vdisplayDenies, [], '该组没有可掩蔽的名字 -> 一条掩蔽都不该产生')

  const masked = h.denies.flat().sort()
  assert.deepEqual(masked, [
    ...DEVICE_TOOL_GROUPS.browser,
    ...DEVICE_TOOL_GROUPS.phone,
  ].sort(), '其余两组必须照常整组掩蔽，不得被兄弟组的缺席连累')
  assert.deepEqual(h.warns, [], '「整组未注册」不是异常路径，不该 warn：' + JSON.stringify(h.warns))
})
