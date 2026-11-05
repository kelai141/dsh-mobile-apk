// verify-webview-015.mjs — 追上游 0.1.5 适配的 WebView DOM 断言（0.13.7）
// 用法：node scripts/verify-webview-015.mjs <cdp-ws-url>
// 取 ws 地址：adb forward tcp:29225 localabstract:webview_devtools_remote_<app-pid>
//             node -e "fetch('http://127.0.0.1:29225/json/list').then(r=>r.json()).then(j=>console.log(j[0].webSocketDebuggerUrl))"
// 断言项对应 docs/UPSTREAM-0.1.5-ADAPT-2026-09-10.md §4 验收清单 1/3/8 的可在页内自证部分。
//
// 形态判据（2026-09-24 修）：本脚本一律按「页内实测 viewport」判形态，不按 --wide 形参。
// 页面自判手机形态的唯一真源是 dsh-client-ui-responsive/src/client/mobile/form-marker.ts:21
// MOBILE_FORM_MAX_WIDTH = 767（镜像上游 (max-width: 767px)，见同包 keyboard-boundary.ts:48）。
// 故 innerWidth <= 767 即手机形态。--wide 只当调用者意图提示打印，不再进入任何判据：
// 旧写法用它硬编码期望「不是手机形态」，而「16384 横屏」实测跑在 freeform 浮窗里只有
// 281x522 CSS px，页面**正确地**自判为手机形态，于是断言恒红且无产品含义
// （实测 viewport 才是唯一可证伪的读点）。
if (process.argv.includes("--self-test")) {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const result = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("./verify-webview-settings.test.mjs", import.meta.url))], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const [, , wsUrl] = process.argv
const wide = process.argv.includes('--wide')
if (!wsUrl) { console.error('用法: node verify-015.mjs <ws-url> [--wide]'); process.exit(2) }

/** 手机形态宽度阈值：与页面注入层 form-marker.ts 的 MOBILE_FORM_MAX_WIDTH 同值。 */
const MOBILE_FORM_MAX_WIDTH = 767

/**
 * 形态判据的唯一写法：每条表达式自己在页内重算 mobile = innerWidth <= 767，
 * 再断言「页面形态产物」与它一致。自算而不读模块级缓存，是为了让每条断言单独可证伪
 * （改坏哪一条，就只有那一条红，不会连带把后面的判据一起带偏）。
 * @param body - 已定义 mobile 的页内语句块，须 return 一个含 mobile 的读数对象。
 * @returns 包好同一 mobile 判据的页内表达式。
 */
const formExpr = (body) => '(() => { const mobile = window.innerWidth <= ' + MOBILE_FORM_MAX_WIDTH + '; ' + body + ' })()'

/**
 * 角标座位与展开键的页内读数：面板是否挂载、是否展开、corner 里有没有按钮。
 *
 * 上游 ui-sidebar-right/src/client/shell/ExpandButton.tsx:33-34 在 surface.layout.expanded
 * 为真时 return null，所以「按钮在不在」本身没有固定真值，不能当无条件断言。
 */
const CORNER_PROBE = "(() => { const c = document.querySelector('[data-conversation-header-corner]'); const p = document.querySelector('[data-sidebar-right-panel]'); return { corner: !!c, panel: !!p, open: !!(p && p.hasAttribute('data-sidebar-right-open')), button: !!(c && c.querySelector('button')) } })()"

/**
 * 页内「打开设置」导航片段（2026-10-26，两个探针共用）。
 *
 * 为什么要有它：上游**没有** aria-label=设置 的直连按钮（设备实测 settingsAriaIndex=-1，竖屏/横屏都如此），
 * 设置入口在「账号菜单」弹出菜单的 menuitem 里。此前两处探针各自写死「找 aria 设置」，只在
 * 「本轮之前恰好已有浮层」时靠跳过分支蒙过去 ⇒ 新起一局就恒红（存量红，基线同样红）。
 * 兜底选择器还有一处歧义（设备实测）：单个 .find() 同时认 aria-label 账号菜单 与文字 更多，而侧栏
 * 导航项「更多」（插件浏览器入口）排在账号菜单之前（index 5 vs 14）⇒ 点了导航项进插件页，再找
 * menuitem 设置必然落空。故顺序固定为：直连按钮 → 账号菜单（按 aria-label 认）→ 文字 更多；
 * 点开没看到设置项就把弹层关掉，不把浮层留给后面的兜底与断言。
 *
 * 片段无反引号、无 ${} 插值，所以能作为独立的 const 行被 scripts/verify-webview-settings.test.mjs
 * 原样取出求值（该测试就是这么拿到真源码的）。调用方负责先定义 sleep / tap 与自己的判据。
 */
const OPEN_SETTINGS_SRC = `const openSettings = async () => { const direct = [...document.querySelectorAll('button')].find(x => /^(设置|Settings)$/.test((x.getAttribute('aria-label') || '').trim())); if (direct) return { opener: 'direct', el: direct }; const accountMenu = [...document.querySelectorAll('button')].find(b => /^(账号菜单|Account menu)$/.test((b.getAttribute('aria-label') || '').trim())); const trigger = accountMenu || [...document.querySelectorAll('button')].find(b => /^(更多|More)$/.test((b.textContent || '').trim())); if (!trigger) return { opener: 'absent', el: null }; tap(trigger); await sleep(600); const name = /^(账号菜单|Account menu)$/.test((trigger.getAttribute('aria-label') || '').trim()) ? 'account-menu' : 'more'; const item = [...document.querySelectorAll('[role=menuitem],button')].find(b => /^(设置|Settings)$/.test((b.getAttribute('aria-label') || b.textContent || '').trim())); if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300); } return { opener: name + (item ? '' : ':no-item'), el: item || null }; };`

/**
 * 「重置链接」按钮的页内探针（0.14.2 P1）。
 *
 * 跨层判据分两步，缺一步只证明一半：
 *   ① 桥面在场（另一条断言）—— 页面**能**调用；
 *   ② 本探针 —— 按钮真实渲染且可点，即用户**真的**点得到。只有桥面而 UI 缺席 = 死路，
 *      正是 0.14.1 审查 P0 记过的形态（指引指向一条不存在的路）。
 *
 * 两处实测前置（2026-09-26，都是「判据真值依赖跑前 UI 状态」）：
 *   a) 本条之前的检查会主动开浮层 → 到达时 dialogs=1，设置按钮的点击被浮层吃掉 ⇒ 先真实关掉浮层；
 *   b) 设置打开后「手机控制」是**页签**，不点它该区块不挂载（实测 dialog 文本含「通用设置/模型/
 *      内置插件/…/手机控制/开发者选项」而 #dsh-phone-control-title 为 null）⇒ 补点页签。
 *
 * c) 设置入口不在直连按钮上（2026-10-26 设备实测，存量红）：上游没有 aria-label=设置 的按钮，
 *      入口在「账号菜单」弹出菜单里；兜底选择器还同时认文字「更多」，而侧栏导航项「更多」排在
 *      账号菜单之前（index 5 vs 14）⇒ 旧写法点了导航项进插件页，返回 no-settings-entry。
 *      导航统一走 OPEN_SETTINGS_SRC（直连 → 账号菜单 → 文字兜底，点空即关弹层），
 *      steps 里记 open:<用的是哪个入口>，下次一眼看出卡在哪一环。
 *   d) 「已开」不能用「节点在场」判（2026-10-26 竖屏实测）：上一轮留下的设置页在本视角下 rect=0x0，
 *      旧 section() 直接短路 ⇒ steps 为空、按钮 w/h=0 判红。改为按**布局尺寸**（rect>0）认已开，
 *      于是同一次运行里它会先清浮层、再正经导航一遍；判据（w>0 && h>0）保持不放宽。
 *
 * 失败态带上 steps，下次一眼看出卡在哪一步；打不开就如实判红，不用缺失冒充绿。
 */
/**
 * 「已退役的 Session-header 入口是否复活」的页内探针（双语）。
 *
 * 这是**否定**判据：中英文可访问名任一命中都算复活 → 调用方要求 `present === false`。
 * 单独抽成 const 是为了让 scripts/verify-webview-settings.test.mjs 能原样取出真源码求值
 * （无反引号、无插值），从而给这条判据配可证伪的负控。
 */
const RETIRED_OPEN_ENTRY_PROBE = `(() => { const active = !!document.querySelector('[data-dsh-frame] [data-phase="active"]'); const labels = ['在文件中打开', 'Open in file manager']; const hits = labels.filter((label) => document.querySelector('[aria-label="' + label + '"]') !== null); return { active, present: hits.length > 0, hits } })()`

// Match the supported accessible names without depending on the active UI locale.
const FILE_BUTTON_PROBE = `(() => { const btn = document.querySelector('button[aria-label="添加文件或调用指令"], button[aria-label="Add files or run commands"]'); if (!btn) return 'absent'; return getComputedStyle(btn).display !== 'none'; })()`

const RESET_BUTTON_PROBE = `(async () => { const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const tap = (el) => { const b = el.getBoundingClientRect(); const x = b.x + b.width / 2; const y = b.y + b.height / 2; el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y })); el.click(); }; const mobile = window.innerWidth <= ${MOBILE_FORM_MAX_WIDTH}; const section = () => { const el = document.querySelector('#dsh-phone-control-title'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const steps = []; const dlg = () => document.querySelectorAll('[role=dialog]').length; if (!section() && dlg() > 0) { for (let i = 0; i < 5 && dlg() > 0; i++) { const c = [...document.querySelectorAll('[role=dialog] button')].find(b => /^(关闭|Close)$/.test((b.getAttribute('aria-label') || '').trim())); if (c) tap(c); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(500); } steps.push('cleared:' + dlg()); } if (!section()) { if (mobile) { const t = document.querySelector('[data-dsh-sidebar-toggle]'); if (t) { tap(t); await sleep(900); steps.push('drawer'); } } ${OPEN_SETTINGS_SRC} let opened = await openSettings(); steps.push('open:' + opened.opener); let s = opened.el; if (!s) { const t = document.querySelector('[data-dsh-sidebar-toggle]'); if (t) { tap(t); await sleep(600); opened = await openSettings(); steps.push('open2:' + opened.opener); s = opened.el; } } if (!s) return 'no-settings-entry'; tap(s); await sleep(2000); steps.push('settings'); if (!section()) { const tab = [...document.querySelectorAll('button,[role=tab]')].find(b => { const label = b.cloneNode(true); label.querySelectorAll('[data-dsh-settings-nav-desc], [data-dsh-settings-nav-chevron]').forEach(n => n.remove()); return /^(手机控制|Phone control)$/.test((label.textContent || '').trim()); }); if (tab) { tap(tab); await sleep(1200); steps.push('tab'); } } } if (!section()) return 'settings-not-opened:' + steps.join(','); const btn = [...document.querySelectorAll('button')].find(b => /^(重置链接|Reset link)$/.test((b.textContent || '').trim())); if (!btn) return 'button-absent'; const rc = btn.getBoundingClientRect(); return { steps, section: true, present: true, disabled: btn.disabled === true, visible: getComputedStyle(btn).display !== 'none', w: Math.round(rc.width), h: Math.round(rc.height) }; })()`

const checks = [
  ['移动形态标记与实测 viewport 一致（判据取自页内 innerWidth，与 --wide 无关）',
    formExpr("const marked = document.documentElement.hasAttribute('data-dsh-mobile-form'); return { w: window.innerWidth, mobile, marked }"),
    (v) => !!v && typeof v.w === 'number' && v.marked === v.mobile],
  ['框架根已打标 [data-dsh-frame]', "!!document.querySelector('[data-dsh-frame]')", true],
  ['上游右栏列存在 [data-rightbar-col]', "!!document.querySelector('[data-rightbar-col]')", true],
  // 0.14.2 P4：自绘的 44px 顶栏 band 已撤（用户报「额头太大挤占屏幕」）。判据改成它的反面，
  // 并把「抽屉开关搬进了上游标题行」这件事钉住 —— 只断「开关在场」不够，
  // 否则把开关挪到任何地方（甚至挪回 band）都会假绿。
  ['无自绘顶栏 [data-dsh-mobile-topbar]（0.14.2 P4 已撤）', "!document.querySelector('[data-dsh-mobile-topbar]')", true],
  ['抽屉开关在 [data-conversation-header-leading] 座位内（与标题同行）',
    "(() => { const t = document.querySelector('[data-dsh-sidebar-toggle]'); const seat = document.querySelector('[data-conversation-header-leading]'); return !!t && !!seat && seat.contains(t); })()", true],
  ['左栏 position 与实测 viewport 形态一致（手机形态 fixed / 桌面形态非 fixed）',
    formExpr("const col = document.querySelector('[data-dsh-frame] > [class*=sidebarCol]'); return { w: window.innerWidth, mobile, position: col ? getComputedStyle(col).position : 'no-sidebar-col' }"),
    (v) => !!v && v.position !== 'no-sidebar-col' && (v.position === 'fixed') === v.mobile],
  // 2026-09-26 修正：锚点从 [class*=handle] 换成上游自己的 [data-width-handle]。
  // 旧锚点恒红的真因是 CSS 属性选择器的子串匹配**大小写敏感** —— 上游真实类名是
  // wSkVaW_widthHandle（大写 H，见 ui-conversation/.../ConversationWidthControls.tsx:118），
  // 而 [class*=handle]（小写 h）实测 0 命中；产品侧手柄一直在场且行为正确。
  // 手柄只在 conversation phase==='active' 时渲染（同文件 :171 phase !== 'active' 即 return null），
  // 故另加 phase 前置：hero 空白态下手柄本就不该存在，判它等于把「跑到哪个 UI 状态」写进门禁。
  ['拖拽手柄可见性与实测 viewport 形态一致（手机形态全 display:none；仅 active 会话判）',
    formExpr("const active = !!document.querySelector('[data-dsh-frame] [data-phase=\"active\"]'); const hs = [...document.querySelectorAll('[data-dsh-frame] [data-width-handle]')]; return { w: window.innerWidth, mobile, active, count: hs.length, hidden: hs.length > 0 && hs.every(h => getComputedStyle(h).display === 'none') }"),
    (v) => !!v && (v.active ? (v.count >= 1 && v.hidden === v.mobile) : v.count === 0)],
  // 2026-09-24 基线实测（.deploy-tmp/0142-verify-1/probe-table.md）：corner 座位在竖屏 16416 与
  // 横屏 16384（freeform 浮窗 281x522）**都渲染**，故座位存在性两方向都判，不按 --wide 降级。
  // 判据与原「上游附件按钮未被遮蔽」同构：座位存在 + computed display !== none。
  // 不追加可见性判据：header 座位能否落在视口内由布局与滚动位置决定，它随交互漂移，
  // 判它就等于把噪点写进门禁；display:none 才是「被样式藏起来」这个真缺陷的信号。
  ['会话头部 corner 座位存在且未 display:none（两方向都判）',
    "(() => { const c = document.querySelector('[data-conversation-header-corner]'); return { present: !!c, display: c ? getComputedStyle(c).display : 'absent' } })()",
    (v) => !!v && v.present === true && v.display !== 'none' && v.display !== 'absent'],
  // 旧断言「corner 内 button 存在」之所以漂：上游 ExpandButton.tsx:33-34 在面板展开（含
  // surface 未建时的 false）之外 return null —— 有按钮即面板未展开，面板展开了按钮本就该消失。
  // 判互斥关系才有固定真值，且两方向都能非空证伪。面板未挂载时按钮同样缺席
  // （上游 RightbarSeat 在 surface 未建时返回 null 的读数由 CORNER_PROBE 的 panel 字段记下），
  // 前置 pinPanelStates() 会把本轮实测到的形态与观测序列写进它自己的结果行。
  ['右栏展开键存在性与面板展开态互斥（展开键存在 === 面板未展开）',
    CORNER_PROBE,
    (v) => !!v && v.corner === true && v.button === !v.open],
  // 0.14.2 P5 已按用户反馈退役 Session-header 文件夹入口；
  // dsh-client-ui-responsive/src/client/index.ts:352-356 记录删除注册的原因，组件仍供 open-with tab 使用。
  // 此断言验证退役状态在空白页和活动会话中都成立，避免把历史 UI 入口误报为产品回归。
  //
  // 双语（#601 后续）：本断言是「不存在」判据，所以中英文**任一**命中都算「入口复活」→ 判红。
  // 只认中文时，英文界面下把入口加回来会恒真假绿（组件 OpenInFileManagerAction.tsx 的
  // LABEL 目前只有中文；一旦上游/适配层给它配英文可访问名，旧判据就漏了）。
  ['已退役的 Session-header「在文件中打开」入口不存在（两方向都判，中英文任一复活即红）',
    RETIRED_OPEN_ENTRY_PROBE,
    (v) => !!v && v.present === false],
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
  // 陈旧选器修正（2026-09-24）：旧断言查 button[aria-label="添加附件"]，该字符串属**已退役**的
  // dsh-attachment-formats —— 0.1.7-rc.1 构建产物里 0 命中（实测 scripts/patches/tests/fixtures/
  // dsh-client-ui-conversation-0.1.7-rc.1/lib/client.js 全文件只有 "添加文件或调用指令"）。
  // 本代活体 label 是「添加文件或调用指令」（上游 ui-conversation/src/client/locales.ts:22
  // 'input.commands'，渲染点 skeleton/InputBar.tsx:423 aria-label），故改查活体 label，
  // 并保留原语义「存在且 display !== none」。这是换正确选器而非删断言：选器一改，遮蔽回归即可证伪。
  ['上游添加文件或调用指令按钮未被遮蔽（活体 label）',
    FILE_BUTTON_PROBE,
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
  // 0.14.9 追加：ES2023 change-array-by-copy（2026-10-26 用户报障「模型选择不可用」——
  // 旧内核缺 toSorted，render 抛错被 slot 错误边界吞成空渲染，模型胶囊看起来被下掉了）。
  // 该组 API **恰好在 Chrome 110 落地，而模拟器 WebView 就是 110**：这四条在本机是原生在应答，
  // 单看「是函数」证明不了注入层。所以先断言注入文本真的进了页面（送不到即红），再断言能力可用；
  // 「删掉原生后仍能用」的语义对照在 dsh-host-web-compat/scripts/array-copy-polyfills.test.mjs。
  ['polyfill: 注入层送达 ES2023 change-array-by-copy 片段（页面内联脚本含 toSorted/with 实现）',
    // 认「不可枚举安装」形态（issue #621）：赋值式安装会让 for...in 多出方法名，判据必须钉住修法本身。
    "(() => { const rows = [...document.querySelectorAll('script:not([src])')].map(s => s.textContent || ''); return rows.some(t => t.includes(\"defNonEnum('toSorted'\")) && rows.some(t => t.includes(\"defNonEnum('with'\")); })()", true],
  ['polyfill: Array.prototype.toSorted 可用（缺它即模型胶囊/设置模型行/定时任务排序崩）', "typeof [].toSorted === 'function'", true],
  ['polyfill: Array.prototype.toReversed 可用', "typeof [].toReversed === 'function'", true],
  ['polyfill: Array.prototype.toSpliced 可用', "typeof [].toSpliced === 'function'", true],
  ['polyfill: Array.prototype.with 可用', "typeof [].with === 'function'", true],
  // 同批审计补的 ES2022 对（Chrome 97+；产品语法下限是 chrome87，87-96 在支持范围内却没有它们）。
  // 与本批报障的 toSorted 无关，别混成一条归因。
  ['polyfill: Array.prototype.findLast 可用', "typeof [].findLast === 'function'", true],
  ['polyfill: Array.prototype.findLastIndex 可用', "typeof [].findLastIndex === 'function'", true],
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
  // 判据：浮层必须被登记为层、且壳侧同步缓存为真（层数增减由下一条「消费」断言覆盖）。
  // 形态差异：手机分支有 drawer、桌面分支没有，故 drawer 形态项只按实测形态判。
  // 分支取自页内实测 innerWidth，不取自 --wide（281x522 的 freeform 浮窗就是手机形态）。
  //
  // 2026-09-26 修正（D6-c）：旧写法只在手机分支**主动建层**（点顶栏开关开抽屉），桌面分支
  // 直接读层栈——它的绿依赖「本条之前的检查恰好留了一个 @ 菜单层」。跑到 hero 空白态、或
  // 前置检查正好把菜单关干净时 depth=0 就恒红（横屏 16384 实测复现：depth=0 kinds=[] cached=false，
  // 同机点开设置后立刻 depth=1 kinds=['dialog']）。这是「判据真值依赖跑前 UI 状态」的另一种形态。
  // 现在两条分支都**自己建层**，且都用真实点击（非合成 click）：手机点顶栏开关（抽屉层），
  // 桌面点侧栏的设置入口（dialog 层）。已在竖屏/横屏两方向各自实测：建层后 depth>=1、cached=true。
  ['抽屉/浮层成为返回层且壳侧同步缓存为真（两条分支各自建层；drawer 形态项仅手机判）',
    "(async () => { const sleep = (ms) => new Promise(r => setTimeout(r, ms)); const kinds = () => Array.isArray(window.__dshBackKinds) ? window.__dshBackKinds : []; const mobile = window.innerWidth <= " + MOBILE_FORM_MAX_WIDTH + "; const tap = (el) => { const r = el.getBoundingClientRect(); const x = r.x + r.width / 2; const y = r.y + r.height / 2; el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y })); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y })); el.click(); }; if (mobile && !kinds().includes('drawer')) { const b = document.querySelector('[data-dsh-sidebar-toggle]'); if (!b) return 'no-sidebar-toggle'; tap(b); await sleep(700); } if (!mobile && kinds().length === 0) { " + OPEN_SETTINGS_SRC + " const opened = await openSettings(); if (!opened.el) return 'no-settings-entry:' + opened.opener; tap(opened.el); await sleep(1600); } return { mobile, depth: window.__dshBackDepth, kinds: kinds(), cached: window.dshBackBridge?.getBackAvailable?.() }; })()",
    (v) => v && v.depth >= 1 && v.cached === true && Array.isArray(v.kinds)
      && (v.mobile ? v.kinds.includes('drawer') : true)],
  ['层栈消费（__dshBack 弹出该层）→ 层数下降且壳侧缓存回读 false',
    "(async () => { const before = window.__dshBackDepth; const consumed = typeof window.__dshBack === 'function' ? window.__dshBack() : 'no-entry'; await new Promise(r => setTimeout(r, 400)); return { before, consumed, depth: window.__dshBackDepth, cached: window.dshBackBridge?.getBackAvailable?.() }; })()",
    (v) => v && v.consumed === true && v.before >= 1 && v.depth === v.before - 1 && v.cached === (v.depth > 0)],
  // ── 0.14.0-preview 追加：壳侧状态 getter 在场（计划 §4.3 ST-10/ST-11）──
  ['桥 getImmersiveMode 在场（ST-10 壳侧唯一真源）', "typeof window.androidBridge?.getImmersiveMode === 'function'", true],
  ['getImmersiveMode 返回布尔（回读壳侧偏好真值）', "typeof window.androidBridge?.getImmersiveMode?.() === 'boolean'", true],
  // ── 0.14.2 追加：Shizuku「重置链接」（P1）──
  // ① 桥面在场：页面能调用（TS 类型面与 @JavascriptInterface 两侧都接上的证据）。
  ['桥 resetShizukuConnection 在场（P1 重置链接的跨层面）', "typeof window.androidBridge?.resetShizukuConnection === 'function'", true],
  // ② 按钮真实渲染且可点：用户真的点得到（探针与实测前置见 RESET_BUTTON_PROBE 的注释）。
  ['「重置链接」按钮真实渲染且可点（清浮层→开设置→点手机控制页签）',
    RESET_BUTTON_PROBE,
    (v) => !!v && typeof v === 'object' && v.section === true && v.present === true
      && v.disabled === false && v.visible === true && v.w > 0 && v.h > 0],
]

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
const results = []

/**
 * 把「面板展开态与 corner 展开键的互斥」先钉成实测形态，再交给断言判。
 *
 * 上游 ExpandButton.tsx:33-34 在 expanded 时 return null，所以按钮有无本身不是固定事实；
 * 这里不猜、不绑方向：读初态 → （有按钮时）点它展开 → 再读 → （展开态下）点收起键回到收起态 → 再读，
 * 每一步都记一份 {panel, open, button}，每次点击都记下它是否真的翻转了面板状态。
 * 返回的一行在下列条件全成立时才判绿：
 * (1) 至少观测到一次面板已挂载；(2) 至少观测到两次状态（含一次真实点击）；
 * (3) 每一次观测都满足 button === !open（收起与展开两个方向都成立）；
 * (4) 每一次点击都真的翻转了状态（点不动 = 用户开不了/收不掉面板，是真缺陷，不得静默放过）。
 * 面板未挂载（上游 RightbarSeat 在 surface 未建时返回 null，见 SidebarRight.tsx:433）时如实记账为
 * 未挂载，该形态下按钮必然缺席而互斥式恒真，故此处不判绿，避免「面板没起来」被读成通过。
 * @returns 与 checks 同构的一行 [是否通过, 标签, 读数]。
 */
async function pinPanelStates() {
  const observations = []
  const flips = []
  const observe = async () => {
    const value = await evaluate(CORNER_PROBE)
    observations.push(value)
    return value
  }
  const click = async (selector) => {
    await evaluate('(() => { const b = document.querySelector(' + JSON.stringify(selector) + '); if (b) b.click(); return !!b })()')
    await new Promise(r => setTimeout(r, 400))
  }
  const before = await observe()
  const mounted = !!before && before.panel === true
  if (mounted && before.button === true) {
    await click('[data-conversation-header-corner] button')
    const after = await observe()
    flips.push(!!after && after.open === true)
  }
  const last = observations[observations.length - 1]
  if (mounted && last && last.open === true) {
    await click('[data-sidebar-right-toggle]')
    const after = await observe()
    flips.push(!!after && after.open === false)
  }
  const agreed = observations.every(o => !!o && o.button === !o.open)
  const flipped = flips.length >= 1 && flips.every(Boolean)
  const sequence = observations.map(o => (o && o.open) ? 'expanded' : 'collapsed').join('->')
  const clicks = flips.length === 0 ? 'none' : flips.map(f => f ? 'flipped' : 'no-op').join(',')
  return [
    mounted && agreed && observations.length >= 2 && flipped,
    '面板状态固定：先钉形态再判互斥（mounted=' + mounted + '，序列 ' + sequence + '，点击 ' + clicks + '）',
    JSON.stringify(observations),
  ]
}

ws.onopen = async () => {
  const measured = await evaluate('({ width: window.innerWidth, height: window.innerHeight })')
  console.log('实测 viewport: ' + JSON.stringify(measured) + ' → 形态判据 mobile = ' + (measured && measured.width <= MOBILE_FORM_MAX_WIDTH))
  // 站点 3 的前置必须先于任何依赖面板状态的断言：它会把面板状态钉成一个确定的最终形态。
  results.push(await pinPanelStates())
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
