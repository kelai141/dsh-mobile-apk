#!/usr/bin/env node
// gen-protocol-v2-fixture.mjs — 生成跨语言往返门禁的 fixture（0.13.8 批 F1b）。
//
// 产物（写进壳侧单测资源目录，两个仓各一份）：
//   canonical-rows.json  编码器**输入**行表（含零尺寸节点；跨语言的唯一真值面）
//   expected-v2.json     TS 编码器对同一输入的**输出**载荷
//
// 壳侧 Kotlin 单测读 canonical-rows.json → ControlProtocolV2.encode(...) → 与 expected-v2.json
// 逐字段比对。这条链是 C5「三通道一致」的可执行定义：两语言编码器只要有一边改规则，门禁立刻红。
//
// 用法：node scripts/gen-protocol-v2-fixture.mjs [--check]
//   --check 只比对不写盘（CI 可用：产物与生成器不一致即失败）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const CHECK_ONLY = process.argv.includes('--check')

const PROBE = join(ROOT, 'plugins', 'dsh-android-manage', 'test', 'fixtures', 'ui-probe.xml')
const PLUGIN_LIB = join(ROOT, 'plugins', 'dsh-android-manage', 'lib')
if (!existsSync(join(PLUGIN_LIB, 'protocol-v2.js'))) {
  console.error('缺构建产物：先 cd plugins/dsh-android-manage && npm run build')
  process.exit(1)
}
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

const ALL_TARGETS = [
  join(ROOT, 'dsh-mobile-apk', 'app', 'src', 'test', 'resources', 'protocol-v2'),
  join(ROOT, 'plugins', 'dsh-android-manage', 'test', 'fixtures', 'protocol-v2'),
]
// 两仓布局不同：--check 只比对本仓在场的目录（写盘时两个都建）
const TARGETS = CHECK_ONLY ? ALL_TARGETS.filter((dir) => existsSync(dir)) : ALL_TARGETS

let failed = false
for (const dir of TARGETS) {
  for (const [name, payload] of [['canonical-rows.json', canonical], ['expected-v2.json', expected]]) {
    const file = join(dir, name)
    const text = JSON.stringify(payload)
    if (CHECK_ONLY) {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const same = current.trim() === text
      console.log((same ? 'PASS  ' : 'FAIL  ') + file.replace(ROOT + '\\', '').replace(ROOT + '/', ''))
      if (!same) failed = true
    } else {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, text)
      console.log('wrote ' + file)
    }
  }
}
if (failed) {
  console.error('跨语言 fixture 与生成器不一致——请重跑本脚本（无 --check）并提交产物')
  process.exit(1)
}
