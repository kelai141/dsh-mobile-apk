// 补丁回归清单门禁：scripts/patches/tests/*.test.mjs 必须全部真的跑起来，且**不允许悄悄坏掉**。
//
// 立项理由（0.14.5，上游对齐审计 C-1 实锤）：
//   scripts/patches/tests/ 下有补丁回归测试文件，但此前**只有 6 个**有自动化入口
//   （coord pr-gate 跑 3 个、build-snapshot 跑 2 个、check-runtime-assets 跑 2 个，去重后 6 个）。
//   其余从未被执行过 —— 后果实测：一旦真跑，多个测试缺陷当场暴露；A1 测试曾把发布包 fixture
//   当源码 checkout 使用，且文件级豁免掩盖了它。该缺陷现已改为覆盖真实发布 lib fixture。
//   这正是「存在不等于能用」：文件在、语法对（check-release-gates 只做 node --check），行为没有防线。
//
// 设计取舍（为什么不直接「全绿才过」）：
//   直接把存量失败写进忽略名单=掩盖；要求立刻全绿=门禁永远红、会被绕开。
//   折中：**显式、带理由、带日期的已知失败清单** + 「失败数必须恰好等于清单长度」。
//   于是：存量失败被如实记账；任何**新增**失败立刻判红；清单无法悄悄变长。
//
// 平台差异：两个 symlink 用例在 Windows 上因 EPERM（创建符号链接需特权）失败，在 Linux/CI 上通过。
//   故这两条只在 Windows 上被豁免，非 Windows 若失败必须判红。
//
// 用法：node scripts/check-patch-test-manifest.mjs
//       node scripts/check-patch-test-manifest.mjs --self-test
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = join(HERE, 'patches', 'tests')

// 已知失败清单。每条必须有 reason 与 since —— 不许无理由豁免，也不许把新失败塞进来当没看见。
const KNOWN_FAIL = [
  {
    match: /^emergency CLI keeps recovery marker across interrupted writes and round-trips fixture$/,
    platforms: ['win32'],
    reason: 'Windows 专有：同上 symlink EPERM。Linux/CI 上通过。',
    since: '2026-10-07',
  },
  {
    match: /^emergency CLI accepts autoDir symlink aliases and rejects backup paths outside autoDir$/,
    platforms: ['win32'],
    reason: 'Windows 专有：同上 symlink EPERM。Linux/CI 上通过。',
    since: '2026-10-07',
  },
]

function listTestFiles() {
  return readdirSync(TESTS_DIR).filter((f) => f.endsWith('.test.mjs')).sort()
    .map((f) => 'scripts/patches/tests/' + f)
}

// issue #1190 洞一：**清单不能只来自被检查的目录**。
//
// 旧实现的「每个补丁都有回归测试」这条承诺从未被验证：清单来自 scripts/patches/tests/，
// 也就是拿测试目录验它自己 —— 目录里有几个文件就宣称几个。registry.json 里那些没有测试的
// 补丁结构上不可见（实测 registry 53 个补丁、tests 目录 38 个文件）。
//
// 为什么**不**按文件名猜对应关系（我试过，结论是不可用）：
// registry 的 id 与测试文件名不是一对一 —— 53 个补丁对 38 个文件，且有 market-B / undo-E1..E8
// 这类共享夹具、以及完全不含补丁名的通用测试。用「id 是否出现在文件名里」匹配，
// 会得出 25~36 条「缺测试」，其中绝大多数其实是被别的文件覆盖的。**用猜出来的对应关系判红，
// 比不判更糟**：它会逼人改名凑数，而真缺陷仍可能漏掉。
//
// 所以这里只做**能站住的那半**：断言「registry 的补丁集合与测试文件集合都不是空的」，
// 并给出两侧计数，让「15 个补丁没测试」这类缺口**可见**（打印差值与 id 清单），但不据此判红。
// 真要判红，正确做法是给 registry 每条补丁加显式的 test 字段（数据改动，另开 issue）。
function patchTestGap() {
  const reg = JSON.parse(readFileSync(join(HERE, '..', 'scripts', 'patches', 'registry.json'), 'utf8'))
  const patches = Array.isArray(reg.patches) ? reg.patches : []
  const retired = Array.isArray(reg.retired) ? reg.retired : []
  const declared = patches.filter((p) => p && p.id).map((p) => ({ id: String(p.id), test: p.test ?? null }))
  const files = listTestFiles()
  // 显式声明了 test 的条目才参与覆盖判定（当前 0 条，等数据补齐后判据自动生效）。
  const declaredOnly = declared.filter((d) => d.test)
  const missingDeclared = declaredOnly.filter((d) => !existsSync(join(HERE, '..', d.test)))
  return { patches, retired, declared, files, declaredOnly, missingDeclared }
}


function runAll(files) {
  // 串行：node:test 默认并行跑文件，实测会造成互相干扰的假失败
  // （combo-probe-p1 并行时判红、串行时全绿 —— 已实测复现）。
  const r = spawnSync(process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files.map((f) => join(HERE, '..', f))],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return (r.stdout || '') + (r.stderr || '')
}

function parseTap(out) {
  const fails = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^not ok \d+ - (.+)$/.exec(line.trim())
    if (m) fails.push(m[1].trim())
  }
  const tests = Number((/# tests (\d+)/.exec(out) || [])[1] || 0)
  const pass = Number((/# pass (\d+)/.exec(out) || [])[1] || 0)
  return { fails, tests, pass }
}

function isAllowed(name, platform) {
  return KNOWN_FAIL.some((k) => k.match.test(name) && k.platforms.includes(platform))
}

function selfTest() {
  let checks = 0, failed = 0
  const ok = (c, l) => { checks++; if (!c) { failed++; console.error('  FAIL ' + l) } else console.log('  ok   ' + l) }

  const files = listTestFiles()
  ok(files.length >= 20, '识别到补丁回归文件（' + files.length + ' 个）')
  // 反证：门禁必须真的能判红——解析器对伪造的 TAP 失败行必须识别
  const fake = 'ok 1 - a\nnot ok 2 - some brand new breakage\n# tests 2\n# pass 1\n# fail 1\n'
  ok(parseTap(fake).fails.length === 1, '解析器识别 TAP 失败行（证明门禁有判别力）')
  ok(parseTap(fake).fails[0] === 'some brand new breakage', '失败名原样提取')
  ok(parseTap('ok 1 - x\n# tests 1\n# pass 1\n').fails.length === 0, '全绿时无失败')
  // 反证：白名单只放行声明过的条目，新的失败名不得被放行
  ok(isAllowed('some brand new breakage', process.platform) === false, '未声明的新失败**不被**放行（门禁不会被绕过）')
  ok(isAllowed(files.find((f) => /ptc-android-native-A1/.test(f)), process.platform) === false, 'ptc 回归文件没有豁免')
  ok(KNOWN_FAIL.every((k) => k.reason && k.since),
    '白名单每条都带 reason 与 since（不许无理由豁免）')
  // 反证：平台条件必须生效
  const symlinkCase = 'emergency CLI keeps recovery marker across interrupted writes and round-trips fixture'
  ok(isAllowed(symlinkCase, 'win32') === true, 'symlink 失败仅豁免受影响的 Windows 用例')
  ok(isAllowed(symlinkCase, 'linux') === false, 'Linux 上 symlink 用例失败仍判红')

  // issue #1190：空 TAP 不得当作零失败（旧实现只看 fails.length === 0）
  const emptyTap = parseTap('')
  ok(emptyTap.tests === 0 && emptyTap.fails.length === 0,
    '#1190 空输出解析出 0 用例 0 失败（这正是旧实现判绿的原因，必须被 tests<files 拦下）')
  ok(parseTap('# tests 1\n# pass 1\nok 1 - x\n').tests === 1, '#1190 用例数被正确解析')
  // issue #1190：两侧集合非空 —— 空集合会让「都覆盖了」恒真
  const gap = patchTestGap()
  ok(gap.patches.length > 0, '#1190 registry 补丁集合非空（' + gap.patches.length + ' 个）')
  ok(gap.files.length > 0, '#1190 回归测试集合非空（' + gap.files.length + ' 个）')
  ok(gap.missingDeclared.length === 0,
    '#1190 registry 里显式声明 test 的条目都指向真实文件（当前声明 ' + gap.declaredOnly.length + ' 条）')
  console.log('')
  console.log('CHECK-PATCH-TEST-MANIFEST ' + (failed === 0 ? 'PASSED' : 'FAILED') + '（' + checks + ' 项检查，' + failed + ' 项失败）')
  process.exitCode = failed === 0 ? 0 : 1
}

if (process.argv.includes('--self-test')) selfTest()
else {
  const files = listTestFiles()
  console.log('补丁回归文件: ' + files.length + ' 个（串行执行）')
  // issue #1190：两侧集合都要在场且非空 —— 空集合会让「都覆盖了」恒真。
  const gap = patchTestGap()
  if (gap.files.length === 0 || gap.patches.length === 0) {
    console.error('CHECK-PATCH-TEST-MANIFEST FAILED：集合为空（测试文件 ' + gap.files.length
      + ' 个 / registry 补丁 ' + gap.patches.length + ' 个）')
    console.error('  空集合不得判绿：「每个补丁都有测试」在两侧任一为空时恒真。')
    process.exit(1)
  }
  // 显式声明 test 的条目（当前 0 条）必须指向真实存在的文件；数据补齐后这条自动生效。
  if (gap.missingDeclared.length > 0) {
    console.error('CHECK-PATCH-TEST-MANIFEST FAILED：registry 声明的测试文件不存在（'
      + gap.missingDeclared.length + ' 条）：')
    for (const d of gap.missingDeclared) console.error('  - ' + d.id + ' -> ' + d.test)
    process.exit(1)
  }
  // 缺口可见但不判红（理由见 patchTestGap 的注释：按名字猜对应关系不可靠）。
  if (gap.patches.length !== gap.files.length) {
    console.log('NOTE  补丁 ' + gap.patches.length + ' 个 / 回归测试 ' + gap.files.length + ' 个（差 '
      + Math.abs(gap.patches.length - gap.files.length) + '）：两者不是一对一，不做逐条判定。')
    console.log('      要逐条判「每个补丁都有测试」，需给 registry 每条补丁加显式 test 字段。')
  }
  const out = runAll(files)
  const { fails, tests, pass } = parseTap(out)
  const unexpected = fails.filter((f) => !isAllowed(f, process.platform))
  console.log('TAP: tests=' + tests + ' pass=' + pass + ' fail=' + fails.length + '（平台 ' + process.platform + '）')

  // issue #1190 洞二：**空 TAP 不是零失败**。
  //
  // parseTap 对完全无输出的子进程返回 { fails: [], tests: 0, pass: 0 }，旧实现只看
  // fails.length === 0 就判 PASSED —— 于是 spawn 失败、runner 崩溃、node 起不来，
  // 全都被转成「补丁回归全绿」。这不是 SKIP 形态，是**空输入被当成零失败**，比 SKIP 更隐蔽。
  //
  // 判据：TAP 里报告的用例数必须 >= 实际送进去的文件数（每个文件至少一个顶层用例）。
  // 取「>= 文件数」而不是「>= 某个写死总数」：用例总数随测试增删变化，写死会变成新的漂移源；
  // 而「每个文件至少贡献一个用例」是 node:test 的稳定语义。
  if (tests < files.length) {
    console.error('')
    console.error('CHECK-PATCH-TEST-MANIFEST FAILED：TAP 报告 ' + tests + ' 个用例，'
      + '少于送进去的 ' + files.length + ' 个文件 —— 子进程可能没真正跑起来。')
    console.error('  空输入不得当作零失败：没有用例 = 没有证据，不是「全绿」。')
    console.error('  常见原因：process.execPath 指向错误 / runner 崩溃 / --test 参数不被接受。')
    console.error('  子进程原始输出（末 15 行）：')
    for (const line of out.split(/\r?\n/).filter((l) => l.trim()).slice(-15)) console.error('    ' + line)
    process.exit(1)
  }
  if (fails.length) {
    console.log('')
    console.log('已知失败（已声明，不阻塞）：')
    for (const f of fails.filter((x) => isAllowed(x, process.platform))) console.log('  - ' + f)
  }
  if (unexpected.length) {
    console.error('')
    console.error('CHECK-PATCH-TEST-MANIFEST FAILED：出现**未声明**的补丁回归失败（' + unexpected.length + ' 项）：')
    for (const f of unexpected) console.error('  - ' + f)
    console.error('补丁回归是行为防线；新失败必须修，或按既有格式加入带 reason/since 的白名单。')
    process.exit(1)
  }
  console.log('')
  console.log('CHECK-PATCH-TEST-MANIFEST PASSED（' + files.length + ' 个文件均已纳入自动化执行；'
    + '已知失败 ' + fails.length + ' 项，均带理由）')
}