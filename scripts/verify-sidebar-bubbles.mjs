#!/usr/bin/env node
/** Runtime/ADB acceptance. Seed real tabs first; no mocked panels or production test hooks. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const args = process.argv.slice(2)
const arg = key => { const at = args.indexOf('--' + key); return at < 0 ? undefined : args[at + 1] }
const serial = arg('serial')
if (!serial) throw new Error('Usage: node scripts/verify-sidebar-bubbles.mjs --serial <device> --out <directory> [--wide]')
const out = resolve(arg('out') ?? '.deploy-tmp/sidebar-bubbles-' + serial)
mkdirSync(out, { recursive: true })
const checks = [], commands = []
function adb(argv, binary = false) {
  commands.push(['adb', '-s', serial, ...argv])
  const result = spawnSync('adb', ['-s', serial, ...argv], { encoding: binary ? undefined : 'utf8', maxBuffer: 20 * 1024 * 1024 })
  if (result.status !== 0) throw new Error('ADB failed: ' + argv.join(' ') + ': ' + String(result.stderr))
  return result.stdout
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const fingerprint = adb(['shell', 'run-as', 'com.dsharnessmobile.shell', 'ls', 'files/.snapshot-fingerprint']).trim()
const transaction = spawnSync('adb', ['-s', serial, 'shell', 'run-as', 'com.dsharnessmobile.shell', 'ls', 'files/.snapshot-transaction'], { encoding: 'utf8' })
assert.ok(fingerprint); assert.notEqual(transaction.status, 0, 'snapshot refresh must have finished')
let port, target, discoveryError
for (let attempt = 0; attempt < 60 && !target; attempt++) {
  try {
    const pid = adb(['shell', 'pidof', 'com.dsharnessmobile.shell']).trim()
    port = adb(['forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid]).trim()
    const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())
    target = targets.find(t => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url))
  } catch (error) { discoveryError = String(error) }
  if (!target) { if (port) adb(['forward','--remove','tcp:'+port]); await delay(500) }
}
assert.ok(target, 'main application WebView must exist: ' + discoveryError)
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve,reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let next = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data)), waiter = pending.get(message.id)
  if (!waiter) return
  pending.delete(message.id); clearTimeout(waiter.timer)
  if (message.error || message.result.exceptionDetails) waiter.reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)))
  else waiter.resolve(message.result.result.value)
})
const contextSource = String.raw`function context() {
  const node = document.querySelector('[data-sidebar-right-panel] [data-dockkit-strip]')
  if (!node) throw new Error('No native tab strip')
  let fiber = node[Object.keys(node).find(key => key.startsWith('__reactFiber'))]
  for (; fiber; fiber = fiber.return) if (fiber.memoizedProps?.binding?.ctx) return fiber.memoizedProps.binding.ctx
  throw new Error('No live slot binding for runtime inspection')
}`
function evaluate(fn, ...values) {
  const id = ++next
  const expression = '(() => {' + contextSource + ';return (' + fn.toString() + ')(...' + JSON.stringify(values) + ')})()'
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout')) }, 20000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}
async function state() {
  return evaluate(() => {
    const ctx = context(), right = ctx.get('sidebarRight'), owner = right.mounted.getSnapshot()
    const panel = [...document.querySelectorAll('[data-sidebar-right-panel]')].find(p => p.getAttribute('data-sidebar-right-session') === owner)
    const rows = [...panel.querySelectorAll('[data-dsh-bubble-tab]')].map(e => ({ id: e.getAttribute('data-dsh-bubble-tab'), rect: e.getBoundingClientRect().toJSON(), pane: panel.querySelector('[data-dockkit-tab="' + e.getAttribute('data-dsh-bubble-tab') + '"]')?.closest('[data-dockkit-strip]')?.getAttribute('data-dockkit-strip') }))
    const pop = panel.querySelector('.dsh-bubble-popover')
    return { width: innerWidth, height: innerHeight, owner, active: right.active()?.id, expanded: right.isExpanded(), bubbles: !!panel.querySelector('[data-dsh-sidebar-bubbles-toggle]'), open: panel.querySelector('[data-dsh-sidebar-bubbles-toggle]')?.getAttribute('aria-expanded') === 'true', order: [...panel.querySelectorAll('[data-dockkit-host="dock"] [data-dockkit-strip] [data-dockkit-tab]')].map(e => e.getAttribute('data-dockkit-tab')), rows, tabs: right.tabsIn(owner).map(t => ({ id: t.id, kind: t.kind, contentId: t.contentId })), pop: pop ? { rect: pop.getBoundingClientRect().toJSON(), scrollTop: pop.scrollTop, scrollHeight: pop.scrollHeight, clientHeight: pop.clientHeight } : null, mainSession: document.documentElement.getAttribute('data-dsh-session-id'), terminalText: panel.querySelector('.xterm-screen')?.textContent, browserFrames: [...panel.querySelectorAll('iframe')].map(f => ({ src: f.src, name: f.name })) }
  })
}
let screenshotIndex = 0
function screenshot(label) {
  const name = 'ui-' + String(++screenshotIndex).padStart(2, '0') + '-' + label + '.png'
  writeFileSync(join(out, name), adb(['exec-out', 'screencap', '-p'], true))
  return name
}
function pass(name, details) { checks.push({ name, status: 'PASS', details }); console.log('PASS ' + name) }
async function point(selector) {
  const p = await evaluate(selector => {
    const element = document.querySelector(selector)
    if (!element) throw new Error('Missing control: ' + selector)
    const rect = element.getBoundingClientRect()
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: innerWidth, ratio: devicePixelRatio * (visualViewport?.scale ?? 1), rect: rect.toJSON() }
  }, selector)
  const ratio = p.ratio
  return { x: Math.round(p.x * ratio), y: Math.round(p.y * ratio), ratio }
}
async function tap(selector) { const p = await point(selector); adb(['shell','input','tap',String(p.x),String(p.y)]); await delay(380) }
async function disclosure(open) {
  const s = await state()
  if (s.open !== open) await tap('[data-dsh-sidebar-bubbles-toggle]')
  assert.equal((await state()).open, open)
}
try {
  let ready = false
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    ready = await evaluate(() => !!document.querySelector('[data-sidebar-right-panel] [data-dockkit-strip]'))
    if (!ready) await delay(500)
  }
  assert.ok(ready, 'application must mount a real tab strip after startup')
  if (arg('owner')) { await evaluate(id => context().get('uiWorkspace').openSession(id), arg('owner')); await delay(600) }
  if (args.includes('--seed-many')) await evaluate(() => { const right=context().get('sidebarRight'); right.openTabIn(right.mounted.getSnapshot(), 'guide') })
  await evaluate(() => { const right = context().get('sidebarRight'); if (!right.isExpanded()) right.toggleExpanded() })
  await delay(500)
  let initial = await state()
  const wide = args.includes('--wide')
  if (wide && await evaluate(() => document.querySelector('[data-sidebar-right-panel]')?.getAttribute('data-sidebar-right-panel') === 'fullscreen')) {
    await tap('[data-sidebar-right-mode]'); initial = await state()
  }
  if (wide) {
    assert.ok(initial.width >= 768, 'wide run requires a measured wide window')
    assert.equal(initial.bubbles, false)
    const before = initial.tabs
    const selected = await evaluate(() => {
      const right = context().get('sidebarRight'), owner = right.mounted.getSnapshot()
      const tab = right.tabsIn(owner).find(t => t.kind === 'conversation')
      if (!tab) throw new Error('Wide regression requires a real conversation tab')
      right.focus(tab.id)
      return tab.id
    })
    await delay(500)
    const nativeTab = '[data-dockkit-tab="' + selected + '"]'
    await tap(nativeTab)
    const after = await state()
    assert.equal(after.active, selected); assert.equal(after.owner, initial.owner); assert.deepEqual(after.tabs, before)
    const layout = await evaluate(() => {
      const p = document.querySelector('[data-sidebar-right-panel]'), root = document.querySelector('[data-dsh-frame]')
      return { panel: p.getBoundingClientRect().toJSON(), root: root.getBoundingClientRect().toJSON(), fullscreen: p.getAttribute('data-sidebar-right-panel') === 'fullscreen' }
    })
    assert.equal(layout.fullscreen, false, 'wide panel must use the existing parallel presentation')
    assert.ok(layout.panel.width < layout.root.width, 'main and secondary columns must both have room')
    pass('宽窗口原生横向标签和并排会话', { width: after.width, layout, screenshot: screenshot('wide-parallel') })
  } else {
    assert.ok(initial.width < 768)
    assert.ok(initial.bubbles && initial.expanded)
    assert.ok(initial.tabs.some(t => t.kind === 'conversation') && initial.tabs.some(t => t.kind === 'browser') && initial.tabs.some(t => t.kind === 'terminal') && initial.tabs.some(t => t.kind === 'android-vdisplay'), 'seed real conversation/browser/terminal/display tabs first')
    await disclosure(true)
    let s = await state()
    assert.deepEqual(s.rows.map(r => r.id), s.order)
    assert.ok(s.pop.rect.bottom <= s.height && s.pop.rect.left >= 0 && s.pop.rect.right <= s.width)
    pass('真实标签映射、竖向排列和可用区约束', { width: s.width, count: s.tabs.length, screenshot: screenshot('portrait-expanded') })
    const visible = s.rows.find(row => row.id !== s.active && row.rect.top > s.pop.rect.top + 2 && row.rect.bottom < s.pop.rect.bottom - 2)
    assert.ok(visible)
    await tap('[data-dsh-bubble-select="' + visible.id + '"]')
    let after = await state()
    assert.equal(after.active, visible.id); assert.equal(after.open, false); assert.equal(after.owner, initial.owner); assert.deepEqual(after.tabs, initial.tabs)
    pass('原生触摸切换后收起，主会话和工具身份保留', { selected: after.active, screenshot: screenshot('switched') })
    await disclosure(true)
    adb(['shell','input','keyevent','4']); await delay(400)
    after = await state(); assert.equal(after.open,false); assert.equal(after.expanded,true)
    pass('Android 返回优先收起气泡', { active: after.active })
    await disclosure(true)
    const outside = await point('[data-dsh-sidebar-bubbles-toggle]')
    adb(['shell','input','tap',String(Math.round(8*outside.ratio)),String(Math.round(380*outside.ratio))]); await delay(400)
    after = await state(); assert.equal(after.open,false); assert.equal(after.expanded,true)
    pass('外部点击只收起导航', { active: after.active })
    await disclosure(true)
    s = await state()
    assert.ok(s.pop.scrollHeight > s.pop.clientHeight, 'many-tab scenario must really overflow')
    const scale = (await point('[data-dsh-sidebar-bubbles-toggle]')).ratio
    const box = s.pop.rect, x = Math.round((box.x + box.width/2)*scale)
    const a = Math.round((s.pop.scrollTop > 0 ? box.top + 90 : box.bottom - 60)*scale)
    const b = Math.round((s.pop.scrollTop > 0 ? box.bottom - 60 : box.top + 90)*scale)
    adb(['shell','input','swipe',String(x),String(a),String(x),String(b),'350']); await delay(400)
    after = await state(); assert.notEqual(after.pop.scrollTop,s.pop.scrollTop); assert.deepEqual(after.order,s.order); assert.equal(after.open,true)
    pass('多标签原生纵向滚动不触发排序或侧栏手势', { from:s.pop.scrollTop,to:after.pop.scrollTop,screenshot:screenshot('scrolled') })
    s = after
    const shown = s.rows.filter(r => r.rect.top > s.pop.rect.top+5 && r.rect.bottom < s.pop.rect.bottom-5)
    const source = shown[0], destination = shown.find((r,i)=>i>=2 && r.pane===source.pane)
    assert.ok(source && destination,'three visible same-pane tabs are required')
    const from = {x:Math.round((source.rect.x+80)*scale),y:Math.round((source.rect.y+source.rect.height/2)*scale)}
    const to = {x:from.x,y:Math.round((destination.rect.y+destination.rect.height*.8)*scale)}
    adb(['shell','input','motionevent','DOWN',String(from.x),String(from.y)]); await delay(520)
    const dragging = await evaluate(()=>!!document.querySelector('[data-dsh-bubble-tab][data-dragging]'))
    assert.ok(dragging,'native hold must enter reorder feedback')
    adb(['shell','input','motionevent','MOVE',String(to.x),String(to.y)]); await delay(120)
    adb(['shell','input','motionevent','UP',String(to.x),String(to.y)]); await delay(500)
    after=await state(); assert.notDeepEqual(after.order,s.order); assert.equal(after.active,s.active); assert.equal(after.open,true)
    assert.deepEqual(after.tabs.map(t=>t.id).sort(),s.tabs.map(t=>t.id).sort())
    pass('长按拖拽提交原生排序并保留活动面板', {before:s.order,after:after.order,screenshot:screenshot('reordered')})
    const held = after.rows.find(r => r.rect.top > after.pop.rect.top+5 && r.rect.bottom < after.pop.rect.bottom-5)
    const hx=Math.round((held.rect.x+80)*scale),hy=Math.round((held.rect.y+held.rect.height/2)*scale)
    adb(['shell','input','motionevent','DOWN',String(hx),String(hy)]); await delay(520)
    assert.ok(await evaluate(()=>!!document.querySelector('[data-dragging]')))
    adb(['shell','input','motionevent','CANCEL',String(hx),String(hy)])
    adb(['shell','input','keyevent','4']); await delay(380)
    assert.equal((await state()).open,false)
    assert.ok(await evaluate(()=>document.activeElement===document.querySelector('[data-dsh-sidebar-bubbles-toggle]')))
    pass('取消长按后的首次返回和焦点恢复', { screenshot:screenshot('canceled-hold-back') })
    for(const kind of ['terminal','browser','android-vdisplay','conversation']) {
      const selected = await evaluate(kind=>{const right=context().get('sidebarRight');const tab=right.tabsIn(right.mounted.getSnapshot()).find(t=>t.kind===kind);right.focus(tab.id);return tab.id},kind)
      await delay(300); await disclosure(false); await disclosure(true)
      await tap('[data-dsh-bubble-select="'+selected+'"]')
      const current=await state();assert.equal(current.active,selected);assert.equal(current.open,false)
    }
    after=await state()
    assert.deepEqual(after.tabs.map(t=>[t.id,t.contentId]).sort(),initial.tabs.map(t=>[t.id,t.contentId]).sort())
    pass('对话、终端、浏览器、虚拟屏切换无重复实例', {ids:after.tabs,screenshot:screenshot('tools-retained')})
    await disclosure(true)
    await evaluate(()=>{const button=document.querySelector('[data-dsh-sidebar-bubbles-toggle]');for(let i=0;i<20;i++)button.click()})
    after=await state();assert.equal(after.open,true);assert.equal(await evaluate(()=>document.querySelectorAll('[data-dsh-sidebar-bubbles-toggle]').length),1)
    pass('动画中连续开关状态稳定', { open:after.open })
    const closed = after.tabs.find(t => t.kind === 'conversation' && t.id === after.active)
    assert.ok(closed)
    const sourceSession = decodeURIComponent(closed.contentId.split('/session/')[1].split('?')[0])
    await tap('[data-dsh-bubble-tab="' + closed.id + '"] .dsh-bubble-close')
    after = await state()
    assert.equal(after.tabs.length, initial.tabs.length - 1); assert.ok(!after.tabs.some(t => t.id === closed.id))
    assert.ok(after.tabs.some(t => t.id === after.active))
    assert.ok(await evaluate(id => context().get('sessions').list.getSnapshot().ids.includes(id), sourceSession))
    pass('关闭侧开标签保留原会话历史并选择下一面板', { closed:closed.id, sourceSession, active:after.active, screenshot:screenshot('closed-tab') })
    const collapseLabel=await evaluate(()=>document.querySelector('[data-sidebar-right-panel] [data-sidebar-right-toggle]').getAttribute('aria-label'))
    await tap('[data-dsh-bubble-action][aria-label='+JSON.stringify(collapseLabel)+']')
    assert.equal((await state()).expanded,false)
    await tap('[data-conversation-header-corner] button')
    assert.equal((await state()).expanded,true)
    pass('标签栏重建后原生收起与再次展开按钮可用', { screenshot:screenshot('native-controls') })
  }
  writeFileSync(join(out,'result.json'),JSON.stringify({serial,phase:'PASS',checks,commands},null,2)+'\n')
  console.log('SIDEBAR BUBBLES ACCEPTANCE PASSED: '+checks.length+' checks; '+out)
} catch(error) {
  adb(['shell','input','motionevent','CANCEL','0','0'])
  try{screenshot('failure')}catch(screenshotError){console.error(String(screenshotError))}
  writeFileSync(join(out,'result.json'),JSON.stringify({serial,phase:'FAIL',error:String(error),checks,commands},null,2)+'\n')
  throw error
} finally {
  socket.close()
  for(const waiter of pending.values())clearTimeout(waiter.timer)
  adb(['forward','--remove','tcp:'+port])
}
