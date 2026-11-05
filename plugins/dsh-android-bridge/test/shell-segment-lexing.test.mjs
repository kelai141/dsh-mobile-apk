import assert from 'node:assert/strict'
import { test } from 'node:test'
import { translateAdbLine } from '../lib/shell-ops.js'

/**
 * issue #1066：段切分只跟踪引号状态、不跟踪反斜杠 —— 引号内的**字面**分隔符被当成段分隔符，
 * 一条命令被拆成两条设备命令（第二条用户根本没写）。
 *
 * 判据一律走公开入口 `translateAdbLine`：1 段 = 1 step，所以切错的两个方向都能在 steps 上看见：
 * - 多切 = 凭空多出一条设备命令（伪造，危险侧，本 issue 的根因）；
 * - 少切 = 真分隔符被吃掉（把用户写的两条命令并成一条）。
 *
 * 输入用 `String.raw` 写，保证反斜杠是**原样字符**而不是 JS 转义。
 */

/** 取出每条 exec 步的命令文本；本组用例只应产生 exec 步。 */
function execCommands(line) {
  const translated = translateAdbLine(line)
  assert.equal(translated.ok, true, '应可翻译：' + JSON.stringify(line))
  const out = []
  for (const step of translated.steps) {
    assert.equal(step.kind, 'exec', '本组用例只产生 exec 步：' + JSON.stringify(line))
    out.push(step.command)
  }
  return out
}

test('#1066/1 双引号内的字面分号不切段', () => {
  assert.deepEqual(execCommands(String.raw`adb shell echo "a; b"`), ['echo "a; b"'])
  // 根因形态：双引号内的 \" 是字面双引号，不闭合引号段，后面的 ; 仍在引号内
  assert.deepEqual(execCommands(String.raw`adb shell echo "a \"; rm -rf /sdcard/x"`), [
    String.raw`echo "a \"; rm -rf /sdcard/x"`,
  ])
})

test('#1066/2 单引号内的字面分号不切段（POSIX：单引号内无转义）', () => {
  assert.deepEqual(execCommands(String.raw`adb shell echo 'a; rm -rf /sdcard/x'`), [
    String.raw`echo 'a; rm -rf /sdcard/x'`,
  ])
  // 单引号内的反斜杠是普通字符（不转义），所以它不会让紧随的 ' 变成「已转义」而提前闭合
  assert.deepEqual(execCommands(String.raw`adb shell echo 'a\; rm -rf /sdcard/x'`), [
    String.raw`echo 'a\; rm -rf /sdcard/x'`,
  ])
})

test('#1066/3 反证：引号外的分隔符仍然要切', () => {
  assert.deepEqual(execCommands(String.raw`adb shell wm size; adb shell rm -rf /data/local/tmp/x`), [
    'wm size',
    'rm -rf /data/local/tmp/x',
  ])
  assert.deepEqual(execCommands(String.raw`adb shell wm size && adb shell getprop ro.product.model`), [
    'wm size',
    'getprop ro.product.model',
  ])
  // 非 adb 段落同样照切：不能为了修转义把切分整体关掉
  assert.deepEqual(execCommands(String.raw`echo one; echo two && echo three`), ['echo one', 'echo two', 'echo three'])
})

test('#1066/4 转义双引号不结束双引号', () => {
  assert.deepEqual(execCommands(String.raw`adb shell echo "a \" b"`), [String.raw`echo "a \" b"`])
  // 引号外同理：\" 是字面引号，不开启引号段 —— 后面的 ; 是真分隔符（修前这里**少切**）
  assert.deepEqual(execCommands(String.raw`adb shell echo \" ; ls`), [String.raw`echo \"`, 'ls'])
})

test('#1066/5 未闭合引号整行一段（fail-closed，不猜）', () => {
  assert.deepEqual(execCommands(String.raw`adb shell wm size; adb shell echo "a`), [
    String.raw`wm size; adb shell echo "a`,
  ])
  assert.deepEqual(execCommands(String.raw`adb shell wm size; adb shell echo 'a`), [
    String.raw`wm size; adb shell echo 'a`,
  ])
  // 「整行一段」的硬判据：段数必须是 1（多切就会造出第二条设备命令）
  const translated = translateAdbLine(String.raw`adb shell wm size; adb shell echo "a`)
  assert.equal(translated.ok, true)
  assert.equal(translated.steps.length, 1)
})

test('#1066/6 双重转义按奇偶语义', () => {
  // 偶数个反斜杠：\\ 是字面反斜杠，紧随的 " 是真的引号闭合 ⇒ 后面的 ; 是真分隔符
  assert.deepEqual(execCommands(String.raw`adb shell echo "a \\" ; ls`), [
    String.raw`echo "a \\"`,
    'ls',
  ])
  // 奇数个反斜杠：\" 是字面引号，双引号未闭 ⇒ 整行一段（与 /5 同一条 fail-closed）
  assert.deepEqual(execCommands(String.raw`adb shell echo "a \" ; ls`), [
    String.raw`echo "a \" ; ls`,
  ])
})

test('#1066/7 引号外转义的分号不是分隔符', () => {
  assert.deepEqual(execCommands(String.raw`adb shell echo a\;b`), [String.raw`echo a\;b`])
  // 偶数反斜杠：\\ 是字面反斜杠，后面的 ; 没被转义 ⇒ 真分隔符
  assert.deepEqual(execCommands(String.raw`adb shell echo a\\;b`), [String.raw`echo a\\`, 'b'])
})

test('#1066/8 ANSI-C 与本地化引号不猜（整行一段）', () => {
  assert.deepEqual(execCommands(String.raw`adb shell wm size; echo $'a; b'`), [
    String.raw`wm size; echo $'a; b'`,
  ])
  assert.deepEqual(execCommands(String.raw`adb shell wm size; echo $"a; b"`), [
    String.raw`wm size; echo $"a; b"`,
  ])
})

test('#1066/9 行尾孤立反斜杠（续行）不猜（整行一段）', () => {
  // 输入末尾就是一个反斜杠（续行形态），用普通字符串写，避免 raw 模板吃掉末尾反斜杠
  assert.deepEqual(execCommands('adb shell wm size && adb shell echo a\\'), ['wm size && adb shell echo a\\'])
})
