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

function harness() {
  const registered = []
  const skills = []
  const events = []
  const denies = []
  const scopedCtx = {
    tools: {
      restrict: (filter) => {
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
    logger: { warn: () => {} },
  }
  return { ctx, registered, skills, events, state, denies }
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
