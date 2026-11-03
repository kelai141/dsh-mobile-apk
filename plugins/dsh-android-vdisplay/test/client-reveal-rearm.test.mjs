// 虚拟屏自动展示的**门能否重新武装**（issue #1339）。
//
// 缺陷形态：`4ec796a0` 给自动展示加了可见性门，但 `pending` 只在被它挡住的那个函数
// 内部写入 —— 门在 `pending === false` 时关闭，而唯一能把它置真的路径又被这道门挡住。
// 加上 `seenActive` 在折叠期间从不重置，一旦「页签被关 + 侧栏折叠 + 屏重建」组合出现，
// 自动展示再也不会发生：屏在跑、模型照常 vdInput/vdLaunch，用户看不到任何东西。
//
// 为什么是源码契约而不是行为测试：本文件是浏览器端 bundle 入口，依赖 document /
// sidebar / 跨桥 decodeNative，离线跑不起真实运行时（既有 client-polling-*.test.mjs
// 同此口径）。运行时行为另需 CDP 层验收，判据见本目录 README 与 PR 描述。
//
// ## 判据（每条都能被负控打红）
//   1. 落位状态锚定到**具体那块屏**（displayId），不是一个布尔；
//   2. 「收起」分支只攒待落位、**不**标记已落位（标了就等于展开后不再落）；
//   3. 屏消失时两个标记一起清（下一次激活是全新的落位机会）；
//   4. 闸门读的是能被 reveal() 之外看见的待落位（否则门自锁）；
//   5. 用户手动关掉页签时（同一块屏、已落位过）不再每拍拽回来。
import { readFileSync } from "node:fs"
import { test } from "node:test"
import assert from "node:assert/strict"

const SRC = new URL("../src/client/index.ts", import.meta.url)
const source = readFileSync(SRC, "utf8")

/** 精确切出 reveal() 的函数体：全文正则会在负控时命中定义处之外的内容，那是假绿。 */
function revealBlock() {
  const start = source.indexOf("const reveal = () => {")
  assert.ok(start > 0, "找不到 reveal 定义")
  // 以紧随其后的 `reveal()` 调用作为收尾锚点
  const end = source.indexOf("reveal()", start + 10)
  assert.ok(end > start, "找不到 reveal 的收尾")
  return source.slice(start, end)
}

/** 切出 800ms 自动露出定时器的回调体。 */
function autoRevealTimerBlock() {
  const end = source.indexOf("}, 800)")
  assert.ok(end > 0, "找不到 800ms 定时器收尾")
  const idx = source.lastIndexOf("timer = window.setTimeout(() => {", end)
  assert.ok(idx > 0 && idx < end, "找不到 800ms 定时器开头")
  return source.slice(idx, end)
}

test("#1339 落位状态锚定 displayId，不再是单个布尔 seenActive", () => {
  const block = revealBlock()
  assert.doesNotMatch(block, /seenActive/, "reveal() 里仍在用布尔 seenActive（屏重建后无法重新武装）")
  assert.match(block, /const displayId = status\.displayId/, "必须以 displayId 作为「这块屏」的身份")
  assert.match(block, /placedFor/, "缺少「已落位过的 displayId」状态")
  assert.match(block, /pendingFor/, "缺少「收起期间攒下的 displayId」状态")
})

test("#1339 收起分支只攒待落位，不得标记已落位", () => {
  const block = revealBlock()
  // 取「收起」那个 if 分支体
  const i = block.indexOf("if (collapsedNow()) {")
  assert.ok(i > 0, "找不到收起分支")
  const body = block.slice(i, block.indexOf("}", i) + 1)
  assert.match(body, /pendingFor = displayId/, "收起时必须攒下待落位（否则展开后不会补）")
  assert.doesNotMatch(body, /placedFor = displayId/,
    "收起分支不得标记已落位——标了就等于「展开后不再落」，正是 #1339 的死锁形态")
})

test("#1339 屏消失时两个标记一起清空（下一次激活是全新机会）", () => {
  const block = revealBlock()
  const i = block.indexOf("if (status === undefined || status.state !== 'active') {")
  assert.ok(i > 0, "找不到非 active 分支")
  const body = block.slice(i, block.indexOf("}", i) + 1)
  assert.match(body, /placedFor = undefined/, "屏消失时必须清掉已落位标记")
  assert.match(body, /pendingFor = undefined/, "屏消失时必须清掉待落位标记")
})

test("#1339 闸门读的是可在 reveal() 之外看见的待落位（否则门自锁）", () => {
  const block = autoRevealTimerBlock()
  assert.match(block, /pendingFor !== undefined/,
    "800ms 闸门必须读 pendingFor；读一个只在 reveal() 内翻转的布尔会让门把自己锁死")
  assert.doesNotMatch(block, /\|\| pending\)/, "闸门仍在读旧的 pending 布尔")
})

test("#1339 同一块屏上用户关掉页签后，不再每拍把页签拽回来", () => {
  const block = revealBlock()
  assert.match(block, /if \(placedFor === displayId\) \{/,
    "缺少「这块屏已落位过」的早退分支——删了就会每 800ms 与用户抢页签")
  assert.match(block, /pendingFor = undefined/, "早退分支应清掉待落位")
})
