// issue #864：控制台 IME 遮挡量的**单位**判据（不靠肉眼，靠算术）。
//
// 真机现场（V2425A / Android 16 / 1260x2800 @560dpi -> dpr 3.5，CSS 视口 360x800）：
//   IME 区域高 **1105 设备像素**，被当成 CSS px 直接用，于是
//     height: calc(100% - var(--ime-occlusion))  ->  800 - 1105 < 0  -> 高度塔成 0
//     compact 判据 innerHeight - max(bottom, ime) -> 800 - 1105 < 0  -> 误判 compact
// 结论不是「多减一个导航栏」（那只差 18 CSS px），而是单位错配。
//
// 本文件从 `console.html` 里抽出纯函数 `consoleImeCssPx` 求值 —— 页面没有模块系统，
// 抽取是为了让这三条判据**在 CI 里可回归**，而不是只靠一次真机目测。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../app/src/main/assets/console.html', import.meta.url), 'utf8')

/** 从 HTML 里按大括号配对抽出 `function consoleImeCssPx(...) { ... }` 的源码。 */
function extractFunction(name) {
  const start = SOURCE.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('console.html 里找不到 ' + name)
  let depth = 0
  let i = SOURCE.indexOf('{', start)
  const from = i
  for (; i < SOURCE.length; i += 1) {
    const c = SOURCE[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return SOURCE.slice(start, i + 1)
    }
  }
  throw new Error('未闭合: ' + name + '（from ' + from + '）')
}

const sandbox = vm.createContext({})
vm.runInContext(extractFunction('consoleImeCssPx'), sandbox)
const imeCssPx = sandbox.consoleImeCssPx

const DPR = 3.5
const INNER_H = 800

test('① IME=1105 设备像素必须换成 315.7 CSS px，而不是原样 1105', () => {
  // visualViewport 不可用 -> 走 /dpr 兜底
  const v = imeCssPx(INNER_H, 0, DPR, 1105)
  assert.ok(Math.abs(v - 1105 / DPR) < 0.01, 'expected 315.7 got ' + v)
  assert.ok(v > 300 && v < 320, 'must be in the 315.7 band, got ' + v)
  assert.notEqual(v, 1105, '绝不允许把设备像素当 CSS px 传下去')
})

test('①b visualViewport 路径同样得到 CSS px（不依赖 dpr）', () => {
  // 真机：innerHeight 800，IME 弹起后 visualViewport.height ≈ 800 - 315.71
  const vvHeight = INNER_H - 1105 / DPR
  const v = imeCssPx(INNER_H, vvHeight, DPR, 1105)
  assert.ok(Math.abs(v - 1105 / DPR) < 0.01, 'expected 315.7 got ' + v)
  // 即使 dpr 传错（0），visualViewport 路径也不受影响 —— 这正是它优先的原因
  const v2 = imeCssPx(INNER_H, vvHeight, 0, 1105)
  assert.ok(Math.abs(v2 - 1105 / DPR) < 0.01, 'visualViewport 路径不应依赖 dpr，got ' + v2)
})

test('② innerHeight - imeCss > 0 时不得进入 compact', () => {
  const imeCss = imeCssPx(INNER_H, 0, DPR, 1105)
  const remaining = INNER_H - Math.max(0, imeCss)
  assert.ok(remaining > 0, '剩余高度必须为正，实际 ' + remaining)
  // 页面里的 compact 判据：剩余 < 320 才算 compact
  assert.equal(remaining < 320, false, '剩余 ' + remaining + ' 不应判 compact')
  // 反证：若错把设备像素当 CSS px，剩余为负 -> 会判 compact（这正是真机现场）
  const wrongRemaining = INNER_H - Math.max(0, 1105)
  assert.ok(wrongRemaining < 0, '用错单位时剩余高度应为负（复现真机误判）')
  assert.equal(wrongRemaining < 320, true, '用错单位时必然误判 compact')
})

test('③ 回归：IME=0 时行为不变（遮挡量 0、不触发 compact）', () => {
  assert.equal(imeCssPx(INNER_H, 0, DPR, 0), 0)
  assert.equal(imeCssPx(INNER_H, INNER_H, DPR, 0), 0, 'visualViewport 等于 innerHeight 时也为 0')
  const remaining = INNER_H - Math.max(0, 0)
  assert.equal(remaining < 320, false, '800 的视口不应判 compact')
})

test('④ 已经是 CSS px 的输入不得被二次除以 dpr', () => {
  // 调用方若已换算好（315.7），且它没超过视口高度 -> 原样返回
  const v = imeCssPx(INNER_H, 0, DPR, 1105 / DPR)
  assert.ok(Math.abs(v - 1105 / DPR) < 0.01, 'expected 315.7 got ' + v)
})
test('②b 页面里的 compact 判据必须用换算后的 imeCss（源码级，防回退）', () => {
  // 注意：CSS 里也有 `:root[data-console-compact]` 选择器，必须只取**设置属性**的那一行。
  const line = SOURCE.split('\n').find((l) => l.includes('toggleAttribute') && l.includes('data-console-compact'))
  assert.ok(line, 'console.html 里找不到 compact 判据行')
  assert.match(line, /Math\.max\(consoleBottomInset,\s*imeCss\)/, 'compact 判据必须用 imeCss（CSS px），实际: ' + line.trim())
  assert.doesNotMatch(line, /consoleImeOverlap/, 'compact 判据不得直接用未换算的遮挡量（真机误判的根因），实际: ' + line.trim())
})

test('②c --ime-occlusion 必须写换算后的值（源码级）', () => {
  const line = SOURCE.split('\n').find((l) => l.includes("setProperty('--ime-occlusion'"))
  assert.ok(line, '找不到 --ime-occlusion 设置行')
  assert.match(line, /imeCss/, '--ime-occlusion 必须用换算后的 CSS px，实际: ' + line.trim())
  assert.doesNotMatch(line, /consoleImeOverlap/, '不得直接把原始遮挡量写进 CSS 变量')
})
