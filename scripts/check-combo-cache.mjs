#!/usr/bin/env node
// check-combo-cache.mjs — combo 预计算死缓存回流门禁（0.14.2 反向改造）
//
// 这个名字原本守的是另一件事：「快照里每条 client.js 都必须有 sha256 命中的 A3 预计算条目」
// （覆盖不全 = 启动收益被回退吞掉）。0.14.2 追上游 0.1.7-rc.1 时 A3 被**撤销**，理由不是锚点漂了，
// 而是它在 rc.1 上**净亏**（实测见 scripts/patches/registry.json 与本文件 --self-test 的口径说明）：
//   上游把 combo 载荷改成懒构造（`buildCombo` 返回 `lazyBody(...)`，`dsh-client-modules/lib/index.js`），
//   启动路径上每条 bundle 只剩 utf8 解码 + 两次正则剥离；而 A3 命中路径要先 JSON.parse 一份
//   内联了全部 source 文本的清单（55 条 / 4.6 MiB 样本 ⇒ 清单 5.09 MiB）再逐条读 .map 文件。
//   同一台机器同一批字节：上游 44 ms / A3 现形态 129 ms / 只缓存 source 的收窄形态 78 ms。
// ⇒ 预计算与 .combo-cache 目录本身现在是**产物里的死重**（多 5 MiB 要打包、传输、解包，
//   设备上还要在启动路径上解析）。本门禁因此反向外形：谁把它弄回来，就在这里判红。
//
// 三条断言：
//   1. 产物面：快照内不得出现 home/.dsh/profiles/**/.combo-cache/ 任何条目；
//   2. 链路面：构建脚本不得再调 combo-precompute，inject-all.py 不得再收 --combo-cache-delta；
//   3. 补丁面：补丁登记表里不得再有 combo-cache-A3 / combo-single-lazy-A5 / combo-parallel-C3。
//
// 用法：node scripts/check-combo-cache.mjs [<snapshot.tar.xz>] [--self-test]
// 退出码：0 = PASS（无快照时第 1 条计数 SKIP）；1 = FAIL。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { TAR } from './lib/shell.mjs'
import { stripComments } from './lib/strip-comments.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const DEAD_PATCH_IDS = ['combo-cache-A3', 'combo-single-lazy-A5', 'combo-parallel-C3']

// issue #1195 洞二：**行尾注释不能被当成调用**（假红），且不能按行首符号整行丢弃（假绿）。
//
// 旧实现按「行首是 // / # / <#」整行过滤，两种错误同时存在：
//   假红：代码行尾写一句「已撤销：本文件不再调用 combo-precompute.mjs」被判成仍在调用；
//   假绿：以 // 开头的行里若真有代码，会被整行删掉（本仓踩过的坑）。
//
// 改用共享状态机（scripts/lib/strip-comments.mjs）：只抹掉注释内容、保留代码，
// 且按引号状态走一遍，字符串里的 // 不会被误判。
const codeOnly = (text) => stripComments(text)

/**
 * 死缓存条目判定（issue #1195，两处判据共用这一份）。
 *
 * 旧条件要求路径里出现 `/.combo-cache/`（**带尾斜杠**），而缓存的自然形态可能就是一个 JSON 文件：
 * `home/.dsh/profiles/web/.combo-cache`（无尾斜杠）→ 扫不到 → 假绿。
 *
 * 改成按「路径段等于 .combo-cache」判定：既覆盖目录形态（`.../.combo-cache/x.json`），
 * 也覆盖单文件形态（`.../.combo-cache`）。用分段比较而不是裸 includes，
 * 避免 `my.combo-cache.bak` 这类名字被误判。
 *
 * @param {string} name tar 成员路径或文件路径（POSIX 分隔符）
 * @returns {boolean} 是否为死缓存条目
 */
export function isDeadCacheEntry(name) {
  // Windows 上 tar -tf 的输出带 CRLF：成员名会带尾随 \r。
  // 不先归一化，分段比较会得到 '.combo-cache\r' ≠ '.combo-cache' —— 实测到的假绿
  // （同一份 tar 在 Linux 上能判红、Windows 上不能）。
  const norm = String(name).replace(/\r/g, '').trim()
  return norm.split('/').includes('.combo-cache')
}

/** 纯判据：喂成员清单 + 构建脚本源码 + 登记表 id，返回失败列表（--self-test 直接驱动它）。 */
function audit(memberNames, buildScriptsText, registryIds) {
  const out = []
  // issue #1195 洞一：**单文件缓存也要能扫到**。
  //
  // 旧条件要求路径里出现 `/.combo-cache/`（**带尾斜杠**），而缓存的自然形态可能就是一个 JSON 文件：
  // `home/.dsh/profiles/web/.combo-cache`（无尾斜杠）→ 扫不到 → 假绿。
  // 改成按「路径段等于 .combo-cache」判定：既覆盖目录形态（`.../.combo-cache/x.json`），
  // 也覆盖单文件形态（`.../.combo-cache`）。用分段比较而不是裸 includes，
  // 避免 `my.combo-cache.bak` 这类名字被误判。
  const dead = memberNames.filter(isDeadCacheEntry)
  if (dead.length > 0) out.push(`快照内含 combo 死缓存条目 ${String(dead.length)} 个: [${dead.slice(0, 3).join(', ')}]——A3 已撤销（上游 rc.1 懒构造后预计算净亏）`)
  const code = codeOnly(buildScriptsText)
  if (/combo-precompute\.mjs/.test(code)) out.push('构建链仍在调用 combo-precompute.mjs')
  if (/--combo-cache-delta/.test(code)) out.push('inject-all 仍接受 --combo-cache-delta（死缓存的回流口）')
  for (const id of DEAD_PATCH_IDS) if (registryIds.includes(id)) out.push(`补丁登记表复活了 ${id}`)
  return out
}

if (argv.includes('--self-test')) {
  const fails = []
  const push = (label, ok, detail) => { if (!ok) fails.push(label) ; console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail)) }
  const ids = ['flock-android-F3']
  push('反证：快照含 .combo-cache 条目判红',
    audit(['home/.dsh/profiles/web/.combo-cache/client-combos.json'], '', ids).length === 1)
  push('反证：构建链调 precompute 判红',
    audit([], "run('node', [join(ROOT,'scripts','lib','combo-precompute.mjs')])", ids).length === 1)
  push('反证：inject-all 收 --combo-cache-delta 判红',
    audit([], 'elif argv[i] == "--combo-cache-delta":', ids).length === 1)
  push('反证：登记表复活 A3 判红',
    audit([], '', ['combo-cache-A3']).length === 1)
  push('反证：注释里提文件名不误判（撤销说明本身就是合法文案）',
    audit([], '// 链路面不得再调 combo-precompute.mjs\n  run(\'node\', [gate(\'check-something.mjs\')])', ids).length === 0)
  push('对照组：干净输入不判红', audit(['home/.dsh/profiles/web/package.json'], '', ids).length === 0)
  if (fails.length) { console.error(`COMBO-CACHE SELF-TEST FAILED（${fails.length} 项）`); process.exit(1) }
  console.log('COMBO-CACHE SELF-TEST PASSED')
  process.exit(0)
}

const failures = []
let skipped = 0
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

const tarArg = argv.find((a) => !a.startsWith('-'))
const autoTar = join(ROOT, '.deploy-tmp', 'snapshot-013', 'x86_64', 'snapshot.tar.xz')
const tarPath = tarArg ?? (existsSync(autoTar) ? autoTar : null)
let members = []
if (!tarArg && !existsSync(autoTar)) {
  skipped += 1
  console.log('SKIP(#' + String(skipped) + ')  产物面未核对（无快照可扫）——构建/发布链以显式 <snapshot.tar.xz> 参数强制')
} else {
  const listing = execFileSync(TAR, ['-tf', tarPath], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  // 同上：Windows tar 输出带 \r，先归一化再做任何路径判定。
  members = listing.split('\n').map((l) => l.replace(/\r/g, '').trim()).filter((l) => l.length > 0)
  // issue #1195：这条与 audit() 里的产物面判据必须用**同一份**匹配逻辑。
  // 旧实现两处各写一遍 `includes('/.combo-cache/')`，改了一处另一处仍是假绿 ——
  // 修洞一时实测到：单文件 `.../.combo-cache` 在 audit() 已能扫到，这条却仍漏。
  // 抽成 isDeadCacheEntry 后两处共用，避免再次分叉。
  const deadHere = members.filter(isDeadCacheEntry)
  check('产物面无 combo 死缓存条目（' + String(members.length) + ' 个成员已扫）',
    deadHere.length === 0,
    deadHere.slice(0, 3).join(', ') + ' —— A3 已撤销：预计算清单在 rc.1 上是净亏，见本文件头注')
}

const buildScripts = ['scripts/build-snapshot-013.mjs', 'scripts/build-apk.mjs', 'scripts/build-apk-013.ps1',
  'scripts/inject-all.py'].map((rel) => {
  const p = join(ROOT, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}).join('\n')
const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
const problems = audit(members, buildScripts, registry.patches.map((p) => p.id))
check('combo 死缓存回流判据（产物面 / 链路面 / 补丁面）', problems.length === 0, problems.join(' | '))

if (failures.length) {
  console.error(`CHECK-COMBO-CACHE FAILED（${failures.length} 项，SKIP=${String(skipped)}）`)
  process.exit(1)
}
console.log(`CHECK-COMBO-CACHE PASSED（SKIP=${String(skipped)}；combo 预计算已撤销且无回流）`)