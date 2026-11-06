// scripts/check-code-map-only-write.test.mjs — `--only --write` 的落盘原子性与写序（issue #1607）。
//
// 真因：旧实现是两次独立 `writeFileSync`（先文档、后 543 KB 基线）。两次写之间被杀 →
// 文档已是符号锚点形态、基线缺 symbolHashes → 之后每次 `symbol-unbaselined`，构建链拒打包；
// 而**重跑同一命令修不回来**（第二遍 symbolForm 直接 continue，rewrites 为空，基线原样写回）。
//
// 判据是**行为**的，不是源码切片：
//   ① 在临时副本里真跑 `--only <文件> --write`，再用**同一份门禁**复验 PASSED；
//   ② 用 `--import` 预载把「第一次落盘」变成一次自杀（模拟两次写之间被杀），
//      然后**只凭重跑同一命令**看能否收敛 —— 这正是旧实现修不回来的那条路；
//   ③ 基线截断（写一半被杀）必须解析失败，原子写落盘后必须等价可解析。
//
// 样本是自己造的：真实仓里该形态的锚点大多落在超大同名符号里推不出宿主类名（会直接判红），
// 那不是本用例要验的东西。副本里新增 `scripts/check-negctl-sample.mjs`（被 `glob:scripts/check-*.mjs`
// 覆盖，不用改覆盖账本），文档里给它一条 legacy 行号锚。
//
// 真实工作树全程只读：所有执行都在 mkdtemp 副本里（scripts/ docs/ 真复制，其余目录 junction 指回）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeAtomic } from './lib/atomic-write.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DOC_REL = 'docs/AGENTS/EXECUTION-MAP.md'
const BASELINE_REL = 'scripts/check-code-map-anchor-baseline.json'
const SAMPLE_REL = 'scripts/check-negctl-sample.mjs'
const SAMPLE_LINE = 2
const SAMPLE_SOURCE = [
  '// negctl sample: only exists inside the test copy (issue #1607 control).',
  'export function negctlSample(input) {',
  '  return String(input).trim()',
  '}',
  '',
].join('\n')
const SAMPLE_ANCHOR = '`' + SAMPLE_REL + ':' + SAMPLE_LINE + '`'

const JUNCTION_DIRS = ['app', 'plugins', 'vendor', 'webpages', 'release', 'dsh-client-ui-responsive',
  'dsh-host-web-compat', 'dsh-shell-termux', 'base', 'final-acceptance', 'qrcode', 'gradle',
  'keystore', 'LICENSES', '.github']

function copyTree(stage, rel) {
  const abs = join(ROOT, rel)
  mkdirSync(join(stage, rel), { recursive: true })
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const childRel = rel + '/' + entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      copyTree(stage, childRel)
    } else if (entry.isFile()) cpSync(join(ROOT, childRel), join(stage, childRel))
  }
}

let stage = null
before(() => {
  stage = mkdtempSync(join(tmpdir(), 'code-map-only-'))
  copyTree(stage, 'scripts')
  copyTree(stage, 'docs')
  for (const dir of JUNCTION_DIRS) {
    try { symlinkSync(join(ROOT, dir), join(stage, dir), 'junction') }
    catch { try { cpSync(join(ROOT, dir), join(stage, dir), { recursive: true }) } catch { /* 目录缺省 */ } }
  }
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile()) cpSync(join(ROOT, entry.name), join(stage, entry.name))
  }
})
after(() => { if (stage !== null) rmSync(stage, { recursive: true, force: true }) })

const run = (args, extraEnv = {}) => spawnSync(
  process.execPath, ['scripts/check-code-map.mjs', ...args],
  { cwd: stage, encoding: 'utf8', env: { ...process.env, ...extraEnv } },
)
const outOf = (r) => (r.stdout ?? '') + (r.stderr ?? '')

/** 每个用例从真实仓重置输入，再装回「样本文件 + legacy 行号锚」。 */
function resetInputs() {
  for (const rel of [DOC_REL, BASELINE_REL]) cpSync(join(ROOT, rel), join(stage, rel))
  writeFileSync(join(stage, SAMPLE_REL), SAMPLE_SOURCE)
  const abs = join(stage, DOC_REL)
  const text = readFileSync(abs, 'utf8')
  writeFileSync(abs, text + '\n' + '## 9. 负控样本（仅测试副本）' + '\n' + '## ' + '\n' + '- ' + SAMPLE_ANCHOR + '\n')
  return readFileSync(abs, 'utf8')
}

/** 预载：第一次**落到这两份文件之一**的写操作完成后立刻自杀（模拟两次写之间被杀）。 */
const KILL_PRELOAD = [
  "import fs from 'node:fs'",
  "import { syncBuiltinESMExports } from 'node:module'",
  "import { basename } from 'node:path'",
  'const targets = new Set([String(process.env.NEGCTL_DOC), String(process.env.NEGCTL_BASELINE)])',
  'let armed = true',
  'const maybeKill = (dest) => {',
  '  if (!armed) return',
  '  if (!targets.has(String(dest))) return',
  '  armed = false',
  '  process.stderr.write("[negctl] killed right after the first landing write: " + basename(String(dest)) + String.fromCharCode(10))',
  '  process.exit(137)',
  '}',
  'const w = fs.writeFileSync',
  'fs.writeFileSync = function (dest, ...rest) { const r = w.call(this, dest, ...rest); maybeKill(dest); return r }',
  'const rn = fs.renameSync',
  'fs.renameSync = function (from, to) { const r = rn.call(this, from, to); maybeKill(to); return r }',
  'syncBuiltinESMExports()',
].join('\n')

function armKill() {
  const probe = join(stage, 'scripts', '__negctl-kill.mjs')
  writeFileSync(probe, KILL_PRELOAD)
  return {
    NODE_OPTIONS: '--import ' + pathToFileURL(probe).href,
    NEGCTL_DOC: join(stage, DOC_REL),
    NEGCTL_BASELINE: join(stage, BASELINE_REL),
  }
}

test('--only --write 落盘后，同一份门禁必须当场 PASSED（基线同批写入，不留半份）', () => {
  resetInputs()
  const r = run(['--only', SAMPLE_REL, '--write'])
  assert.equal(r.status, 0, outOf(r))
  const check = run([])
  assert.equal(check.status, 0, outOf(check))
  assert.match(outOf(check), /CHECK-CODE-MAP PASSED/, outOf(check))
})

test('第一次落盘后被杀：重跑同一命令必须收敛到 PASSED（旧写序下修不回来）', () => {
  resetInputs()
  const env = armKill()
  const killed = run(['--only', SAMPLE_REL, '--write'], env)
  assert.equal(killed.status, 137, '预载必须真的在第一处落盘后杀掉进程：' + outOf(killed))
  assert.match(outOf(killed), /killed right after the first landing write/, outOf(killed))
  // 只做一件事：重跑同一命令（不 --refresh-anchor-baseline，不手工改文件）。
  const again = run(['--only', SAMPLE_REL, '--write'])
  assert.equal(again.status, 0, outOf(again))
  const check = run([])
  assert.match(outOf(check), /CHECK-CODE-MAP PASSED/, '被杀后重跑必须收敛：' + outOf(check))
})

test('写序：基线里的新键必须同时出现在文档里（半份的形态就是「只在一边」）', () => {
  const docBefore = resetInputs()
  const beforeBaseline = JSON.parse(readFileSync(join(stage, BASELINE_REL), 'utf8'))
  const r = run(['--only', SAMPLE_REL, '--write'])
  assert.equal(r.status, 0, outOf(r))
  const afterBaseline = JSON.parse(readFileSync(join(stage, BASELINE_REL), 'utf8'))
  const docNow = readFileSync(join(stage, DOC_REL), 'utf8')
  assert.notEqual(docNow, docBefore, '样本必须真的被改写（否则本用例没有判别对象）')
  const added = Object.keys(afterBaseline.symbolHashes ?? {})
    .filter((k) => !Object.hasOwn(beforeBaseline.symbolHashes ?? {}, k))
  assert.ok(added.length > 0, '本次应当新增 symbolHashes 条目')
  for (const key of added) {
    assert.ok(docNow.includes(key), '基线里的新键必须同时出现在文档里（否则就是半份）：' + key)
  }
})

test('基线写一半被杀不得留下截断 JSON（截断负控 + 原子写正控）', () => {
  resetInputs()
  const abs = join(stage, BASELINE_REL)
  const text = readFileSync(abs, 'utf8')
  writeFileSync(abs, text.slice(0, Math.floor(text.length / 2)))
  assert.throws(() => JSON.parse(readFileSync(abs, 'utf8')), '截断的基线必须解析失败')
  writeAtomic(abs, text)
  assert.deepEqual(JSON.parse(readFileSync(abs, 'utf8')), JSON.parse(text), '原子写后必须等价可解析')
})
/** 预载：**写到基线一半就死**（模拟 543 KB 基线写一半被杀）。 */
const HALF_WRITE_PRELOAD = [
  "import fs from 'node:fs'",
  "import { syncBuiltinESMExports } from 'node:module'",
  "import { StringDecoder } from 'node:string_decoder'",
  'const target = String(process.env.NEGCTL_BASELINE)',
  'let armed = true',
  'const w = fs.writeFileSync',
  'fs.writeFileSync = function (dest, bytes, ...rest) {',
  '  const p = String(dest)',
  '  if (armed && (p === target || p.startsWith(target + ".tmp-"))) {',
  '    armed = false',
  '    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8")',
  '    const half = buf.subarray(0, Math.max(1, Math.floor(buf.length / 2)))',
  '    const r = w.call(this, dest, half, ...rest)',
  '    process.exit(137)',
  '  }',
  '  return w.call(this, dest, bytes, ...rest)',
  '}',
  'syncBuiltinESMExports()',
].join('\n')

function armHalfWrite() {
  const probe = join(stage, 'scripts', '__negctl-half.mjs')
  writeFileSync(probe, HALF_WRITE_PRELOAD)
  return { NODE_OPTIONS: '--import ' + pathToFileURL(probe).href, NEGCTL_BASELINE: join(stage, BASELINE_REL) }
}

test('基线写到一半被杀：目标文件必须仍是完整可解析的旧基线（原子写正控）', () => {
  resetInputs()
  const before = readFileSync(join(stage, BASELINE_REL), 'utf8')
  const killed = run(['--only', SAMPLE_REL, '--write'], armHalfWrite())
  assert.equal(killed.status, 137, '预载必须真的在基线写到一半时杀掉进程：' + outOf(killed))
  const after = readFileSync(join(stage, BASELINE_REL), 'utf8')
  assert.equal(after, before, '基线被写了一半（不是原子写）')
  assert.doesNotThrow(() => JSON.parse(after), '下一次启动会 JSON.parse 直接崩')
  // 半截字节只能落在同目录临时文件里，绝不能被当成基线。
  const again = run(['--only', SAMPLE_REL, '--write'])
  assert.equal(again.status, 0, outOf(again))
  const check = run([])
  assert.match(outOf(check), /CHECK-CODE-MAP PASSED/, outOf(check))
})
/** 只让指定侧落盘后自杀（'doc' = 只切文档；'baseline' = 只切基线）。 */
function writeKillProbe(sides) {
  const probe = join(stage, 'scripts', '__negctl-side-' + sides.join('-') + '.mjs')
  const targets = sides.map((s) => 'String(process.env.' + (s === 'doc' ? 'NEGCTL_DOC' : 'NEGCTL_BASELINE') + ')')
  writeFileSync(probe, [
    "import fs from 'node:fs'",
    "import { syncBuiltinESMExports } from 'node:module'",
    'const targets = new Set([' + targets.join(', ') + '])',
    'let armed = true',
    'const maybeKill = (dest) => {',
    '  if (!armed || !targets.has(String(dest))) return',
    '  armed = false',
    '  process.exit(137)',
    '}',
    'const w = fs.writeFileSync',
    'fs.writeFileSync = function (dest, ...rest) { const r = w.call(this, dest, ...rest); maybeKill(dest); return r }',
    'const rn = fs.renameSync',
    'fs.renameSync = function (from, to) { const r = rn.call(this, from, to); maybeKill(to); return r }',
    'syncBuiltinESMExports()',
  ].join(String.fromCharCode(10)))
  return probe
}

test('写序：只让文档落盘后被杀，基线必须**已经**含本次新键（旧写序下这一刀留下永久半份）', () => {
  // 这条与上一条互为对照：
  //   旧写序（先文档后基线）下这一刀 = 文档已是符号锚点形态、基线缺 symbolHashes ⇒ 重跑推不出任何改写，
  //   基线永远补不上（.tmp-negctl-1607.mjs 的「写序退回」变异跑出来的就是这条红）；
  //   新写序（先基线后文档）下同一刀切在文档上时，基线早已落盘 ⇒ 剩下的半份是**能自愈的那半**。
  resetInputs()
  const docAbs = join(stage, DOC_REL)
  const baselineAbs = join(stage, BASELINE_REL)
  const beforeBaseline = JSON.parse(readFileSync(baselineAbs, 'utf8'))
  const env = {
    NODE_OPTIONS: '--import ' + pathToFileURL(writeKillProbe(['doc'])).href,
    NEGCTL_DOC: docAbs,
    NEGCTL_BASELINE: baselineAbs,
  }
  const killed = run(['--only', SAMPLE_REL, '--write'], env)
  assert.equal(killed.status, 137, '这一刀必须切在文档上：' + outOf(killed))
  const midBaseline = JSON.parse(readFileSync(baselineAbs, 'utf8'))
  const addedMid = Object.keys(midBaseline.symbolHashes ?? {})
    .filter((k) => !Object.hasOwn(beforeBaseline.symbolHashes ?? {}, k))
  assert.ok(addedMid.length > 0, '被杀时基线必须已经写进本次新键（先基线、后文档）')
  // 剩下的半份必须能自愈：重跑同一命令即收敛。
  const again = run(['--only', SAMPLE_REL, '--write'])
  assert.equal(again.status, 0, outOf(again))
  const check = run([])
  assert.match(outOf(check), /CHECK-CODE-MAP PASSED/, '半份修不回来：' + outOf(check))
})
