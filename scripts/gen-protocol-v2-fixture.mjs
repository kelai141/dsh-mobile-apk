#!/usr/bin/env node
// gen-protocol-v2-fixture.mjs — 生成跨语言往返门禁的 fixture（0.13.8 批 F1b；0.13.8-b FX-212.6 修复）
//
// 产物（写进壳侧单测资源目录，两个布局各一份）：
//   canonical-rows.json  编码器**输入**行表（含零尺寸节点；跨语言的唯一真值面）
//   expected-v2.json     TS 编码器对同一输入的**输出**载荷
//
// 壳侧 Kotlin 单测读 canonical-rows.json → ControlProtocolV2.encode(...) → 与 expected-v2.json
// 逐字段比对。这条链是 C5「三通道一致」的可执行定义：两语言编码器只要有一边改规则，门禁立刻红。
//
// FX-212.6 修的两个缺陷：
//   1) 旧实现硬编码 `<root>/dsh-mobile-apk/app/src/test/resources/protocol-v2`，apk 仓自包含布局下
//      该目录不在场 → `existsSync` 过滤把它静默丢掉，**2/4 PASS 且 exit 0**（壳侧真值静默过期）；
//      现按「含 app/src/test 的树」探测壳侧真值目录，布局无关。
//   2) 缺壳侧真值时不再静默跳过，而是**失败**（Kotlin 侧 fixture 不允许过期）。
//
// 用法：node scripts/gen-protocol-v2-fixture.mjs [--check]
//   --check 只比对不写盘（CI 可用：四目标全部一致才 0，任一缺失/不一致即 1）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : dirname(HERE)
const CHECK_ONLY = argv.includes('--check')
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

const PLUGIN = join(ROOT, 'plugins', 'dsh-android-manage')
const PROBE = join(PLUGIN, 'test', 'fixtures', 'ui-probe.xml')
const PLUGIN_LIB = join(PLUGIN, 'lib')
if (!existsSync(join(PLUGIN_LIB, 'protocol-v2.js'))) {
  console.error('缺构建产物：先 cd plugins/dsh-android-manage && npm run build')
  process.exit(1)
}

/** 壳侧树探测：含 app/src/test 的树（协调仓布局 <根>/dsh-mobile-apk；apk 仓自包含布局 <根>）。 */
const APK_ROOT = [join(ROOT, 'dsh-mobile-apk'), ROOT].find((d) => existsSync(join(d, 'app', 'src', 'test')))
  ?? [join(ROOT, 'dsh-mobile-apk'), ROOT].find((d) => existsSync(join(d, 'app', 'src', 'main')))
if (!APK_ROOT && CHECK_ONLY) {
  console.error('GEN-PROTOCOL-V2-FIXTURE FAILED：找不到壳侧树（应含 app/src/test/resources 或 app/src/main）\n'
    + '  候选：' + [join(ROOT, 'dsh-mobile-apk'), ROOT].map(rel).join('、'))
  process.exit(1)
}
const SHELL_TARGET = join(APK_ROOT ?? join(ROOT, 'dsh-mobile-apk'), 'app', 'src', 'test', 'resources', 'protocol-v2')
const PLUGIN_TARGET = join(PLUGIN, 'test', 'fixtures', 'protocol-v2')
const TARGETS = [
  { dir: SHELL_TARGET, kind: '壳侧真值（Kotlin 单测读取）' },
  { dir: PLUGIN_TARGET, kind: '插件侧副本（TS 侧回归）' },
]

const require2 = createRequire(import.meta.url)
const { parseUiTreeXml } = require2(join(PLUGIN_LIB, 'ui-tree.js'))
const { rowsFromRaw, encodeV2 } = require2(join(PLUGIN_LIB, 'protocol-v2.js'))

const parsed = parseUiTreeXml(readFileSync(PROBE, 'utf8'))
const rows = rowsFromRaw(parsed.raw)
const GEN = 42
const ROT = parsed.rotation
const SCREEN = { w: 1080, h: 2400 }
const VIEW = 'all'

const canonical = { gen: GEN, rot: ROT, screen: SCREEN, view: VIEW, rows }
const expected = encodeV2(rows, VIEW, GEN, ROT, SCREEN.w, SCREEN.h)
const FILES = [['canonical-rows.json', canonical], ['expected-v2.json', expected]]

let total = 0
let passed = 0
const failed = []
for (const { dir, kind } of TARGETS) {
  if (CHECK_ONLY && !existsSync(dir)) {
    failed.push('缺' + kind + ' 目录：' + rel(dir) + '（壳侧真值不允许静默过期）')
    continue
  }
  for (const [name, payload] of FILES) {
    const file = join(dir, name)
    total += 1
    const text = JSON.stringify(payload)
    if (CHECK_ONLY) {
      if (!existsSync(file)) {
        failed.push('缺' + kind + ' 文件：' + rel(file))
        console.log('FAIL  ' + rel(file) + '（缺席）')
        continue
      }
      const same = readFileSync(file, 'utf8').trim() === text
      console.log((same ? 'PASS  ' : 'FAIL  ') + rel(file))
      if (same) passed += 1
      else failed.push('内容不一致：' + rel(file))
    } else {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, text)
      passed += 1
      console.log('wrote ' + rel(file))
    }
  }
}
if (failed.length > 0) {
  console.error('GEN-PROTOCOL-V2-FIXTURE FAILED（' + passed + '/' + total + '）：')
  for (const f of failed) console.error('  - ' + f)
  console.error('  修复：重跑 node scripts/gen-protocol-v2-fixture.mjs（无 --check）并提交两处产物')
  process.exit(1)
}
console.log('GEN-PROTOCOL-V2-FIXTURE ' + (CHECK_ONLY ? 'CHECK ' : 'WRITE ') + 'PASSED（' + passed + '/' + total + '，壳侧树=' + (APK_ROOT && rel(APK_ROOT) ? rel(APK_ROOT) : APK_ROOT ?? SHELL_TARGET) + '）')
