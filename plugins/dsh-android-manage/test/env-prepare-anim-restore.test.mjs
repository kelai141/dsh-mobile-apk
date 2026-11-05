// env_prepare 的「恢复动画」分支必须有回读（issue #1372）。
//
// 缺陷形态：关闭分支有 `readAnimScales()` 回读与 `notDone`，恢复分支却直接 push「已恢复默认（1）」
// ——写失败被 `restoreAnimScales` 内部 catch 吞掉，回执仍是成功（假成功）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

test('恢复分支必须回读并与关闭分支同口径', () => {
  // 取一段窗口即可：内部还有一层 if/else，按 '} else {' 切会切到内层去。
  const start = src.indexOf('if (restore) {')
  const restore = src.slice(start, start + 900)
  assert.ok(restore.includes('await restoreAnimScales({})'), '恢复动作必须仍在')
  assert.ok(restore.includes('await readAnimScales()'), '恢复后必须回读')
  assert.ok(restore.includes("ANIM_KEYS.every((k) => now[k] === '1')"), '判据必须是三项都等于 1')
  assert.ok(restore.includes('notDone.push('), '读回不符必须进 notDone（不得假成功）')
})

test('不得再有「恢复后无条件宣告成功」的写法', () => {
  const bad = "await restoreAnimScales({})\n          lines.push('动画：已恢复默认（1）')"
  assert.ok(!src.includes(bad), 'restoreAnimScales 之后不得直接 push 成功文案')
})
