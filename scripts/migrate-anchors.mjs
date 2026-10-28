#!/usr/bin/env node
/**
 * 存量 legacy 锚点迁移助手（分批迁移用）。
 *
 * 背景：执行地图里约 1600 条锚点，多数还是旧形式 `path:line#expect=字面量`。
 * 那种形式一旦有人在源文件上方插几行，整批判红（#718/#771/#788 三次实证）。
 *
 * 设计要点：**推导逻辑不在这里，一律调 check-code-map.mjs 导出的 deriveAnchorFor**。
 * 早先版本自己复制了一份推导，同一批锚点给出 1006/614，而门禁本体给出 1349/251 ——
 * 两个答案说明必然分叉。迁移脚本只负责「出报告 + 按批写盘 + 写完自校验」。
 *
 * 用法：
 *   node scripts/migrate-anchors.mjs --dry-run
 *   node scripts/migrate-anchors.mjs --dry-run --json out.json
 *   node scripts/migrate-anchors.mjs --write --only SnapshotTransaction.kt,SnapshotFs.kt
 *
 * 幂等：已是符号形式（`path#Symbol`）的引用一律不动，重复执行结果相同。
 * 迁移后自动 `--refresh-anchor-baseline` 再校验，失败即回滚文档。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveAnchorFor, makeFsViewForMigration } from './check-code-map.mjs'

// 路径解析一律用门禁自己的 fsView：它带 PARENT 回退（协调仓）、裸名唯一性判定、
// 越界检查，与判定口径完全一致。早先自己写一份 locateFile，176 条锚点被误判成
// 「文件不存在」（它们其实在父目录里），同一批数据两个答案。

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DOC = join(ROOT, 'docs/AGENTS/EXECUTION-MAP.md')
const argv = process.argv.slice(2)
// 默认 **dry-run**；必须显式 --write 才落盘。这是硬要求：
// 迁移会改 1600 条锚点的表示形式，误触一次影响面极大。
const APPLY = argv.includes('--write') || argv.includes('--apply')
const JSON_OUT = argv.indexOf('--json') > 0 ? argv[argv.indexOf('--json') + 1] : null
const ONLY = argv.indexOf('--only') > 0
  ? new Set(argv[argv.indexOf('--only') + 1].split(',').map((s) => s.trim()).filter(Boolean))
  : null

const fsView = makeFsViewForMigration(ROOT, join(ROOT, '..'))

const text = readFileSync(DOC, 'utf8')
// 与 check-code-map.mjs 的 ANCHOR_RE 同口径：路径前不能是路径字符或 `:`
// （后者用来跳过 `coord:docs/...:12` 这类跨仓引用），否则会多算 13 条。
const RE = /(?:^|[^A-Za-z0-9_.\/:@-])((?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+[.](?:kt|kts|ts|tsx|mjs|js|py|ps1|sh|json|xml|yml|yaml|md)):([0-9]+)(?:-[0-9]+)?(#[^\s`)|]*)?/g
const report = { migratable: [], blocked: [], skipped: [] }
const rewrites = new Map()
const cache = new Map()

for (const m of text.matchAll(RE)) {
  // m[0] 含负向后顾吃掉的那个前导字符（常见是反引号），不能直接当引用原文；
  // 用捕获组重拼，保证与文档里的实际写法一致。
  const rel = m[1], lineStr = m[2], rest = m[3]
  const whole = rel + ':' + lineStr + (rest ?? '')
  // `#expect=` 不是符号锚点的一部分，是旧的期望片段写法；只有 `#Symbol` 才算「已是符号形式」。
  if (rest && rest.startsWith('#') && !rest.startsWith('#expect=')) {
    report.skipped.push({ ref: whole, reason: '已是符号形式' })
    continue
  }
  // 带 #expect 的 legacy 锚点也要迁移：@hash 已承担同样的判据职责（hash 就是该行内容的哈希），
  // 迁移后不再需要 #expect。旧 expect 值用于校验迁移前后指向同一行内容。
  const legacyExpect = rest && rest.startsWith('#expect=') ? decodeURIComponent(rest.slice(8)) : null
  // --only 支持**后缀匹配**：文档里同一个文件可能写成裸名（ShellOps.kt）
  // 或全路径（app/src/main/java/.../ShellOps.kt），只按全等匹配会漏掉一半。
  // --only 支持**双向后缀匹配**：文档里同一个文件可能写成裸名（screen-scope.ts）、
  // 相对路径（src/screen-scope.ts）或全路径（plugins/dsh-android-bridge/src/screen-scope.ts），
  // 而调用方传的也是其中某一种。只要一方是另一方以 / 分隔的后缀就算命中。
  if (ONLY && ![...ONLY].some((o) => {
    const a = rel.toLowerCase()
    const b = o.toLowerCase()
    return a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
  })) continue
  const lines = fsView.sourceLines(rel)
  if (lines === null) { report.blocked.push({ ref: whole, reason: '文件不存在或裸名多候选（不猜）' }); continue }
  const line = Number(lineStr)
  const lineText = lines[line - 1]
  if (lineText === undefined) { report.blocked.push({ ref: whole, reason: '行号越界' }); continue }
  const d = deriveAnchorFor(lines, line)
  if (!d.ok) { report.blocked.push({ ref: whole, reason: d.reason, text: lineText.trim().slice(0, 60) }); continue }
  if (legacyExpect !== null && !lineText.includes(legacyExpect)) {
    report.blocked.push({ ref: whole, reason: '旧 #expect 内容不在该行，拒绝迁移', text: lineText.trim().slice(0, 60) })
    continue
  }
  // d.symbol === null 表示「没有包围符号，只能全文唯一内容匹配」。
  // 这种情况**不能**产出 `path@hash`——那不是合法的锚点语法（缺 #Symbol 段），
  // 门禁的耦合边证据正则不认，会报「缺 path:line 或 path#Symbol 证据」（实测 index.ts）。
  // 内容锚一律保持 legacy 形式 + #expect，等人工判断是否值得迁移。
  if (d.symbol === null) {
    report.blocked.push({
      ref: whole,
      reason: '无包围符号（只能全文唯一内容匹配），保持 legacy',
      text: lineText.trim().slice(0, 60),
    })
    continue
  }
  const target = rel + '#' + d.symbol + '@' + d.hash
  report.migratable.push({ ref: whole, target, kind: d.kind, text: lineText.trim().slice(0, 60) })
  rewrites.set(rel + ':' + line, target)
}

console.log('锚点迁移' + (APPLY ? '（apply）' : '（dry-run）') + '：')
console.log('  可迁移 ' + report.migratable.length + ' 条（唯一符号 '
  + report.migratable.filter((x) => x.kind === 'symbol').length
  + ' / 消歧 ' + report.migratable.filter((x) => x.kind === 'disambiguated').length
  + ' / 内容锚 ' + report.migratable.filter((x) => x.kind === 'content').length + '）')
console.log('  不可迁移 ' + report.blocked.length + ' 条（保持 legacy，需人工）')
const byReason = {}
for (const b of report.blocked) byReason[b.reason] = (byReason[b.reason] ?? 0) + 1
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log('    ' + v + '  ' + k)
if (report.skipped.length) console.log('  已是符号形式 ' + report.skipped.length + ' 条（跳过）')

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(report, null, 2) + '\n')
  console.log('  明细已写入 ' + JSON_OUT)
}

if (!APPLY) {
  console.log('')
  console.log('  --- 不可迁移清单（前 30）---')
  for (const b of report.blocked.slice(0, 30)) console.log('    ' + b.ref + '  ' + b.reason + (b.text ? '  | ' + b.text : ''))
  if (report.blocked.length > 30) console.log('    ... 另有 ' + (report.blocked.length - 30) + ' 条')
  process.exit(0)
}

const orig = text
let out = text, replaced = 0
for (const [key, target] of rewrites) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 一并吃掉紧跟其后的 #expect=...（迁移后由 @hash 承担同样的判据职责）
  out = out.replace(new RegExp(esc + '(?:#expect=[^\`\\s)|]*)?', 'g'), () => { replaced += 1; return target })
}
writeFileSync(DOC, out)
console.log('')
console.log('  已改写 ' + replaced + ' 处')
const rf = spawnSync('node', ['scripts/check-code-map.mjs', '--refresh-anchor-baseline'], { cwd: ROOT, encoding: 'utf8' })
process.stdout.write(rf.stdout || '')
if (rf.status !== 0) {
  process.stderr.write(rf.stderr || '')
  writeFileSync(DOC, orig)
  console.error('  refresh 失败，文档已回滚')
  process.exit(1)
}
const g = spawnSync('node', ['scripts/check-code-map.mjs'], { cwd: ROOT, encoding: 'utf8' })
process.stdout.write((g.stdout || '') + (g.stderr || ''))
if (g.status !== 0) { writeFileSync(DOC, orig); console.error('  校验失败，文档已回滚'); process.exit(1) }
console.log('  迁移成功，门禁 PASSED')
