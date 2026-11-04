// replace-once-1531.test.mjs — issue #1531 回归：正则锚点也必须「恰好一处」。
//
// 缺陷形态（#1384 只修了字面量锚点）：apply-patches.mjs 里 8 处锚点走的是**正则** replace。
// `String.prototype.replace(/re/, …)` 同样只换第一处、同样不校验出现次数，于是上游 bundle 里
// 同一段代码出现两份时：只改一份 → marker 已插入 → check() 恒真 → 之后每轮 `[skip] 已应用`。
// 实锤：把 arkweb H1 的锚点复制一份，修复前 `--apply` 退出码 0、日志 `[ok] applied`，
// 而文件里仍剩 1 份未修补的原始分支。
//
// 为什么计数不能照抄 replaceOnce：它用 `source.split(before).length - 1` 数出现次数，正则喂进去
// 是把 `re.source` **当字面量**数。`\r?\n`、`[\s\S]*?`、`[ \t]*` 这些能被**模式**匹配到的文本，
// 作为 source 串在文件里出现 0 次——实测 apply-patches.mjs 的 8 处锚点 source 串全部 0 命中，
// 直接把正则交给 replaceOnce 会让每一处都抛「found 0」。所以计数必须问模式本身（全局 matchAll）。
//
// 本文件两类判据：
//   ① 判据本身（纯函数）：0/1/2 次的行为、正则元字符语义、全局计数、零宽不死循环；
//   ② 端到端：真跑 apply-patches.mjs，把锚点复制成两份 —— 必须判红退出 1，不得半补丁成功。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { replaceAtMostOnceRe, replaceOnceRe } from '../lib/replace-once.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const runner = join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs')

/** 出现次数：必须走模式的全局匹配，不能数 source 串。原有的 m/s/i/u 标志必须保留。 */
const count = (source, pattern) => {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g'
  return (source.match(new RegExp(pattern.source, flags)) || []).length
}

test('恰好一处：正常替换', () => {
  assert.equal(replaceOnceRe('aXb', /X/, 'Y'), 'aYb')
})

test('零处：抛（锚点已变，不得静默空转）', () => {
  assert.throws(() => replaceOnceRe('abc', /X/, 'Y'), /found 0/)
})

test('两处：抛（否则就是静默半补丁）', () => {
  assert.throws(() => replaceOnceRe('aXbXc', /X/, 'Y'), /found 2/)
})

test('错误信息带标签，且缺省标签印出模式原文', () => {
  assert.throws(() => replaceOnceRe('aXbXc', /X/, 'Y', 'H1 anchor'), /H1 anchor/)
  assert.throws(() => replaceOnceRe('abc', /dsh-resource:/, 'Y'), /\/dsh-resource:\//)
})

test('非 RegExp 锚点：抛（字面量请走 replaceOnce）', () => {
  assert.throws(() => replaceOnceRe('abc', 'b', 'Y'), /must be a RegExp/)
})

test('正则元字符按模式语义计数，不按 source 字面量计数', () => {
  // `\r?\n` 在 CRLF 文本里匹配 1 处；而还原成 source 串去数会得到 0 —— 这正是 #1531 的根因。
  const crlf = 'alpha\r\nbeta\r\n'
  assert.equal(count(crlf, /\r?\n/g), 2, '模式语义下两行都算')
  assert.equal(crlf.split('\\r?\\n').length - 1, 0, 'source 串字面量出现 0 次（旧判据看不到锚点）')
  // 恰好一处的跨行锚点：模式命中，source 串不命中 —— 旧写法会误抛 found 0。
  const once = 'x\r\ny'
  assert.equal(replaceOnceRe(once, /x\r?\ny/, 'Z'), 'Z')
})

test('正则元字符不误匹配：转义点号只匹配点号', () => {
  // `overrides.autoDir` 若漏转义，点号会匹配任意字符 —— 那会把 `overrides_autoDir` 也算命中。
  const escaped = /overrides\.autoDir/
  assert.equal(count('overrides.autoDir', escaped), 1)
  assert.equal(count('overrides_autoDir', escaped), 0, '转义点号不得匹配下划线')
  assert.equal(count('overridesXautoDir', escaped), 0, '转义点号不得匹配任意字符')
  // 惰性量词不得跨过第一个终止符去匹配更远的一处。
  const lazy = /\[start\][\s\S]*?\[end\]/
  const twice = '[start]a[end] [start]b[end]'
  assert.equal(count(twice, lazy), 2, '两段都要计入：惰性不影响全局计数')
  assert.throws(() => replaceOnceRe(twice, lazy, '[X]'), /found 2/, '两处必须判红，不得只换第一处')
  assert.equal(replaceOnceRe('[start]only[end]', lazy, '[X]'), '[X]', '恰一处时正常替换')
  // 字符类与锚定的组合：`[ \t]*` 只吃空格与制表符，`^` 未加 m 时只锚串首。
  const indented = 'head\n    return x'
  assert.equal(count(indented, /^[ \t]*return/), 0, '未加 m 时 ^ 只锚串首，第二行不算')
  assert.equal(count(indented, /^[ \t]*return/m), 1, '加了 m 才逐行锚定')
  assert.equal(count('head\n\treturn x', /^[ \t]*return/m), 1, '制表符也在字符类里')
  assert.equal(count('head\n  X  return x', /^[ \t]*return/m), 0, '非空白字符挡住锚点')
})

test('重复出现必须靠模式计数判定：同一段文本出现两份', () => {
  const block = 'if (parsed.protocol !== \`dsh-resource:\`) return void 0;'
  const once = 'head\n' + block + '\ntail'
  const twice = 'head\n' + block + '\n' + block + '\ntail'
  assert.equal(replaceOnceRe(once, /if \(parsed\.protocol !== \`dsh-resource:\`\) return void 0;/, 'FIXED'), 'head\nFIXED\ntail')
  assert.throws(() => replaceOnceRe(twice, /if \(parsed\.protocol !== \`dsh-resource:\`\) return void 0;/, 'FIXED'), /found 2/)
})

test('带 g 标志的锚点照常工作，且不污染调用方的 lastIndex', () => {
  const pattern = /X/g
  pattern.lastIndex = 7
  assert.equal(replaceOnceRe('aXb', pattern, 'Y'), 'aYb', '带 g 的单处锚点照常替换（不受 lastIndex 影响）')
  assert.equal(pattern.lastIndex, 7, '调用方的 lastIndex 不得被改动')
  assert.throws(() => replaceOnceRe('aXbXc', pattern, 'Y'), /found 2/, '带 g 也照样数得出两处')
})

test('零宽模式不得死循环', () => {
  assert.equal(replaceOnceRe('abc', /(?=b)/, 'X'), 'aXbc')
  // `(?=)` 在长度 3 的串里有 4 个位置（含串尾）：计数必须是确定的 4，而不是挂死。
  assert.throws(() => replaceOnceRe('abc', /(?=)/, 'X'), /found 4/, '零宽也有确定计数，不是挂死')
})

test('replaceAtMostOnceRe：0 次不动、1 次替换、2 次仍抛', () => {
  // 升级型正则锚点：新形态文件里锚点本来就不存在（例如 node:path 的短 import），0 次合法。
  assert.equal(replaceAtMostOnceRe('abc', /X/, 'Y'), 'abc')
  assert.equal(replaceAtMostOnceRe('aXb', /X/, 'Y'), 'aYb')
  assert.throws(() => replaceAtMostOnceRe('aXbXc', /X/, 'Y'), /found 2/)
  assert.throws(() => replaceAtMostOnceRe('abc', 'X', 'Y'), /must be a RegExp/)
})

// ── 端到端：把被迁移的锚点复制成两份，apply 必须判红 ────────────────────────────────

/** 造一棵只有目标包的临时树，返回 { root, file }。 */
function scratchPackage(rootPkgDir, packageName, source) {
  const root = mkdtempSync(join(tmpdir(), 'replace-once-1531-'))
  const dir = join(root, rootPkgDir)
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: packageName, type: 'module' }))
  writeFileSync(join(dir, 'lib', 'client.js'), source)
  return { root, file: join(dir, 'lib', 'client.js') }
}

const H1_TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-resources'
const H1_ANCHOR = /(if \(parsed\.protocol !== \`dsh-resource:\`\) return void 0;)(\r?\n)([ \t]*)return parsed\.hostname === "" \? void 0 : parsed\.hostname\.toLowerCase\(\);/

/** 上游原始字节（版本化夹具，不在此写死版本）。 */
function h1Source() {
  const p = versionedFixture('dsh-client-resources', 'lib', 'client.js')
  if (!existsSync(p)) throw new Error('夹具缺席: ' + p)
  return readFileSync(p, 'utf8')
}

const runPatch = (root, only, scope) => spawnSync(process.execPath,
  [runner, root, '--apply', '--only', only, '--scope', scope], { encoding: 'utf8' })

test('H1 锚点恰一处：正常施加，原始分支被替换（正控）', () => {
  const source = h1Source()
  assert.equal(count(source, H1_ANCHOR), 1, '上游夹具里该锚点必须恰好一处，否则本用例失去意义')
  const { root, file } = scratchPackage(H1_TARGET, '@deepseek-ai/dsh-client-resources', source)
  try {
    const r = runPatch(root, 'arkweb-resource-protocol-H1', 'engine')
    assert.equal(r.status, 0, '恰一处时应当成功：' + (r.stdout || '') + (r.stderr || ''))
    const after = readFileSync(file, 'utf8')
    assert.equal(count(after, H1_ANCHOR), 0, '原始分支应被整段替换掉')
    assert.match(after, /dsh-mobile ArkWeb resource authority fallback \(H1\)/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('H1 锚点两处：apply 必须判红退出 1，不得半补丁成功（负控，issue #1531 本体）', () => {
  const source = h1Source()
  const m = H1_ANCHOR.exec(source)
  assert.ok(m !== null, '上游夹具里该锚点必须存在')
  // 用**模式匹配到的原文**复制，EOL 与缩进因此与原文件一致。
  const duplicated = source.replace(m[0], m[0] + (m[2] || '\n') + m[0])
  assert.equal(count(duplicated, H1_ANCHOR), 2, '夹具构造失败：复制后应有两处')
  const { root, file } = scratchPackage(H1_TARGET, '@deepseek-ai/dsh-client-resources', duplicated)
  try {
    const r = runPatch(root, 'arkweb-resource-protocol-H1', 'engine')
    assert.equal(r.status, 1, '两处锚点必须判红；实得 status=' + String(r.status)
      + '\nstdout: ' + (r.stdout || '') + '\nstderr: ' + (r.stderr || ''))
    assert.match((r.stderr || ''), /found 2/, '诊断必须说清是「出现两次」')
    assert.match((r.stderr || ''), /arkweb-resource-protocol/, '诊断必须点名是哪条锚点')
    // 不得留下半补丁：文件必须逐字节保持施加前的样子（失败即不写回）。
    assert.equal(readFileSync(file, 'utf8'), duplicated, '锚点两处时必须拒绝写回，不能只改一处')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
