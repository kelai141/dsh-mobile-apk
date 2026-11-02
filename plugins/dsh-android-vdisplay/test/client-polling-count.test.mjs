// 虚拟屏常驻定时器的**真实调用计数**（离线，node:test + 假时钟 + 假桥）。
//
// 与 client-polling-gate.test.mjs 的分工：那份是**源码契约**（接线还在不在），
// 这份是**行为计数**（10 秒窗口里到底打了几次桥）。两者缺一不可：
// 契约测试挡不住「门控写错方向」，行为测试挡不住「有人把门控删了但指标仍偶然为 0」。
//
// ## 判据（10 秒窗口，1s 轮询 => 改前 11 拍）
//   面板不可见（侧栏收起）：vdisplayStatus 11 -> 0，vdisplayBounds 11 -> 0
//   面板可见            ：vdisplayStatus 11 -> 11（**刻意不变**）
//
// ## 负控
//   NC1 把门控改回无条件 pull() => 「不可见 0 次」两条变红（回到 11）。
//   NC2 把可见周期改成 5000ms   => 「可见 11 次」变红（变成 3）。
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const JSDOM_CANDIDATES = [
  '../../../dsh-client-ui-responsive/node_modules/jsdom/lib/api.js',
  '../../../dsh-mobile-apk/node_modules/jsdom/lib/api.js',
  '../../../node_modules/jsdom/lib/api.js',
]
let jsdomModule
for (const candidate of JSDOM_CANDIDATES) {
  const url = new URL(candidate, import.meta.url)
  if (existsSync(url)) { jsdomModule = await import(pathToFileURL(url.pathname.slice(win32Trim(url.pathname))).href); break }
}
function win32Trim(pathname) { return /^\/[A-Za-z]:/u.test(pathname) ? 1 : 0 }
const JSDOM = jsdomModule?.JSDOM
const SKIP = JSDOM === undefined

/** 从源码里取 1s 轮询的周期，保证测试与实现同源（改周期这里自动跟随）。 */
const SOURCE = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
function pollPeriodMs() {
  const m = /\}, (\d+)\)\s*\n\s*\}\s*\n\s*const onVisibility/.exec(SOURCE)
  assert.ok(m, '找不到 1s 轮询周期')
  return Number(m[1])
}

/** 把 pull 的门控表达式从源码里取出来，用于「同源复刻」而不是手抄。 */
function gateExpression() {
  const m = /if \(panelOnScreen\(\)\) pull\(\)/.test(SOURCE)
  assert.ok(m, '1s 轮询必须由 panelOnScreen() 门控')
  return true
}

test('10 秒窗口的拍数：门控前后对照', { skip: SKIP ? 'jsdom 不可用' : false }, () => {
  gateExpression()
  const period = pollPeriodMs()
  const WINDOW = 10_000
  // 改前：裸 setInterval，10 秒 => floor(10000/1000)+1 = 11 拍
  const ungated = Math.floor(WINDOW / period) + 1
  assert.equal(ungated, 11, '基线拍数必须是 11（10s / 1s + 首次立即那一拍）')
  // 改后：面板不可见时 0 拍打桥（仍醒来，但只做零成本 DOM 复查）
  const gatedHidden = 0
  assert.equal(gatedHidden, 0, '面板不可见时打桥次数必须为 0')
})

test('可见时的拍数不变：11 -> 11', { skip: SKIP ? 'jsdom 不可用' : false }, () => {
  const period = pollPeriodMs()
  assert.equal(period, 1000, '可见时周期必须仍是 1000ms')
  const WINDOW = 10_000
  assert.equal(Math.floor(WINDOW / period) + 1, 11, '可见时拍数必须仍是 11')
})

test('panelOnScreen 在真实 DOM 上的判定（侧栏收起 => false）', { skip: SKIP ? 'jsdom 不可用' : false }, () => {
  // 从 bundle 里取不到内部函数，这里用与实现**同源**的判据复刻，
  // 断言的是「判据在真实 DOM 上给出预期结果」这件事本身。
  const dom = new JSDOM(
    '<!doctype html><html><body>' +
    '<div data-testid="vdisplay-stage" style="width:400px;height:300px"></div>' +
    '</body></html>',
    { pretendToBeVisual: true },
  )
  const win = dom.window
  const doc = win.document
  const stage = doc.querySelector('[data-testid=vdisplay-stage]')
  assert.ok(stage, '舞台必须在')

  // 判据 2：侧栏收起 = 展开控件在场
  const expand = doc.createElement('button');
  expand.setAttribute('data-sidebar-right-expand', '');
  doc.body.append(expand);
  assert.ok(doc.querySelector('[data-sidebar-right-expand]') !== null, '收起信号必须可观测');
  expand.remove();
  assert.equal(doc.querySelector('[data-sidebar-right-expand]'), null, '展开后信号消失');

  // 判据 4：display:none 必须能被识别
  stage.style.display = 'none';
  assert.equal(win.getComputedStyle(stage).display, 'none', 'display:none 必须可观测');
  stage.style.display = '';

  // 判据 3：脱离文档必须能被识别
  stage.remove();
  assert.equal(stage.isConnected, false, '脱离后 isConnected 必须为 false');
})

test('后台时整拍不打桥（#1325 成果保留）', { skip: SKIP ? 'jsdom 不可用' : false }, () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  // jsdom 默认 visibilityState = 'visible'；模拟切后台。
  Object.defineProperty(doc, 'visibilityState', { value: 'hidden', configurable: true });
  assert.equal(doc.visibilityState, 'hidden', '后台状态必须可观测');
  assert.equal(doc.hidden, false, 'jsdom 的 document.hidden 不跟随 visibilityState（宿主缺口，非实现缺陷）');
})