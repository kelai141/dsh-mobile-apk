// check-contract.mjs — adapter-layer contract point check (core M1.4 adapter chain check).
// Consumes scripts/contract.json; any broken point → non-zero exit + report.
// 用法：node scripts/check-contract.mjs [--require]
//         [--self-test]                        反证夹具：13 例「故意造反例必判红」自证（只读临时副本，不动仓库文件）
//         [--runtime <ver>]                    只用于反证：把目标运行时装成下一版，验 §7 会不会判红
//         [--capture-slots --accept-slot-diff <理由>] / [--capture-rows --accept-row-diff <理由>]
//                                              换树后重新登记 §4c / §8 的上游面集合（改范围必须给理由，不给即红）
//         [--contract <file>] [--profile <file>] 仅 --self-test 用的输入改道缝
// review C6（2026-09-14）：本门禁此前未接任何链（存在但从不执行 = 假防线）；现接进聚合入口与两条构建链。
// 上游 `dsh/` 只读 checkout 与基线 `node_modules` 都是**本机产物**（gitignore，CI/自包含树不在场）：
// 对应小节以 SKIP 计数并打印汇总；`--require`（发布链）下任何 SKIP 即失败——发布环境必须齐全。
// --runtime 只用于反证（把目标运行时装成下一版，验 §7 会不会判红），不参与任何默认判据。
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
/**
 * --contract / --profile 只为 `--self-test` 的反证夹具留缝（把改坏的登记表/装配清单指到临时副本），
 * 正式链一律不传 ⇒ 反证不靠「改仓库文件再改回来」（半途被杀就留下一棵脏树）。
 */
const flagValue = (name) => { const i = argv.indexOf(name); return i >= 0 ? String(argv[i + 1] ?? '') : null }
const CONTRACT_PATH = resolve(flagValue('--contract') ?? join(root, 'scripts/contract.json'))
const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'))
const PROFILE_PATCH_PATH = resolve(flagValue('--profile') ?? join(root, 'scripts', 'profile-web.cordis.patch.yml'))
const DOC_PATH = resolve(flagValue('--doc') ?? join(root, 'docs', 'UPSTREAM-CONTRACT.md'))
/**
 * `--slots-source`：只给 `--self-test` 用的取面改道缝（把「我方消费面」指到一个临时文件），
 * 从而能造出「消费未登记」这一反例而**不动仓库源码**——半途被杀也不会留下脏树。
 * 正式链一律不传 ⇒ 取面恒为 contract.clientSlots.repo 的 src/client/**。
 */
const SLOTS_SOURCE = flagValue('--slots-source')
const issues = []
const REQUIRE = argv.includes('--require')
/**
 * issue #1114：依赖树缺席时默认 exit 2（硬失败），只有显式传它才以 0 结案。
 *
 * 谁该传：`--self-test` 的对照组（它验的是**判据逻辑**，不是「上游树就绪」）、以及
 * 任何确实处在「依赖尚未就绪」合法阶段的调用点。构建链与发版链**一律不传** ——
 * 那两条链的前提就是上游树已在场，缺席必须当场暴露而不是静默结案。
 */
const ALLOW_MISSING = argv.includes('--allow-missing')
let skipped = 0
/** 仓库相对路径（仅用于报错文案）。0.14.2 rc.2 追版实修：§9 的两处报错此前调用了**从未定义**的
 *  `rel()` —— rc.1 时文档含基线字样，该分支从未走到；换基线后第一次判红即 `ReferenceError` 崩溃，
 *  把「该判红」变成「门禁自己炸」，判据在追版路径上不可读。 */
const rel = (p) => { const r = resolve(p).slice(root.length + 1); return r.split('\\').join('/') }
const ok = (msg) => console.log('  OK  ' + msg)
const fail = (msg) => { issues.push(msg); console.log('  FAIL ' + msg) }
/**
 * 依赖缺席计数器（issue #1114）。
 *
 * `skip` 与 `softSkip` 的区别是「这一侧负不负责这条判据」：
 *   - softSkip：自包含树里协调仓独有输入，合法缺席，不是缺口；
 *   - skip（本函数）：**该验却验不了**，是缺口。以前它只打一行就放过，现在必须让
 *     最终退出码反映出来（见文件末尾的 hardSkip 分支）。
 */
let hardSkip = 0
const skip = (msg) => {
  skipped += 1
  hardSkip += 1
  if (REQUIRE) issues.push('SKIP: ' + msg)
  console.log('  SKIP(#' + skipped + ')  ' + msg + (REQUIRE ? ' —— --require 档不得 SKIP' : ''))
}
/** 自包含树（apk 仓单人检出）里，**协调仓独有**的输入合法缺席。
 *  此时 SKIP 不计入 --require，但必须显式打印原因并单独计数——与 check-release-gates 的
 *  「apk 树不在场 ⇒ 显式 SKIP、绝不回落自证」同一纪律：判据只在**它能看见输入**的那一侧负责。
 *  真实 run 36359806116 就是这条：apk 自包含树没有 docs/UPSTREAM-CONTRACT.md，
 *  而链以 --require 跑 ⇒ 合法缺席被当成判红，整链在最后一段 §9 停下。 */
const APK_SELF_CONTAINED = !existsSync(join(root, 'dsh-mobile-apk'))
const softSkip = (msg) => {
  // 计入 skipped 只为让 SKIP 编号连续（check-gate-skips 要求每个 SKIP 打印行都是「已计数行」）；
  // 关键差别是**不 push 到 issues** ⇒ 严格档下也不算失败。
  skipped += 1
  console.log('  SKIP(#' + skipped + ')  ' + msg + ' —— 自包含树合法缺席，不计入 --require（协调仓布局下必须真跑）')
}

/* --self-test：新加的每一条判据都要「故意造反例必判红」的自证（AGENTS 反证要求）。
 * 反例走临时副本（--contract / --profile），不改仓库文件——半途被杀也不会留下一棵脏树。 */
if (argv.includes('--self-test')) runContractSelfTest()

/**
 * 槽位注入的**词法抽取**（G-P4b 双向判据的取面器）。
 *
 * ── 为什么必须词法化，而不是正则扫原文 ──────────────────────────────────────────
 * §4 原判据是 `slotText.includes("'" + slot + "'")`——它在**原文**上找子串，于是：
 *  · 注释里写一句 `ctx.slots.inject('x')` 会被当成真消费（假绿方向：写句注释就能让判据满足）；
 *  · 字符串/模板串里提一句同样的文本同样算数；
 *  · 反过来它也只能回答「这个槽名有没有在文件里出现过」，答不了「有没有被 inject」。
 * 双向判据要求「消费事实」本身可靠，所以这里把源码切成**代码位**与**字面量位**：注释整体丢弃，
 * 字符串/模板串替换成 \u0000<idx>\u0000 占位符。`slots.inject(` 只在代码位匹配，槽名只取自
 * 紧随其后的那个字面量 ⇒ 注释与字符串两个方向都骗不过它。
 * 模板串的 `${...}` 插值区**按代码位扫描**（否则插值里写 inject 会被漏判，属假绿方向）。
 *
 * @param text 源文件全文。
 * @returns `{ slots, dynamic }`：去重后的字面量槽名数组；dynamic 为非字面量参数的调用片段。
 */
function scanSlotInjections(text) {
  const literals = []
  let code = ''
  let i = 0
  const n = text.length
  let state = 'code'
  let buf = ''
  const tpl = []
  const flush = (isTemplate) => {
    const idx = literals.length
    literals.push({ value: buf, template: isTemplate })
    code += '\u0000' + idx + '\u0000'
    buf = ''
  }
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (state === 'code') {
      if (tpl.length > 0) {
        if (c === '{') tpl[tpl.length - 1] += 1
        else if (c === '}') {
          if (tpl[tpl.length - 1] === 0) { tpl.pop(); state = 'tpl'; i += 1; continue }
          tpl[tpl.length - 1] -= 1
        }
      }
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue }
      if (c === "'" || c === '"') { state = c === "'" ? 'sq' : 'dq'; buf = ''; i += 1; continue }
      if (c === '`') { state = 'tpl'; buf = ''; i += 1; continue }
      code += c; i += 1; continue
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; code += c } i += 1; continue }
    if (state === 'block') { if (c === '*' && d === '/') { state = 'code'; i += 2 } else { i += 1 } continue }
    if (state === 'tpl') {
      if (c === '\\') { buf += c + (d === undefined ? '' : d); i += 2; continue }
      if (c === '$' && d === '{') { flush(true); state = 'code'; tpl.push(0); i += 2; continue }
      if (c === '`') { flush(true); state = 'code'; i += 1; continue }
      buf += c; i += 1; continue
    }
    if (c === '\\') { buf += c + (d === undefined ? '' : d); i += 2; continue }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) { flush(false); state = 'code'; i += 1; continue }
    buf += c; i += 1; continue
  }
  const slots = []
  const dynamic = []
  const re = /slots\.inject\(\s*\u0000(\d+)\u0000/g
  let m
  while ((m = re.exec(code)) !== null) {
    const lit = literals[Number(m[1])]
    if (lit === undefined || lit.template) { dynamic.push(lit === undefined ? '(unresolved)' : lit.value); continue }
    if (!slots.includes(lit.value)) slots.push(lit.value)
  }
  const reDyn = /slots\.inject\(\s*(?!\u0000)/g
  while ((m = reDyn.exec(code)) !== null) dynamic.push(code.slice(reDyn.lastIndex, reDyn.lastIndex + 40).replace(/\s+/g, ' '))
  return { slots, dynamic }
}

/**
 * 收集我方注入层的**槽消费事实**（§4 双向判据的唯一取面口径）。
 *
 * 扫描面 = `contract.clientSlots.repo` 的 `src/client/**`（排除 node_modules 与测试文件）——因为
 * 该目录整体编译进 `lib/client.js`（package.json 的 exports 面），所以「在这个目录里 inject」与
 * 「发布出去会生效」等价。**不扫 `src/` 其它部分**：注入是 client 概念，扫宽了会把非注入面的
 * 同名文本算成消费。
 *
 * 为什么用同一取面喂两个方向：若「登记未消费」看 index.ts 而「消费未登记」看全树，把一次 inject
 * 挪到别的文件就会让第一个方向**假红**（它其实仍被消费）。两侧同源才自洽。
 *
 * @returns `{ slots, dynamic, sources }`；扫描面不存在时返回 null（由调用方 SKIP）。
 */
function collectConsumedSlots() {
  if (SLOTS_SOURCE !== null) {
    const p = resolve(SLOTS_SOURCE)
    if (!existsSync(p)) return null
    const r = scanSlotInjections(readFileSync(p, 'utf8'))
    return { slots: r.slots, dynamic: r.dynamic.map((s) => ({ file: rel(p), snippet: s })), sources: [rel(p)] }
  }
  const base = join(root, contract.clientSlots.repo, 'src', 'client')
  if (!existsSync(base)) return null
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.includes('__tests__')) files.push(p)
    }
  }
  walk(base)
  const slots = []
  const dynamic = []
  for (const p of files) {
    const r = scanSlotInjections(readFileSync(p, 'utf8'))
    for (const s of r.slots) if (!slots.includes(s)) slots.push(s)
    for (const s of r.dynamic) dynamic.push({ file: rel(p), snippet: s })
  }
  return { slots, dynamic, sources: files.map(rel) }
}

function dtsFiles(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...dtsFiles(p))
    else if (p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/**
 * 上游树身份（G-9）。§1/§3/§4b/§4c 全部直接读 `dsh/packages/**` 工作树，但此前**没有任何门禁记录
 * 读的是哪一棵树**：本轮实测该树停在 `dsh-v0.1.5-rc.1-9-gaa8262ec09`（比 tag 多 9 个提交），
 * 而根包 `version` 在两次发布之间不 bump ⇒ 只看 package.json 分不清「正好在 tag 上」和「漂在 tag 之后」。
 * 登记 upstream{tag,describe,commit,rootVersion} 后，切树/漏切都会判红，而不是换一棵树继续全绿。
 */
const upstreamDir = join(root, contract.upstreamRepo)
function gitInUpstream(args) {
  try {
    return execFileSync('git', ['-C', upstreamDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch { return null }
}
/** 上游树实际身份；树不在场（CI/自包含构建）时返回 null，由调用方 SKIP。 */
function upstreamIdentity() {
  const pkgPath = join(upstreamDir, 'package.json')
  if (!existsSync(pkgPath)) return null
  const describe = gitInUpstream(['describe', '--tags'])
  const commit = gitInUpstream(['rev-parse', 'HEAD'])
  return { rootVersion: JSON.parse(readFileSync(pkgPath, 'utf8')).version, describe, commit }
}

console.log('== 0. 上游树身份（上游面判据读的是哪一棵树；G-9） ==')
const up = contract.upstream
if (up === undefined) {
  fail('contract.json 缺 upstream{tag,describe,commit,rootVersion}：上游面判据（§1/§3/§4b/§4c）没有树身份锚定，任何一棵树都能绿')
} else {
  const id = upstreamIdentity()
  if (id === null) skip('上游树 ' + contract.upstreamRepo + '/package.json 不在场 —— 上游树身份未执行')
  else {
    if (id.rootVersion !== contract.baseline) {
      fail('上游树根包 version=' + id.rootVersion + ' ≠ contract.baseline=' + contract.baseline
        + '：§1/§3/§4b 正在拿一棵别的版本的树当基线判（追版时先切树再改 baseline，两步必须同时发生）')
    } else ok('上游树根包 version == baseline（' + id.rootVersion + '）')
    if (up.rootVersion !== contract.baseline) fail('contract.upstream.rootVersion=' + up.rootVersion + ' ≠ contract.baseline=' + contract.baseline + '（登记表内部自相矛盾）')
    if (id.commit === null || id.describe === null) {
      skip('git 不可读（不是 checkout 或 git 不在 PATH）—— 无法核对上游树 commit/describe')
    } else {
      if (id.commit !== up.commit) fail('上游树 HEAD=' + id.commit + ' ≠ 登记 commit=' + up.commit + '（登记来自 ' + up.describe + '，现在读的是 ' + id.describe + '）——请复核是否切了树；确需换树就同步改 contract.upstream 并复核 §1/§3/§4b 结论')
      else ok('上游树 HEAD == 登记 commit（' + id.describe + '）')
      if (id.describe !== up.describe) fail('上游树 describe=' + id.describe + ' ≠ 登记 describe=' + up.describe + '（同一 commit 也不代表同一判据范围：tag 之后多出的提交同样在树里）')
      else ok('上游树 describe == 登记（' + up.describe + '）')
    }
  }
}

console.log('== 1. bundle 行引用 ==')
const upstreamPackages = join(root, contract.upstreamRepo, 'packages')
if (!existsSync(upstreamPackages)) {
  skip('上游树 ' + contract.upstreamRepo + '/packages 不在场（只读 checkout；CI/自包含树不含）——bundle 行引用未执行')
} else {
  for (const row of contract.rows) {
    const patchFile = join(upstreamPackages, 'bundle', row.bundle, 'cordis.patch.yml')
    if (!existsSync(patchFile)) { fail('bundle patch 缺失: ' + patchFile); continue }
    const text = readFileSync(patchFile, 'utf8')
    const hit = text.split('\n').find(l => l.trim() === '- id: ' + row.id)
    if (hit === undefined) fail('行 ' + row.id + ' 在上游 ' + row.bundle + ' bundle 中不存在（patch 静默失效风险）')
    else ok('行 ' + row.id + ' @ ' + row.bundle + ' 存在')
  }
}

console.log('== 2. 插入行包存在（仓库 + 构建产物） ==')
for (const ins of contract.inserted) {
  const repo = join(root, ins.repo)
  if (!existsSync(join(repo, 'package.json'))) fail('仓库缺失: ' + ins.repo)
  else ok('仓库 ' + ins.repo + ' 存在')
  const built = existsSync(join(repo, 'lib/index.js')) || existsSync(join(repo, 'lib/client.js'))
  if (!built) fail(ins.repo + ' 未构建（lib/ 缺失）')
  else ok(ins.repo + ' lib/ 已构建')
}

console.log('== 3. 继承符号（基线 node_modules 类型面） ==')
const baseline = join(root, contract.symbols[0].repo, 'node_modules/@deepseek-ai')
if (!existsSync(baseline)) {
  skip('基线 node_modules 不在场（' + contract.symbols[0].repo + '/node_modules，先 npm install）——继承符号未执行')
} else {
  for (const sym of contract.symbols) {
    const typesDir = join(baseline, sym.pkg, 'lib/types')
    if (!existsSync(typesDir)) { fail('基线缺失 ' + sym.pkg + '/lib/types（先 npm install）'); continue }
    const found = dtsFiles(typesDir).some(f => readFileSync(f, 'utf8').includes(sym.symbol))
    if (found) ok(sym.pkg + ': ' + sym.symbol)
    else fail(sym.pkg + ': 符号 ' + sym.symbol + ' 不在基线类型面（继承面断裂）')
  }
}

// 0.2.0 起注入层不再替换上游框架：它组合进上游的座位，绝不注册 'root'。
console.log('== 4. 客户端槽位声明（组合面，非框架替换） ==')
/* 正式链读我方 index.ts（注入入口）；`--slots-source` 只把**槽位消费面**改道到临时文件，供自证用。
 * 注意只有消费面（collectConsumedSlots 与 §4 的双向差集）走这条缝；ownRoot 判据仍读**真实**入口文件，
 * 否则反证会顺带把那条不相关的判据也替换掉（同一个变量喂两条判据 = 反证结论不可信）。 */
const slotEntryPath = join(root, contract.clientSlots.repo, 'src/client/index.ts')
const slotText = readFileSync(slotEntryPath, 'utf8')
/* G-P4b：§4 此前只做**单方向**检查（遍历登记表，看我方源码里有没有那个字符串），于是
 *   · 能抓「登记了但源码没消费」（本轮构建链真实拒过：conversation.session.header.utilities）；
 *   · **抓不到「源码消费了但登记表没有」**——task-62 把抽屉开关注册进 conversation.header.leading
 *     而 contract.json 未登记时，本门禁**全绿**，会一路绿到发布。
 * 那个方向的后果不是「多点了一个座位」，而是：上游改该座位的 kind/scope 时，§4b 的声明面判据
 * 根本不知道要盯它（登记表里没有这条）⇒ 注入层**静默落空**，界面少一块而门禁无话可说。
 * 因此这里补成双向：以「我方源码的 inject 事实」为集合，与登记表求**对称差集**，两个方向都判红。
 * 判定严格：不做任何白名单豁免——确有动态注册（非字面量参数）时**单独判红并要求显式登记**，
 * 因为「忽略某些槽」正是本仓反复出现的假绿形态。 */
const consumed = collectConsumedSlots()
if (consumed === null) {
  skip('我方注入层源码不在场（' + contract.clientSlots.repo + '/src/client）——槽位消费面未执行（双向判据都跳过）')
} else {
  const declaredSlots = contract.clientSlots.slots
  /* 既有方向（登记了但源码未消费）。**文案不变**（既有 15 例自证按它匹配），但判据从
   * `slotText.includes("'" + slot + "'")` 换成词法抽取出的**消费事实**：
   * 原文子串匹配会被一句注释满足——`// ctx.slots.inject('x')` 能让「已组合」判绿，
   * 而那个槽其实没有任何注入。词法化后两个方向共用同一个集合，也因此天然是**对称差**。 */
  for (const slot of declaredSlots) {
    if (consumed.slots.includes(slot)) ok('槽位 ' + slot + ' 已组合')
    else fail('槽位 ' + slot + ' 未组合')
  }
  for (const slot of consumed.slots) {
    if (declaredSlots.includes(slot)) {
      ok('槽位 ' + slot + ' 已登记（消费面与登记表一致）')
    } else {
      fail('槽位 ' + slot + ' 已在我方源码消费（slots.inject）但未登记进 clientSlots.slots：上游改其 kind/scope 时注入层会静默落空、且 §4b 声明面不知道要盯它，请登记')
    }
  }
  // 动态注册（参数不是字面量）不得静默通过：它既无法与登记表对齐，也无法被 §4b 盯住。
  for (const d of consumed.dynamic) {
    fail('动态注册的槽位无法与登记表对齐（' + d.file + '）：slots.inject(' + d.snippet + ' —— 请改为字面量槽名，或显式登记并写明 why（不得静默忽略）')
  }
  if (consumed.dynamic.length === 0) ok('注入面无非字面量槽名（全部可被登记表与 §4b 盯住）')
}
if (contract.clientSlots.ownRoot === false) {
  if (/name:\s*'root'/.test(slotText)) fail("注入层注册了 'root' 槽（框架替换回归）")
  else ok("未注册 'root' 槽（上游 ui-layout 持有框架）")
}
if (contract.clientSlots.enabledRow !== undefined) {
  const patchText = readFileSync(join(root, 'scripts/profile-web.cordis.patch.yml'), 'utf8')
  const disabled = new RegExp('- id:\\s*' + contract.clientSlots.enabledRow + '\\s*\\n\\s*disabled:\\s*true').test(patchText)
  if (disabled) fail('profile patch 禁用了 ' + contract.clientSlots.enabledRow + '（0.1.5 起为布局服务中枢，禁用即会话与左栏同时失效）')
  else ok('profile patch 保留 ' + contract.clientSlots.enabledRow + ' 启用')
}

// 槽位**声明面**（0.14.1 §1.1b 决策 1 第 3 项）：上面的 §4 只断言「我们注册了哪些槽」，
// 全是**我方源码里挑字符串**——上游把槽删掉/改 kind/改 scope 时它照样绿（文本还在我方文件里）。
// 这是「注入层在升级后静默失效」的真实盲区，本段用**上游声明源**做结构性判据：
//   · 从上游该槽的声明文件里定位声明块（单行 `'x': { ... }` 或多行 `'x': {\n ... \n}` 两种形态）；
//   · 断言 kind / scope 与 contract.json 记录的实测值一致（kind=keyed/list/single，scope=root/session）。
// 判红理由分两类且文案分开：槽**消失**（升级删槽）与 kind/scope **漂移**（语义变更）是不同事故。
//
// issue #1021（判据失效模式：vacuous pass——判据整段被条件包住，空输入时静默消失）：
//   旧实现把整段包在 §declarations.length > 0§ 里，于是把 §clientSlots.declarations§ 清空，
//   这段守卫**根本不执行**：门禁仍打印 §CONTRACT PASS§、SKIP 计数还变小（§4b 段不再产生 SKIP 行），
//   没有任何地方记录「这一段没跑」。整段判据对「登记表被清空」这种形态恒真 —— 属空集恒真家族。
//   修法 = **声明面登记本身成为一条判据**：declarations 必须是非空数组，且必须与 §4 的槽位登记
//   同规模（每个在 §clientSlots.slots 里登记、又在上游有声明文件的槽，都必须在 declarations 里出现）。
//   于是「清空 declarations」直接从「静默通过」变成「判红」，且 §4b 段永远会被执行。
const declarations = contract.clientSlots.declarations
/** 声明面登记的非空下限（issue #1021）。纯函数形式便于自检直接喂合成输入。 */
const declarationsProblem = (list, declaredSlots) => {
  if (!Array.isArray(list)) return 'clientSlots.declarations 不是数组（声明面判据会整段消失）'
  if (list.length === 0) {
    return 'clientSlots.declarations 为空 —— §4b 声明面判据会整段静默消失（空声明集不等于「没有漂移」）'
  }
  // 非空下限之外再钉规模关系：§4 登记的槽位里凡有声明文件的，都该出现在 declarations 里。
  // 只要求「declarations 里的项都在 slots 里」，不要求反向全等：有些槽的上游声明文件不在
  // 当前 checkout（CI/自包含树），规模关系只在能核对的方向上成立。
  const slotSet = new Set(Array.isArray(declaredSlots) ? declaredSlots : [])
  const unknown = list.filter((d) => !slotSet.has(d.slot)).map((d) => d.slot)
  if (unknown.length > 0) {
    return 'clientSlots.declarations 里有未在 clientSlots.slots 登记的槽：' + unknown.join(', ')
  }
  return null
}
const declProblem = declarationsProblem(declarations, contract.clientSlots.slots)
if (declProblem !== null) fail(declProblem)
{
  console.log('== 4b. 槽位声明面（上游 kind/scope 与实测值一致；防升级静默失效） ==')
  // declarations 非数组已由上面的判据判红（不再是「整段消失」），这里只做遍历；
  // 数组为空时下面的 for 不执行，但判据已在上面报过红，不存在「静默通过」。
  for (const d of Array.isArray(declarations) ? declarations : []) {
    const declFile = join(root, contract.upstreamRepo, d.file)
    if (!existsSync(declFile)) {
      skip('上游声明文件不在场: ' + d.file + '（只读 checkout；CI/自包含树不含）——槽 ' + d.slot + ' 未执行')
      continue
    }
    const text = readFileSync(declFile, 'utf8')
    const key = "'" + d.slot + "'"
    const at = text.indexOf(key)
    if (at < 0) {
      fail('槽 ' + d.slot + ' 在上游声明源里消失（' + d.file + '）：注入层注册将静默落空')
      continue
    }
    // 声明块 = 键之后到首个 `}` 为止（单行与多行两种写法都覆盖；槽值内无嵌套对象字面量）。
    const rest = text.slice(at + key.length)
    const braceOpen = rest.indexOf('{')
    const braceClose = rest.indexOf('}')
    if (braceOpen < 0 || braceClose < braceOpen) {
      fail('槽 ' + d.slot + ' 的声明块无法解析（' + d.file + '）——上游写法变更，需人工核对')
      continue
    }
    const block = rest.slice(braceOpen, braceClose + 1)
    const kind = (/\bkind\s*:\s*'([a-z]+)'/.exec(block) ?? [, null])[1]
    const scope = (/\bscope\s*:\s*'([a-z]+)'/.exec(block) ?? [, null])[1]
    if (kind === null || scope === null) {
      fail('槽 ' + d.slot + ' 声明缺 kind/scope（' + d.file + ' 实测 kind=' + kind + ' scope=' + scope + '）')
      continue
    }
    const kindOk = kind === d.kind
    const scopeOk = scope === d.scope
    if (kindOk && scopeOk) {
      ok('槽 ' + d.slot + ' 声明面 == 实测（kind=' + d.kind + ' scope=' + d.scope + '）')
    } else {
      fail('槽 ' + d.slot + ' 声明漂移：实测 kind=' + kind + ' scope=' + scope
        + '，登记期望 kind=' + d.kind + ' scope=' + d.scope
        + '（kind 变更 = 并列/覆盖语义变了；scope 变更 = 注册作用域变了。改了上游就同步改 contract.json 并复核注入层注册面）')
    }
  }
}

/**
 * 上游生产槽位声明枚举（G-1 的反向半）。§4b 只遍历「我们登记的 5 条」，所以上游**新长出来**的槽
 * 永远不会被看见——rc.1 相对 0.1.5 就多了一个 `shell.leading`（14 文件命中 / 0.1.5 零命中），
 * 账本对它一无所知。这里改成「上游声明全集 == 已登记全集」的集合等值判据：多一条即红（要判一次），
 * 少一条也即红（上游删槽 = 我们的注册静默落空）。
 * @returns slot → {kind, scope, file}，上游树不在场时返回 null。
 */
function scanUpstreamSlots() {
  const clientDir = join(root, contract.upstreamRepo, 'packages', 'client')
  if (!existsSync(clientDir)) return null
  const files = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'tests' && entry.name !== '__tests__') walk(p)
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) files.push(p)
    }
  }
  walk(clientDir)
  const rootRel = root.replaceAll('\\', '/')
  const toRel = (f) => f.replaceAll('\\', '/').slice(rootRel.length + 1)
  /* 只认生产声明面：packages/client/<pkg>/src/**，且排除测试目录与 *.test.ts(x)——上游测试夹具里
   * 造了一批假槽名（test.list / dynamic.a / spec.single …），混进来会让登记集与真实槽位面无关。 */
  const upRe = contract.upstreamRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const isProdDecl = (p) => new RegExp('^' + upRe + '/packages/client/[^/]+/src/').test(p)
    && !/\/(?:tests?|__tests__)\//.test(p) && !/\.(test|spec)\.tsx?$/.test(p)
  /* 上游两种写法：单行 `'x': { kind: 'list'; scope: 'root' }` 与跨行（type 字面量里无分隔符），
   * 故 kind/scope 之间只要求空白。 */
  const re = /'([a-z][a-zA-Z0-9._-]*(?:\.[a-zA-Z0-9._-]+)+)'\s*:\s*\{\s*kind\s*:\s*'([a-z]+)'\s*;?\s*scope\s*:\s*'([a-z]+)'/g
  const found = new Map()
  for (const abs of files) {
    const f = toRel(abs)
    if (!isProdDecl(f)) continue
    const text = readFileSync(abs, 'utf8')
    let m
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      if (!found.has(m[1])) found.set(m[1], { slot: m[1], kind: m[2], scope: m[3], file: f })
    }
  }
  return found
}

const CAPTURE_SLOTS = argv.includes('--capture-slots')
const slotReasonIdx = argv.indexOf('--accept-slot-diff')
const slotReason = slotReasonIdx >= 0 ? String(argv[slotReasonIdx + 1] ?? '') : ''

console.log('== 4c. 上游槽位全集（反向断言：上游新长出的槽必须判一次） ==')
{
  const universe = scanUpstreamSlots()
  if (universe === null) skip('上游树不在场 —— 槽位全集反向断言未执行')
  else if (universe.size === 0) fail('上游槽位枚举为空（树在场但一条没命中）—— 枚举范围/声明形态与判据假设不符，拒绝按空集继续判（这正是上一轮用 grep 误判 YAML 的那类事故）')
  else {
    const id = upstreamIdentity()
    const treeStamp = id === null ? 'unknown' : (id.describe ?? id.commit ?? 'unknown')
    let recorded = contract.clientSlots.upstreamUniverse
    if (recorded === undefined && !CAPTURE_SLOTS) {
      fail('contract.json 缺 clientSlots.upstreamUniverse：跑 `node scripts/check-contract.mjs --capture-slots --accept-slot-diff "<首次登记的理由>"` 生成')
    } else {
      const fresh = [...universe.values()].sort((a, b) => (a.slot < b.slot ? -1 : 1))
      const oldNames = new Map((recorded?.entries ?? []).map(e => [e.slot, e]))
      const added = fresh.filter(e => !oldNames.has(e.slot))
      const removed = [...oldNames.keys()].filter(s => !universe.has(s))
      const drifted = fresh.filter(e => oldNames.has(e.slot)
        && (oldNames.get(e.slot).kind !== e.kind || oldNames.get(e.slot).scope !== e.scope))
      if (CAPTURE_SLOTS) {
        if (added.length + removed.length + drifted.length > 0 && !slotReason.trim()) {
          fail('--capture-slots 会改判据范围（新增 ' + added.length + ' / 消失 ' + removed.length + ' / 漂移 ' + drifted.length + '），必须带 --accept-slot-diff "<理由>"')
        } else {
          contract.clientSlots.upstreamUniverse = {
            $comment: 'G-1 反向判据的登记集：上游**声明面**槽位全集（见 scanUpstreamSlots 的枚举范围），不是「上游一共有多少座位」的哲学断言——它只负责让「新长出来/被删掉」两类漂移判红。追版换树后必须重新 --capture-slots 并逐条判定新增项。',
            scanScope: 'packages/client/<pkg>/src/**（排除 tests/__tests__ 与 *.test.tsx）里的 `\'slot\': { kind: …; scope: … }`',
            capturedFrom: treeStamp,
            capturedReason: slotReason || (recorded?.capturedReason ?? '首次登记'),
            total: fresh.length,
            entries: fresh.map(e => ({ slot: e.slot, kind: e.kind, scope: e.scope, file: e.file })),
          }
          writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n')
          ok('--capture-slots 已登记 ' + fresh.length + ' 条上游槽位（树 ' + treeStamp + '，理由：' + contract.clientSlots.upstreamUniverse.capturedReason + '）'
            + (added.length + removed.length + drifted.length > 0
              ? '；本次范围变化：新增 ' + added.map(e => e.slot).join(',') + ' / 消失 ' + removed.join(',') + ' / 漂移 ' + drifted.map(e => e.slot).join(',')
              : ''))
        }
      } else if (recorded !== undefined) {
        if (recorded.capturedFrom !== treeStamp && treeStamp !== 'unknown') {
          fail('槽位全集登记自 ' + recorded.capturedFrom + '，当前上游树是 ' + treeStamp
            + '：换树后必须重跑 --capture-slots（否则 §4c 在拿旧集合判新树）')
        }
        if (added.length > 0) {
          fail('上游长出未登记的槽（' + added.length + ' 条）: ' + added.map(e => e.slot + '[' + e.kind + '/' + e.scope + ']').join(', ')
            + ' —— 每条要么显式判定不消费、要么登记消费面；判完再 --capture-slots --accept-slot-diff "<这一版判了什么>"')
        }
        if (removed.length > 0) {
          fail('上游删除了已登记的槽: ' + removed.join(', ')
            + ' —— 我们若仍注册它即静默落空（消费面判据 §4b 会单独报 kind/scope，这里先报「槽没了」）')
        }
        if (drifted.length > 0) {
          fail('上游槽 kind/scope 漂移: ' + drifted.map(e => e.slot + ' 登记=' + oldNames.get(e.slot).kind + '/' + oldNames.get(e.slot).scope + ' 现=' + e.kind + '/' + e.scope).join('; '))
        }
        if (added.length + removed.length + drifted.length === 0 && recorded.capturedFrom === treeStamp) {
          ok('上游槽位全集 == 登记（' + recorded.total + ' 条，树 ' + treeStamp + '；我们消费 ' + contract.clientSlots.declarations.length + ' 条）')
        }
      }
    }
  }
}

console.log('== 5. 环境契约键 ==')
const envText = readFileSync(join(root, contract.envContract.repo, 'src/index.ts'), 'utf8')
for (const key of contract.envContract.keys) {
  if (envText.includes(key)) ok('环境键 ' + key + ' 注入')
  else fail('环境键 ' + key + ' 未注入')
}

console.log('== 6. 版本钉（package.json vs contract.json；覆盖面 = scripts/plugin-dirs.json） ==')
// 覆盖清单（0.13.8-b ST-06 / F-ENV-05）：注入集单一常量的每个包都必须登记进 contract.inserted，
// 否则「peer 版本钉」对它们没有覆盖面（契约少登记一个包 = 该包的钉永远不被检查）。
const pluginManifest = JSON.parse(readFileSync(join(root, 'scripts', 'plugin-dirs.json'), 'utf8'))
const insertedRepos = new Set(contract.inserted.map(i => i.repo))
const uncovered = pluginManifest.dirs.filter(d => !insertedRepos.has(d))
if (uncovered.length > 0) fail('注入集未登记进 contract.inserted（版本钉无覆盖面）: ' + uncovered.join(', '))
else ok('注入集 ' + pluginManifest.dirs.length + ' 个包全部登记在 contract.inserted')

// 版本钉两面（devDependencies + peerDependencies）都要钉：只看 dev 会漏掉「发布面钉旧版」。
// 说明符允许 ^/~ 前缀（区间语义仍指向同一版本），其余严格等值。
const norm = (spec) => String(spec).replace(/^[\^~]/, '')
const expectedPin = (dep) => dep === '@deepseek-ai/cordis' ? contract.cordis
  : dep === '@deepseek-ai/schemastery' ? contract.schemastery
  : contract.baseline // @deepseek-ai/dsh-*
const isPinnedDep = (dep) => dep.startsWith('@deepseek-ai/dsh-')
  || dep === '@deepseek-ai/cordis' || dep === '@deepseek-ai/schemastery'
const deviations = (repo) => {
  const pkg = JSON.parse(readFileSync(join(root, repo, 'package.json'), 'utf8'))
  const out = new Set()
  for (const [dep, spec] of Object.entries({ ...(pkg.peerDependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
    if (!isPinnedDep(dep)) continue
    if (norm(spec) !== norm(expectedPin(dep))) out.add(dep + '@' + norm(spec))
  }
  return out
}
// 未对齐的显式声明（scripts/contract-pin-gaps.json）：§8.4 要求先对齐基线再扩门禁，
// 声明期内在场 = 红-able；对齐后条目变 stale 也会红，必须删除。
const gapsPath = join(root, 'scripts', 'contract-pin-gaps.json')
const pinGaps = existsSync(gapsPath) ? (JSON.parse(readFileSync(gapsPath, 'utf8')).gaps ?? []) : []
for (const ins of contract.inserted) {
  if (!existsSync(join(root, ins.repo, 'package.json'))) continue // 仓库缺失已在第 2 节报过
  const actual = [...deviations(ins.repo)].sort()
  const gap = pinGaps.find(g => g.repo === ins.repo)
  if (gap === undefined) {
    if (actual.length > 0) {
      fail(ins.repo + ': 版本钉偏离且未声明: ' + actual.join(', ')
        + '（基线 ' + contract.baseline + ' / cordis ' + contract.cordis + ' / schemastery ' + contract.schemastery + '）')
    } else ok(ins.repo + ': 版本钉 == 基线/cordis/schemastery')
    continue
  }
  if (!gap.reason || !String(gap.reason).trim()) { fail(ins.repo + ': contract-pin-gaps 条目缺 reason'); continue }
  const accepted = [...new Set(gap.accepted ?? [])].sort()
  const undeclared = actual.filter(d => !accepted.includes(d))
  const stale = accepted.filter(d => !actual.includes(d))
  if (undeclared.length > 0 || stale.length > 0) {
    fail(ins.repo + ': 声明与事实不符（未声明偏离: [' + undeclared.join(', ') + ']；已对齐却仍声明: [' + stale.join(', ') + ']）')
  } else ok(ins.repo + ': 版本钉偏离已显式声明（' + accepted.length + ' 项，基线 ' + contract.baseline + '）')
}
for (const g of pinGaps) {
  if (!contract.inserted.some(i => i.repo === g.repo)) {
    fail('contract-pin-gaps 声明了未登记进 contract.inserted 的仓库: ' + g.repo)
  }
}
ok('版本钉检查完成')

/**
 * §7 运行期兼容门禁（0.14.2 追版 N-1；AGENTS 铁律的「发版闸门」前置）。
 *
 * 上游从 0.1.7 起在 boot 期按 `package.json.peerDependencies` 判插件兼容性，不满足就**把整行置
 * disabled 并只在 stderr 打一行**（`packages/boot/app-boot/src/plugin-compatibility.ts:61-88`
 * + `compatibility-preflight.ts`）：进程照起、页面照开，只有我们的 shell 执行栅栏与响应式客户端
 * UI 双双缺席。本门禁把**同一个算法**在构建前跑一遍——判据必须与运行时逐字同构，否则门禁绿而设备丢插件。
 *
 * 运行时版本取自安装闭包（`engine-overlay.json` 的 `@deepseek-ai/dsh-app-boot`），**不是**
 * contract.baseline：设备上跑的是 overlay 说的那个版本，两者一旦不同步，说谎的是登记表 ⇒ 判红。
 */
console.log('== 7. 运行期兼容门禁（复刻上游 boot 期 peer 判定；不匹配即静默禁用） ==')

/** 解析与运行时同一个 semver：优先仓内/快照/全局引擎自带的副本（判据必须与设备侧同构）。 */
function resolveSemver() {
  const candidates = [
    join(root, 'node_modules', 'semver'),
    join(root, 'dsh', 'node_modules', 'semver'),
    join(root, '.deploy-tmp', 'snapshot-013', 'x86_64', 'stage', 'root', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'semver'),
    join(root, '.deploy-tmp', 'snapshot-013', 'arm64', 'stage', 'root', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'semver'),
  ]
  for (const repo of pluginManifest.dirs) candidates.push(join(root, repo, 'node_modules', 'semver'))
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'package.json'))) continue
    try {
      const req = createRequire(join(dir, 'noop.js'))
      const mod = req(join(dir, 'index.js'))
      if (typeof mod?.satisfies === 'function') {
        return { satisfies: mod.satisfies, origin: dir.slice(root.length + 1).replaceAll('\\', '/'), version: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version }
      }
    } catch { /* 副本不可用：继续找下一个候选 */ }
  }
  try {
    const req = createRequire(join(root, 'check-contract.mjs'))
    const mod = req('semver')
    if (typeof mod?.satisfies === 'function') return { satisfies: mod.satisfies, origin: 'bare semver', version: '(未记)' }
  } catch { /* 未安装 */ }
  return null
}

const overlayPath = join(root, 'scripts', 'snapshot-config', 'engine-overlay.json')
const runtimeOverrideIdx = argv.indexOf('--runtime')
const runtimeOverride = runtimeOverrideIdx >= 0 ? String(argv[runtimeOverrideIdx + 1] ?? '') : null
const semverImpl = resolveSemver()

if (!existsSync(overlayPath) || !existsSync(PROFILE_PATCH_PATH) || semverImpl === null) {
  const missing = [
    existsSync(overlayPath) ? null : 'engine-overlay.json',
    existsSync(PROFILE_PATCH_PATH) ? null : 'profile-web.cordis.patch.yml',
    semverImpl === null ? 'semver（设备侧 app-boot 用的同一个库）' : null,
  ].filter(Boolean)
  skip('运行期兼容门禁缺输入: ' + missing.join(' + ')
    + (semverImpl === null ? ' —— 取用面：快照 stage 的 @deepseek-ai/dsh/node_modules/semver（跑过 build-snapshot 即在）、任一插件的 node_modules/semver，或 contract.json 同层 npm 安装；本门禁只在拿不到时 SKIP，拿到即必判' : ''))
} else {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
  const runtimePinned = overlay.packages['@deepseek-ai/dsh-app-boot']
  const runtime = runtimeOverride ?? runtimePinned
  if (runtime === undefined) fail('engine-overlay.json 里没有 @deepseek-ai/dsh-app-boot 钉 —— 运行时版本无从确定')
  else {
    if (runtimeOverride !== null) console.log('  NOTE  --runtime=' + runtimeOverride + ' 是**反证用覆盖**（不是设备事实）：把目标运行时装成下一版，验本门禁会不会判红')
    if (runtimePinned !== overlay.engineVersion) fail('overlay.engineVersion=' + overlay.engineVersion + ' ≠ packages[@deepseek-ai/dsh-app-boot]=' + runtimePinned + '（登记表内部不自洽）')
    if (runtimeOverride === null && runtimePinned !== contract.baseline) {
      fail('安装闭包运行时 ' + runtimePinned + ' ≠ contract.baseline ' + contract.baseline
        + '：§1/§3/§4 的上游面判据在拿 baseline 那棵树判、设备却跑 ' + runtimePinned + '（追版两步没走完：切树 + 抬登记表）')
    } else if (runtimeOverride === null) ok('运行时版本 == baseline == overlay app-boot 钉（' + runtimePinned + '）')
    console.log('  INFO  semver 取用: ' + semverImpl.origin + '（v' + semverImpl.version + '，与设备侧 app-boot 用的同一实现）')

    let ourMountRows
    try { ourMountRows = parseCordisRows(readFileSync(PROFILE_PATCH_PATH, 'utf8'), '本机 profile-web.cordis.patch.yml') } catch (e) { fail(String(e.message ?? e)) }
    if (ourMountRows !== undefined) {
      const mounts = {
        inserts: ourMountRows.filter(r => r.inInsert),
        disabled: ourMountRows.filter(r => !r.inInsert && r.disabled).map(r => r.id),
      }
      ok('profile patch 解析: ' + mounts.inserts.length + ' 条 insert + ' + mounts.disabled.length + ' 条 disabled')
      const nameToRepo = new Map()
      for (const dir of [...pluginManifest.dirs, ...pluginManifest.externals]) {
        const pkgPath = join(root, dir, 'package.json')
        if (!existsSync(pkgPath)) continue
        nameToRepo.set(JSON.parse(readFileSync(pkgPath, 'utf8')).name, dir)
      }
      const mountNames = new Set(mounts.inserts.map(r => r.name))
      const ghostMounted = [...mountNames].filter(n => !n.startsWith('@deepseek-ai/') && !nameToRepo.has(n))
      if (ghostMounted.length > 0) fail('profile patch 挂了仓库里不存在的包（注入链会带一个空壳）: ' + ghostMounted.join(', '))
      const registeredNotMounted = contract.inserted.map(i => i.pkg).filter(n => !mountNames.has(n))
      if (registeredNotMounted.length > 0) fail('contract.inserted 登记但 profile patch 不挂载（幽灵登记）: ' + registeredNotMounted.join(', '))
      if (ghostMounted.length === 0 && registeredNotMounted.length === 0) ok('insert 行 ↔ 仓库/登记表 双向一致（' + mountNames.size + ' 条）')

      const compat = contract.runtimeCompat ?? {}
      const noPeerAdjudicated = new Map((compat.noPeerRows ?? []).map(r => [r.rowId, r]))
      const exemptions = compat.exemptions ?? []
      let judged = 0
      let rejected = 0
      for (const row of mounts.inserts) {
        if (row.name.startsWith('@deepseek-ai/')) {
          const pinned = overlay.packages[row.name]
          if (pinned === undefined) fail('insert 行 ' + row.id + ' 引用的引擎包 ' + row.name + ' 不在安装闭包（挂载静默失败）')
          else if (pinned !== runtimePinned) fail('insert 行 ' + row.id + ' 的 ' + row.name + '@' + pinned + ' ≠ 运行时 ' + runtimePinned + '（跨版混挂：上游 peer 门禁会拒）')
          else { judged += 1; ok('insert ' + row.id + ': 引擎包 ' + row.name + '@' + pinned + ' 与运行时同版') }
          continue
        }
        const repo = nameToRepo.get(row.name)
        if (repo === undefined) continue // 上面已按幽灵判红
        const pkg = JSON.parse(readFileSync(join(root, repo, 'package.json'), 'utf8'))
        const peers = pkg.peerDependencies
        if (peers === undefined || Object.keys(peers).length === 0
          || !Object.keys(peers).some(n => n === '@deepseek-ai/dsh' || n.startsWith('@deepseek-ai/dsh-'))) {
          /* 上游算法在这里是 fail-open（plugin-compatibility.ts:68「无 peerDependencies 键即放行」）
           * ⇒ 门禁反过来要求显式判定：不声明 peer 的行走的是「上游不管」而不是「验过兼容」。 */
          const adjud = noPeerAdjudicated.get(row.id)
          if (adjud === undefined) fail('insert ' + row.id + '（' + row.name + '）没有任何 @deepseek-ai/dsh* peer —— 上游按 fail-open 放行，但那是"没判"不是"兼容"：请在 contract.runtimeCompat.noPeerRows 登记判定与理由')
          else if (!adjud.why || !String(adjud.why).trim()) fail('noPeerRows[' + row.id + '] 缺 why')
          else { judged += 1; ok('insert ' + row.id + ': 无 dsh peer，已显式判定（' + adjud.why + '）') }
          continue
        }
        const bad = {}
        for (const [name, range] of Object.entries(peers)) {
          if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
          if (typeof range !== 'string') { fail('insert ' + row.id + ' 的 peerDependencies[' + name + '] 不是字符串（上游会 throw，整个清单读不出）'); continue }
          const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range
          if (requirement.trim() === '' || !semverImpl.satisfies(runtime, requirement, { includePrerelease: true })) bad[name] = range
        }
        if (Object.keys(bad).length === 0) { judged += 1; ok('insert ' + row.id + '（' + pkg.name + '@' + pkg.version + '）peer 全部满足运行时 ' + runtime); continue }
        const key = pkg.name + '@' + pkg.version
        const grant = exemptions.find(e => e.key === key && e.runtime === runtime)
        if (grant !== undefined && grant.why) {
          judged += 1
          fail('insert ' + row.id + ' 走了精确豁免（' + key + ' on ' + runtime + '）：设备侧 compatibility.json 会放行，但豁免按「插件版本 × 运行时版本」精确匹配，任一变动即重新判红 —— 本版不允许带着它发布，请抬 peer')
          rejected += 1
          continue
        }
        rejected += 1
        fail('insert ' + row.id + '（' + key + '）在运行时 ' + runtime + ' 会被**静默禁用**：不满足的 peer = '
          + JSON.stringify(bad) + ' —— 症状是设备上功能面消失而进程照常起（stderr 只有一行 disabling profile plugin row）。'
          + '处置：把这些 peer 抬到 ' + runtime + '（不是留兼容性豁免），或按上游 `dsh plugin allow-version` 显式登记进 contract.runtimeCompat.exemptions 并说明为什么本版必须留。')
      }
      console.log('  INFO  运行期兼容判定：' + judged + ' 条过、' + rejected + ' 条会被禁用（insert 共 ' + mounts.inserts.length + ' 条），semver 语义 = includePrerelease:true')
    }
  }
}

/**
 * cordis patch 文件的行解析（§7 与 §8 共用一份，避免「我们的文件按固定缩进解析、上游的文件按另一套
 * 正则解析」这种双标——上一轮的教训正是拿 grep 猜 YAML 序列成员）。
 * 归属规则用**缩进**：`- id:` 之后的同块属性必须比该 `-` 更缩进；`- insert:` 之下的行才是插行。
 * @returns 每行 {id, name, disabled, inInsert}
 * @throws 形态与假设不符时抛出（调用方判红）——绝不按空集合继续。
 */
function parseCordisRows(text, label) {
  const lines = String(text).split(/\r?\n/)
  const rows = []
  let cur = null
  let insertDepth = null
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const ind = raw.length - raw.trimStart().length
    const ins = /^(\s*)- insert:\s*$/.exec(raw)
    if (ins !== null) { insertDepth = ins[1].length; cur = null; continue }
    if (insertDepth !== null && ind <= insertDepth) insertDepth = null
    const idm = /^(\s*)- id:\s*(\S+)\s*$/.exec(raw)
    if (idm !== null) {
      cur = { id: idm[2], name: null, disabled: false, indent: idm[1].length, inInsert: insertDepth !== null }
      rows.push(cur)
      continue
    }
    if (cur === null) continue
    if (ind <= cur.indent) { cur = null; continue }
    const kv = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(raw)
    if (kv === null) continue
    if (kv[1] === 'name' && cur.name === null) cur.name = kv[2].trim().replace(/^['"]|['"]$/g, '')
    else if (kv[1] === 'disabled') cur.disabled = /^true\b/.test(kv[2].trim())
  }
  const unnamed = rows.filter(r => r.inInsert && r.name === null)
  if (unnamed.length > 0) throw new Error(label + ': insert 行缺 name（形态与判据假设不符，需人工核对）: ' + unnamed.map(r => r.id).join(', '))
  if (rows.length === 0) throw new Error(label + ': 解析结果为空——拒绝按空集继续判')
  return rows
}

/** 上游 bundle（base + web-app）出现的全部行 id；任一 bundle 不在场即返回 null（由调用方 SKIP）。 */
function scanUpstreamRows() {
  const out = new Map()
  for (const bundle of ['base', 'web-app']) {
    const p = join(root, contract.upstreamRepo, 'packages', 'bundle', bundle, 'cordis.patch.yml')
    if (!existsSync(p)) return null
    let rows
    try { rows = parseCordisRows(readFileSync(p, 'utf8'), '上游 ' + bundle + ' bundle') }
    catch (e) { fail(String(e.message ?? e)); continue }
    for (const r of rows) if (!out.has(r.id)) out.set(r.id, { key: r.id, name: r.name ?? '', upstreamDisabled: r.disabled, bundle })
  }
  return out
}

const CAPTURE_ROWS = argv.includes('--capture-rows')
const rowReasonIdx = argv.indexOf('--accept-row-diff')
const rowReason = rowReasonIdx >= 0 ? String(argv[rowReasonIdx + 1] ?? '') : ''

console.log('== 8. 上游行面不变量（G-4：我们禁用的行必须还在；上游新增行必须判一次） ==')
{
  const upRows = scanUpstreamRows()
  if (upRows === null) skip('上游 bundle patch 不在场 —— 行面不变量未执行')
  else if (upRows.size === 0) fail('上游行枚举为空——解析器与上游形态不符，拒绝按空集继续判')
  else if (!existsSync(PROFILE_PATCH_PATH)) skip('profile patch 不在场 —— 行面不变量未执行')
  else {
    let ourRows
    try { ourRows = parseCordisRows(readFileSync(PROFILE_PATCH_PATH, 'utf8'), '本机 profile-web.cordis.patch.yml') }
    catch (e) { fail(String(e.message ?? e)) }
    if (ourRows !== undefined) {
      /* (a) 每个 `disabled: true` 的目标必须在上游存在。判红理由要说清「静默」在哪：
       * 我们禁用一条上游已改名/已删除的行 = 这行 YAML 变成无害的空指向，而上游那条真行**照常挂载**
       * —— 0.14.1 的 client-hmr 与 rc.1 的 hmr/dsh-hmr 换名就是这个形态。 */
      const ourDisabled = ourRows.filter(r => !r.inInsert && r.disabled)
      const ghost = ourDisabled.filter(r => !upRows.has(r.id))
      if (ourDisabled.length === 0) fail('profile patch 解析出 0 条 disabled 顶层行——与现网形态不符（0.14.2-fx-2 起实测为 6 条：agent-default-model 改走同 id config 覆盖后由 7 减为 6），判红不放行')
      else if (ghost.length > 0) {
        fail('profile patch 禁用了上游不存在的行（禁用即空指向，上游那条真行照常挂载）: '
          + ghost.map(r => r.id).join(', ') + ' —— 上游改名/删除时必然出现；请核对新行 id 后改 profile，别删了这条 YAML 当没事发生')
      } else ok('profile patch 的 ' + ourDisabled.length + ' 条 disabled 目标全部在上游存在（base+web-app 共 ' + upRows.size + ' 个行 id）')
      const alreadyUp = ourDisabled.filter(r => upRows.has(r.id) && upRows.get(r.id).upstreamDisabled)
      if (alreadyUp.length > 0) {
        console.log('  NOTE  其中 ' + alreadyUp.length + ' 条上游自己就带 disabled: true（我们的禁用是二次声明，无害但冗余）: '
          + alreadyUp.map(r => r.id).join(', '))
      }
      /* (b) 上游行全集 == 登记集：新增行必须判一次（挂 or 禁），删除行必须看见。 */
      const id = upstreamIdentity()
      const treeStamp = id === null ? 'unknown' : (id.describe ?? id.commit ?? 'unknown')
      const fresh = [...upRows.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
      let recorded = contract.upstreamRows
      const cmpOf = (rec) => {
        const old = new Map(rec.entries.map(e => [e.key, e]))
        return {
          old,
          added: fresh.filter(f => !old.has(f.key)),
          removed: [...old.keys()].filter(k => !upRows.has(k)),
          drifted: fresh.filter(f => old.has(f.key) && (old.get(f.key).name !== f.name || old.get(f.key).bundle !== f.bundle)),
        }
      }
      if (recorded === undefined && !CAPTURE_ROWS) {
        fail('contract.json 缺 upstreamRows：跑 `node scripts/check-contract.mjs --capture-rows --accept-row-diff "<理由>"` 生成')
      } else if (CAPTURE_ROWS) {
        if (recorded !== undefined) {
          const c = cmpOf(recorded)
          if (c.added.length + c.removed.length + c.drifted.length > 0 && !rowReason.trim()) {
            fail('--capture-rows 会改判据范围（新增 ' + c.added.length + ' / 消失 ' + c.removed.length + ' / 漂移 ' + c.drifted.length + '），必须带 --accept-row-diff "<这一版判了什么>"')
          } else {
            contract.upstreamRows = {
              $comment: 'G-4 判据的登记集：上游 base + web-app 两个 bundle 的全部行 id（含我们未挂载的）。新增行必须逐条判「挂载 / 明确不挂」后重新登记——0.14.2 追版时 `mcp-resources` 这类新行走的就是这里。',
              capturedFrom: treeStamp, capturedReason: rowReason || '首次登记', total: fresh.length, entries: fresh,
            }
            writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n')
            ok('--capture-rows 已登记 ' + fresh.length + ' 条上游行 id（树 ' + treeStamp + '）')
          }
        } else {
          contract.upstreamRows = {
            $comment: 'G-4 判据的登记集：上游 base + web-app 两个 bundle 的全部行 id（含我们未挂载的）。新增行必须逐条判「挂载 / 明确不挂」后重新登记。',
            capturedFrom: treeStamp, capturedReason: rowReason || '首次登记', total: fresh.length, entries: fresh,
          }
          writeFileSync(CONTRACT_PATH, JSON.stringify(contract, null, 2) + '\n')
          ok('--capture-rows 已登记 ' + fresh.length + ' 条上游行 id（树 ' + treeStamp + '）')
        }
      } else {
        if (recorded.capturedFrom !== treeStamp && treeStamp !== 'unknown') {
          fail('上游行集登记自 ' + recorded.capturedFrom + '，当前上游树是 ' + treeStamp + '：换树后必须重跑 --capture-rows')
        } else {
          const c = cmpOf(recorded)
          if (c.added.length > 0) {
            fail('上游新增未判定的行（' + c.added.length + ' 条）: '
              + c.added.map(e => e.key + '(' + e.name + '@' + e.bundle + (ourRows.some(r => r.id === e.key) ? ', 我们已挂/已禁' : '') + ')').join(', ')
              + ' —— 每条都要判「挂载还是禁用」；默认不判 = 上游往移动设备上塞了一个我们没审过的面（G-2 的 mcp-resources 就是这个形态）')
          }
          if (c.removed.length > 0) fail('上游删除了已登记的行: ' + c.removed.join(', ') + '（我们若仍引用它即空指向）')
          if (c.drifted.length > 0) fail('上游行的包名/bundle 归属漂移: ' + c.drifted.map(e => e.key + ' 登记=' + c.old.get(e.key).name + '@' + c.old.get(e.key).bundle + ' 现=' + e.name + '@' + e.bundle).join('; '))
          if (c.added.length + c.removed.length + c.drifted.length === 0) {
            ok('上游行全集 == 登记（' + recorded.total + ' 条，树 ' + treeStamp + '）')
          }
        }
      }
    }
  }
}

console.log('== 9. 人读契约文档与登记表同源（G-8：它会误导开工） ==')
{
  /* docs/UPSTREAM-CONTRACT.md 历史上把清单复述了一遍，然后三次追版没人同步：基线停在 0.1.0-rc.6、
   * 禁用行名单里留着早已启用的 ui-layout、继承面写着上游已删的 runArgv/startArgv。
   * 现在它是「只讲语义」的文档，但仍会误导 ⇒ 至少把它与登记表的可锚定字段钉死：基线字样 + 非权威源声明。 */
  const docPath = DOC_PATH
  if (!existsSync(docPath)) {
    if (APK_SELF_CONTAINED) softSkip('docs/UPSTREAM-CONTRACT.md 不在场（协调仓独有文档）—— 文档同源性未执行')
    else skip('docs/UPSTREAM-CONTRACT.md 不在场 —— 文档同源性未执行（协调仓布局下必须存在）')
  }
  else {
    const doc = readFileSync(docPath, 'utf8')
    if (!doc.includes(contract.baseline)) {
      fail(rel(docPath) + ' 不含当前基线 ' + contract.baseline
        + '：文档里的版本/成员名是上一基线的（正是它把开工的人带错路的那次）。抬 baseline 时同批改文档。')
    } else ok('文档基线字样 == contract.baseline（' + contract.baseline + '）')
    if (!/非权威源/.test(doc) || !/contract\.json/.test(doc)) {
      fail(rel(docPath) + ' 必须显式声明「权威源是 scripts/contract.json」——它读起来像权威源时，漂移比缺席更危险')
    } else ok('文档已声明自己非权威源并指向 contract.json')
  }
}

if (skipped > 0) console.log('SKIP=' + skipped)

/**
 * issue #1114：依赖树缺席 ≠ 通过。
 *
 * 旧行为：上游声明文件不在场时只打一条 `SKIP(#n)` 就继续，最后照样 `CONTRACT PASS`。
 * 于是「槽位声明面」这整段在干净 checkout 里**从未被执行过**，却一直报绿。
 *
 * 三态必须可区分（与 check-dead-tokens.mjs 同口径）：
 *   0 = 判据跑了且通过；1 = 判据跑了且不通过；2 = 判据没跑（依赖缺席）。
 *
 * 例外：`softSkip` 记的是**自包含树里协调仓独有输入**的合法缺席（APK_SELF_CONTAINED），
 * 那类不计入 hardSkip —— 它是「这一侧本来就不负责这条判据」，不是「该验却没验」。
 */
if (issues.length > 0) {
  console.error('')
  console.error('CONTRACT FAIL (' + issues.length + '):')
  for (const i of issues) console.error('  - ' + i)
  process.exit(1)
}
if (hardSkip > 0) {
  if (!ALLOW_MISSING) {
    console.error('')
    console.error('CONTRACT DEPENDENCY-ABSENT (' + hardSkip + ' 处判据未执行):')
    console.error('  上游树（' + contract.upstreamRepo + '）不在场，' + hardSkip + ' 个槽位声明面没被核对。')
    console.error('  这不是通过，也不是被测对象有缺陷 —— 是「本次没验」。')
    console.error('  请先拉取上游树，或在确实无法拉取的场合显式传 --allow-missing 声明接受。')
    process.exit(2)
  }
  console.error('')
  console.error('CONTRACT SKIPPED（--allow-missing：调用方已显式接受 ' + hardSkip + ' 处判据未执行）')
}
console.log('')
console.log('CONTRACT PASS（SKIP=' + skipped + '）')

/**
 * 反证夹具：每条新判据配一个「改坏必须判红」的用例。
 * 每个用例把改坏的登记表/装配清单写进临时目录，用 --contract / --profile 指给子进程 ⇒
 * 仓库文件全程不动（`--capture-*` 也不会被触发，因为子进程不带捕获档）。
 */
function runContractSelfTest() {
  const gateFile = fileURLToPath(import.meta.url)
  const pristineContract = JSON.parse(readFileSync(join(root, 'scripts', 'contract.json'), 'utf8'))
  const pristineProfile = readFileSync(join(root, 'scripts', 'profile-web.cordis.patch.yml'), 'utf8')
  const pristineDoc = existsSync(join(root, 'docs', 'UPSTREAM-CONTRACT.md'))
    ? readFileSync(join(root, 'docs', 'UPSTREAM-CONTRACT.md'), 'utf8') : null
  const scratch = mkdtempSync(join(tmpdir(), 'contract-selftest-'))
  const dropSlot = (c) => { c.clientSlots.upstreamUniverse.entries = c.clientSlots.upstreamUniverse.entries.filter(e => e.slot !== 'shell.overlay') }
  const fakeSlot = (c) => { c.clientSlots.upstreamUniverse.entries.push({ slot: 'zzz.selftest.not.upstream', kind: 'list', scope: 'root', file: 'nowhere' }) }
  const cases = [
    { label: '对照组：现状登记表必须全绿', expect: null },
    { label: '§0 树身份判红：登记的 commit 不是树上的 commit', mutate: c => { c.upstream.commit = 'aa00000000000000000000000000000000000000' }, expect: /≠ 登记 commit/ },
    { label: '§4b 声明面判红：把某槽登记的 kind 改成单值', mutate: c => { c.clientSlots.declarations[0].kind = 'single' }, expect: /声明漂移/ },
    /* ── issue #1021：空集恒真（判据整段被条件包住，空输入时静默消失）────────────────
     * 旧实现在 declarations 为空时**整段不执行**，门禁照打 CONTRACT PASS 且 SKIP 计数变小。
     * 这两条负控要证明的是「清空之后仍然判红」，且理由点的是 §4b 的声明面本身。 */
    { label: '#1021 声明面清空 → 判红（不得整段静默消失）', mutate: c => { c.clientSlots.declarations = [] }, expect: /declarations 为空/ },
    { label: '#1021 声明面不是数组 → 判红（不得静默降级成空集）', mutate: c => { c.clientSlots.declarations = null }, expect: /不是数组/ },
    { label: '#1021 声明面登记了未在 slots 里的槽 → 判红（规模关系）', mutate: c => { c.clientSlots.declarations.push({ slot: 'zzz.selftest.unregistered', file: 'nowhere', kind: 'list', scope: 'root' }) }, expect: /未在 clientSlots\.slots 登记/ },
    { label: '§4c 反向判红：登记集漏一条（上游实有 = 未登记的槽）', mutate: dropSlot, expect: /上游长出未登记的槽/ },
    { label: '§4c 反向判红：登记集多一条（上游已无 = 静默落空）', mutate: fakeSlot, expect: /上游删除了已登记的槽/ },
    { label: '§4c 反向判红：登记的 kind 与上游声明不一致', mutate: c => { c.clientSlots.upstreamUniverse.entries.find(e => e.slot === 'settings.section').kind = 'chain' }, expect: /kind\/scope 漂移/ },
    { label: '§4c 树身份判红：登记集来自另一棵树', mutate: c => { c.clientSlots.upstreamUniverse.capturedFrom = 'dsh-v0.0.0-selftest' }, expect: /槽位全集登记自 dsh-v0\.0\.0-selftest/ },
    { label: '§8 行面判红：禁用了一条上游不存在的行（改名/删除形态）', profile: t => t.replace('- id: client-hmr', '- id: client-hmr-upstream-renamed'), expect: /禁用了上游不存在的行/ },
    { label: '§8 行面判红：上游行登记集多一条', mutate: c => { c.upstreamRows.entries.push({ key: 'zzz-selftest-row', name: '@dsh-android/nope', upstreamDisabled: false, bundle: 'base' }) }, expect: /上游删除了已登记的行/ },
    { label: '§8 行面判红：上游行登记集漏一条', mutate: c => { c.upstreamRows.entries = c.upstreamRows.entries.filter(e => e.key !== 'timer') }, expect: /上游新增未判定的行/ },
    { label: '§7 幽灵插行判红：profile 挂了一个仓库里不存在的包', profile: t => t.replace("'@dsh-android/dsh-host-web-compat'", "'@dsh-android/dsh-nope'"), expect: /profile patch 挂了仓库里不存在的包/ },
    { label: '§7 fail-open 判红：抹掉无 peer 行的显式判定', mutate: c => { c.runtimeCompat.noPeerRows = [] }, expect: /没有任何 @deepseek-ai\/dsh\* peer/ },
    /* 反证要钉在「未来的运行时」上没有意义（抬版后它就变成现状）；这里装一个任何 peer
     * 都不可能满足的版本，判据必须逐行判红——这才与追版进度无关。 */
    { label: '§7 静默禁用判红：运行时装成不可满足的 0.0.1-rc.1（每行 peer 都必须被拒）', extra: ['--runtime', '0.0.1-rc.1'], expect: /会被\*\*静默禁用\*\*/ },
    { label: '§9 文档同源判红：文档里的基线字样被抹掉', doc: t => t.split(contract.baseline).join('0.0.0-stale'), expect: /不含当前基线/ },
    { label: '§9 文档同源判红：文档删掉「非权威源」声明（漂移比缺席更危险的那种）', doc: t => t.replace(/非权威源/g, '参考'), expect: /必须显式声明/ },
    /* ── G-P4b：§4 双向判据的自证（本轮门禁盲区，两个方向各一例）──────────────────
     * 反例走 `--slots-source` 指向临时「消费面」文件 —— 不动仓库源码，也不依赖 index.ts 的真实内容。
     * slotsSource 给出「我方源码消费了哪些槽」，与临时登记表求对称差集。 */
    {
      label: '§4 双向正例：消费面与登记表一致 == 绿',
      kind: null,
      slotsSource: (c) => c.clientSlots.slots.map((s) => "ctx.slots.inject('" + s + "', () => ctx.slots.register({}))").join('\n') + '\n',
      expect: null,
    },
    {
      label: '§4 双向反例：源码消费了但登记表漏登记 == 红（本轮真盲区）',
      kind: null,
      slotsSource: (c) => c.clientSlots.slots.map((s) => "ctx.slots.inject('" + s + "', () => ctx.slots.register({}))").join('\n')
        + '\nctx.slots.inject(\'conversation.header.trailing\', () => ctx.slots.register({}))\n',
      expect: /已在我方源码消费（slots\.inject）但未登记/,
    },
    {
      label: '§4 反例：登记了但源码未消费（既有方向不得退化）',
      kind: null,
      slotsSource: (c) => c.clientSlots.slots.slice(1).map((s) => "ctx.slots.inject('" + s + "', () => ctx.slots.register({}))").join('\n') + '\n',
      expect: /槽位 .* 未组合/,
    },
    {
      label: '§4 反例：动态注册（非字面量槽名）不得静默通过',
      kind: null,
      slotsSource: (c) => c.clientSlots.slots.map((s) => "ctx.slots.inject('" + s + "', () => ctx.slots.register({}))").join('\n')
        + '\nctx.slots.inject(slotName, () => ctx.slots.register({}))\n',
      expect: /动态注册的槽位无法与登记表对齐/,
    },
    {
      label: '§4 反例：注释里的 inject 不算消费（不得被注释骗绿）',
      kind: null,
      slotsSource: (c) => c.clientSlots.slots.slice(1).map((s) => "ctx.slots.inject('" + s + "', () => ctx.slots.register({}))").join('\n')
        + '\n// ctx.slots.inject(\'' + c.clientSlots.slots[0] + '\', () => ctx.slots.register({}))\n',
      expect: /槽位 .* 未组合/,
    },
  ]
  let bad = 0
  let inertCount = 0
  /* 用例属于哪一节由 label 前缀决定（§7 需要安装闭包+semver；§0/§4/§8 需要上游 checkout）。
   * 反例落不红有两种原因必须分开：判据失灵（真事故） vs 本布局压根没跑那段判据
   * ——apk 自包含树没有 dsh/ checkout，若把「没跑」报成 PASS，镜像侧的 SELFTEST PASS 就是在
   * 替一节没执行的代码背书，所以这里如实报 N/A 并单独计数。 */
  const NA_REASONS = {
    compat: /运行期兼容门禁缺输入/,
    tree: /上游树 |上游声明文件不在场|上游 bundle patch 不在场|槽位全集反向断言未执行|行面不变量未执行|上游树身份未执行/,
    doc: /文档同源性未执行/,
  }
  /* 用例可显式声明 kind：§4 的双向判据只依赖**我方源码**，不依赖上游 checkout，
   * 故必须显式 kind:null —— 否则会被按 label 归到 tree 类，在缺 checkout 的布局里
   * 被当成「本布局未执行」而静默不计自证（新判据反而失去自证，属假绿方向）。 */
  const needKind = (kase) => kase.kind !== undefined ? kase.kind : (kase.label.startsWith('§7') ? 'compat'
    : kase.label.startsWith('§9') ? 'doc' : /^§[048]/.test(kase.label) ? 'tree' : null)
  for (const [i, kase] of cases.entries()) {
    const c = structuredClone(pristineContract)
    if (kase.mutate !== undefined) kase.mutate(c)
    const cPath = join(scratch, 'contract-' + i + '.json')
    const pPath = join(scratch, 'profile-' + i + '.yml')
    writeFileSync(cPath, JSON.stringify(c, null, 2) + '\n')
    writeFileSync(pPath, kase.profile === undefined ? pristineProfile : kase.profile(pristineProfile))
    const dPath = kase.doc === undefined || pristineDoc === null ? null : join(scratch, 'doc-' + i + '.md')
    if (dPath !== null) writeFileSync(dPath, kase.doc(pristineDoc))
    // G-P4b：§4 双向判据的取面改道缝——把「我方消费面」写成临时文件（内容由 kase.slotsSource(c) 生成），
    // 于是「消费了未登记」这类反例不需要动仓库源码。
    const sPath = kase.slotsSource === undefined ? null : join(scratch, 'slots-' + i + '.ts')
    if (sPath !== null) writeFileSync(sPath, kase.slotsSource(c))
    /* --allow-missing：自证验的是**判据逻辑**，不是「上游树就绪」。
     * issue #1114 之后，依赖缺席会让门禁 exit 2 —— 若不传它，缺上游 checkout 的布局里
     * 全部用例都会因 exit 2 而"红"，自证就变成在测环境而不是测判据。 */
    const r = spawnSync(process.execPath,
      [gateFile, '--contract', cPath, '--profile', pPath, '--allow-missing', ...(dPath === null ? [] : ['--doc', dPath]), ...(sPath === null ? [] : ['--slots-source', sPath]), ...(kase.extra ?? [])],
      { encoding: 'utf8' })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const firstFail = (out.split(/\r?\n/).find(l => /^\s+FAIL/.test(l)) ?? '').trim()
    /* expect === null 的对照组要求「红不许出现」；其余用例要求「必须红，且红在本判据上」——
     * 只判 exitCode 会被别处的红蒙对，所以这里匹配的是判据文案。 */
    const kind = needKind(kase)
    const inert = kase.expect !== null && r.status === 0 && kind !== null && NA_REASONS[kind].test(out)
    const hit = inert ? true
      : kase.expect === null ? (r.status === 0 && !/^\s+FAIL/m.test(out)) : (r.status !== 0 && kase.expect.test(out))
    console.log((inert ? 'N/A   ' : hit ? 'PASS  ' : 'FAIL  ') + kase.label
      + (inert ? ' -> 本布局未执行该段判据（缺上游 checkout / 安装闭包输入），此例不计自证'
        : hit ? '' : ' -> exit=' + r.status + (kase.expect === null ? '（对照组出现红）' : '；首条红: ' + firstFail.slice(0, 130))))
    if (!hit) bad += 1
    if (inert) inertCount += 1
  }
  rmSync(scratch, { recursive: true, force: true })
  console.log(bad === 0
    ? '\nCONTRACT SELFTEST PASS（判红自证 ' + (cases.length - inertCount) + ' 例全中'
      + (inertCount > 0 ? '；另 ' + inertCount + ' 例本布局未执行，未计自证' : '') + '）'
    : '\nCONTRACT SELFTEST FAILED ' + bad + '/' + cases.length)
  process.exit(bad === 0 ? 0 : 1)
}
