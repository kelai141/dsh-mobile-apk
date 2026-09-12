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

  // ── attach-durable-F2：附件持久化祖先 fsync 的 Android 守卫（2026-09-10 实测，scope=engine）──
  // 根因：attachment-local 的 ensureDurableDirectory 从 DSH_HOME 一路 fsync 到文件系统根
  // （boundary = parse(home).root），而 Android 应用私有路径的祖先 /data/user/0 对应用不可读
  // → open('/data/user/0') EACCES → 任何图片上传（session/prompt 的 image 内容）在准入阶段抛错，
  // api-proxy 兜底映射为 session/agent-busy（details.reason=EACCES open '/data/user/0'）；
  // 同一根因也是 read_image 读任何路径都报同一 EACCES 的原因（附件提交在读取之后）。
  // 不变量：打不开的祖先不再致命——上层目录由平台负责持久化。
  'attach-durable-F2': {
    file: 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js',
    scope: 'engine',
    check: (s) => s.includes('dsh-mobile durable-walk guard'),
    apply: (s) => {
      if (s.includes('dsh-mobile durable-walk guard')) return s
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
      if (!s.includes('dsh-mobile durable-walk guard')) throw new Error('attach-durable 复核失败——不写回')
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
      && (s.match(/dshMobileClaimExclusive\(/g) || []).length >= 3,
    apply: (s) => {
      if (s.includes('dsh-mobile exclusive materialize (F7)')) return s
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
      s = s.slice(0, fnIdx) + HELPERS + s.slice(fnIdx)

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
      const pubIdx = s.indexOf(PUBLISH_OLD, s.indexOf(ANCHOR_FN))
      if (pubIdx < 0) throw new Error('publish-exclusive 锚点未命中：publish 站 rename(staged, currentPath)')
      s = s.slice(0, pubIdx) + PUBLISH_NEW + s.slice(pubIdx + PUBLISH_OLD.length)

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
      if (matIdx < 0) throw new Error('publish-exclusive 锚点未命中：materialize 站 rename(tmp, finalPath)')
      s = s.slice(0, matIdx) + MAT_NEW + s.slice(matIdx + MAT_OLD.length)

      if (!s.includes('dsh-mobile exclusive publish (F7)') || !s.includes('dsh-mobile exclusive materialize (F7)')
        || (s.match(/dshMobileClaimExclusive\(/g) || []).length < 3) {
        throw new Error('publish-exclusive 复核失败——不写回')
      }
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
