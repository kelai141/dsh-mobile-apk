#!/usr/bin/env node
// check-browser-syntax-floor.mjs — 浏览器语法下限门禁（0.14.1 块C / 详档 G-1，docs/0.14.1-preview-LEGACY-AND-PERF.md §2.2、§5.2）
//
// 背景（A 档产物级实证）：已发布快照的浏览器面产物里，dsh-web-frontend 入口 chunk 含 ES2022 的
// 「类静态初始化块」static{}（Chromium 94+ 才有），WebView < 94 解析期抛 SyntaxError → 入口模块一行不执行
// → 纯白无线索。此前 27 个 check-*.mjs 没有任何一条校验「发往浏览器的 bundle 语法下限」。
//
// 本门禁两条正交判据（缺一即假绿）：
//   判据 1（结构断言，真实解析器）：TypeScript AST（ScriptTarget.ESNext + ScriptKind.JS）断言
//     ClassStaticBlockDeclaration 计数 == 0 且 parseDiagnostics.length === 0。AST 天然免疫
//     字符串/模板/注释载荷（词法阶段即区分），并给出 行:列 + 字节偏移 定位。
//   判据 2（真实降级差分）：对同一份原始字节跑两个 arm：--target=esnext（A）与 --target=chrome87（B）。
//     A != B ⇒ 该产物携带「esbuild 的 chrome87 口径需要降级、但当前构建未降级」的语法。
//   清单（两条判据共用，防口径分裂）：dsh-web-frontend/dist/**/*.js 的全部 + 每一个 lib/client.js
//     （含 home/.dsh/profiles/** 下的镜像副本），不是只有入口 chunk，也不是只有 dsh-client-ui-* 前缀。
//
// 严格禁止（详档 §2.2 / §5.2，已实测证伪）：
//   - 任何 grep / readFileSync().includes() 形式的语法判断：对 4 类载荷全部误报，且在真实产物上
//     把 documentpreview 的 1 处真语法多报成 2 处（另一处落在 StringLiteral 内）。
//   - 用「二次降级逐字节相同」当 anti-no-op 判据：该不变量**不成立**（实测 documentpreview 二遍输出
//     差 144 B，来自 /* @__PURE__ */ 注解重排）。判绿一律用「降级后双 arm 差分归零」+ AST 复扫。
//   本文件全篇不含任何文本在场式语法判断；载荷对照在 --self-test 里用 4 用例自证。
//
// 口径边界（必须如实标注，不得声称已满足 Chromium 87）：判据 2 的效力完全取决于 esbuild 的兼容表，
// 该表**不是 MDN 支持表**——实测 esbuild 在 chrome87 下降 optional-chain / class-static-blocks /
// 若干 RegExp 特性，但**不降** nullish-coalescing（Chromium 80）/ logical-assignment（85）/ 类字段 /
// 私有成员 / 对象展开。因此「差分归零」只证明「不低于 esbuild 的 chrome87 口径」。
//
// 依赖（非协调仓已声明依赖，必须显式定位并固定版本，不得依赖偶然在场）：
//   - typescript：从固定的候选路径解析（plugins/*/node_modules 先于 node_modules），缺席即报错退出 2。
//   - esbuild：同上；且版本必须等于 ESBUILD_PIN（兼容表决定判据口径，漂移即口径漂移）→ 不等退出 2。
//
// 用法：
//   node scripts/check-browser-syntax-floor.mjs --scan <stageRoot|tar.xz>   # 门禁主模式（构建后/发布前）
//   node scripts/check-browser-syntax-floor.mjs --degrade --stage <dir>     # 构建期降级（原地，chrome87）
//   node scripts/check-browser-syntax-floor.mjs --degrade <file> --out <file>  # 单文件降级（实验/对照）
//   node scripts/check-browser-syntax-floor.mjs --self-test                 # 自包含四向自证（可离线跑）
//   node scripts/check-browser-syntax-floor.mjs --self-test --as-shipped <stageRoot|tar.xz>
//                                                                          # 追加「对真实出厂产物」的反向对照
//   node scripts/check-browser-syntax-floor.mjs --scan <path> --json        # 机器可读输出
// 退出码：0 = 通过；1 = 判红（存在违规）；2 = 用法/工具链/清单口径错误（无法判定，绝不静默跳过）。
//
// 已实测的预期读数（详档 §1.4 / §5.2，可复算）：
//   对 release/v0.14.0-preview/snapshot/snapshot-arm64.tar.xz 的 96 个浏览器面文件：
//     反向对照 → 判红：AST 报 2 个违规文件（index-DuF6ti6g.js 2 处、sidebar-documentpreview/lib/client.js 1 处），
//                      双 arm 差分报 64 个命中文件；
//     正向对照 → 全绿：96/96 用 --target=chrome87 降级后，AST 0 违规、双 arm 差分逐字节归零；
//     载荷对照 → 字符串/模板串/注释内的同类文本一律不触发（4 用例，判据 1 天然满足，判据 2 实测无差）。
//
// ⚠️ 双份构建脚本（协调仓 + apk 仓云端副本）必须同改，禁止单边演进（AGENTS.md 雷点 10）。
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const SELF = fileURLToPath(import.meta.url)
const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const argOf = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? (argv[i + 1] ?? d) : d }

const TARGET_LOW = 'chrome87'   // 语法下限（纸面基线：Android 10 / Chromium 87，且唯一在案老内核 = 87.0.4280.101）
const TARGET_HIGH = 'esnext'    // 对照臂（当前出厂口径）
const ESBUILD_PIN = '0.25.12'   // 判据 2 的口径锁：兼容表随版本变，故显式钉住

// 显式、固定顺序的依赖候选（不依赖偶然在场；缺席时给出可诊断错误）
const TS_CANDIDATES = [
  'plugins/dsh-android-bridge/node_modules/typescript',
  'plugins/dsh-android-browser/node_modules/typescript',
  'plugins/dsh-android-vdisplay/node_modules/typescript',
  'dsh-client-ui-responsive/node_modules/typescript',
  'dsh-shell-termux/node_modules/typescript',
  'node_modules/typescript',
]
const ESBUILD_CANDIDATES = [
  'plugins/dsh-android-bridge/node_modules/esbuild',
  'plugins/dsh-android-vdisplay/node_modules/esbuild',
  'dsh-client-ui-responsive/node_modules/esbuild',
  'node_modules/esbuild',
]

const failures = []
const notes = []
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}
const die = (msg, code = 2) => { console.error('CHECK-BROWSER-SYNTAX-FLOOR 无法判定（exit ' + code + '）：' + msg); process.exit(code) }

// ── 工具链显式定位 ──────────────────────────────────────────────────────────
const resolveTypeScript = () => {
  for (const rel of TS_CANDIDATES) {
    const dir = join(ROOT, rel)
    const main = join(dir, 'lib', 'typescript.js')
    const pkg = join(dir, 'package.json')
    if (existsSync(main) && existsSync(pkg)) {
      return { rel, dir, main, version: JSON.parse(readFileSync(pkg, 'utf8')).version }
    }
  }
  return null
}
const resolveEsbuild = () => {
  for (const rel of ESBUILD_CANDIDATES) {
    const dir = join(ROOT, rel)
    const main = join(dir, 'lib', 'main.js')
    const pkg = join(dir, 'package.json')
    if (existsSync(main) && existsSync(pkg)) {
      const version = JSON.parse(readFileSync(pkg, 'utf8')).version
      // 平台可用的那一个才算命中：快照构建在 WSL/Linux 内跑（build-snapshot-013.mjs:30-44 自执行进 WSL），
      // 而仓内 node_modules 只有 @esbuild/win32-x64 时，直接 import 会抛
      // 「You installed esbuild for another platform」——必须在选择阶段就按平台过滤，否则是踩坑而不是命中。
      if (esbuildUsable(main, version)) return { rel, dir, main, version }
    }
  }
  return null
}
/** 按**固定版本 + 本平台**准备 esbuild（npm 拉取到缓存放，显式、可复现、不入仓）。 */
const provisionDest = () => {
  const key = `esbuild-${ESBUILD_PIN}-${process.platform}-${process.arch}`
  // WSL/Linux 侧落到 Linux 原生缓存（HOME 在 ext4），避免把 node_modules 装到 /mnt/d（9p 小文件极慢）。
  if (process.platform === 'linux' && process.env.HOME) {
    const base = process.env.XDG_CACHE_HOME || join(process.env.HOME, '.cache')
    return join(base, 'dsh-browser-syntax-floor', key)
  }
  return join(ROOT, '.deploy-tmp', 'browser-syntax-floor', key)
}
const provisionEsbuild = async () => {
  const dest = provisionDest()
  const main = join(dest, 'node_modules', 'esbuild', 'lib', 'main.js')
  const pkg = join(dest, 'node_modules', 'esbuild', 'package.json')
  if (existsSync(main) && existsSync(pkg)) {
    const version = JSON.parse(readFileSync(pkg, 'utf8')).version
    if (version === ESBUILD_PIN && esbuildUsable(main, version)) return { rel: 'provisioned/' + process.platform + '-' + process.arch, dir: join(dest, 'node_modules', 'esbuild'), main, version }
    rmSync(dest, { recursive: true, force: true })
  }
  const platformPkg = process.platform === 'win32' ? '@esbuild/win32-' + process.arch
    : process.platform === 'linux' ? '@esbuild/linux-' + process.arch
      : process.platform === 'darwin' ? '@esbuild/darwin-' + process.arch : null
  if (!platformPkg) die('无 esbuild 平台包映射：' + process.platform + '/' + process.arch
    + '。请用 --esbuild <node_modules/esbuild/lib/main.js> 显式指定一个本平台可用的 esbuild@' + ESBUILD_PIN + '。')
  let mirrors = ['https://registry.npmjs.org']
  try { mirrors = JSON.parse(readFileSync(join(ROOT, 'scripts', 'snapshot-config', 'preinstall.json'), 'utf8')).npmMirrors ?? mirrors } catch { /* 用默认镜像 */ }
  mkdirSync(dest, { recursive: true })
  console.log('  准备 esbuild@' + ESBUILD_PIN + '（' + process.platform + '/' + process.arch + '，镜像链 ' + mirrors.length + ' 个）…')
  for (const m of mirrors) {
    try {
      await extractNpmTgz(m, 'esbuild', ESBUILD_PIN, join(dest, 'node_modules', 'esbuild'))
      await extractNpmTgz(m, platformPkg, ESBUILD_PIN, join(dest, 'node_modules', ...platformPkg.split('/')))
      if (process.platform !== 'win32') {
        spawnSync('chmod', ['+x', join(dest, 'node_modules', ...platformPkg.split('/'), 'bin', 'esbuild')], { encoding: 'utf8' })
      }
      const version = JSON.parse(readFileSync(pkg, 'utf8')).version
      if (version === ESBUILD_PIN && esbuildUsable(main, version)) return { rel: 'provisioned/' + process.platform + '-' + process.arch, dir: join(dest, 'node_modules', 'esbuild'), main, version }
      console.log('    装好了但本平台不可用，换下一个镜像')
    } catch (e) {
      console.log('    镜像 ' + m + ' 不可用（' + String(e.message).split('\n')[0] + '）')
    }
  }
  return null
}
/** 从 npm registry 取 metadata → 下 tgz → sha512 校验 → 解包（机制与 build-snapshot-013.mjs:196-217 同款；不依赖 npm CLI）。 */
const extractNpmTgz = async (registry, name, version, targetDir) => {
  const res = await fetch(registry + '/' + name, { signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error('metadata HTTP ' + res.status)
  const meta = await res.json()
  const dist = meta?.versions?.[version]?.dist
  if (!dist?.tarball) throw new Error('版本 ' + version + ' 的 dist 不可得')
  const buf = Buffer.from(await (await fetch(dist.tarball, { signal: AbortSignal.timeout(300000) })).arrayBuffer())
  const sha = dist.sha512 ?? (String(dist.integrity ?? '').startsWith('sha512-') ? String(dist.integrity).slice(7) : null)
  if (sha && createHash('sha512').update(buf).digest('base64') !== sha) throw new Error('sha512 不匹配')
  const tgzDir = dirname(targetDir)
  mkdirSync(tgzDir, { recursive: true })
  const tgz = join(tgzDir, '.__' + name.replace(/[@/]/g, '_') + '.tgz')
  writeFileSync(tgz, buf)
  rmSync(targetDir, { recursive: true, force: true })
  mkdirSync(targetDir, { recursive: true })
  const r = spawnSync('tar', ['-xzf', tgz, '-C', targetDir, '--strip-components=1'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('解包失败: ' + (r.stderr ?? '').trim().split('\n')[0])
  rmSync(tgz, { force: true })
}
/** 该 esbuild 安装是否能被**本进程**真正加载并跑完一次最小 transform（只查 transform 存在会漏掉平台二进制不匹配）。 */
function esbuildUsable(main, version) {
  const probe = 'try{const m=require(' + JSON.stringify(main) + ');'
    + 'if(m.version!==' + JSON.stringify(version) + ')process.exit(3);'
    + 'const r=m.transformSync("export const a = 1",{loader:"js"});'
    + 'process.exit(r&&typeof r.code==="string"?0:4)}catch(e){process.exit(5)}'
  const r = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
  return r.status === 0
}
let TS = resolveTypeScript()
let ESB = resolveEsbuild()
if (!TS) die('typescript 缺席（候选路径全未命中：' + TS_CANDIDATES.join(' / ') + '）。'
  + '本门禁的判据 1 依赖真实解析器，不得以文本判据替代；请先安装插件依赖（npm ci）。')
if (!ESB) {
  ESB = await provisionEsbuild()
  if (ESB) notes.push('esbuild 不在仓内可用副本中，已按固定版本 ' + ESBUILD_PIN + ' 准备到 ' + ESB.main)
}
if (!ESB) {
  const h = ESBUILD_CANDIDATES.map((rel) => {
    const pkg = join(ROOT, rel, 'package.json')
    return existsSync(pkg) ? rel + '（版本 ' + JSON.parse(readFileSync(pkg, 'utf8')).version + '，平台不可用）' : rel + '（缺席）'
  })
  die('esbuild@' + ESBUILD_PIN + ' 对本平台 ' + process.platform + '/' + process.arch + ' 不可用：'
    + h.join(' / ') + '。仓内 node_modules 通常只装本机平台二进制，而快照构建在 WSL/Linux 内跑；'
    + '请显式声明并固定 esbuild@' + ESBUILD_PIN + '（两条构建链），或用 --esbuild <node_modules/esbuild/lib/main.js> 指定。'
    + '绝不静默跳过——跳过等于把这条门禁变成永绿。')
}
if (has('esbuild')) {
  const p = argOf('esbuild')
  if (!existsSync(p)) die('--esbuild 指定的路径不存在: ' + p)
  const pkgPath = join(dirname(dirname(p)), 'package.json')
  if (!existsSync(pkgPath)) die('--esbuild 路径旁无 package.json，无法确认版本: ' + p)
  ESB = { rel: p, dir: dirname(dirname(p)), main: p, version: JSON.parse(readFileSync(pkgPath, 'utf8')).version }
  if (!esbuildUsable(ESB.main, ESB.version)) die('--esbuild 指定的安装对本平台不可用（平台二进制不匹配）: ' + p)
}
if (ESB.version !== ESBUILD_PIN) {
  die('esbuild 版本漂移：解析到 ' + ESB.version + '（' + ESB.rel + '），本门禁固定 ' + ESBUILD_PIN
    + '。判据 2 的口径完全由 esbuild 兼容表决定，版本漂移即口径漂移（详档 §6 未确证第 5 项）。'
    + '修法：在构建链里显式声明 esbuild@' + ESBUILD_PIN + '，或用 --esbuild <node_modules/esbuild/lib/main.js> 显式指定。')
}

const tsMod = await import(pathToFileURL(TS.main).href)
const ts = tsMod.default ?? tsMod
if (typeof ts.createSourceFile !== 'function') die('typescript 解析器不可用（' + TS.main + '：createSourceFile 缺席）')
const esbMod = await import(pathToFileURL(ESB.main).href)
const esbuild = esbMod.default ?? esbMod
if (typeof esbuild.transform !== 'function') die('esbuild transform API 不可用（' + ESB.main + '）')
notes.push('工具: typescript@' + TS.version + ' (' + TS.rel + ') ; esbuild@' + ESB.version + ' (' + ESB.rel + ')')
if (!has('json')) console.log(notes[notes.length - 1])

// ── 清单口径（两条判据共用，防口径分裂）────────────────────────────────────
// dist/**/*.js 全部 + 每一个 lib/client.js（含 home/.dsh/profiles/** 镜像副本）。
const classify = (rel) => {
  if (/(^|\/)dsh-web-frontend\/dist\/.*\.js$/.test(rel)) return 'frontend-dist'
  if (/(^|\/)lib\/client\.js$/.test(rel)) return 'client-bundle'
  return null
}
const walkDir = (base, rel, out) => {
  let entries
  try { entries = readdirSync(rel ? join(base, rel) : base, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const childRel = rel ? rel + '/' + e.name : e.name
    if (e.isDirectory()) walkDir(base, childRel, out)
    else if (e.isFile() && classify(childRel)) out.push(childRel)
  }
}
const tarMembers = (tar) => {
  try {
    return execFileSync('tar', ['-tf', tar], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) { die('tar 不可读（' + tar + '）：' + e.message) }
}
/** 把输入（stage 目录 / tar.xz）物化成 {root, rels, cleanup}。tar 只解清单成员，避免整包解压。 */
const materialize = (input) => {
  const isTar = /\.(tar\.xz|txz|tar)$/i.test(input)
  if (!isTar) {
    if (!existsSync(input)) die('--scan 输入不存在: ' + input)
    const rels = []
    walkDir(input, '', rels)
    return { root: input, rels, cleanup: () => {} }
  }
  if (!existsSync(input)) die('--scan 输入不存在: ' + input)
  const all = tarMembers(input)
  const rels = all.filter((m) => classify(m))
  const tmp = mkdtempSync(join(tmpdir(), 'syntax-floor-'))
  if (rels.length > 0) {
    const listFile = join(tmp, '__members.txt')
    writeFileSync(listFile, rels.join('\n') + '\n')
    try {
      execFileSync('tar', ['-xf', input, '-C', tmp, '-T', listFile], { stdio: ['ignore', 'inherit', 'inherit'] })
    } catch (e) { die('tar 解清单成员失败（' + input + '）：' + e.message) }
  }
  return { root: tmp, rels, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}
const absOf = (root, rel) => join(root, rel.split('/').join(sep))

// ── 判据 1：TypeScript AST 结构断言 ─────────────────────────────────────────
const astJudgment = (rel, text) => {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS)
  let staticBlocks = 0
  let privates = 0
  const hits = []
  const visit = (n) => {
    if (n.kind === ts.SyntaxKind.ClassStaticBlockDeclaration) {
      staticBlocks++
      const lc = sf.getLineAndCharacterOfPosition(n.getStart(sf))
      hits.push({ line: lc.line + 1, col: lc.character + 1, byteOffset: Buffer.byteLength(text.slice(0, n.getStart(sf)), 'utf8') })
    }
    if (n.kind === ts.SyntaxKind.PrivateIdentifier) privates++
    ts.forEachChild(n, visit)
  }
  visit(sf)
  const diags = sf.parseDiagnostics ?? []
  return {
    staticBlocks,
    privates,
    diagnostics: diags.length,
    diagSample: diags.slice(0, 3).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')),
    hits,
    bad: staticBlocks > 0 || diags.length > 0,
  }
}

// ── 判据 2：esbuild 双 arm 差分（两臂都对**原始字节**做；绝不对已降级产物做第二遍）────
// 不传 format：两臂做**完全相同**的管线，唯一变量就是 target —— 这正是差分要隔离的东西；
// 且与我方 client.js（CJS 风格闭包工厂）及上游 ESM dist 都保持原格式语义（详见 --degrade 处注释）。
const diffJudgment = async (text) => {
  const opts = { loader: 'js', logLevel: 'silent' }
  const [a, b] = await Promise.all([
    esbuild.transform(text, { ...opts, target: TARGET_HIGH }),
    esbuild.transform(text, { ...opts, target: TARGET_LOW }),
  ])
  return { a: Buffer.from(a.code, 'utf8'), b: Buffer.from(b.code, 'utf8'), differs: a.code !== b.code }
}

/** 对一份物化输入跑两条判据，返回结构化读数。 */
const runScan = async (root, rels, { stopAfterFirst = false } = {}) => {
  const rows = []
  let astBad = 0
  let staticTotal = 0
  let diagBad = 0
  let diffHits = 0
  let bytesA = 0
  let bytesB = 0
  let privatesTotal = 0
  const kinds = { 'frontend-dist': 0, 'client-bundle': 0 }
  const scopes = { usr: 0, home: 0, other: 0 }
  const concurrency = 4
  let cursor = 0
  const worker = async () => {
    while (cursor < rels.length) {
      const rel = rels[cursor++]
      kinds[classify(rel)]++
      if (rel.startsWith('usr/')) scopes.usr++
      else if (rel.startsWith('home/')) scopes.home++
      else scopes.other++
      const abs = absOf(root, rel)
      const text = readFileSync(abs, 'utf8')
      const ast = astJudgment(rel, text)
      let diff = null
      // 已判红的文件在快速模式下不必再跑差分；门禁主模式全跑（两条判据互证）
      if (!(stopAfterFirst && ast.bad)) diff = await diffJudgment(text)
      else diff = { a: Buffer.alloc(0), b: Buffer.alloc(0), differs: true }
      staticTotal += ast.staticBlocks
      privatesTotal += ast.privates
      if (ast.staticBlocks > 0) astBad++
      if (ast.diagnostics > 0) diagBad++
      if (diff.differs) { diffHits++; bytesA += diff.a.length; bytesB += diff.b.length }
      rows.push({ rel, kind: classify(rel), ...ast, a: diff.a.length, b: diff.b.length, differs: diff.differs })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rels.length || 1) }, worker))
  return { rows, astBad, staticTotal, diagBad, diffHits, privatesTotal, kinds, scopes, bytesA, bytesB, total: rels.length }
}

/** 门禁判定：判红条件（两条判据任一命中）。 */
const decide = (r) => {
  const detailFailures = []
  if (r.total === 0) detailFailures.push('清单为空——口径漂移（路径前缀/布局变更？）')
  if (r.kinds['frontend-dist'] === 0) detailFailures.push('清单里 dsh-web-frontend/dist/**/*.js 为 0——前端产出口径失效')
  if (r.kinds['client-bundle'] === 0) detailFailures.push('清单里 lib/client.js 为 0——插件 bundle 口径失效')
  if (r.astBad > 0) detailFailures.push('判据1：' + r.astBad + ' 个文件含 ClassStaticBlockDeclaration（Chromium 94+ 语法，老内核解析即整模块不执行）')
  if (r.diagBad > 0) detailFailures.push('判据1：' + r.diagBad + ' 个文件存在解析诊断——产物必须能被 ESNext 解析器无错解析')
  if (r.diffHits > 0) detailFailures.push('判据2：' + r.diffHits + ' 个文件在 esnext 与 chrome87 之间产生字节差——携带未降级的需降级语法')
  return detailFailures
}

const report = (r, out = console.log) => {
  const fails = decide(r)
  out('BROWSER-SYNTAX-FLOOR ' + (fails.length === 0 ? 'PASS' : 'FAIL'))
  out('  清单: ' + r.total + ' 个文件（dist/**/*.js = ' + r.kinds['frontend-dist'] + '，lib/client.js = ' + r.kinds['client-bundle']
    + '；usr/ = ' + r.scopes.usr + '，home/ = ' + r.scopes.home + '，其他 = ' + r.scopes.other + '）')
  out('  判据1 AST: ClassStaticBlockDeclaration 违规文件 ' + r.astBad + ' 个（共 ' + r.staticTotal + ' 处）；'
    + '解析诊断>0 的文件 ' + r.diagBad + ' 个；PrivateIdentifier 共 ' + r.privatesTotal + ' 处（Chromium 74+，不作判据）')
  out('  判据2 差分: ' + r.diffHits + '/' + r.total + ' 个文件 ' + TARGET_HIGH + ' != ' + TARGET_LOW
    + (r.diffHits > 0 ? '（其中 ' + TARGET_LOW + ' 侧合计 ' + r.bytesA + ' -> ' + r.bytesB + ' B，+' + (r.bytesB - r.bytesA) + ' B）' : ''))
  for (const row of r.rows) {
    if (row.staticBlocks > 0) {
      out('    VIOLATION-STATIC ' + row.rel + ' staticBlocks=' + row.staticBlocks + ' diagnostics=' + row.diagnostics
        + ' hits=' + row.hits.map((h) => h.line + ':' + h.col + '(byte ' + h.byteOffset + ')').join(','))
    } else if (row.diagnostics > 0) {
      out('    VIOLATION-PARSE ' + row.rel + ' diagnostics=' + row.diagnostics + ' :: ' + row.diagSample.join(' | '))
    }
    if (row.differs && row.staticBlocks === 0) out('    DIFF ' + row.rel + ' ' + TARGET_HIGH + '=' + row.a + ' B vs ' + TARGET_LOW + '=' + row.b + ' B')
  }
  if (fails.length > 0) for (const f of fails) out('  FAIL ' + f)
  out('  口径边界: 「差分归零」只证明不低于 esbuild 的 ' + TARGET_LOW + ' 口径，不等价于 MDN 意义的 Chromium 87（详档 §6 未确证第 5 项，未做逐特性 --supported 断言）')
  return fails
}

// ── 模式：--degrade（构建期降级；本脚本同时充当构建链的唯一降级原语）──────────
// 生产降级**不传 format**：我方 client.js 是「CJS 风格 + window.__ModuleLoader__ 闭包工厂」，
// 传 format:'esm' 会把工厂形参 require 重命名成 require2（实测 vdisplay 89 字节处分歧）——
// 判据 2 的差分只比较两臂，format 无所谓；但**落到产物的字节**必须保持原格式语义，否则是改行为不是降级。
/**
 * 引擎树补丁的 marker 清单（来自 registry.json，数据驱动，不硬编码）。
 *
 * 为什么降级必须照顾它们（0.14.1 实测踩到的真缺陷）：esbuild 的 transform **会剥掉注释**，
 * 而其中三个补丁的 marker 正是**注释**——`arkweb-resource-protocol-H1` /
 * `reference-drill-F6` / `external-draft-conversation-seam-J1`（目标是 `lib/client.js`）。
 * 构建器顺序是「overlay → 引擎树补丁 → 0f-1b 降级」，于是降级会把「补丁已施加」的**唯一证据**
 * 洗掉，`check-engine-overlay` 随即判红（实测 H1 与 F6 两项缺席）。
 *
 * 保留是**合法**的，不是把判据改松：降级（target=chrome87）是**语义保持**变换，补丁插入的**代码**
 * 仍在（实测降级后 H1 的 authority 回退逻辑在场），丢的只是注释文本。故此处只对**原文确实含有**
 * 的 marker 做补回——不凭空造标记，也不掩盖「补丁真的没打」。
 */
const PATCH_MARKERS = (() => {
  try {
    const reg = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
    return (reg.patches ?? [])
      .map((p) => p.marker)
      .filter((m) => typeof m === 'string' && m.trim() !== '')
  } catch { return [] }
})()

const degradeText = async (text) => {
  const out = (await esbuild.transform(text, {
    loader: 'js', logLevel: 'silent', target: TARGET_LOW,
  })).code
  const missing = PATCH_MARKERS.filter((m) => text.includes(m) && !out.includes(m))
  if (missing.length === 0) return out
  // 以行注释补回（注释对运行时无影响）；仅当降级确实丢失时才补。
  return missing.map((m) => '// ' + m).join('\n') + '\n' + out
}

if (has('degrade')) {
  const file = argOf('file') ?? argv[argv.indexOf('--degrade') + 1]
  const stage = argOf('stage')
  const out = argOf('out')
  if (stage) {
    if (!existsSync(stage)) die('--degrade --stage 输入不存在: ' + stage)
    const rels = []
    walkDir(stage, '', rels)
    if (rels.length === 0) die('--degrade --stage 清单为空（' + stage + '）——拒绝 no-op 降级')
    let before = 0
    let after = 0
    let changed = 0
    for (const rel of rels) {
      const abs = absOf(stage, rel)
      const src = readFileSync(abs, 'utf8')
      const dst = await degradeText(src)
      before += Buffer.byteLength(src, 'utf8')
      after += Buffer.byteLength(dst, 'utf8')
      if (dst !== src) { writeFileSync(abs, dst); changed++ }
    }
    console.log('BROWSER-SYNTAX-FLOOR DEGRADE stage=' + stage + ' target=' + TARGET_LOW
      + ' files=' + rels.length + ' changed=' + changed + ' bytes ' + before + ' -> ' + after + ' (+' + (after - before) + ')')
    console.log('  ⚠️ 二次降级不保证逐字节相同（@__PURE__ 注解重排，详档 §5.2 步骤 4）；判绿请用 --scan 的「双 arm 差分归零」。')
    process.exit(0)
  }
  if (!file || !existsSync(file)) die('--degrade 需要 <file>（或 --stage <dir>）：' + String(file))
  const src = readFileSync(file, 'utf8')
  const dst = await degradeText(src)
  if (!out) { process.stdout.write(dst); process.exit(0) }
  writeFileSync(out, dst)
  console.log('BROWSER-SYNTAX-FLOOR DEGRADE ' + file + ' -> ' + out + ' (' + Buffer.byteLength(src, 'utf8') + ' -> ' + Buffer.byteLength(dst, 'utf8') + ' B)')
  process.exit(0)
}

// ── 接线反回归（task-9 判据 3）：构建链里「降级步骤存在且被调用」────────────────
// 为什么单独一条：check-release-gates 只断言「门禁集合被两条链调用」（31/31），它比不出
// **构建链里少了降级步骤** —— 门禁照样被调用、照样判红，但没有任何步骤把产物改成合规形态，
// 于是云端自包含构建必然判红而本地不可见（task-9 的真因）。
// 判据是结构性的（不是文本在场）：
//   · 两条链各自源码里都必须有一次「调用本脚本 + --degrade」（而不是只 import / 只注释提到）；
//   · 该调用的**行号必须早于** combo 预计算调用（顺序硬约束：combo 键 = sha256(client.js)）；
//   · 降级目标必须是**暂存副本**（原地降级会把入库跟踪的 vendor/lib 写脏 / 制造镜像漂移）。
//
// 布局无关：协调仓根下是 `scripts/...`；apk 仓自包含根下同名，`dsh-mobile-apk/scripts/...` 是其镜像。
// 两条链都必须查——**镜像面单边缺失就是 task-9 的真因**（本地有降级、云端没有）。
const WIRED_CHAINS = ['scripts/build-apk-013.ps1', 'scripts/build-apk.mjs']
const mirrorRel = (rel) => (existsSync(join(ROOT, rel)) ? rel : rel.replace(/^/, 'dsh-mobile-apk/'))
/** 去掉注释后的代码行（判据只看真正会执行的调用；两种链的注释形态不同）。 */
const codeLines = (text) => text
  .replace(/\r\n/g, '\n')
  .split('\n')
  .map((l, i) => ({ n: i + 1, l }))
  .filter(({ l }) => {
    const t = l.trim()
    return t.length > 0 && !t.startsWith('#') && !t.startsWith('//')
  })
const checkChainWiring = () => {
  const problems = []
  const evidence = []
  for (const rel of WIRED_CHAINS) {
    for (const base of [ROOT, join(ROOT, 'dsh-mobile-apk')]) {
      const p = join(base, rel)
      const tag = (base === ROOT ? '本仓' : '镜像仓') + '/' + rel
      if (!existsSync(p)) { if (base === ROOT) problems.push(rel + ' 缺席'); continue }
      const lines = codeLines(readFileSync(p, 'utf8'))
      // ① 「调用」：同一行同时出现脚本名与 --degrade（是调用，不是别处的说明）
      const degradeLine = lines.find(({ l }) => l.includes('check-browser-syntax-floor.mjs') && l.includes('--degrade'))
      const comboLine = lines.find(({ l }) => l.includes('combo-precompute.mjs'))
      if (!degradeLine) {
        problems.push(tag + ' 没有任何一行同时含 check-browser-syntax-floor.mjs 与 --degrade（降级步骤缺失）')
        continue
      }
      if (!comboLine) { problems.push(tag + ' 找不到 combo-precompute.mjs 调用（无法验证降级在 combo 之前）'); continue }
      if (degradeLine.n >= comboLine.n) {
        problems.push(tag + ' 降级(L' + degradeLine.n + ')不在 combo 预计算(L' + comboLine.n + ')之前'
          + '——combo 键 = sha256(client.js)，顺序反了必然全 miss')
      }
      // ② 暂存副本（**绑定判据**，不是「文件里提到过这个词」）：取降级调用的实际 --stage 实参，
      //    它必须是一个由**暂存路径**赋值的变量。否则就是原地降级 —— `vendor/**/lib/` 是入库跟踪的
      //    （.gitignore 显式 !vendor 例外），原地降级会写脏工作树并制造与 apk 仓镜像的漂移。
      const tgt = /--stage['"\s,]+([A-Za-z_$][\w$]*)/.exec(degradeLine.l)?.[1]
      if (!tgt) {
        problems.push(tag + ' 无法从降级调用行解析出 --stage 实参（判据失效，拒绝假绿）：' + degradeLine.l.trim())
      } else {
        // 找到 tgt 的赋值行；该赋值必须源自暂存路径（degradeStaged / degrade-src）。
        // 变量名可能带 PS 前缀 `$`（如 `$dst`）——必须转义后建正则，且不用 \b（`$` 左侧无词边界
        // → `\b\$dst` 恒不匹配，会把合法链误判成「原地降级」，首版实测踩到）。
        const esc = tgt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const assign = lines.find(({ l }) => new RegExp('(?:^|[\\s(])' + esc + '\\s*=').test(l))
        const fromStaging = assign !== undefined
          && /degradeStaged|degrade-src/.test(assign.l)
          && !/--stage/.test(assign.l)   // 赋值行本身不能又是调用行（自指假绿）
        if (!fromStaging) {
          problems.push(tag + ' 降级目标是 ' + tgt + ' 且其赋值不来自暂存路径（禁止原地降级；'
            + 'vendor/**/lib 入库跟踪，原地降级会写脏工作树 + 制造镜像漂移）')
        }
        evidence.push(tag + ': degrade@L' + degradeLine.n + ' < combo@L' + comboLine.n + ' stage=' + tgt + ' staged=' + fromStaging)
      }
    }
  }
  return { ok: problems.length === 0, detail: problems.join('；'), evidence: evidence.join(' | ') }
}

// ── 模式：--self-test（自包含四向自证；可离线跑，不碰仓库产物）──────────────
if (has('self-test')) {
  const spawnSelf = (extra) => {
    try {
      const stdout = execFileSync(process.execPath, [SELF, ...extra], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
      return { status: 0, stdout }
    } catch (e) {
      return { status: e.status ?? -1, stdout: (e.stdout ?? '') + (e.stderr ?? '') }
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), 'syntax-floor-self-'))
  const root = join(tmp, 'root')
  const FE = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets'
  const CB = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-fixture/lib'
  const HOME_CB = 'home/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-fixture/lib'
  for (const rel of [FE, CB, HOME_CB]) mkdirSync(join(root, rel.split('/').join(sep)), { recursive: true })

  // 用例 1：真代码（类静态块 + 可选链）—— 两条判据都必须报
  const realCode = 'export class A {\n  static { this.x = 1 }\n  static is(v) { return v?.y }\n}\nexport const z = A.is?.length\n'
  writeFileSync(absOf(root, FE + '/index-fixture.js'), realCode)
  // 用例 2/3/4：字符串 / 模板串 / 注释内的同类文本，且**不含任何现代语法**——两条判据都不得触发（载荷对照）。
  // 关键：文档里 grep 会把这三种载荷全部误报成语法；本门禁必须一个都不报。
  const payload = 'export const a = "class A { static { this.x = 1 } }"\n'
    + 'export const b = `class B { static { this.y = 2 } }`\n'
    + '// class C { static { this.z = 3 } }\nexport const c = a.length\n'
  writeFileSync(absOf(root, CB + '/client.js'), payload)
  // 对照件：只有真 `?.`（无类静态块）—— 判据 1 必须静默、判据 2 必须命中（证明判据 2 不是靠静态块才有输出）
  writeFileSync(absOf(root, HOME_CB + '/client.js'), 'export const opt = (o) => o?.x?.y\nexport const n = opt.length\n')

  const t0 = Date.now()
  const reverse = spawnSelf(['--scan', root])                 // 反向对照：未降级必须判红
  const reverseReported = reverse.status === 1
    && /VIOLATION-STATIC .*index-fixture\.js/.test(reverse.stdout)
    && !/VIOLATION-STATIC .*client\.js/.test(reverse.stdout)
    && /DIFF .*home\/.*client\.js/.test(reverse.stdout)
    && reverse.stdout.includes('ClassStaticBlockDeclaration 违规文件 1 个')
    && reverse.stdout.includes('解析诊断>0 的文件 0 个')
  // 载荷对照（文件级）：CB/client.js 只含载荷文本 → 判据 1 不得出现该路径、判据 2 不得对该路径出 DIFF；
  // 同时 HOME 对照件（只有真 ?.）必须被判据 2 命中 —— 证明判据 2 的输出不是只靠类静态块才有。
  const payloadClean = !/VIOLATION-STATIC [^\n]*client\.js staticBlocks=/.test(reverse.stdout)
    && !/DIFF usr\/[^\n]*dsh-client-ui-fixture/.test(reverse.stdout)
    && /DIFF home\/[^\n]*dsh-client-ui-fixture/.test(reverse.stdout)
    && reverse.stdout.includes('判据2 差分: 2/3 个文件')

  // 正向对照：同一棵树原地降到 chrome87 后必须全绿
  const degraded = spawnSelf(['--degrade', '--stage', root])
  const forward = spawnSelf(['--scan', root])                  // 正向对照：降级后必须全绿
  const forwardOk = degraded.status === 0 && forward.status === 0
    && /BROWSER-SYNTAX-FLOOR PASS/.test(forward.stdout)
    && /判据2 差分: 0\//.test(forward.stdout)

  // 解析器可用性：AST 必须能把真代码与载荷区分开（4 用例级）
  const astReal = astJudgment('real.js', realCode)
  const astPayload = astJudgment('payload.js', payload)
  const parserDiscriminates = astReal.staticBlocks === 1 && astPayload.staticBlocks === 0 && astPayload.diagnostics === 0
  const [dHighReal, dLowReal] = await Promise.all([
    esbuild.transform(realCode, { format: 'esm', loader: 'js', logLevel: 'silent', target: TARGET_HIGH }),
    esbuild.transform(realCode, { format: 'esm', loader: 'js', logLevel: 'silent', target: TARGET_LOW }),
  ])
  const [dHighPay, dLowPay] = await Promise.all([
    esbuild.transform(payload, { format: 'esm', loader: 'js', logLevel: 'silent', target: TARGET_HIGH }),
    esbuild.transform(payload, { format: 'esm', loader: 'js', logLevel: 'silent', target: TARGET_LOW }),
  ])
  const diffDiscriminates = dHighReal.code !== dLowReal.code && dHighPay.code === dLowPay.code

  // 用例 5（0.14.1 实测缺陷回归）：带**引擎树补丁 marker 注释**的文件降级后，marker 必须仍在。
  // 真因：esbuild 剥注释，而 H1/F6/J1 三个补丁的 marker 正是注释、目标是 lib/client.js；构建器
  // 顺序是「打补丁 → 降级」，于是降级把「补丁已施加」的唯一证据洗掉，check-engine-overlay 判红。
  // 这条自证让本门禁的降级原语**自带**该回归防线——不必等 check-engine-overlay 来发现。
  //
  // **不能用单个 marker 做夹具**：registry 里多数 marker 是**代码片段**（如 `function tt(){...}`），
  // esbuild 不会剥，用它则用例**空转通过**（首版实测踩到：禁用保全逻辑后该用例照样绿）。故夹具含
  // **全部** marker 且都以行注释形式给出——注释必被剥，判据才有承重。
  let markerKept = true
  let markerDetail = '（registry 无 marker，跳过）'
  const markerLost = []
  if (PATCH_MARKERS.length > 0) {
    const mroot = mkdtempSync(join(tmpdir(), 'bsf-marker-'))
    const mdir = join(mroot, 'lib')
    mkdirSync(mdir, { recursive: true })
    writeFileSync(join(mdir, 'client.js'),
      PATCH_MARKERS.map((m) => '// ' + m).join('\n') + '\nexport const opt = (o) => o?.x?.y\nexport const n = opt.length\n')
    spawnSelf(['--degrade', '--stage', mroot])
    const after = readFileSync(join(mdir, 'client.js'), 'utf8')
    for (const m of PATCH_MARKERS) if (!after.includes(m)) markerLost.push(m)
    markerKept = markerLost.length === 0
    markerDetail = 'registry marker 共 ' + PATCH_MARKERS.length + ' 个；降级后缺失 ' + markerLost.length
      + (markerLost.length > 0 ? '（例：' + JSON.stringify(markerLost[0]) + '）' : '')
      + '；降级仍生效=' + !after.includes('o?.x?.y')
    rmSync(mroot, { recursive: true, force: true })
  }

  console.log('BROWSER-SYNTAX-FLOOR --self-test（六向自证 + 接线反回归，用时 ' + (Date.now() - t0) + ' ms）')
  // ① 解析器可用性：**真判据**（此前是 `check(..., true)` 硬编码 —— 文件缺席/版本错也照样绿，
  //    等于把「环境是否可用」写成常量。现断言：解析器真能把真代码与载荷区分开，且 esbuild 版本 == 钉住值。
  const parserUsable = typeof ts.createSourceFile === 'function'
    && parserDiscriminates
    && astPayload.diagnostics === 0
    && TS.version.length > 0
    && ESB.version === ESBUILD_PIN
  check('① 解析器可用性：typescript@' + TS.version + ' 真解析且能区分真语法/载荷；esbuild@' + ESB.version + ' == 钉住值 ' + ESBUILD_PIN,
    parserUsable,
    'createSourceFile=' + (typeof ts.createSourceFile === 'function')
    + ' ast real=' + astReal.staticBlocks + ' payload=' + astPayload.staticBlocks
    + ' payloadDiag=' + astPayload.diagnostics + ' esbuild=' + ESB.version)
  check('② 反向对照：未降级 fixture（真 static{} + ?.）必须判红，且载荷文件不被误报', reverseReported,
    'exit=' + reverse.status + '（期望 1）')
  check('③ 正向对照：同一棵树 --degrade 到 ' + TARGET_LOW + ' 后必须全绿（判据1 0 违规 + 判据2 差分归零）', forwardOk,
    'degrade exit=' + degraded.status + ' scan exit=' + forward.status + '（期望 0/0）')
  check('④ 载荷对照：字符串/模板串/注释内同类文本不得触发（AST 3 用例 + 双 arm 差分 3 用例）', payloadClean && diffDiscriminates,
    'ast real=' + astReal.staticBlocks + ' payload=' + astPayload.staticBlocks
    + '；esbuild real differs=' + (dHighReal.code !== dLowReal.code) + ' payload differs=' + (dHighPay.code !== dLowPay.code))
  // ⑤ 降级不得洗掉引擎树补丁 marker（esbuild 剥注释；0.14.1 实测缺陷）
  check('⑤ 补丁 marker 保全：降级（剥注释）后 registry 的 marker 必须仍在原文件里', markerKept, markerDetail)
  // ⑥ 接线反回归（task-9）：降级步骤必须真的被两条构建链调用——「脚本存在」不等于「有步骤在用它」。
  //    真因：check-release-gates 只比门禁集合（31/31 全绿），比不出「构建链里少了降级步骤」，
  //    于是 PowerShell 链有降级、Node 链没有，云端自包含构建必判红而无人知。
  const wiring = checkChainWiring()
  check('⑥ 接线反回归：两条构建链都必须在 combo 预计算之前调用 --degrade（暂存副本，不原地）',
    wiring.ok, wiring.detail)
  console.log('  接线取证: ' + wiring.evidence)

  // ── 真实产物反向对照（C-2）：默认**自动启用**，不再是 opt-in ──
  // 真因：`--as-shipped <path>` 是 opt-in 且**没有任何调用方传它**（两条构建链调的是 `--scan`），
  // 于是「对真实出厂产物必须判红」这条最有力的反假绿证据**从未在本仓被执行过** —— 只有人工跑过一次。
  //
  // 判据取向（关键，别写成永红或永绿）：反向对照要的是**未降级的**出厂产物 ——
  //   · 已发布快照（release/**，降级步骤落地前构建的）→ 必须**判红**（AST 违规 > 0）；
  //   · 本机新建快照（.deploy-tmp/**，降级步骤落地后构建的）→ 应当**判绿**（这本身就是降级生效的反向证据）。
  // 故候选按「未降级优先」排序，取第一个在场的判红；若只找到已降级产物，则如实报告它绿（不假红）。
  const shippedCandidates = [
    argOf('as-shipped'),
    'release/v0.14.0-preview/snapshot/snapshot-arm64.tar.xz',
    'release/v0.14.0-preview/snapshot/snapshot-x86_64.tar.xz',
    '.deploy-tmp/snapshot-013/x86_64/snapshot.tar.xz',
    '.deploy-tmp/snapshot-013/arm64/snapshot.tar.xz',
  ].filter((p) => typeof p === 'string' && p.length > 0)
  const present = shippedCandidates.map((p) => (existsSync(join(ROOT, p)) ? join(ROOT, p) : (existsSync(p) ? p : null))).filter(Boolean)
  if (process.env.DSH_SYNTAX_FLOOR_SKIP_SHIPPED === '1') {
    console.log('  真实产物反向对照: SKIP（DSH_SYNTAX_FLOOR_SKIP_SHIPPED=1，显式跳过，未计数）')
  } else if (present.length === 0) {
    console.log('  真实产物反向对照: SKIP(#1)（已知出厂产物均不在场——裸 clone；候选: ' + shippedCandidates.join(', ') + '）')
  } else {
    // 优先挑「未降级」的那个做反向对照（判红）；降级后的读数作为正向证据一并打印。
    let redDemonstrated = null
    const readings = []
    for (const p of present.slice(0, 2)) {
      const mat = materialize(p)
      const r = await runScan(mat.root, mat.rels)
      mat.cleanup()
      const rel = p.startsWith(ROOT) ? p.slice(ROOT.length + 1).replace(/\\/g, '/') : p
      readings.push({ rel, astBad: r.astBad, staticTotal: r.staticTotal, diffHits: r.diffHits, total: r.total })
      if (r.astBad > 0 && r.diffHits > 0 && redDemonstrated === null) redDemonstrated = readings[readings.length - 1]
    }
    for (const x of readings) {
      console.log('  真实产物读数: ' + x.rel + ' → AST 违规文件 ' + x.astBad + '（staticBlocks ' + x.staticTotal
        + '）/ 差分命中 ' + x.diffHits + '/' + x.total)
    }
    check('⑦ 真实出厂产物反向对照（默认启用，未降级产物必须判红）', redDemonstrated !== null,
      redDemonstrated
        ? '未降级产物=' + redDemonstrated.rel + '（astBad=' + redDemonstrated.astBad + ' diffHits=' + redDemonstrated.diffHits + '）'
        : '在场的 ' + readings.length + ' 个产物**全部判绿**（都已降级）——无法演示反向对照；'
          + '请提供一份降级前产物（release/** 已发布快照），否则本条形同虚设')
  }

  rmSync(tmp, { recursive: true, force: true })
  if (failures.length > 0) {
    console.error('CHECK-BROWSER-SYNTAX-FLOOR SELF-TEST FAILED（' + failures.length + ' 项）：' + failures.join('；'))
    process.exit(1)
  }
  console.log('CHECK-BROWSER-SYNTAX-FLOOR SELF-TEST PASSED（六向自证全绿 + 真实产物反向对照）')
  process.exit(0)
}

// ── 模式：--scan（门禁主模式）──────────────────────────────────────────────
const scanInput = argOf('scan') ?? argv.find((a) => !a.startsWith('--'))
if (!scanInput) {
  die('用法: node scripts/check-browser-syntax-floor.mjs --scan <stageRoot|tar.xz>'
    + ' | --degrade --stage <dir> | --self-test [--as-shipped <path>]')
}
const mat = materialize(scanInput)
const r = await runScan(mat.root, mat.rels)
mat.cleanup()
if (has('json')) {
  console.log(JSON.stringify({
    input: scanInput, total: r.total, kinds: r.kinds, scopes: r.scopes,
    astViolations: r.astBad, staticBlocks: r.staticTotal, parseDiagnostics: r.diagBad,
    diffHits: r.diffHits, targetHigh: TARGET_HIGH, targetLow: TARGET_LOW,
    esbuild: ESB.version, typescript: TS.version,
    failures: decide(r),
    files: r.rows.map((x) => ({ rel: x.rel, staticBlocks: x.staticBlocks, diagnostics: x.diagnostics, differs: x.differs })),
  }, null, 2))
  process.exit(decide(r).length === 0 ? 0 : 1)
}
const fails = report(r)
if (fails.length > 0) {
  console.error('CHECK-BROWSER-SYNTAX-FLOOR FAILED（' + fails.length + ' 项）：' + fails.slice(0, 3).join('；'))
  process.exit(1)
}
console.log('CHECK-BROWSER-SYNTAX-FLOOR PASSED（' + r.total + ' 个浏览器面文件：判据1 0 违规 + 判据2 差分归零）')
