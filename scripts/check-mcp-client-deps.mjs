#!/usr/bin/env node
// check-mcp-client-deps.mjs — MCP client 运行期依赖在快照内可解析（0.14.2-fx-2 H-1）
//
// 真因（真实用户诊断包，Xiaomi M610BB / Android 37 / arm64 / 0.14.2-fx-1 vc42）：
//   issue存图/20260927-173254-engine-died-during-boot/engine.log:138（6 个世代全同）：
//     dsh: fatal uncaught exception: Error: dsh: plugin tree failed to load: failed to apply
//     loader entry include (cordis:include): failed to import loader entry mcp-lark
//     (@deepseek-ai/dsh-mcp-client): Cannot find package '@modelcontextprotocol/client'
//   ⇒ 引擎 boot 阶段硬崩、exit=1，用户看见的是「引擎起不来」。
//
// 为什么既有的 check-engine-overlay 正向闭包没拦住它（这是本门禁存在的理由）：
//   那条判据只对**行面**（快照内三份 cordis.patch.yml 声明的挂载点）问责——
//   「不在行面上的包缺依赖不影响 boot，判红是假红」。而 `@deepseek-ai/dsh-mcp-client`
//   **不在我们装配的行面上**（profile-web.cordis.patch.yml 零 mcp 条目）：它是**用户自己**
//   在 profile 里挂的 entry（用官方 MCP 客户端连自己的 server）。
//   ⇒ 该缺口落在正向闭包的**定义域之外**，本地门禁结构性全绿，设备上必崩。
//
// 判据（不依赖行面、不依赖上游树在场）：**快照内 `@deepseek-ai/dsh-mcp-client` 的运行期
// dependencies 必须全部可在快照内解析**。上游再次换包名 / 加依赖时，本门禁判红而不是静默漏掉。
//
// 用法：node scripts/check-mcp-client-deps.mjs [abi] [--snapshot <tar>] [--require]
//   退出码：0 = 通过；1 = 依赖在快照内不可解析；2 = 前置不满足（无快照且未 --require 时 SKIP）
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAR } from './lib/shell.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
// ── --self-test：判别力自证（2026-10-29 补；此前这条门禁零判别力面）──────────────────
//
// 它守的是「快照内 @deepseek-ai/dsh-mcp-client 的运行期依赖**闭包**必须可解析」——
// 那条真实用户诊断包里的 boot 硬崩（Cannot find package '@modelcontextprotocol/client'）
// 就是这条判据的由来。自证造四个极小快照（--snapshot 指向），把六个分支全打一遍，
// 其中「传递闭包缺」那条专门证明它查的是闭包而不是一层。
if (process.argv.includes('--self-test')) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const selfPath = fileURLToPath(import.meta.url)
  const NM = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules'
  const runGate = (gateArgs) => {
    try {
      const out = execFileSync(process.execPath, [selfPath, ...gateArgs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    }
  }
  /** pkgs: { 包名: { dependencies } }；包名带 @scope 的会落到 @scope/name 子目录。 */
  const buildSnapshot = (tag, pkgs) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpsnap-' + tag + '-'))
    const nmDir = join(dir, ...NM.split('/'))
    for (const [name, meta] of Object.entries(pkgs)) {
      const pkgDir = join(nmDir, ...name.split('/'))
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', dependencies: meta.dependencies ?? {} }))
    }
    const tops = ['usr']
    const archive = join(tmpdir(), 'mcpsnap-' + tag + '-' + process.pid + '.tar.xz')
    execFileSync(TAR, ['-cJf', archive, '-C', dir, ...tops], { stdio: ['ignore', 'pipe', 'pipe'] })
    rmSync(dir, { recursive: true, force: true })
    return archive
  }

  const HOST = '@deepseek-ai/dsh-mcp-client'
  const ok = buildSnapshot('ok', {
    [HOST]: { dependencies: { 'dep-a': '^1' } },
    'dep-a': { dependencies: {} },
  })
  const oneLevel = buildSnapshot('onelevel', {
    [HOST]: { dependencies: { 'dep-a': '^1', 'dep-missing': '^1' } },
    'dep-a': {},
  })
  const transitive = buildSnapshot('transitive', {
    [HOST]: { dependencies: { 'dep-a': '^1' } },
    'dep-a': { dependencies: { 'dep-deep-missing': '^2' } },
  })
  const noHost = buildSnapshot('nohost', { 'dep-a': {} })
  const absent = join(tmpdir(), 'mcpsnap-absent-' + process.pid + '.tar.xz')

  const checks = [
    ['合规快照（宿主只依赖在场的 dep-a）→ PASSED 且 exit 0', runGate(['--snapshot', ok]), (r) => r.code === 0 && r.out.includes('CHECK-MCP-CLIENT-DEPS PASSED')],
    ['一层依赖缺 → FAILED 且点名 MISS 与设备后果', runGate(['--snapshot', oneLevel]), (r) => r.code === 1 && r.out.includes('MISS  dep-missing') && r.out.includes('ERR_MODULE_NOT_FOUND')],
    ['传递闭包缺（dep-a 依赖 dep-deep-missing）→ FAILED（证明查的是闭包不是一层）', runGate(['--snapshot', transitive]), (r) => r.code === 1 && r.out.includes('dep-deep-missing')],
    ['快照缺席（非 --require）→ SKIP(#1) 且 exit 0', runGate(['--snapshot', absent]), (r) => r.code === 0 && r.out.includes('SKIP(#1)')],
    ['快照缺席 + --require → 硬失败 exit 1', runGate(['--snapshot', absent, '--require']), (r) => r.code === 1 && r.out.includes('CHECK-MCP-CLIENT-DEPS FAILED')],
    ['宿主包不在快照 → SKIP(#2)（上游裁包/改名，本门禁不适用）', runGate(['--snapshot', noHost]), (r) => r.code === 0 && r.out.includes('SKIP(#2)')],
  ]
  let bad = 0
  for (const [label, result, verify] of checks) {
    const pass = verify(result)
    console.log((pass ? 'PASS  ' : 'FAIL  ') + label + (pass ? '' : '  -> exit=' + result.code + ' out=' + result.out.trim().slice(0, 240)))
    if (!pass) bad += 1
  }
  for (const a of [ok, oneLevel, transitive, noHost]) rmSync(a, { force: true })
  console.log(bad === 0
    ? 'MCP_CLIENT_DEPS_SELF_TEST_PASSED（' + checks.length + ' 项）'
    : 'MCP_CLIENT_DEPS_SELF_TEST_FAILED（' + bad + ' 项）')
  process.exit(bad === 0 ? 0 : 1)
}

const args = process.argv.slice(2)
let ABI = 'x86_64'
let SNAP_OVERRIDE = null
let REQUIRE = false
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--snapshot') { SNAP_OVERRIDE = args[i + 1]; i += 1; continue }
  if (args[i] === '--require') { REQUIRE = true; continue }
  if (!args[i].startsWith('--')) ABI = args[i]
}

const APK_DIR = existsSync(join(ROOT, 'dsh-mobile-apk')) ? join(ROOT, 'dsh-mobile-apk') : ROOT
const SNAP = SNAP_OVERRIDE ?? join(ROOT, '.deploy-tmp', 'snapshot-013', ABI, 'snapshot.tar.xz')

/** 被守护的宿主包：它的运行期 dependencies 就是本门禁的判据面。 */
const WATCHED = '@deepseek-ai/dsh-mcp-client'
const NM = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules'

const fail = (msg) => { console.error('CHECK-MCP-CLIENT-DEPS FAILED：' + msg); process.exit(1) }

if (!existsSync(SNAP)) {
  const msg = `快照不在场（${SNAP}，abi=${ABI}）——先构建快照再跑本门禁`
  if (REQUIRE) fail(msg + '\n  严格模式（--require）：构建链/发布链不得以 SKIP 结案')
  console.log('SKIP(#1)  ' + msg)                                             // SKIP #1：快照缺席（发布链 --require 下改判红）
  console.log('SKIP=1（本门禁在快照缺席时以 SKIP 结案，发布链 --require 强制齐全）')
  // 具名结论行（issue #1154）：只有 SKIP 行 + SKIP=1 时，审计侧判「no-verdict」（有 SKIP 面却没有
  // 任何判据行，可能零判据结案），只能靠 AUDIT_BASELINE 登记兜着；而那套登记在双环境下不可能同时
  // 成立（本地有快照→真跑通过，CI 无快照→恒 SKIP），销账必然倒挂。补一行与 PASSED/FAILED 同形的
  // SKIP 结论，审计就能直接读懂「这是明确结案」，登记表随之不需要。
  console.log('CHECK-MCP-CLIENT-DEPS SKIPPED（快照不在场，' + ABI + '；SKIP=1）')
  process.exit(0)
}

// 一次 tar -tf 列出全部成员，再按需 tar -xO 取 package.json（避免解压整包）。
let members
try {
  members = execFileSync(TAR, ['-tf', SNAP], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    // Windows 的 bsdtar 每行以 CRLF 结尾；不剥 \r 会让 `members.includes(p)` 恒假（本轮实测）。
    .split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0)
} catch (e) {
  fail('读不了快照成员表：' + String(e).slice(0, 300))
}

/** 快照内已存在的包目录（顶层 node_modules 与嵌套 node_modules 都算：Node 解析会向上走）。 */
/**
 * 快照内可解析的包名集合。
 * 关键：取**最后一个** `node_modules/` 段——路径形如
 *   usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/...
 * 取第一个 `node_modules/` 会把包名解析成 `@deepseek-ai/dsh`（本轮实测的假红/假绿源）。
 * 嵌套 node_modules 也算（Node 解析会逐级向上），故按每段最后一个 node_modules 取其后的包名即可。
 */
const pkgDirs = new Set()
const ADD = (seg) => {
  const parts = seg.split('/')
  if (parts.length < 2) return
  pkgDirs.add(parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0])
}
for (const m of members) {
  const i = m.lastIndexOf('node_modules/')
  if (i < 0) continue
  ADD(m.slice(i + 'node_modules/'.length))
}

/**
 * 一次性把顶层 node_modules 下所有 `*.json` 里的 package.json 取出来（单次 tar 调用）。
 * 为什么不用「每包一次 tar -xOf」：49k 成员的 tar 每个包一次 = 每次都要重扫索引，
 * 闭包十几个包就要几分钟（本轮实测超时）。一次 -xOf 取回全部 package.json 只需一次扫描。
 * 只匹配顶层 NM（闭包只在引擎顶层解析；嵌套副本由 Node 逐级向上找到顶层）。
 */
const pkgJsons = new Map()
try {
  // 成员表经临时文件传给 tar -T（argv 放不下 900+ 路径：ENAMETOOLONG，本轮实测）。
  const listFile = join(dirname(SNAP), `.mcp-deps-list-${process.pid}.txt`)
  const wanted = members.filter((m) => m.startsWith(NM + '/') && m.endsWith('/package.json'))
  writeFileSync(listFile, wanted.join('\n') + '\n')
  let bulk
  try {
    bulk = execFileSync(TAR, ['-xOf', SNAP, '-T', listFile], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  } finally { rmSync(listFile, { force: true }) }
  // -xOf 多成员会顺序拼接；用 JSON 文本切分（每个 package.json 是独立 JSON 对象）
  let depth = 0, start = -1, inStr = false, esc = false
  for (let i = 0; i < bulk.length; i += 1) {
    const c = bulk[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === '{') { if (depth === 0) start = i; depth += 1 }
    else if (c === '}') { depth -= 1; if (depth === 0 && start >= 0) {
      try { const j = JSON.parse(bulk.slice(start, i + 1)); if (typeof j.name === 'string') pkgJsons.set(j.name, j) } catch { /* 非法片段跳过 */ }
      start = -1
    } }
  }
} catch (e) {
  fail('批量取 package.json 失败：' + String(e).slice(0, 300))
}

const readPkgJson = (name) => pkgJsons.get(name) ?? null

const host = readPkgJson(WATCHED)
if (host === null) {
  // 宿主包不在快照里：说明上游裁掉了它（或被改名）。这本身要人看一眼，但不属于本门禁的判据面。
  console.log('SKIP(#2)  快照内无 ' + WATCHED + '（上游裁包/改名？）——本门禁不适用，请核对上游依赖图')   // SKIP #2：宿主包被上游裁掉/改名
  console.log('SKIP=1（宿主包不在快照内时以 SKIP 结案；发布链 --require 强制齐全）')
  // 具名结论行，理由同 SKIP #1（见上）。
  console.log('CHECK-MCP-CLIENT-DEPS SKIPPED（快照内无宿主包，' + ABI + '；SKIP=1）')
  process.exit(0)
}

/**
 * 传递闭包：从宿主的运行期 dependencies 出发，逐级读快照内该包的 package.json，
 * 收集「缺哪些 + 谁在引用」。判据必须是闭包而非「我列了就够」——上游给 client 加一个新依赖时，
 * 只把 client 自己登记进 overlay 仍然会在设备上崩。每个包只访问一次（快照内可解析性是幂等的）。
 */
const missing = new Map()   // 缺失包名 -> 引用者集合
const seen = new Set([WATCHED])
const queue = [WATCHED]
let visited = 0
while (queue.length > 0) {
  const cur = queue.shift()
  const pkg = readPkgJson(cur)
  if (pkg === null) continue
  visited += 1
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!pkgDirs.has(dep)) {
      if (!missing.has(dep)) missing.set(dep, new Set())
      missing.get(dep).add(cur)
      continue   // 缺席的包读不到它自己的依赖，到此为止
    }
    if (!seen.has(dep)) { seen.add(dep); queue.push(dep) }
  }
}
console.log(`宿主 ${WATCHED}@${String(host.version)}：闭包遍历 ${String(visited)} 个包`)
for (const d of [...seen].filter((n) => n !== WATCHED).sort()) console.log('  PASS  ' + d)
for (const [d, who] of [...missing.entries()].sort()) {
  console.log('  MISS  ' + d + '   <- ' + [...who].sort().join(', '))
}

if (missing.size > 0) {
  const names = [...missing.keys()].sort()
  fail(
    `${WATCHED} 的运行期依赖闭包在快照内不可解析 ${String(names.length)} 条: [${names.join(', ')}]`
    + '\n  设备后果：boot 阶段 ERR_MODULE_NOT_FOUND 硬崩、engine exit=1（用户看见「引擎起不来」）。'
    + '\n  修法：把缺失包（含其传递闭包）登记进 scripts/snapshot-config/engine-overlay.json 的'
    + ' vendorTop（顶层第三方依赖）或 packages（@deepseek-ai 域）。'
    + '\n  注意：该宿主不在我们装配的行面上（用户自己挂的 entry），故 check-engine-overlay 的正向闭包'
    + ' 不覆盖它——这正是本门禁的判别力所在。'
  )
}

console.log(`CHECK-MCP-CLIENT-DEPS PASSED（宿主 ${WATCHED} 的运行期依赖闭包 ${String(seen.size - 1)} 个包全部可在快照内解析）`)
