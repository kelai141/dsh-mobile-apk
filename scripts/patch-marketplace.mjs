#!/usr/bin/env node
/**
 * patch-marketplace.mjs — 固化 dshmarketplace-plugin@0.1.5 pre-execute 守卫修复（幂等）。
 *
 * 背景（设备实测，见 docs/review-0.13.0-20260823.md）：
 *   上游 0.1.5 的 tools/pre-execute listener 形如 `async t => { if(非安装) return; ... }`
 *   —— 所有路径返回 undefined 且不调用 waterfall 的 next()，导致 gate=undefined →
 *   全工具执行读 `gate.kind` 崩溃（Cannot read properties of undefined (reading 'kind')）。
 *   修复：listener 改双参签名 `(t, n)` 并让每条路径 `return n()`（无否决即透传）。
 *
 * 本脚本对 lib/index.js 做字节级替换；已修复时直接退出 0（幂等，可反复执行）。
 * 用法：node scripts/patch-marketplace.mjs <path/to/lib/index.js>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const p = process.argv[2]
if (!p) {
  console.error('用法: node scripts/patch-marketplace.mjs <path/to/lib/index.js>')
  process.exit(2)
}

const s = readFileSync(p, 'utf8')

// 已修复判定：三处 return n() 全部在场（签名+首路径 / fullName 空 / 安装尾部）。
const FIXED = [
  'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();',
  'if(!r)return n();',
  ')});return n()}}',
]
if (FIXED.every((m) => s.includes(m))) {
  console.log('already fixed (3/3 return n() 路径在场)——跳过')
  process.exit(0)
}

let t = s
let changed = 0

// 1) 签名 + 首路径（同一锚点，仅 pristine 形态存在）
const SIG_OLD = 'function tt(){return async t=>{if(t?.tool?.name!=="dshmarketplace_install")return;'
const SIG_NEW = 'function tt(){return async (t,n)=>{if(t?.tool?.name!=="dshmarketplace_install")return n();'
if (t.includes(SIG_OLD)) {
  t = t.replace(SIG_OLD, SIG_NEW)
  changed++
} else if (t.includes('dshmarketplace_install")return;')) {
  // 变体签名（listener 已是 (t,n) 但首路径漏 n()）
  t = t.replace('dshmarketplace_install")return;', 'dshmarketplace_install")return n();')
  changed++
}

// 2) fullName 空路径
if (!t.includes('if(!r)return n();') && t.includes('if(!r)return;')) {
  t = t.replace('if(!r)return;', 'if(!r)return n();')
  changed++
}

// 3) 尾部（安装完成/风险提示后）
const TAIL_OLD = 'join(`\n`)})}}'
const TAIL_NEW = 'join(`\n`)});return n()}}'
if (!t.includes(')});return n()}}') && t.includes(TAIL_OLD)) {
  t = t.replace(TAIL_OLD, TAIL_NEW)
  changed++
}

if (changed === 0) {
  console.error('PATTERN NOT FOUND——未匹配任何已知形态；请人工检查 lib/index.js 的 tt() 实现')
  const i = s.indexOf('function tt()')
  if (i >= 0) console.error(s.slice(i, i + 700))
  process.exit(1)
}

// 写回前复核三锚点
const ok = FIXED.every((m) => t.includes(m))
if (!ok) {
  console.error('修复后复核失败（锚点缺失）——不写回，请人工检查')
  process.exit(1)
}
writeFileSync(p, t)
console.log(`patched ok (${changed} 处替换):`, p)
