// issue #1004 / #997 / #996: migrate-anchors 的三处安全阀失效.
//
// 三条的共同点: [dry-run 说成功、实际写盘后不可用] -- 所以判据必须落在能观测真实
// 行为的面上, 而不是读源码里有没有 if.
//
//   #997  --only 写在 argv[0] 时被静默忽略 -> 本该迁 8 条却迁 900+ 条 (安全阀失效)
//   #996  改写正则无边界 -> path:N 命中 path:N-M, 区间尾巴粘到 @hash 后 -> refresh 拒收
//   #1004 refresh 已写基线, 校验失败只回滚文档 -> 仓库停在红态且不能自愈
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SCRIPT = join(ROOT, 'scripts', 'migrate-anchors.mjs')

function runM(args) {
  const r = spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: ROOT, encoding: 'utf8', timeout: 180000 })
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
}

function migratable(out) {
  const m = /可迁移 (\d+) 条/.exec(out)
  return m ? Number(m[1]) : null
}

test('#997 反证: --only 写在第一个参数位必须生效 (不得静默退化成全量)', () => {
  const first = runM(['--only', 'SnapshotTransaction.kt'])
  const second = runM(['--dry-run', '--only', 'SnapshotTransaction.kt'])
  const a = migratable(first.stdout)
  const b = migratable(second.stdout)
  assert.notEqual(a, null, '--only 在首参位时必须能跑出报告; stderr=' + first.stderr.slice(0, 300))
  assert.notEqual(b, null, '--only 在次参位时必须能跑出报告')
  assert.equal(a, b, '--only 的筛选结果不得因参数位置而不同 (首参 ' + a + ' vs 次参 ' + b + ')')
})

test('#997 反证: --only 无值时必须报错, 不得静默当成全量', () => {
  const r = runM(['--only'])
  assert.notEqual(r.status, 0, '--only 缺值必须非零退出')
  assert.equal(migratable(r.stdout), null, '--only 缺值时不得跑出全量迁移报告')
})

test('#996 反证: 改写正则不得把行号区间的尾巴粘到哈希后面', () => {
  // 从被测脚本里原样提取正则后缀 -- 新旧两版都写作 new RegExp(esc + <字面量>, 'g'),
  // 所以这条提取对两版都成立, 变红只能来自**正则语义**, 不会来自 [找不到那行].
  const src = readFileSync(SCRIPT, 'utf8')
  const reLine = /new RegExp\(esc \+ (.*?), 'g'\)/.exec(src)
  assert.notEqual(reLine, null, '被测脚本里必须有那条改写正则')
  const suffix = eval(reLine[1])
  const probe = [
    'const key = "/x/SnapshotTransaction.kt:283"',
    'const target = "/x/T.kt#finish@5d74610e"',
    'const esc = key.replace(/[.*+?^$()|[\]\\]/g, "\\$&")',
    'const re = new RegExp(esc + ' + JSON.stringify(suffix) + ', "g")',
    'const input = "见 /x/SnapshotTransaction.kt:283-289 与 /x/SnapshotTransaction.kt:283 两处"',
    'process.stdout.write(input.replace(re, () => target))',
  ].join(String.fromCharCode(10))
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8' })
  const out = r.stdout || ''
  assert.doesNotMatch(out, /@5d74610e-289/, '区间尾巴不得粘到哈希后面; 实际输出: ' + out)
  assert.equal((out.match(/#finish@5d74610e/g) || []).length, 2, '两处引用都应迁移到同一符号; 实际: ' + out)
})

test('#1004 反证: rollback 必须同时还原文档与基线 (行为级: 真跑那段代码)', () => {
  // 行为判据: 把脚本里的 rollback 抽出来**真执行**一次, 观察两个文件是否都回到原状.
  // 只断言 [源码里有这行] 是结构性证据, 挡不住 [写了但没调用/调用错参数] 这类回归.
  const src = readFileSync(SCRIPT, 'utf8')
  const fn = /function rollback\(why\) \{([\s\S]*?)\n\}/.exec(src)
  // 旧版没有 rollback 函数（失败分支各写各的 writeFileSync(DOC, orig)）。此时退回到
  // 「把两个失败分支的内联语句当作 rollback 体」来跑——这样变红的原因仍是行为
  // （基线没被还原），而不是「找不到那个函数名」这种结构性理由。
  // 旧版把校验失败分支写成**单行**：if (g.status !== 0) { writeFileSync(DOC, orig); ... }
  const legacy = /if \(g\.status !== 0\) \{([\s\S]*?)process\.exit\(1\)/.exec(src)
  const body = fn ? fn[1] : (legacy ? legacy[1] : null)
  assert.notEqual(body, null, '必须能定位到失败分支的还原逻辑')
  const dir = mkdtempSync(join(tmpdir(), 'rollback-'))
  const docP = join(dir, 'doc.md')
  const baseP = join(dir, 'baseline.json')
  writeFileSync(docP, 'MIGRATED-DOC', 'utf8')
  writeFileSync(baseP, 'MIGRATED-BASELINE', 'utf8')
  const driver = [
    'import { writeFileSync } from "node:fs"',
    'const DOC = ' + JSON.stringify(docP),
    'const BASELINE = ' + JSON.stringify(baseP),
    'const orig = "ORIGINAL-DOC"',
    'const baselineOrig = "ORIGINAL-BASELINE"',
    'const why = "boom"',
    'function rollback(why) {' + body + String.fromCharCode(10) + '}',
    'rollback(why)',
    'process.stdout.write("done")',
  ].join(String.fromCharCode(10))
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8' })
  assert.equal(r.status, 0, 'rollback 必须能跑通; stderr=' + (r.stderr || '').slice(0, 300))
  assert.equal(readFileSync(docP, 'utf8'), 'ORIGINAL-DOC', 'rollback 必须还原文档')
  assert.equal(readFileSync(baseP, 'utf8'), 'ORIGINAL-BASELINE', 'rollback 必须还原基线 (否则仓库停在红态)')
})
