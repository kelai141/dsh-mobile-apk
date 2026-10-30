import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  realScreenAdbCommandDenied,
  screenCommandFamilies,
  screenCommandVerdict,
} from '../lib/screen-scope.js'

// ── issue #1060：屏幕范围门禁的三处 fail-open ────────────────────────────────────
//
// 共同形态：门禁判「目标屏 = 已注册虚拟屏」而**真实 argv 作用在 display 0（真实屏）**。
// 三处都必须 fail-closed：拿不准的形态判 `deny-uncertified-target`，绝不新增放行分支。
//
// 注册表夹具：displayId 7 与一条 SurfaceFlinger token（> 2^53，只能按字符串比）都属于
// **已注册虚拟屏**；`0` 恒为真实屏。每条用例的「真实 argv」写在断言上方的注释里。
const VTOKEN = '11529215046816944610'
const OWNED = {
  virtualDisplayIds: [7],
  virtualAliases: ['virtual-1'],
  sfVirtualDisplays: [{ alias: 'virtual-1', token: VTOKEN }],
}
const isOwned = (raw) => raw === '7' || raw === VTOKEN
const verdict = (command) => screenCommandVerdict(command, isOwned)
const denied = (command) => realScreenAdbCommandDenied('virtual-only', command, OWNED) !== null

// ── F1：引号折叠伪造 `-d` 的值 ────────────────────────────────────────────────
//
// 缺陷形态（`stripQuotedText` 把非首词的引号内容整体替换成**一个空格**）：
//   screencap -d "" 7     真实 argv ["screencap","-d","","7"]        atoi("")==0 ⇒ display 0，7 是输出文件名
//   screencap -d '' 7     同上（单引号空串同样只是**一个空 word**）
//   screencap -d "$X" 7   真实 argv 的 -d 值是一个变量 ⇒ 非数字 ⇒ atoi→0
//   screencap -d \ 7      真实 argv ["screencap","-d"," ","7"]       转义空格是**词内字符**，不是分隔符
// 旧实现把引号段折叠后得到 `screencap -d   7` ⇒ `-d` 的值被误认成 `7` ⇒ 门禁拿「已注册 7」
// 发通行证，命令实际读真实屏。
test('#1060 F1：`-d` 的值位被引号/转义吃掉时，不得拿下一个词当目标屏（必须拒）', () => {
  for (const command of [
    'screencap -d "" 7',
    "screencap -d '' 7",
    'screencap -d "$X" 7',
    'screencap -d \\ 7',
    'screencap -d "" -p /sdcard/a.png',
  ]) {
    assert.equal(verdict(command), 'deny-uncertified-target', command + ' 必须判「目标屏未能认证」')
    assert.equal(denied(command), true, command + ' 在 virtual-only 下必须拒')
  }

  // 正控：`-d` 的值位就是那个数字词 ⇒ 必须仍放行（不得把正常用法一起拦掉）。
  for (const command of [
    'screencap -d 7',
    `screencap -d ${VTOKEN}`,
    'screencap -d 7 -p /sdcard/a.png',
    'screencap -p -d 7 /sdcard/a.png',
    'input -d 7 tap 100 200',
  ]) {
    assert.equal(denied(command), false, command + ' 是合法形态，必须仍放行')
  }
})

// ── F2：只有 `input` 设了 getopt 边界 ─────────────────────────────────────────
//
// toybox getopt 在**第一个非选项词**处停止解析（`--` 同为选项终结符），之后的 `-d` 只是普通
// argv，工具根本不会读它 ⇒ 目标屏退回默认 display 0：
//   screencap -p /sdcard/a.png -d 7  真实 argv […,"-p","/sdcard/a.png","-d","7"] ⇒ -d 未被解析
//   screencap -- -d 7                `--` 之后全是操作数 ⇒ -d 未被解析
//   screencap -p 7 -d 7              `-p` 不吃参数 ⇒ 7 是第一个非选项词 ⇒ 之后不再解析
// 旧实现只给 `input` 算了边界（`family.name === 'input' ? inputCommandIndex(…) : bare.length`），
// screencap/screenrecord 做全段扫描 ⇒ 尾随 `-d <已注册>` 反而成了「已认证」的通行证。
test('#1060 F2：`-d` 落在 getopt 停止解析之后时不算凭据（必须拒）', () => {
  for (const command of [
    'screencap -p /sdcard/a.png -d 7',
    'screencap -- -d 7',
    'screencap -p 7 -d 7',
    `screencap -p /sdcard/a.png -d ${VTOKEN}`,
    'screencap -p "" -d 7',
    // 引号包住的路径词同样是一个位置词 ⇒ getopt 在它那里就停了。
    'screencap -p "/sdcard/a b.png" -d 7',
    // 多目标必须逐个命中：`-d` **自己的取值词**不得被当成位置词，否则第二个 `-d 99` 会被静默丢掉。
    'screencap -d 7 -d 99 -p /sdcard/a.png',
  ]) {
    assert.equal(verdict(command), 'deny-uncertified-target', command + ' 必须判「目标屏未能认证」')
    assert.equal(denied(command), true, command + ' 在 virtual-only 下必须拒')
  }

  // 正控：`-d` 在选项区（第一个非选项词之前）⇒ 必须仍放行。
  for (const command of [
    'screencap -d 7',
    'screencap -d 7 -p /sdcard/a.png',
    'screencap -p -d 7 /sdcard/a.png',
    'screencap -d7 -p /sdcard/a.png',
    'screenrecord -d 7 /sdcard/a.mp4',
    // 本门禁也判 `adb shell …` 包装形态：命令词不在段首，边界必须从命令词之后才开始数。
    'adb shell screencap -p -d 7 /data/local/tmp/a.png',
  ]) {
    assert.equal(denied(command), false, command + ' 是合法形态，必须仍放行')
  }
})

// ── F3：`dumpsys -t 10 window` 绕过命令词正则 ─────────────────────────────────
//
// AOSP `dumpsys.cpp`：`getopt_long(argc, argv, "+t:l", …)` —— `-t <秒>` 是全局超时旗标，
// 服务名**永不紧贴** `dumpsys`：
//   dumpsys -t 10 window       真实 argv ["dumpsys","-t","10","window"]        输出含真实屏 View 层级
//   dumpsys -t 10 activity top 真实 argv […,"activity","top"]                  完整 View Hierarchy
//   dumpsys\t-t\t10\twindow      同上（tab 与空格同为 ASCII 空白）
// 旧 pattern 要求 `window|display|input|activity` **紧跟**命令名 ⇒ 三条全部 families=[] ⇒ allow。
test('#1060 F3：`dumpsys` 的全局旗标把服务名推离命令名，不得因此漏拦（必须拒）', () => {
  for (const command of [
    'dumpsys -t 10 window',
    'dumpsys -t 10 activity top',
    'dumpsys\t-t\t10\twindow',
    'dumpsys -t 10 display',
    // 裸 `dumpsys`（以及只带旗标）会 dump **全部**服务，里面就有 window ⇒ 同样不可放行。
    'dumpsys',
    'dumpsys -t 10',
  ]) {
    assert.notDeepEqual(screenCommandFamilies(command), [], command + ' 必须命中屏幕命令词面')
    assert.equal(denied(command), true, command + ' 在 virtual-only 下必须拒')
  }

  // 正控：与屏无关的服务必须仍放行（不得把整个 `dumpsys` 都拒掉）。
  for (const command of [
    'dumpsys meminfo',
    'dumpsys battery',
    'dumpsys SurfaceFlinger',
    "dumpsys SurfaceFlinger | grep -E '^(Virtual Display |    name=)'",
  ]) {
    assert.deepEqual(screenCommandFamilies(command), [], command + ' 不得命中屏幕命令词面')
    assert.equal(denied(command), false, command + ' 与屏无关，必须仍放行')
  }
})

// ── 反证：修 F1/F2/F3 不得顺手开出新的放行通道 ────────────────────────────────
//
// F1 改了「目标屏参数的取值口」，最容易的副作用就是让**非屏幕命令**携带的折叠形态参数不再被
// 认出来。`echo -d "" 7` 折叠后就是 `-d 7`，历史判据按「洗白凭据」拒（deny-orphan-target-token）；
// 这条拒必须保留 —— 少一条拒就是多一条放行通道。
test('#1060 反证：修法不得把既有的拒改成放行（非屏幕命令的折叠目标屏参数仍按洗白凭据拒）', () => {
  assert.equal(verdict('echo -d "" 7'), 'deny-orphan-target-token')
  assert.equal(denied('echo -d "" 7'), true)
  // 对照：不携带目标屏参数的普通 echo 必须放行（不得退化成「凡 echo 就拒」）。
  assert.equal(verdict('echo hi'), 'allow')
  assert.equal(denied('echo hi'), false)
  // `curl -d <数据>` 是长选项之外的常见写法，双引号形态不得回归成误拦。
  for (const command of ['curl -d value https://example.test', 'curl -d "a=b" https://example.test']) {
    assert.equal(denied(command), false, command + ' 与屏无关，必须仍放行')
  }
})

// 三处共用的收口断言：拒绝文案必须如实指向「目标屏未能核对」，且点名当前范围。
test('#1060：三处拒绝都走 deny-uncertified-target 的文案（不是「不允许访问 real」假门禁）', () => {
  for (const command of [
    'screencap -d "" 7',
    'screencap -p /sdcard/a.png -d 7',
    'dumpsys -t 10 window',
  ]) {
    const text = realScreenAdbCommandDenied('virtual-only', command, OWNED)
    assert.equal(typeof text, 'string', command)
    assert.match(String(text), /virtual-only/, command + ' 必须点名当前范围')
    assert.match(String(text), /未能与壳侧注册表核对上/, command + ' 必须如实说明拒因')
  }
})
