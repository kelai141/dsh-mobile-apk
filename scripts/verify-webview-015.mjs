// verify-webview-015.mjs — 追上游 0.1.5 适配的 WebView DOM 断言（0.13.7）
// 用法：node scripts/verify-webview-015.mjs <cdp-ws-url>
// 取 ws 地址：adb forward tcp:29225 localabstract:webview_devtools_remote_<app-pid>
//             node -e "fetch('http://127.0.0.1:29225/json/list').then(r=>r.json()).then(j=>console.log(j[0].webSocketDebuggerUrl))"
// 断言项对应 docs/UPSTREAM-0.1.5-ADAPT-2026-09-10.md §4 验收清单 1/3/8 的可在页内自证部分。
const [, , wsUrl] = process.argv
if (!wsUrl) { console.error('用法: node verify-015.mjs <ws-url>'); process.exit(2) }

const checks = [
  ['移动形态标记 html[data-dsh-mobile-form]', "document.documentElement.hasAttribute('data-dsh-mobile-form')", true],
  ['框架根已打标 [data-dsh-frame]', "!!document.querySelector('[data-dsh-frame]')", true],
  ['上游右栏列存在 [data-rightbar-col]', "!!document.querySelector('[data-rightbar-col]')", true],
  ['顶栏存在 [data-dsh-mobile-topbar]', "!!document.querySelector('[data-dsh-mobile-topbar]')", true],
  ['顶栏含侧栏开关按钮', "!!document.querySelector('[data-dsh-mobile-topbar] button')", true],
  ['左栏为离屏 fixed 抽屉', "getComputedStyle(document.querySelector('[data-dsh-frame] > [class*=sidebarCol]')).position === 'fixed'", true],
  ['拖拽手柄已隐藏', "[...document.querySelectorAll('[data-dsh-frame] [class*=handle]')].every(h => getComputedStyle(h).display === 'none')", true],
  ['会话头部 corner 座位存在', "!!document.querySelector('[data-conversation-header-corner]')", true],
  ['右栏展开键存在（corner 内按钮）', "!!document.querySelector('[data-conversation-header-corner] button')", true],
  ['我们的「在文件中打开」入口存在', "!!document.querySelector('[aria-label=\"在文件中打开\"]')", true],
  ['桥 openPathChooser 已注入', "typeof window.androidBridge?.openPathChooser === 'function'", true],
  ['桥 downloadDebugLogs 已退役', "typeof window.androidBridge?.downloadDebugLogs === 'undefined'", true],
  ['桥 pickImage 已退役', "typeof window.androidBridge?.pickImage === 'undefined'", true],
  // 0.13.7fx-1：注入项整体退役（@ 文件回上游原生），这里断言它们都不再出现在菜单里
  ['菜单注入项已退役：引用本机文件 / 导出调试日志 / 上传图片（打开 add 菜单后）',
    "(async () => { const b = document.querySelector('[data-composer-card] button[aria-haspopup=\"listbox\"], [data-composer-card] button[aria-label*=\"添加\"]'); if (b) { b.click(); await new Promise(r => setTimeout(r, 250)); } const filePick = !!document.querySelector('[data-dsh-file-pick]'); const dbg = !!document.querySelector('[data-dsh-debug-log]'); const img = !!document.querySelector('[data-dsh-image-pick]'); document.body.click(); return { filePick, debugLog: dbg, imagePick: img }; })()",
    (v) => v && v.filePick === false && v.debugLog === false && v.imagePick === false],
  ['桥 pickFilePath 已退役（SAF 路径桥整链）', "typeof window.androidBridge?.pickFilePath === 'undefined'", true],
  // 原生 @ 菜单保持纯净：不许再有任何非 option 的注入按钮混进 [role=listbox]
  ['原生 @ 菜单无注入杂项（0.13.7fx-1 退役回归）',
    "(async () => { const ce = document.querySelector('[contenteditable=true]'); if (!ce) return 'no-composer'; ce.focus(); document.execCommand('insertText', false, '@'); await new Promise(r => setTimeout(r, 1500)); const m = document.querySelector('[data-trigger-menu]'); const strays = m ? [...m.querySelectorAll('button:not([role=option])')].map(e => (e.innerText || '').trim()).filter(Boolean) : []; const rows = m ? m.querySelectorAll('[role=option]').length : 0; document.execCommand('selectAll'); document.execCommand('delete'); return { menu: !!m, rows, strays }; })()",
    (v) => v === 'no-composer' || (v && (v.menu === false || (Array.isArray(v.strays) && v.strays.length === 0)))],
  ['上游附件按钮未被遮蔽',
    "(async () => { const btn = document.querySelector('button[aria-label=\"添加附件\"]'); if (!btn) return 'absent'; return getComputedStyle(btn).display !== 'none'; })()",
    true],
  ['名册含 ui-layout 与 ui-responsive',
    "(window.__DSH_BOOT__?.entries ?? []).map(e => e.id).filter(id => id.includes('ui-layout') || id.includes('ui-responsive'))",
    (v) => Array.isArray(v) && v.length >= 2],
  // ── 0.13.7 追加：polyfill 活性 + 注入脚本可解析（2026-09-10 缺陷回归）──
  // 背景：POLYFILLS 片段曾用 join('') 装配，Set 片段结尾 `})()` 直接撞下一段 `if (` →
  // 整个 <script> 被解析器拒绝，页面 polyfill 全灭（表现为 "Iterator is not defined"），
  // 而抓 HTML 仍能看到片段文本（grep 类检查全绿）。下列断言按「页面里能不能用」判。
  ['polyfill: 全局 Iterator 可用（上游 0.1.5 客户端 import 期依赖）', "typeof Iterator !== 'undefined'", true],
  ['polyfill: Promise.withResolvers 可用（宿主 boot 就绪尾脚本依赖）', "typeof Promise.withResolvers === 'function'", true],
  ['polyfill: Object.groupBy 可用', "typeof Object.groupBy === 'function'", true],
  ['polyfill: Map.groupBy 可用', "typeof Map.groupBy === 'function'", true],
  ['polyfill: Array.fromAsync 可用', "typeof Array.fromAsync === 'function'", true],
  ['polyfill: Set.prototype.union 可用', "typeof Set.prototype.union === 'function'", true],
  ['polyfill: Set.prototype.isDisjointFrom 可用', "typeof Set.prototype.isDisjointFrom === 'function'", true],
  ['Iterator 迭代器助手可用（map/toArray 跑通）', "[1,2,3].values().map(v => v * 2).toArray().join(',')", '2,4,6'],
  ['页面内全部内联脚本可解析（装配语法回归）',
    "(() => { const bad = []; for (const s of document.querySelectorAll('script:not([src])')) { const body = s.textContent || ''; if (body.trim() === '') continue; try { new Function(body) } catch (e) { bad.push((body.slice(0, 48).replace(/\\s+/g, ' ')) + ' :: ' + e.message) } } return bad; })()",
    (v) => Array.isArray(v) && v.length === 0],
  ['documentpreview 客户端条目在场（曾被 Iterator 缺失打挂的包）',
    "(window.__DSH_BOOT__?.entries ?? []).map(e => e.id).filter(id => id.includes('documentpreview'))",
    (v) => Array.isArray(v) && v.length >= 1],
  // ── 0.14.0-preview 追加：系统返回层栈通道在场（计划 §5.1 IX-BG-01/14）──
  // 页面侧 BackStackSignal 暴露 window.__dshBack；层数/逐层类型全局是设备侧逐级返回断言的读点；
  // dshBackBridge 是壳侧同步缓存的 set/get 成对上行面（getBackAvailable 回读「层栈非空」缓存）。
  ['返回层栈入口 window.__dshBack 在场（函数）', "typeof window.__dshBack === 'function'", true],
  // 注意：层数/逐层类型只断言「类型在场」——不绑定初始值，因为本条之前的检查会打开 @ 菜单等层，
  // 层栈在读到时可能已非 0（判据是通道在场 + 层随交互变化，见后面两条交互断言）。
  ['返回层栈层数全局在场（数字）', "typeof window.__dshBackDepth === 'number'", true],
  ['返回层栈逐层类型全局在场（数组）', "Array.isArray(window.__dshBackKinds)", true],
  ['返回层栈上行桥 dshBackBridge 成对在场（set/get）',
    "typeof window.dshBackBridge?.setAvailable === 'function' && typeof window.dshBackBridge?.getBackAvailable === 'function'", true],
  // 判据：抽屉必须被登记为层、且壳侧同步缓存为真（层数增减由下一条「消费」断言覆盖，避免点击幂等性带来的噪声）。
  ['抽屉成为层（kinds 含 drawer）且壳侧同步缓存为真',
    "(async () => { const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const kinds = () => Array.isArray(window.__dshBackKinds) ? window.__dshBackKinds : []; if (!kinds().includes('drawer')) { const b = document.querySelector('[data-dsh-mobile-topbar] button'); if (!b) return 'no-topbar'; b.click(); await sleep(500); } return { depth: window.__dshBackDepth, kinds: kinds(), cached: window.dshBackBridge?.getBackAvailable?.() }; })()",
    (v) => v && v.depth >= 1 && v.cached === true && Array.isArray(v.kinds) && v.kinds.includes('drawer')],
  ['层栈消费（__dshBack 弹出该层）→ 层数下降且壳侧缓存回读 false',
    "(async () => { const before = window.__dshBackDepth; const consumed = typeof window.__dshBack === 'function' ? window.__dshBack() : 'no-entry'; await new Promise(r => setTimeout(r, 400)); return { before, consumed, depth: window.__dshBackDepth, cached: window.dshBackBridge?.getBackAvailable?.() }; })()",
    (v) => v && v.consumed === true && v.before >= 1 && v.depth === v.before - 1 && v.cached === (v.depth > 0)],
  // ── 0.14.0-preview 追加：壳侧状态 getter 在场（计划 §4.3 ST-10/ST-11）──
  ['桥 getImmersiveMode 在场（ST-10 壳侧唯一真源）', "typeof window.androidBridge?.getImmersiveMode === 'function'", true],
  ['getImmersiveMode 返回布尔（回读壳侧偏好真值）', "typeof window.androidBridge?.getImmersiveMode?.() === 'boolean'", true],
]

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
const results = []

ws.onopen = async () => {
  for (const [label, expression, expect] of checks) {
    const value = await evaluate(expression)
    const pass = typeof expect === 'function' ? expect(value) : value === expect
    results.push([pass, label, JSON.stringify(value)?.slice(0, 90)])
  }
  for (const [pass, label, value] of results) console.log((pass ? 'PASS ' : 'FAIL ') + label + '  → ' + value)
  const failed = results.filter(r => !r[0]).length
  console.log('\n' + (failed === 0 ? 'ALL PASS (' + results.length + ')' : 'FAILED ' + failed + '/' + results.length))
  ws.close()
  process.exit(failed === 0 ? 0 : 1)
}

function evaluate(expression) {
  return new Promise((resolve) => {
    const messageId = ++id
    pending.set(messageId, resolve)
    ws.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
}

ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const resolve = pending.get(message.id)
  if (!resolve) return
  pending.delete(message.id)
  if (message.result?.exceptionDetails) resolve('EXCEPTION: ' + JSON.stringify(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text).slice(0, 120))
  else resolve(message.result?.result?.value)
}
ws.onerror = (error) => { console.error('WS error: ' + (error?.message ?? 'unknown')); process.exit(1) }
setTimeout(() => { console.error('timeout'); process.exit(1) }, 60000)