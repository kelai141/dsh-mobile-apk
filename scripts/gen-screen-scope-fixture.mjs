#!/usr/bin/env node
// gen-screen-scope-fixture.mjs — 跨语言屏幕范围判定 fixture 的同步器（0.14.1 审查 §8.3/§8.3b 收口）
//
// 权威源（唯一手工维护面）：
//   plugins/dsh-android-bridge/test/fixtures/screen-scope-cases.json
// 产物（机器复制，禁止手工编辑）：
//   <壳侧树>/app/src/test/resources/screen-scope/screen-scope-cases.json   （Kotlin 单测读取）
//
// 为什么必须有一份机器同步的副本：壳侧 Kotlin 单测只能读测试资源目录（classpath），而它无法
// 反向引用协调仓的插件目录——插件单测里出现的跨仓相对路径正是审查 V-M4 的缺陷形态
// （`../../../dsh-mobile-apk/app/...` 在壳仓自包含布局下恒 ENOENT，门禁结构性必红）。
// 故：权威源在插件侧、壳侧副本由本脚本生成，并由 `--check` 判「副本是否过期」。
//
// 布局无关：壳侧树按「含 app/src/test 的树」探测（协调仓布局 <根>/dsh-mobile-apk；apk 仓自包含布局 <根>），
// 与 gen-protocol-v2-fixture.mjs 同款（FX-212.6 的修法）。
//
// 用法：node scripts/gen-screen-scope-fixture.mjs [--check]
//   --check 只比对不写盘（CI/构建链可用：不一致即 exit 1，不允许壳侧真值静默过期）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const rootIdx = argv.indexOf('--root')
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : dirname(HERE)
const CHECK_ONLY = argv.includes('--check')
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')

const SOURCE = join(ROOT, 'plugins', 'dsh-android-bridge', 'test', 'fixtures', 'screen-scope-cases.json')
if (!existsSync(SOURCE)) {
  console.error('GEN-SCREEN-SCOPE-FIXTURE FAILED：缺权威源 ' + rel(SOURCE)
    + '\n  权威源在插件侧（plugins/dsh-android-bridge/test/fixtures/），不是本脚本生成的。')
  process.exit(1)
}

/** 壳侧树探测：含 app/src/test 的树（协调仓布局 <根>/dsh-mobile-apk；apk 仓自包含布局 <根>）。 */
const APK_ROOT = [join(ROOT, 'dsh-mobile-apk'), ROOT].find((d) => existsSync(join(d, 'app', 'src', 'test')))
  ?? [join(ROOT, 'dsh-mobile-apk'), ROOT].find((d) => existsSync(join(d, 'app', 'src', 'main')))

const TARGETS = [
  {
    dir: join(APK_ROOT ?? join(ROOT, 'dsh-mobile-apk'), 'app', 'src', 'test', 'resources', 'screen-scope'),
    kind: '壳侧真值（Kotlin 单测读取）',
  },
]

// 规范化：单行 JSON + 末尾换行（两侧逐字节一致才有意义；手写排版差异会造成假漂移）。
const canonical = (() => {
  const parsed = JSON.parse(readFileSync(SOURCE, 'utf8'))
  return JSON.stringify(parsed, null, 2) + '\n'
})()

let passed = 0
const failed = []
for (const { dir, kind } of TARGETS) {
  const file = join(dir, 'screen-scope-cases.json')
  if (CHECK_ONLY) {
    if (!existsSync(file)) {
      failed.push('缺' + kind + '：' + rel(file) + '（壳侧真值不允许静默过期）')
      console.log('FAIL  ' + rel(file) + '（缺席）')
      continue
    }
    const same = readFileSync(file, 'utf8') === canonical
    console.log((same ? 'PASS  ' : 'FAIL  ') + rel(file))
    if (same) passed += 1
    else failed.push('内容不一致：' + rel(file))
  } else {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, canonical)
    passed += 1
    console.log('wrote ' + rel(file))
  }
}

if (failed.length > 0) {
  console.error('GEN-SCREEN-SCOPE-FIXTURE FAILED（' + passed + '/' + TARGETS.length + '）：')
  for (const f of failed) console.error('  - ' + f)
  console.error('  修复：node scripts/gen-screen-scope-fixture.mjs（无 --check）后提交壳侧副本')
  process.exit(1)
}
console.log('GEN-SCREEN-SCOPE-FIXTURE ' + (CHECK_ONLY ? 'CHECK ' : 'WRITE ') + 'PASSED（' + passed + '/'
  + TARGETS.length + '，壳侧树=' + (APK_ROOT ? rel(APK_ROOT) : '(未找到)') + '）')
