// 输入法还原的守卫与转义（issue #1371）。
//
// 现场：ADBKeyboard 通道借道 IME 注入文本，结束后要 `ime set <用户原输入法>` 还回去。旧实现
//   ① 把设备回读值直接拼进 shell 命令（同模块已导出 shellQuote 却没用）；
//   ② 不校验形态：`settings get secure default_input_method` 在未显式赋值时打印字面 `null`，
//      于是还原命令变成 `ime set null`，失败又被 catch 吞掉 ⇒ 用户输入法永久停在 DSH 键盘。
//
// 判据落在「源码里那两行」上：还原必须转义、读取必须过形态判据。本文件读 src/index.ts 文本，
// 不依赖构建产物（lib/ 在 CI 才生成）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const broadcast = readFileSync(new URL('../src/ime-broadcast.ts', import.meta.url), 'utf8')

test('还原命令必须对回读值做 shell 转义', () => {
  assert.ok(src.includes('ime set ${shellQuote(prev)}'), '还原必须用 shellQuote 包裹 prev')
  assert.ok(!src.includes('ime set ${prev}`'), '不得再出现裸拼接的 ime set ${prev}')
})

test('回读值必须过「可还原形态」判据', () => {
  assert.ok(broadcast.includes('export function restorableImeId(raw: string): boolean'), '判据函数必须存在（已下沉到 ime-broadcast 以便单测）')
  assert.ok(src.includes('resolveImeRestoreTarget(rawPrev'), '读取处必须经判据过滤')
  assert.ok(broadcast.includes("v.toLowerCase() === 'null'"), '必须显式拦掉字面 null')
})

// 判据模型那段原来是一份**手抄的同构实现**（测的是抄件，不是真函数）。现已改为
// `ime-restore-fallback.test.mjs` 直接 import 构建产物 `../lib/ime-broadcast.js` 的真函数。
