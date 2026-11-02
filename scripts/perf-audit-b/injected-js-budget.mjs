#!/usr/bin/env node
/**
 * B2 辅助：量出「壳侧往引擎页面注入多少字节的同步 JS」。
 *
 * 判据：dsh-host-web-compat 把多段脚本拼进 index.html 的 head，它们在页面解析期同步执行，
 * 直接占首屏主线程，所以字节数就是「首屏同步 JS 的 CPU 面」。
 *
 * 做法：静态切分 dsh-host-web-compat/lib/index.js 里的脚本常量（初值即最终注入的字符串），
 * 按 UTF-8 字节计长。不 import 模块：它 import cordis 等运行期依赖，宿主侧装载不起来，
 * 强 import 只会得到一个与被测量无关的假失败。
 *
 * 用法：node scripts/perf-audit-b/injected-js-budget.mjs <仓库根目录>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/injected-js-budget.mjs <仓库根目录>')
  process.exit(2)
}

const libPath = join(root, 'dsh-host-web-compat', 'lib', 'index.js')
const source = readFileSync(libPath, 'utf8')

/** 注入表：源文件里的 [名称, 常量名] 二元组。 */
const tableRe = new RegExp(String.raw`\[\s*['"]?([a-z0-9-]+)['"]?\s*,\s*([A-Z][A-Z0-9_]*)\s*\]`, 'g')
const wanted = new Map()
let tm
while ((tm = tableRe.exec(source)) !== null) wanted.set(tm[2], tm[1])

/** 取某个常量的字符串字面量正文（模板串 / 普通串都支持）。 */
function literalOf(name) {
  const decl = new RegExp('const ' + name + String.raw`\s*(?::\s*string)?\s*=\s*`, 'm')
  const at = decl.exec(source)
  if (at === null) return undefined
  let i = at.index + at[0].length
  const quote = source[i]
  const SQ = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const BTK = String.fromCharCode(96)
  const BSL = String.fromCharCode(92)
  if (quote !== BTK && quote !== SQ && quote !== DQ) return undefined
  i += 1
  let out = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === BSL) { out += source[i + 1] === undefined ? '' : source[i + 1]; i += 2; continue }
    if (ch === quote) break
    out += ch
    i += 1
  }
  return out
}

const segments = []
for (const pair of wanted) {
  const constName = pair[0]
  const label = pair[1]
  const body = literalOf(constName)
  if (body === undefined) continue
  segments.push({ label, constant: constName, chars: body.length, bytes: Buffer.byteLength(body, 'utf8') })
}

const composites = []
for (const name of ['POLYFILL_SCRIPT', 'STATIC_FALLBACK_SCRIPT', 'SLOT_GUARD_SCRIPT', 'BOOT_WATCHDOG_SCRIPT', 'THEME_BRIDGE_SCRIPT', 'PICKER_SCRIPT', 'CLIPBOARD_FALLBACK_SCRIPT']) {
  const body = literalOf(name)
  if (body === undefined) continue
  composites.push({ name, bytes: Buffer.byteLength(body, 'utf8') })
}

segments.sort((a, b) => b.bytes - a.bytes)
composites.sort((a, b) => b.bytes - a.bytes)
const totalBytes = segments.reduce((a, s) => a + s.bytes, 0)

const report = {
  root,
  libPath,
  method: 'static literal split of lib/index.js (module import unusable on host: imports cordis)',
  injectionTableSize: wanted.size,
  segments,
  composites,
  totals: { segments: segments.length, bytes: totalBytes, KiB: Number((totalBytes / 1024).toFixed(1)) },
}
process.stdout.write(JSON.stringify(report, null, 2) + String.fromCharCode(10))

const out = []
out.push('注入脚本常量 ' + segments.length + ' 段，合计 ' + report.totals.KiB + ' KiB')
for (const s of segments) out.push('  ' + String(s.bytes).padStart(7) + ' B  ' + s.label + '  (' + s.constant + ')')
out.push('组合串: ' + composites.map((c) => c.name + '=' + c.bytes + 'B').join(' '))
process.stderr.write(out.join(String.fromCharCode(10)) + String.fromCharCode(10))