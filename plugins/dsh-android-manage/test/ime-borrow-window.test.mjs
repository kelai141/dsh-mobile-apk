// 借道窗口的范围与排队回执（issue #1516 #1517 #1520）。
//
// 这三条缺陷的共同形态是「判据看不见真行为」：
//   #1516 锁把 nodeText 回读（4s 超时 ×2）与重试等待都包进临界区，第二路无超时、无回执地静默等待；
//   #1517 兜底取 `ime list -s` 第一行（ROM 枚举顺序），回执也不报还原到谁；
//   #1520 自身排除用严格等值，ROM 打全组件名时 DSH 自己成了还原目标。
//
// 所以判据一律落在**真实现的行为**上：驱动 `android_ui_input` 的真工具（假 face 提供壳侧回执），
// 只看「发了哪些命令、按什么顺序、跨两路时谁先动、回执写了什么」。
// 原先的接线断言读 src/index.ts 文本（`src.includes('needSwitch = prev !== IME_ID')`），
// 改一行注释就能让它失真——这里全部换成行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// #679 之后壳侧只认 nonce：先备一份可读的，否则 android_ui_input 在发广播之前就返回。
const NONCE_DIR = mkdtempSync(join(tmpdir(), 'kb-window-'))
writeFileSync(join(NONCE_DIR, 'adb-keyboard-nonce'), 'test-nonce\n')
process.env.DSH_FILES_DIR = NONCE_DIR

const SELF = 'com.dsharnessmobile.shell/.AdbKeyboardService'
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

/**
 * 假壳侧面 + 事件序列。events 里两条前缀分开记：
 *   `adb:<命令原文>` / `a11y:<op>`——「谁先动」只能从这条序列读出来。
 * options.shell(command, events) 可改写单条命令的返回（用来模拟永挂/异常回执）。
 */
function makeHarness(options = {}) {
  const events = []
  const face = {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend: 'adb', reason: 'test-adb' }),
    a11yEnabled: () => true,
    controlExec: async (op) => {
      events.push('a11y:' + op)
      if (op === 'nodeText') {
        if (options.nodeText) return options.nodeText()
        return { ok: true, data: { text: options.readBack ?? '' } }
      }
      return { ok: true, data: {} }
    },
    execAdbShell: async (command) => {
      events.push('adb:' + command)
      if (options.shell) {
        const override = await options.shell(command)
        if (override !== undefined) return override
      }
      if (command.startsWith('settings get secure default_input_method')) {
        return { ok: true, stdout: options.settingsOut ?? '' }
      }
      if (command === 'ime list -s') return { ok: true, stdout: options.imeList ?? '' }
      if (command.startsWith('am broadcast')) return { ok: true, stdout: 'Broadcast completed: result=1\n' }
      return { ok: true, stdout: '' }
    },
    execAdbLine: async () => ({ ok: true, stdout: '' }),
  }
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  return { events, tool: tools.find((t) => t.name === 'android_ui_input') }
}

const restoreCmd = (id) => `adb:sleep 0.4; ime set '${id}'`
const broadcasts = (events) => events.filter((e) => e.startsWith('adb:am broadcast'))

test('#1516 窗口顺序：切换 → 广播 → 还原，回读（nodeText）在还原之后', async () => {
  const { events, tool } = makeHarness({ settingsOut: 'com.user/.Mine', readBack: 'hello' })
  const r = await tool.execute({ text: 'hello', channel: 'adbkeyboard' }, {})
  assert.equal(r.ok, true, '正常路径必须成功：' + JSON.stringify(r))
  assert.deepEqual(events, [
    'adb:settings get secure default_input_method',
    'adb:ime enable ' + SELF,
    'adb:ime set ' + SELF,
    events.find((e) => e.includes('ADB_INPUT_TEXT')),
    restoreCmd('com.user/.Mine'),
    'a11y:nodeText',
  ], '借道窗口必须是「读 prev → 启用/切换 → 广播 → 还原」，回读在还原之后')
})

test('#1516 回读在锁外：第二路不必等第一路的 nodeText 回读', async () => {
  let releaseReadBack
  const readBackGate = new Promise((resolve) => { releaseReadBack = resolve })
  const first = makeHarness({
    settingsOut: 'com.user/.Mine',
    nodeText: async () => {
      await readBackGate
      return { ok: true, data: { text: 'hello' } }
    },
  })
  const second = makeHarness({ settingsOut: 'com.user/.Mine', readBack: 'hello' })

  const firstRun = first.tool.execute({ text: 'hello', channel: 'adbkeyboard' }, {})
  // 等第一路走到回读：此时它在旧实现里**仍持有借道锁**。
  for (let i = 0; i < 200 && !first.events.includes('a11y:nodeText'); i += 1) await sleep(5)
  assert.ok(first.events.includes('a11y:nodeText'), '第一路应已进入回读：' + first.events.join(' , '))
  assert.ok(first.events.includes(restoreCmd('com.user/.Mine')), '回读前必须先还原（还原在窗口内）')

  const secondRun = second.tool.execute({ text: 'hello', channel: 'adbkeyboard' }, {})
  const raced = await Promise.race([
    (async () => { for (let i = 0; i < 400; i += 1) { if (second.events.some((e) => e.startsWith('adb:settings get'))) return 'started'; await sleep(5) } return 'waiting' })(),
    sleep(3000).then(() => 'timeout'),
  ])
  releaseReadBack()
  await Promise.all([firstRun, secondRun])
  assert.equal(raced, 'started',
    '第一路卡在 nodeText 回读时第二路必须已开始（回读若在锁内，第二路只能干等）：' + second.events.join(' , '))
})

test('#1516 排队超时：前一路悬着时后一路按时失败，且不切换、不广播', async () => {
  let releaseHang
  const hang = new Promise((resolve) => { releaseHang = resolve })
  const holder = makeHarness({
    settingsOut: 'com.user/.Mine',
    shell: async (command) => {
      // 第一路卡在窗口里（模拟壳侧回填不来）：此后它既不还原也不释放。
      if (command.startsWith('ime enable')) { await hang; return { ok: false, stdout: '' } }
      return undefined
    },
  })
  process.env.DSH_IME_BORROW_BUDGET_MS = '120'
  try {
    const held = holder.tool.execute({ text: 'held', channel: 'adbkeyboard' }, {})
    for (let i = 0; i < 200 && !holder.events.some((e) => e.startsWith('adb:ime enable')); i += 1) await sleep(5)
    assert.ok(holder.events.some((e) => e.startsWith('adb:ime enable')), '第一路应已进入窗口并持有锁')

    const waiter = makeHarness({ settingsOut: 'com.user/.Mine' })
    const outcome = await Promise.race([
      waiter.tool.execute({ text: 'second', channel: 'adbkeyboard' }, {}),
      sleep(3000).then(() => 'HANG'),
    ])
    releaseHang()
    await held
    assert.notEqual(outcome, 'HANG', '排队必须有超时（旧实现在无超时的 await 上静默等待）')
    assert.equal(outcome.ok, false, '排不上队必须失败，不得假装成功')
    assert.match(String(outcome.text), /排队/, '回执必须说明是排队超时：' + String(outcome.text))
    assert.match(String(outcome.text), /未切换输入法/, '回执必须说明本次没切换、没广播：' + String(outcome.text))
    assert.equal(broadcasts(waiter.events).length, 0, '超时的这一路不得发广播：' + waiter.events.join(' , '))
    assert.equal(waiter.events.filter((e) => e.startsWith('adb:ime set')).length, 0,
      '超时的这一路不得切输入法：' + waiter.events.join(' , '))
  } finally {
    delete process.env.DSH_IME_BORROW_BUDGET_MS
  }
})

test('#1517 回执必须报出还原目标（读回路径）', async () => {
  const { tool } = makeHarness({ settingsOut: 'com.user/.Mine', readBack: 'hello' })
  const r = await tool.execute({ text: 'hello', channel: 'adbkeyboard' }, {})
  assert.equal(r.ok, true)
  assert.match(String(r.text), /已还原到 com\.user\/\.Mine/, '回执必须写明还原到谁：' + String(r.text))
})

test('#1517 兜底不取 ROM 顺序第一行：优先还回用户实际在用的输入法', async () => {
  const mine = 'com.pref.unique/.Board'
  // 第一次：读回值可用 ⇒ 记住用户在用谁。
  const learn = makeHarness({ settingsOut: mine, readBack: 'x' })
  await learn.tool.execute({ text: 'x', channel: 'adbkeyboard' }, {})
  // 第二次：读回值变成 null，列表里 mine 排在第二名。
  const fallback = makeHarness({
    settingsOut: 'null',
    imeList: 'com.other/.First\n' + mine + '\n' + SELF + '\n',
    readBack: 'x',
  })
  const r = await fallback.tool.execute({ text: 'x', channel: 'adbkeyboard' }, {})
  assert.equal(r.ok, true, '兜底路径必须仍然成功：' + JSON.stringify(r))
  assert.ok(fallback.events.includes(restoreCmd(mine)),
    '必须还回用户实际在用的 ' + mine + '（不是列表第一行）：' + fallback.events.join(' , '))
  assert.ok(!fallback.events.includes(restoreCmd('com.other/.First')),
    '不得还把用户切到 ROM 顺序第一行：' + fallback.events.join(' , '))
  assert.match(String(r.text), /按已启用列表还原到 com\.pref\.unique\/\.Board/, '回执必须报兜底来源与目标：' + String(r.text))
})

test('#1520 全组件名形态的自身排除：DSH 键盘不得成为还原目标', async () => {
  const selfFull = 'com.dsharnessmobile.shell/com.dsharnessmobile.shell.AdbKeyboardService'
  const { events, tool } = makeHarness({
    settingsOut: selfFull,
    imeList: selfFull + '\ncom.dsh.other/.Board\n',
    readBack: 'x',
  })
  const r = await tool.execute({ text: 'x', channel: 'adbkeyboard' }, {})
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(!events.includes(restoreCmd(selfFull)), '不得还原到 DSH 键盘（全形态）：' + events.join(' , '))
  assert.ok(!events.includes(restoreCmd(SELF)), '不得还原到 DSH 键盘（短形态）：' + events.join(' , '))
  assert.ok(events.includes(restoreCmd('com.dsh.other/.Board')),
    '读回值就是本通道时，必须退到列表里另一个输入法：' + events.join(' , '))
  assert.match(String(r.text), /按已启用列表还原到 com\.dsh\.other\/\.Board/, '回执必须如实报出兜底还原目标：' + String(r.text))
})

test('#1371 两边都不可还原：仍然切换（否则广播拿 imeNotReady），回执明写未能还原', async () => {
  const { events, tool } = makeHarness({ settingsOut: 'null', imeList: SELF + '\n', readBack: 'x' })
  const r = await tool.execute({ text: 'x', channel: 'adbkeyboard' }, {})
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.ok(events.includes('adb:ime list -s'), '读回不可用时必须查已启用列表：' + events.join(' , '))
  assert.ok(events.includes('adb:ime set ' + SELF), 'prev 为空也必须切换，否则广播不会被提交')
  assert.equal(events.filter((e) => e.startsWith('adb:sleep 0.4')).length, 0, '没有还原目标就不得发 ime set')
  assert.match(String(r.text), /未能还原/, '回执必须明写未能还原：' + String(r.text))
})

test('#1371 还原命令必须单引号转义 prev（不得裸拼设备回读值）', async () => {
  const { events, tool } = makeHarness({ settingsOut: 'com.user/.Mine', readBack: 'x' })
  await tool.execute({ text: 'x', channel: 'adbkeyboard' }, {})
  const restore = events.filter((e) => e.startsWith('adb:sleep 0.4')).join(' | ')
  assert.equal(restore, restoreCmd('com.user/.Mine'), '还原必须是 sleep 0.4; ime set <单引号包裹的 prev>，实际：' + restore)
})

test('#1516 clear + text：清空与输入各一次广播，顺序不得颠倒', async () => {
  const { events, tool } = makeHarness({ settingsOut: 'com.user/.Mine', readBack: 'hi' })
  const r = await tool.execute({ clear: true, text: 'hi', channel: 'adbkeyboard' }, {})
  assert.equal(r.ok, true, JSON.stringify(r))
  const casts = broadcasts(events)
  assert.equal(casts.length, 2, 'clear + text 必须两次广播：' + events.join(' , '))
  assert.ok(casts[0].includes('ADB_CLEAR_TEXT'), '第一次必须是清空：' + casts[0])
  assert.ok(casts[1].includes('ADB_INPUT_TEXT'), '第二次必须是输入：' + casts[1])
})
