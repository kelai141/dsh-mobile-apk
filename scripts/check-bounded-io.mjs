#!/usr/bin/env node
// check-bounded-io.mjs — 子进程无界读 grep 门禁（0.13.8 #173）
// 缺陷：先 readText 后 waitFor 使超时失效；redirectErrorStream 下先 waitFor 后读会死锁；
// 锁内挂起升级为全局冻结。铁律：子进程输出一律走 ProcIo.readBounded。
// 命中即拒打包。双仓共用（协调仓无 Kotlin 源时自然通过）。
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(ROOT, 'app', 'src', 'main', 'java')
let files = []
try {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.kt')) files.push(full)
    }
  }
  walk(SRC)
} catch {
  console.log('SKIP  本树无 Kotlin 源（协调仓侧）')
  process.exit(0)
}

// 只对「子进程流」命中（proc/p/process 接收者）；HTTP/文件流的读有各自超时语义，不在此列。
// ProcIo.kt 本体豁免（并发排水正是其职责）。
const patterns = [
  [/\b(proc|process|p)\.inputStream\.bufferedReader\(\)\.use\s*\{\s*it\.readText\(\)\s*\}/, '裸 readText（无界，超时失效）'],
  [/\b(proc|process|p)\.inputStream\.readBytes\(\)/, '裸 readBytes（无界）'],
  [/\b(proc|process|p)\.errorStream\.bufferedReader\(\)\.use\s*\{\s*it\.readText\(\)\s*\}/, '裸 stderr readText（无界）'],
]
const bad = []
for (const f of files) {
  if (f.endsWith('ProcIo.kt')) continue
  const text = readFileSync(f, 'utf8')
  for (const [re, why] of patterns) {
    if (re.test(text)) bad.push(`${f.replace(ROOT + '\\', '').replace(ROOT + '/', '')}: ${why}`)
  }
}
if (bad.length > 0) {
  console.error('BOUNDED-IO CHECK FAILED（子进程输出必须走 ProcIo.readBounded）:')
  for (const b of bad) console.error('  ' + b)
  process.exit(1)
}
console.log('BOUNDED-IO CHECK PASSED（' + files.length + ' 个 Kotlin 文件零命中）')
