// env_prepare 的动画取值口径（issue #1526）。
//
// ## 缺陷形态（两条，同源：把「字符串」当成「取值」）
//   1. 回读用字符串等值 `now[k] === '1'` / `=== '0'`：ROM 回 `1.0`、或读通道缺席（键缺失，
//      旧文案里打成 `?`）时，**真成功也进 notDone** —— env_prepare 整条返回 ok=false，
//      用户看到的是假失败，而且无从区分「没写进去」与「读不到」；
//   2. 恢复写常量 1：`restoreAnimScales({})` ⇒ `old[k] ?? '1'` 一律写 '1'。用户自设的
//      0.5 / 10 倍速被静默抹成默认值——「恢复」把人家的设置改掉了。
//
// ## 为什么重写
// 原用例是**源码文本切片**（`src.indexOf('if (restore) {')` 起 900 字符，断言里面出现某几句
// 字符串）。它只证明「这几句话还写着」，不证明任何取值口径：
//   - 把判定挪进 helper（本 PR 就是这么修的）→ 原用例整条变红，而行为没变；
//   - 反过来，把 `Number(...)` 改回 `===` 只要还留着一句同名断言就能骗过去。
// 所以这里**驱动真实现**：`apply()` 注册工具，用假 priv 面喂各种回读形态，只断言回执与
// 真正写给设备的键值表。
//
// ## 判据
//   1 关闭分支：回读 `1.0` 形态的 `0.0` 必须算成功（不再假失败）；
//   2 关闭分支：键缺失 / 回 `unknown` 必须报「读不回」，且与「未生效」是**两条不同文案**；
//   3 恢复分支：准备前读到 0.5 / 10，恢复必须把 0.5 / 10 **写回去**（不是常量 1）；
//   4 恢复分支：没有原值记录时写回 1，且回执**点名**「原值未记录」；
//   5 恢复分支：回读 `1.0` 形态的目标值必须算成功。
//
// ## 负控
//   NC1 把 `animScaleMatches` 改回字符串等值 -> 用例 1 / 5 红（1.0 被当成不相等）。
//   NC2 把恢复写回值改回常量 '1' -> 用例 3 红（用户设置被抹掉）。
//   NC3 把「读不到」并进「未生效」-> 用例 2 红（两条文案分不开）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)

const KEYS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']

/**
 * 假特权面：动画三开关是一块内存表，读写都记进 `writes`。
 *
 * **写入后按 ROM 的真实口径回显**：本 issue 的现场就是「写 0 / 1，读回 0.0 / 1.0」
 * （不少 ROM 的 settings 值以浮点形态存储与回显）。夹具必须复现这个形态，
 * 否则「字符串等值」这条缺陷在夹具里根本不会显形 —— 那正是原用例绿着的真因。
 * @param initial - 初始表（模拟设备当前值）。
 * @param options - `unreadable` 为 true 时读通道整体缺席；`echo` 可自定义回显格式。
 */
function faceFor(initial, options = {}) {
  const state = { ...initial }
  const writes = []
  const echo = options.echo ?? ((v) => {
    const n = Number(v)
    return Number.isFinite(n) ? n.toFixed(1) : String(v)
  })
  const face = {
    writes,
    state,
    gateFor: () => ({ ok: true }),
    audit: () => {},
    bindSession: () => {},
    controlDecision: () => ({ backend: 'adb', reason: 'test-adb' }),
    controlExec: async () => ({ ok: true, data: {} }),
    // env_prepare 需要 adb shell 通道存在（判据是「通道接通」，不是「命令成功」）。
    execAdbShell: async () => ({ ok: true, stdout: 'com.dsharnessmobile.shell/.AdbKeyboardService\n' }),
    execAdbLine: async () => ({ ok: true, stdout: '' }),
    screenAccess: () => ({ ok: true, screenId: 'real', displayId: 0, scope: 'all' }),
    // IME 分支的判据：ime list -s | grep -c 有输出 ⇒ 已启用（这里恒为 1）。
    ...(options.unreadable
      ? {}
      : {
        readAnimationScales: async () => ({
          ok: true,
          stdout: KEYS.map((k) => 'R:' + k + '=' + String(state[k])).join('\n'),
        }),
      }),
    writeAnimationScales: async (values) => {
      writes.push({ ...values })
      // 落盘后按 ROM 口径回显（写 0 -> 读回 0.0）。
      for (const [k, v] of Object.entries(values)) state[k] = echo(v)
      return { ok: true, stdout: '' }
    },
  }
  return face
}

/** 用给定特权面跑一次 android_env_prepare。 */
async function runPrepare(face, args) {
  const tools = []
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  const tool = tools.find((t) => t.name === 'android_env_prepare')
  assert.ok(tool, 'android_env_prepare 必须注册')
  // ime=false：本文件只验动画口径，输入法分支不参与。
  return tool.execute({ ime: false, ...args }, { agent: { session: 's1' } })
}

/** 设备侧三开关的**数值**视图（ROM 回显形态可能是 0 / 0.0 / 0.00，取值只看数）。 */
function scalesOf(face) {
  const out = {}
  for (const key of KEYS) out[key] = Number(face.state[key])
  return out
}

/** 独立的 DSH_FILES_DIR：原值落盘互不干扰（每条用例一个临时目录）。 */
function withFilesDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anim-'))
  const previous = process.env.DSH_FILES_DIR
  process.env.DSH_FILES_DIR = dir
  try {
    return fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_FILES_DIR
    else process.env.DSH_FILES_DIR = previous
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

test('关闭分支：回读 0.0 形态必须算成功（字符串等值会假失败）', async () => {
  await withFilesDir(async () => {
    const face = faceFor({ window_animation_scale: '0.0', transition_animation_scale: '0.0', animator_duration_scale: '0.0' })
    const r = await runPrepare(face, { animations: true })
    assert.equal(r.ok, true, '三项读回都是 0.0（数值 = 0）时必须成功：' + String(r.text))
    assert.match(String(r.text), /已关闭/, '回执必须如实说已关闭')
  })
})

test('关闭分支：读不回与未生效是两条不同文案（处置方式不同）', async () => {
  await withFilesDir(async () => {
    // 读通道整体缺席 ⇒ 三项都读不到。
    const blind = faceFor({ window_animation_scale: '0', transition_animation_scale: '0', animator_duration_scale: '0' }, { unreadable: true })
    const a = await runPrepare(blind, { animations: true })
    assert.equal(a.ok, false, '读不到时不得报成功')
    assert.match(String(a.text), /读不回/, '读不到必须说「读不回」（通道问题）')

    // 通道在、但写入没生效 ⇒ 三项仍是 1。
    const stuck = faceFor({ window_animation_scale: '1', transition_animation_scale: '1', animator_duration_scale: '1' })
    // 让写入变成空操作，模拟「写了但没生效」。
    stuck.writeAnimationScales = async () => ({ ok: true, stdout: '' })
    const b = await runPrepare(stuck, { animations: true })
    assert.equal(b.ok, false, '写入没生效时不得报成功')
    assert.match(String(b.text), /未生效/, '写进去但读回不对必须说「未生效」（写入问题）')
    assert.doesNotMatch(String(b.text), /读不回/, '未生效不得说成读不回')
  })
})

test('恢复分支：准备前读到 0.5 / 10 时必须写回原值，不是常量 1', async () => {
  await withFilesDir(async () => {
    const original = { window_animation_scale: '0.5', transition_animation_scale: '10', animator_duration_scale: '0.5' }
    const face = faceFor(original)
    // 先关（记下原值），再恢复。
    const off = await runPrepare(face, { animations: true })
    assert.equal(off.ok, true, '关闭必须成功：' + String(off.text))
    assert.deepEqual(
      scalesOf(face),
      { window_animation_scale: 0, transition_animation_scale: 0, animator_duration_scale: 0 },
      '关闭必须真的写 0',
    )
    const on = await runPrepare(face, { animations: true, restore: true })
    assert.equal(on.ok, true, '恢复必须成功：' + String(on.text))
    // 核心判据：用户自设的 0.5 / 10 必须回来（旧实现一律写 1）。
    assert.deepEqual(scalesOf(face), {
      window_animation_scale: 0.5,
      transition_animation_scale: 10,
      animator_duration_scale: 0.5,
    }, '恢复必须写回准备前的原值，而不是常量 1')
    assert.match(String(on.text), /已恢复原值/, '回执必须说恢复的是原值')
  })
})

test('恢复分支：没有原值记录时写回 1，且回执点名「原值未记录」', async () => {
  await withFilesDir(async () => {
    // 直接从 0（上次会话关掉的状态）恢复：本进程没有记录。
    const face = faceFor({ window_animation_scale: '0', transition_animation_scale: '0', animator_duration_scale: '0' })
    const r = await runPrepare(face, { animations: true, restore: true })
    assert.equal(r.ok, true, '写回默认 1 是成功路径（不是失败）：' + String(r.text))
    assert.deepEqual(
      scalesOf(face),
      { window_animation_scale: 1, transition_animation_scale: 1, animator_duration_scale: 1 },
      '没有记录时退回默认 1',
    )
    // 但必须**点名**：不点名就等于宣称「还原到了你原来的设置」，而实际是默认值。
    assert.match(String(r.text), /原值未记录/, '原值未知必须点名，不能装作已还原用户设置')
  })
})

test('恢复分支：回读 1.0 形态的目标值必须算成功', async () => {
  await withFilesDir(async () => {
    const face = faceFor({ window_animation_scale: '1', transition_animation_scale: '1', animator_duration_scale: '1' })
    const r = await runPrepare(face, { animations: true, restore: true })
    assert.equal(r.ok, true, '目标 1 读回 1.0 必须成功：' + String(r.text))
  })
})
