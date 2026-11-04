// 输入法 id 的形态与等值判据（issue #1371 / #1520）。
//
// 现场（#1371）：ADBKeyboard 通道借道 IME 注入文本，结束后要 `ime set <用户原输入法>` 还回去。
//  ① 旧实现把设备回读值直接拼进 shell 命令（转义问题）；
//  ② 不校验形态：`settings get secure default_input_method` 在未显式赋值时打印字面 `null`，
//     于是还原命令变成 `ime set null`，失败又被 catch 吞掉 ⇒ 用户输入法永久停在 DSH 键盘。
// 现场（#1520）：自身排除用严格字符串等值，ROM 打印 `pkg/pkg.Class` 全形态时 DSH 自己成了
// 还原目标——回执写「已还原」，实际把用户留在 DSH 键盘上。
//
// 本文件只放**纯函数**判据；`ime set` 的 shell 转义与整段接线由行为判据守
// （ime-borrow-window.test.mjs：还原命令必须是 sleep 0.4; ime set '<prev>'）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImeId, restorableImeId, resolveImeRestoreTarget } from '../lib/ime-broadcast.js'

const SELF = 'com.dsharnessmobile.shell/.AdbKeyboardService'
const SELF_FULL = 'com.dsharnessmobile.shell/com.dsharnessmobile.shell.AdbKeyboardService'

test('回读值必须过「可还原形态」判据：null / 空 / 非组件一律拒', () => {
  assert.equal(restorableImeId('null'), false, '必须显式拦掉字面 null')
  assert.equal(restorableImeId('NULL'), false, '大小写不敏感')
  assert.equal(restorableImeId('"null"'), false, '带引号的 null 同样要拦')
  assert.equal(restorableImeId(''), false)
  assert.equal(restorableImeId('com.example'), false, '没有 / 不是组件名')
})

test('#1520 等值比较必须归一化：全形态与短形态是同一个输入法', () => {
  assert.equal(normalizeImeId(SELF_FULL), normalizeImeId(SELF))
  assert.notEqual(normalizeImeId('com.other/com.other.AdbKeyboardService'), normalizeImeId(SELF))
})

test('#1520 读回值＝本通道（任一种形态）时不得把自己当还原目标', () => {
  for (const raw of [SELF, SELF_FULL]) {
    const r = resolveImeRestoreTarget(raw, 'com.user/.Mine\n', SELF)
    assert.deepEqual(r, { id: 'com.user/.Mine', source: 'fallback' },
      '读回值是本通道时必须退到列表里的另一个输入法（而不是把自己当目标）：' + raw)
  }
})
