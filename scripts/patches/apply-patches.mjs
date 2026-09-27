#!/usr/bin/env node
/**
 * apply-patches.mjs — vendor 固化插件统一补丁 runner（Phase 2a 补丁统合，2026-09-05）
 *
 * 单一入口管理快照注入链的全部 vendor 补丁（登记表 = 本目录 registry.json；
 * 实现 = 本文件 IMPLS，二者 id 必须一一对应——启动时交叉校验，漂移即拒）：
 *  - dshmarketplace-plugin 0.1.5：A pre-execute 守卫 / B execPath 安全化 /
 *    C 不可安装置灰 / D 移动兼容徽章 + mobile: 过滤（server+client，
 *    COMPAT_MAP/NOTE 出码 data/compat-map.json）
 *  - dsh-undo-savepoint 0.3.8：E1-E7 移动端裁剪（字节级锚点，见其 PATCHES.md）
 *
 * 用法：node scripts/patches/apply-patches.mjs <vendorRoot> [--check|--apply|--list] [--only id1,id2]
 *   --check（默认）：验证全部补丁在场——全在场退出 0；任一缺席退出 1（构建门禁）
 *   --apply：幂等施加（已应用跳过）+ 自验；锚点失配退出 1（拒绝写半成品）
 *   --list：列出登记表与状态
 *   --only：只处理指定 id（逗号分隔；引导性分步施加用）
 * 退出码：0 成功 / 1 补丁失败或锚点失配 / 2 用法错误。
 * 雷点 8 约定：本脚本全量输出，构建链禁止 Select-First 截断（截断会杀 node 致误判失败）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const registry = JSON.parse(readFileSync(join(HERE, 'registry.json'), 'utf8'))
const compat = JSON.parse(readFileSync(join(HERE, 'data', 'compat-map.json'), 'utf8'))

// ── dshmarketplace-plugin：A（pre-execute 守卫）已于 0.1.7 退役 ──────────────
// 上游 0.1.7 自己修好了这个 waterfall 崩溃：listener 工厂 `function b(t=c){return async(r,n)=>{
// let e=()=>typeof n=="function"?n():{kind:"allow"},...return s??e()}}` —— 每条路径都返回一个
// gate 对象（无 next 时回落 {kind:"allow"}），不再是恒返 undefined。锚点随之消失。
// 退役记录保留在 registry.json 的 `retired` 段与 vendor PATCHES.md，可审计。

// 文件内容缓存（同一目标文件的多补丁顺序生效）
const IMPL_state = {}

function loadImpl(target, vendorRoot) {
  const key = target
  if (!(key in IMPL_state)) IMPL_state[key] = readFileSync(join(vendorRoot, target), 'utf8')
  return IMPL_state[key]
}
function saveImpl(target, vendorRoot) {
  writeFileSync(join(vendorRoot, target), IMPL_state[target])
}

// F7 v1 双占位形态（0.14.0-preview 实锤坏资产；review C1）：publish 站先内联 open("wx") 占位、
// 随后又调 helper 占位 → 同一路径第二次 O_EXCL 必得 EEXIST → publishCurrentExclusive 恒 return false。
// 该串是坏形态的唯一特征（v2 正确形态只在模块级 helper 内出现一次，且变量名是 targetPath）。
const F7_LEGACY_INLINE = 'const claim = await open(currentPath, "wx");'

const IMPLS = {

  // ── marketplace B：安装 runner execPath 安全化（apk#83/#89 bad ELF magic）──
  'market-B': {
    file: 'dshmarketplace-plugin/lib/index.js',
    check: (s) => s.includes('execPath:(process.env.TERMUX__PREFIX||"/data/data/com.dsharnessmobile.shell/files/usr")+"/bin/node"'),
    apply: (s) => {
      const OLD = 'execPath:process.execPath,cliPath:process.argv[1]'
      const NEW = 'execPath:(process.env.TERMUX__PREFIX||"/data/data/com.dsharnessmobile.shell/files/usr")+"/bin/node",cliPath:process.argv[1]'
      if (s.includes(OLD)) return s.replace(OLD, NEW)
      if (s.includes(NEW)) return s
      throw new Error('execPath 锚点未命中且安全化形态不在场——T() 实现可能已变，请人工核对')
    },
  },

  // ── marketplace C（不可安装条目置灰）已于 0.1.7 退役 ──────────────────────────
  // 上游 0.1.7 服务端新增 installCheck:"passed" 过滤：search 端点与 dshmarketplace_search 工具
  // 都只返回安装校验通过的条目，客户端因此拿不到 installable:false 的行，置灰已无对象。
  // 实测（2026-09-26，api/v1/plugins 分页 1200 条）：installCheck===passed 800 条中
  //   installable===false = 0、install 为空 = 0；未通过的 400 条里 installable===false = 85。
  // 退役记录见 registry.json 的 retired 段与 vendor PATCHES.md。

  // ── marketplace D-server：搜索响应 compat 富化 + mobile: 过滤（含 COMPAT_MAP 幂等刷新）──
  'market-D-server': {
    file: 'dshmarketplace-plugin/lib/index.js',
    check: (s) => s.includes('function Wc('),
    apply: (s) => {
      const MAP = JSON.stringify(compat.compatMap)
      const NOTE = JSON.stringify(compat.compatNote)
      if (s.includes('function Wc(')) {
        // 幂等 + map 强制同步（别名增补等数据更新直接反映到已修补文件）
        const mapRe = /let _=\{.*?\},e=String\(t\.fullName/
        if (!mapRe.test(s)) throw new Error('D map 锚点未命中——请人工核对')
        return s.replace(mapRe, `let _=${MAP},e=String(t.fullName`)
      }
      const D_SRV = `function Wc(t){let _=${MAP},e=String(t.fullName??"").split("#").pop().split("/").pop().toLowerCase(),f=_?.[e]??"unknown",n=${NOTE}[f];return{...t,compat:f,compatNote:n}}`
      // 0.1.7 重新 minify：apply 函数名与搜索端点标识符都变了（qt 绑定仍在，handler 内是 c/（l,200,p(a))）。
      // 插入锚点用 apply 函数声明，缺失时回落到 export-name 绑定；两者都失配则明确报错（check 会拒打包）。
      const INSERT_BEFORE = s.includes('function Dt(t){') ? 'function Dt(t){' : (s.includes('var qt=') ? 'var qt=' : null)
      if (INSERT_BEFORE === null) throw new Error('D 插入锚点未命中——apply 函数与 export 绑定都不在场，请人工核对')
      // 0.1.7 的服务端搜索 handler：上游新增 installCheck:"passed"，我们只在这段前后加 mobile: 过滤与富化。
      const OLD = 'let a=await c({q:s.searchParams.get("q")??void 0,category:s.searchParams.get("category")??void 0,limit:s.searchParams.get("limit")??60,installCheck:"passed"});l(e,200,p(a))'
      const NEW = 'let _q=s.searchParams.get("q")??void 0,_m=String(_q??"").startsWith("mobile:");if(_m)_q=String(_q).slice(7).trim()||void 0;let a=await c({q:_q,category:s.searchParams.get("category")??void 0,limit:s.searchParams.get("limit")??60,installCheck:"passed"});a.results=(a.results??[]).map(x=>Wc(x));if(_m)a.results=a.results.filter(x=>x.compat!=="desktop");l(e,200,p(a))'
      s = s.replace(INSERT_BEFORE, D_SRV + INSERT_BEFORE)
      if (!s.includes(OLD)) {
        const i = s.indexOf('searchParams.get("q")')
        throw new Error('D 搜索端点锚点未命中——上游 handler 可能已变：' + (i >= 0 ? s.slice(i, i + 120) : '（找不到 q 参数段）'))
      }
      s = s.replace(OLD, NEW)
      if (!s.includes('function Wc(') || !s.includes('compat!=="desktop"')) throw new Error('D-server 复核失败——不写回')
      return s
    },
  },

  // ── marketplace D-client：兼容徽章 + 仅移动端复选框 ──
  // ── market-route-auth-U2：商城 exact 路由不绕过 /api 信任栅栏（apk #222 衍生审计）──
  // vendor 的 search/install 都以 exact 路由注册在 /api/dshmarketplace/*；在 webserver 的 exact-first
  // 分派下同样不经过 client-connection 的 /api prefix。商城安装会改 profile，故两个端点一律要求
  // connection 的 Host/Origin/browser-session 栅栏；缺 connection 也必须 401，不得乐观放行。
  'market-route-auth-U2': {
    file: 'dshmarketplace-plugin/lib/index.js',
    check: (s) => s.includes('dsh-mobile marketplace route auth (U2)') && s.includes('dsh-mobile marketplace no-store (U2)'),
    apply: (s) => {
      const AUTH_OLD = 'let dshMobileMarketplaceRouteAuthorized=(n,e)=>{/* dsh-mobile marketplace route auth (U2) */let r=401;try{let s=t.get?.("connection");typeof s?.requestRejection==="function"&&(r=s.requestRejection(n))}catch{}if(r===void 0)return!0;e.writeHead(r===403?403:401);e.end();return!1};'
      const AUTH_NEW = `let dshMobileMarketplaceRouteAuthorized=(n,e)=>{/* dsh-mobile marketplace route auth (U2); dsh-mobile marketplace no-store (U2) */let r=401;try{let s=t.get?.("connection");typeof s?.requestRejection==="function"&&(r=s.requestRejection(n))}catch{}if(r===void 0)return!0;if(r===403){e.writeHead(403,{"cache-control":"no-store"});e.end()}else{e.writeHead(401,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});e.end('{"ok":false,"error":"unauthorized"}')}return!1};`
      if (s.includes(AUTH_NEW)) return s
      if (s.includes(AUTH_OLD)) return s.replace(AUTH_OLD, AUTH_NEW)
      // 0.1.7 标识符重命名：A()->I()、Q->et、V->rt、b()->N。锚点按新字节写死，
      // 并保留 0.1.5 旧形态作为兜底（两个版本都能重锚，便于回退排障）。
      const SEARCH_OLD = s.includes('let r=I();r&&t.skills.register(r),t.webServer.register({kind:"exact",path:et,handler:async(n,e)=>{')
        ? 'let r=I();r&&t.skills.register(r),t.webServer.register({kind:"exact",path:et,handler:async(n,e)=>{'
        : 'let r=A();r&&t.skills.register(r),t.webServer.register({kind:"exact",path:Q,handler:async(n,e)=>{'
      // SEARCH_NEW 做两件事，缺一即半成品（此前只做第 1 件，导致 search 路由实际无鉴权）：
      //   1) 在 skills 注册与 webServer 注册之间插入 AUTH_NEW 定义（原来是逗号，改成 ";" + 定义）；
      //   2) 把 guard 调用插进 search handler 体的开头。
      // 用纯字符串替换而非正则：path 值是标识符、其后紧跟 ",handler:"，正则容易失配（实测踩到）。
      const SEARCH_SEP = ',t.webServer.register({kind:"exact",path:'
      if (!SEARCH_OLD.includes(SEARCH_SEP)) throw new Error('market-route-auth 锚点未命中：search 注册段分隔形态已变')
      const HANDLER_OPEN = ',handler:async(n,e)=>{'
      if (!SEARCH_OLD.includes(HANDLER_OPEN)) throw new Error('market-route-auth 锚点未命中：search handler 开头形态已变')
      const SEARCH_NEW = SEARCH_OLD
        .replace(SEARCH_SEP, ';' + AUTH_NEW + 't.webServer.register({kind:"exact",path:')
        .replace(HANDLER_OPEN, ',handler:async(n,e)=>{if(!dshMobileMarketplaceRouteAuthorized(n,e))return;')
      const INSTALL_OLD = s.includes('t.webServer.register({kind:"exact",path:rt,handler:N({install:n=>f(n,T()),onInstalled:h})})')
        ? 't.webServer.register({kind:"exact",path:rt,handler:N({install:n=>f(n,T()),onInstalled:h})})'
        : 't.webServer.register({kind:"exact",path:V,handler:b({install:n=>p(n,T()),onInstalled:f})})'
      const INSTALL_NEW = s.includes('path:rt,handler:N(')
        ? 't.webServer.register({kind:"exact",path:rt,handler:async(n,e)=>{if(!dshMobileMarketplaceRouteAuthorized(n,e))return;return N({install:s=>f(s,T()),onInstalled:h})(n,e)}})'
        : 't.webServer.register({kind:"exact",path:V,handler:async(n,e)=>{if(!dshMobileMarketplaceRouteAuthorized(n,e))return;return b({install:s=>p(s,T()),onInstalled:f})(n,e)}})'
      if (!s.includes(SEARCH_OLD)) throw new Error('market-route-auth 锚点未命中：search route 起点已变')
      if (!s.includes(INSTALL_OLD)) throw new Error('market-route-auth 锚点未命中：install route 已变')
      s = s.replace(SEARCH_OLD, SEARCH_NEW).replace(INSTALL_OLD, INSTALL_NEW)
      if (!s.includes('dsh-mobile marketplace route auth (U2)')) throw new Error('market-route-auth 复核失败——不写回')
      return s
    },
  },

  'market-D-client': {
    file: 'dshmarketplace-plugin/lib/client.js',
    check: (s) => s.includes('dshm-compat'),
    apply: (s) => {
      const HELPERS = `function Uq(e){return e==="ok"?"#2f9e68":e==="desktop"?"#b96a2a":e==="native"?"#8a5fc0":"#8a8f98"}function Uw(e){return e==="ok"?"移动可用":e==="desktop"?"仅桌面":e==="native"?"原生?":"未验证"}`
      const HELPERS_ANCHOR = 'var B=Object.create;var h=Object.defineProperty;'
      const BADGE_OLD = 'i?s.default.createElement("span",{className:"dshm-risk"},e.riskFlags.join(" \\xB7 ")):null,s.default.createElement("a",{href:e.url,target:"_blank",rel:"noopener"},r("details"))'
      const BADGE_NEW = 'i?s.default.createElement("span",{className:"dshm-risk"},e.riskFlags.join(" \\xB7 ")):null,s.default.createElement("span",{className:"dshm-compat",style:{margin:"0 0 0 6px",fontSize:11,padding:"0 6px",borderRadius:4,color:"#fff",background:Uq(e.compat)}},Uw(e.compat)),s.default.createElement("a",{href:e.url,target:"_blank",rel:"noopener"},r("details"))'
      const FILTER_OLD = 'onChange:o=>m(o.target.value)}),l==="loading"'
      const FILTER_NEW = 'onChange:o=>m(o.target.value)}),s.default.createElement("label",{style:{marginLeft:10,display:"inline-flex",alignItems:"center",gap:4,fontSize:13}},s.default.createElement("input",{type:"checkbox",checked:/^mobile:/.test(n),onChange:o=>{let v=(n||"").replace(/^mobile:\\s*/,"");m(o.target.checked?"mobile: "+v:v)}}),"仅移动端可用"),l==="loading"'
      if (!s.includes(HELPERS_ANCHOR)) throw new Error('D 助手锚点未命中——请人工核对')
      s = s.replace(HELPERS_ANCHOR, HELPERS + HELPERS_ANCHOR)
      if (!s.includes(BADGE_OLD)) {
        const i = s.indexOf('dshm-risk"')
        throw new Error('D 徽章锚点未命中——dshm-risk 段已变：' + (i >= 0 ? s.slice(i, i + 120) : '（找不到段）'))
      }
      s = s.replace(BADGE_OLD, BADGE_NEW)
      if (!s.includes(FILTER_OLD)) {
        const j = s.indexOf('dshm-search"')
        throw new Error('D 过滤锚点未命中——搜索框段已变：' + (j >= 0 ? s.slice(j, j + 100) : '（找不到段）'))
      }
      s = s.replace(FILTER_OLD, FILTER_NEW)
      if (!s.includes('dshm-compat') || !s.includes('仅移动端可用')) throw new Error('D-client 复核失败——不写回')
      return s
    },
  },

  // ── dsh-undo-savepoint E1-E7（0.3.8 移动端裁剪，字节级锚点）──
  'undo-E1': {    file: 'dsh-undo-savepoint/lib/client.js',
    // 移除类：标记不存在 = 已应用
    check: (s) => !s.includes('size: 14 }), t("snapshots")]'),
    apply: (s) => {
      const iAnchor = s.indexOf('className: styles.btn + " " + styles.undo,')
      const iStart = s.lastIndexOf('(0, react_jsx_runtime.jsx)("button", {', iAnchor)
      const iSnap = s.indexOf('size: 14 }), t("snapshots")]')
      // 结束锚：快照按钮内容行之后的按钮级 "}),"——即下次"stat !== null（徽章）"前的最近 "}),"。
      // 不能对 iSnap 直接 indexOf("}),")：会命中 CameraIcon 自身的 "14 }),"（历史 bug）。
      const iStat = s.indexOf('\t\t\t\t\tstat !== null', iSnap)
      const iEnd = s.lastIndexOf('}),', iStat) + 3
      if (iAnchor < 0 || iStart < 0 || iSnap < 0 || iStat < 0 || iEnd < 3) throw new Error('E1 锚点缺失')
      return s.slice(0, iStart) + s.slice(iEnd)
    },
  },
  'undo-E2': {
    file: 'dsh-undo-savepoint/lib/client.js',
    check: (s) => !s.includes('//#region KeyBindRow (settings.general.item)'),
    apply: (s) => {
      const iStart = s.indexOf('//#region KeyBindRow (settings.general.item)')
      if (iStart < 0) throw new Error('E2 起点缺失')
      const iEnd = s.indexOf('//#endregion', iStart)
      if (iEnd < 0) throw new Error('E2 终点缺失')
      const after = s.indexOf('\n', iEnd)
      return s.slice(0, iStart) + s.slice(after + 1)
    },
  },
  'undo-E3': {
    file: 'dsh-undo-savepoint/lib/client.js',
    check: (s) => !s.includes('}, KeyBindRow)));'),
    apply: (s) => {
      const iStart = s.indexOf('// Custom shortcut settings row (General settings)')
      const iEnd = s.indexOf('}, KeyBindRow)));', iStart)
      if (iStart < 0 || iEnd < 0) throw new Error('E3 锚点缺失')
      const after = s.indexOf('\n', iEnd)
      return s.slice(0, iStart) + s.slice(after + 1)
    },
  },
  'undo-E4': {
    file: 'dsh-undo-savepoint/lib/client.js',
    check: (s) => !s.includes('"dsh-undo-savepoint: keyboard"'),
    apply: (s) => {
      const iStart = s.indexOf('// Global keyboard shortcuts')
      const iEnd = s.indexOf('"dsh-undo-savepoint: keyboard"', iStart)
      if (iStart < 0 || iEnd < 0) throw new Error('E4 锚点缺失')
      const after = s.indexOf('\n', iEnd)
      return s.slice(0, iStart) + s.slice(after + 1)
    },
  },
  'undo-E5': {
    file: 'dsh-undo-savepoint/lib/client.js',
    check: (s) => !s.includes('exports.KeyBindRow'),
    apply: (s) => {
      const iStart = s.indexOf('exports.KeyBindRow')
      if (iStart < 0) throw new Error('E5 锚点缺失')
      const after = s.indexOf('\n', iStart)
      return s.slice(0, iStart) + s.slice(after + 1)
    },
  },
  'undo-E6': {
    file: 'dsh-undo-savepoint/lib/client.js',
    check: (s) => !s.includes('relativeTime(stat.latest, t) || ""'),
    apply: (s) => {
      const anchor = '\t\t\t\t\t\t\tstat.latest ? " · " + (relativeTime(stat.latest, t) || "") : ""'
      const a = s.indexOf(anchor)
      if (a < 0) throw new Error('E6 锚点缺失')
      const lineStart = s.lastIndexOf('\n', a)
      const lineEnd = s.indexOf('\n', a)
      return s.slice(0, lineStart) + s.slice(lineEnd)
    },
  },
  'undo-E7': {
    file: 'dsh-undo-savepoint/lib/client.js',
    // 新增类：标记存在 = 已应用（isRemoval=false 语义）
    check: (s) => s.includes('gap:5px;white-space:nowrap;flex:none;max-width:30vw'),
    apply: (s) => {
      const anchor = 'gap:5px;white-space:nowrap;flex:none}.u_badge:hover'
      const a = s.indexOf(anchor)
      if (a < 0) throw new Error('E7 锚点缺失')
      return s.slice(0, a) + 'gap:5px;white-space:nowrap;flex:none;max-width:30vw;overflow:hidden;text-overflow:ellipsis}.u_badge:hover' + s.slice(a + anchor.length)
    },
  },

  // ── undo-E8：快照徽章折叠成小绿点（2026-09-10 用户定例）──
  // 会话头部在 360dp 竖屏已被「模式徽章 + 打开方式 + … + 右栏键」占满，
  // 「已存 N 份快照」的文字徽章把标题挤成省略号，更窄处还会错位。
  // 口径：直接折叠成一个小绿点——数量与含义挪进 title/aria-label（悬停/读屏仍可见），
  // 点击行为不变（打开快照管理面板）。E6（去相对时间）与 E7（宽度封顶）保留但已非必需；
  // E7 的 marker 串保持不动（改它会让 E7 误判未应用 → 二次施加锚点失配）。
  'undo-E8': {
    file: 'dsh-undo-savepoint/lib/client.js',
    check: (s) => s.includes('dsh-mobile dot-only badge'),
    apply: (s) => {
      if (s.includes('dsh-mobile dot-only badge')) return s
      const TEXT = 't("badge.count", { n: stat.total }),'
      if (!s.includes(TEXT)) throw new Error('E8 锚点缺失：badge.count 文本节点')
      s = s.replace(TEXT, '// dsh-mobile dot-only badge: 数量只在 title/aria-label 里，头部只留绿点')
      const TITLE = 'title: t("badge.title"),'
      const ARIA = '"aria-label": t("badge.title"),'
      if (!s.includes(TITLE) || !s.includes(ARIA)) throw new Error('E8 锚点缺失：badge title/aria-label')
      s = s.replace(TITLE, 'title: t("badge.title") + " · " + t("badge.count", { n: stat.total }),')
      s = s.replace(ARIA, '"aria-label": t("badge.title") + ", " + t("badge.count", { n: stat.total }),')
      // 同优先级后置规则覆盖上面的胶囊样式：20x20 圆形、绿点居中（不改 E7 的 marker 串）。
      const CSS_END = 'overflow:hidden}";'
      if (!s.includes(CSS_END)) throw new Error('E8 锚点缺失：css2 结尾')
      s = s.replace(CSS_END, 'overflow:hidden}.u_badge{padding:0;width:20px;height:20px;justify-content:center;gap:0}";')
      if (!s.includes('dsh-mobile dot-only badge')) throw new Error('E8 复核失败——不写回')
      return s
    },
  },

  // ── undo-api-auth-U1：/api/undo 更长 prefix 不得绕过 /api 信任栅栏（apk #222）──
  // 上游 webserver 先匹配 exact、随后 longest-prefix；/api/undo 因此不会进入 client-connection
  // 注册的 /api prefix handler。此补丁在 undo handler 的**第一条语句**重建同一 Host/Origin/cookie
  // 栅栏，并允许壳侧共享 controlToken 供本机投递；未认证读写均在读取 body/快照之前失败关闭。
  'undo-api-auth-U1': {
    file: 'dsh-undo-savepoint/lib/index.js',
    check: (s) => s.includes('dsh-mobile undo route auth (U1)') && s.includes('dsh-mobile undo no-store (U1)'),
    apply: (s) => {
      const SEND_OLD = "      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });"
      const SEND_NEW = "      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); // dsh-mobile undo no-store (U1)"
      if (!s.includes('dsh-mobile undo no-store (U1)')) {
        if (!s.includes(SEND_OLD)) throw new Error('undo-api-auth 锚点未命中：REST send() 响应头已变')
        s = s.replace(SEND_OLD, SEND_NEW)
      }
      if (s.includes('dsh-mobile undo route auth (U1)')) return s
      const AUTH_ANCHOR = '    const readJson = (req) => new Promise((resolve) => {'
      const AUTH = [
        '    // dsh-mobile undo route auth (U1): /api/undo is a longer prefix than /api, so it must',
        '    // enforce the same Host/Origin/browser-session fence before every read or mutation.',
        '    const dshMobileUndoHeader = (req, name) => {',
        '      const value = req?.headers?.[name];',
        "      return typeof value === 'string' ? value : (Array.isArray(value) ? value[0] : undefined);",
        '    };',
        '    const dshMobileUndoControlToken = () => {',
        "      const valid = (value) => typeof value === 'string' && value.length >= 8 ? value : undefined;",
        '      const prefsPath = process.env.DSH_ADB_PREFS_PATH',
        "        ?? ((process.env.TERMUX__PREFIX && process.env.DSH_HOME) ? '/data/user/0/com.dsharnessmobile.shell/shared_prefs/dsh-adb.xml' : undefined);",
        '      let fromPrefs;',
        '      if (prefsPath) {',
        "        try { fromPrefs = valid(/<string\\s+name=\"controlToken\">([^<]*)<\\/string>/.exec(readFileSync(prefsPath, 'utf8'))?.[1]); }",
        '        catch { /* Android prefs unavailable: the browser-session path below remains fail-closed. */ }',
        '      }',
        "      const testMode = process.env.DSH_CONTROL_TOKEN_TEST;",
        "      return testMode === '1' || testMode === 'true' ? valid(process.env.DSH_CONTROL_TOKEN) ?? fromPrefs : fromPrefs;",
        '    };',
        '    const dshMobileUndoAuthorize = (req) => {',
        '      let connection;',
        "      try { connection = ctx.get?.('connection'); } catch { connection = undefined; }",
        "      if (typeof connection?.requestRejection === 'function') {",
        '        try {',
        '          const rejection = connection.requestRejection(req);',
        '          if (rejection === undefined) return undefined;',
        '          if (rejection === 403) return { status: 403 };',
        '          const controlToken = dshMobileUndoControlToken();',
        "          return controlToken !== undefined && controlToken === dshMobileUndoHeader(req, 'x-dsh-control-token') ? undefined : { status: 401 };",
        '        } catch { return { status: 401 }; }',
        '      }',
        "      const host = dshMobileUndoHeader(req, 'host')?.trim().toLowerCase();",
        "      if (host !== '127.0.0.1:3080' && host !== 'localhost:3080') return { status: 403 };",
        "      if (dshMobileUndoHeader(req, 'sec-fetch-site')?.toLowerCase() === 'cross-site') return { status: 403 };",
        "      const origin = dshMobileUndoHeader(req, 'origin');",
        "      if (origin && origin.toLowerCase() !== 'http://127.0.0.1:3080' && origin.toLowerCase() !== 'http://localhost:3080') return { status: 403 };",
        '      const controlToken = dshMobileUndoControlToken();',
        "      return controlToken !== undefined && controlToken === dshMobileUndoHeader(req, 'x-dsh-control-token') ? undefined : { status: 401 };",
        '    };',
        '    const dshMobileUndoReject = (res, rejection) => {',
        "      if (rejection.status === 403) { res.writeHead(403, { 'cache-control': 'no-store' }); res.end(); return; }",
        "      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });",
        "      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));",
        '    };',
      ].join('\n')
      if (!s.includes(AUTH_ANCHOR)) throw new Error('undo-api-auth 锚点未命中：REST readJson() 片段已变')
      s = s.replace(AUTH_ANCHOR, AUTH + '\n' + AUTH_ANCHOR)
      const HANDLER = '      handler: async (req, res) => {'
      const GUARD = [
        '        const rejection = dshMobileUndoAuthorize(req);',
        '        if (rejection !== undefined) { dshMobileUndoReject(res, rejection); return; }',
      ].join('\n')
      if (!s.includes(HANDLER)) throw new Error('undo-api-auth 锚点未命中：REST handler 起点已变')
      s = s.replace(HANDLER, HANDLER + '\n' + GUARD)
      if (!s.includes('dsh-mobile undo route auth (U1)')) throw new Error('undo-api-auth 复核失败——不写回')
      return s
    },
  },

  // ── narb-android-N1：Android 无预编译 node-addon-require-builtin 绑定（0.14.2 追上游 0.1.7-rc.1）──
  // 0.1.7-rc.1 的 dsh-app-boot 新增依赖 node-addon-require-builtin（0.1.5 的 app-boot 里
  // require-builtin / internalModules 零命中，已比对 0.1.5 夹具）；它在
  // packages/boot/app-boot/src/profile-resolution/resolver.ts 的 internalModules() 里用 native
  // 拿 Node 内部 loader（internal/modules/esm/loader 等）来装 profile 解析拦截。
  //
  // 该包只发布 darwin/linux/win32 七元组，**无 android**（npm 上
  // node-addon-require-builtin-android-x64 = 404；上游 native/system/docs/support-matrix.md
  // 明写「Other CPU/OS combinations have no published platform package」）。
  // 设备实测（16416，engine.log 首行 + boot-fail.log 连记 4 轮）：
  //   dsh: fatal uncaught exception: Error: dsh: host preparation failed:
  //     No usable native binding found for node-addon-require-builtin-android-x64 (auto)
  // ⇒ 引擎在 boot 阶段硬崩，**不是** PLAN §2.1 预测的「静默禁用插件」，而是根本没起来。
  //
  // 不变量：拿不到 native addon 不能杀死 boot。壳侧本来就以 --expose-internals 起 node
  // （EngineManager.kt:1036 的 argv 第二项），设备实测该 flag 恰好暴露 rc.1 internalModules()
  // 需要的五个 internal/modules/*，且形状与它的逐条校验全部吻合（esm.resolveSync /
  // getOrCreateModuleJob / cjs._resolveFilename / getCjsConditions / getDefaultConditions /
  // defaultResolve）。故 native 不可用时回落 require(moduleId) —— 与内置模块同一实现，
  // 不是「假装成功」。
  'narb-android-N1': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/node-addon-require-builtin/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile native-binding fallback (N1)'),
    apply: (s) => {
      if (s.includes('dsh-mobile native-binding fallback (N1)')) return s
      const OLD = [
        "const node_path_1 = __importDefault(require(\"node:path\"));",
        "const { createEntryApi } = require('node-addon-native-custom-loader');",
        "const api = createEntryApi(node_path_1.default.resolve(__dirname, '..'));",
      ].join('\n')
      const NEW = [
        "const node_path_1 = __importDefault(require(\"node:path\"));",
        "// dsh-mobile native-binding fallback (N1): no prebuilt addon for this platform (Android has none).",
        "// The shell already launches node with --expose-internals, which exposes exactly the",
        "// internal/modules/* entries internalModules() needs; fall back to require() for them",
        "// instead of crashing host preparation. See scripts/patches/registry.json narb-android-N1.",
        "let api;",
        "try {",
        "    const { createEntryApi } = require('node-addon-native-custom-loader');",
        "    api = createEntryApi(node_path_1.default.resolve(__dirname, '..'));",
        "} catch (error) {",
        "    api = undefined;",
        "    if (!globalThis.__dshMobileNativeBindingFallbackWarned) {",
        "        globalThis.__dshMobileNativeBindingFallbackWarned = true;",
        "        console.warn('node-addon-require-builtin: no prebuilt native binding for this platform; ' +",
        "            'falling back to require() (dsh-mobile N1, requires --expose-internals): ' +",
        "            (error && error.message ? error.message : String(error)));",
        "    }",
        "}",
      ].join('\n')
      const OLD_FNS = [
        "function requireBuiltin(moduleId) {",
        "    return api.requireBuiltin(moduleId);",
        "}",
        "function isAllowedInternalId(moduleId) {",
        "    return api.isAllowedInternalId(moduleId);",
        "}",
        "function getBindingInfo() {",
        "    return api.getBindingInfo();",
        "}",
      ].join('\n')
      const NEW_FNS = [
        "function requireBuiltin(moduleId) {",
        "    if (api !== undefined) return api.requireBuiltin(moduleId);",
        "    return require(moduleId);",
        "}",
        "function isAllowedInternalId(moduleId) {",
        "    if (api !== undefined) return api.isAllowedInternalId(moduleId);",
        "    try { require(moduleId); return true; } catch { return false; }",
        "}",
        "function getBindingInfo() {",
        "    if (api !== undefined) return api.getBindingInfo();",
        "    return { backend: 'expose-internals', package: undefined, abi: process.versions.modules };",
        "}",
      ].join('\n')
      if (!s.includes(OLD)) {
        throw new Error('narb-android 锚点未命中：createEntryApi 顶层调用——引擎升级后请人工核对 node-addon-require-builtin/lib/index.js')
      }
      if (!s.includes(OLD_FNS)) {
        throw new Error('narb-android 锚点未命中：三个导出函数体——引擎升级后请人工核对 node-addon-require-builtin/lib/index.js')
      }
      s = s.replace(OLD, NEW).replace(OLD_FNS, NEW_FNS)
      if (!s.includes('dsh-mobile native-binding fallback (N1)')) throw new Error('narb-android 复核失败——不写回')
      return s
    },
  },

  // ── flock-android-F3：Android 无预编译 flock 绑定（0.13.7 追上游 0.1.5）──
  // 0.1.5 的 dsh-session-persistence-jsonl 用 @deepseek-ai/node-addon-system/flock 做
  // 会话目录写锁（session.lock，跨进程互斥）；dsh-sandbox-local 用同包的 landlock-run
  // 选 Linux 沙箱后端。该包（独立版本线 0.1.2）只发布 darwin/linux 预编译，
  // optionalDependencies 没有 android → Android 上 tryLockExclusive() 必抛
  // ERR_FLOCK_UNSUPPORTED_PLATFORM：会话写入直接失败（实测连整树 boot 都进不去）。
  //
  // 不变量：拿不到原生 flock 不能杀死会话写入。降级口径与上游自己的先例一致——
  // lease 模块注释明写「The browser worker stubs the native flock entry to immediate
  // success: it is single-process, so the in-process write claim already excludes every
  // writer」。Android 上同理：壳侧看门狗保证同一时刻只有一个引擎进程，
  // 进程内写声明已排除所有写者，故 stub 为立即成功并一次性告警（不记账、不误判 fd 复用）。
  'flock-android-F3': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/node-addon-system/lib/flock.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile flock fallback (F3)'),
    apply: (s) => {
      if (s.includes('dsh-mobile flock fallback (F3)')) return s
      const OLD = [
        "    if (platform !== 'linux' && platform !== 'darwin') {",
        '        throw Object.assign(new Error(`flock is not supported on ${platform}-${arch}`), {',
        "            code: 'ERR_FLOCK_UNSUPPORTED_PLATFORM',",
        "            syscall: 'flock',",
        '        });',
        '    }',
      ].join('\n')
      const NEW = [
        "    if (platform !== 'linux' && platform !== 'darwin') {",
        '        // dsh-mobile flock fallback (F3): no prebuilt binding for this platform. Single-process host',
        '        // (one engine process), so the in-process write claim already excludes',
        '        // every writer — same stub upstream ships for its browser worker.',
        '        if (!globalThis.__dshMobileFlockStubbed) {',
        '            globalThis.__dshMobileFlockStubbed = true;',
        '            console.warn(`node-addon-system: no prebuilt flock binding for ${platform}-${arch}; stubbed to immediate success (dsh-mobile F3, single-process host)`);',
        '        }',
        '        binding = { tryLock(_fd, done) { done(0); } };',
        '        return binding;',
        '    }',
      ].join('\n')
      if (!s.includes(OLD)) {
        throw new Error('flock-android 锚点未命中：unsupported-platform throw——引擎升级后请人工核对 node-addon-system/lib/flock.js')
      }
      s = s.replace(OLD, NEW)
      if (!s.includes('dsh-mobile flock fallback (F3)')) throw new Error('flock-android 复核失败——不写回')
      return s
    },
  },

  // ── atomic-stale-lock-F4：0.14.2 rc.2 追版退役（上游原生满足前提）──
  // 上游 rc.2 的 withFileLock 已自带孤儿锁回收 takeOverExitedLock()：重试循环里 isLockContention
  // 命中后立即尝试回收（claim 文件独占仲裁 + 回收前二次读锁 + 重新探活），语义比 F4 更严谨——
  // F4 的「二次核验」仍留 TOCTOU 窗口，上游用带 sha256 的 claim 文件关闭了它，并额外防护
  // 「死者的 pid 被活进程复用」。实测（rc.2 真产物，.deploy-tmp/lead-verify/f4probe.mjs）：
  // 孤儿锁 15ms 内成功执行且锁被清除；活锁对照正确超时且锁保留 ⇒ F4 的前提已被上游吸收。
  // 退役不等于失去守卫：回归就地改写为「撤销不变量守卫」
  // （scripts/patches/tests/atomic-stale-lock.test.mjs 改为直接对上游真产物断言该能力仍在）。
  // ── attach-durable-F2：附件持久化 Android 三件套（0.13.7 重出对齐，scope=engine）──
  // ① 祖先 fsync 守卫（2026-09-10 实测）：attachment-local 的 ensureDurableDirectory 从 DSH_HOME
  //    一路 fsync 到文件系统根（boundary = parse(home).root），而 Android 应用私有路径的祖先
  //    /data/user/0 对应用不可读 → open('/data/user/0') EACCES → 任何图片上传（session/prompt 的
  //    image 内容）在准入阶段抛错，api-proxy 兜底映射为 session/agent-busy；read_image 同理。
  //    不变量：打不开的祖先不再致命——上层目录由平台负责持久化。
  // ② 两处 link(2) → rename 回退（publishImmutableAlias.source / publishStagedObject.staged.path）：
  //    与 spj-migration-link-F5 同源根因（Android 应用域 SELinux 拒 hardlink，EACCES 被 dontaudit）。
  // ③ publishStagedObject 主链 unlink(staged.path) 容忍 ENOENT：回退 rename 已消费 staged 文件。
  // review C1（2026-09-14）：② ③ 此前只在运行时 asset 里（快照缺）——资产↔快照逐字节同源判据要求
  // 快照侧补齐，否则重出资产时必须二选一：丢修复或保持分叉（两者都不可接受）。
  'attach-durable-F2': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile durable-walk guard')
      && (s.match(/dsh-mobile link->rename fallback/g) || []).length === 2
      && s.includes('dsh-mobile: a link->rename fallback already consumed the staged file.'),
    apply: (s) => {
      // ① durable-walk guard
      if (!s.includes('dsh-mobile durable-walk guard')) {
        const OLD = 'const parent = dirname(level);\n\t\tawait syncDirectory(parent);'
        const NEW = [
          'const parent = dirname(level);',
          '\t\ttry { await syncDirectory(parent); } catch (error) {',
          '\t\t\t// dsh-mobile durable-walk guard: Android app-private ancestors (/data/user/0) are not readable by the app.',
          "\t\t\tif (error && (error.code === 'EACCES' || error.code === 'EPERM')) return;",
          '\t\t\tthrow error;',
          '\t\t}',
        ].join('\n')
        if (!s.includes(OLD)) {
          throw new Error('attach-durable 锚点未命中：syncDirectory(parent) 循环——引擎升级后请人工核对 ensureDurableDirectory')
        }
        s = s.replace(OLD, NEW)
      }
      // ② link(2) 回退两站（缩进随站点；与 asset 逐字节同源由 check-runtime-assets 守）
      const linkFallback = (from, to, indent) => [
        indent + `await link(${from}, ${to}).catch(async (error) => {`,
        indent + '\t/* dsh-mobile link->rename fallback: Android app-private dirs reject link(2) (EACCES). */',
        indent + '\tif (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP"))) throw error;',
        indent + `\tawait rename(${from}, ${to});`,
        indent + '});',
      ].join('\n')
      const SITE_A = '\t\t\tawait link(source, target);'
      const SITE_B = '\t\t\tawait link(staged.path, target);'
      if (s.includes(SITE_A)) s = s.replace(SITE_A, linkFallback('source', 'target', '\t\t\t'))
      else if (!s.includes('dsh-mobile link->rename fallback')) {
        throw new Error('attach-durable 锚点未命中：publishImmutableAlias 的 link(source, target)')
      }
      if (s.includes(SITE_B)) s = s.replace(SITE_B, linkFallback('staged.path', 'target', '\t\t\t'))
      else if (!s.includes('dsh-mobile link->rename fallback')) {
        throw new Error('attach-durable 锚点未命中：publishStagedObject 的 link(staged.path, target)')
      }
      // ③ unlink ENOENT 容忍
      const SITE_C = '\t\tawait unlink(staged.path);'
      if (s.includes(SITE_C)) {
        s = s.replace(SITE_C, [
          '\t\tawait unlink(staged.path).catch((error) => {',
          '\t\t\t/* dsh-mobile: a link->rename fallback already consumed the staged file. */',
          '\t\t\tif (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;',
          '\t\t});',
        ].join('\n'))
      } else if (!s.includes('already consumed the staged file')) {
        throw new Error('attach-durable 锚点未命中：publishStagedObject 的 unlink(staged.path)')
      }
      if (!s.includes('dsh-mobile durable-walk guard')
        || (s.match(/dsh-mobile link->rename fallback/g) || []).length !== 2
        || !s.includes('dsh-mobile: a link->rename fallback already consumed the staged file.')) {
        throw new Error('attach-durable 复核失败——不写回')
      }
      return s
    },
  },


  // ── fs-local-link-F8：文件写工具 createIfAbsent 的 link(2) 回退（2026-09-22 apk issue #246，scope=engine）──
  // 根因：dsh-fs-observation-policy 对「未观察过/确认不存在」的路径判写意图 createIfAbsent，
  // dsh-fs-local 的 writeFileAtomic 拿到该意图后**只能**用 link(2) 做 no-replace 发布，失败即抛，
  // 该分支没有任何回退。Android 应用域恒拒 hardlink（EACCES，denial 被 dontaudit 静默）⇒ 真机上
  // write 工具**建不了任何新文件**（覆盖已存在文件走 else 的 rename，正常）——表现为「只能改不能建」。
  // 与坑位 #77 / F2 / F5 同一 sepolicy 限制，只是站点不同；本文件是它的第 4 个站点。
  // 历史：0.13.3 曾以「上游 0.1.2-rc.1 已原生覆盖 rename 回退」为由退役 fs-local-index.js，
  // 但该结论对当前的 createIfAbsent 站点不成立（0.1.5-rc.1 实测：全文仅此一处 link 调用，
  // 且无任何 EACCES/EPERM/ENOTSUP 回退）——本补丁即补回该覆盖。
  // 不变量：EACCES/EPERM/ENOTSUP 时改用 O_EXCL 占位 + rename 等价实现 no-replace
  // （直接照抄 else 分支的裸 rename 会静默覆盖已存在目标，丢掉 link 的独占语义）。
  'fs-local-link-F8': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile exclusive create (F8)')
      && s.includes('dsh-mobile link->rename fallback (F8)')
      && s.includes('dshMobilePublishExclusive('),
    apply: (s) => {
      if (s.includes('dsh-mobile exclusive create (F8)')
        && s.includes('dsh-mobile link->rename fallback (F8)')
        && s.includes('dshMobilePublishExclusive(')) return s

      // ① 站点：createIfAbsent 的 link 失败分支（原文失败即抛，无回退）。
      const SITE_OLD = [
        '\t\tif (createIfAbsent !== void 0) try {',
        '\t\t\tawait linkFile(tempPath, absolutePath);',
        '\t\t} catch (error) {',
        '\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);',
        '\t\t}',
      ].join('\n')
      const SITE_NEW = [
        '\t\tif (createIfAbsent !== void 0) try {',
        '\t\t\tawait linkFile(tempPath, absolutePath);',
        '\t\t} catch (error) {',
        '\t\t\t/* dsh-mobile link->rename fallback (F8): Android app-private dirs reject link(2) (EACCES). */',
        '\t\t\tif (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP"))) {',
        '\t\t\t\tawait throwGuardedCreateFailure(error, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget);',
        '\t\t\t} else {',
        '\t\t\t\tawait dshMobilePublishExclusive(tempPath, absolutePath, createIfAbsent.displayPath, inspectPublicationTarget, internals);',
        '\t\t\t}',
        '\t\t}',
      ].join('\n')
      if (!s.includes(SITE_OLD)) throw new Error('fs-local-link 锚点未命中：createIfAbsent link 失败分支')
      s = s.replace(SITE_OLD, SITE_NEW)

      // ② 等价实现：O_EXCL 占位 + rename（保住 no-replace 语义）。
      const GUARD_TAIL = [
        '\tthrow new FsError(`cannot write "${displayPath}": ${errorMessage(error)}`, "FS_IO_ERROR", { cause: error });',
        '}',
      ].join('\n')
      const HELPER = [
        '',
        '/**',
        ' * dsh-mobile exclusive create (F8): Android app-private directories reject link(2) with EACCES,',
        ' * so the createIfAbsent publication cannot use the hard-link no-replace primitive at all.',
        ' * Re-implement it with an O_EXCL placeholder plus a rename, which keeps the semantics the hard',
        ' * link provided: the loser of a concurrent create gets EEXIST and reports the same',
        ' * "cannot overwrite existing" refusal, and a failed rename releases the placeholder so a',
        ' * zero-byte target never survives to make every later create lose the claim race.',
        ' * @param tempPath - the fully written and synced staging file to publish.',
        ' * @param absolutePath - destination that must not already exist.',
        ' * @param displayPath - user-facing path used by the refusal messages.',
        ' * @param inspectPublicationTarget - metadata probe used by the refusal path.',
        ' * @param internals - test hook for pinning the open/rename/rm primitives.',
        ' */',
        'async function dshMobilePublishExclusive(tempPath, absolutePath, displayPath, inspectPublicationTarget, internals = {}) {',
        '\tconst openFile = internals.openFile ?? open;',
        '\tconst renameFile = internals.renameFile ?? rename;',
        '\tconst removeFile = internals.removeFile ?? rm;',
        '\tlet guard;',
        '\ttry {',
        '\t\tguard = await openFile(absolutePath, "wx");',
        '\t} catch (error) {',
        '\t\t/* EEXIST and every other failure keep the caller\'s original refusal path. */',
        '\t\tawait throwGuardedCreateFailure(error, absolutePath, displayPath, inspectPublicationTarget);',
        '\t}',
        '\tawait guard.close();',
        '\ttry {',
        '\t\tawait renameFile(tempPath, absolutePath);',
        '\t} catch (error) {',
        '\t\t/* Release the placeholder: a leftover zero-byte target would win every later claim. */',
        '\t\tawait removeFile(absolutePath, { force: true }).catch(() => {});',
        '\t\tthrow error;',
        '\t}',
        '}',
      ].join('\n')
      const GUARD_TAIL_NEW = GUARD_TAIL + '\n' + HELPER
      if (!s.includes(GUARD_TAIL)) throw new Error('fs-local-link 锚点未命中：throwGuardedCreateFailure 收尾')
      s = s.replace(GUARD_TAIL, GUARD_TAIL_NEW)

      if (!s.includes('dsh-mobile exclusive create (F8)') || !s.includes('dshMobilePublishExclusive(')) {
        throw new Error('fs-local-link 复核失败——不写回')
      }
      return s
    },
  },

  // ── spj-migration-link-F5：会话迁移发布的 link(2) 回退（2026-09-11 apk issue #154，scope=engine）──
  // 根因：0.1.5 起会话格式推到 v3，旧会话（header version:0）首次打开必走 v0→v3 迁移，最后一步
  // publishCurrentExclusive() 用 link(2) 原子发布；Android 应用域 SELinux 拒绝 hardlink（EACCES，
  // denial 被 dontaudit 静默）→ 升级前写入的会话全部打不开。同文件 materialize 路径早有同款回退，
  // 此处漏打（运行期 asset 亦只覆盖了后者）。
  // 不变量：link 在 EACCES/EPERM/ENOTSUP 下改用模块顶层导入的 rename 发布（internals.fs 不暴露 rename）。
  'spj-migration-link-F5': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
    scope: 'engine',
    check: (s) => (s.match(/dsh-mobile link->rename fallback/g) || []).length === 2,
    apply: (s) => {
      if ((s.match(/dsh-mobile link->rename fallback/g) || []).length === 2) return s
      const IMPORT_OLD = 'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, truncate } from "node:fs/promises";'
      const IMPORT_NEW = 'import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, truncate } from "node:fs/promises";'
      if (s.includes(IMPORT_OLD)) s = s.replace(IMPORT_OLD, IMPORT_NEW)
      else if (!s.includes('realpath, rename, rm')) throw new Error('spj-migration-link 锚点未命中：import rename')
      const FALLBACK = (from, to) => [
        'await link(' + from + ', ' + to + ').catch(async (error) => {',
        '\t/* dsh-mobile link->rename fallback: Android app-private dirs reject link(2) (EACCES). */',
        '\tif (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP"))) throw error;',
        '\tawait rename(' + from + ', ' + to + ');',
        '});',
      ].join('\n')
      const A_OLD = '\t\t\tawait link(tmp, finalPath);'
      if (!s.includes(A_OLD)) throw new Error('spj-migration-link 锚点未命中：materialize link(tmp, finalPath)')
      s = s.replace(A_OLD, '\t\t\t' + FALLBACK('tmp', 'finalPath').split('\n').join('\n\t\t\t'))
      const B_OLD = [
        '\t\tif (isEEXIST(error)) return false;',
        '\t\t/* v8 ignore next -- the filesystem error is already complete. */',
        '\t\tthrow error;',
        '\t}',
        '\tawait syncDirectory(dirname(currentPath), internals);',
      ].join('\n')
      const B_NEW = [
        '\t\tif (isEEXIST(error)) return false;',
        '\t\t/* dsh-mobile link->rename fallback: Android app-private dirs reject link(2) (EACCES). */',
        '\t\tif (!(error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM" || error.code === "ENOTSUP"))) throw error;',
        '\t\tawait rename(staged, currentPath);',
        '\t}',
        '\tawait syncDirectory(dirname(currentPath), internals);',
      ].join('\n')
      if (!s.includes(B_OLD)) throw new Error('spj-migration-link 锚点未命中：publishCurrentExclusive catch 块')
      s = s.replace(B_OLD, B_NEW)
      if ((s.match(/dsh-mobile link->rename fallback/g) || []).length !== 2) throw new Error('spj-migration-link 复核失败——不写回')
      return s
    },
  },

  // ── publish-exclusive-F7：找回发布独占语义 + 失败回收（2026-09-12 apk issue #170 / FX-207.1+207.2，scope=engine）──
  // F5 用 rename 回退修「旧会话打不开」，但 rename 会**静默替换**已存在的目标，于是上游的
  // isEEXIST → return false（唯一创建语义）在 Android 上成了死代码：并发发布同一会话/同一日志时
  // 双方都成功，后者覆盖前者已追加的事件（历史静默缺失）。
  // 修法：O_EXCL 原子占位抽成模块级小函数 dshMobileClaimExclusive()，**F5 的两个站点共用**——
  //   ① publish 站（publishCurrentExclusive，rename 之前）：占位成功=我们赢，输家得到 EEXIST 并
  //      return false，与 link 路径完全同语义；rename 随后替换的是我们自己刚占的位。
  //   ② materialize 站（materializePosix 的 link 回退）：同一函数占位；输家得到 EEXIST 并抛出
  //      （该站上游只有抛错通道：persistBatch() 把任何 resolve 当成 materialized，返回 false 会变成
  //      静默无操作），不静默覆盖。
  // 两站占位成功后若 rename 失败（IO 错/权限），必须 unlink 回收占位（dshMobileReleaseClaim）——
  // 否则留下 0 字节目标：它会被当成「已存在」让之后每次发布都输掉占位竞争，且被读日志侧当成损坏文件。
  // E-3：不得只给 F7 的 publish 站打补丁——两站共用同一小函数，任一站漏了就等于没修。
  'publish-exclusive-F7': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile exclusive publish (F7)')
      && s.includes('dsh-mobile exclusive materialize (F7)')
      && (s.match(/dshMobileClaimExclusive\(/g) || []).length >= 3
      // 0.14.0-preview 实锤（review C1）：v1 双占位形态既满足上面的 marker/计数，又恒恒失败——
      // 必须显式判为未收敛，否则「已应用」的幂等判定会把坏文件永远留在原地。
      && !s.includes(F7_LEGACY_INLINE),
    apply: (s) => {
      // ⓪ 收敛 v1 双占位形态（0.14.0-preview 坏资产的修复必由路径；无该形态则 no-op）。
      //    边界 = 旧块注释起、到紧随其后的 helper 占位调用止；helper 占位调用是 v2 正确形态，保留。
      if (s.includes(F7_LEGACY_INLINE)) {
        const markIdx = s.indexOf(F7_LEGACY_INLINE)
        let legacyStart = s.lastIndexOf('/* dsh-mobile exclusive publish (F7)', markIdx)
        // 把旧块注释行前的缩进一并切除（v1 插入的注释带多余 tab；留下会让收敛输出与快照构建差 2 字节）
        while (legacyStart > 0 && (s[legacyStart - 1] === '\t' || s[legacyStart - 1] === ' ')) legacyStart -= 1
        const legacyEndMark = s.indexOf('if (!(await dshMobileClaimExclusive(currentPath))) return false;', markIdx)
        if (legacyStart < 0 || legacyEndMark < 0) {
          throw new Error('publish-exclusive 收敛失败：v1 双占位块边界未命中（人工核对 publishCurrentExclusive）')
        }
        // 切到「占位调用行行首」为止——切点已含该行原有缩进（坏资产里就是规范的 \t\t）→ 右半原样接回。
        // 校验该行缩进为规范 \t\t，否则收敛输出与快照构建不会逐字节一致（宁抛错不写差异字节）。
        let legacyEnd = legacyEndMark
        while (legacyEnd > 0 && s[legacyEnd - 1] !== '\n') legacyEnd -= 1
        if (!s.startsWith('\t\tif (!(await dshMobileClaimExclusive(currentPath))) return false;', legacyEnd)) {
          throw new Error('publish-exclusive 收敛失败：占位调用行缩进非 \\t\\t（人工核对）')
        }
        const region = s.slice(legacyStart, legacyEnd)
        if (!region.includes(F7_LEGACY_INLINE) || region.includes('dshMobileReleaseClaim')) {
          throw new Error('publish-exclusive 收敛失败：v1 双占位块区间含非预期内容')
        }
        s = s.slice(0, legacyStart) + s.slice(legacyEnd)
      }
      if (s.includes('dsh-mobile exclusive materialize (F7)')
        && (s.match(/dshMobileClaimExclusive\(/g) || []).length >= 3
        && !s.includes(F7_LEGACY_INLINE)) return s
      const MARK = '/* dsh-mobile link->rename fallback: Android app-private dirs reject link(2) (EACCES). */'
      const idx = s.indexOf(MARK, s.indexOf('isEEXIST(error)) return false;'))
      // 锚点缺失 = 目标文件不是 F5 打过补丁的那份（例如补丁测试用的合成夹具）→ 不改写直接返回。
      // 强制力不靠这里抛错：装配后的快照有 overlay marker 门禁（F7 marker 缺席即拒打包），
      // 所以「真树上锚点没命中」仍然会被拦住，而合成夹具不会误伤。
      if (idx < 0) return s
      const RENAME_PUBLISH = 'await rename(staged, currentPath);'
      const RENAME_MATERIALIZE = 'await rename(tmp, finalPath);'
      const relPublish = s.indexOf(RENAME_PUBLISH, idx)
      const relMaterialize = s.indexOf(RENAME_MATERIALIZE, idx)
      if (relPublish < 0 || relMaterialize < 0) return s

      // unlink 导入（F5 只补了 rename；internals.fs 不暴露 unlink）
      const IMPORT_OLD = 'rename, rm, stat, truncate } from "node:fs/promises";'
      const IMPORT_NEW = 'rename, rm, stat, truncate, unlink } from "node:fs/promises";'
      if (s.includes(IMPORT_NEW)) { /* 幂等 */ }
      else if (s.includes(IMPORT_OLD)) s = s.replace(IMPORT_OLD, IMPORT_NEW)
      else throw new Error('publish-exclusive 锚点未命中：import unlink（F5 的 rename 导入形态已变）')

      // 模块级小函数：O_EXCL 原子占位 + 失败回收（两站共用同一份实现）
      const HELPERS = [
        '/* dsh-mobile exclusive publish (F7): rename() silently replaces an existing target, so the',
        '   EEXIST semantics link(2) gave us would vanish. Claim the destination with O_EXCL first:',
        '   the winner keeps the claim, the loser gets EEXIST and reports false exactly like the link',
        '   path. Cross-process exclusivity now rests on this atomic claim alone — that is the',
        '   consequence of flock-android-F3 stubbing the writer lock out on Android, and of link(2)',
        '   being unavailable in the app-private domain. */',
        'async function dshMobileClaimExclusive(targetPath) {',
        '\ttry {',
        '\t\tconst claim = await open(targetPath, "wx");',
        '\t\tawait claim.close();',
        '\t\treturn true;',
        '\t} catch (claimError) {',
        '\t\tif (isEEXIST(claimError)) return false;',
        '\t\tthrow claimError;',
        '\t}',
        '}',
        '/* dsh-mobile exclusive publish reclaim (F7): a failed publish must not leave the O_EXCL',
        '   placeholder behind — a 0-byte target reads as a live log, makes every later publisher lose',
        '   the claim race, and can be mistaken for a corrupt session file. Best-effort: the original',
        '   publish error still propagates. */',
        'async function dshMobileReleaseClaim(targetPath) {',
        '\tawait unlink(targetPath).catch(() => {});',
        '}',
        '',
      ].join('\n')
      const ANCHOR_FN = 'async function publishCurrentExclusive(staged, currentPath, internals) {'
      const fnIdx = s.indexOf(ANCHOR_FN)
      if (fnIdx < 0) throw new Error('publish-exclusive 锚点未命中：publishCurrentExclusive 函数头')
      if (!s.includes('async function dshMobileClaimExclusive(')) {
        s = s.slice(0, fnIdx) + HELPERS + s.slice(fnIdx)
      }

      // 站①：publishCurrentExclusive —— 占位失败 return false；rename 失败回收
      const PUBLISH_OLD = '\t\tawait rename(staged, currentPath);'
      const PUBLISH_NEW = [
        '\t\tif (!(await dshMobileClaimExclusive(currentPath))) return false;',
        '\t\ttry {',
        '\t\t\tawait rename(staged, currentPath);',
        '\t\t} catch (publishError) {',
        '\t\t\tawait dshMobileReleaseClaim(currentPath);',
        '\t\t\tthrow publishError;',
        '\t\t}',
      ].join('\n')
      // 重新定位（helpers 插入后索引变化）
      if (!s.includes('if (!(await dshMobileClaimExclusive(currentPath))) return false;')) {
        const pubIdx = s.indexOf(PUBLISH_OLD, s.indexOf(ANCHOR_FN))
        if (pubIdx < 0) throw new Error('publish-exclusive 锚点未命中：publish 站 rename(staged, currentPath)')
        s = s.slice(0, pubIdx) + PUBLISH_NEW + s.slice(pubIdx + PUBLISH_OLD.length)
      }

      // 站②：materializePosix —— 同一占位函数；输家得 EEXIST 抛出（不静默覆盖）；rename 失败回收
      const MAT_OLD = '\t\t\tawait rename(tmp, finalPath);'
      const MAT_NEW = [
        '\t\t\tif (!(await dshMobileClaimExclusive(finalPath))) {',
        '\t\t\t\t/* dsh-mobile exclusive materialize (F7): another publisher owns this log. The link',
        '\t\t\t\t   path surfaces EEXIST by throwing and persistBatch() treats any resolve as',
        '\t\t\t\t   materialized, so the loser must throw here too — never rename over the winner. */',
        '\t\t\t\tthrow Object.assign(new Error("dsh-mobile exclusive materialize: target already exists"), { code: "EEXIST" });',
        '\t\t\t}',
        '\t\t\ttry {',
        '\t\t\t\tawait rename(tmp, finalPath);',
        '\t\t\t} catch (materializeError) {',
        '\t\t\t\tawait dshMobileReleaseClaim(finalPath);',
        '\t\t\t\tthrow materializeError;',
        '\t\t\t}',
      ].join('\n')
      const matIdx = s.indexOf(MAT_OLD, s.indexOf(ANCHOR_FN))
      if (matIdx < 0 && !s.includes('dsh-mobile exclusive materialize (F7)')) {
        throw new Error('publish-exclusive 锚点未命中：materialize 站 rename(tmp, finalPath)')
      }
      if (!s.includes('dsh-mobile exclusive materialize (F7)')) {
        s = s.slice(0, matIdx) + MAT_NEW + s.slice(matIdx + MAT_OLD.length)
      }

      if (!s.includes('dsh-mobile exclusive publish (F7)') || !s.includes('dsh-mobile exclusive materialize (F7)')
        || (s.match(/dshMobileClaimExclusive\(/g) || []).length < 3 || s.includes(F7_LEGACY_INLINE)) {
        throw new Error('publish-exclusive 复核失败——不写回')
      }
      return s
    },
  },

  // ── external-draft-conversation-seam-J1：向旧 public conversation face 补最小文件草稿入口 ──
  // ui-conversation 原有的 addFiles closure 是 ComposerBar 私有注入面；外部打开不能伪造
  // input/change 或自己建第二条上传通道。该方法把同一 createDrafts → shell.addAttachments →
  // refusal release 逻辑放到 ConversationController 上，仍只接受已经由 Session controller
  // 确认可寻址的 sessionId。
  'external-draft-conversation-seam-J1': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    check: (s) => s.includes('dsh-mobile external draft addFiles seam (J1)'),
    apply: (s) => {
      if (s.includes('dsh-mobile external draft addFiles seam (J1)')) return s
      const anchor = '\t\t\t/**\n\t\t\t* Restart one failed file upload.'
      if (!s.includes(anchor)) throw new Error('external draft seam 锚点未命中：ui-conversation createDrafts 后续注释已变')
      const method = [
        '\t\t\t/** dsh-mobile external draft addFiles seam (J1): reuse the normal composer attachment path. */',
        '\t\t\taddFiles(sessionId, files) {',
        '\t\t\t\tconst shell = this.input.shell(sessionId);',
        '\t\t\t\tconst drafts = this.createDrafts(sessionId, files);',
        '\t\t\t\tif (shell.addAttachments(drafts.map((draft) => draft.id)) === false) {',
        '\t\t\t\t\tthis.releaseDraftAttachments(drafts);',
        '\t\t\t\t\treturn false;',
        '\t\t\t\t}',
        '\t\t\t\treturn true;',
        '\t\t\t}',
        '',
      ].join('\n')
      const out = s.replace(anchor, method + anchor)
      if (!out.includes('dsh-mobile external draft addFiles seam (J1)') || !out.includes('this.input.shell(sessionId)')) {
        throw new Error('external draft seam 复核失败——不写回')
      }
      return out
    },
  },

  // ── arkweb-resource-protocol-H1：ArkWeb 丢失 dsh-resource authority（apk #221）──
  // HarmonyOS/ArkWeb 对 non-special scheme 可报告 dsh-resource: 协议却把 hostname 留空；标准
  // Chromium 的 hostname 仍优先使用。仅在 hostname 为空时按 DSH 自有地址文法恢复 type，拒绝
  // userinfo、空 authority 与非 resource scheme，绝不 monkey-patch 全局 URL。
  'arkweb-resource-protocol-H1': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-resources/lib/client.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile ArkWeb resource authority fallback (H1)'),
    apply: (s) => {
      if (s.includes('dsh-mobile ArkWeb resource authority fallback (H1)')) return s
      const ORIGINAL = /(if \(parsed\.protocol !== `dsh-resource:`\) return void 0;)(\r?\n)([ \t]*)return parsed\.hostname === "" \? void 0 : parsed\.hostname\.toLowerCase\(\);/
      if (!ORIGINAL.test(s)) throw new Error('arkweb-resource-protocol 锚点未命中：protocolOf hostname 返回语句已变')
      s = s.replace(ORIGINAL, (_whole, protocolCheck, eol, indent) => [
        protocolCheck,
        indent + 'if (parsed.hostname !== "") return parsed.hostname.toLowerCase();',
        indent + '// dsh-mobile ArkWeb resource authority fallback (H1): ArkWeb loses the non-special-scheme hostname.',
        indent + 'const authority = /^dsh-resource:\\/\\/([A-Za-z][A-Za-z0-9-]*)(?:[/?#]|$)/i.exec(address);',
        indent + 'return authority === null ? void 0 : authority[1].toLowerCase();',
      ].join(eol))
      if (!s.includes('dsh-mobile ArkWeb resource authority fallback (H1)')) throw new Error('arkweb-resource-protocol 复核失败——不写回')
      return s
    },
  },

  // ── reference-drill-F6：移动端目录行点行体进子目录（2026-09-11 apk #163，scope=engine）──
  // 上游 0.1.5 的 @ 菜单给目录行两个动词：行体=落定 pick（把文件夹本身变成原子引用并关菜单），
  // 行尾小箭头/Tab=下钻。手机上点行体只想「进去看看」，结果直接引用了文件夹 —— 用户侧表现为
  // 「@ 只能选到第一层、用不了」（#150/#144/#163）。移动形态标记（html[data-dsh-mobile-form]，
  // 由 dsh-client-ui-responsive 打）在场时，目录行的落定动作改为下钻；桌面行为不变。
  'reference-drill-F6': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-reference/lib/client.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile mobile-folder-drill (F6)'),
    apply: (s) => {
      if (s.includes('dsh-mobile mobile-folder-drill (F6)')) return s
      const OLD = 'if (value.fileKind === "directory" && action === "drill") return {'
      const NEW = [
        '/* dsh-mobile mobile-folder-drill (F6): on the phone form a directory row settles into the folder',
        ' * instead of referencing it — the trailing chevron and Tab keep drilling, and the multi-select',
        ' * checkbox is owned by the responsive layer. Desktop (no form marker) is untouched. */',
        'if (value.fileKind === "directory" && (action === "drill" || document.documentElement.hasAttribute("data-dsh-mobile-form"))) return {',
      ].join('\n')
      if (!s.includes(OLD)) throw new Error('reference-drill 锚点未命中：onPick 的 directory/drill 判定')
      s = s.replace(OLD, NEW)
      if (!s.includes('dsh-mobile mobile-folder-drill (F6)')) throw new Error('reference-drill 复核失败——不写回')
      return s
    },
  },

  // ── boot-third-party-isolation-G3：第三方插件 boot 期失败隔离（0.14.1，scope=engine）──
  // 真因（真实用户反馈 报错反馈/0.14.0/20260919-125714-engine-died-during-boot，华为 NOH-AN00 /
  // Android 31 / arm64 / 0.14.0 vc39）：用户自装的 dsh-live2d-pets 在 **import 期**抛 SyntaxError
  // （`The requested module '@deepseek-ai/dsh-settings' does not provide an export named
  // 'settingsNamespace'`）→ 整树 boot 失败、engine exit=1。
  // **为什么必须在 boot() 的挂载点拦，而不是在启动后的条目断言里容错**：import 失败的抛出点在
  // **更早**的调用链上——boot() → mountRootInclude() → loader.create() → EntryTree.update
  //   (cordis-plugin-loader) → Promise.allSettled → Entry._init → import 失败 → updateError("import", …)
  //   → 单条失败即 `throw failures[0]`
  // 该异常在 mountRootInclude 处就冒泡进 boot 的 catch，**assertEntriesActivated 根本不会被执行**
  // ⇒ 条目断言层的容错对这条路径不可达（不是漏了分支，是那个函数不在路径上）。
  // 修法：把挂载 root include 换成**隔离式挂载**——失败时若失败条目属于「用户自装第三方」，
  // 则用既有 patch 机制给它加 `disabled: true` 后重试；成功后在 engine.log 里**点名**被跳过的插件。
  //   - 复用 `applyEntryPatches` 的 `disabled` 覆盖（cordis-plugin-include），
  //     loader 的 `Entry._disabled()` 对新条目跳过 `init()` ⇒ 不再 import 坏插件。不改 loader/vendor。
  //   - **官方包与出厂移动侧插件失败仍然响亮失败**（@deepseek-ai/*、@dsh-android/* 及出货具名插件），
  //     核心坏掉必须可见。
  //   - **有上限**：最多隔离 8 个，超过即响亮失败并给出完整清单（不允许无限容忍）。
  'boot-third-party-isolation-G3': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile third-party boot isolation (G3)')
      && s.includes('dshMobileMountRootIncludeTolerant')
      && s.includes('__dshMobileBootSkippedPlugins')
      // 归属可证性检查（dshMobileIsIsolatableEntry）是收敛后的形态：缺它说明是更早的宽松变体
      // （只按前缀判归属，会把不可证的 path/URL 条目也隔离掉）→ 必须判为未应用并重新施加。
      && s.includes('dshMobileIsIsolatableEntry')
      // 反 no-op：boot() 仍直接挂载 root include 就说明隔离没接上。
      && !s.includes('\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);'),
    apply: (s) => {
      if (s.includes('dsh-mobile third-party boot isolation (G3)') && s.includes('dshMobileMountRootIncludeTolerant') && s.includes('dshMobileIsIsolatableEntry')) return s
      // ① 隔离式挂载器 + 判据（插在 boot() 定义之前）
      const BOOT_FN_ANCHOR = 'async function boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl) {'
      const HELPERS = [
        '/* dsh-mobile third-party boot isolation (G3): a user-installed plugin that fails to import must',
        ' * not take the whole engine down. boot() mounts the root include through this wrapper, which',
        ' * disables the offending third-party entry (via the Loader patch mechanism) and retries, then',
        ' * names every skipped plugin in engine.log. Official and shipped-mobile entries still fail loud. */',
        '/** Scopes owned by the product: a failure here is a real regression and must stay fatal. */',
        'const DSH_MOBILE_SHIPPED_PLUGIN_PREFIXES = ["@deepseek-ai/", "@dsh-android/"];',
        // 0.14.1：`@aiwayds/dsh-model-sync` 随插件整体摘除（审查 §9，用户裁定）——它留在本名单里
        // 的后果很具体：名单成员的加载失败**按产品回归 fail-loud**，而它已经不在注入集里了，
        // 老设备上任何残留挂载都会把引擎启动打挂（fail-loud 用在了错误的对象上）。
        // 摘除插件时，这里必须同步删掉——名单就是「谁算我们自己的插件」的单一真源。
        'const DSH_MOBILE_SHIPPED_PLUGIN_NAMES = ["dsh-undo-savepoint", "dshmarketplace-plugin"];',
        '/** Isolation cap: never tolerate an unbounded number of broken plugins. */',
        'const DSH_MOBILE_BOOT_SKIP_LIMIT = 8;',
        'const DSH_MOBILE_BOOT_SKIPPED_PLUGINS = [];',
        'Object.defineProperty(globalThis, "__dshMobileBootSkippedPlugins", { value: DSH_MOBILE_BOOT_SKIPPED_PLUGINS, configurable: true });',
        '/**',
        '* Whether a failing entry belongs to the product rather than to the user.',
        '* @param name - the Loader entry name (package specifier).',
        '* @returns true when the entry is official or shipped with the mobile build.',
        '*/',
        'function dshMobileIsShippedPlugin(name) {',
        '\tconst value = String(name ?? "");',
        '\tif (DSH_MOBILE_SHIPPED_PLUGIN_PREFIXES.some((prefix) => value.startsWith(prefix))) return true;',
        '\treturn DSH_MOBILE_SHIPPED_PLUGIN_NAMES.includes(value);',
        '}',
        '/**',
        '* Whether a failing entry may be isolated. Only a bare package specifier proves that the entry',
        '* is a plugin the user installed: a relative or absolute path, a `file:` URL, or any other',
        '* scheme leaves ownership unprovable, and an unprovable failure must stay fatal rather than be',
        '* silently skipped (a product regression must never hide behind this tolerance).',
        '* @param name - the Loader entry name (package specifier).',
        '* @returns true when the entry is a non-shipped, bare package specifier.',
        '*/',
        'function dshMobileIsIsolatableEntry(name) {',
        '\tconst value = String(name ?? "");',
        '\tif (value === "") return false;',
        '\tif (value.startsWith("./") || value.startsWith("../") || value.startsWith("/") || value.startsWith("file:") || value.startsWith("cordis:")) return false;',
        '\tif (/^[A-Za-z][A-Za-z\\d+.-]*:/.test(value)) return false;',
        '\treturn !dshMobileIsShippedPlugin(value);',
        '}',
        '/**',
        '* Collect the `{ id, name }` of every entry the Loader reported as failed, from an update error',
        '* chain. The Loader wraps each failure as `failed to <stage> loader entry <id> (<name>): …`',
        '* (cordis-plugin-loader/lib/index.js:309) and folds multiple failures into an AggregateError, so',
        '* every message in the cause chain is scanned. The root include row itself is not an entry the',
        '* caller may disable and is filtered out.',
        '* @param error - the error thrown by mountRootInclude.',
        '* @returns de-duplicated failed entries in discovery order.',
        '*/',
        'function dshMobileCollectEntryFailures(error) {',
        '\tconst found = [];',
        '\tconst seen = /* @__PURE__ */ new Set();',
        '\tconst visit = (value) => {',
        '\t\tif (value === null || value === void 0) return;',
        '\t\tif (value instanceof AggregateError && Array.isArray(value.errors)) for (const nested of value.errors) visit(nested);',
        '\t\tif (value instanceof Error && value.cause !== void 0) visit(value.cause);',
        '\t\tconst message = value instanceof Error ? value.message : String(value);',
        '\t\tlet cursor = message.indexOf("loader entry ");',
        '\t\twhile (cursor >= 0) {',
        '\t\t\tconst start = cursor + "loader entry ".length;',
        '\t\t\tconst open = message.indexOf(" (", start);',
        '\t\t\tconst close = open >= 0 ? message.indexOf(")", open + 2) : -1;',
        '\t\t\tif (open > start && close > open) {',
        '\t\t\t\tconst id = message.slice(start, open);',
        '\t\t\t\tconst name = message.slice(open + 2, close);',
        '\t\t\t\tconst key = id + "|" + name;',
        '\t\t\t\t/* `cordis:*` is the bootstrap include row itself, not a plugin the caller can disable. */',
        '\t\t\t\tif (id !== "include" && !name.startsWith("cordis:") && !seen.has(key)) {',
        '\t\t\t\t\tseen.add(key);',
        '\t\t\t\t\tfound.push({ id, name });',
        '\t\t\t\t}',
        '\t\t\t}',
        '\t\t\tcursor = message.indexOf("loader entry ", start);',
        '\t\t}',
        '\t};',
        '\tvisit(error);',
        '\treturn found;',
        '}',
        '/**',
        '* Mount the root include, isolating failing user-installed plugins.',
        '* A failure attributable only to third-party entries disables those entries and retries; a',
        '* failure of an official/shipped entry, an unidentifiable failure, or one above the isolation',
        '* cap propagates unchanged so the engine still fails loud on its own regressions.',
        '* @param ctx - the boot context before any config-tree entry mounts.',
        '* @param binName - diagnostic prefix for the thrown error.',
        '* @param absoluteConfigPath - the config to include.',
        '* @param patches - overlay patches supplied by the caller.',
        '* @param bareModuleBaseUrl - optional installed-host base for bare specifiers.',
        '* @returns nothing once the tree mounted.',
        '*/',
        'async function dshMobileMountRootIncludeTolerant(ctx, binName, absoluteConfigPath, patches, bareModuleBaseUrl) {',
        '\tconst disabled = [];',
        '\tfor (;;) {',
        '\t\ttry {',
        '\t\t\tawait mountRootInclude(ctx, absoluteConfigPath, [...(patches ?? []), ...disabled], bareModuleBaseUrl, binName);',
        '\t\t\tif (disabled.length > 0) {',
        '\t\t\t\tconst noun = disabled.length === 1 ? "plugin" : "plugins";',
        '\t\t\t\tconsole.warn(`${binName}: ${String(disabled.length)} third-party ${noun} failed to load during boot and will be skipped; the engine continues. Broken: ${disabled.map((entry) => entry.name).join(", ")} (dsh-mobile third-party boot isolation (G3)). Update or remove the plugin to clear this warning.`);',
        '\t\t\t}',
        '\t\t\treturn;',
        '\t\t} catch (error) {',
        '\t\t\tconst failures = dshMobileCollectEntryFailures(error).filter((failure) => !disabled.some((entry) => entry.id === failure.id));',
        '\t\t\t/* Nothing identifiable to isolate: the boot error is the caller\'s own failure. */',
        '\t\t\tif (failures.length === 0) throw error;',
        '\t\t\t/* Official or shipped-mobile entry: never tolerate, so a product regression stays visible. */',
        '\t\t\tif (failures.some((failure) => dshMobileIsShippedPlugin(failure.name))) throw error;',
        '\t\t\t/* Ownership must be provable: a path/URL specifier is not evidence of a user-installed',
        '\t\t\t * plugin, so such a failure stays fatal instead of being skipped. */',
        '\t\t\tif (failures.some((failure) => !dshMobileIsIsolatableEntry(failure.name))) throw error;',
        '\t\t\tif (disabled.length + failures.length > DSH_MOBILE_BOOT_SKIP_LIMIT) {',
        '\t\t\t\tthrow new Error(`${binName}: ${String(disabled.length + failures.length)} third-party plugins failed to load, above the isolation limit of ${String(DSH_MOBILE_BOOT_SKIP_LIMIT)}; refusing to skip more. Broken: ${[...disabled, ...failures].map((entry) => entry.name).join(", ")}`, { cause: error });',
        '\t\t\t}',
        '\t\t\tfor (const failure of failures) {',
        '\t\t\t\tdisabled.push({ id: failure.id, name: failure.name, disabled: true });',
        '\t\t\t\tDSH_MOBILE_BOOT_SKIPPED_PLUGINS.push(failure.name);',
        '\t\t\t}',
        '\t\t}',
        '\t}',
        '}',
        BOOT_FN_ANCHOR,
      ].join('\n')
      if (!s.includes(BOOT_FN_ANCHOR)) throw new Error('boot-third-party-isolation 锚点未命中：boot() 函数头（引擎升级后请人工核对 dsh-app-boot）')
      s = s.replace(BOOT_FN_ANCHOR, HELPERS)
      // ② boot() 调用点改为隔离式挂载
      const CALL_OLD = '\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);'
      const CALL_NEW = '\t\tawait dshMobileMountRootIncludeTolerant(ctx, binName, absoluteConfigPath, patches, bareModuleBaseUrl); /* dsh-mobile third-party boot isolation (G3) */'
      if (!s.includes(CALL_OLD)) throw new Error('boot-third-party-isolation 锚点未命中：boot() 内 mountRootInclude 调用点')
      s = s.replace(CALL_OLD, CALL_NEW)
      if (!s.includes('dsh-mobile third-party boot isolation (G3)')
        || !s.includes('dshMobileMountRootIncludeTolerant')
        || !s.includes('__dshMobileBootSkippedPlugins')
        || s.includes('\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl, binName);')) {
        throw new Error('boot-third-party-isolation 复核失败——不写回')
      }
      return s
    },
  },

  // ── pi-toolcall-G2：流式 tool_call 空名止血（0.13.5 W2，引擎树补丁 scope=engine）──
  // issue #124：两条独立路径都实测复现（.deploy-tmp/0135/repro-124*.mjs）——
  //  A 累加器：续块缺 index 且缺 id 时新建块 → 一次调用裂成两个，第二个 name/id 为空；
  //  B 出口：convertMessages 不做空名过滤 → 损坏历史被原样回放，网关 400
  //    「invalid tool_call: function/name/arguments cannot be empty」。
  // 修复必须同时覆盖：只堵 A 则已损坏会话仍 400，只堵 B 则新损坏继续产生。
  'pi-toolcall-G2': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile tool_call guard (G2)') && s.includes('dsh-mobile continuation guard (G2)'),
    apply: (s) => {
      const DECL_OLD = '    const params = [];\n    const normalizeToolCallId = (id) => {'
      const DECL_NEW = '    const params = [];\n'
        + '    // dsh-mobile tool_call guard (G2): ids of tool calls dropped from this request.\n'
        + '    const droppedToolCallIds = new Set();\n'
        + '    const normalizeToolCallId = (id) => {'
      const MAP_OLD = [
        '            if (toolCalls.length > 0) {',
        '                assistantMsg.tool_calls = toolCalls.map((tc) => {',
        '                    const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);',
        '                    if (customInputProperty !== undefined) {',
        '                        return {',
        '                            id: tc.id,',
        '                            type: "custom",',
        '                            custom: {',
        '                                name: tc.name,',
        '                                input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),',
        '                            },',
        '                        };',
        '                    }',
        '                    return {',
        '                        id: tc.id,',
        '                        type: "function",',
        '                        function: {',
        '                            name: tc.name,',
        '                            arguments: JSON.stringify(tc.arguments),',
        '                        },',
        '                    };',
        '                });',
        '            }',
      ].join('\n')
      const MAP_NEW = [
        '            if (toolCalls.length > 0) {',
        '                // dsh-mobile tool_call guard (G2): a tool call with no name cannot be replayed —',
        '                // OpenAI-compatible gateways reject the whole request. Drop it (and its tool',
        '                // result below) so one corrupted history entry cannot poison every later turn.',
        '                const replayableToolCalls = toolCalls.filter((tc) => {',
        '                    if (typeof tc.name === "string" && tc.name.trim().length > 0)',
        '                        return true;',
        '                    if (tc.id)',
        '                        droppedToolCallIds.add(tc.id);',
        '                    return false;',
        '                });',
        '                if (replayableToolCalls.length > 0) {',
        '                    assistantMsg.tool_calls = replayableToolCalls.map((tc) => {',
        '                        const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);',
        '                        if (customInputProperty !== undefined) {',
        '                            return {',
        '                                id: tc.id,',
        '                                type: "custom",',
        '                                custom: {',
        '                                    name: tc.name,',
        '                                    input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),',
        '                                },',
        '                            };',
        '                        }',
        '                        const serializedArguments = JSON.stringify(tc.arguments ?? {});',
        '                        return {',
        '                            id: tc.id,',
        '                            type: "function",',
        '                            function: {',
        '                                name: tc.name,',
        '                                arguments: typeof serializedArguments === "string" && serializedArguments.length > 0 ? serializedArguments : "{}",',
        '                            },',
        '                        };',
        '                    });',
        '                }',
        '            }',
      ].join('\n')
      const RESULT_OLD = [
        '                const toolResultMsg = {',
        '                    role: "tool",',
        '                    content: sanitizeSurrogates(toolResultText),',
        '                    tool_call_id: toolMsg.toolCallId,',
        '                };',
      ].join('\n')
      const RESULT_NEW = '                if (toolMsg.toolCallId && droppedToolCallIds.has(toolMsg.toolCallId))\n'
        + '                    continue; // dsh-mobile tool_call guard (G2): its tool call was dropped\n'
        + RESULT_OLD
      const ACC_OLD = [
        '                let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;',
        '                if (!block && toolCall.id) {',
        '                    block = toolCallBlocksById.get(toolCall.id);',
        '                }',
      ].join('\n')
      const ACC_NEW = ACC_OLD + '\n'
        + '                if (!block && streamIndex === undefined && !toolCall.id && (toolCall.function?.name ?? toolCall.custom?.name ?? "").length === 0) {\n'
        + '                    // dsh-mobile continuation guard (G2): a continuation chunk that omits both\n'
        + '                    // index and id must extend the single open tool call, never start a nameless one.\n'
        + '                    const openToolCalls = blocks.filter((entry) => entry.type === "toolCall");\n'
        + '                    if (openToolCalls.length === 1)\n'
        + '                        block = openToolCalls[0];\n'
        + '                }'
      const REPL = [
        { old: DECL_OLD, neu: DECL_NEW },
        { old: MAP_OLD, neu: MAP_NEW },
        { old: RESULT_OLD, neu: RESULT_NEW },
        { old: ACC_OLD, neu: ACC_NEW },
      ]
      let changed = 0
      for (const { old, neu } of REPL) {
        if (s.includes(neu)) continue
        if (!s.includes(old)) throw new Error('pi-toolcall 锚点未命中：' + old.slice(0, 90).replace(/\n/g, '\\n') + '…——引擎升级后请人工核对 convertMessages / ensureToolCallBlock')
        s = s.replace(old, neu)
        changed++
      }
      if (!s.includes('dsh-mobile tool_call guard (G2)') || !s.includes('dsh-mobile continuation guard (G2)')) {
        throw new Error('pi-toolcall 复核失败——不写回')
      }
      console.log(`  pi-toolcall-G2: ${changed} 处锚点替换`)
      return s
    },
  },

  // ── combo-probe-P1：把 compose 探针送进产品内，收口 C6 的 t_compose_total=-1（0.14.1 块F，scope=engine）──
  // 背景（T6 设备实测的真因 + 详档 §5.1 C6/P-AC-04）：t_compose_total 在设备上 42/42 恒为 -1——探针
  // 从未接进产品。把 scripts/perf/count-compose.mjs 打进快照或由 inject-all 注入是**结构性无效**的：
  //   ① 时机错：count-compose 的 TOTAL 只在 process.on('exit') 打印，那一刻落在 killExistingEngine()
  //      内、早于 rotateEngineLog() ⇒ 上一代临终写的 TOTAL 被 engine.log → engine.log.1 搬走，新生代
  //      probe tail 从新文件偏移 0 起读 ⇒ 即使打进出厂件，大概率仍读到 -1。
  //   ② 会引入更坏的假绿：--import/NODE_OPTIONS 在 file-based worker 线程里也会执行（Node v24.17
  //      实测），引擎树至少 5 处 worker；worker 临终打 `TOTAL calls=0 totalMs=0`，而解析取**最后一条**
  //      TOTAL ⇒ 变成「非 -1 但为 0」——门禁 C6 只查 != -1，抓不到。且 NODE_OPTIONS 会被 agent 的全部
  //      node 子进程继承、preload 缺 COMBO_LIB 时直接 exit(2) ⇒ 打坏用户工具链。
  // 本补丁（方案 d）：在**产品内**的 compose() 返回处打印探针行——正好落在 LISTEN 之后、首个页面
  // 请求路径上，即 check-boot-budget C2 要测的那个同步块。不新增快照成员（避开 check-snapshot-file-modes
  // 时序与「测量脚本进产品树」争议）；壳侧解析器零改动。
  // 关键三件事：
  //   - **只主线程打印**：非主线程一律不安装探针。worker 的 calls=0 TOTAL 绝不能成为壳侧解析到的
  //     最后一条 TOTAL（否则真读数被冒充成 0，即上面 ② 的假绿）。
  //   - 输出行与 T2 定稿格式逐字一致，loopP99Ms/loopSamples 无值时报 -1（绝不省字段）。
  //   - 同时打 `[perf] compose #N at=.. dur=..` 行：C2/C3 需要单次 dur，只有 TOTAL 不足以判 C2。
  'combo-probe-P1': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile combo probe (P1)')
      && s.includes('dshMobileComboProbeEmit')
      && s.includes('import { isMainThread } from "node:worker_threads";')
      // 主线程门：探针块必须带 isMainThread 分支（worker 的 calls=0 不得冒充真读数）。
      && s.includes('if (!isMainThread) {')
      && s.includes('} else {'),
    apply: (s) => {
      if (s.includes('dsh-mobile combo probe (P1)') && s.includes('dshMobileComboProbeEmit')) return s
      // ① import：锚点选 node:crypto 行——combo 家族里 A3/A5/C3 撤销后，这行只剩探针自己会碰。
      const IMPORT_ANCHOR = 'import { createHash } from "node:crypto";'
      const IMPORTS = [
        IMPORT_ANCHOR,
        '/* dsh-mobile combo probe (P1): the compose probe is part of the product, so the shell parses',
        ' * the real reading from engine.log instead of a measurement preload that never lands. */',
        'import { monitorEventLoopDelay } from "node:perf_hooks";',
        'import { isMainThread } from "node:worker_threads";',
      ].join('\n')
      if (!s.includes(IMPORT_ANCHOR)) throw new Error('combo-probe 锚点未命中：node:crypto import 行（引擎升级后请人工核对 dsh-client-modules）')
      s = s.replace(IMPORT_ANCHOR, IMPORTS)
      // ② 探针块：装在类定义之后、export 之前（wrap prototype.compose —— 打印点即 compose() 返回处）。
      const EXPORT_ANCHOR = 'export { ClientModuleRegistry, ClientModuleRegistry as default, bootInjections, orderByModuleGraph, stripClientSuffix };'
      const BLOCK = [
        '/* dsh-mobile combo probe (P1): TOTAL/compose probe lines printed from inside the product at',
        ' * every composition return. The first composition happens after listen, on the first page',
        ' * request path, which is exactly the synchronous block check-boot-budget C2 measures. */',
        'const DSH_MOBILE_COMBO_PROBE_STATS = { calls: 0, totalMs: 0, firstAt: null, singleRequests: 0 };',
        'const dshMobileComboProbeInstances = /* @__PURE__ */ new Set();',
        'const dshMobileComboProbeT0 = performance.now();',
        'let dshMobileComboProbeMonitor;',
        '/** A3 cache stats are published by combo-cache-A3; a missing block must not drop the field. */',
        'function dshMobileComboProbeCacheLine() {',
        '\tconst stats = globalThis.__dshMobileComboCacheStats;',
        '\treturn stats === void 0 ? "comboCache=none hits=0 misses=0"',
        '\t\t: `comboCache=${stats.state} hits=${stats.hits} misses=${stats.misses}`;',
        '}',
        '/** A5 lazy counter: distinguishes “已经延迟” from “探针没接上” (the -1 lesson). */',
        'function dshMobileComboProbeSingles() {',
        '\tconst value = globalThis.__dshMobileComboLazyStats?.singleBuilds;',
        '\treturn typeof value === "number" && Number.isFinite(value) ? value : -1;',
        '}',
        '/** C4 event-loop reading; without a monitor both fields still print, as -1 (never omitted). */',
        'function dshMobileComboProbeLoopLine() {',
        '\tconst monitor = dshMobileComboProbeMonitor;',
        '\tif (monitor === void 0) return "loopP99Ms=-1 loopSamples=-1";',
        '\tconst p99 = monitor.count === 0 ? -1 : (monitor.percentile(99) / 1e6).toFixed(1);',
        '\treturn `loopP99Ms=${p99} loopSamples=${monitor.count}`;',
        '}',
        '/**',
        '* Print the two probe lines for one composition. Field set and order are the contract shared',
        '* with scripts/perf/count-compose.mjs, scripts/check-boot-budget.mjs and the shell parser: the',
        '* TOTAL line always carries calls/totalMs/instances/firstAt/singles/loopP99Ms/loopSamples and',
        '* the cache line.',
        '* @param atMs - milliseconds from module load to this composition start.',
        '* @param durationMs - this composition duration in milliseconds.',
        '* @param records - composed record count, or -1 when unavailable.',
        '*/',
        'function dshMobileComboProbeEmit(atMs, durationMs, records) {',
        '\tconst stats = DSH_MOBILE_COMBO_PROBE_STATS;',
        '\tconst instances = dshMobileComboProbeInstances.size;',
        '\tconst singles = dshMobileComboProbeSingles();',
        '\tconst cache = dshMobileComboProbeCacheLine();',
        '\tconsole.log(`[perf] compose #${stats.calls} at=${atMs.toFixed(0)}ms dur=${durationMs.toFixed(0)}ms instances=${instances} records=${records} singles=${singles} ${cache}`);',
        '\tconst firstAt = stats.firstAt === null ? -1 : stats.firstAt;',
        '\tconsole.log(`[perf] TOTAL calls=${stats.calls} totalMs=${stats.totalMs.toFixed(0)} instances=${instances} firstAt=${firstAt === -1 ? -1 : `${firstAt.toFixed(0)}ms`} singles=${singles} ${dshMobileComboProbeLoopLine()} ${cache}`);',
        '\t/* dsh-mobile combo probe (P1): the C5 reverse judge reads a boot-time line. Emitting it here',
        '\t * (instead of relying on the measurement preload) keeps that judge evaluable in production,',
        '\t * where no preload is installed — otherwise C5 would be permanently unmeasurable on device. */',
        '\tif (stats.calls === 1) console.log(`[perf] boot singles=${singles} records=${records}`);',
        '}',
        '/** C5 positive control: a requested single-row URL must leave evidence that the counter moved. */',
        'function dshMobileComboProbeSingleEvent(atMs, singles) {',
        '\tDSH_MOBILE_COMBO_PROBE_STATS.singleRequests += 1;',
        '\tconsole.log(`[perf] single #${DSH_MOBILE_COMBO_PROBE_STATS.singleRequests} at=${atMs.toFixed(0)}ms singles=${singles}`);',
        '}',
        'if (!isMainThread) {',
        '\t/* dsh-mobile combo probe (P1): a non-main thread must never emit the probe. The shell keeps',
        '\t * the LAST TOTAL line, so a worker’s `calls=0` reading would be mistaken for the real one —',
        '\t * a fake zero that a `!= -1` gate cannot catch. */',
        '} else {',
        '\tconst dshMobileComboProbeProto = ClientModuleRegistry.prototype;',
        '\tconst dshMobileComboProbeOriginal = dshMobileComboProbeProto.compose;',
        '\tdshMobileComboProbeProto.compose = function (...args) {',
        '\t\tconst started = performance.now();',
        '\t\tif (DSH_MOBILE_COMBO_PROBE_STATS.firstAt === null) DSH_MOBILE_COMBO_PROBE_STATS.firstAt = started - dshMobileComboProbeT0;',
        '\t\tDSH_MOBILE_COMBO_PROBE_STATS.calls += 1;',
        '\t\tdshMobileComboProbeInstances.add(this);',
        '\t\tconst result = dshMobileComboProbeOriginal.apply(this, args);',
        '\t\tconst duration = performance.now() - started;',
        '\t\tDSH_MOBILE_COMBO_PROBE_STATS.totalMs += duration;',
        '\t\tdshMobileComboProbeEmit(started - dshMobileComboProbeT0, duration, this.table?.size ?? -1);',
        '\t\treturn result;',
        '\t};',
        '\t/* C5 positive control also lives in the product: a served single-row URL prints the line that',
        '\t * proves the lazy counter moved. Without it, “singles stayed 0” cannot be told apart from',
        '\t * “the probe never ran” — the exact lesson of t_compose_total being stuck at -1. */',
        '\tconst dshMobileComboProbeSingleOriginal = dshMobileComboProbeProto.dshMobileSingleComboResponse;',
        '\tif (typeof dshMobileComboProbeSingleOriginal === "function") {',
        '\t\tdshMobileComboProbeProto.dshMobileSingleComboResponse = function (...args) {',
        '\t\t\tconst result = dshMobileComboProbeSingleOriginal.apply(this, args);',
        '\t\t\tif (result !== void 0) dshMobileComboProbeSingleEvent(performance.now() - dshMobileComboProbeT0, dshMobileComboProbeSingles());',
        '\t\t\treturn result;',
        '\t\t};',
        '\t}',
        '\ttry {',
        '\t\tdshMobileComboProbeMonitor = monitorEventLoopDelay({ resolution: 10 });',
        '\t\tdshMobileComboProbeMonitor.enable();',
        '\t} catch {',
        '\t\t/* The probe must never break composition; C4 then reads -1 for both loop fields. */',
        '\t\tdshMobileComboProbeMonitor = void 0;',
        '\t}',
        '}',
        EXPORT_ANCHOR,
      ].join('\n')
      if (!s.includes(EXPORT_ANCHOR)) throw new Error('combo-probe 锚点未命中：模块 export 行（引擎升级后请人工核对 dsh-client-modules）')
      s = s.replace(EXPORT_ANCHOR, BLOCK)
      if (!s.includes('dsh-mobile combo probe (P1)')
        || !s.includes('dshMobileComboProbeEmit')
        || !s.includes('import { isMainThread } from "node:worker_threads";')
        || !s.includes('if (!isMainThread) {')) {
        throw new Error('combo-probe 复核失败——不写回')
      }
      return s
    },
  },

  // ── perf-compile-cache-flush-N2：NODE_COMPILE_CACHE 主动落盘（2026-09-14 缓存审计，scope=engine）──
  // 背景（2026-09-14 设备实测 + Node v24 文档）：Node 只在**进程正常退出**时把编译缓存写盘；
  // 壳侧停引擎是有界宽限的 SIGTERM→SIGKILL（EngineManager.killExistingEngine），Android 还会整进程
  // 回收——设备上 09-12 23:07 之后零新增条目，而 09-14 三次快照刷新换过引擎树，换掉的模块每次冷启
  // 都重新编译。修法：入口 bin.js 周期 flush（40 s 首刷 + 5 min）并在 exit 兜底；不注册信号处理，
  // 不改变任何命令的退出语义。flush 是同步调用，失败按 Node 契约静默忽略。
  'perf-compile-cache-flush-N2': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile compile cache flush (N2)') && s.includes('dshMobileFlushCompileCacheQuietly'),
    apply: (s) => {
      if (s.includes('dsh-mobile compile cache flush (N2)') && s.includes('dshMobileFlushCompileCacheQuietly')) return s
      // 锚 = bin.js 的最后一条顶层 import（rc.1 起 node:util 那行；此前是 node:fs 的 readFileSync，
      // 上游把根包改成只用 fs/promises 后旧锚逐字符消失）。插在 import 之后、`//#region` 之前，
      // 保证定时器与 exit 兜底在任何命令逻辑跑起来之前就注册。
      const IMPORT_OLD = 'import { inspect } from "node:util";'
      const BLOCK = [
        'import { flushCompileCache as dshMobileFlushCompileCache } from "node:module";',
        '/* dsh-mobile compile cache flush (N2): Node persists NODE_COMPILE_CACHE entries only when the',
        ' * process exits normally; the Android shell stops the engine with a bounded SIGTERM grace and',
        ' * the OS may reclaim the app process outright, so each boot would discard the code cache for',
        ' * the module graph it just compiled. Persist periodically (and at exit) instead of relying on',
        ' * a graceful shutdown. The API is best-effort by contract; failures are ignored. */',
        'const dshMobileFlushCompileCacheQuietly = () => {',
        '\ttry {',
        '\t\tdshMobileFlushCompileCache();',
        '\t} catch {',
        '\t\t/* a failed flush must never affect the engine (Node compile-cache contract) */',
        '\t}',
        '};',
        'setTimeout(dshMobileFlushCompileCacheQuietly, 40000).unref();',
        'setInterval(dshMobileFlushCompileCacheQuietly, 300000).unref();',
        'process.on("exit", dshMobileFlushCompileCacheQuietly);',
      ].join('\n')
      if (!s.includes(IMPORT_OLD)) throw new Error('compile-cache-flush 锚点未命中：bin.js 头部 import（引擎升级后请人工核对根包）')
      s = s.replace(IMPORT_OLD, IMPORT_OLD + '\n' + BLOCK)
      if (!s.includes('dsh-mobile compile cache flush (N2)') || !s.includes('dshMobileFlushCompileCacheQuietly')) {
        throw new Error('compile-cache-flush 复核失败——不写回')
      }
      return s
    },
  },

  // ── terminal-inspector-android-D1（D14）：Android 平台进程检查器（2026-09-26 设备实测，scope=engine）──
  // 背景：侧边栏「新建终端」在设备上失败：
  //   subprocess-local: terminal inspection is unsupported on platform android
  // 真因：Android 的 Node 把 process.platform 报成 'android'（不是 'linux'），而上游
  // createProcessInspector 只映射 linux / darwin / win32 → 直接 throw。
  // 同因下 selectContainmentMode 的 platform === 'linux' 分支与 LocalTerminalHandle 的若干
  // this.platform === 'linux' 判定在 android 上也拿不到该分支。
  //
  // 口径（为什么不改壳侧、也不改上游源）：
  // - 上游树零改动（铁律）；壳侧无法改变 Node 的 process.platform。
  // - Android 就是 Linux 内核，syscall 表（x64/arm64）与 /proc 形态一致，
  //   故把 'android' 归入既有 Linux 分支是语义等价，不新增实现。
  // - 只归类，不放松任何判据：真·不支持的平台仍然照旧 throw。
  'terminal-inspector-android-D1': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-B2zsQ1Dz.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile android is linux (D1)'),
    apply: (s) => {
      if (s.includes('dsh-mobile android is linux (D1)')) return s
      const OLD = 'function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS) {'
      const NEW = [
        '/* dsh-mobile android is linux (D1): Node reports process.platform === "android" on Android,',
        ' * while this dispatcher only maps linux/darwin/win32 — the terminal controller then fails with',
        ' * "terminal inspection is unsupported on platform android". Android is the Linux kernel, and',
        ' * the inspectors below are pure /proc + syscall-table readers, so android belongs to the Linux',
        ' * branch. This only widens the dispatch key; every other platform still throws. */',
        'function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS) {',
        '\tif (platform === "android") platform = "linux";',
      ].join(String.fromCharCode(10))
      if (!s.includes(OLD)) {
        throw new Error('terminal-inspector-android 锚点未命中：createProcessInspector——引擎升级后请人工核对 subprocess-local 构建产物')
      }
      s = s.replace(OLD, NEW)
      if (!s.includes('dsh-mobile android is linux (D1)')) throw new Error('terminal-inspector-android 复核失败——不写回')
      return s
    },
  },
}

// ── 登记表 ↔ 实现 交叉校验（漂移即拒）──
const regIds = registry.patches.map((p) => p.id)
const implIds = Object.keys(IMPLS)
const onlyReg = regIds.filter((id) => !implIds.includes(id))
const onlyImpl = implIds.filter((id) => !regIds.includes(id))
if (onlyReg.length || onlyImpl.length) {
  console.error(`registry.json 与 apply-patches.mjs IMPLS 不同步：仅登记表有 [${onlyReg}]，仅实现有 [${onlyImpl}]`)
  process.exit(1)
}

// ── CLI ──
const argv = process.argv.slice(2)
const vendorRoot = argv[0]
const flags = argv.slice(1)
const mode = flags.includes('--apply') ? 'apply' : flags.includes('--list') ? 'list' : 'check'
const onlyIdx = flags.indexOf('--only')
const only = onlyIdx >= 0 ? flags[onlyIdx + 1].split(',').map((s) => s.trim()) : null
const scopeIdx = flags.indexOf('--scope')
const scope = scopeIdx >= 0 ? flags[scopeIdx + 1] : 'vendor'
if (!['vendor', 'engine', 'all'].includes(scope)) {
  console.error('--scope 仅支持 vendor | engine | all（vendor=vendored plugins；engine=快照引擎树，build-snapshot 用）')
  process.exit(2)
}
const scopeOf = (p) => p.scope ?? 'vendor'
if (!vendorRoot || flags.some((f) => f.startsWith('-') && !['--check', '--apply', '--list', '--only', '--scope'].includes(f))) {
  console.error('用法: node scripts/patches/apply-patches.mjs <vendorRoot|stageRoot> [--check|--apply|--list] [--only id1,id2] [--scope vendor|engine|all]')
  process.exit(2)
}

const order = registry.patches.filter((p) => scope === 'all' || scopeOf(p) === scope).map((p) => p.id).filter((id) => !only || only.includes(id))
if (mode === 'list') {
  for (const p of registry.patches) {
    const status = p.soft ? 'soft' : 'gate'
    console.log(`${p.id.padEnd(16)} [${status}] ${p.target}  ${p.summary}  来源: ${p.provenance}`)
  }
  process.exit(0)
}

let applied = 0
let failed = 0
const touched = new Set()

/** 前提补丁（registry.requires）：前提未打时依赖补丁的锚点不可能命中——提前给出精确诊断。 */
const requirementFailure = (meta) => {
  for (const dep of meta?.requires ?? []) {
    const dimpl = IMPLS[dep]
    if (!dimpl) return `requires 声明的补丁 ${dep} 没有实现（registry/IMPLS 漂移）`
    let dsrc
    try {
      dsrc = loadImpl(dimpl.file, vendorRoot)
    } catch {
      return `前提补丁 ${dep} 的目标文件缺失（${dimpl.file}）`
    }
    if (!dimpl.check(dsrc)) return `前提补丁 ${dep} 未打（marker 不在场）——先施加 ${dep}，否则本补丁只会在原地空转`
  }
  return null
}

for (const id of order) {
  const impl = IMPLS[id]
  const meta = registry.patches.find((p) => p.id === id)
  let src
  try {
    src = loadImpl(impl.file, vendorRoot)
  } catch (e) {
    console.error(`[fail] ${id}: 目标文件缺失 ${impl.file}（${e.message}）`)
    failed++
    continue
  }
  const missingDep = requirementFailure(meta)
  if (missingDep) {
    console.error(`[fail] ${id}: ${missingDep}`)
    failed++
    continue
  }
  if (impl.check(src)) {
    console.log(`[skip] ${id} 已应用（${impl.file}）`)
    continue
  }
  if (mode === 'check') {
    if (meta.soft) {
      console.warn(`[warn] ${id} 缺席（soft 补丁，不拒打包）——锚点可能已变，请人工核对 ${impl.file}`)
      continue
    }
    console.error(`[fail] ${id} 缺席（${impl.file}）——${meta.summary}`)
    failed++
    continue
  }
  try {
    const next = impl.apply(src)
    // FX-E19：check() 为假却「施加后零改动」= 锚点未命中（典型：前提补丁未打）。
    // 旧实现照打 `[ok] applied` 并报 `ALL OK`，制造假绿 apply——零改动必须失败。
    if (next === src) {
      console.error(`[fail] ${id}: apply 零改动（锚点未命中或前提补丁未打）——拒绝报 ALL OK；请人工核对 ${impl.file}`)
      failed++
      continue
    }
    if (!impl.check(next)) {
      console.error(`[fail] ${id}: 施加后自验失败（marker 仍不在场）——不写回 ${impl.file}`)
      failed++
      continue
    }
    IMPL_state[impl.file] = next
    touched.add(impl.file)
    saveImpl(impl.file, vendorRoot)
    applied++
    console.log(`[ok]   ${id} applied（${impl.file}）`)
  } catch (e) {
    console.error(`[fail] ${id}: ${e.message}`)
    failed++
  }
}

if (mode === 'apply') {
  console.log(`applied ${applied}/${order.length}${failed ? `，失败 ${failed}` : ''}`)
  if (failed) process.exit(1)
} else if (failed) {
  process.exit(1)
}
console.log(`apply-patches: ALL OK（${order.length - failed}/${order.length}，mode=${mode}，changed=${applied}）`)
