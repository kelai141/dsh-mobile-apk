// vd-shot.test.mjs — 虚拟屏 SF token 反查的纯函数回归（0.14.1 块G F6）。
//
// 夹具取自**设备真实输出**（MuMu x86_64 模拟器 / Android 15 / API 35），不是手写想象形态：
//   adb shell "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'"
// 反向对照（改前必红）：本文件对「token 反查」的断言在当前 HEAD 上是**缺席的**
// （resolveVirtualDisplayToken 不存在），故新用例必然先红后绿。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVirtualDisplayTokens,
  resolveVirtualDisplayToken,
  vdTokenMissingText,
} from '../lib/vd-shot.js'

// 设备实测夹具 1：物理屏 + 一块 DSH 虚拟屏（displayId=3，1200x675 缩放后 675x1200）。
const REAL_DUMP_A = [
  '    name="mumuscreen000"',
  'Virtual Display 11529215046816944610',
  '    name="DSH virtual-1"',
].join('\n')

// 设备实测夹具 2：另一世代（displayId=2 那次），token 不同——证明 token 随世代变化，
// 因此**绝不能缓存 token**，必须每次反查。
const REAL_DUMP_B = [
  '    name="mumuscreen000"',
  'Virtual Display 11529215049621561620',
  '    name="DSH virtual-1"',
].join('\n')

test('解析出 DSH 虚拟屏的 alias -> SF token（设备实测形态）', () => {
  const entries = parseVirtualDisplayTokens(REAL_DUMP_A)
  assert.equal(entries.length, 1, '只应产出 DSH 自己的虚拟屏，物理屏不得入表')
  assert.equal(entries[0].alias, 'virtual-1')
  assert.equal(entries[0].token, '11529215046816944610')
})

test('token 全程按字符串保留：超出 2^53 与 2^63-1 都不得被转成数', () => {
  const token = parseVirtualDisplayTokens(REAL_DUMP_A)[0].token
  assert.equal(typeof token, 'string', 'token 必须是字符串（数值化会丢精度）')
  assert.equal(token, '11529215046816944610')
  // 这是本项的核心陷阱：Number() 会把它变成 ...944000（末位失真），于是与真实 token 不等。
  assert.notEqual(String(Number(token)), token, 'Number(token) 必须与原串不同（精度丢失的证据）')
  assert.ok(BigInt(token) > 9007199254740991n, 'token 超出 JS 安全整数范围')
  assert.ok(BigInt(token) > 9223372036854775807n, 'token 也超出 Kotlin Long 上界，故必须走字符串')
})

test('反查按 alias 命中；token 随世代变化（不得缓存）', () => {
  assert.equal(resolveVirtualDisplayToken(REAL_DUMP_A, 'virtual-1'), '11529215046816944610')
  assert.equal(resolveVirtualDisplayToken(REAL_DUMP_B, 'virtual-1'), '11529215049621561620')
  assert.notEqual(
    resolveVirtualDisplayToken(REAL_DUMP_A, 'virtual-1'),
    resolveVirtualDisplayToken(REAL_DUMP_B, 'virtual-1'),
    '同 alias 在不同世代 token 不同 ⇒ 每次都必须重新反查',
  )
})

test('fail-closed：查不到一律 null，绝不猜、绝不回落', () => {
  assert.equal(resolveVirtualDisplayToken(REAL_DUMP_A, 'virtual-2'), null, '未注册的 alias')
  assert.equal(resolveVirtualDisplayToken(REAL_DUMP_A, ''), null, '空 alias')
  assert.equal(resolveVirtualDisplayToken(REAL_DUMP_A, undefined), null, 'undefined alias')
  assert.equal(resolveVirtualDisplayToken('', 'virtual-1'), null, '空 dump')
  assert.equal(resolveVirtualDisplayToken('no virtual display here', 'virtual-1'), null, '无虚拟屏')
  // 只有物理屏时不得产出任何条目（物理屏永不是合法目标）。
  assert.equal(parseVirtualDisplayTokens('    name="mumuscreen000"').length, 0)
  assert.equal(
    resolveVirtualDisplayToken('Virtual Display 4619827820427265280\n    name="mumuscreen000"', 'mumuscreen000'),
    null,
    '物理屏不得被反查到（name 前缀不是 DSH ）',
  )
})

test('name 与 token 必须成对，错配即不得产出', () => {
  // 若某个 name 先于任何 Virtual Display 出现（物理屏那行），不得被错配给后面的 token。
  const misordered = [
    'Virtual Display 11111111111111111111',
    '    name="DSH virtual-9"',
    'Virtual Display 22222222222222222222',
    '    name="mumuscreen000"',
  ].join('\n')
  const entries = parseVirtualDisplayTokens(misordered)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].alias, 'virtual-9')
  assert.equal(entries[0].token, '11111111111111111111', 'token 必须与其名紧跟配对，不得串到下一个')
})

test('反查失败的文案必须点名 alias 且声明不回落', () => {
  const text = vdTokenMissingText('virtual-1')
  assert.match(text, /virtual-1/, '必须点名是哪个 alias')
  assert.match(text, /SF token/, '必须说清是 SF token 解析不到')
  assert.match(text, /不会.*回落/, '必须声明不回落（防后人误加 displayId/真实屏回落）')
  assert.match(text, /真实屏/, '必须点名「回落真实屏」这一被禁止的旧缺陷')
})
