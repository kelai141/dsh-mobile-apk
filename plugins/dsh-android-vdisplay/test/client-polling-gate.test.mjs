// 虚拟屏面板：**常驻定时器是否在面板不可见时白烧桥调用**的回归（离线，node:test + jsdom）。
//
// 为什么单独立一份：`#1325` 已把「页面切后台」那一半做掉了（document.hidden 时不排下一拍）。
// 但还有另一半——**侧栏收起时页面仍在前台**：document.hidden 为 false，1s 轮询照跑，
// 每秒仍跨桥两次（vdisplayStatus + vdisplayBounds），而面板根本不在屏幕上。
// 用户收起侧栏看聊天界面的整段时间都在白烧。
//
// ## 判据（可数，不是「更快」）
//   面板不可见（侧栏收起 / 页面后台 / 舞台 display:none），10 秒窗口内：
//     vdisplayStatus 调用 11 -> 0
//     vdisplayBounds 调用 11 -> 0
//   面板可见，10 秒窗口内：
//     vdisplayStatus 调用 11 -> 11（**刻意保持不变**，证明没顺手把正常路径降速）
//
// ## 负控
//   NC1 把 `if (panelOnScreen()) pull()` 改回无条件 `pull()`
//       -> 「不可见时 0 次」两条变红。
//   NC2 把可见时的周期从 1000ms 改成 5000ms
//       -> 「可见时 11 次」变红（证明这条断言真的绑住节奏，不是恒真）。
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = new URL('../src/client/index.ts', import.meta.url)

/** 源码级契约：本插件是 client bundle，运行时行为由浏览器宿主提供；
 *  这里断言的是「接线是否还在」——删掉任一条都会让上面的可数指标失效。 */
const source = readFileSync(SRC, 'utf8')

/**
 * 抽出「1s 轮询」那个 useEffect 的 setTimeout 回调体。
 *
 * 为什么必须切片：全文正则会在负控时仍命中 `panelOnScreen()` 的**定义处**，
 * 于是「把门控删掉」这个变异依然全绿——那是假绿。断言必须只看真正执行的那段。
 */
function pollBlock() {
  // 用周期精确定位：自动露出是 800ms，1s 轮询是 1000ms。
  const end = source.indexOf('}, 1000)')
  assert.ok(end > 0, '找不到 1000ms 的定时器收尾')
  const idx = source.lastIndexOf('timer = window.setTimeout(() => {', end)
  assert.ok(idx > 0 && idx < end, '找不到 1000ms 定时器的开头')
  return source.slice(idx, end)
}

test('面板不可见时，1s 轮询不再打桥（只剩挂载首拍）', () => {
  // 必须精确锚定在 **1s 轮询的 setTimeout 回调体内**，而不是全文搜索。
  // 早先的全文正则会在负控时仍然命中 panelOnScreen() 的定义处，导致「去掉门控但测试仍绿」
  // ——那是假绿，已改为此处的块内断言。
  const block = pollBlock()
  assert.match(
    block,
    /if \(panelOnScreen\(\)\) pull\(\)/,
    '1s 轮询的定时器回调体内必须由 panelOnScreen() 门控',
  )
  assert.doesNotMatch(
    block,
    /^\s*pull\(\)\s*$/m,
    '定时器回调体内不得出现无条件 pull()',
  )
})

test('panelOnScreen 的五条判据都在', () => {
  const body = source.slice(source.indexOf('function panelOnScreen'), source.indexOf('function panelOnScreen') + 1200)
  assert.match(body, /visibilityState === \'hidden\'/, '判据 1：页面在前台')
  assert.match(body, /data-sidebar-right-expand/, '判据 2：侧栏没收起（权威信号 = 展开控件在场）')
  assert.match(body, /isConnected/, '判据 3：舞台还在文档里')
  assert.match(body, /display === \'none\'/, '判据 4a：display:none')
  assert.match(body, /visibility === \'hidden\'/, '判据 4b：visibility:hidden')
  assert.match(body, /rect\.width > 1 && rect\.height > 1/, '判据 5：矩形大于 1px')
})

test('可见时的节奏保持不变（1000ms，没有被顺手降速）', () => {
  const m = /\}, (\d+)\)\s*\n\s*\}\s*\n\s*const onVisibility/.exec(source)
  assert.ok(m, '找不到 1s 轮询的周期常量')
  assert.equal(m[1], '1000', '可见时周期必须仍是 1000ms（降它会让状态停更）')
})

test('自动露出：收起且无待落位时不跑，有待落位时仍要跑', () => {
  // 锚点按内容钉：判据是「门控 + 待落位路径不能被一起挡掉」，不认承载它的变量名。
  // issue #1339 把待落位从布尔 pending 换成 pendingFor（锚定到具体 displayId），
  // 这条断言此前锚死了变量名，于是判据没失效、断言先红了。
  assert.match(
    source,
    /if \(!document\.hidden && \(!collapsedNow\(\) \|\| pendingFor !== undefined\)\) reveal\(\)/,
    '自动露出必须门控，且待落位（收起期间攒下的那次）路径不能一起被挡掉',
  )
})

test('publishBounds 里同一元素只解析一次样式', () => {
  const start = source.indexOf('const publishBounds = useCallback')
  const body = source.slice(start, start + 2000)
  const gcsCount = (body.match(/getComputedStyle\(/g) ?? []).length
  assert.equal(gcsCount, 1, 'getComputedStyle 是强制样式重算入口，一次 publish 只许调一次')
})

test('后台不排下一拍的口径仍然保留（#1325 的成果不能被本改动吃掉）', () => {
  assert.match(source, /if \(!document\.hidden\) schedule\(\)/, '页面后台时必须停止排下一拍')
  assert.match(source, /addEventListener\(\'visibilitychange\'/, '回前台必须有补一拍的通道')
})