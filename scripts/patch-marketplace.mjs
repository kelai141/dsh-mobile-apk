#!/usr/bin/env node
/**
 * patch-marketplace.mjs — 固化 dshmarketplace-plugin@0.1.5 三项修复（幂等）。
 *
 * 修复 A（0.13.0，pre-execute 守卫，lib/index.js）：上游 tools/pre-execute listener 形如
 *   `async t => { if(非安装) return; ... }` —— 所有路径返回 undefined 且不调用 waterfall
 *   的 next()，导致 gate=undefined → 全工具执行读 `gate.kind` 崩溃（Cannot read properties
 *   of undefined (reading 'kind')）。修复：listener 改双参签名 `(t, n)` 并让每条路径
 *   `return n()`（无否决即透传）。
 *
 * 修复 B（0.13.1，安装 runner execPath 安全化，lib/index.js，issue apk#83/#89）：真机禁
 *   exec app-data ELF 时引擎经 /system/bin/linker64 回退启动 → process.execPath 被污染为
 *   linker64；市场安装 execFile(process.execPath,[bin.js,...]) 把 shebang 脚本当 ELF 加载
 *   → "bad ELF magic: 23212f75"。修复：execPath 改快照内真实 node 绝对路径。
 *   （真机 linker64 环境 modlens 端到端实测通过：200 / pnpm Done / profile 登记。）
 *
 * 修复 C（0.13.1 Phase1，不可安装条目置灰，lib/client.js）：installable:false 的条目
 *   （市场无安装命令/需凭据/仅桌面）仍渲染可点「安装」钮 → 风险确认后才 500 NO_COMMAND
 *   （2026-08-29 真机实测）。修复：卡片按钮 disabled + title 说明原因。
 *
 * 用法：node scripts/patch-marketplace.mjs <path/to/lib>（目录：index.js+client.js 双修补）
 *       或 <path/to/lib/index.js>（旧式单文件，仅 index 修复）。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'

const p = process.argv[2]
if (!p) {
  console.error('用法: node scripts/patch-marketplace.mjs <path/to/lib>')
  process.exit(2)
}
const libDir = statSync(p).isDirectory() ? p : dirname(p)
const indexPath = join(libDir, 'index.js')
const clientPath = join(libDir, 'client.js')

// ── index.js：修复 A（3 锚点）+ 修复 B（execPath）──
const FIXED_INDEX = [
  'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();',
  'if(!r)return n();',
  ')});return n()}}',
  // B：安装 runner execPath 安全化（壳 shellEnv 已注入 TERMUX__PREFIX，兜底烧写设备前缀）。
  'execPath:(process.env.TERMUX__PREFIX||"/data/data/com.dsharnessmobile.shell/files/usr")+"/bin/node"',
]
let indexChanged = 0
if (existsSync(indexPath)) {
  let t = readFileSync(indexPath, 'utf8')
  if (FIXED_INDEX.every((m) => t.includes(m))) {
    console.log('index.js: already fixed (A 3/3 + B execPath)——跳过')
  } else {
    // A-1 签名 + 首路径
    if (t.includes('function tt(){return async t=>{if(t?.tool?.name!=="dshmarketplace_install")return;')) {
      t = t.replace('function tt(){return async t=>{if(t?.tool?.name!=="dshmarketplace_install")return;', 'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();')
      indexChanged++
    } else if (t.includes('dshmarketplace_install")return;')) {
      t = t.replace('dshmarketplace_install")return;', 'dshmarketplace_install")return n();')
      indexChanged++
    }
    // A-2 fullName 空路径
    if (!t.includes('if(!r)return n();') && t.includes('if(!r)return;')) {
      t = t.replace('if(!r)return;', 'if(!r)return n();')
      indexChanged++
    }
    // A-3 尾部
    if (!t.includes(')});return n()}}') && t.includes('join(`\n`)}}')) {
      t = t.replace('join(`\n`)}}', 'join(`\n`)});return n()}}')
      indexChanged++
    }
    // B execPath 安全化
    const EXEC_OLD = 'execPath:process.execPath,cliPath:process.argv[1]'
    const EXEC_NEW = 'execPath:(process.env.TERMUX__PREFIX||"/data/data/com.dsharnessmobile.shell/files/usr")+"/bin/node",cliPath:process.argv[1]'
    if (t.includes(EXEC_OLD)) {
      t = t.replace(EXEC_OLD, EXEC_NEW)
      indexChanged++
    } else if (!t.includes(EXEC_NEW)) {
      console.error('execPath 锚点未命中且安全化形态不在场——T() 实现可能已变，请人工核对')
    }
    if (indexChanged === 0) {
      console.error('index.js: PATTERN NOT FOUND——未匹配任何已知形态；请人工检查 lib/index.js 的 tt()/T() 实现')
      const i = t.indexOf('function tt()')
      if (i >= 0) console.error(t.slice(i, i + 700))
      process.exit(1)
    }
    if (!FIXED_INDEX.every((m) => t.includes(m))) {
      console.error('index.js: 修复后复核失败（锚点缺失）——不写回，请人工检查')
      process.exit(1)
    }
    writeFileSync(indexPath, t)
    console.log(`index.js: patched ok (${indexChanged} 处替换)`)
  }
} else {
  console.error(`index.js 不存在: ${indexPath}`)
  process.exit(1)
}

// ── client.js：修复 C（不可安装条目置灰）──
const GREY_OLD = 'className:"dshm-install",disabled:n==="installing"||n==="installed",onClick:()=>a(e)'
const GREY_NEW = 'className:"dshm-install",title:e.installable===false?"该条目当前不可安装（市场无安装命令，或需凭据/仅桌面环境）":"",disabled:n==="installing"||n==="installed"||e.installable===false,onClick:()=>a(e)'
if (existsSync(clientPath)) {
  let c = readFileSync(clientPath, 'utf8')
  if (c.includes('||e.installable===false')) {
    console.log('client.js: already fixed (C 置灰在场)——跳过')
  } else if (c.includes(GREY_OLD)) {
    c = c.replace(GREY_OLD, GREY_NEW)
    if (!c.includes('||e.installable===false')) {
      console.error('client.js: 置灰复核失败——不写回')
      process.exit(1)
    }
    writeFileSync(clientPath, c)
    console.log('client.js: patched ok (C 不可安装置灰)')
  } else {
    console.error('client.js: 置灰锚点未命中——安装按钮渲染可能已变，请人工核对（不阻断打包，仅警告）')
  }
} else {
  console.warn('client.js 不存在（旧版插件布局？）——跳过 C 修复')
}
