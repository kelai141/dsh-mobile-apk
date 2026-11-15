#!/usr/bin/env node
/**
 * verify-sidebar-drawer.mjs —— 手机形态左抽屉的两条交互契约（CDP 层验收）。
 *
 * 守两件事，各自都有「先红后绿」的实锤（真机/模拟器 127.0.0.1:16480 实测）：
 *
 * 1. 点会话行的「三个点」只开菜单，**不得**收起抽屉。
 *    缺陷真因：PanelNavDrawer.attachNavDismiss 的点击判据只排除 [aria-expanded]，
 *    而上游三个点只有 data-context-menu-trigger（无 aria-haspopup、无 aria-expanded），
 *    被当成导航 ⇒ 260ms 后模拟点遮罩收抽屉。
 *
 * 2. 抽屉展开后**向左滑**必须能收起它。
 *    缺陷真因：上游左抽屉自己就是 role=dialog aria-modal=true（展开态页内唯一一个），
 *    旧的模态守卫 :not([data-dsh-settings-dialog]) 因此恒命中，touchstart 直接 return；
 *    开方向不受影响（那一刻抽屉收着），所以只有「收起方向」坏。
 *
 * 用法：
 *   node scripts/verify-sidebar-drawer.mjs --serial <adb-serial> [--out <dir>] [--wide]
 * 退出码：0 = 两条全 PASS；1 = 有 FAIL；2 = 前置缺失或证据不足（INCONCLUSIVE，不得当通过）。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const arg = key => { const at = args.indexOf('--' + key); return at < 0 ? undefined : args[at + 1] }
const serial = arg('serial')
if (!serial) { console.error('用法: node scripts/verify-sidebar-drawer.mjs --serial <serial> [--out <dir>] [--wide]'); process.exit(2) }
const out = resolve(arg('out') ?? '.deploy-tmp/sidebar-drawer-' + serial.replace(/[:.]/g, '-'))
mkdirSync(out, { recursive: true })

const checks = []
function adb(argv, binary = false) {
  const result = spawnSync('adb', ['-s', serial, ...argv], { encoding: binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('ADB failed: ' + argv.join(' ') + ': ' + String(result.stderr))
  return result.stdout
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function pass(name, details) { checks.push({ name, status: 'PASS', details }); console.log('PASS ' + name + (details ? ' :: ' + details : '')) }
function fail(name, details) { checks.push({ name, status: 'FAIL', details }); console.error('FAIL ' + name + ' :: ' + details) }
/**
 * 证据不足：**不得当通过**（与 verify-screen-scope-matrix 同一纪律）。
 *
 * 出现的场合是环境限制而非产品缺陷，例如横屏 610x343 CSS px 时抽屉里找不到一条
 * 既能让手势起手、又能收手、且都不压在控件上的纵向空白带 —— 手势源按设计不认领落在
 * 按钮上的触摸，强行在按钮上起手只会验到那条守卫，验不到收起方向本身。
 */
function inconclusive(name, details) { checks.push({ name, status: 'INCONCLUSIVE', details }); console.warn('INCONCLUSIVE ' + name + ' :: ' + details) }

// ---- 前置：应用在跑 + WebView devtools socket 可达 ----
// pidof 在应用没跑时返回非零 —— 那是"前置缺失"而不是脚本故障，所以这里不走会抛的 adb()。
const pidResult = spawnSync('adb', ['-s', serial, 'shell', 'pidof', 'com.dsharnessmobile.shell'], { encoding: 'utf8' })
const pid = pidResult.status === 0 ? String(pidResult.stdout).trim() : ''
if (pid === '') { console.error('前置缺失：应用未运行（com.dsharnessmobile.shell）'); process.exit(2) }
const port = String(adb(['forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid])).trim()
let target
for (let attempt = 0; attempt < 40 && target === undefined; attempt += 1) {
  try {
    const list = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())
    target = list.find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url))
  } catch { /* devtools 还没起来 */ }
  if (target === undefined) await delay(500)
}
if (target === undefined) { console.error('前置缺失：WebView devtools target 未出现'); process.exit(2) }

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let next = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  const waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id)
  clearTimeout(waiter.timer)
  if (message.error || message.result?.exceptionDetails) waiter.reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
  else waiter.resolve(message.result)
})
function send(method, params, timeoutMs = 20000) {
  const id = ++next
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(fn, ...values) {
  const result = await send('Runtime.evaluate', {
    expression: '(() => (' + fn.toString() + ')(...' + JSON.stringify(values) + '))()',
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(result.exceptionDetails))
  return result.result.value
}

/** 页面级读数：抽屉开合 + 菜单数量 + 视口（形态判据用）。 */
const readState = () => evaluate(() => {
  const frame = document.querySelector('[data-dsh-frame]')
  const column = frame?.querySelector('[class*="sidebarCol"]')
  return {
    mobileForm: document.documentElement.hasAttribute('data-dsh-mobile-form'),
    innerWidth: innerWidth, innerHeight: innerHeight,
    collapsed: frame?.hasAttribute('data-sidebar-collapsed') ?? null,
    colRight: column ? Math.round(column.getBoundingClientRect().right) : null,
    menus: document.querySelectorAll('[role="menu"]').length,
  }
})

let shotIndex = 0
function screenshot(label) {
  const name = 'ui-' + String(++shotIndex).padStart(2, '0') + '-' + label + '.png'
  writeFileSync(join(out, name), adb(['exec-out', 'screencap', '-p'], true))
  console.log('SHOT ' + join(out, name))
  return name
}

/** 等抽屉动画收敛：连续两次读数相同且抽屉在屏上（CSS 过渡 200ms）。 */
async function settled(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let previous = await readState()
  for (;;) {
    await delay(120)
    const current = await readState()
    if (current.collapsed === previous.collapsed && current.colRight === previous.colRight) return current
    previous = current
    if (Date.now() > deadline) return current
  }
}

/** 物理点按：CSS 坐标 -> 物理像素（按页内 devicePixelRatio 换算）。 */
const dpr = await evaluate(() => window.devicePixelRatio || 1)
function tap(cssX, cssY) {
  adb(['shell', 'input', 'tap', String(Math.round(cssX * dpr)), String(Math.round(cssY * dpr))])
}
function swipe(cssX1, cssY1, cssX2, cssY2, ms = 260) {
  adb(['shell', 'input', 'swipe', String(Math.round(cssX1 * dpr)), String(Math.round(cssY1 * dpr)), String(Math.round(cssX2 * dpr)), String(Math.round(cssY2 * dpr)), String(ms)])
}

// ---- 复位到干净初态：关掉残留菜单，确保抽屉是收起的 ----
async function resetToCollapsed() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const state = await readState()
    if (state.menus === 0 && state.collapsed === true) return state
    if (state.menus > 0) tap(state.innerWidth / 2, state.innerHeight / 2)
    else if (state.collapsed === false) {
      const opener = await evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(candidate => {
          const rect = candidate.getBoundingClientRect()
          return /打开导航|打开侧边栏/.test(candidate.getAttribute('aria-label') || '') && rect.width > 0 && rect.x >= 0
        })
        if (button === undefined) return null
        const rect = button.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })
      if (opener !== null) tap(opener.x, opener.y)
    }
    await delay(700)
  }
  return readState()
}

async function openDrawer() {
  const current = await readState()
  if (current.collapsed === false) return settled()
  const opener = await evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(candidate => {
      const rect = candidate.getBoundingClientRect()
      return /打开导航|打开侧边栏/.test(candidate.getAttribute('aria-label') || '') && rect.width > 0 && rect.x >= 0
    })
    if (button === undefined) return null
    const rect = button.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, label: button.getAttribute('aria-label') }
  })
  if (opener === null) throw new Error('找不到抽屉开关（aria-label 打开导航/打开侧边栏）')
  tap(opener.x, opener.y)
  return settled()
}

// 等页面把 frame 挂出来：应用刚重启/引擎刚 LISTEN 时 [data-dsh-frame] 还不存在，
// 直接读属性会抛 "Cannot read properties of null"，那是前置未就绪而不是判据失败。
for (let attempt = 0; ; attempt += 1) {
  const ready = await evaluate(() => document.querySelector('[data-dsh-frame]') !== null)
  if (ready) break
  if (attempt >= 120) { console.error('前置缺失：等了 60 秒页面仍未挂出 [data-dsh-frame]（应用未加载完）'); process.exit(2) }
  await delay(500)
}

try {
  const initial = await readState()
  if (!initial.mobileForm) { console.log('前置：当前不是手机形态（innerWidth=' + initial.innerWidth + '），本脚本只覆盖手机形态'); process.exit(2) }
  if (initial.menus > 0) screenshot('00-initial-menu');

  // ---- 契约 1：点会话行三个点，抽屉不得收起 ----
  try {
    await resetToCollapsed()
    const opened = await openDrawer()
    assert.equal(opened.collapsed, false, '前置：抽屉必须张开');
    // 会话行可能藏在折叠着的工作区里（横屏 + 高密度实测就是这样）：先把它展开再找。
    const needsExpand = await evaluate(() => {
      const column = document.querySelector('[data-dsh-frame] [class*="sidebarCol"]')
      if (column === null) return false
      return [...column.querySelectorAll('[data-row-key^="session:"] button[data-context-menu-trigger]')]
        .every(candidate => candidate.getBoundingClientRect().width === 0)
    })
    if (needsExpand) {
      const workspaceRow = await evaluate(() => {
        const row = [...document.querySelectorAll('[data-row-key^="workspace:"]')]
          .find(candidate => candidate.getBoundingClientRect().width > 0 && candidate.getAttribute('aria-expanded') !== 'true')
        if (row === undefined) return null
        const rect = row.getBoundingClientRect()
        return { x: rect.x + Math.min(60, rect.width / 2), y: rect.y + rect.height / 2, key: row.getAttribute('data-row-key') }
      })
      if (workspaceRow !== null) {
        tap(workspaceRow.x, workspaceRow.y)
        await delay(900)
        console.log('EXPAND ' + JSON.stringify(workspaceRow))
      }
    }
    // 视口很矮时（横屏实测 610x343 CSS px）会话行在抽屉列表的可视区之外：先用真实上滑把它滚进来。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const visible = await evaluate(() => {
        const column = document.querySelector('[data-dsh-frame] [class*="sidebarCol"]')
        if (column === null) return 0
        return [...column.querySelectorAll('[data-row-key^="session:"] button[data-context-menu-trigger]')]
          .filter(candidate => candidate.getBoundingClientRect().width > 0).length
      })
      if (visible > 0) break
      const listRect = await evaluate(() => {
        const column = document.querySelector('[data-dsh-frame] [class*="sidebarCol"]')
        const list = column?.querySelector('[role="tree"]')
        if (list === null || list === undefined) return null
        const rect = list.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, top: rect.top, bottom: rect.bottom }
      })
      if (listRect === null) break
      // 在列表内向上滑 = 内容上滚，把下面的行带进视口。
      swipe(listRect.x, listRect.bottom - 20, listRect.x, listRect.top + 20, 220)
      await delay(700)
    }
    // 取点必须**用真实命中测试验一遍**：抽屉有 200ms 收合过渡，动画中途算出来的矩形
    // 会让点击落到遮罩上（遮罩点击本来就会收起抽屉），那不是被验的缺陷，是探针自己的错。
    const locate = () => evaluate(() => {
      const column = document.querySelector('[data-dsh-frame] [class*="sidebarCol"]')
      if (column === null) return null
      const buttons = [...column.querySelectorAll('[data-row-key^="session:"] button[data-context-menu-trigger]')]
        .filter(candidate => candidate.getBoundingClientRect().width > 0)
      for (const button of buttons) {
        const rect = button.getBoundingClientRect()
        const x = rect.x + rect.width / 2
        const y = rect.y + rect.height / 2
        const hit = document.elementFromPoint(x, y)
        // 命中点必须落在这颗按钮里；否则说明它被遮罩/其他层压住，不能拿它当探针。
        if (hit === null || !button.contains(hit)) continue
        return { x, y, label: button.getAttribute('aria-label') }
      }
      return null
    })
    let ellipsis = null
    for (let attempt = 0; attempt < 6 && ellipsis === null; attempt += 1) {
      ellipsis = await locate()
      if (ellipsis === null) { await delay(400) }
    }
    assert.notEqual(ellipsis, null, '前置：抽屉里必须有可见、且未被遮挡的会话行三个点');
    const before = await readState()
    tap(ellipsis.x, ellipsis.y)
    await delay(1400)
    const after = await readState()
    screenshot('10-ellipsis-menu');
    assert.equal(after.collapsed, false, '点三个点后抽屉必须仍展开（缺陷形态：collapsed=true 即点了菜单入口就被当成导航）');
    assert.ok(after.menus > 0, '点三个点后会话菜单必须弹出（否则说明点压根没到按钮上，判据不成立）');
    pass('点会话行三个点不收起抽屉', JSON.stringify({ before, after, label: ellipsis.label, at: { x: Math.round(ellipsis.x), y: Math.round(ellipsis.y) } }));
  } catch (error) {
    fail('点会话行三个点不收起抽屉', String(error && error.message ? error.message : error));
  }

  // ---- 契约 2：抽屉展开后向左滑必须能收起 ----
  try {
    // 复位：关掉上一条用例留下的菜单，再确保抽屉张开。
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const state = await readState()
      if (state.menus === 0) break;
      tap(state.innerWidth / 2, 40)
      await delay(600)
    }
    let state = await readState()
    if (state.collapsed !== false) state = await openDrawer()
    assert.equal(state.collapsed, false, '前置：抽屉必须张开');
    const drawerRect = await evaluate(() => {
      const column = document.querySelector('[data-dsh-frame] [class*="sidebarCol"]')
      if (column === null) return null
      const rect = column.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, height: rect.height }
    })
    assert.notEqual(drawerRect, null, '前置：抽屉列元素必须存在');
    // 从抽屉内部往左滑：全程落在抽屉盒内，且起止都远离视口边缘（不被系统手势条吃掉）。
    const startX = drawerRect.right - 40
    const endX = drawerRect.left + 60
    // 纵向落点必须避开可交互控件：手势源按设计不认领落在按钮上的触摸
    // （横屏实测 610x343 时「工作区」那排的搜索/视图/新建按钮正好压在 65% 高度上，
    //  点在那里被正确排除 ⇒ 判据会假红）。逐点探测，取第一个非交互位置。
    const y = await evaluate((startX, endX, top, bottom) => {
      // 与源码 editableOrInteractive 同一份闭集：落在这些控件上的触摸按设计不认领。
      const INTERACTIVE = 'input, textarea, select, button, label, a, summary, [contenteditable="true"], [role="button"], [role="tab"], [role="menu"], [role="menuitem"], [role="textbox"], [role="searchbox"], [role="combobox"], [aria-haspopup], [data-trigger-menu], [data-dockkit-float]'
      // 整条横向路径都要干净，不能只查两端：手势会扫过中间每一个 x，
      // 只要有一个触点落在控件上，源码就会按设计不认领（横屏 343 CSS px 实测：
      // 抽屉右列几乎整列都是行内操作按钮，只查两端会挑出"看着空、滑过去压按钮"的位置）。
      const steps = 8
      const free = []
      // 跳过顶部系统栏：那里的触摸由系统消费，根本进不到页面（实测 cssY=23 时页内收不到 touchstart）。
      const first = Math.ceil(top) + 40
      for (let candidate = first; candidate < bottom - 2; candidate += 3) {
        let clean = true
        for (let step = 0; step <= steps; step += 1) {
          const x = startX + (endX - startX) * (step / steps)
          const hit = document.elementFromPoint(x, candidate)
          if (hit === null || hit.closest(INTERACTIVE) !== null) { clean = false; break }
        }
        if (clean) free.push(candidate)
      }
      if (free.length === 0) return null
      // 取最长的连续空档的中点：整段滑动手势都要落在空档里。
      let best = { from: free[0], to: free[0] }
      let runStart = free[0]
      for (let index = 1; index <= free.length; index += 1) {
        const current = free[index]
        if (current !== undefined && current - free[index - 1] <= 3) continue
        const runEnd = free[index - 1]
        if (runEnd - runStart > best.to - best.from) best = { from: runStart, to: runEnd }
        if (current !== undefined) runStart = current
      }
      return (best.from + best.to) / 2
    }, startX, endX, drawerRect.top, drawerRect.top + drawerRect.height)
    // 候选纵向位置：先按"起手点干净"筛，再逐个**实测重试**。
    // 为什么不能只靠 elementFromPoint 选一次：极矮视口下扫描结果与真实命中测试会分歧
    //（横屏 610x343 实测：扫描判空档，真实 touchstart 落在 button 上），一次定死就会假红。
    const candidates = await evaluate((startX, top, bottom) => {
      const INTERACTIVE = 'input, textarea, select, button, label, a, summary, [contenteditable="true"], [role="button"], [role="tab"], [role="menu"], [role="menuitem"], [role="textbox"], [role="searchbox"], [role="combobox"], [aria-haspopup], [data-trigger-menu], [data-dockkit-float]'
      // 守卫只在 touchstart 判落点，因此只需保证**起手点**不在控件上（之后的 touchmove 不再判）。
      // 顶部 40px 跳过：那里是系统栏，触摸根本进不到页面。
      const clean = []
      for (let candidate = Math.ceil(top) + 40; candidate < bottom - 8; candidate += 6) {
        const hit = document.elementFromPoint(startX, candidate)
        if (hit !== null && hit.closest(INTERACTIVE) === null) clean.push(candidate)
      }
      return clean
    }, startX, drawerRect.top, drawerRect.top + drawerRect.height)

    if (candidates.length === 0) {
      inconclusive('侧滑收起左抽屉', '视口 ' + JSON.stringify({ innerWidth: await evaluate(() => innerWidth), innerHeight: await evaluate(() => innerHeight) }) + ' 太矮：抽屉内找不到任何不在交互控件上的起手位置')
    } else {
    let verdict = null
    let attempts = 0
    // 记下"起手前"的抽屉状态，报告里才说得清 before/after 各自的含义。
    const openedBefore = await readState()
    for (const candidateY of candidates) {
      attempts += 1
      // 只读探针：记录这次侧滑的 touchstart 是否到页面、是否压在控件上。
      await evaluate(() => {
        const INTERACTIVE = 'input, textarea, select, button, label, a, summary, [contenteditable="true"], [role="button"], [role="tab"], [role="menu"], [role="menuitem"], [role="textbox"], [role="searchbox"], [role="combobox"], [aria-haspopup], [data-trigger-menu], [data-dockkit-float]'
        window.__dshTouchProbe = { count: 0, interactive: null, target: null }
        window.__dshProbeHandler?.()
        window.__dshProbeHandler = () => {}
        document.addEventListener('touchstart', event => {
          window.__dshTouchProbe.count += 1
          const target = event.target
          window.__dshTouchProbe.interactive = target instanceof Element ? target.closest(INTERACTIVE) !== null : null
          window.__dshTouchProbe.target = target instanceof Element ? target.tagName + '.' + String(target.className).slice(0, 32) : null
        }, { capture: true, once: true, passive: true })
      })
      swipe(startX, candidateY, endX, candidateY)
      await delay(1200)
      const state = await readState()
      const probe = await evaluate(() => window.__dshTouchProbe ?? { count: 0 })
      if (state.collapsed === true) { verdict = { outcome: 'closed', state, probe, y: candidateY }; break }
      // 抽屉没合上：若是落点问题就换下一个候选；若落点干净却仍不生效，那就是真缺陷。
      if (probe.count > 0 && probe.interactive === false) { verdict = { outcome: 'open', state, probe, y: candidateY }; break }
      // 抽屉没合上时把可能开着的菜单等状态复位，再试下一个候选。
      const reset = await readState()
      if (reset.menus > 0) { tap(reset.innerWidth / 2, 40); await delay(600) }
      if ((await readState()).collapsed === false) { /* 仍是张开：可以继续试 */ } else { await openDrawer() }
    }
    screenshot('20-swipe-closed')
    if (verdict === null) {
      inconclusive('侧滑收起左抽屉', '试过 ' + attempts + ' 个起手位置，touchstart 要么没到页面、要么压在控件上，本视口无法在不触发守卫的前提下起手')
    } else if (verdict.outcome === 'closed') {
      pass('侧滑收起左抽屉', JSON.stringify({ before: openedBefore, after: verdict.state, from: Math.round(startX), to: Math.round(endX), y: Math.round(verdict.y), attempts }))
    } else {
      fail('侧滑收起左抽屉', '起手位置干净（' + verdict.probe.target + '，y=' + Math.round(verdict.y) + '）且 touchstart 已到页面，但抽屉没有收起（缺陷形态：guards 被抽屉自己的 aria-modal 根节点挡住，手势永不认领）')
    }
    }
  } catch (error) {
    fail('侧滑收起左抽屉', String(error && error.message ? error.message : error));
  }
} finally {
  socket.close()
}

writeFileSync(join(out, 'result.json'), JSON.stringify({ serial, out, checks, target: target.url }, null, 2))
const failed = checks.filter(check => check.status === 'FAIL')
const inconclusiveChecks = checks.filter(check => check.status === 'INCONCLUSIVE')
console.log('');
const passed = checks.filter(check => check.status === 'PASS').length
console.log('结果：' + checks.length + ' 项，PASS ' + passed + '，FAIL ' + failed.length + '，INCONCLUSIVE ' + inconclusiveChecks.length + '（证据目录 ' + out + '）')
if (failed.length > 0) process.exit(1)
// 有 INCONCLUSIVE 却无 FAIL：证据不足，不算通过，也不能说失败。
process.exit(inconclusiveChecks.length > 0 ? 2 : 0)