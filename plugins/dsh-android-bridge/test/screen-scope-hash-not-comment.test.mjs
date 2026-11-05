// issue #1572：`#` 只有在**词首**才是注释起点。引号/命令替换结束后词已经开始，
// 那里的 `#` 是词内字面量 —— 词法器不得把它到行尾整段当注释吃掉。
//
// 缺陷形态：四处 `continue`（单引号、双引号、反引号、`$(`）都不清 `atWordStart`，
// 于是 `echo ''#; screencap -p /sdcard/real.png` 里的 `screencap` 不进 segments，
// 屏幕范围判据看不见它 ⇒ 真实屏命令被放行。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitCommandSegments } from '../lib/screen-scope.js'

const segmentsOf = (cmd) => splitCommandSegments(cmd).segments.join(' || ')

test('引号/替换后的 # 不是注释：真实屏命令必须可见', () => {
  const bypasses = [
    'echo $(true)#; screencap -p /sdcard/real.png',
    'echo `true`#; screencap -p /sdcard/real.png',
    "echo ''#; screencap -p /sdcard/real.png",
    'echo ""#; screencap -p /sdcard/real.png',
  ]
  for (const cmd of bypasses) {
    assert.ok(
      segmentsOf(cmd).includes('screencap'),
      '后半行的 screencap 必须出现在命令段里（否则真实屏命令被当注释吞掉）：' + cmd + ' -> ' + segmentsOf(cmd),
    )
  }
})

test('真正的注释仍被剥掉：词首 # 之后的内容不算命令', () => {
  // 这条是防过度修正：把 `atWordStart=false` 加过头、连词首注释也留着，会让 `#` 后面任意文本被当命令
  const cmd = 'echo hi #; screencap -p /sdcard/real.png'
  assert.ok(!segmentsOf(cmd).includes('screencap'), '词首 # 之后必须是注释，不得进 segments：' + segmentsOf(cmd))
})

test('input tap 同样不能被绕过（不只是读屏命令）', () => {
  const cmd = "echo ''#; input tap 100 200"
  assert.ok(segmentsOf(cmd).includes('input tap'), '写操作同样必须可见：' + segmentsOf(cmd))
})