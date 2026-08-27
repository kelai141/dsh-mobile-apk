// patch-undo-mobile.mjs — dsh-undo-savepoint 0.3.8 移动端适配（幂等补丁）
//
// 背景（2026-08-23 真机测试）：undo 插件在手机上出现不适配控件——
//  ① 会话头部「撤销/恢复/快照」按钮（手机无键盘，撤销/恢复走按钮仍重复了设置页能力；
//     产品决策（用户拍板）：头部只留「快照」徽章 = 快照管理入口）
//  ② 通用设置「撤销/恢复快捷键」行（Ctrl+Alt+Z/Y 录入，手机无键盘——彻底移除）
//  ③ 全局 keydown 键盘监听（无快捷键配置后成为死监听——移除）
// 保留：头部快照徽章（打开快照管理面板）+ 设置页「快照」分区（自动兜底/保留数/清理/脱敏/目录）。
//
// 用法：node scripts/patch-undo-mobile.mjs <client.js> [--apply|--check]
//   --check（默认）：验证 5 处移除全部在场 → 退出 0；任一残留 → 退出 1（构建门禁用）
//   --apply：在原始包上应用 5 处移除（已移除则跳过），随后 --check 自验
//
// 上游基线：lire1131/dsh-undo-savepoint@0.3.8（lib/client.js 单文件补丁，字节级锚点）
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
const mode = process.argv[3] ?? '--check'
if (!file) { console.error('用法: node patch-undo-mobile.mjs <client.js> [--apply|--check]'); process.exit(2) }

const EDITS = [
  {
    name: 'E1 头部撤销/恢复/快照按钮（保留徽章）',    // 从 UndoHeader children 首个 button 起，到「快照」按钮（CameraIcon size14 + t("snapshots")）的 "})," 闭括号止
    checkAbsent: 'size: 14 }), t("snapshots")]',
    apply(src) {
      const iAnchor = src.indexOf('className: styles.btn + " " + styles.undo,')
      const iStart = src.lastIndexOf('(0, react_jsx_runtime.jsx)("button", {', iAnchor)
      const iSnap = src.indexOf('size: 14 }), t("snapshots")]')
      // 结束锚：快照按钮内容行之后的按钮级 "}),"——即下次“stat !== null（徽章）”前的最近 "}),"。
      // 注意不能对 iSnap 直接 indexOf("}),")：那会命中 CameraIcon 自身的 "14 }),"（历史 bug）。
      const iStat = src.indexOf('\t\t\t\t\tstat !== null', iSnap)
      const iEnd = src.lastIndexOf('}),', iStat) + 3
      if (iAnchor < 0 || iStart < 0 || iSnap < 0 || iStat < 0 || iEnd < 3) throw new Error('E1 锚点缺失')
      return src.slice(0, iStart) + src.slice(iEnd)
    },
  },
  {
    name: 'E2 KeyBindRow 函数区域（settings.general.item 注册组件）',
    checkAbsent: '//#region KeyBindRow (settings.general.item)',
    apply(src) {
      const iStart = src.indexOf('//#region KeyBindRow (settings.general.item)')
      if (iStart < 0) throw new Error('E2 起点缺失')
      const iEnd = src.indexOf('//#endregion', iStart)
      if (iEnd < 0) throw new Error('E2 终点缺失')
      // 区域整体 + 其后换行
      const after = src.indexOf('\n', iEnd)
      return src.slice(0, iStart) + src.slice(after + 1)
    },
  },
  {
    name: 'E3 settings.general.item 注册块（undo-keys）',
    checkAbsent: '}, KeyBindRow)));',
    apply(src) {
      const iStart = src.indexOf('// Custom shortcut settings row (General settings)')
      const iEnd = src.indexOf('}, KeyBindRow)));', iStart)
      if (iStart < 0 || iEnd < 0) throw new Error('E3 锚点缺失')
      const after = src.indexOf('\n', iEnd)
      return src.slice(0, iStart) + src.slice(after + 1)
    },
  },
  {
    name: 'E4 全局键盘监听（keydown）',
    checkAbsent: '"dsh-undo-savepoint: keyboard"',
    apply(src) {
      const iStart = src.indexOf('// Global keyboard shortcuts')
      const iEnd = src.indexOf('"dsh-undo-savepoint: keyboard"', iStart)
      if (iStart < 0 || iEnd < 0) throw new Error('E4 锚点缺失')
      const after = src.indexOf('\n', iEnd)
      return src.slice(0, iStart) + src.slice(after + 1)
    },
  },
  {
    name: 'E5 exports.KeyBindRow 导出',
    checkAbsent: 'exports.KeyBindRow',
    apply(src) {
      const iStart = src.indexOf('exports.KeyBindRow')
      if (iStart < 0) throw new Error('E5 锚点缺失')
      const after = src.indexOf('\n', iStart)
      return src.slice(0, iStart) + src.slice(after + 1)
    },
  },
  {
    name: 'E6 徽章文本裁剪（去掉相对时间，防与 Session log 重叠）',
    checkAbsent: 'relativeTime(stat.latest, t) || ""',
    apply(src) {
      const anchor = '\t\t\t\t\t\t\tstat.latest ? " · " + (relativeTime(stat.latest, t) || "") : ""'
      const a = src.indexOf(anchor)
      if (a < 0) throw new Error('E6 锚点缺失')
      const lineStart = src.lastIndexOf('\n', a)
      const lineEnd = src.indexOf('\n', a)
      return src.slice(0, lineStart) + src.slice(lineEnd)
    },
  },
  {
    name: 'E7 徽章宽度封顶（max-width + 省略号，双保险）',
    // E7 是「新增」而非「移除」：已应用 = 锚点串存在（isRemoval=false 反转判定）
    isRemoval: false,
    checkAbsent: 'gap:5px;white-space:nowrap;flex:none;max-width:30vw',
    apply(src) {
      const anchor = 'gap:5px;white-space:nowrap;flex:none}.u_badge:hover'
      const a = src.indexOf(anchor)
      if (a < 0) throw new Error('E7 锚点缺失')
      return src.slice(0, a) + 'gap:5px;white-space:nowrap;flex:none;max-width:30vw;overflow:hidden;text-overflow:ellipsis}.u_badge:hover' + src.slice(a + anchor.length)
    },
  },
]

/** 已应用判定：移除类 = 标记串不存在；新增类（isRemoval=false）= 标记串存在。 */
function isApplied(src, e) {
  const present = src.includes(e.checkAbsent)
  return e.isRemoval === false ? present : !present
}

let src = readFileSync(file, 'utf8')
if (mode === '--apply') {
  let applied = 0
  for (const e of EDITS) {
    if (isApplied(src, e)) { console.log(`[skip] ${e.name}（已应用）`); continue }
    src = e.apply(src)
    applied++
    console.log(`[ok]   ${e.name}`)
  }
  writeFileSync(file, src)
  console.log(`applied ${applied}/${EDITS.length}`)
} else if (mode === '--check') {
  const missing = EDITS.filter((e) => !isApplied(src, e))
  if (missing.length) {
    console.error(`未适配：${missing.map((m) => m.name).join('；')}`)
    process.exit(1)
  }
  console.log(`already mobile-adapted (${EDITS.length}/${EDITS.length})`)
} else {
  console.error('未知模式: ' + mode)
  process.exit(2)
}
