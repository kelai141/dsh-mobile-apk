#!/usr/bin/env node
// check-browser-parse-floor.mjs — 浏览器面产物「chrome87 语法可解析」判据（0.2.2-rc.1 适配引入）。
//
// ── 为什么这条门与 check-browser-syntax-floor 同时存在 ──────────────────────
// 那条门的两条判据是：
//   判据1 AST：ClassStaticBlockDeclaration 计数 == 0（针对**单一**已知杀器）；
//   判据2 差分：同一字节在 esnext / chrome87 两个 esbuild arm 下字节相同。
// 判据2 的口径边界，那条门自己在输出里写明了：「差分归零只证明不低于 esbuild 的
// chrome87 口径，不等价于 MDN 意义的 Chromium 87」。也就是说，如果 esbuild 认为
// 某个语法在 chrome87 下无需降级、而真实 Chromium 87 解析不了，判据2 会放过它。
//
// 这条门补的是**另一个方向的证据**：用真解析器（acorn）按 chrome87 对应的语法档位
// （ECMAScript 2021 / ecmaVersion 12）逐文件 parse。解析失败 = 老内核在解析期就抛
// SyntaxError，整个模块一行不执行（正是 0.14.1 块C 那个白屏事故的形态）。
//
// ── 判据 ───────────────────────────────────────────────────────────────────
//   1. 清单与 check-browser-syntax-floor 同源（dist/**/*.js + 每个 lib/client.js），
//      不另立一套口径——两套口径就是两个真源，迟早漂移。
//   2. 每个文件必须能被 acorn 以 ecmaVersion=12（ES2021，Chromium 87 的语法档位）
//      解析为 module；parse 抛错即判红，并给出 行:列 + 错误原文。
//   3. acorn 缺席或清单为空 => exit 2（无法判定），不静默放行。
//
// ── 与「降级」的关系 ───────────────────────────────────────────────────────
// 降级（--degrade，走 esbuild --target=chrome87）会把 static{} / 类字段等改写成
// helper 形式。降级之后本门应当全绿；降级之前本门应当在含 static{} 的文件上判红。
// 两者互为反证：只有「降级前红、降级后绿」同时成立，才证明降级真的起作用。
//
// 用法：node scripts/check-browser-parse-floor.mjs --scan <stageRoot|tar.xz>
//       node scripts/check-browser-parse-floor.mjs --self-test
// 退出码：0 = 通过；1 = 判据不成立；2 = 无法判定。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const argOf = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? (argv[i + 1] ?? d) : d }
const die = (msg, code = 2) => { console.error('CHECK-BROWSER-PARSE-FLOOR 无法判定（exit ' + code + '）：' + msg); process.exit(code) }

/** Chromium 87 的语法档位 = ECMAScript 2021（ecmaVersion 12）。 */
const ECMA_VERSION = 12
const ECMA_LABEL = 'ES2021'

/** 清单与 check-browser-syntax-floor 同源：dist/**\/*.js + 每个 lib/client.js。 */
const isBrowserFace = (rel) => {
  const p = rel.split(sep).join('/')
  if (!p.endsWith('.js')) return false
  if (/(^|\/)dsh-web-frontend\/dist\//.test(p)) return true
  if (/(^|\/)lib\/client\.js$/.test(p)) return true
  return false
}

/**
 * tar 成员名 → 是否浏览器面。与 isBrowserFace 同一套规则，但多剥一层：
 * 快照成员以 `usr/`（或 `home/`）开头，且可能是 `./` 前缀。这里只做前缀归一并复用同一函数，
 * 保证「解包哪些」与「扫哪些」永远同一口径（两处各写一份规则迟早漂移）。
 */
const isBrowserFaceTarMember = (member) => {
  const m = member.replace(/^\.\//, '').replace(/\/+$/, '')
  if (m === '' || m.endsWith('/')) return false
  return isBrowserFace(m)
}

const walkDir = (base, rel, out) => {
  const abs = rel === '' ? base : join(base, rel)
  let entries = []
  try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const child = rel === '' ? e.name : join(rel, e.name)
    if (e.isDirectory()) walkDir(base, child, out)
    else if (e.isFile()) out.push(child.split(sep).join('/'))
  }
}

const tarMembers = (tar) => {
  const r = spawnSync('tar', ['-tf', tar], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) die('无法列出 tar 成员：' + (r.stderr || '').slice(0, 400))
  return r.stdout.split(/\r?\n/).filter((s) => s.trim() !== '')
}

const materialize = (input) => {
  if (!existsSync(input)) die('--scan 输入不存在: ' + input)
  const st = statSync(input)
  if (st.isDirectory()) {
    const rels = []
    walkDir(input, '', rels)
    return { root: input, rels: rels.filter(isBrowserFace), cleanup: () => {} }
  }
  if (!/\.tar\.xz$/.test(input)) die('--scan 只接受目录或 .tar.xz：' + input)
  const dir = mkdtempSync(join(tmpdir(), 'parse-floor-'))
  // **只解浏览器面成员，不全量解包**。全量 `tar -xJf` 在 Windows 上必失败：快照里有
  // `usr/lib/*.so`、`usr/bin/*` 这类成员，落到 NTFS 上是非法文件名（实测报
  // `Can't create '...\\usr\\lib\\libmenu.so': Invalid argument`），整条命令 status!==0。
  // 而本门只需要 `dist/**/*.js` 与各 `lib/client.js`——它们都在 `usr/` 下的 node_modules 里，
  // 路径合法。按成员清单精确解包，既避开非法名，也少写几十万个无关文件。
  const wanted = tarMembers(input).filter((m) => isBrowserFaceTarMember(m))
  if (wanted.length === 0) die('tar 内没有浏览器面成员（清单口径与 check-browser-syntax-floor 同源）：' + input)
  // 用 -T <清单文件> 精确解包：成员可能上百个，塞命令行会撞长度上限；也不能用 `-T -`
  // ——Windows 自带的 bsdtar 不支持从 stdin 读清单（实测 `Error inclusion pattern: Failed to open '-'`）。
  const listPath = join(dir, '.members.txt')
  writeFileSync(listPath, wanted.join('\n') + '\n')
  const r = spawnSync('tar', ['-xJf', input, '-C', dir, '-T', listPath], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  rmSync(listPath, { force: true })
  if (r.status !== 0) die('解包失败（浏览器面成员 ' + wanted.length + ' 个）：' + (r.stderr || '').slice(0, 400))
  const rels = []
  walkDir(dir, '', rels)
  const faces = rels.filter(isBrowserFace)
  if (faces.length !== wanted.length) {
    die('解包后浏览器面文件数 ' + faces.length + ' != 清单 ' + wanted.length + '（解包不完整，拒绝给假绿读数）')
  }
  return { root: dir, rels: faces, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 解析器来源：优先仓库内已安装的 acorn（与门禁其它工具同源），不做网络安装。 */
const resolveAcorn = async () => {
  const candidates = [
    join(ROOT, 'node_modules', 'acorn'),
    join(ROOT, '.deploy-tmp', 'survey-022rc1', 'closure022', 'node_modules', 'acorn'),
    join(ROOT, 'dsh-client-ui-responsive', 'node_modules', 'acorn'),
  ]
  for (const dir of candidates) {
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const entry = join(dir, 'dist', 'acorn.mjs')
    if (!existsSync(entry)) continue
    const mod = await import(pathToFileURL(entry).href)
    const parse = (mod.default ?? mod).parse
    if (typeof parse !== 'function') continue
    const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
    return { parse, version, dir: relative(ROOT, dir).split(sep).join('/') }
  }
  return null
}

const runScan = async (root, rels) => {
  const acorn = await resolveAcorn()
  if (!acorn) die('找不到可用的 acorn 解析器（不联网安装）：试过 node_modules / .deploy-tmp/survey-022rc1/closure022 / dsh-client-ui-responsive')
  if (rels.length === 0) die('清单为空（' + root + '）——拒绝把「没扫到」当通过')
  const failures = []
  let parsed = 0
  for (const rel of rels) {
    const text = readFileSync(join(root, rel), 'utf8')
    try {
      acorn.parse(text, { ecmaVersion: ECMA_VERSION, sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true })
      parsed++
    } catch (error) {
      failures.push({
        rel,
        message: String(error && error.message ? error.message : error),
        loc: error && error.loc ? (error.loc.line + ':' + error.loc.column) : '?',
      })
    }
  }
  return { acorn, rels, failures, parsed }
}

const report = (r, root) => {
  console.log('  解析器: acorn@' + r.acorn.version + '（' + r.acorn.dir + '），语法档位 ' + ECMA_LABEL + '（ecmaVersion=' + ECMA_VERSION + '）')
  console.log('  清单: ' + r.rels.length + ' 个浏览器面文件（' + root + '）')
  for (const f of r.failures.slice(0, 20)) console.error('  FAIL ' + f.rel + ' @' + f.loc + ' —— ' + f.message)
  if (r.failures.length > 20) console.error('  …还有 ' + (r.failures.length - 20) + ' 个')
  if (r.failures.length > 0) {
    console.error('CHECK-BROWSER-PARSE-FLOOR FAILED（' + r.failures.length + ' / ' + r.rels.length
      + ' 个文件在 ' + ECMA_LABEL + ' 档位下解析失败——老内核解析期即抛 SyntaxError，整个模块一行不执行）')
    return 1
  }
  console.log('CHECK-BROWSER-PARSE-FLOOR PASSED（' + r.parsed + ' / ' + r.rels.length + ' 个文件在 ' + ECMA_LABEL + ' 档位下解析通过）')
  return 0
}

const selfTest = async () => {
  const acorn = await resolveAcorn()
  if (!acorn) die('自检需要 acorn')
  const fails = []
  let count = 0
  const t = (label, ok) => { count++; if (!ok) fails.push(label); console.log((ok ? 'PASS  ' : 'FAIL  ') + '[self-test] ' + label) }
  const parses = (src) => {
    try { acorn.parse(src, { ecmaVersion: ECMA_VERSION, sourceType: 'module', allowAwaitOutsideFunction: true }); return true } catch { return false }
  }
  // 注意：acorn 把「类字段 / 私有字段 / static 块」统一挂在 ES2022 档位，ES2021 一律拒绝。
  // 这与真实 Chromium 的逐特性发布节奏不完全一致（类字段 Chrome 72、static 块 Chrome 94），
  // 所以本门的口径是**保守**的：它可能比真机更严，但绝不会放过真机解析不了的东西。
  t('正控：ES2021 代码可解析', parses('const a = 1; function f(x) { return x ?? 0 }'))
  t('负控：类静态初始化块 static{} 在 ES2021 档位必须解析失败', parses('class C { static { this.x = 1 } }') === false)
  t('负控：私有字段 #x 在 ES2021 档位必须解析失败', parses('class C { #x = 1 }') === false)
  t('正控：顶层 await 在 ES2021 module 下可解析（不应误报）', parses('await 1') === true)
  t('负控：类字段在 ES2021 档位必须解析失败（acorn 保守口径）', parses('class C { x = 2 }') === false)
  t('载荷：字符串里的 static{} 不得误报', parses('const s = "class C { static {} }"') === true)
  t('载荷：注释里的 static{} 不得误报', parses('// class C { static {} }\nconst a = 1') === true)
  // 清单判据：口径与 check-browser-syntax-floor 同源
  t('清单：dsh-web-frontend/dist/**/*.js 命中', isBrowserFace('node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-abc.js') === true)
  t('清单：任意包 lib/client.js 命中', isBrowserFace('node_modules/@deepseek-ai/dsh-client-ui-foo/lib/client.js') === true)
  t('清单：lib/index.js 不命中（不是浏览器面）', isBrowserFace('node_modules/@deepseek-ai/dsh-foo/lib/index.js') === false)
  t('清单：dist 下非 dsh-web-frontend 不命中', isBrowserFace('node_modules/@deepseek-ai/dsh-foo/dist/x.js') === false)
  // tar 成员口径（与 isBrowserFace 同一函数，只是剥前缀）：必须和扫描口径一致，
  // 否则「解包哪些」与「扫哪些」会各写一份规则并漂移。
  t('tar 成员：./usr/.../lib/client.js 命中', isBrowserFaceTarMember('./usr/lib/node_modules/@deepseek-ai/dsh-client-ui-foo/lib/client.js') === true)
  t('tar 成员：usr/.../dsh-web-frontend/dist/a.js 命中', isBrowserFaceTarMember('usr/lib/node_modules/@deepseek-ai/dsh-web-frontend/dist/a.js') === true)
  t('tar 成员：目录项（结尾 /）不命中', isBrowserFaceTarMember('usr/lib/node_modules/@deepseek-ai/dsh-client-ui-foo/lib/') === false)
  t('tar 成员：usr/lib/libmenu.so 不命中（Windows 非法文件名，绝不能进解包清单）', isBrowserFaceTarMember('usr/lib/libmenu.so') === false)
  t('tar 成员：usr/bin/bash 不命中', isBrowserFaceTarMember('usr/bin/bash') === false)
  // 真实解包负控（回归 2026-11-06 缺陷）：整包 `tar -xJf` 在 Windows 上会被 usr/lib/*.so
  // 的非法文件名打死，所以按清单精确解包。这里造一个同时含 .so 与 client.js 的小 tar.xz，
  // 断言 materialize 只挑出 client.js 且能读到内容——把「只解浏览器面」这条钉进自检。
  let tarOk = false
  let tarDetail = '（跳过：无 tar）'
  const probe = spawnSync('tar', ['--version'], { encoding: 'utf8' })
  if (probe.status === 0) {
    const tdir = mkdtempSync(join(tmpdir(), 'parse-floor-tar-'))
    try {
      mkdirSync(join(tdir, 'src', 'usr', 'lib'), { recursive: true })
      mkdirSync(join(tdir, 'src', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh-client-ui-x', 'lib'), { recursive: true })
      writeFileSync(join(tdir, 'src', 'usr', 'lib', 'libmenu.so'), 'not really an elf')
      writeFileSync(join(tdir, 'src', 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh-client-ui-x', 'lib', 'client.js'), 'export const ok = 1\n')
      const tarPath = join(tdir, 'probe.tar.xz')
      const made = spawnSync('tar', ['-cJf', tarPath, '-C', join(tdir, 'src'), 'usr'], { encoding: 'utf8' })
      if (made.status === 0) {
        const m = materialize(tarPath)
        try {
          tarOk = m.rels.length === 1
            && /dsh-client-ui-x\/lib\/client\.js$/.test(m.rels[0])
            && readFileSync(join(m.root, m.rels[0].split('/').join(sep)), 'utf8').includes('ok = 1')
          tarDetail = 'rels=' + JSON.stringify(m.rels)
        } finally { m.cleanup() }
      } else { tarDetail = '（跳过：打包失败 ' + (made.stderr || '').slice(0, 120) + '）' }
    } finally { rmSync(tdir, { recursive: true, force: true }) }
  }
  t('tar 直读：含 .so 与 client.js 的归档只解出 client.js 且内容可读（' + tarDetail + '）', tarOk)
  if (fails.length > 0) {
    console.error('CHECK-BROWSER-PARSE-FLOOR SELF-TEST FAILED（' + fails.length + ' / ' + count + ' 项）：' + fails.join('；'))
    return 1
  }
  console.log('CHECK-BROWSER-PARSE-FLOOR SELF-TEST PASSED（' + count + ' 项判别力断言：ES2021 正控 / static 块与私有字段负控 / 载荷不误报 / 清单口径同源）')
  return 0
}

if (has('self-test')) process.exit(await selfTest())
const input = argOf('scan')
if (!input) die('用法: node scripts/check-browser-parse-floor.mjs --scan <stageRoot|tar.xz> | --self-test')
const { root, rels, cleanup } = materialize(input)
try {
  const r = await runScan(root, rels)
  process.exit(report(r, input))
} finally {
  cleanup()
}
