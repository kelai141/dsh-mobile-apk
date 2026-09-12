#!/usr/bin/env node
// check-bounded-io.mjs — 子进程无界读门禁（0.13.8 #173；0.13.8-b 批 B2 FX-208.3 / FX-208.E1 扩容）
//
// 缺陷：先 readText 后 waitFor 使超时失效；redirectErrorStream 下先 waitFor 后读会死锁；
// 锁内挂起升级为全局冻结。铁律：子进程输出一律走 ProcIo.readBounded。
//
// 两处历史缺陷（本脚本同时修掉，锚点见 0.13.8 迭代文档 §3.4）：
//   1) 正则只覆盖 `proc.inputStream.bufferedReader().use { it.readText() }` 一种形态，
//      漏掉无 `.use` 的裸读（LogCollector.kt:123）——46 个 Kotlin 文件零命中 exit 0 = 假绿；
//   2) ROOT 固定为「本脚本上两级」，在协调仓根跑时指向协调仓（无 Kotlin 源）→ SKIP exit 0，
//      即「本地默认入口空转」（E-17）。现改为探测「含 app/src/main 的树」，找不到即失败。
//
// 用法：node scripts/check-bounded-io.mjs [--root <apk 仓根或协调仓根>]
//   --root  仅用于反向验证（合成夹具树）；缺省自动探测。也可用环境变量 DSH_APK_ROOT。
// 退出码：0 = 通过；1 = 命中拒绝（构建链/CI 以此拒打包/拒合并）或树定位失败。
//
// 豁免通道只有一个且必须写明理由：在命中行或上一行加注释 `bounded-io-exempt: <理由>`。
// 放宽正则而漏报比误报更危险——任何新增豁免都要在 PR 里给出理由。
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const OVERRIDE = rootIdx >= 0 ? argv[rootIdx + 1] : process.env.DSH_APK_ROOT

const hasKotlinTree = (dir) => existsSync(join(dir, 'app', 'src', 'main', 'java'))
const CANDIDATES = OVERRIDE
  ? [resolve(OVERRIDE)]
  : [ROOT, join(ROOT, 'dsh-mobile-apk'), resolve(join(ROOT, '..'))]
const APK_ROOT = CANDIDATES.find(hasKotlinTree)
if (!APK_ROOT) {
  console.error('BOUNDED-IO CHECK FAILED：找不到含 app/src/main/java 的树（协调仓布局应为 <根>/dsh-mobile-apk，'
    + 'apk 仓自包含布局应为 <根> 本身）')
  console.error('  候选：' + CANDIDATES.join('、'))
  console.error('  正确入口：在协调仓根或 dsh-mobile-apk 仓根执行本门禁（勿在别的目录跑）')
  process.exit(1)
}
const SRC = join(APK_ROOT, 'app', 'src', 'main', 'java')
console.log('APK 树: ' + (relative(ROOT, APK_ROOT) || APK_ROOT))

const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else if (name.endsWith('.kt')) files.push(full)
  }
}
walk(SRC)

// 只对「子进程/连接流」命中；HTTP 与文件流的读有各自超时语义，不在此列。
// ProcIo.kt 本体豁免（并发排水正是其职责）。
const patterns = [
  // 0.13.8-b 新增：任何接收者的 `.bufferedReader().readText()`（含缺 `.use` 的裸读）——
  // LogCollector.kt:123 的实测形态，旧正则零命中（假绿根因）。
  [/\.bufferedReader\(\)\s*\.\s*readText\(\)/, '裸 readText（无界，超时失效；未走 ProcIo.readBounded）'],
  // 0.13.8-b 新增：显式 BufferedReader(InputStreamReader(...)).readText() 形态。
  [/BufferedReader\s*\(\s*InputStreamReader\s*\([\s\S]*?\)\s*\)\s*\.\s*readText\(\)/, 'BufferedReader(InputStreamReader(..)).readText()（无界）'],
  // 既有：子进程流上的 `.use { it.readText() }` 同样无界（超时失效）。
  [/\b(proc|process|p)\.inputStream\.bufferedReader\(\)\.use\s*\{\s*it\.readText\(\)\s*\}/, '裸 readText（无界，超时失效）'],
  [/\b(proc|process|p)\.inputStream\.readBytes\(\)/, '裸 readBytes（无界）'],
  [/\b(proc|process|p)\.errorStream\.bufferedReader\(\)\.use\s*\{\s*it\.readText\(\)\s*\}/, '裸 stderr readText（无界）'],
]

const EXEMPT_MARKER = /bounded-io-exempt:\s*\S/
const bad = []
for (const f of files) {
  if (f.endsWith('ProcIo.kt')) continue
  const text = readFileSync(f, 'utf8')
  const lines = text.split(/\r?\n/)
  for (const [re, why] of patterns) {
    for (let i = 0; i < lines.length; i += 1) {
      if (!re.test(lines[i])) continue
      const ctx = (lines[i] + ' ' + (lines[i - 1] ?? '')).replace(/\/\/.*$/, '')
      if (EXEMPT_MARKER.test(lines[i]) || EXEMPT_MARKER.test(lines[i - 1] ?? '')) continue
      const rel = relative(ROOT, f).replace(/\\/g, '/')
      bad.push(`${rel}:${i + 1}: ${why}`)
      void ctx
    }
  }
}
if (bad.length > 0) {
  console.error('BOUNDED-IO CHECK FAILED（子进程/连接流输出必须走 ProcIo.readBounded）:')
  for (const b of bad) console.error('  ' + b)
  process.exit(1)
}
console.log('BOUNDED-IO CHECK PASSED（' + files.length + ' 个 Kotlin 文件零命中，树=' + APK_ROOT + '）')
