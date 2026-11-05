// issue #1030：能力门禁的 fail-open —— 组里有一个未注册的工具名，整组掩蔽被取消。
//
// 缺陷形态：引擎侧 tools.restrict() 的判据是**逐个名字**——deny 里只要有一个名字没注册，
// 整次调用抛错（dsh-tools/lib/index.js：「names unknown global tool …」）。而 capability-gate
// 把该异常当成「该组未注册」直接跳过，于是 phone 组的 17 个名字分布在两个插件里时，
// 禁用一个插件就让**整组**（含桥自己那 3 个特权工具）在用户从未解锁的情况下仍然可调用。
//
// 判据选「喂一个**真实引擎语义**的 restrict 桩」：既有的 capability-gate.test.mjs 的桩只
// denies.push(filter.deny) 从不校验名字，所以那条「按组分别掩蔽」的用例永远走不到引擎的 throw
// 分支——这正是缺陷藏了这么久的原因。本文件补上这个名字校验。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installCapabilityGate, DEVICE_TOOL_GROUPS } from '../lib/capability-gate.js'

function isolatedStore() {
  let saved = []
  return { read: () => [...saved], write: (groups) => { saved = [...groups] } }
}

/**
 * 引擎语义的 restrict 桩：deny 里出现未注册名字即抛错（与 dsh-tools 的实际判据一致），
 * 且暴露 view().restrictableNames（这是修复所需要的、引擎本来就有的能力面）。
 */
function engineLikeHarness(registeredNames) {
  const registered = new Set(registeredNames)
  const denies = []
  const errors = []
  const scopedCtx = {
    tools: {
      view: () => ({ restrictableNames: new Set(registered) }),
      restrict: (filter) => {
        const unknown = filter.deny.filter((name) => !registered.has(name))
        if (unknown.length > 0) {
          throw new Error('tools.restrict() names unknown global tool ' 
            + unknown.map((n) => '"' + n + '"').join(', ') + '; known global tools: ' + [...registered].sort().join(', '))
        }
        denies.push(filter.deny)
        return () => {}
      },
    },
  }
  const agent = { ctx: { inject: (_deps, callback) => { callback(scopedCtx); return { dispose: () => {} } } } }
  const ctx = {
    tools: { register: () => {} },
    get: () => undefined,
    on: (event, handler) => { events.push([event, handler]) },
    logger: { warn: (m) => { errors.push(String(m)) } },
  }
  const events = []
  return { ctx, agent, denies, errors, events, registered }
}

test('#1030 反证：组里有一个未注册的名字，不得让整组都不掩蔽', () => {
  const h = engineLikeHarness([])
  // 真实分布：phone 组 17 个名字 = manage 的 14 个 + bridge 的 3 个。
  // 模拟「用户禁用了 dsh-android-manage」：只剩桥自己的三个工具是注册过的。
  const bridgeOwned = ['android_shell_exec', 'android_termux_channel_exec', 'android_privilege_status']
  const phoneNames = DEVICE_TOOL_GROUPS.phone
  assert.ok(phoneNames.length > bridgeOwned.length, 'phone 组必须同时含两个插件的工具（夹具前提）')
  for (const name of bridgeOwned) {
    assert.ok(phoneNames.includes(name), name + ' 必须在 phone 组里（夹具前提）')
  }
  const onlyBridge = new Set([...bridgeOwned, ...DEVICE_TOOL_GROUPS.browser, ...DEVICE_TOOL_GROUPS['virtual-display']])
  const h2 = engineLikeHarness([...onlyBridge])
  installCapabilityGate(h2.ctx, () => ({ a11y: true, shizuku: false }), isolatedStore())
  const handler = h2.events.find(([event]) => event === 'agent/created')?.[1]
  assert.equal(typeof handler, 'function')
  handler({ agent: h2.agent })
  const deniedNames = h2.denies.flat()
  for (const name of bridgeOwned) {
    assert.ok(deniedNames.includes(name),
      '兄弟插件缺席时，' + name + ' 仍必须被掩蔽（否则未解锁 phone 组即可调用特权工具）；'
      + ' 实际掩蔽：' + JSON.stringify(deniedNames))
  }
  assert.doesNotMatch(h2.errors.join('\n'), /names unknown global tool/,
    '求交集后不该再有名字校验异常；实际告警：' + JSON.stringify(h2.errors))
})

test('#1030 正控：整组都在时掩蔽集合与组定义完全一致', () => {
  const all = new Set([...DEVICE_TOOL_GROUPS.phone, ...DEVICE_TOOL_GROUPS.browser, ...DEVICE_TOOL_GROUPS['virtual-display']])
  const h = engineLikeHarness([...all])
  installCapabilityGate(h.ctx, () => ({ a11y: true, shizuku: false }), isolatedStore())
  const handler = h.events.find(([event]) => event === 'agent/created')?.[1]
  handler({ agent: h.agent })
  assert.deepEqual(h.denies.flat().sort(), [...all].sort(), '全员在场时掩蔽集合必须等于全部设备工具')
  assert.equal(h.errors.length, 0, '不该有降级告警')
})
