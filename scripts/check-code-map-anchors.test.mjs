#!/usr/bin/env node
/**
 * check-code-map 符号锚点的变异反证（三组）。
 *
 * 用法：node scripts/check-code-map-anchors.test.mjs [--repo <路径>]
 *
 * 为什么要有「变异必须真的落地」的断言：
 * 所有者实测时第一次把 `function tableRows` 当成替换目标，而实际声明是 `const tableRows =`，
 * 替换零命中、门禁自然绿 —— 差一点把机制判成「无效」。
 * 所以每条变异替换后先比对全文，与原文相同即输出 VOID 并判该反证无效，绝不把假绿算成通过。
 * 同理，门禁崩溃（SyntaxError 等）也不算判定，一律 VOID。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argRepo = process.argv.indexOf('--repo')
const ROOT = argRepo > 0 ? resolvePath(process.argv[argRepo + 1]) : join(HERE, '..')
const TARGET = ROOT + '/scripts/check-code-map.mjs'
const orig = readFileSync(TARGET, 'utf8')
const nl = orig.indexOf('\n')
const headPart = orig.slice(0, nl + 1)
const restPart = orig.slice(nl + 1)

function gate() {
  const p = spawnSync('node', ['scripts/check-code-map.mjs'], { cwd: ROOT, encoding: 'utf8' })
  const out = (p.stdout || '') + (p.stderr || '')
  const crash = /SyntaxError|ReferenceError|TypeError|ERR_UNSUPPORTED/.test(out)
  const kinds = [...new Set([...out.matchAll(/\[((?:symbol|anchor|bad)-[a-z-]+)\]/g)].map((m) => m[1]))]
  return { code: p.status, passed: /CHECK-CODE-MAP PASSED/.test(out), crash, kinds }
}

// 变异态的复原：**三条路都要覆盖**，否则中断会把仓库留在变异态（实测：杀链/Ctrl-C 后
// scripts/check-code-map.mjs 停在 `if (t === '') continue`，下一个 PR 可能把它当自己的改动提交）。
//   ① 正常/异常：run() 里的 try/finally
//   ② 信号：SIGINT / SIGTERM / SIGHUP（超时与 Ctrl-C 走这条）
//   ③ 进程退出：process.on('exit')（含 process.exit 与未捕获异常）
// SIGKILL 无法捕获，那一档只能靠人手 checkout —— 但它是唯一的残留窗口。
let dirty = false
function restore() {
  if (!dirty) return
  try { writeFileSync(TARGET, orig, 'utf8') } catch { /* 尽力复原 */ }
  dirty = false
}
process.on('exit', restore)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restore(); process.exit(130) })
}

function run(label, content, want) {
  if (content === orig) {
    console.log('  VOID  ' + label + ' —— 变异未落地（替换零命中），该反证无效')
    return false
  }
  let r
  try {
    dirty = true
    writeFileSync(TARGET, content, 'utf8')
    r = gate()
  } finally {
    restore()
  }
  if (r.crash) { console.log('  VOID  ' + label + ' —— 门禁崩溃，非判定，该反证无效'); return false }
  const ok = want === 'green' ? (r.passed && r.code === 0) : (!r.passed && r.code === 1)
  console.log((ok ? '  ok    ' : '  FAIL  ') + label + ' -> exit=' + r.code
    + (r.kinds.length ? ' [' + r.kinds.join(',') + ']' : ''))
  return ok
}

let ok = true
console.log('== 组 1：改符号名 / 改函数体 -> 必须红 ==')
const r1 = orig.replace(/tableRows/g, 'tableRowsX')
if (r1 === orig) { console.log('  VOID  tableRows 改名 —— 未命中'); ok = false }
else ok = run('tableRows -> tableRowsX（全部引用）', r1, 'red') && ok
const r2 = orig.replace(/parseDoc/g, 'parseDocX')
if (r2 === orig) { console.log('  VOID  parseDoc 改名 —— 未命中'); ok = false }
else ok = run('parseDoc -> parseDocX（全部引用）', r2, 'red') && ok
const r3 = orig.replace("if (t === '' || t.startsWith('#')) continue", "if (t === '') continue")
if (r3 === orig) { console.log('  VOID  parseDoc 体改动 —— 未命中'); ok = false }
else ok = run('parseDoc 函数体改动', r3, 'red') && ok

console.log('== 组 2：上方插行 / 加空行 / 只挪行 -> 必须绿 ==')
ok = run('shebang 后插 1 行（全文行号 +1）', headPart + '// inserted by mutation control\n' + restPart, 'green') && ok
ok = run('shebang 后插 5 个空行', headPart + '\n\n\n\n\n' + restPart, 'green') && ok
ok = run('parseDoc 上方插 3 空行', orig.replace('export function parseDoc(text) {', '\n\n\nexport function parseDoc(text) {'), 'green') && ok
ok = run('tableRows 上方插 2 行注释', orig.replace('const tableRows = (chunk) => {', '// a\n// b\nconst tableRows = (chunk) => {'), 'green') && ok

console.log('== 组 3：符号移走 + 保留同名其它符号 -> 必须红（消歧不误判）==')
const r4 = orig
  .replace('export function parseDoc(text) {', 'export function parseDocBase(text) {')
  .replace(/\bparseDoc\(/g, 'parseDocBase(')
  + '\nclass DecoyA {\n  parseDoc(x) {\n    return x\n  }\n}\n'
  + '\nclass DecoyB {\n  parseDoc(y) {\n    return y\n  }\n}\n'
ok = run('原符号移走 + 两个不同类的同名方法', r4, 'red') && ok

console.log(ok ? 'ALL 8 MUTATION CONTROLS PASSED（每条均已断言变异落地）' : 'SOME CONTROLS FAILED OR VOID')
process.exit(ok ? 0 : 1)
