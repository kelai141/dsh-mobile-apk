#!/usr/bin/env node
// Usage: node scripts/verify-webui-navigation.mjs --serial <device> --json <report>
// The app must show an engine WebView on a debug build. Navigation actions use
// trusted CDP taps and ADB Back. No screenshots or model/service credentials.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as wait } from 'node:timers/promises'

const arg = name => process.argv[process.argv.indexOf(name) + 1]
const serial = process.argv.includes('--serial') ? arg('--serial') : ''
if (!serial) {
  console.error('Usage: node scripts/verify-webui-navigation.mjs --serial <device> --json <report>')
  process.exit(2)
}
const app = 'com.dsharnessmobile.shell'
const adb = (...args) => execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8', timeout: 15_000 }).trim()
const report = { serial, started: new Date().toISOString(), cases: [] }
const save = () => {
  const json = JSON.stringify(report, null, 2)
  if (process.argv.includes('--json')) writeFileSync(arg('--json'), json + '\n')
  console.log(json)
}
const until = async (read, accept, title) => {
  const deadline = Date.now() + 6000
  let actual
  do {
    actual = await read()
    if (accept(actual)) return actual
    await wait(100)
  } while (Date.now() < deadline)
  throw new Error(title + ' wait expired, last state ' + JSON.stringify(actual))
}
const pageState = "(" + (() => {
  const frame = document.querySelector('[data-dsh-frame]')
  const settings = document.querySelector('[data-dsh-settings-dialog]')
  const sublayer = document.querySelector('[data-dsh-settings-dialog] [data-dsh-settings-sublayer], [data-dsh-linux-environment-panel] [data-dsh-settings-sublayer]')
  const linux = document.querySelector('[data-dsh-linux-environment-panel]')
  const backdrop = document.querySelector('[data-dsh-composer-sheet-backdrop]:not([data-dsh-composer-sheet-leaving])')
  const panel = backdrop?.querySelector('[data-dsh-composer-sheet-panel]')
  const bounds = panel?.getBoundingClientRect()
  const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible'
  const sectionButton = settings?.querySelector('nav button[aria-current="true"]')?.cloneNode(true)
  sectionButton?.querySelectorAll('[data-dsh-settings-nav-desc], [data-dsh-settings-nav-chevron], svg')
    .forEach(node => node.remove())
  return {
    controller: typeof window.__dshNavigationBack === 'function',
    layout: document.documentElement.hasAttribute('data-dsh-mobile-form') ? 'phone' : 'wide',
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    imeInset: Math.round(Math.max(innerHeight - (visualViewport?.height ?? innerHeight),
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-android-page-ime-overlap')) || 0)),
    stack: window.__dshBackKinds,
    drawer: !!frame && !frame.hasAttribute('data-sidebar-collapsed'),
    settings: settings?.getAttribute('data-dsh-settings-level') ?? (settings ? 'wide' : null),
    section: sectionButton?.textContent?.trim() ?? null,
    sublayer: sublayer?.getAttribute('data-dsh-settings-sublayer-title') ?? null,
    linux: !!linux,
    linuxBack: [...(linux ?? settings ?? document.body).querySelectorAll('[data-dsh-linux-back], [data-dsh-settings-back], [data-dsh-settings-sublayer-back], [data-linux-action="back"]')].filter(visible).length,
    history: history.length,
    url: location.pathname + location.hash,
    pluginPanel: !!document.querySelector('[data-plugin-panel]'),
    pluginDetail: !!document.querySelector('[data-plugin-detail], [data-plugin-item-detail], [data-plugin-row-detail]'),
    composerSheet: !!backdrop,
    sheetGeometry: bounds && backdrop ? {
      form: backdrop.getAttribute('data-dsh-composer-sheet-form'),
      waiting: backdrop.hasAttribute('data-dsh-composer-sheet-waiting-ime'),
      bottomGap: Math.round(backdrop.getBoundingClientRect().bottom - bounds.bottom),
      heightCap: window.__dshComposerSheet?.max ?? null,
      hitsPanel: panel.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 24)),
      position: getComputedStyle(panel).position,
      bottom: getComputedStyle(panel).bottom,
      zIndex: getComputedStyle(backdrop).zIndex,
    } : null,
  }
}).toString() + ")()"

let ws
let port
let evalPage
let seq = 0
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => finish(new Error(method + ' timed out')), 8000)
    const finish = (error, result) => {
      clearTimeout(timer)
      ws.removeEventListener('message', receive)
      ws.removeEventListener('close', closed)
      if (error) reject(error)
      else resolve(result)
    }
    const closed = () => finish(new Error('CDP target closed'))
    const receive = event => {
      const reply = JSON.parse(event.data)
      if (reply.id !== id) return
      if (reply.error || reply.result?.exceptionDetails) {
        finish(new Error(reply.error?.message ?? reply.result.exceptionDetails.text))
      } else finish(null, reply.result)
    }
    ws.addEventListener('message', receive)
    ws.addEventListener('close', closed)
    ws.send(JSON.stringify({ id, method, params }))
  })
}
const anchored = sample => sample.sheetGeometry?.form === 'sheet' &&
  !sample.sheetGeometry.waiting && sample.sheetGeometry.bottomGap === 0 &&
  sample.sheetGeometry.hitsPanel && sample.sheetGeometry.position === 'absolute' &&
  sample.sheetGeometry.bottom === '0px' && sample.sheetGeometry.zIndex === '2147483647'
const state = () => evalPage(pageState)
const androidBack = () => adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
const focus = () => adb('shell', 'dumpsys', 'window')
  .split(/\r?\n/).filter(line => /mCurrentFocus=Window/.test(line)).map(line => line.trim())

async function findControl(selector, label) {
  return evalPage("(" + ((query, name) => {
    const visible = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible'
    const button = [...document.querySelectorAll(query)].find(node => {
      if (!visible(node) || node.disabled === true) return false
      if (name === null) return true
      const copy = node.cloneNode(true)
      copy.querySelectorAll('[data-dsh-settings-nav-desc], [data-dsh-settings-nav-chevron]').forEach(item => item.remove())
      return new RegExp(name, 'i').test((node.getAttribute('aria-label') || copy.textContent || '').trim())
    })
    if (!button) return null
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const rect = button.getBoundingClientRect()
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    if (!button.contains(document.elementFromPoint(x, y))) return null
    return { x, y }
  }).toString() + ")(" + JSON.stringify(selector) + ',' + JSON.stringify(label) + ")")
}
async function tap(selector, label = null) {
  const { x, y } = await until(() => findControl(selector, label), Boolean, label ?? selector)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
}
async function androidTap(selector) {
  const { x, y } = await until(() => findControl(selector, null), Boolean, selector)
  const { dpr } = (await state()).viewport
  adb('shell', 'input', 'tap', String(Math.round(x * dpr)), String(Math.round(y * dpr)))
}
const nativeImeShown = () => /\bmInputShown=true\b/.test(adb('shell', 'dumpsys', 'input_method'))

async function testSheetFromKeyboard(attach) {
  const editor = '[data-composer-card] [contenteditable="true"]'
  try {
    await androidTap(editor)
    await until(async () => ({ shown: nativeImeShown(), page: await state() }),
      value => value.shown && value.page.imeInset > 0, 'Android soft keyboard')
  } catch (error) {
    if (nativeImeShown()) androidBack()
    await evalPage('document.activeElement?.blur(); true')
    skip('Composer sheet from Android soft keyboard', error.message)
    return
  }
  await record('Composer sheet from Android soft keyboard', 'ADB tap, Android IME and CDP',
    'Keyboard closes, then the sheet sits flush with the viewport bottom',
    () => androidTap(attach), sample => anchored(sample) && sample.imeInset === 0 && !nativeImeShown())
  if ((await state()).composerSheet) {
    await record('Composer sheet after keyboard dismissal', 'ADB KEYCODE_BACK', 'Conversation',
      androidBack, sample => !sample.composerSheet && sample.imeInset === 0)
  }
}

async function record(page, source, expected, action, accepts) {
  const row = { page, source, expected, before: await state() }
  report.cases.push(row)
  try {
    await action()
    row.actual = await until(state, accepts, page)
    row.focus = focus()
    if (!row.focus.some(line => line.includes(app + '/'))) throw new Error('App has no focused window')
    row.result = 'PASS'
  } catch (error) {
    row.result = 'FAIL'
    row.error = error.message
    row.actual = await state().catch(() => null)
  }
  return row.result === 'PASS'
}
function skip(page, reason) { report.cases.push({ page, result: 'NOT RUN', reason }) }

async function openDrawer() {
  if (!(await state()).drawer) await tap('[data-dsh-sidebar-toggle]')
  await until(state, sample => sample.drawer, 'drawer')
}

async function openSettings() {
  await openDrawer()
  const direct = 'button[aria-label="设置"],button[aria-label="Settings"]'
  if (await findControl(direct, null)) await tap(direct)
  else {
    await tap('button', '^(账号菜单|Account menu)$')
    await tap('[role="menuitem"],button', '^(设置|Settings)$')
  }
  await until(state, sample => sample.settings !== null, 'settings')
}

async function linuxChildren() {
  for (const [action, name] of [['toolchains', '工具链|Toolchains'], ['terminal', '终端|Terminal']]) {
    if (!(await findControl('[data-linux-action="' + action + '"]', null))) {
      skip('Linux / ' + action, 'The installed runtime exposes no enabled control')
      continue
    }
    await tap('[data-linux-action="' + action + '"]')
    await until(state, sample => new RegExp(name).test(sample.sublayer ?? ''), action)
    await record('Linux / ' + action, 'ADB KEYCODE_BACK', 'Linux overview with one visible back control',
      androidBack, sample => sample.linux && sample.sublayer === null && sample.linuxBack === 1)
  }
}

try {
  report.package = adb('shell', 'dumpsys', 'package', app).split(/\r?\n/)
    .find(line => line.includes('versionName='))?.trim()
  const pid = adb('shell', 'pidof', app).split(/\s+/)[0]
  port = adb('forward', 'tcp:0', 'localabstract:webview_devtools_remote_' + pid)
  const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(5000) })
  const targets = await response.json()
  const main = targets.find(item => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(item.url))
  if (!main) throw new Error('No engine WebView target')
  ws = new WebSocket(main.webSocketDebuggerUrl)
  await Promise.race([
    new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    }),
    wait(5000, undefined, { ref: false }).then(() => { throw new Error('CDP connection timed out') }),
  ])
  evalPage = async expression => (await cdp('Runtime.evaluate', { expression, returnByValue: true })).result.value
  report.initial = await until(state, sample => sample.controller && Array.isArray(sample.stack),
    'WebUI navigation controller')
  await evalPage('window.__dshNavigationTrace = true')
  if (report.initial.settings !== null || report.initial.linux) {
    throw new Error('Start the suite from the Conversation so it does not dismiss user work')
  }
  if (report.initial.layout === 'phone') {
    await openDrawer()
    await record('Conversation drawer', 'ADB KEYCODE_BACK', 'Conversation', androidBack,
      sample => !sample.drawer && !sample.stack.includes('drawer'))
  }
  if (report.initial.settings === null && !report.initial.linux && (await state()).stack.length === 0) {
    const attach = 'button[aria-label="添加文件或调用指令"],button[aria-label="Add files or run commands"]'
    if (await findControl(attach, null)) {
      await tap(attach)
      await until(state, sample => sample.composerSheet, 'composer attachment sheet')
      if ((await state()).layout === 'phone') {
        await record('Composer sheet geometry', 'CDP geometry and hit test',
          'Sheet flush with viewport bottom and hit above underlying controls', () => {}, anchored)
        const cap = (await state()).sheetGeometry?.heightCap
        await record('Composer sheet during IME inset update', 'CDP simulated IME event',
          'Same bottom anchor, height cap and hit target', async () => {
            await evalPage("(" + (() => {
              const style = document.documentElement.style
              const key = '--dsh-android-page-ime-overlap'
              const before = style.getPropertyValue(key)
              const priority = style.getPropertyPriority(key)
              try {
                style.setProperty(key, '180px')
                window.dispatchEvent(new Event('dsh-page-ime-change'))
              } finally {
                if (before) style.setProperty(key, before, priority)
                else style.removeProperty(key)
              }
              return true
            }).toString() + ")()")
          }, sample => anchored(sample) && sample.sheetGeometry?.heightCap === cap)
      }
      const closed = await record('Composer attachment sheet', 'ADB KEYCODE_BACK', 'Conversation, same history',
        androidBack, sample => !sample.composerSheet && sample.history === report.initial.history)
      if (closed && report.initial.layout === 'phone' && process.argv.includes('--real-ime')) {
        await testSheetFromKeyboard(attach)
      }
    } else skip('Composer attachment sheet', 'The current session exposes no enabled attachment button')
  }
  if (report.initial.settings === null && !report.initial.linux) {
    await openSettings()
    const names = await evalPage("(" + (() => [...document.querySelectorAll('[data-dsh-settings-dialog] nav button')]
      .map(button => {
        const copy = button.cloneNode(true)
        copy.querySelectorAll('[data-dsh-settings-nav-desc], [data-dsh-settings-nav-chevron]').forEach(item => item.remove())
        return copy.textContent.trim()
      }).filter(Boolean)).toString() + ")()")
    report.settingsSections = names
    if (report.initial.layout === 'phone') {
      for (const name of names) {
        const pattern = '^' + name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&') + '$'
        if (!(await findControl('[data-dsh-settings-dialog] nav button', pattern))) {
          if (!/^(关于|About)$/.test(name)) skip('Settings / ' + name, 'Currently hidden or unavailable')
          continue
        }
        await tap('[data-dsh-settings-dialog] nav button', pattern)
        await until(state, sample => sample.settings === 'detail', name)
        if (/^(通用设置|General settings|General)$/.test(name)) {
          const about = '[data-dsh-about-entry]'
          if (await findControl(about, null)) {
            await tap(about)
            await until(state, sample => /关于|About/.test(sample.section ?? ''), 'About')
            await record('Settings / General / About', 'ADB KEYCODE_BACK', 'General settings',
              androidBack, sample => /通用|General/.test(sample.section ?? '') && sample.settings === 'detail')
          } else skip('Settings / General / About', 'About entry is unavailable')
        }
        if (/^(手机控制|Phone control)$/.test(name)) {
          for (const label of ['无障碍通道|Accessibility channel', 'Shizuku 授权|Shizuku access', '虚拟屏设置|Virtual screen settings', '高级设置与诊断|Advanced and diagnostics', 'Root 权限|Root access']) {
            const candidates = '[data-plugin="dev-phone-control"] button'
            if (!(await findControl(candidates, label))) {
              skip('Phone control / ' + label, 'Subpage entry is unavailable in this configuration')
              continue
            }
            await tap(candidates, label)
            await until(state, sample => new RegExp(label).test(sample.sublayer ?? ''), label)
            const returned = await record('Phone control / ' + label, 'ADB KEYCODE_BACK', 'Phone control overview',
              androidBack, sample => sample.settings === 'detail' && sample.sublayer === null)
            if (!returned) break
          }
        }
        const ok = await record('Settings / ' + name, 'ADB KEYCODE_BACK', 'Settings home', androidBack,
          sample => sample.settings === 'home')
        if (!ok) break
      }
    }
    const parent = await state()
    if (parent.settings === 'home' || parent.settings === 'wide') {
      await record('Settings root', 'ADB KEYCODE_BACK', 'Previous screen', androidBack,
        sample => sample.settings === null)
    }
  }
  const idle = await state()
  if (idle.settings === null) {
    if (!idle.linux) {
      await openDrawer()
      const linuxEntry = '^(Linux\\s*环境|Linux environment)$'
      if (await findControl('button,[role="button"]', linuxEntry)) {
        await tap('button,[role="button"]', linuxEntry)
        await until(state, sample => sample.linux && (sample.layout === 'wide' || !sample.drawer), 'Linux panel')
      } else skip('Linux panel', 'No Linux panel entry on this engine configuration')
    }
    if ((await state()).linux) {
      await linuxChildren()
      await record('Linux overview', 'WebUI back control', 'Conversation', () => tap('[data-dsh-linux-back]'),
        sample => !sample.linux && !sample.stack.includes('main-panel'))
    }
  }
  if ((await state()).settings === null && !(await state()).linux) {
    await openDrawer()
    const candidates = '[data-dsh-frame] button,[data-dsh-frame] [role="button"]'
    const label = '^(插件|Plugins|插件管理|Manage plugins)$'
    if (await findControl(candidates, label)) {
      await tap(candidates, label)
      await until(state, sample => sample.pluginPanel, 'Plugin manager')
      await record('Plugin manager', 'ADB KEYCODE_BACK', 'Previous conversation',
        androidBack, sample => !sample.pluginPanel)
    } else {
      skip('Plugin manager', 'Sidebar does not expose a matching plugin control')
      if ((await state()).layout === 'phone' && (await state()).drawer) androidBack()
    }
  }
  process.exitCode = report.cases.some(item => item.result === 'FAIL') ? 1
    : report.cases.some(item => item.result === 'NOT RUN') || report.cases.length === 0 ? 2 : 0
} catch (error) {
  report.blocker = error.message
  process.exitCode = report.cases.some(item => item.result === 'FAIL') ? 1 : 2
} finally {
  if (evalPage && ws?.readyState === WebSocket.OPEN) {
    await evalPage('delete window.__dshNavigationTrace').catch(() => {})
  }
  ws?.close()
  if (port) {
    try {
      adb('forward', '--remove', 'tcp:' + port)
      report.nativeLogs = adb('logcat', '-d', '-s', 'dsh-back:I')
        .split(/\r?\n/).filter(line => /source=android/.test(line)).slice(-report.cases.length - 5)
    } catch (error) { report.logError = error.message }
  }
  report.completed = new Date().toISOString()
  save()
}
