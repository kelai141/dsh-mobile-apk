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

// ── dshmarketplace-plugin / lib/index.js：A（tt 守卫三锚点）──────────────────
const A_FIXED = [
  'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();',
  'if(!r)return n();',
  ')});return n()}}',
]

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
  // ── marketplace A：pre-execute 守卫（全工具崩溃修复）──
  'market-A': {
    file: 'dshmarketplace-plugin/lib/index.js',
    check: (s) => A_FIXED.every((m) => s.includes(m)),
    apply: (s) => {
      let changed = 0
      // A-1 签名 + 首路径（长形态优先，短形态兜底）
      if (s.includes('function tt(){return async t=>{if(t?.tool?.name!=="dshmarketplace_install")return;')) {
        s = s.replace('function tt(){return async t=>{if(t?.tool?.name!=="dshmarketplace_install")return;', 'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();')
        changed++
      } else if (s.includes('dshmarketplace_install")return;') && !s.includes('dshmarketplace_install")return n();')) {
        s = s.replace('dshmarketplace_install")return;', 'dshmarketplace_install")return n();')
        changed++
      }
      // A-2 fullName 空路径
      if (!s.includes('if(!r)return n();') && s.includes('if(!r)return;')) {
        s = s.replace('if(!r)return;', 'if(!r)return n();')
        changed++
      }
      // A-3 尾部
      if (!s.includes(')});return n()}}') && s.includes('join(`\n`)}}')) {
        s = s.replace('join(`\n`)}}', 'join(`\n`)});return n()}}')
        changed++
      }
      if (changed === 0) {
        throw new Error('锚点未命中——未匹配任何已知形态；请人工检查 lib/index.js 的 tt() 实现')
      }
      if (!A_FIXED.every((m) => s.includes(m))) {
        throw new Error('修复后复核失败（锚点缺失）——不写回，请人工检查')
      }
      return s
    },
  },

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

  // ── marketplace C：不可安装条目置灰（soft：锚点失配仅告警不拒打包，与原语义一致）──
  'market-C': {
    file: 'dshmarketplace-plugin/lib/client.js',
    soft: true,
    check: (s) => s.includes('||e.installable===false'),
    apply: (s) => {
      const OLD = 'className:"dshm-install",disabled:n==="installing"||n==="installed",onClick:()=>a(e)'
      const NEW = 'className:"dshm-install",title:e.installable===false?"该条目当前不可安装（市场无安装命令，或需凭据/仅桌面环境）":"",disabled:n==="installing"||n==="installed"||e.installable===false,onClick:()=>a(e)'
      if (!s.includes(OLD)) throw new Error('置灰锚点未命中——安装按钮渲染可能已变，请人工核对')
      const out = s.replace(OLD, NEW)
      if (!out.includes('||e.installable===false')) throw new Error('置灰复核失败——不写回')
      return out
    },
  },

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
      const INSERT_BEFORE = 'function qt(t){'
      const OLD = 'let a=await u({q:s.searchParams.get("q")??void 0,category:s.searchParams.get("category")??void 0,limit:s.searchParams.get("limit")??60});l(e,200,a)'
      const NEW = 'let _q=s.searchParams.get("q")??void 0,_m=String(_q??"").startsWith("mobile:");if(_m)_q=String(_q).slice(7).trim()||void 0;let a=await u({q:_q,category:s.searchParams.get("category")??void 0,limit:s.searchParams.get("limit")??60});a.results=(a.results??[]).map(x=>Wc(x));if(_m)a.results=a.results.filter(x=>x.compat!=="desktop");l(e,200,a)'
      if (!s.includes(INSERT_BEFORE)) throw new Error('D 插入锚点 qt( 未命中——请人工核对')
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
      const SEARCH_OLD = 'let r=A();r&&t.skills.register(r),t.webServer.register({kind:"exact",path:Q,handler:async(n,e)=>{'
      const SEARCH_NEW = [
        'let r=A();r&&t.skills.register(r);',
        AUTH_NEW,
        't.webServer.register({kind:"exact",path:Q,handler:async(n,e)=>{if(!dshMobileMarketplaceRouteAuthorized(n,e))return;',
      ].join('')
      const INSTALL_OLD = 't.webServer.register({kind:"exact",path:V,handler:b({install:n=>p(n,T()),onInstalled:f})})'
      const INSTALL_NEW = 't.webServer.register({kind:"exact",path:V,handler:async(n,e)=>{if(!dshMobileMarketplaceRouteAuthorized(n,e))return;return b({install:s=>p(s,T()),onInstalled:f})(n,e)}})'
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

  // ── atomic-stale-lock-F4：孤儿写锁回收（2026-09-10 模拟器实测，scope=engine）──
  // withFileLock 用 wx 建 <file>.lock 做跨进程写互斥，锁内容就是持有者 pid；释放走 operation 的
  // finally（rm）。进程被硬杀（用户划掉应用 / 系统 OOM / am force-stop / 壳侧看门狗重启）时 finally
  // 不执行 → 锁文件永久残留 → 之后每一次写该文件都等到 deadline 抛
  // "atomic-write: timed out waiting for the writer lock at …/.credentials.yaml.lock"。
  // 上游注释明写「contender never removes an existing lock… orphan recovery is an operator action」——
  // 桌面/服务器有位「运维」可以删锁，Android 应用私有目录（/data/data/<pkg>/…）用户无任何可达手段，
  // 症状等于应用永久起不来（实测：重复引擎进程被清掉后仍 boot 失败，只因残留 .credentials.yaml.lock）。
  //
  // 不变量：仅当锁记录的 pid 已消失且锁内容二次核验一致时才回收，且每次获取最多回收一次。
  // pid 存活用 process.kill(pid, 0)：ESRCH=不存活（可回收），EPERM=存活但非本进程（不回收）。
  // 读取失败 / 内容非 pid / 二次核验不一致 / 任何异常 → 一律不动锁（退回上游的等待-超时语义）。
  'atomic-stale-lock-F4': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile stale-lock recovery (F4)'),
    apply: (s) => {
      if (s.includes('dsh-mobile stale-lock recovery (F4)')) return s
      const IMPORT_OLD = 'import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";'
      const IMPORT_NEW = 'import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";'
      const HELPER_OLD = '/**\n* Retry cadence for a contended lock.'
      const HELPER_NEW = [
        '/**',
        '* dsh-mobile stale-lock recovery (F4): remove a writer lock whose recorded owner is gone.',
        '* Returns whether the lock was removed; any unproven case leaves the lock untouched so the',
        '* upstream wait-and-timeout semantics stay authoritative.',
        '* @param lockPath - the `<file>.lock` sibling to inspect.',
        '* @returns `true` when an orphaned lock was removed.',
        '*/',
        'async function recoverStaleLock(lockPath) {',
        '\ttry {',
        '\t\tconst owner = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);',
        '\t\tif (!Number.isInteger(owner) || owner <= 0) return false;',
        '\t\tlet alive = true;',
        '\t\ttry {',
        '\t\t\tprocess.kill(owner, 0);',
        '\t\t} catch (error) {',
        '\t\t\talive = error?.code === "EPERM"; // EPERM: the process exists but is not ours',
        '\t\t}',
        '\t\tif (alive) return false;',
        '\t\tconst confirmed = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);',
        '\t\tif (confirmed !== owner) return false; // a live contender re-took the lock meanwhile',
        '\t\tawait rm(lockPath, { force: true });',
        '\t\tconsole.warn(`atomic-write: removed the orphaned writer lock at ${lockPath} (owner pid ${owner} is gone; dsh-mobile F4)`);',
        '\t\treturn true;',
        '\t} catch {',
        '\t\treturn false; // unreadable/unremovable lock: let the deadline decide, as upstream does',
        '\t}',
        '}',
        '/**',
        '* Retry cadence for a contended lock.',
      ].join('\n')
      const LOOP_OLD = '\tlet delay = LOCK_RETRY_INITIAL_MS;'
      const LOOP_NEW = '\tlet delay = LOCK_RETRY_INITIAL_MS;\n\tlet recovered = false; // dsh-mobile F4: at most one orphan recovery per acquisition'
      // 上游把 deadline 声明为 const（只读一次就够，因为从不延长）；回收后要重新给一点宽限，
      // 故这里必须改成 let——功能测试实测：不改则 TypeError: Assignment to constant variable。
      const DEADLINE_DECL_OLD = '\tconst deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS);'
      const DEADLINE_DECL_NEW = '\tlet deadline = Date.now() + (options?.waitMs ?? DEFAULT_LOCK_WAIT_MS); // dsh-mobile F4: extended once after an orphan recovery'
      const DEADLINE_OLD = '\t\tif (Date.now() >= deadline) throw new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`);'
      const DEADLINE_NEW = [
        '\t\tif (Date.now() >= deadline) {',
        '\t\t\tif (!recovered && await recoverStaleLock(lockPath)) {',
        '\t\t\t\trecovered = true;',
        '\t\t\t\tdeadline = Date.now() + LOCK_RETRY_MAX_MS * 5;',
        '\t\t\t\tcontinue;',
        '\t\t\t}',
        '\t\t\tthrow new Error(`atomic-write: timed out waiting for the writer lock at ${lockPath}`);',
        '\t\t}',
      ].join('\n')
      for (const [old, label] of [[IMPORT_OLD, 'import 行'], [HELPER_OLD, 'LOCK_RETRY 常量注释'], [LOOP_OLD, 'delay 初始化'], [DEADLINE_DECL_OLD, 'deadline 声明'], [DEADLINE_OLD, '超时 throw']]) {
        if (!s.includes(old)) throw new Error(`atomic-stale-lock 锚点未命中（${label}）——引擎升级后请人工核对 dsh-atomic-write/lib/index.js`)
      }
      s = s.replace(IMPORT_OLD, IMPORT_NEW)
      s = s.replace(HELPER_OLD, HELPER_NEW)
      s = s.replace(LOOP_OLD, LOOP_NEW)
      s = s.replace(DEADLINE_DECL_OLD, DEADLINE_DECL_NEW)
      s = s.replace(DEADLINE_OLD, DEADLINE_NEW)
      if (!s.includes('dsh-mobile stale-lock recovery (F4)')) throw new Error('atomic-stale-lock 复核失败——不写回')
      return s
    },
  },

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

  // ── boot-pending-G1：web boot 容错（0.13.5 W1b，引擎树补丁 scope=engine）──
  // issue #126 P3：第三方插件声明 inject 了 client-only 服务（uiConversation 只存在于
  // dsh-client-ui-*/lib/client.js），宿主永远不 provide → fiber 永久 pending →
  // assertEntriesActivated 抛错 → 整树 boot 失败、用户看到「Failed to load plugins」。
  // 不变量：非官方包的 pending 降级为告警（等不到的服务不会因等待而出现），
  // FAILED 与官方包（@deepseek-ai/*）pending 仍然致命——核心 bundle 坏掉必须响亮失败。
  'boot-pending-G1': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile boot tolerance (G1)'),
    apply: (s) => {
      const DECL_OLD = '\tconst failures = [];'
      const DECL_NEW = '\tconst failures = [];\n'
        + '\t// dsh-mobile boot tolerance (G1): entries that stay pending are collected here\n'
        + '\t// instead of failing the boot, unless they are official packages.\n'
        + '\tconst deferred = [];'
      const PENDING_OLD = '\t\t\tfailures.push(`${entry.options.name}: pending (waiting for ${subject}: ${missing.join(", ") || "unknown"})`);'
      const PENDING_NEW = '\t\t\tconst pendingLine = `${entry.options.name}: pending (waiting for ${subject}: ${missing.join(", ") || "unknown"})`;\n'
        + '\t\t\t// dsh-mobile boot tolerance (G1): a missing service a third-party entry waits for\n'
        + '\t\t\t// never appears on the host, so waiting cannot succeed; keep it pending and boot on.\n'
        + '\t\t\tif (String(entry.options.name ?? "").startsWith("@deepseek-ai/")) failures.push(pendingLine);\n'
        + '\t\t\telse deferred.push(pendingLine);'
      const THROW_OLD = '\tif (failures.length > 0) {'
      const THROW_NEW = '\tif (deferred.length > 0) {\n'
        + '\t\tconst deferredNoun = deferred.length === 1 ? "entry" : "entries";\n'
        + '\t\tconsole.warn(`${binName}: ${String(deferred.length)} ${deferredNoun} did not activate and stays pending; boot continues (dsh-mobile boot tolerance (G1))\\n${deferred.join("\\n")}`);\n'
        + '\t}\n'
        + '\tif (failures.length > 0) {'
      const REPL = [
        { old: DECL_OLD, neu: DECL_NEW },
        { old: PENDING_OLD, neu: PENDING_NEW },
        { old: THROW_OLD, neu: THROW_NEW },
      ]
      let changed = 0
      for (const { old, neu } of REPL) {
        if (s.includes(neu)) continue
        if (!s.includes(old)) throw new Error('boot-pending 锚点未命中：' + old.slice(0, 90) + '…——引擎升级后请人工核对 assertEntriesActivated')
        s = s.replace(old, neu)
        changed++
      }
      if (!s.includes('dsh-mobile boot tolerance (G1)') || !s.includes('const deferred = [];')) {
        throw new Error('boot-pending 复核失败——不写回')
      }
      console.log(`  boot-pending-G1: ${changed} 处锚点替换`)
      return s
    },
  },

  // ── boot-third-party-isolation-G3：第三方插件 boot 期失败隔离（0.14.1，scope=engine）──
  // 真因（真实用户反馈 报错反馈/0.14.0/20260919-125714-engine-died-during-boot，华为 NOH-AN00 /
  // Android 31 / arm64 / 0.14.0 vc39）：用户自装的 dsh-live2d-pets 在 **import 期**抛 SyntaxError
  // （`The requested module '@deepseek-ai/dsh-settings' does not provide an export named
  // 'settingsNamespace'`）→ 整树 boot 失败、engine exit=1。
  // **boot-pending-G1 结构上无法覆盖这一形态**：G1 的锚点全在 `assertEntriesActivated` 内
  // （dsh-app-boot/lib/index.js:1472-1505），而 import 失败的抛出点在**更早**的调用链上——
  //   boot(:1543) → mountRootInclude(:1552) → loader.create(:553) → EntryTree.update
  //   (cordis-plugin-loader/lib/index.js:86) → Promise.allSettled(:97) → Entry._init → import 失败
  //   → updateError("import", …)（loader:309/524）→ failures.length === 1 → `throw failures[0]`（loader:100）
  // 该异常在 mountRootInclude 处就冒泡进 boot 的 catch(:1557)，**assertEntriesActivated(:1555) 根本
  // 不会被执行** ⇒ 不是「锚点漏了分支」，而是 G1 的函数在这条路径上不可达。
  // 修法：在 boot() 里把挂载 root include 换成**隔离式挂载**——失败时若失败条目属于「用户自装第三方」，
  // 则用既有 patch 机制给它加 `disabled: true` 后重试；成功后在 engine.log 里**点名**被跳过的插件。
  //   - 复用 `applyEntryPatches` 的 `disabled` 覆盖（cordis-plugin-include/lib/index.js:100），
  //     loader 的 `Entry._disabled()` 对新条目跳过 `init()` ⇒ 不再 import 坏插件。不改 loader/vendor。
  //   - **官方包与出厂移动侧插件失败仍然响亮失败**（@deepseek-ai/*、@dsh-android/* 及出货具名插件），
  //     核心坏掉必须可见——这条不变量与 G1 同口径且更强。
  //   - **有上限**：最多隔离 8 个，超过即响亮失败并给出完整清单（不允许无限容忍）。
  //   - 与 G1 **anchor 互不相交、顺序无关**（各自函数不同），故不设 requires 以免假耦合。
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
      && !s.includes('\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl);'),
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
        'const DSH_MOBILE_SHIPPED_PLUGIN_NAMES = ["dsh-undo-savepoint", "dshmarketplace-plugin", "@aiwayds/dsh-model-sync"];',
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
        '\t\t\tawait mountRootInclude(ctx, absoluteConfigPath, [...(patches ?? []), ...disabled], bareModuleBaseUrl);',
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
      const CALL_OLD = '\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl);'
      const CALL_NEW = '\t\tawait dshMobileMountRootIncludeTolerant(ctx, binName, absoluteConfigPath, patches, bareModuleBaseUrl); /* dsh-mobile third-party boot isolation (G3) */'
      if (!s.includes(CALL_OLD)) throw new Error('boot-third-party-isolation 锚点未命中：boot() 内 mountRootInclude 调用点')
      s = s.replace(CALL_OLD, CALL_NEW)
      if (!s.includes('dsh-mobile third-party boot isolation (G3)')
        || !s.includes('dshMobileMountRootIncludeTolerant')
        || !s.includes('__dshMobileBootSkippedPlugins')
        || s.includes('\t\tawait mountRootInclude(ctx, absoluteConfigPath, patches, bareModuleBaseUrl);')) {
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
  // ── perf-patch-reload-N1：patchReload=startup 出厂默认 + 存量升级归一化（0.13.8 性能 A1，scope=engine）──
  // 背景（docs/ANDROID-RUNTIME-PERF-2026-09-12.md §A1/R2，实测 24.9s -> 16.6s 冷启动）：
  // 出厂 web profile 的 patchReload 是 "live"，上游在 live 档额外挂 cordis-plugin-timer 与
  // cordis-plugin-hmr，启动期反复现场重算客户端 combo（36 -> 16 次）。Android 上 live reload
  // 本就不可用（坑 19：改 cordis.patch.yml 必须冷启动才生效），保留它纯亏启动时间。
  // 两处一起改才算修好（P-AC-23 全新安装 + P-AC-24 存量升级）：
  //   ① web 模板默认 "live" -> "startup"：initProfile（全新安装）与「键缺失」的升级用户都拿到 startup；
  //   ② normalizeShippedProfile 的 needsReloadDefault：上游只在键**缺失**时写回模板默认，而存量设备上
  //      旧引擎早已把 "live" 显式写进 profiles/web/package.json -> 永不归一化。改为「installation-owned
  //      当前元组下把旧默认 live 一并归一化」，只动安装方拥有的元组，用户自建 profile 元组不受影响。
  'perf-patch-reload-N1': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
    scope: 'engine',
    check: (s) => (s.match(/dsh-mobile patchReload normalization \(N1\)/g) || []).length === 2,
    apply: (s) => {
      if ((s.match(/dsh-mobile patchReload normalization \(N1\)/g) || []).length === 2) return s
      const TEMPLATE_OLD = '\tweb: {\n\t\tbundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],\n\t\tpatchReload: "live"\n\t},'
      const TEMPLATE_NEW = [
        '\tweb: {',
        '\t\tbundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],',
        '\t\t/* dsh-mobile patchReload normalization (N1): the shipped web profile starts in',
        '\t\t * "startup" mode — Android cannot use live patch reload (a cordis.patch.yml change',
        '\t\t * never takes effect without a restart, gotcha 19) and live costs 8s of cold start. */',
        '\t\tpatchReload: "startup"',
        '\t},',
      ].join('\n')
      if (!s.includes(TEMPLATE_OLD)) throw new Error('perf-patch-reload 锚点未命中：web 模板 patchReload: "live"')
      s = s.replace(TEMPLATE_OLD, TEMPLATE_NEW)
      const NORMALIZE_OLD = '\tconst needsReloadDefault = manifest.dsh?.profile?.patchReload === void 0 && isCurrentTuple;'
      const NORMALIZE_NEW = [
        '\t/* dsh-mobile patchReload normalization (N1): resident installs already carry the old',
        '\t * installation default "live" explicitly, so the upstream fill-a-missing-key rule never',
        '\t * reaches them; an installation-owned tuple is normalized to the shipped default. */',
        '\tconst staleReloadDefault = manifest.dsh?.profile?.patchReload === "live";',
        '\tconst needsReloadDefault = isCurrentTuple && (manifest.dsh?.profile?.patchReload === void 0 || staleReloadDefault);',
      ].join('\n')
      if (!s.includes(NORMALIZE_OLD)) throw new Error('perf-patch-reload 锚点未命中：needsReloadDefault（引擎升级后请人工核对 normalizeShippedProfile）')
      s = s.replace(NORMALIZE_OLD, NORMALIZE_NEW)
      const ASSIGN_OLD = '\t\t\t\tpatchReload: manifest.dsh?.profile?.patchReload ?? template.patchReload'
      const ASSIGN_NEW = '\t\t\t\tpatchReload: staleReloadDefault ? template.patchReload : (manifest.dsh?.profile?.patchReload ?? template.patchReload)'
      if (!s.includes(ASSIGN_OLD)) throw new Error('perf-patch-reload 锚点未命中：patchReload 回写表达式')
      s = s.replace(ASSIGN_OLD, ASSIGN_NEW)
      if ((s.match(/dsh-mobile patchReload normalization \(N1\)/g) || []).length !== 2) {
        throw new Error('perf-patch-reload 复核失败——不写回')
      }
      return s
    },
  },

  // ── combo-lazy-A4：compose() 延迟 + 去重（0.14.0 启动性能 P1-1，scope=engine）──
  // 背景（docs/ANDROID-RUNTIME-PERF-2026-09-12.md §R1/§4.A4）：装配期每次 internal/plugin 事件
  // 都触发 flush → compose() 全表重建 90 条 combo（单次 1.8-3.1 s，启动期 9-14 次，占 LISTEN
  // 墙钟 88%）。上游构造函数还先 compose 一次、再 flush 一次（同数据纯重复）。修法：
  //   ① 构造函数不再抢先 compose；
  //   ② flush 只置脏（composeDirty），首个读者（graph()/index-inject/bundle 路由/rebuilt）触发
  //      唯一一次全量 compose——boot 期间的多次表变更因此收敛为一次；
  //   ③ 图已存在后的 flush（运行期插件挂载/HMR）保持即时重算 + notify，行为不变（HMR rebuilt()
  //      路径原样，只补清脏标记）。
  // 与 A3 叠加：唯一那次 compose 里逐条查构建期缓存。
  'combo-lazy-A4': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
    scope: 'engine',
    check: (s) => (s.match(/dsh-mobile combo lazy \(A4\)/g) || []).length === 2
      && s.includes('\tensureComposed() {')
      && !s.includes('\t\tthis.composed = this.compose();\n\t\tconst failures = [];'),
    apply: (s) => {
      if ((s.match(/dsh-mobile combo lazy \(A4\)/g) || []).length === 2 && s.includes('\tensureComposed() {')) return s
      const FIELD_OLD = '\tflushQueued = false;\n\tcomposed;'
      const FIELD_NEW = '\tflushQueued = false;\n\tcomposed;\n\tcomposeDirty = false; /* dsh-mobile combo lazy (A4): a flush deferred the composed graph */'
      if (!s.includes(FIELD_OLD)) throw new Error('combo-lazy 锚点未命中：类字段 flushQueued/composed')
      s = s.replace(FIELD_OLD, FIELD_NEW)
      const CTOR_OLD = '\t\tthis.composed = this.compose();\n\t\tconst failures = [];'
      const CTOR_NEW = [
        '\t\t/* dsh-mobile combo lazy (A4): the initial composition is deferred to the first graph',
        '\t\t * reader (or the first post-serve table change), so every boot-time flush coalesces. */',
        '\t\tconst failures = [];',
      ].join('\n')
      if (!s.includes(CTOR_OLD)) throw new Error('combo-lazy 锚点未命中：构造函数抢先 compose（引擎升级后请人工核对 ClientModuleRegistry）')
      s = s.replace(CTOR_OLD, CTOR_NEW)
      const FLUSH_OLD = '\t\tif (!changed) return;\n\t\tlet composed;'
      const FLUSH_NEW = [
        '\t\tif (!changed) return;',
        '\t\tthis.composeDirty = true;',
        '\t\tif (this.composed === void 0) return; /* defer the first composition to the graph reader (A4) */',
        '\t\tlet composed;',
      ].join('\n')
      if (!s.includes(FLUSH_OLD)) throw new Error('combo-lazy 锚点未命中：flush 提前返回')
      s = s.replace(FLUSH_OLD, FLUSH_NEW)
      const FLUSH_SET_OLD = '\t\tthis.composed = composed;\n\t\tthis.notifyGraphChanged();'
      const FLUSH_SET_NEW = '\t\tthis.composed = composed;\n\t\tthis.composeDirty = false;\n\t\tthis.notifyGraphChanged();'
      if (!s.includes(FLUSH_SET_OLD)) throw new Error('combo-lazy 锚点未命中：flush 写回 + notify')
      s = s.replace(FLUSH_SET_OLD, FLUSH_SET_NEW)
      const GRAPH_OLD = '\tgraph() {\n\t\treturn this.composed;\n\t}'
      const GRAPH_NEW = [
        '\tgraph() {',
        '\t\treturn this.ensureComposed();',
        '\t}',
        '\t/**',
        '\t* Compose on demand: the first reader after any table change pays the single full pass;',
        '\t* later readers reuse the stable graph object. Boot-time flushes only mark dirty, so the',
        '\t* 9-14 startup compositions collapse into the first read (perf A4).',
        '\t* @returns the current composed entry graph.',
        '\t*/',
        '\tensureComposed() {',
        '\t\tif (this.composed !== void 0 && !this.composeDirty) return this.composed;',
        '\t\tconst composed = this.compose();',
        '\t\tthis.composed = composed;',
        '\t\tthis.composeDirty = false;',
        '\t\treturn composed;',
        '\t}',
      ].join('\n')
      if (!s.includes(GRAPH_OLD)) throw new Error('combo-lazy 锚点未命中：graph()')
      s = s.replace(GRAPH_OLD, GRAPH_NEW)
      const INJECT_OLD = '\t\t\ttable.push(...bootInjections(this.composed));'
      const INJECT_NEW = '\t\t\ttable.push(...bootInjections(this.ensureComposed()));'
      if (!s.includes(INJECT_OLD)) throw new Error('combo-lazy 锚点未命中：index-inject 行')
      s = s.replace(INJECT_OLD, INJECT_NEW)
      const RESOURCE_OLD = '\tbundleResource(method, url) {\n\t\tif (method !== "GET" && method !== "HEAD") return { status: 405 };'
      const RESOURCE_NEW = '\tbundleResource(method, url) {\n\t\tthis.ensureComposed();\n\t\tif (method !== "GET" && method !== "HEAD") return { status: 405 };'
      if (!s.includes(RESOURCE_OLD)) throw new Error('combo-lazy 锚点未命中：bundleResource')
      s = s.replace(RESOURCE_OLD, RESOURCE_NEW)
      const REBUILT_OLD = '\t\tthis.composed = this.compose();\n\t\tfor (const notify of this.rebuildListeners) try {'
      const REBUILT_NEW = '\t\tthis.composed = this.compose();\n\t\tthis.composeDirty = false;\n\t\tfor (const notify of this.rebuildListeners) try {'
      if (!s.includes(REBUILT_OLD)) throw new Error('combo-lazy 锚点未命中：rebuilt() 即时重算')
      s = s.replace(REBUILT_OLD, REBUILT_NEW)
      if ((s.match(/dsh-mobile combo lazy \(A4\)/g) || []).length !== 2 || !s.includes('\tensureComposed() {')) {
        throw new Error('combo-lazy 复核失败——不写回')
      }
      return s
    },
  },

  // ── combo-cache-A3：combo 构建期预计算 + 运行时查表（0.14.0 启动性能 P1-2，scope=engine）──
  // 契约（与 scripts/lib/combo-precompute.mjs、scripts/check-combo-cache.mjs 三处同源，勿单边演进）：
  //   键 = sha256(client.js 原始字节)；值 = { id, source, lines, map }；
  //   清单 = $DSH_HOME/profiles/web/.combo-cache/{client-combos.json,client-combos.inject.json}（按序合并，
  //   后者为注入段增量）；未命中/损坏/id 不符/文件不可读一律回退现场生成并计数（fail-open）。
  // 命中路径跳过的正是热点：comboSource 的 utf8 解码与正则、newlineCount 逐字符扫描、
  // identitySectionMap（mappings 拼接 + sourcesContent 全文进 map）。HMR rebuilt() 时 bundle 已变，
  // sha 天然不匹配 → 回退现场生成（行为与不装缓存一致）。
  'combo-cache-A3': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile combo cache (A3)')
      && s.includes('dsh-mobile combo cache hit (A3)')
      && s.includes('dsh-mobile combo cache report (A3)'),
    apply: (s) => {
      if (s.includes('dsh-mobile combo cache (A3)')
        && s.includes('dsh-mobile combo cache hit (A3)')
        && s.includes('dsh-mobile combo cache report (A3)')) return s
      const HELPERS = [
        '/* dsh-mobile combo cache (A3): precomputed identity-combo sections keyed by sha256(client.js',
        ' * bytes), shipped under <DSH_COMBO_CACHE || $DSH_HOME/profiles/web/.combo-cache>. Every lookup',
        ' * failure (absent manifest, corrupt JSON, id mismatch, unreadable map file) falls back to the',
        ' * live composition and is counted for the boot probe (fail-open, P-AC-05). */',
        'const DSH_MOBILE_COMBO_CACHE_STATS = { state: "unloaded", entries: 0, hits: 0, misses: 0 };',
        'Object.defineProperty(globalThis, "__dshMobileComboCacheStats", { value: DSH_MOBILE_COMBO_CACHE_STATS, configurable: true });',
        'let dshMobileComboCache = null;',
        'let dshMobileComboCacheWarned = false;',
        'let dshMobileComboCacheReported = false;',
        'const dshMobileComboCacheMemo = /* @__PURE__ */ new WeakMap();',
        'function dshMobileComboCacheWarn(message) {',
        '\tif (dshMobileComboCacheWarned) return;',
        '\tdshMobileComboCacheWarned = true;',
        '\tconsole.warn(`client-modules: combo cache (A3) fell back to live composition: ${message}`);',
        '}',
        'function dshMobileComboCacheLoad() {',
        '\tif (dshMobileComboCache !== null) return dshMobileComboCache;',
        '\tconst home = process.env.DSH_HOME;',
        '\tconst dir = process.env.DSH_COMBO_CACHE !== void 0 && process.env.DSH_COMBO_CACHE !== "" ? process.env.DSH_COMBO_CACHE',
        '\t\t: home === void 0 || home === "" ? void 0 : join(home, "profiles", "web", ".combo-cache");',
        '\tconst cache = { dir: dir ?? "", entries: /* @__PURE__ */ new Map() };',
        '\tif (dir === void 0) {',
        '\t\tDSH_MOBILE_COMBO_CACHE_STATS.state = "no-dsh-home";',
        '\t\tdshMobileComboCache = cache;',
        '\t\treturn cache;',
        '\t}',
        '\tlet manifests = 0;',
        '\tfor (const name of ["client-combos.json", "client-combos.inject.json"]) {',
        '\t\tconst path = join(dir, name);',
        '\t\tif (!existsSync(path)) continue;',
        '\t\tmanifests += 1;',
        '\t\ttry {',
        '\t\t\tconst manifest = JSON.parse(readFileSync(path, "utf8"));',
        '\t\t\tconst entries = manifest === null || typeof manifest !== "object" ? void 0 : manifest.entries;',
        '\t\t\tif (entries === null || typeof entries !== "object") throw new Error(`${name}: entries missing`);',
        '\t\t\tfor (const [key, value] of Object.entries(entries)) {',
        '\t\t\t\tif (value === null || typeof value !== "object") continue;',
        '\t\t\t\tif (typeof value.id !== "string" || typeof value.source !== "string" || typeof value.lines !== "number" || typeof value.map !== "string") continue;',
        '\t\t\t\tcache.entries.set(key, value);',
        '\t\t\t}',
        '\t\t} catch (error) {',
        '\t\t\tdshMobileComboCacheWarn(`${name}: ${error instanceof Error ? error.message : String(error)}`);',
        '\t\t}',
        '\t}',
        '\tDSH_MOBILE_COMBO_CACHE_STATS.state = manifests === 0 ? "absent" : cache.entries.size === 0 ? "empty" : "loaded";',
        '\tDSH_MOBILE_COMBO_CACHE_STATS.entries = cache.entries.size;',
        '\tdshMobileComboCache = cache;',
        '\treturn cache;',
        '}',
        'function dshMobileComboCacheLookup(record) {',
        '\tif (record.sourceMap !== void 0) return void 0;',
        '\tconst memo = dshMobileComboCacheMemo.get(record);',
        '\tif (memo !== void 0 && memo.bundle === record.bundle) return memo.value;',
        '\tconst cache = dshMobileComboCacheLoad();',
        '\tlet value;',
        '\tconst entry = cache.entries.get(createHash("sha256").update(record.bundle).digest("hex"));',
        '\tif (entry !== void 0 && entry.id === record.entry.id) {',
        '\t\ttry {',
        '\t\t\tvalue = {',
        '\t\t\t\tsource: entry.source,',
        '\t\t\t\tlines: entry.lines,',
        '\t\t\t\tsection: JSON.parse(readFileSync(join(cache.dir, entry.map), "utf8"))',
        '\t\t\t};',
        '\t\t\tDSH_MOBILE_COMBO_CACHE_STATS.hits += 1;',
        '\t\t} catch (error) {',
        '\t\t\tdshMobileComboCacheWarn(`map read failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);',
        '\t\t\tvalue = void 0;',
        '\t\t}',
        '\t}',
        '\tif (value === void 0) DSH_MOBILE_COMBO_CACHE_STATS.misses += 1;',
        '\tdshMobileComboCacheMemo.set(record, { bundle: record.bundle, value });',
        '\treturn value;',
        '}',
        'function dshMobileComboCacheReport() {',
        '\tif (dshMobileComboCacheReported) return;',
        '\tdshMobileComboCacheReported = true;',
        '\tconst stats = DSH_MOBILE_COMBO_CACHE_STATS;',
        '\tconsole.log(`client-modules: combo cache (A3) state=${stats.state} entries=${stats.entries} hits=${stats.hits} misses=${stats.misses}`);',
        '}',
      ].join('\n')
      const HELPERS_ANCHOR = '/** sha1 content hash shortened to 12 hex chars (combo / graph / rebuilt-artifact rev). */'
      if (!s.includes(HELPERS_ANCHOR)) throw new Error('combo-cache 锚点未命中：shortHash JSDoc（引擎升级后请人工核对 dsh-client-modules）')
      s = s.replace(HELPERS_ANCHOR, HELPERS + '\n' + HELPERS_ANCHOR)
      const LOOP_OLD = [
        '\tfor (const record of records) {',
        '\t\tconst prepared = comboSource(record);',
        '\t\tconst section = record.sourceMap === void 0 ? identitySectionMap(prepared.source, prepared.fallbackSource) : comboSectionMap(record);',
      ].join('\n')
      const LOOP_NEW = [
        '\tfor (const record of records) {',
        '\t\tconst mobileCached = dshMobileComboCacheLookup(record); /* dsh-mobile combo cache hit (A3) */',
        '\t\tif (mobileCached !== void 0) {',
        '\t\t\tsections.push({',
        '\t\t\t\toffset: {',
        '\t\t\t\t\tline,',
        '\t\t\t\t\tcolumn: 0',
        '\t\t\t\t},',
        '\t\t\t\tmap: mobileCached.section',
        '\t\t\t});',
        '\t\t\tsource += mobileCached.source + ";\\n";',
        '\t\t\tline += mobileCached.lines;',
        '\t\t\tcontinue;',
        '\t\t}',
        '\t\tconst prepared = comboSource(record);',
        '\t\tconst section = record.sourceMap === void 0 ? identitySectionMap(prepared.source, prepared.fallbackSource) : comboSectionMap(record);',
      ].join('\n')
      if (!s.includes(LOOP_OLD)) throw new Error('combo-cache 锚点未命中：buildCombo 逐条装配循环')
      s = s.replace(LOOP_OLD, LOOP_NEW)
      const REPORT_OLD = [
        '\t\tconst batches = artifacts.map((artifact) => artifact.descriptor);',
        '\t\treturn {',
        '\t\t\trev: shortHash(JSON.stringify({',
        '\t\t\t\tentries,',
        '\t\t\t\tbatches',
        '\t\t\t})),',
        '\t\t\tentries,',
        '\t\t\tbatches',
        '\t\t};',
      ].join('\n')
      const REPORT_NEW = [
        '\t\tconst batches = artifacts.map((artifact) => artifact.descriptor);',
        '\t\tdshMobileComboCacheReport(); /* dsh-mobile combo cache report (A3) */',
        '\t\treturn {',
        '\t\t\trev: shortHash(JSON.stringify({',
        '\t\t\t\tentries,',
        '\t\t\t\tbatches',
        '\t\t\t})),',
        '\t\t\tentries,',
        '\t\t\tbatches',
        '\t\t};',
      ].join('\n')
      if (!s.includes(REPORT_OLD)) throw new Error('combo-cache 锚点未命中：compose 返回处')
      s = s.replace(REPORT_OLD, REPORT_NEW)
      if (!s.includes('dsh-mobile combo cache (A3)') || !s.includes('dsh-mobile combo cache hit (A3)') || !s.includes('dsh-mobile combo cache report (A3)')) {
        throw new Error('combo-cache 复核失败——不写回')
      }
      return s
    },
  },

  // ── combo-single-lazy-A5：单条 combo 延迟到首次被请求（0.14.1 块F P0-1，scope=engine）──
  // 背景（docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md §3.3(4) 与 §4 第 1 项，A 档设备实测）：
  // 上游 compose() 无条件遍历全表，为每条记录 buildCombo([record], rev) 产出一条「单条 combo」塞进
  // this.responses，供 /plugins/??<id>/client.js&rev=… 使用。而单条 URL 的唯一生产者是 HMR
  // invalidate()（client/system.ts:126-127 只在 reloadUrls 有值时才用单条 row.url）：设备 CDP 实测
  // boot 期浏览器只请求 2 个 /plugins/ 资源（两个批 combo），56 条单条 combo 一条都没被请求。
  // A4 已把 compose 收敛为 1 次，但这一次仍把 56 条单条产物全建出来——它是那 2 795 ms 同步块里
  // 与「首个页面请求」无关的部分。
  // 修法（不改上游语义）：compose() 只登记「单条 URL -> 记录 + 是否 map」映射（纯字符串键，无字节
  // 运算、无哈希），bundleResource() 命中单条 URL 时才 buildCombo([record], rev) 并缓存；批 combo
  // 仍按原样即时构建，notifyGraphChanged / rebuilt() 语义不变。
  // 缓存按「组合世代」失效：每次 compose() 换新的 singleResponses Map，上一代交给 previousSingle*
  // 承载——与上游 previousBatchResponses「一代覆盖竞态请求」的口径同构。
  // 陈旧字节防线：命中后仍用记录重建 artifact、用 artifact 的 URL 与请求 URL 逐字符比对，记录换
  // rev 后旧 URL 一律落 404（绝不在陈旧 rev 下交付字节）。
  'combo-single-lazy-A5': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile combo single lazy (A5)')
      && s.includes('dshMobileSingleComboResponse')
      // 关键反 no-op：compose() 里「无条件为每条记录建单条」的调用必须已消失。
      && !s.includes('const artifact = buildCombo([record], record.entry.rev);'),
    apply: (s) => {
      if (s.includes('dsh-mobile combo single lazy (A5)') && s.includes('dshMobileSingleComboResponse')) return s
      // ① 模块级探针计数：boot 期 singleBuilds=0 证明「已延迟」；请求一条后变 1 证明探针活着。
      const STATS_ANCHOR = 'const COMBO_REVISION_PLACEHOLDER = "0".repeat(HASH_REVISION_LENGTH);'
      const STATS = [
        '/* dsh-mobile combo single lazy (A5): boot composes batch combos only; a single-row',
        ' * body is built on first request (HMR invalidate() is its only producer). The counter',
        ' * is the probe surface: singleBuilds=0 at boot proves the deferral, a rise after one',
        ' * request proves the lazy path is live rather than a dead counter. */',
        'const DSH_MOBILE_COMBO_LAZY_STATS = { urls: 0, singleBuilds: 0, maxMs: 0 };',
        'Object.defineProperty(globalThis, "__dshMobileComboLazyStats", { value: DSH_MOBILE_COMBO_LAZY_STATS, configurable: true });',
      ].join('\n')
      if (!s.includes(STATS_ANCHOR)) throw new Error('combo-single-lazy 锚点未命中：COMBO_REVISION_PLACEHOLDER 常量（引擎升级后请人工核对 dsh-client-modules）')
      s = s.replace(STATS_ANCHOR, STATS_ANCHOR + '\n' + STATS)
      // ② 类字段：单条 URL 登记表 + 当/上两代响应缓存
      const FIELDS_ANCHOR = '\tpreviousBatchResponses = /* @__PURE__ */ new Map();'
      const FIELDS = [
        '\tpreviousBatchResponses = /* @__PURE__ */ new Map();',
        '\t/* dsh-mobile combo single lazy (A5): single-row URLs are registered, never built eagerly. */',
        '\tsingleRecords = /* @__PURE__ */ new Map();',
        '\tsingleResponses = /* @__PURE__ */ new Map();',
      ].join('\n')
      if (!s.includes(FIELDS_ANCHOR)) throw new Error('combo-single-lazy 锚点未命中：previousBatchResponses 类字段')
      s = s.replace(FIELDS_ANCHOR, FIELDS)
      // ③ compose()：去掉逐条 buildCombo，改为登记 URL -> 记录；世代换手。
      const COMPOSE_OLD = [
        '\t\tconst responses = new Map(batchResponses);',
        '\t\tfor (const record of this.table.values()) {',
        '\t\t\tconst artifact = buildCombo([record], record.entry.rev);',
        '\t\t\tresponses.set(artifact.url, {',
        '\t\t\t\tbody: artifact.script,',
        '\t\t\t\tcontentType: "text/javascript; charset=utf-8"',
        '\t\t\t});',
        '\t\t\tresponses.set(artifact.sourceMapUrl, {',
        '\t\t\t\tbody: artifact.sourceMap,',
        '\t\t\t\tcontentType: "application/json; charset=utf-8"',
        '\t\t\t});',
        '\t\t}',
        '\t\tthis.previousBatchResponses = this.batchResponses;',
        '\t\tthis.batchResponses = batchResponses;',
        '\t\tthis.responses = responses;',
      ].join('\n')
      const COMPOSE_NEW = [
        '\t\tconst responses = new Map(batchResponses);',
        '\t\t/* dsh-mobile combo single lazy (A5): boot requests batch combos only, so a single-row',
        '\t\t * body must not be composed here. Register the cheap URL -> record mapping instead and',
        '\t\t * compose each body on first request. A stale rev can never be served: the lazy resolver',
        '\t\t * rebuilds the artifact URL and compares it with the request before answering. */',
        '\t\tconst singleRecords = new Map();',
        '\t\tfor (const record of this.table.values()) {',
        '\t\t\tsingleRecords.set(comboUrl([record.entry.id], record.entry.rev), { record, sourceMap: false });',
        '\t\t\tsingleRecords.set(comboUrl([record.entry.id], record.entry.rev, true), { record, sourceMap: true });',
        '\t\t}',
        '\t\tthis.previousBatchResponses = this.batchResponses;',
        '\t\tthis.batchResponses = batchResponses;',
        '\t\t/* dsh-mobile combo single lazy (A5): the single-row maps are RETAINED per composition',
        '\t\t * generation only. A prior generation is deliberately NOT kept: reconcilePackage swaps',
        '\t\t * a new record object in while the old one keeps its obsolete rev, so an old URL could',
        '\t\t * otherwise be answered with superseded bytes. A URL no live record owns is a 404 —',
        '\t\t * upstream serves single-row URLs only to the HMR reload path, which always re-reads the',
        '\t\t * fresh URL from the graph. Clearing the memo also drops any body built for a URL whose',
        '\t\t * record has since been replaced. */',
        '\t\tthis.singleRecords = singleRecords;',
        '\t\tthis.singleResponses = new Map();',
        '\t\tthis.responses = responses;',
        '\t\tDSH_MOBILE_COMBO_LAZY_STATS.urls = singleRecords.size; /* registered single-row URLs, client.js + .map */',
      ].join('\n')
      if (!s.includes(COMPOSE_OLD)) throw new Error('combo-single-lazy 锚点未命中：compose() 逐条 buildCombo 循环 + 世代换手')
      s = s.replace(COMPOSE_OLD, COMPOSE_NEW)
      // ④ bundleResource()：批响应未命中时才走惰性单条解析
      const RESOURCE_OLD = '\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl);'
      const RESOURCE_NEW = '\t\tconst response = this.responses.get(resourceUrl) ?? this.previousBatchResponses.get(resourceUrl) ?? this.dshMobileSingleComboResponse(resourceUrl); /* dsh-mobile combo single lazy (A5) */'
      if (!s.includes(RESOURCE_OLD)) throw new Error('combo-single-lazy 锚点未命中：bundleResource 响应查找行')
      s = s.replace(RESOURCE_OLD, RESOURCE_NEW)
      // ⑤ 惰性解析器（同步、无 await）
      const HELPER_ANCHOR = '\tnotifyGraphChanged() {'
      const HELPER = [
        '\t/**',
        '\t* Compose one single-row combo on demand (perf A5). Boot composes batch combos only; a',
        '\t* single-row URL is fetched only after HMR invalidate(), so its body is built here on the',
        '\t* first request and memoized for the composition generation that owns the URL. A record',
        '\t* replaced by a newer revision can never answer an obsolete rev: the artifact URL is',
        '\t* rebuilt and compared before any body is served (a stale rev stays a 404, as upstream).',
        '\t* @param resourceUrl - path plus query of the requested `/plugins` resource.',
        '\t* @returns the response, or undefined when no live record owns the URL.',
        '\t*/',
        '\tdshMobileSingleComboResponse(resourceUrl) {',
        '\t\tconst memoized = this.singleResponses.get(resourceUrl);',
        '\t\tif (memoized !== void 0) return memoized;',
        '\t\tconst pending = this.singleRecords.get(resourceUrl);',
        '\t\tif (pending === void 0) return void 0;',
        '\t\tconst started = performance.now();',
        '\t\tconst artifact = buildCombo([pending.record], pending.record.entry.rev);',
        '\t\tconst artifactUrl = pending.sourceMap ? artifact.sourceMapUrl : artifact.url;',
        '\t\t/* A record whose rev moved on must not answer the URL built from the old rev. */',
        '\t\tif (artifactUrl !== resourceUrl) return void 0;',
        '\t\tDSH_MOBILE_COMBO_LAZY_STATS.singleBuilds += 1;',
        '\t\tDSH_MOBILE_COMBO_LAZY_STATS.maxMs = Math.max(DSH_MOBILE_COMBO_LAZY_STATS.maxMs, performance.now() - started);',
        '\t\tconst response = {',
        '\t\t\tbody: pending.sourceMap ? artifact.sourceMap : artifact.script,',
        '\t\t\tcontentType: pending.sourceMap ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8"',
        '\t\t};',
        '\t\tthis.singleResponses.set(resourceUrl, response);',
        '\t\treturn response;',
        '\t}',
        '\tnotifyGraphChanged() {',
      ].join('\n')
      if (!s.includes(HELPER_ANCHOR)) throw new Error('combo-single-lazy 锚点未命中：notifyGraphChanged 方法头')
      s = s.replace(HELPER_ANCHOR, HELPER)
      if (!s.includes('dsh-mobile combo single lazy (A5)')
        || !s.includes('dshMobileSingleComboResponse')
        || s.includes('const artifact = buildCombo([record], record.entry.rev);')
        || !s.includes('DSH_MOBILE_COMBO_LAZY_STATS.singleBuilds += 1;')) {
        throw new Error('combo-single-lazy 复核失败——不写回')
      }
      return s
    },
  },

  // ── combo-parallel-C3：compose 重活分片并行（K = min(2, cores-1)，0.14.1 块F P1，scope=engine）──
  // 背景（docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md §3.6(e) 与 §4 第 3 项；用户 2026-09-19
  // 拍板 C3 为 0.14.1 必做）：A4 把 compose 收敛为 1 次、A3 砍半、A5 去掉单条浪费之后，剩下的仍是
  // 一个同步块（设备实测 2 795 ms），且它落在首个页面请求路径上——把这块重活移出主线程是当前对
  // 「可对话」最大的单一杠杆。
  // 形态（硬约束逐条对应详档 §4 第 3 项）：
  //   - buildCombo 的**逐记录字节计算**（comboSource 的 utf8 解码与正则、identitySectionMap 的
  //     逐行 mappings + sourcesContent 全文、newlineCount 逐字符）分片到 worker；A3 缓存命中仍走
  //     主线程（查表极便宜，且 A3 是字节真相源）；带 sourceMap 的记录留主线程走 comboSectionMap
  //     （真实产物里 .map 已被 slim 删除，此路径实际不触发，保留只为正确性）。
  //   - **rev 分配与批拼接留主线程**：allocateInitialRevision() 未被触碰；framedHash/Buffer 拼接/
  //     JSON.stringify(sections) 全部仍在主线程执行（worker 只回传每条的 {source, lines, section}）。
  //   - 池是**启动期临时池**：每次组合过程创建、在同一过程结束的 finally 里对每个 worker 调
  //     terminate()——比「启动完成后」更严格，稳态 RSS 不驻留（预算 220 MiB）。
  //   - **正确性不依赖池**：任何异常（Worker 不可用、分片超时、worker 内抛错）都回退主线程现场生成
  //     并计数；分片失败绝不产出错误字节，也不会挂死（有分片 deadline）。
  // 步进同步用 SharedArrayBuffer + Atomics.wait：compose() 是同步函数（上游不含 await），必须同步
  // 等待分片结果。**坑**：把 Int32Array 视图放进 workerData 会被结构化克隆（worker 里 isSAB=false，
  // 计数不共享）——必须传 `.buffer` 本体（宿主实测：传视图 → 主线程永远等不到；传 buffer → 正常）。
  'combo-parallel-C3': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js',
    scope: 'engine',
    requires: ['combo-lazy-A4', 'combo-cache-A3', 'combo-single-lazy-A5'],
    check: (s) => s.includes('dsh-mobile combo parallel (C3)')
      && s.includes('dshMobileComboPrepareRecords')
      && s.includes('__dshMobileComboParallelStats')
      // 反 no-op：A3 的逐条装配循环必须已被「预准备数组 + 主线程拼接」取代。
      && !s.includes('const mobileCached = dshMobileComboCacheLookup(record);'),
    apply: (s) => {
      if (s.includes('dsh-mobile combo parallel (C3)') && s.includes('dshMobileComboPrepareRecords')) return s
      // ① 依赖导入（fixture 是 ESM：worker_threads 与 os 都要显式 import）
      const IMPORT_ANCHOR = 'import { dirname, isAbsolute, join } from "node:path";'
      const IMPORTS = [
        IMPORT_ANCHOR,
        '/* dsh-mobile combo parallel (C3): temporary shard pool for one composition pass. */',
        'import { availableParallelism } from "node:os";',
        'import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";',
      ].join('\n')
      if (!s.includes(IMPORT_ANCHOR)) throw new Error('combo-parallel 锚点未命中：node:path import 行（引擎升级后请人工核对 dsh-client-modules）')
      s = s.replace(IMPORT_ANCHOR, IMPORTS)
      // ② 模块级：walk 统计 + 常量 + worker 源码 + 分片执行器 + 预准备器
      const STATS_ANCHOR = 'Object.defineProperty(globalThis, "__dshMobileComboLazyStats", { value: DSH_MOBILE_COMBO_LAZY_STATS, configurable: true });'
      const BLOCK = [
        STATS_ANCHOR,
        '/* dsh-mobile combo parallel (C3): per-record byte computation for one composition pass is',
        ' * sharded across a temporary worker pool sized K = min(2, cores - 1). rev allocation and the',
        ' * batch concatenation stay on the main thread. The pool lives exactly one pass and every',
        ' * worker is terminated when that pass ends, so the startup cost never becomes resident memory.',
        ' * Any failure falls back to the live single-thread path for the affected records: correctness',
        ' * never depends on the pool. */',
        'const DSH_MOBILE_COMBO_PARALLEL_STATS = { workers: 0, shards: 0, records: 0, fallbackRecords: 0, terminateRequests: 0, live: 0 };',
        'Object.defineProperty(globalThis, "__dshMobileComboParallelStats", { value: DSH_MOBILE_COMBO_PARALLEL_STATS, configurable: true });',
        '/** Hard ceiling for one sharded pass: a stalled worker must never hang the sync composition. */',
        'const DSH_MOBILE_COMBO_PARALLEL_DEADLINE_MS = 20000;',
        '/** Worker body: byte-identical copy of comboSource + identitySectionMap for one record.',
        ' * Written as a real function and stringified, so worker byte math cannot drift from the',
        ' * main-thread implementation through a second hand-rolled copy. */',
        'function dshMobileComboWorkerBody() {',
        '\tconst { workerData } = require("node:worker_threads");',
        '\tconst SOURCE_MAP_TRAILER = /(?:\\r?\\n)?\\/\\/# sourceMappingURL=[^\\r\\n]*(?:\\r?\\n)?$/;',
        '\tconst SOURCE_URL_TRAILER = /(?:\\r?\\n)?\\/\\/# sourceURL=([^\\r\\n]+)(?:\\r?\\n)?$/;',
        '\tconst newlineCount = (value) => { let n = 0; for (const c of value) if (c === "\\n") n += 1; return n; };',
        '\tconst prepare = (record) => {',
        '\t\tlet source = Buffer.from(record.bundle).toString("utf8");',
        '\t\tconst sourceUrl = SOURCE_URL_TRAILER.exec(source)?.[1];',
        '\t\tsource = source.replace(SOURCE_URL_TRAILER, "").replace(SOURCE_MAP_TRAILER, "");',
        '\t\tif (!source.endsWith("\\n")) source += "\\n";',
        '\t\tconst fallbackSource = sourceUrl === void 0 ? `/plugins/${record.id}/client.js` : /^(?:[A-Za-z][A-Za-z\\d+.-]*:|\\/)/.test(sourceUrl) ? sourceUrl : `/${sourceUrl}`;',
        '\t\tconst mappings = Array.from({ length: newlineCount(source) }, (_, index) => index === 0 ? "AAAA" : "AACA").join(";");',
        '\t\treturn { source, lines: newlineCount(source + ";\\n"), section: { version: 3, names: [], sources: [fallbackSource], sourcesContent: [source], mappings } };',
        '\t};',
        '\tconst done = new Int32Array(workerData.sab);',
        '\tworkerData.port.on("message", (msg) => {',
        '\t\tlet payload;',
        '\t\ttry { payload = { parts: msg.records.map(prepare) }; }',
        '\t\tcatch (error) { payload = { error: error?.message ?? String(error) }; }',
        '\t\tworkerData.port.postMessage(payload);',
        '\t\tAtomics.add(done, 0, 1);',
        '\t\tAtomics.notify(done, 0);',
        '\t});',
        '}',
        'const DSH_MOBILE_COMBO_WORKER_SOURCE = `(${dshMobileComboWorkerBody.toString()})()`;',
        '/** K = min(2, cores - 1); DSH_MOBILE_COMBO_PARALLEL=0 forces the single-thread path (A/B tests). */',
        'function dshMobileComboWorkerCount() {',
        '\tif (process.env.DSH_MOBILE_COMBO_PARALLEL === "0") return 1;',
        '\tconst cores = typeof availableParallelism === "function" ? availableParallelism() : 1;',
        '\treturn Math.max(1, Math.min(2, cores - 1));',
        '}',
        '/**',
        '* Shard the identity-path preparation of `pending` records across a temporary worker pool.',
        '* @param records - the full record list (indexed by `pending`).',
        '* @param pending - indexes whose bytes must be prepared on this pass.',
        '* @returns parts aligned with `pending`, or undefined when the caller must use the main thread.',
        '*/',
        'function dshMobileComboRunParallel(records, pending) {',
        '\tconst k = dshMobileComboWorkerCount();',
        '\tif (k <= 1 || pending.length < 2) {',
        '\t\tDSH_MOBILE_COMBO_PARALLEL_STATS.fallbackRecords += pending.length;',
        '\t\treturn void 0;',
        '\t}',
        '\tconst parts = new Array(pending.length);',
        '\tconst pool = [];',
        '\ttry {',
        '\t\tconst shards = Array.from({ length: k }, () => []);',
        '\t\tfor (let i = 0; i < pending.length; i += 1) shards[i % k].push(i);',
        '\t\t/* pass the SharedArrayBuffer itself, never an Int32Array view: a view is structured-cloned',
        '\t\t * (losing shared memory) and the main thread would then wait forever. */',
        '\t\tconst sab = new SharedArrayBuffer(4);',
        '\t\tconst done = new Int32Array(sab);',
        '\t\tfor (let i = 0; i < shards.length; i += 1) {',
        '\t\t\tconst channel = new MessageChannel();',
        '\t\t\tconst worker = new Worker(DSH_MOBILE_COMBO_WORKER_SOURCE, { eval: true, workerData: { sab, port: channel.port2 }, transferList: [channel.port2] });',
        '\t\t\tworker.unref();',
        '\t\t\tDSH_MOBILE_COMBO_PARALLEL_STATS.workers += 1;',
        '\t\t\tDSH_MOBILE_COMBO_PARALLEL_STATS.live += 1;',
        '\t\t\tpool.push({ worker, port: channel.port1 });',
        '\t\t}',
        '\t\tfor (let i = 0; i < pool.length; i += 1) {',
        '\t\t\tpool[i].port.postMessage({ records: shards[i].map((index) => ({ id: records[index].entry.id, bundle: records[index].bundle })) });',
        '\t\t}',
        '\t\tconst deadline = Date.now() + DSH_MOBILE_COMBO_PARALLEL_DEADLINE_MS;',
        '\t\twhile (Atomics.load(done, 0) < pool.length) {',
        '\t\t\tif (Date.now() > deadline) throw new Error("a shard did not answer before the deadline");',
        '\t\t\tAtomics.wait(done, 0, Atomics.load(done, 0), 25);',
        '\t\t}',
        '\t\tfor (let i = 0; i < pool.length; i += 1) {',
        '\t\t\tconst message = receiveMessageOnPort(pool[i].port);',
        '\t\t\tif (message === void 0) throw new Error("a shard replied without an enveloped message");',
        '\t\t\tif (message.message.error !== void 0) throw new Error(message.message.error);',
        '\t\t\tconst shardParts = message.message.parts;',
        '\t\t\tif (shardParts.length !== shards[i].length) throw new Error("a shard returned the wrong number of parts");',
        '\t\t\tfor (let j = 0; j < shardParts.length; j += 1) parts[shards[i][j]] = shardParts[j];',
        '\t\t}',
        '\t\tfor (const part of parts) if (part === void 0) throw new Error("a shard left a record unprepared");',
        '\t\tDSH_MOBILE_COMBO_PARALLEL_STATS.shards += pool.length;',
        '\t\tDSH_MOBILE_COMBO_PARALLEL_STATS.records += pending.length;',
        '\t\treturn parts;',
        '\t} catch (error) {',
        '\t\tconsole.warn(`client-modules: combo parallel (C3) fell back to the main thread: ${error?.message ?? String(error)}`);',
        '\t\tDSH_MOBILE_COMBO_PARALLEL_STATS.fallbackRecords += pending.length;',
        '\t\treturn void 0;',
        '\t} finally {',
        '\t\tfor (const entry of pool) {',
        '\t\t\tDSH_MOBILE_COMBO_PARALLEL_STATS.terminateRequests += 1;',
        '\t\t\tconst settle = () => { DSH_MOBILE_COMBO_PARALLEL_STATS.live -= 1; };',
        '\t\t\ttry { Promise.resolve(entry.worker.terminate()).then(settle, settle); } catch { settle(); }',
        '\t\t}',
        '\t}',
        '}',
        '/**',
        '* Per-record pieces for one buildCombo pass. A3 cache hits are served on the main thread (the',
        '* lookup is cheap and A3 owns the byte truth); identity-path misses are sharded (C3); records',
        '* carrying a source map keep the upstream comboSectionMap path on the main thread.',
        '* @param records - records in composition order.',
        '* @returns one { source, lines, section } per record, same order.',
        '*/',
        'function dshMobileComboPrepareRecords(records) {',
        '\tconst parts = new Array(records.length);',
        '\tconst pending = [];',
        '\tfor (let i = 0; i < records.length; i += 1) {',
        '\t\tconst cached = dshMobileComboCacheLookup(records[i]); /* dsh-mobile combo cache hit (A3) */',
        '\t\tif (cached !== void 0) parts[i] = { source: cached.source, lines: cached.lines, section: cached.section };',
        '\t\telse if (records[i].sourceMap === void 0) pending.push(i);',
        '\t}',
        '\tif (pending.length > 0) {',
        '\t\tconst sharded = dshMobileComboRunParallel(records, pending);',
        '\t\tif (sharded !== void 0) for (let j = 0; j < pending.length; j += 1) parts[pending[j]] = sharded[j];',
        '\t}',
        '\tfor (let i = 0; i < records.length; i += 1) {',
        '\t\tif (parts[i] !== void 0) continue;',
        '\t\tconst prepared = comboSource(records[i]);',
        '\t\t/* Map-carrying records, and any identity record the shards did not cover (single-record',
        '\t\t * passes, fallback), take the upstream branch verbatim — identitySectionMap for the',
        '\t\t * identity path, comboSectionMap only when the record carries a map. */',
        '\t\tconst section = records[i].sourceMap === void 0 ? identitySectionMap(prepared.source, prepared.fallbackSource) : comboSectionMap(records[i]);',
        '\t\tparts[i] = { source: prepared.source, lines: newlineCount(prepared.source + ";\\n"), section };',
        '\t}',
        '\treturn parts;',
        '}',
      ].join('\n')
      if (!s.includes(STATS_ANCHOR)) throw new Error('combo-parallel 锚点未命中：A5 统计挂载行（需先施加 combo-single-lazy-A5）')
      s = s.replace(STATS_ANCHOR, BLOCK)
      // ③ buildCombo：A3 的逐条装配循环 → 预准备数组 + 主线程拼接（rev/拼接/哈希语义不变）
      const LOOP_OLD = [
        '\tfor (const record of records) {',
        '\t\tconst mobileCached = dshMobileComboCacheLookup(record); /* dsh-mobile combo cache hit (A3) */',
        '\t\tif (mobileCached !== void 0) {',
        '\t\t\tsections.push({',
        '\t\t\t\toffset: {',
        '\t\t\t\t\tline,',
        '\t\t\t\t\tcolumn: 0',
        '\t\t\t\t},',
        '\t\t\t\tmap: mobileCached.section',
        '\t\t\t});',
        '\t\t\tsource += mobileCached.source + ";\\n";',
        '\t\t\tline += mobileCached.lines;',
        '\t\t\tcontinue;',
        '\t\t}',
        '\t\tconst prepared = comboSource(record);',
        '\t\tconst section = record.sourceMap === void 0 ? identitySectionMap(prepared.source, prepared.fallbackSource) : comboSectionMap(record);',
        '\t\tsections.push({',
        '\t\t\toffset: {',
        '\t\t\t\tline,',
        '\t\t\t\tcolumn: 0',
        '\t\t\t},',
        '\t\t\tmap: section',
        '\t\t});',
        '\t\tconst bundle = `${prepared.source};\\n`;',
        '\t\tsource += bundle;',
        '\t\tline += newlineCount(bundle);',
        '\t}',
      ].join('\n')
      const LOOP_NEW = [
        '\t/* dsh-mobile combo parallel (C3): the per-record byte work is prepared (A3 lookup on the',
        '\t * main thread, identity-path misses sharded to the temporary pool), but every rev allocation,',
        '\t * buffer concatenation and hash below stays on the main thread exactly as upstream. */',
        '\tconst dshMobileParts = dshMobileComboPrepareRecords(records);',
        '\tfor (let dshMobileIndex = 0; dshMobileIndex < records.length; dshMobileIndex += 1) {',
        '\t\tconst mobilePart = dshMobileParts[dshMobileIndex];',
        '\t\tsections.push({',
        '\t\t\toffset: {',
        '\t\t\t\tline,',
        '\t\t\t\tcolumn: 0',
        '\t\t\t},',
        '\t\t\tmap: mobilePart.section',
        '\t\t});',
        '\t\tsource += mobilePart.source + ";\\n";',
        '\t\tline += mobilePart.lines;',
        '\t}',
      ].join('\n')
      if (!s.includes(LOOP_OLD)) throw new Error('combo-parallel 锚点未命中：buildCombo 的 A3 逐条装配循环（需先施加 combo-cache-A3）')
      s = s.replace(LOOP_OLD, LOOP_NEW)
      if (!s.includes('dsh-mobile combo parallel (C3)')
        || !s.includes('dshMobileComboPrepareRecords')
        || !s.includes('__dshMobileComboParallelStats')
        || s.includes('const mobileCached = dshMobileComboCacheLookup(record);')
        || !s.includes('dshMobileParts[dshMobileIndex]')) {
        throw new Error('combo-parallel 复核失败——不写回')
      }
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
    requires: ['combo-lazy-A4', 'combo-cache-A3', 'combo-single-lazy-A5', 'combo-parallel-C3'],
    check: (s) => s.includes('dsh-mobile combo probe (P1)')
      && s.includes('dshMobileComboProbeEmit')
      && s.includes('import { isMainThread } from "node:worker_threads";')
      // 主线程门：探针块必须带 isMainThread 分支（worker 的 calls=0 不得冒充真读数）。
      && s.includes('if (!isMainThread) {')
      && s.includes('} else {'),
    apply: (s) => {
      if (s.includes('dsh-mobile combo probe (P1)') && s.includes('dshMobileComboProbeEmit')) return s
      // ① import：锚点选 node:crypto 行——A3 不碰它、C3 锚在 node:path 行，互不干扰。
      const IMPORT_ANCHOR = 'import { createHash, randomBytes } from "node:crypto";'
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
      const IMPORT_OLD = 'import { readFileSync } from "node:fs";'
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
