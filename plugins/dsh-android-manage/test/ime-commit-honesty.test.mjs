// issue #1067：ADBKeyboard 通道在「结果码取不到」时报「已输入」。
//
// 缺陷形态：isCommitAccepted(null) = true，而 null 有两个来源——
//   ① 旧壳只回 result=0（am 的默认返回值）⇒ 判接受是**合理兼容**；
//   ② 输出被截断 / 部分 ROM 不打印那行 ⇒ 也返回 null ⇒ 同样判接受。
// 而返回文案在 readBack === null 且 resultCode 不是 committed 时是**空串**，于是一条
// 无法证实的结果被渲染成「已输入 xxx（ADBKeyboard）」——正是该文件 -n 那次修复要消灭的
// 「链路全绿、文本不动」形态。
//
// 边界：a11y 开着时有回读断言兜底（不一致会重试，仍不一致则判红），所以本条只在 a11y-off 生效。
// 判据分两层：
//   ① 纯函数层（可穷举）——isCommitAccepted 必须能区分「有权威证据」与「无权威证据」；
//   ② 文案层——无权威证据时返回文案必须带**明确的未证实限定**，不得裸报「已输入」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(HERE, '..', 'lib', 'index.js')).href)
const ime = await import(pathToFileURL(join(HERE, '..', 'lib', 'ime-broadcast.js')).href)

test('#1067 纯函数层：无权威证据（null）必须有独立于「已提交」的判定口径', () => {
  const { isCommitAccepted, KB_RESULT } = ime
  // 有权威证据：壳侧明确回 committed ⇒ 接受。
  assert.equal(isCommitAccepted(KB_RESULT.committed), true, 'committed 必须接受')
  // 旧壳兼容：am 默认 result=0。
  assert.equal(isCommitAccepted(0), true, '0（旧壳默认返回值）必须继续兼容接受')
  // 明确失败码必须拒（KB_RESULT: committed=1 / imeNotReady=2 / rejected=3 / badRequest=4 / noConnection=5）。
  for (const bad of [KB_RESULT.imeNotReady, KB_RESULT.rejected, KB_RESULT.badRequest, KB_RESULT.noConnection]) {
    assert.equal(isCommitAccepted(bad), false, '结果码 ' + bad + ' 是明确失败，必须拒')
  }
  // 无权威证据：null。兼容口径允许接受，但**必须**存在一个能把它与「已提交」区分开的判定，
  // 否则返回文案永远无法如实说明。
  assert.equal(typeof ime.hasAuthoritativeCommit, 'function',
    '必须提供 hasAuthoritativeCommit(code)：区分「有权威结果码证据」与「只是兼容性放行」')
  assert.equal(ime.hasAuthoritativeCommit(KB_RESULT.committed), true, 'committed 是权威证据')
  assert.equal(ime.hasAuthoritativeCommit(null), false, 'null 不是权威证据（取不到 ≠ 已提交）')
  assert.equal(ime.hasAuthoritativeCommit(0), false, '0 是旧壳默认值，不是权威证据')
})

test('#1067 文案层：无回读 + 无权威结果码时不得裸报「已输入」', () => {
  // 直接驱动工具，让广播回执「取不到结果码」，且 a11y 关闭（readBack 恒 null）。
  const tools = []
  const face = {
    gateFor: () => ({ ok: true }),
    audit: () => {},
    controlDecision: () => ({ backend: 'adb', reason: 'test-adb' }),
    a11yEnabled: () => false,
    controlExec: async (op) => {
      // 广播：回执里**没有** Broadcast completed 行（截断 / ROM 不打印）。
      if (op === 'shExec') return { ok: true, data: { ok: true, stdout: '', exitCode: 0 } }
      // a11y 关闭：nodeText 读不到聚焦框 ⇒ 回读为 null（真实形态，不是空串）。
      if (op === 'nodeText') return { ok: false, error: 'a11y unavailable' }
      return { ok: true, data: { ok: true } }
    },
    execAdbShell: async () => ({ ok: true, stdout: '' }),
    execAdbLine: async () => ({ ok: true, stdout: '' }),
  }
  mod.apply({
    logger: () => ({ warn: () => {}, debug: () => {} }),
    tools: { register: (t) => tools.push(t) },
    get: () => undefined,
    androidPrivilege: face,
  })
  const input = tools.find((t) => t.name === 'android_ui_input')
  assert.ok(input, 'android_ui_input 必须注册')
  return input.execute({ text: 'hello', channel: 'adbkeyboard' }, {}).then((r) => {
    const text = String(r.text ?? '')
    // 允许 ok:true（旧壳兼容），但**文案必须带未证实限定**。
    assert.match(text, /未证实|无法确认|未确认|取不到结果码/,
      '无回读且无权威结果码时，返回文案必须明确标注「未证实」，不得裸报「已输入」；实际：' + text)
  })
})
