// smoke-injections.mjs — boot the plugin against a stubbed cordis, run its real tapIndex
// transform, and parse-check every inline <script> it injects.
//
// Why this exists (2026-09-10, WebView 110 / MuMu): the polyfill snippets used to be joined with
// '' — the Set-methods snippet ends with an expression (`})()`) and the next one starts with
// `if (`, so the parser rejected the WHOLE element and every polyfill died silently. The served
// HTML still contained the shim text, so grep-style checks passed while the page reported
// "Iterator is not defined". Only parsing the assembled markup catches that class of defect.
//
// Usage: node scripts/smoke-injections.mjs
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-web-compat-smoke-'))
const failures = []

/** Assert one condition, recording the failure instead of throwing so all checks report. */
function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

try {
  // The plugin imports @deepseek-ai/cordis; the smoke test supplies a Service stub so the package
  // needs no install (the plugin ships lib/ only).
  const stub = join(scratch, 'node_modules', '@deepseek-ai', 'cordis')
  mkdirSync(stub, { recursive: true })
  writeFileSync(join(stub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/cordis', version: '0.0.0-stub', type: 'module', main: 'index.js' }))
  writeFileSync(join(stub, 'index.js'), 'export class Service { constructor(ctx, name) { this.ctx = ctx; this.name = name } }\n')
  const pluginCopy = join(scratch, 'plugin.mjs')
  copyFileSync(join(pluginRoot, 'lib', 'index.js'), pluginCopy)

  const mod = await import(pathToFileURL(pluginCopy).href)
  const transforms = []
  const ctx = {
    webServer: {
      tapIndex: (fn) => { transforms.push(fn) },
      register: () => () => {},
    },
    effect: () => () => {},
    get: () => undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  mod.apply(ctx)
  check('plugin exports name/inject/apply', mod.name === 'host-web-compat' && Array.isArray(mod.inject) && typeof mod.apply === 'function')
  // 接线契约是**两条** transform：① polyfill+主题桥+picker（共用 pick-token 幂等判据）；
  // ② 静态失败占位（自带哨兵，刻意不共用判据，见 lib/index.js 的 tapIndex 注释）。
  // 此前这里断言「恰好一条」并只跑 transforms[0] —— 于是块C 新增的静态占位脚本
  // **从未被本门禁解析检查过**：一道看不见自己盲区的防线（0.14.1 白闪缺陷 D4 的旁证）。
  // 现在先断言条数契约（新增注入面必须显式更新本行 → 强制其进入下方逐段解析），再逐条应用。
  check('registers the polyfill + static-fallback + slot-guard index transforms', transforms.length === 3, String(transforms.length))

  // 逐条应用（而不是只看 transforms[0]）：每一条注入的脚本体都要过下面的解析与标记检查。
  const html = transforms.reduce((acc, fn) => fn(acc), '<html><head><title>t</title></head><body></body></html>')
  check('injects before </head>', html.includes('</head>') && html.indexOf('Promise.withResolvers') < html.indexOf('</head>'))
  check('static fallback lands before the document head end',
    html.indexOf('dsh-static-fallback') > 0 && html.indexOf('dsh-static-fallback') < html.indexOf('</head>'))

  const bodies = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  check('injects at least 4 script elements', bodies.length >= 4, String(bodies.length))
  for (const [index, body] of bodies.entries()) {
    try {
      new Function(body)
      check('script #' + (index + 1) + ' parses (' + body.length + ' bytes)', true)
    } catch (error) {
      check('script #' + (index + 1) + ' parses (' + body.length + ' bytes)', false, error.message)
    }
  }

  // Live-page markers: the polyfills must be reachable from the served text, not merely present in
  // the plugin source (the failure mode this gate exists for).
  for (const [label, needle] of [
    ['Promise.withResolvers polyfill', 'Promise.withResolvers=function'],
    ['Iterator global shim', "Object.defineProperty(globalThis,'Iterator'"],
    ['Iterator constructor shape (Iterator.prototype)', 'Object.defineProperty(IteratorCtor,\'prototype\''],
    ['Object.groupBy shim', 'Object.groupBy=function'],
    ['Set.prototype.union shim', "def('union'"],
    ['Array.fromAsync shim', 'Array.fromAsync=async function'],
    // ES2023 change-array-by-copy（2026-10-26：旧内核缺 toSorted -> 模型胶囊消失）。四条分别锁
    // 「这一段真的送到页面」，语义对照在 scripts/array-copy-polyfills.test.mjs（本文件只锁送达）。
    ['Array.prototype.toSorted shim', "Object.defineProperty(AP,'toSorted'"],
    ['Array.prototype.toReversed shim', "Object.defineProperty(AP,'toReversed'"],
    ['Array.prototype.toSpliced shim', "Object.defineProperty(AP,'toSpliced'"],
    ['Array.prototype.with shim', "Object.defineProperty(AP,'with'"],
    // 同批审计补的 ES2022 对（与本批报障无关，见 lib/index.js 的注释）。
    ['Array.prototype.findLast shim', "Object.defineProperty(AP,'findLast'"],
    ['Array.prototype.findLastIndex shim', "Object.defineProperty(AP,'findLastIndex'"],
    ['AbortSignal.any polyfill', 'AbortSignal.any=function'],
    ['directory-picker bridge', 'x-dsh-pick-token'],
    ['theme bridge', '__dshThemeBridge'],
    // D4/F1（0.14.1 白闪，issue #242）：入口 chunk 绘制前文档画布是默认白，必须在 head 解析期
    // 就设主题底色。这里只锁「标记送达页面」；**行为**由 boot-watchdog.test.mjs 的 F1 用例判。
    ['boot canvas theme', 'applyCanvasTheme'],
    ['static failure fallback sentinel', 'id="dsh-static-fallback"'],
    ['static fallback hidden by default', 'visibility:hidden'],
    // 2026-10-03 复制按钮静默失效：wrapper 必须真的送达页面（上游 writeClipboard 只在 API **缺席**
    // 时才回落 execCommand，API 在场被拒时直接 return false——判据只能是「桥线在页面文本里」）。
    ['native clipboard fallback wrapper', 'androidBridge.copyText'],
    // 客户端插件装配失败契约行（跨仓逐字，壳侧 LogCollector.PAGE_PLUGIN_FAIL_PREFIX 同源）：
    // 页面侧这条脚本必须**真的送到页面**，否则失败自愈链在页面这一端就断了。
    // 行格式/字段序的行为判据在 boot-watchdog.test.mjs（这里只锁「标记送达」）。
    ['client plugin failure contract prefix', "var BOOT_FAILED_PREFIX='[dsh-boot-failed]';"],
    ['boot page presence criterion (ready must exclude it)', 'function bootPagePresent()'],
    ['client plugin failure publisher', 'function publishBootFailure()'],
  ]) check('served markup carries ' + label, html.includes(needle))

  // Behavioural proof for the shape of the Iterator shim: run the real polyfill script inside a
  // realm with Iterator deleted (the WebView 110 situation) and then evaluate pdfjs's own guard.
  // A bare {from} object passes every text check above and still throws here.
  const { createContext, runInContext } = await import('node:vm')
  const realm = createContext({ console })
  const polyfillBody = bodies.find((body) => body.includes("typeof Iterator==='undefined'"))
  check('polyfill script located for the realm probe', typeof polyfillBody === 'string')
  if (typeof polyfillBody === 'string') {
    // Chromium 110 has neither the Iterator global nor the helper methods; deleting only the global
    // would let the realm's native helpers answer the probe and hide a broken wrapper.
    runInContext(`(() => {
      const proto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))
      for (const name of ['map', 'filter', 'take', 'drop', 'flatMap', 'toArray', 'forEach', 'some', 'every', 'find', 'reduce']) {
        try { delete proto[name] } catch { /* non-configurable: leave it, the probe would then be weaker */ }
      }
      delete globalThis.Iterator
    })()`, realm)
    try {
      runInContext(polyfillBody, realm)
      check('polyfill script executes with Iterator absent', true)
    } catch (error) {
      check('polyfill script executes with Iterator absent', false, error.message)
    }
    const probe = runInContext(`(() => {
      const report = { iterator: typeof Iterator, prototype: typeof Iterator.prototype, withResolvers: typeof Promise.withResolvers }
      // pdfjs (bundled by ui-sidebar-documentpreview) runs exactly this at module init.
      if (typeof Iterator.prototype.join !== 'function') Iterator.prototype.join = function (separator) { return [...this].join(separator) }
      report.join = [3, 1, 2].values().join('-')
      report.toArray = Iterator.from([1, 2]).map((v) => v * 2).toArray().join(',')
      return report
    })()`, realm)
    check('pdfjs Iterator.prototype.join guard survives', typeof probe.prototype === 'string' || probe.prototype === 'object', JSON.stringify(probe))
    check('iterator helpers answer through the shim', probe.join === '3-1-2' && probe.toArray === '2,4', JSON.stringify(probe))
    check('Promise.withResolvers installed by the same script', probe.withResolvers === 'function', JSON.stringify(probe))
  }

  // ── 剪贴板回落（2026-10-03，用户报障：代码块复制按钮点了没复制到剪贴板）────────────────
  //
  // 真机形态：Android WebView 的 navigator.clipboard.writeText() 被拒（NotAllowedError，
  // WebView 没有权限弹窗通道），而上游 writeClipboard 在 **API 在场** 时 `catch { return false }`，
  // 永不尝试 execCommand ⇒ 复制按钮既不写入也无反馈。本块分两步判：
  //   ① 反证：桩 realm 真的复刻真机——**未装 wrapper** 时同一次调用必然「拒绝」，否则下面的正证是假绿；
  //   ② 正证：装了 wrapper 后经壳侧桥写成功；桥缺席时回落 execCommand；三条全失败时给出回执并 reject。
  const clipboardBody = bodies.find((body) => body.includes('__dshClipboardFallback'))
  check('clipboard fallback script located for the realm probe', typeof clipboardBody === 'string')
  if (typeof clipboardBody === 'string') {
    /**
     * 造一个「Android WebView 拒绝剪贴板」的桩 realm。
     * @param options - bridge: true/false 提供桥并给该返回值；undefined = 无桥。execOk = execCommand 结果。
     *   clipboardAbsent = 连 navigator.clipboard 都没有。
     */
    const stubRealm = (options) => {
      const bridgeCalls = []
      const appended = []
      const document = {
        body: { appendChild: (el) => { appended.push(el) } },
        createElement: (tag) => ({ tagName: tag, id: '', style: {}, value: '', textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, select() {}, remove() {} }),
        getElementById: (id) => appended.find((el) => el.id === id) ?? null,
        execCommand: () => options.execOk === true,
      }
      const navigator = options.clipboardAbsent === true
        ? {}
        : { clipboard: { writeText: options.clipboardThrows === true
          ? () => { throw new Error('NotAllowedError: Write permission denied') }
          : () => Promise.reject(new Error('NotAllowedError: Write permission denied')) } }
      const window = options.bridge === undefined
        ? {}
        : { androidBridge: { copyText: (text) => { bridgeCalls.push(text); return options.bridge === true } } }
      return { context: createContext({ console, navigator, document, window, Promise, setTimeout, Error }), bridgeCalls, appended }
    }
    /** 跑一次 writeText，把跨 realm 的 promise 收敛成可断言的字符串。 */
    const writeOutcome = async (context, text) => runInContext(`navigator.clipboard.writeText(${JSON.stringify(text)})`, context)
      .then(() => 'resolved', (error) => 'rejected: ' + error.message)

    // ① 反证：同一桩 realm，未装 wrapper → 必须拒绝（上游 catch 后 return false 的真机形态）。
    const control = stubRealm({ bridge: true, execOk: false })
    const controlOutcome = await writeOutcome(control.context, 'before-shim')
    check('negative control: an unwrapped denied write still rejects (stub models the device)',
      controlOutcome.startsWith('rejected'), controlOutcome)

    // ② 正证：原生被拒 → 壳侧桥写入成功（代码块复制按钮的真实路径）。
    const viaBridgeRealm = stubRealm({ bridge: true, execOk: false })
    runInContext(clipboardBody, viaBridgeRealm.context)
    const bridgeOutcome = await writeOutcome(viaBridgeRealm.context, 'code-block-text')
    check('wrapper resolves through the shell bridge when the native API is denied', bridgeOutcome === 'resolved', bridgeOutcome)
    check('bridge receives the exact copied text',
      viaBridgeRealm.bridgeCalls.length === 1 && viaBridgeRealm.bridgeCalls[0] === 'code-block-text',
      JSON.stringify(viaBridgeRealm.bridgeCalls))

    // ③ 桥缺席 → 回落 execCommand（仍在点击手势内）；此时不得出现失败回执。
    const viaExecRealm = stubRealm({ bridge: undefined, execOk: true })
    runInContext(clipboardBody, viaExecRealm.context)
    const execOutcome = await writeOutcome(viaExecRealm.context, 'exec-text')
    check('wrapper falls back to execCommand when the bridge is absent', execOutcome === 'resolved', execOutcome)
    check('no failure notice on the execCommand path',
      !viaExecRealm.appended.some((el) => el.id === 'dsh-clipboard-failed'),
      JSON.stringify(viaExecRealm.appended.map((el) => el.id)))

    // ③b 原生同步抛（不是返回拒绝的 promise）也要落到桥线上：上游 `try { await … } catch` 同样吞掉它。
    const syncThrowRealm = stubRealm({ clipboardThrows: true, bridge: true, execOk: false })
    runInContext(clipboardBody, syncThrowRealm.context)
    const syncThrowOutcome = await writeOutcome(syncThrowRealm.context, 'sync-throw-text')
    check('wrapper handles a synchronous throw from the native API',
      syncThrowOutcome === 'resolved' && syncThrowRealm.bridgeCalls[0] === 'sync-throw-text',
      syncThrowOutcome + ' ' + JSON.stringify(syncThrowRealm.bridgeCalls))

    // ④ 三条全失败 → 必须 reject（让调用方的 !ok 分支照旧生效）且给出人话回执（不静默——上游 !ok 分支不产出反馈）。
    const deadRealm = stubRealm({ bridge: false, execOk: false })
    runInContext(clipboardBody, deadRealm.context)
    const deadOutcome = await writeOutcome(deadRealm.context, 'doomed')
    check('wrapper rejects when every path fails', deadOutcome.startsWith('rejected'), deadOutcome)
    check('total failure leaves a user-visible notice (no silent failure)',
      deadRealm.appended.some((el) => el.id === 'dsh-clipboard-failed'), JSON.stringify(deadRealm.appended.map((el) => el.id)))

    // ⑤ API 完全缺席（老内核/非安全上下文）→ 装一个走桥的 writeText，让上游的首选路径也落在桥线上。
    const absentRealm = stubRealm({ clipboardAbsent: true, bridge: true, execOk: false })
    runInContext(clipboardBody, absentRealm.context)
    const installed = runInContext('typeof navigator.clipboard.writeText', absentRealm.context)
    check('wrapper installs a writeText when the async Clipboard API is absent entirely', installed === 'function', String(installed))
    const absentOutcome = await writeOutcome(absentRealm.context, 'absent-api-text')
    check('installed writeText routes through the bridge', absentOutcome === 'resolved' && absentRealm.bridgeCalls[0] === 'absent-api-text',
      absentOutcome + ' ' + JSON.stringify(absentRealm.bridgeCalls))
  }

  const guarded = transforms[0]('<html><head>x-dsh-pick-token</head><body></body></html>')
  check('idempotent guard skips a page that already carries the injection', guarded === '<html><head>x-dsh-pick-token</head><body></body></html>')

  // 静态占位自带独立哨兵，**刻意不共用** pick-token 判据：入口 chunk 全灭时它是唯一的可见反馈，
  // 与 pick-token 共用判据会被一起跳过（lib/index.js 的 tapIndex 注释里逐字写了这条理由）。
  const fallbackOnce = transforms[1]('<html><head></head><body></body></html>')
  check('static fallback transform is idempotent (own sentinel)', transforms[1](fallbackOnce) === fallbackOnce)
  check('static fallback is NOT skipped by the pick-token sentinel',
    transforms[1]('<html><head>x-dsh-pick-token</head><body></body></html>').includes('dsh-static-fallback'))

  // slot-guard（transforms[2]）：注入点在 <head> 开标签后（早于上游 queue 脚本）、哨兵幂等、
  // 与 pick-token 判据独立（pick-token 在场的页面同样要拿到守卫）。
  const guardPage = transforms[2]('<html><head><script>window.__ModuleLoader__={}</script></head><body></body></html>')
  check('slot-guard lands right after the <head> open tag',
    guardPage.startsWith('<html><head><script>(function(){') && guardPage.includes('__dshSlotGuard'))
  check('slot-guard outranks the upstream queue script in evaluation order',
    guardPage.indexOf('__dshSlotGuard') < guardPage.indexOf('window.__ModuleLoader__'))
  check('slot-guard transform is idempotent (own sentinel)', transforms[2](guardPage) === guardPage)
  check('slot-guard is NOT skipped by the pick-token sentinel',
    transforms[2]('<html><head>x-dsh-pick-token</head><body></body></html>').includes('__dshSlotGuard'))
  check('slot-guard leaves a page without <head> untouched',
    transforms[2]('<html><body>ok</body></html>') === '<html><body>ok</body></html>')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\nsmoke-injections: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('\nsmoke-injections: all checks passed')
