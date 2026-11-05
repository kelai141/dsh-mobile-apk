#!/usr/bin/env node
/**
 * Independent, real-device acceptance for the mobile right-overlay workspaces.
 *
 * This intentionally does not seed/mock providers, fabricate DOM, or call layout
 * mutators to make a UI assertion pass. Setup uses the live UI workspace and
 * sidebar-right services to create isolated scratch Sessions; every behavior
 * under test is driven with adb input tap/swipe/motionevent and checked against
 * the rendered page plus the mounted native sidebar-right store.
 *
 * Not run until the caller explicitly starts it against the new shell/UI.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const opt = name => { const at = argv.indexOf('--' + name); return at < 0 ? undefined : argv[at + 1] }
const serial = opt('serial')
const adbBin = opt('adb') ?? process.env.ADB ?? 'adb'
process.env.ADB_SERVER_SOCKET ??= 'tcp:localhost:5038'
if (!serial) throw new Error('Usage: node scripts/verify-mobile-workspaces.mjs --serial <adb-serial> [--out <dir>] [--model-evidence <json>] [--orientation portrait|landscape|both]')
if (!argv.includes('--execute') && !argv.includes('--inspect-only')) throw new Error('Use --inspect-only for read-only preflight, or --execute only after the lead authorizes the installed APK')
const repo = resolve('.')
const out = resolve(opt('out') ?? '.deploy-tmp/multitask-20261018/evidence/device-' + serial.replace(/[^a-zA-Z0-9.-]/g, '_') + '-' + Date.now())
mkdirSync(out, { recursive: true })
const checks = [], commands = [], screenshots = []
let ws, wsPort, cdpTarget, cdpPid, restoreSession, scratchSessions = [], oldRotation, rotationChanged = false
let cdpId = 0
const inflight = new Map()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeString = value => String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 240)

function adb(args, binary = false, allowFailure = false) {
  commands.push(['adb', '-s', serial, ...args])
  const result = spawnSync(adbBin, ['-s', serial, ...args], { encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0 && !allowFailure) throw new Error('ADB failed: ' + args.join(' ') + ': ' + safeString(result.stderr ?? result.error ?? ''))
  return result.stdout
}
function request(method, params = {}) {
  const id = ++cdpId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { inflight.delete(id); reject(new Error('CDP timeout: ' + method)) }, 20000)
    inflight.set(id, { resolve, reject, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression, args = []) {
  await ensureConnection()
  const expressionWithArgs = typeof expression === 'function' ? `(${expression})(...${JSON.stringify(args)})` : expression
  return request('Runtime.evaluate', { expression: expressionWithArgs, returnByValue: true, awaitPromise: true })
    .then(message => {
      const exception = message.result?.exceptionDetails
      if (exception) throw new Error('CDP evaluate failed: ' + safeString(exception.text))
      return message.result?.result?.value
    })
}
const fiberContextSource = String.raw`function getLiveContext() {
  const anchor = document.querySelector('[data-dockkit-strip]') || document.querySelector('[data-dockkit-host="dock"]');
  if (!anchor) throw new Error('No live dockkit anchor; app UI has not mounted');
  let fiber = anchor[Object.keys(anchor).find(k => k.startsWith('__reactFiber'))];
  for (; fiber; fiber = fiber.return) {
    const binding = fiber.memoizedProps?.binding;
    if (binding?.ctx && typeof binding.ctx.get === 'function') return binding.ctx;
  }
  throw new Error('No live Cordis context found on dockkit React tree');
}`
function withContext(fn, ...args) {
  return `(() => { ${fiberContextSource}; return (${fn.toString()})(getLiveContext(), ...${JSON.stringify(args)}); })()`
}
async function nativeSnapshot() {
  return evaluate(withContext(ctx => {
    const right = ctx.get('sidebarRight')
    const ui = ctx.get('uiWorkspace')
    const session = right.mounted.getSnapshot()
    const layout = right.adopted?.get(session)?.store.getSnapshot().bySession[session]?.layout
    if (!layout) throw new Error('The mounted native SidebarRight layout is unavailable')
    const nodes = layout?.nodes ?? {}
    const tabs = layout?.tabs ?? {}
    const panes = Object.values(nodes).filter(n => n?.kind === 'pane').map(n => ({
      id: n.id, host: n.host, tabCount: n.tabs?.length ?? 0,
      tabIds: n.tabs ?? [],
      tabKinds: (n.tabs ?? []).map(id => tabs[id]?.kind ?? 'unknown'),
      tabTokens: (n.tabs ?? []).map(id => { let h=2166136261; for(const c of String(id)) h=Math.imul(h^c.charCodeAt(0),16777619); return (h>>>0).toString(16) }),
      rect: n.rect ? { x: n.rect.x, y: n.rect.y, width: n.rect.width, height: n.rect.height } : undefined,
    }))
    const splitNodes = Object.values(nodes).filter(n => n?.kind === 'split').map(n => ({ axis: n.axis, sizes: n.sizes, children: n.children }))
    const sessionList = ctx.get('sessions')?.list?.getSnapshot?.()
    return {
      mounted: right.mounted?.getSnapshot?.() ?? null,
      expanded: right.isExpanded?.() ?? null,
      activeKind: tabs[nodes[layout.activePaneId]?.activeTabId]?.kind ?? null,
      activeTab: nodes[layout.activePaneId]?.activeTabId ?? null,
      mode: layout?.mode ?? null,
      dockPaneCount: panes.filter(p => p.host === 'dock').length,
      floatCount: panes.filter(p => p.host === 'float').length,
      panes, splitNodes, rootId: layout.rootId,
      dockOrder: (nodes[layout.rootId]?.children ?? [layout.rootId]).map(id => panes.find(p => p.id === id)),
      sessionIds: sessionList?.ids ?? [],
      selectedSession: document.documentElement.getAttribute('data-dsh-session-id'),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? 1 },
      uiMarkers: {
        workspacePills: document.querySelectorAll('[data-dsh-workspace-pill], [data-workspace-pill]').length,
        split: document.querySelectorAll('[data-dsh-workspace-split], [data-workspace-action="split"]').length,
        swap: document.querySelectorAll('[data-dsh-workspace-swap], [data-workspace-action="swap"]').length,
        float: document.querySelectorAll('[data-dsh-workspace-float], [data-workspace-action="float"]').length,
        dragPreview: document.querySelectorAll('[data-dsh-workspace-drag-preview], [data-workspace-drag-preview]').length,
        workspaceRoot: document.querySelectorAll('[data-dsh-workspace-root], [data-workspace-root]').length,
      },
      geometry: [...document.querySelectorAll('[data-dsh-workspaces], [data-dockkit-split], [data-dockkit-float]')].map(e => {
        const r = e.getBoundingClientRect(); return { type: e.matches('[data-dockkit-float]') ? 'float' : 'split', x:r.x,y:r.y,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&getComputedStyle(e).display!=='none' };
      }),
    }
  }))
}
async function liveServices() {
  return evaluate(withContext(ctx => {
    const right = ctx.get('sidebarRight'), ui = ctx.get('uiWorkspace'), sessions = ctx.get('sessions')
    return {
      right: { openResource: typeof right.openResource, split: typeof right.split, float: typeof right.float, close: typeof right.close, mounted: right.mounted?.getSnapshot?.() },
      ui: { startSession: typeof ui.startSession, openSession: typeof ui.openSession },
      sessionCreate: typeof sessions?.create,
      sessionIds: sessions?.list?.getSnapshot?.()?.ids ?? [],
    }
  }))
}
async function useService(fn, ...args) { return evaluate(withContext(fn, ...args)) }
async function screenshot(label) {
  const name = `independent-${String(screenshots.length + 1).padStart(2, '0')}-${label}.png`
  writeFileSync(join(out, name), adb(['exec-out', 'screencap', '-p'], true))
  screenshots.push(name)
  return name
}
function record(name, status, details = {}) {
  checks.push({ name, status, details })
  console.log(`${status} ${name}`)
}
function pass(name, details) { record(name, 'PASS', details) }
function fail(name, details) { record(name, 'FAIL', details); throw new Error(name + ': ' + safeString(JSON.stringify(details))) }
function unavailable(name, reason) { record(name, 'INCONCLUSIVE', { reason }) }

const selectors = {
  workspaceRoot: '[data-dsh-workspaces]',
  split: '[data-dsh-workspace-split], [data-workspace-action="split"], button[aria-label*="分屏"], button[aria-label*="Split"]',
  swap: '[data-dsh-workspace-swap], [data-workspace-action="swap"], button[aria-label*="交换"], button[aria-label*="Swap"]',
  smallWindow: '[data-dsh-workspace-float], [data-workspace-action="float"], button[aria-label*="小窗"], button[aria-label*="浮窗"], button[aria-label*="Float"]',
  pills: '[data-dsh-bubble-select]',
  close: '.dsh-bubble-close',
  dragPreview: '.dsh-workspace-drop-preview',
  float: '[data-dockkit-float], [data-dsh-workspace-float-panel]'
}
async function point(selector, index = 0) {
  const p = await evaluate((selector, index) => {
    const elements = [...document.querySelectorAll(selector)]
    const visible = elements.filter(e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && !e.closest('[inert],[hidden]') })
    const e = visible[index]
    if (!e) return null
    const r = e.getBoundingClientRect(), style = getComputedStyle(e)
    if (r.width <= 0 || r.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return null
    return { x:r.x+r.width/2,y:r.y+r.height/2,rect:{x:r.x,y:r.y,width:r.width,height:r.height},dpr:devicePixelRatio,scale:visualViewport?.scale??1 }
  }, [selector, index])
  if (!p) return null
  return { ...p, sx: Math.round(p.x * p.dpr * p.scale), sy: Math.round(p.y * p.dpr * p.scale) }
}
async function tapSelector(selector, index = 0, label = 'tap') {
  if ([selectors.split, selectors.smallWindow, selectors.pills, selectors.close].includes(selector)) await openPopover()
  const p = await point(selector, index)
  if (!p) return null
  adb(['shell', 'input', 'tap', String(p.sx), String(p.sy)])
  await delay(450)
  return { point:p, screenshot:await screenshot(label) }
}
async function openPopover() {
  const opened = await evaluate(() => !!document.querySelector('.dsh-bubble-popover[data-state="open"]'))
  if (!opened) {
    const p = await point('[data-dsh-sidebar-bubbles-toggle]')
    if (!p) throw new Error('Visible bubble toggle unavailable')
    adb(['shell','input','tap',String(p.sx),String(p.sy)])
    await delay(350)
  }
}
async function gesture(points, duration = 500) {
  const first = points[0]
  adb(['shell','input','motionevent','DOWN',String(first.x),String(first.y)])
  for (let i=1;i<points.length;i++) {
    adb(['shell','input','motionevent','MOVE',String(points[i].x),String(points[i].y)])
    await delay(20)
  }
  const last = points.at(-1)
  if (duration > 0) await delay(duration)
  adb(['shell','input','motionevent','UP',String(last.x),String(last.y)])
  await delay(600)
}
async function rotate(to) {
  if (oldRotation === undefined) {
    oldRotation = {
      accelerometer: adb(['shell','settings','get','system','accelerometer_rotation']).toString().trim(),
      user: adb(['shell','settings','get','system','user_rotation']).toString().trim(),
    }
  }
  const val = to === 'landscape' ? '1' : '0'
  adb(['shell','settings','put','system','accelerometer_rotation','0'])
  adb(['shell','settings','put','system','user_rotation',val])
  adb(['shell','cmd','window','user-rotation','lock',val])
  rotationChanged = true
  await delay(1400)
}
async function restoreRotation() {
  if (!rotationChanged || !oldRotation) return
  adb(['shell','settings','put','system','user_rotation',oldRotation.user])
  adb(['shell','settings','put','system','accelerometer_rotation',oldRotation.accelerometer])
  if (oldRotation.accelerometer === '0') adb(['shell','cmd','window','user-rotation','lock',oldRotation.user])
  else adb(['shell','cmd','window','user-rotation','free'])
  rotationChanged = false
  await delay(900)
}
function paneAssignment(snapshot) { return snapshot.panes.filter(p => p.host === 'dock').map(p => p.tabKinds.join(',')).sort() }
function cssToInput(p) { return { x:Math.round(p.x*p.dpr*p.scale), y:Math.round(p.y*p.dpr*p.scale) } }

async function createScratchSessions() {
  const before = await liveServices()
  restoreSession = await evaluate(() => document.documentElement.getAttribute('data-dsh-session-id'))
  if (before.sessionCreate !== 'function' || before.ui.openSession !== 'function') {
    unavailable('isolated scratch sessions', 'live Session create/openSession API is missing')
    return []
  }
  const created = []
  for (let n=0;n<2;n++) {
    const newId = await useService(async ctx => await ctx.get('sessions').create())
    let ids = []
    const deadline = Date.now() + 12000
    do {
      await delay(250)
      ids = (await liveServices()).sessionIds
      const fresh = ids.filter(id => !before.sessionIds.includes(id) && !created.includes(id))
      if (fresh.includes(newId)) { created.push(newId); break }
    } while (Date.now() < deadline)
  }
  if (created.length !== 2) fail('create two independent scratch Sessions', { createdCount:created.length })
  scratchSessions = created
  // Select a scratch Session before opening its real conversation resource. The
  // resource provider retains that Session through the production navigator.
  await useService((ctx, id) => { ctx.get('uiWorkspace').openSession(id) }, created[0])
  await delay(700)
  await useService((ctx, id) => { ctx.get('sidebarRight').openResource('dsh-resource://conversation/session/' + encodeURIComponent(id)) }, created[0])
  await delay(500)
  await useService((ctx, id) => { ctx.get('sidebarRight').openResource('dsh-resource://conversation/session/' + encodeURIComponent(id)) }, created[1])
  await delay(800)
  return created
}

async function assertMountedAndReady() {
  const snapshot = await nativeSnapshot()
  if (!snapshot?.mounted) fail('right-overlay native store mounted', { mounted: snapshot?.mounted ?? null })
  if (!snapshot.geometry.length) fail('rendered workspace geometry exists', { markers:snapshot.uiMarkers })
  return snapshot
}
async function assertSplitAfterInput() {
  const before = await nativeSnapshot()
  const tap = await tapSelector(selectors.split, 0, 'split-control')
  if (!tap) { unavailable('native UI split action', 'No visible user-facing split control matched the independent selector contract'); return null }
  const after = await nativeSnapshot()
  if (after.dockPaneCount !== 2) fail('split creates exactly two native dock panes', { before:before.dockPaneCount, after:after.dockPaneCount, geometry:after.geometry })
  const picker=await tapSelector('[data-dsh-workspace-picker] button:not(:disabled)',0,'split-existing-workspace')
  if(!picker) fail('split picker offers an existing compatible real tab',{})
  const settled=await nativeSnapshot()
  if(settled.panes.filter(p=>p.host==='dock'&&p.tabCount>0).length!==2) fail('split picker populates both real native panes',{panes:settled.panes})
  if (!after.panes.some(p => p.host === 'dock' && p.tabCount > 0)) fail('split panes retain real tab records', { panes:after.panes })
  pass('split creates two native panes through ADB input', { dockPaneCount:after.dockPaneCount, screenshot:tap.screenshot })
  return { before, after }
}
async function exerciseDraftRetention() {
  const selector='[data-sidebar-chat] [contenteditable="true"], [data-dsh-composer] [contenteditable="true"], textarea[placeholder], textarea'
  const composer=await point(selector)
  if(!composer){unavailable('draft retention through workspace switch', 'No visible real conversation composer found in scratch Session');return}
  adb(['shell','input','tap',String(composer.sx),String(composer.sy)])
  // Synthetic harmless draft, entered through Android input. It is never sent.
  adb(['shell','input','text','Independent%stest%sdraft%s261018'])
  await delay(400)
  const hasDraft=await evaluate(selector=>{const e=document.querySelector(selector);return !!e&&((e.value??e.innerText??e.textContent??'').includes('Independent test draft 261018'))},[selector])
  if(!hasDraft)fail('synthetic draft entered through ADB keyboard',{})
  const before=await nativeSnapshot()
  const other=await tapSelector(selectors.pills,1,'draft-switch-away')
  if(!other){unavailable('draft survives workspace switch', 'Could not switch away from draft workspace with a real pill tap');return}
  const back=await tapSelector(selectors.pills,0,'draft-switch-back')
  if(!back){unavailable('draft returns to original workspace', 'Could not return with a real pill tap');return}
  const after=await nativeSnapshot()
  const retained=await evaluate(selector=>{const e=document.querySelector(selector);return !!e&&((e.value??e.innerText??e.textContent??'').includes('Independent test draft 261018'))},[selector])
  if(!retained)fail('unsent draft survives workspace switch', {beforePanes:before.dockPaneCount,afterPanes:after.dockPaneCount})
  pass('synthetic unsent draft survives real workspace switching', {screenshot:back.screenshot})
}
async function exerciseSplitGeometry() {
  return exerciseActualSplitGeometry()
}
async function exerciseActualSplitGeometry() {
  const read = () => evaluate(() => {
    const panel = document.querySelector('[data-dsh-workspaces="2"]'), grid = panel?.querySelector('[data-dockkit-split]')
    if (!grid) return null
    const r=grid.getBoundingClientRect(), vertical=panel.dataset.dshWorkspaceOrientation==='vertical'
    const panes=[...grid.querySelectorAll(':scope > [data-dockkit-host="dock"]')].map(e=>{
      const p=e.getBoundingClientRect(), editor=e.querySelector('textarea,[contenteditable="true"]'), er=editor?.getBoundingClientRect()
      const scroll=[...e.querySelectorAll('*')].filter(n=>{const s=getComputedStyle(n);return /(auto|scroll)/.test(s.overflowY)&&n.clientHeight>0}).map(n=>({height:n.clientHeight,scrollHeight:n.scrollHeight}))
      return {id:e.querySelector('[data-dockkit-pane]')?.getAttribute('data-dockkit-pane'),x:p.x,y:p.y,width:p.width,height:p.height,editor:er?{x:er.x,y:er.y,width:er.width,height:er.height,contained:er.top>=p.top&&er.bottom<=p.bottom&&er.left>=p.left&&er.right<=p.right}:null,scroll}
    }).sort((a,b)=>vertical?a.y-b.y:a.x-b.x)
    return {x:r.x,y:r.y,width:r.width,height:r.height,vertical,panes}
  })
  const before=await nativeSnapshot(), geometry=await read(), divider=await point('[data-dockkit-divider]')
  if(!geometry||geometry.panes.length!==2||!divider) return fail('two measurable split tracks and divider exist',{})
  const extent=geometry.vertical?geometry.height:geometry.width
  const target=geometry.vertical?{x:divider.sx,y:Math.round((geometry.y+extent*.34)*divider.dpr*divider.scale)}:{x:Math.round((geometry.x+extent*.34)*divider.dpr*divider.scale),y:divider.sy}
  await gesture([{x:divider.sx,y:divider.sy},target],100)
  const adjusted=await nativeSnapshot(), sizes=adjusted.splitNodes[0]?.sizes
  if(!sizes||Math.abs(sizes[0]-before.splitNodes[0].sizes[0])<.025) return fail('ADB divider drag changes native sizes',{before:before.splitNodes,after:adjusted.splitNodes})
  pass('divider adjusts actual native sizes',{orientation:geometry.vertical?'vertical':'horizontal',sizes,screenshot:await screenshot('split-ratio')})
  // Probe the real end stop. Pane height alone cannot establish usable input.
  const current=await point('[data-dockkit-divider]')
  const extreme=geometry.vertical?{x:current.sx,y:Math.round((geometry.y+10)*current.dpr*current.scale)}:{x:Math.round((geometry.x+10)*current.dpr*current.scale),y:current.sy}
  await gesture([{x:current.sx,y:current.sy},extreme],100)
  const minimum=await read()
  const measurement={geometry:minimum,nativeSizes:(await nativeSnapshot()).splitNodes[0]?.sizes,screenshot:await screenshot('minimum-pane-usability')}
  writeFileSync(join(out,'minimum-pane-usability.json'),JSON.stringify(measurement,null,2)+'\n')
  const unusable=minimum.panes.filter(p=>p.editor&&(!p.editor.contained||p.editor.height<24||!p.scroll.some(s=>s.height>=48)))
  if(unusable.length) record('minimum split keeps composer and usable scroll area','FAIL',measurement)
  else if(!minimum.panes.every(p=>p.editor)) unavailable('minimum split input usability','One pane has no conversation composer; see minimum-pane-usability.json')
  else pass('minimum split keeps composer and usable scroll area',measurement)
  const center=await point('[data-dockkit-divider]')
  adb(['shell','input','tap',String(center.sx),String(center.sy)])
  adb(['shell','input','tap',String(center.sx),String(center.sy)])
  await delay(400)
  const centered=(await nativeSnapshot()).splitNodes[0]?.sizes
  if(!centered||Math.abs(centered[0]-.5)>.02) fail('divider double tap restores equal native sizes',{centered})
  pass('divider double tap restores equal native sizes',{centered})
}
async function exerciseSwap() {
  const positions=()=>evaluate(()=>[...document.querySelectorAll('[data-dsh-workspaces="2"] [data-dockkit-pane]')].map(e=>{const r=e.getBoundingClientRect();return {id:e.getAttribute('data-dockkit-pane'),x:r.x,y:r.y,width:r.width,height:r.height}}).filter(r=>r.width&&r.height).sort((a,b)=>Math.abs(a.y-b.y)>20?a.y-b.y:a.x-b.x).map(p=>p.id))
  const before=await nativeSnapshot(), order=await positions(), grip=await point('[data-workspace-grip]'), target=await point('[data-dsh-workspaces="2"] [data-dockkit-pane]',1)
  if(!grip||!target) return fail('workspace swap grip exists',{})
  await gesture([{x:grip.sx,y:grip.sy},{x:target.sx,y:target.sy}],100)
  const after=await nativeSnapshot(), next=await positions()
  if(JSON.stringify(next)!==JSON.stringify([...order].reverse())) fail('ADB grip drag reverses physical workspace positions',{order,next})
  if(JSON.stringify(before.dockOrder)!==JSON.stringify(after.dockOrder)) fail('workspace exchange preserves native identities',{before:before.dockOrder,after:after.dockOrder})
  pass('workspace grip drag swaps physical positions with native identity preserved',{screenshot:await screenshot('swap-grip')})
}
async function exercisePillFullscreen() {
  const before = await nativeSnapshot()
  if (before.dockPaneCount !== 2) { unavailable('pill selects one workspace and exits split', 'Needs a live two-pane setup'); return }
  await openPopover()
  const pills = await evaluate(selector => [...document.querySelectorAll(selector)].map((e,i)=>{const r=e.getBoundingClientRect();return {i,selected:e.getAttribute('aria-selected')==='true'||e.getAttribute('aria-pressed')==='true'||e.hasAttribute('data-active'),rect:{x:r.x,y:r.y,width:r.width,height:r.height},disabled:e.getAttribute('aria-disabled')==='true'}}), [selectors.pills])
  if (!pills || pills.length < 2) { unavailable('workspace pills', 'Two visible selection pills are not available'); return }
  const otherIndex=pills.find(p=>!p.selected&&!p.disabled)?.i ?? (pills[0].i===0?1:0)
  const selected = await tapSelector(selectors.pills, otherIndex, 'pill-fullscreen')
  if (!selected) { unavailable('workspace pill touch selection', 'Pill was not visible to ADB tap'); return }
  const after = await nativeSnapshot()
  const fullscreen = await evaluate(() => {
    const p=document.querySelector('[data-sidebar-right-panel]')
    const root=document.querySelector('[data-dsh-workspace-root], [data-workspace-root], [data-dockkit-split]')
    const visiblePanes=[...document.querySelectorAll('[data-dsh-workspaces] [data-dockkit-host="dock"] [data-dockkit-pane]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).display!=='none'})
    return {panelMode:p?.getAttribute('data-sidebar-right-panel'),rootVisible:!!root&&root.getBoundingClientRect().width>0,visiblePaneCount:visiblePanes.length,activeTabs:[...document.querySelectorAll('[data-dockkit-pane-active]')].length}
  })
  if (after.dockPaneCount !== 1 && fullscreen.visiblePaneCount !== 1) fail('pill selection exits split to one full-screen workspace', { nativePanes:after.dockPaneCount, fullscreen })
  if (fullscreen.visiblePaneCount !== 1) fail('pill selection leaves exactly one presented pane', fullscreen)
  pass('pill selects a workspace and exits split', { fullscreen, remainingStorePaneCount:after.dockPaneCount, screenshot:selected.screenshot })
}
async function exerciseFloatMru() {
  const before = await nativeSnapshot()
  const floatButton = await tapSelector(selectors.smallWindow, 0, 'float-small-window')
  if (!floatButton) { unavailable('small-window button', 'No visible small-window control matched selector contract'); return }
  const floated = await nativeSnapshot()
  if (floated.floatCount < 1) fail('small-window action floats the real active tab', { floatCount:floated.floatCount, panes:floated.panes })
  const floatGeometry = floated.geometry.filter(g=>g.visible && g.type === 'float')
  const viewport = floated.viewport
  if (floatGeometry.length && floatGeometry.some(g=>g.x<0||g.y<0||g.x+g.width>viewport.width||g.y+g.height>viewport.height)) fail('floating pane stays within viewport', { floatGeometry, viewport })
  const floats = floated.panes.filter(p=>p.host==='float')
  if (!floats.length || floats.some(p=>p.tabCount!==1)) fail('each floating workspace reuses exactly one native tab', { floats })
  // Tapping a different recent pill while a float is visible must raise/select
  // that same live tab, not create another provider or Session occurrence.
  const tabKindsBefore = floated.panes.flatMap(p=>p.tabKinds).sort()
  const dockTab=floated.panes.find(p=>p.host==='dock'&&p.tabIds.length)?.tabIds[0]
  await openPopover()
  const pillTap = dockTab ? await tapSelector('[data-dsh-bubble-select='+JSON.stringify(dockTab)+']', 0, 'float-mru-switch') : null
  if (!pillTap) { unavailable('float MRU selection', 'Could not tap a second visible recent workspace pill'); return }
  const afterSwitch = await nativeSnapshot()
  if (afterSwitch.floatCount !== floated.floatCount) fail('MRU switch reuses existing floating instance', { before:floated.floatCount, after:afterSwitch.floatCount })
  if (JSON.stringify(afterSwitch.panes.flatMap(p=>p.tabKinds).sort()) !== JSON.stringify(tabKindsBefore)) fail('MRU switch preserves native tab kinds', { before:tabKindsBefore, after:afterSwitch.panes.flatMap(p=>p.tabKinds) })
  pass('small-window and MRU switch reuse live workspace instances', { floatCount:afterSwitch.floatCount, screenshot:floatButton.screenshot, switchScreenshot:pillTap.screenshot })
}
async function exerciseDragGate() {
  await openPopover()
  const start = await point(selectors.pills, 0)
  const target = await point('[data-dockkit-pane], [data-dsh-workspace-pane], [data-workspace-pane]', 1)
  if (!start || !target) { unavailable('safe-area drag migration', 'Need a visible source pill and second pane target'); return }
  const nativeScale = start.dpr * start.scale
  const popover = await point('.dsh-bubble-popover[data-state="open"]')
  const marginPx = 24 * nativeScale
  const down = {x:start.sx,y:start.sy}
  // First release at 23dp from the source edge: must cancel without preview or
  // mutation. The next independent attempt crosses 24dp and waits 150ms before
  // requiring preview state. Both are actual Android motion events.
  const before = await nativeSnapshot()
  adb(['shell','input','motionevent','DOWN',String(down.x),String(down.y)])
  await delay(450)
  const safeEdge={x:Math.round((popover.rect.x-16)*nativeScale),y:down.y}
  adb(['shell','input','motionevent','MOVE',String(safeEdge.x),String(safeEdge.y)])
  await delay(220)
  const safePreview=await evaluate(selector=>!!document.querySelector(selector),[selectors.dragPreview])
  adb(['shell','input','motionevent','UP',String(safeEdge.x),String(safeEdge.y)])
  await delay(400)
  const canceled = await nativeSnapshot()
  const previewAfterCancel = await evaluate(selector=>!!document.querySelector(selector), [selectors.dragPreview])
  if (JSON.stringify(canceled.panes)!==JSON.stringify(before.panes)) fail('drag inside 24dp safe margin is canceled without store mutation', { before:before.panes, after:canceled.panes })
  if (previewAfterCancel||safePreview) fail('drag inside safe margin does not show or leave preview', {})
  const far = {x:target.sx,y:target.sy}
  adb(['shell','input','motionevent','DOWN',String(down.x),String(down.y)])
  await delay(450)
  const moveStarted=Date.now()
  adb(['shell','input','motionevent','MOVE',String(far.x),String(far.y)])
  const early = await evaluate(selector=>!!document.querySelector(selector), [selectors.dragPreview])
  const observedElapsed=Date.now()-moveStarted
  await delay(200)
  const gated = await evaluate(selector=>!!document.querySelector(selector), [selectors.dragPreview])
  adb(['shell','input','motionevent','CANCEL',String(far.x),String(far.y)])
  await delay(450)
  if (!early && !gated) unavailable('150ms drag preview gate', 'No preview signal selector is exposed; do not infer a pass from final state')
  else if (early && observedElapsed<150) fail('drag preview does not appear before the 150ms threshold', { early, gated, observedElapsed })
  else if(observedElapsed>=150) unavailable('150ms drag preview exact timing','ADB/CDP roundtrip exceeded the threshold; gate cannot be judged from this observation')
  else pass('safe-area cancel and delayed drag preview are distinguishable', { early, gated, observedElapsed, screenshot:await screenshot('drag-preview-gate') })
  await tapSelector('[data-dsh-sidebar-bubbles-toggle]',0,'drag-popover-collapse')
}
async function exercisePillChromeAndReorder() {
  await openPopover()
  const read=()=>evaluate(()=>{
    const nav=document.querySelector('.dsh-bubble-popover'),r=nav.getBoundingClientRect()
    return {theme:document.body.hasAttribute('data-ds-dark-theme')?'dark':'light',bounds:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},rows:[...nav.querySelectorAll('[data-dsh-bubble-tab]')].map(e=>{const s=getComputedStyle(e),p=getComputedStyle(e.querySelector('button'));return {id:e.getAttribute('data-dsh-bubble-tab'),selected:e.hasAttribute('data-selected'),bg:s.backgroundColor,color:p.color,radius:s.borderRadius}})}
  })
  const before=await read()
  if(before.rows.length<2) fail('two real workspace pills exist',{})
  if(before.bounds.x<0||before.bounds.y<0||before.bounds.x+before.bounds.width>before.viewport.width+1||before.bounds.y+before.bounds.height>before.viewport.height+1) fail('popover stays in visible safe bounds',before)
  const selected=before.rows.find(r=>r.selected),other=before.rows.find(r=>!r.selected)
  if(!selected||!other||selected.bg===other.bg) fail('selected pill has a distinct computed background',before)
  pass('pill appearance and safe bounds in '+before.theme+' theme',{...before,screenshot:await screenshot('pill-colors-'+before.theme)})
  const from=await point(selectors.pills,0),to=await point(selectors.pills,1)
  adb(['shell','input','motionevent','DOWN',String(from.sx),String(from.sy)])
  await delay(450)
  const destination={x:to.sx,y:Math.round((to.rect.y+to.rect.height*.85)*to.dpr*to.scale)}
  await gestureMoveAndRelease(destination)
  const after=await read()
  if(JSON.stringify(before.rows.map(r=>r.id))===JSON.stringify(after.rows.map(r=>r.id))) fail('long press reorders real native tabs',{before:before.rows.map(r=>r.id),after:after.rows.map(r=>r.id)})
  const state=await nativeSnapshot()
  if(state.dockOrder[0].tabTokens.length!==after.rows.length) fail('pill reorder preserves native tab count',{})
  pass('long press reorders pills through ADB',{screenshot:await screenshot('pill-reordered')})
  await tapSelector('[data-dsh-sidebar-bubbles-toggle]',0,'pill-collapsed')
  const closed=await evaluate(()=>{const e=document.querySelector('.dsh-bubble-popover');return {state:e?.getAttribute('data-state'),inert:e?.hasAttribute('inert'),hidden:e?.getAttribute('aria-hidden')}})
  if(closed.state!=='closed'||!closed.inert||closed.hidden!=='true') fail('collapsed popover removes touch and accessibility access',closed)
  pass('collapsed popover is inert and hidden',closed)
}
async function gestureMoveAndRelease(target) {
  adb(['shell','input','motionevent','MOVE',String(target.x),String(target.y)])
  await delay(180)
  adb(['shell','input','motionevent','UP',String(target.x),String(target.y)])
  await delay(500)
}
async function exerciseCloseFallback() {
  const before = await nativeSnapshot()
  const count = before.panes.reduce((sum,p)=>sum+p.tabCount,0)
  if (!count) { unavailable('close fallback', 'No native tab to close'); return }
  const tap = await tapSelector(selectors.close, 0, 'close-fallback')
  if (!tap) { unavailable('close fallback user action', 'No visible close control matched selector contract'); return }
  const after = await nativeSnapshot()
  const next = after.panes.reduce((sum,p)=>sum+p.tabCount,0)
  if (next >= count) fail('closing the test tab updates native store', { before:count, after:next })
  if (!after.activeKind && next > 0) fail('close selects a surviving native workspace', { activeKind:after.activeKind, panes:after.panes })
  pass('close removes one tab and falls back to a surviving workspace', { before:count, after:next, activeKind:after.activeKind, screenshot:tap.screenshot })
}
async function exerciseCapabilityRefusal() {
  const before = await nativeSnapshot()
  const caps = await evaluate(async () => {
    const bridge=window.androidBridge
    if (typeof bridge?.vdisplayStatus!=='function') return {available:false,reason:'vdisplayStatus bridge unavailable'}
    try { return {available:true,status:JSON.parse(await bridge.vdisplayStatus())} }
    catch(e) { return {available:true,error:String(e)} }
  })
  if (!caps?.available || caps.error || !caps.status) { unavailable('virtual-screen capability refusal', caps?.reason ?? caps?.error ?? 'No authoritative capability status'); return }
  const capPayload = caps.status.capabilities ?? caps.status.caps ?? caps.status
  const state = String(capPayload.state ?? '').toLowerCase()
  const supported = capPayload.supported ?? capPayload.available ?? capPayload.virtualDisplaySupported
  const explicitlyUnsupported = supported === false || ['blocked','disabled','unsupported'].includes(state)
  if (!explicitlyUnsupported) {
    unavailable('virtual-screen capability refusal', 'The live capability source does not prove an unsupported/blocked state; refusing to infer a negative test from device ABI or missing fields')
    return
  }
  const refusalControl = await point('[data-dsh-capability-disabled="true"], [data-workspace-capability="unsupported"], [aria-disabled="true"][data-capability]')
  if (!refusalControl) { unavailable('virtual-screen capability refusal', 'Device says capability unsupported but no user-facing disabled/refusal affordance is present'); return }
  await adb(['shell','input','tap',String(refusalControl.sx),String(refusalControl.sy)])
  await delay(350)
  const after = await nativeSnapshot()
  if (JSON.stringify(after.panes)!==JSON.stringify(before.panes)) fail('unsupported capability refusal leaves native workspace state unchanged', { before:before.panes, after:after.panes })
  const reason = await evaluate(() => document.querySelector('[data-dsh-capability-reason], [data-capability-reason]')?.textContent?.trim() ?? null)
  if (!reason) unavailable('virtual-screen refusal reason', 'No visible capability reason was exposed after the attempted action')
  else pass('unsupported virtual-screen capability is refused without workspace mutation', { reason: safeString(reason), screenshot:await screenshot('capability-refusal') })
}

async function connect() {
  if (wsPort) spawnSync(adbBin,['-s',serial,'forward','--remove','tcp:'+wsPort],{encoding:'utf8'})
  const pid = adb(['shell','pidof','com.dsharnessmobile.shell']).toString().trim().split(/\s+/)[0]
  if (!pid) throw new Error('shell process is not running')
  const socketName = 'webview_devtools_remote_' + pid
  const port = adb(['forward','tcp:0','localabstract:' + socketName]).toString().trim()
  if (!/^\d+$/.test(port)) throw new Error('ADB could not allocate a CDP forward for ' + socketName)
  wsPort = port; cdpPid = pid; cdpTarget = undefined
  const deadline=Date.now()+30000
  while(Date.now()<deadline) {
    try {
      const roster=await fetch(`http://127.0.0.1:${wsPort}/json/list`).then(r=>r.json())
      cdpTarget=roster.find(t=>t.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\//.test(t.url))
      if(cdpTarget?.webSocketDebuggerUrl) break
    } catch {}
    await delay(300)
  }
  if(!cdpTarget) throw new Error('main WebView CDP page target was not found')
  try { ws?.close() } catch {}
  for (const [id, waiter] of inflight) { clearTimeout(waiter.timer); waiter.reject(new Error('CDP target refreshed')); inflight.delete(id) }
  const socket = new WebSocket(cdpTarget.webSocketDebuggerUrl)
  ws = socket
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})})
  socket.addEventListener('message', event => {
    if (ws !== socket) return
    const message=JSON.parse(String(event.data)), waiter=inflight.get(message.id)
    if(!waiter)return
    clearTimeout(waiter.timer);inflight.delete(message.id)
    if(message.error)waiter.reject(new Error(safeString(message.error.message)))
    else waiter.resolve(message)
  })
}
async function ensureConnection() {
  const pid = adb(['shell','pidof','com.dsharnessmobile.shell']).toString().trim().split(/\s+/)[0]
  if (!pid) throw new Error('shell process is not running')
  if (!ws || ws.readyState !== WebSocket.OPEN || pid !== cdpPid) { await connect(); return }
  try {
    const roster=await fetch(`http://127.0.0.1:${wsPort}/json/list`).then(r=>r.json())
    const live=roster.find(t=>t.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\//.test(t.url))
    if (!live?.webSocketDebuggerUrl || live.id !== cdpTarget?.id || live.webSocketDebuggerUrl !== cdpTarget?.webSocketDebuggerUrl) { await connect(); return }
    cdpTarget = live
  } catch { await connect() }
}

try {
  await connect()
  const fingerprint = adb(['shell','run-as','com.dsharnessmobile.shell','cat','files/.snapshot-fingerprint']).toString().trim()
  const transaction = adb(['shell','run-as','com.dsharnessmobile.shell','sh','-c',"'if test -e files/.snapshot-transaction; then echo ACTIVE; else echo ABSENT; fi'"]).toString().trim()
  assert.ok(fingerprint, 'snapshot fingerprint missing')
  assert.equal(transaction, 'ABSENT', 'snapshot transaction is still active')
  const env = {
    serial,
    appVersion: adb(['shell','dumpsys','package','com.dsharnessmobile.shell']).toString().match(/versionName=([^\s]+)/)?.[1] ?? null,
    abi: adb(['shell','getprop','ro.product.cpu.abi']).toString().trim(),
    fingerprint,
    cdpTargetId: cdpTarget.id,
    cdpUrl: cdpTarget.url,
  }
  const ready = argv.includes('--inspect-only') ? await nativeSnapshot() : await assertMountedAndReady()
  if (argv.includes('--inspect-only')) writeFileSync(join(out,'device-readonly-native.json'),JSON.stringify({mounted:!!ready.mounted,activeKind:ready.activeKind,dockPaneCount:ready.dockPaneCount,floatCount:ready.floatCount,splitNodes:ready.splitNodes,uiMarkers:ready.uiMarkers,viewport:ready.viewport},null,2)+'\n')
  const services = await liveServices()
  if (services.right.openResource !== 'function' || services.sessionCreate !== 'function' || services.ui.openSession !== 'function') {
    fail('live native APIs are present', { services: { right:Object.keys(services.right), ui:Object.keys(services.ui) } })
  }
  pass('preflight: app, CDP, snapshot, and real native stores', { appVersion:env.appVersion, abi:env.abi, viewport:ready.viewport, target:env.cdpTargetId })
  writeFileSync(join(out,'device-environment.json'),JSON.stringify(env,null,2)+'\n')
  if (!argv.includes('--inspect-only')) {
  const sessions = await createScratchSessions()
  const scratchBaseline = await nativeSnapshot()
  if (scratchBaseline.sessionIds.filter(id=>sessions.includes(id)).length !== 2) fail('both scratch Sessions are present in native session store', { scratchCount:sessions.length })
  pass('isolated scratch Sessions created through live workspace service', { count:sessions.length, screenshot:await screenshot('scratch-session-baseline') })
  await exercisePillChromeAndReorder()

  const orientation = opt('orientation') ?? 'both'
  const first = orientation === 'landscape' ? 'landscape' : 'portrait'
  await rotate(first)
  let state = await nativeSnapshot()
  let expected = first === 'portrait' ? state.viewport.height > state.viewport.width : state.viewport.width > state.viewport.height
  if (!expected) fail(`${first} orientation is reflected in WebView viewport`, { viewport:state.viewport })
  pass(`${first} viewport`, { viewport:state.viewport, screenshot:await screenshot(`${first}-baseline`) })
  await assertSplitAfterInput()
  await exerciseSplitGeometry()
  if (orientation === 'both') {
    await rotate(first === 'portrait' ? 'landscape' : 'portrait')
    state = await nativeSnapshot()
    const second = first === 'portrait' ? 'landscape' : 'portrait'
    expected = second === 'portrait' ? state.viewport.height > state.viewport.width : state.viewport.width > state.viewport.height
    if (!expected) fail(`${second} orientation is reflected in WebView viewport`, { viewport:state.viewport })
    if(state.dockPaneCount!==2) fail('two-workspace layout survives orientation change', {dockPaneCount:state.dockPaneCount})
    pass(`${second} rotation preserves both workspaces`, {viewport:state.viewport,screenshot:await screenshot(`${second}-split`)})
    await exerciseSplitGeometry()
  }
  await exerciseSwap()
  await exerciseDragGate()
  await exercisePillFullscreen()
  await exerciseDraftRetention()
  // Re-enter a split through its real user control before testing a small window.
  await assertSplitAfterInput()
  await exerciseFloatMru()
  await exerciseCloseFallback()
  await exerciseCapabilityRefusal()

  // The model task is deliberately separate from scripted UI setup. Do not claim
  // a real orchestration pass unless a separate test-session transcript and
  // observed tool-call trace are supplied by the caller.
  if (opt('model-evidence')) {
    const model = JSON.parse(await import('node:fs').then(m => m.readFileSync(resolve(opt('model-evidence')), 'utf8')))
    if (model.sessionKind !== 'independent-test' || model.targetConstraints !== true || !Array.isArray(model.toolCalls) || model.toolCalls.length < 4 || model.result !== 'success') {
      unavailable('model-orchestrated real task', 'Evidence does not prove an independent test session, goal-plus-constraints prompt, and multi-call completion')
    } else pass('model-orchestrated real task', { toolCallCount:model.toolCalls.length, result:model.result })
  } else unavailable('model-orchestrated real task', 'No independent test-session task trace supplied; scripted UI coverage is not a substitute')
  for(const [name,reason] of [
    ['both light and dark pill acceptance','This run captures the current actual theme; the second theme requires a real theme UI action and screenshot'],
    ['browser/terminal/conversation combination matrix','Requires separate live provider setup after the final APK is installed'],
    ['small window without an alternative workspace','The two-conversation setup establishes MRU only; a separate one-tab setup is required'],
    ['successful pill migration into an existing workspace','This run probes the gate and cancellation; a committed migration requires a separate destination identity assertion'],
  ]) unavailable(name,reason)
  }
} catch (error) {
  if (!checks.some(c=>c.status==='FAIL')) record('runner error', 'FAIL', { error:safeString(error?.stack ?? error) })
  process.exitCode=1
} finally {
  try { await restoreRotation() } catch(error) { record('restore device orientation', 'FAIL', {error:safeString(error)}) }
  // Restore only navigation to the originally selected Session. Scratch data is
  // retained as evidence and is never deleted or archived by this test runner.
  if (restoreSession) {
    try { await useService((ctx,id)=>ctx.get('uiWorkspace').openSession(id), restoreSession); await delay(500) }
    catch(error) { record('restore original selected session', 'FAIL', {error:safeString(error)}) }
  }
  try { if(ws) ws.close() } catch {}
  if(wsPort) spawnSync(adbBin,['-s',serial,'forward','--remove','tcp:'+wsPort],{encoding:'utf8'})
  const report={
    suite:argv.includes('--inspect-only')?'independent-mobile-workspaces-readonly-preflight':'independent-mobile-workspaces', serial, generatedAt:new Date().toISOString(),
    status:checks.some(c=>c.status==='FAIL')?'FAIL':checks.some(c=>c.status==='INCONCLUSIVE')?'INCONCLUSIVE':checks.some(c=>c.status==='NOT RUN')?'NOT RUN':'PASS',
    checks, screenshots, adbCommands:commands.map(c=>c.map((arg,i)=>i===0?'adb':arg)),
    note:'No feature test is considered passed solely because a marker exists; outcomes combine real ADB input, the rendered WebView, and the native mounted store. No app data is deleted.'
  }
  writeFileSync(join(out,'independent-report.json'),JSON.stringify(report,null,2)+'\n')
  writeFileSync(join(out,'independent-commands.json'),JSON.stringify(commands,null,2)+'\n')
  if(report.status==='FAIL') process.exitCode=1
  else if(report.status==='INCONCLUSIVE') process.exitCode=2
  console.log(JSON.stringify({status:report.status,out,checkCount:checks.length,screenshotCount:screenshots.length},null,2))
}
