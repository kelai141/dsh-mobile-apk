#!/usr/bin/env node
// check-protocol-v2.mjs — 控制协议 V2 往返与体积门禁（0.13.8 批 F / DESIGN-PROTOCOL-V2.md §S6）
//
// 为什么单独一个门禁：协议 V2 的收益全在**体积**与**结构自洽**上，两者都是"编译通过 + 人工看
// 一眼"发现不了的——列式化多带一个字段、广播规则失效、去重口径变宽，代码照样绿，只是回填报文
// 悄悄回到 30 KB（回到「约 150 节点即熔断」的旧世界）。这里把设计文档里的实测基线钉成断言。
//
// 断言来源：plugins/dsh-android-manage/test/protocol-v2.test.mjs（+ test/fixtures/ui-probe.*）。
// 该测试跑的是**构建产物**（lib/*.js），因此本门禁先做「lib 是否比 src 新」的时效检查，
// 过期就明确叫人重建，绝不拿旧产物判绿（假绿防线，与 0.13.7 polyfill 事件同一教训）。
//
// 退出码：0 = 通过；1 = 失败（构建链与 CI 以此拒打包/拒合并）。
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGIN = join('plugins', 'dsh-android-manage')
const LIB = join(ROOT, PLUGIN, 'lib', 'protocol-v2.js')
const TEST = join(ROOT, PLUGIN, 'test', 'protocol-v2.test.mjs')
const FIXTURES = join(ROOT, PLUGIN, 'test', 'fixtures')

const fail = (msg) => {
  console.error('CHECK-PROTOCOL-V2 FAILED：' + msg)
  process.exit(1)
}

if (!existsSync(TEST)) fail(`测试文件缺席：${TEST}`)
if (!existsSync(join(FIXTURES, 'ui-probe.xml'))) fail(`探针 fixture 缺席：${join(FIXTURES, 'ui-probe.xml')}`)
if (!existsSync(join(FIXTURES, 'ui-probe.expect.json'))) fail(`冻结基线缺席：${join(FIXTURES, 'ui-probe.expect.json')}`)
if (!existsSync(LIB)) {
  fail(`构建产物缺席：${LIB}\n  先构建：cd ${PLUGIN} && npm run build（注入链会自动构建，纯门禁场景需手动）`)
}

/** lib 时效：任一 src/*.ts 比 lib/*.js 新即视为过期（旧产物判绿 = 假绿）。 */
const newest = (dir, ext) => {
  let newestMs = 0
  let newestFile = ''
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) continue
    if (!name.endsWith(ext)) continue
    if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newestFile = name }
  }
  return { ms: newestMs, file: newestFile }
}
const srcNewest = newest(join(ROOT, PLUGIN, 'src'), '.ts')
const libNewest = newest(join(ROOT, PLUGIN, 'lib'), '.js')
if (srcNewest.ms > libNewest.ms) {
  fail(`构建产物过期：src/${srcNewest.file} 比 lib/${libNewest.file} 新\n  先构建：cd ${PLUGIN} && npm run build`)
}

// 跨语言 fixture 必须与 TS 编码器同源（壳侧 Kotlin 单测就是拿它比对的）
const gen = spawnSync(process.execPath, ['scripts/gen-protocol-v2-fixture.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' })
if (gen.status !== 0) {
  console.error((gen.stdout ?? '') + (gen.stderr ?? ''))
  fail('跨语言 fixture 与生成器不一致：重跑 node scripts/gen-protocol-v2-fixture.mjs 并提交产物')
}
console.log('PASS  跨语言 fixture 与生成器同源')

const run = spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8' })
const out = (run.stdout ?? '') + (run.stderr ?? '')
const summary = out.split('\n').filter((l) => /^ℹ (tests|pass|fail)/.test(l)).join('  ')
if (run.status !== 0) {
  console.error(out.slice(-4000))
  fail(`协议 V2 测试未通过（${summary || 'no summary'}）`)
}
console.log('PASS  协议 V2 往返 + 体积门禁' + (summary ? `（${summary}）` : ''))
console.log('CHECK-PROTOCOL-V2 PASSED')
