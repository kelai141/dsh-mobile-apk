#!/usr/bin/env node
// check-retired-plugins.mjs — 退役插件防回退门禁（dsh-model-capability；0.14.8 退役）。
//
// ── 为什么这条门存在（历史事故）──────────────────────────────────────────────
// 0.13.8-b ST-06 / F-ENV-04 的事故形态是「云端 pluginDirs 少一个权威 patch 已挂载的插件」：
// 两条构建链各写一份注入集，云端那份少一个包，本地链照常产出、云端照常打包成功，
// 而**没有任何门禁能发现少了一个已挂载的插件**。当时的修法是把注入集提成
// scripts/plugin-dirs.json 单一常量（两条链读同一份）。
//
// 0.14.8 起 plugins/dsh-model-capability 整体退役（本仓连目录都不存在），同一个事故换了方向复现：
// 构建/发布入口里仍留着对它的引用（注入集条目、构建期目录快照生成段、profile 装配 insert 行）。
// 这类残留**不会让任何一步变红**：
//   · 插件目录不存在时 existsSync 静默跳过，目录快照生成段直接 no-op；
//   · 注入集里多一条指向不存在目录的项，打包照常成功；
//   · workflow 的 prepare 步骤最多打印一条 cp 失败，脚本自己并不判错。
// 于是「少一个已挂载插件且无门禁可发现」的历史形态重新成立，而且包已不存在，排查要重新考古。
//
// ── 判据（扫描面 = 构建/发布入口；**不扫** docs/、release/、AGENTS.md）──────────
// 历史记录与发布说明按设计保留旧引用，扫它们只会逼人删历史。扫描面就是下面的 7 个入口。
//
//   1. 6 个文本入口逐行扫 token  dsh-model-capability  与  catalog-snapshot ：
//      **注释行允许**（trim 后以 # 或 // 开头，只打 INFO 不判红）。入口文件里要写清
//      「这个包已退役、别再挂回来」时，理由必须留在原地；判红只针对**可执行引用**。
//      块注释（/* */、<# #>）的续行**不豁免**（只按行首判定，fail-closed）：
//      历史说明请写成行注释，或者写进本文件。
//   2. scripts/plugin-dirs.json（JSON 没有注释语义）单独判：
//      · 解析后 dirs / externals / retiredExternals 三个数组都不得含退役 token；
//      · **整个文件文本**不得出现两个 token —— 连 $comment 里的历史说明也不留 token，
//        改写文字即可（这条比第 1 条严，是刻意的：JSON 里没有「注释 vs 可执行」之分）。
//   3. scripts/profile-web.cordis.patch.yml 不得出现装配行
//      - id: model-capability  或  name: '@dsh-android/dsh-model-capability'（注释允许）。
//      前者不含 dsh- 前缀，token 扫描抓不到，故单列一条。
//
// 为什么 token 是 dsh-model-capability 而不是裸 model-capability：dsh-android-model-capability
// 是另一个插件名，裸 token 会把它一起判红 —— 那是假阳性，会让真违规淹在噪声里。
//
// ── 命中后的修法（二选一）────────────────────────────────────────────────────
//   a. 从入口移除引用（默认做法）；
//   b. 确实要重新引入该插件：先在 issue 里登记 provenance（谁维护 / 从哪来 / 为什么必须回来），
//      再改本文件末尾的 ALLOW 允许清单（必须写 reason 与 until，到期自动判红）。
//      删掉这道门、改扫描面、或把违规行改成注释形态，都不算修法：注释只承载历史与理由。
//
// 用法：node scripts/check-retired-plugins.mjs             # 校验（CI 与两条构建链）
//       node scripts/check-retired-plugins.mjs --self-test  # 判别力自证（临时目录；不依赖仓库现状）
// 退出码：0 = 通过；1 = 可执行引用残留 / 允许已过期；2 = 布局不可解析（入口缺席 / JSON 不可解析）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)

/**
 * 扫描面：构建/发布入口（唯一清单）。
 *
 * 刻意**不含** docs/ 与 release/：历史记录与发布说明按设计保留旧引用，扫它们只会逼人删历史。
 * 入口改名/挪位必须同步改这里 —— 文件缺席按「布局不可解析」判 exit 2，不静默放行。
 */
export const TEXT_ENTRIES = [
  '.github/workflows/build-apk-source.yml',
  '.github/workflows/release.yml',
  'scripts/build-apk-013.ps1',
  'scripts/build-apk.mjs',
  'scripts/build-snapshot-013.mjs',
  'scripts/profile-web.cordis.patch.yml',
]
/** JSON 入口：没有注释语义，判据比文本入口更严（见文件头判据 2）。 */
export const JSON_ENTRY = 'scripts/plugin-dirs.json'
export const SCAN_ENTRIES = [...TEXT_ENTRIES, JSON_ENTRY]

/** 退役 token：插件包名 + 它独有的构建期产物名（catalog-snapshot.json 只被这个插件消费）。 */
export const RETIRED_TOKENS = ['dsh-model-capability', 'catalog-snapshot']

/** plugin-dirs.json 里必须干净的三个数组（dirs/externals 参与注入，retiredExternals 只是历史位置表）。 */
export const JSON_ARRAYS = ['dirs', 'externals', 'retiredExternals']

/**
 * profile-web.cordis.patch.yml 的装配行形态。
 *
 * 为什么单列：装配行写的是**插件 id**（- id: model-capability），不含 dsh- 前缀，
 * 退役 token 扫描抓不到它；而它一旦在，引擎就会尝试挂载一个不存在的包。
 * 只认「整行就是一条 id/name」的形态，避免误判叙述性文本。
 */
export const ASSEMBLY_PATTERNS = [
  { label: 'id: model-capability', re: /^\s*-\s*id:\s*['"]?model-capability['"]?\s*$/ },
  { label: "name: '@dsh-android/dsh-model-capability'", re: /^\s*name:\s*['"]?@[^'"]*\bdsh-model-capability['"]?\s*$/ },
]

/**
 * 允许清单（默认空 = 默认拒绝）。
 *
 * 只登记「已按文件头修法 b 在 issue 里登记 provenance、且必须回到某个入口」的条目：
 *   { entry: '<相对路径>', reason: '<issue 链接 + 为什么必须回来>', until: 'YYYY-MM-DD' }
 * 缺 reason/until 或已过期都不放行（避免允许变成永久静默）。退役态下本表应为空。
 */
export const ALLOW = []

/** 注释行：trim 后以 # 或 // 开头。只按行首判定（块注释续行不豁免，见文件头）。 */
const isCommentLine = (line) => {
  const t = String(line).trim()
  return t.startsWith('#') || t.startsWith('//')
}

/** 统一的违规行格式：<file>:<line>: <trimmed line>。 */
export const fmt = (v) => v.relPath + ':' + v.line + ': ' + v.text

/**
 * 文本入口扫描（纯函数，自测与真检共用）。
 *
 * @param {string} text 文件全文
 * @param {string} relPath 相对路径（决定是否追加 yml 装配行判据）
 * @returns {{violations: object[], infos: object[]}}
 */
export function scanText(text, relPath) {
  const violations = []
  const infos = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '') continue
    const hits = RETIRED_TOKENS.filter((token) => line.includes(token))
    if (hits.length === 0) continue
    const where = { relPath, line: i + 1, text: line }
    if (isCommentLine(line)) {
      infos.push({ ...where, reason: '注释行（历史说明允许保留）' })
      continue
    }
    violations.push({ ...where, reason: '可执行引用含退役 token: ' + hits.join(' / ') })
  }
  if (relPath === 'scripts/profile-web.cordis.patch.yml') {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (line === '' || isCommentLine(line)) continue
      for (const pat of ASSEMBLY_PATTERNS) {
        if (!pat.re.test(line)) continue
        // 同一行已经按 token 判过就不再重复列一条（装配行里的包名本身含 token）。
        if (violations.some((v) => v.line === i + 1)) continue
        violations.push({ relPath, line: i + 1, text: line, reason: '装配行（' + pat.label + '）把退役插件挂回 profile' })
      }
    }
  }
  return { violations, infos }
}

/**
 * plugin-dirs.json 扫描（纯函数）。
 *
 * 双重判据：三个数组逐项（能点名是哪个数组）+ 全文本 token（JSON 没有注释语义，历史说明也不留 token）。
 * 数组项已在某行报过时，全文本那一条不再重复。
 */
export function scanJsonEntry(text, relPath) {
  const violations = []
  const infos = []
  const lines = String(text).split(/\r?\n/)
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (e) {
    return { violations, infos, parseError: 'JSON 不可解析（' + e.message + '）' }
  }
  for (const key of JSON_ARRAYS) {
    const arr = manifest[key]
    if (!Array.isArray(arr)) return { violations, infos, parseError: '缺数组或类型不对：' + key }
    for (const item of arr) {
      if (typeof item !== 'string') continue
      if (!RETIRED_TOKENS.some((token) => item.includes(token))) continue
      const idx = lines.findIndex((l) => l.includes(item))
      violations.push({
        relPath,
        line: idx >= 0 ? idx + 1 : 0,
        text: JSON.stringify(item),
        reason: '注入集数组 ' + key + ' 仍含退役 token',
      })
    }
  }
  const reported = new Set(violations.map((v) => v.line))
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '') continue
    const hits = RETIRED_TOKENS.filter((token) => line.includes(token))
    if (hits.length === 0) continue
    if (reported.has(i + 1)) continue
    violations.push({
      relPath,
      line: i + 1,
      text: line.length > 200 ? line.slice(0, 200) + '…' : line,
      reason: '文件文本含退役 token（JSON 无注释语义，历史说明也不留 token）: ' + hits.join(' / '),
    })
  }
  return { violations, infos }
}

/**
 * 对一棵树求判（自测用临时树，真检用仓库根）。
 *
 * @param {string} root 树根
 * @param {object[]} allow 允许清单（默认 ALLOW）
 * @returns {{violations: object[], allowed: object[], infos: object[], problems: string[]}}
 */
export function evaluate(root, allow = ALLOW) {
  const violations = []
  const infos = []
  const problems = []
  for (const rel of SCAN_ENTRIES) {
    const abs = join(root, rel)
    if (!existsSync(abs)) {
      problems.push('扫描面入口缺席：' + rel + '（改名/挪位必须同步改本文件的扫描清单）')
      continue
    }
    const text = readFileSync(abs, 'utf8')
    const res = rel === JSON_ENTRY ? scanJsonEntry(text, rel) : scanText(text, rel)
    if (res.parseError !== undefined) problems.push(rel + '：' + res.parseError)
    violations.push(...res.violations)
    infos.push(...res.infos)
  }
  // 允许清单（默认空）：命中登记项不判红，但仍打印；缺 reason/until 或过期一律按违规处理。
  const remain = []
  const allowed = []
  for (const v of violations) {
    const entry = allow.find((a) => a !== null && a.entry === v.relPath)
    if (entry === undefined) { remain.push(v); continue }
    if (!entry.reason || !entry.until) {
      remain.push({ ...v, reason: v.reason + '（允许清单缺 reason/until，按违规处理）' })
      continue
    }
    if (Date.parse(entry.until) < Date.now()) {
      remain.push({ ...v, reason: v.reason + '（允许已过期 until ' + entry.until + '）' })
      continue
    }
    allowed.push({ ...v, allowedBy: entry })
  }
  return { violations: remain, allowed, infos, problems }
}

/** 退出码映射（自测与真检共用同一处，避免「自检说绿、真跑另一码」）。 */
export const exitCodeOf = (result) => (result.problems.length > 0 ? 2 : result.violations.length > 0 ? 1 : 0)

/** 打印并返回退出码。失败时把「为什么这条门存在」与两种修法一并说清。 */
function report(result) {
  for (const p of result.problems) console.error('FAIL  布局: ' + p)
  for (const a of result.allowed) {
    console.log('WARN  ' + fmt(a) + '  [允许清单放行：' + a.allowedBy.reason + '，until ' + a.allowedBy.until + ']')
  }
  for (const i of result.infos) console.log('INFO  ' + fmt(i) + '  [注释行，历史说明允许保留]')
  for (const v of result.violations) console.error('FAIL  ' + fmt(v) + '  [' + v.reason + ']')

  if (result.problems.length > 0) {
    console.error('CHECK-RETIRED-PLUGINS FAILED（扫描面不可解析）')
    console.error('  修法：确认那 7 个入口是否被改名/挪走；入口集合变化必须同步改本文件的 TEXT_ENTRIES / JSON_ENTRY。')
    return 2
  }
  if (result.violations.length > 0) {
    console.error('')
    console.error('CHECK-RETIRED-PLUGINS FAILED（' + result.violations.length + ' 处可执行引用指向已退役插件）')
    console.error('  为什么这条门存在：历史上云端 pluginDirs 少了一个「权威 patch 已挂载」的插件，而没有任何门禁')
    console.error('  能发现——打包成功、装配失败/功能缺席，只能等设备上暴露。dsh-model-capability 已于 0.14.8')
    console.error('  退役（本仓连目录都没有），构建/发布入口里再留引用就是同一个事故的翻版。')
    console.error('  修法二选一：')
    console.error('    a. 从入口移除该引用（默认做法）。注释形态保留历史说明是允许的，删除引用即可。')
    console.error('    b. 确实要重新引入该插件：先在 issue 里登记 provenance（谁维护 / 从哪来 / 为什么必须回来），')
    console.error('       再改 scripts/check-retired-plugins.mjs 的 ALLOW 允许清单（必须带 reason 与 until）。')
    console.error('  不要靠删这道门、改扫描面、或把违规行改成注释形态来「修」它。')
    return 1
  }
  console.log('CHECK-RETIRED-PLUGINS PASSED（' + SCAN_ENTRIES.length + ' 个构建/发布入口均无退役引用；'
    + result.infos.length + ' 处注释说明允许保留）')
  return 0
}

// ── --self-test：临时目录构造样本，**不依赖仓库现状** ────────────────────────
//
// 为什么必须自带样本：Lead 清理完引用后仓库是干净的，靠仓库现状做自检会变成「恒绿假证」——
// 门禁被判据改坏也照样 PASSED。这里每个用例都在临时目录里造树，跑的是与真检同一条 evaluate()。
const selfTest = (silent) => {
  const fails = []
  let count = 0
  const t = (label, ok, detail) => {
    count += 1
    if (!ok) fails.push(label + (detail === undefined ? '' : ' -> ' + detail))
    else if (!silent) console.log('PASS  [self-test] ' + label)
  }
  // 干净样本：历史说明**只写在注释里**（这正是要保留的形态），另外混一处 dsh-android-model-capability 夹具。
  const CLEAN = {
    '.github/workflows/build-apk-source.yml': [
      'name: build-apk-source',
      'on: [workflow_dispatch]',
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: node scripts/build-apk.mjs --abi arm64',
      '      # 模型能力插件 dsh-model-capability 已于 0.14.8 退役：本链不得再注入或装配它',
      '      - run: echo plugins/dsh-android-model-capability-0.2.1.tgz',
    ].join('\n') + '\n',
    '.github/workflows/release.yml': [
      'name: release',
      'on: [workflow_dispatch]',
      'jobs:',
      '  publish:',
      '    steps:',
      '      - run: node scripts/build-release.ps1',
      '      # 历史：0.14.8 起 dsh-model-capability 退役，发布链不再生成 catalog-snapshot.json',
    ].join('\n') + '\n',
    'scripts/build-apk-013.ps1': [
      '$ErrorActionPreference = "Stop"',
      '# 注入集历史：dsh-model-capability 已退役，别再挂回来',
      '$pluginManifest = Get-Content (Join-Path $Root "scripts\plugin-dirs.json") -Raw | ConvertFrom-Json',
      'foreach ($d in $pluginManifest.dirs) { Write-Host $d }',
    ].join('\n') + '\n',
    'scripts/build-apk.mjs': [
      "import { readFileSync } from 'node:fs'",
      '// 注入集历史：dsh-model-capability 已退役，别再挂回来',
      'export const PLUGIN_MANIFEST = readFileSync("scripts/plugin-dirs.json", "utf8")',
    ].join('\n') + '\n',
    'scripts/build-snapshot-013.mjs': [
      '// 0g 段已随插件退役删除（原 dsh-model-capability 的目录快照生成）',
      'export const STAGE = ".deploy-tmp/snapshot-013"',
    ].join('\n') + '\n',
    [JSON_ENTRY]: JSON.stringify({
      $comment: '构建链注入集单一常量；模型能力插件已退役，入口不得再引用它。',
      dirs: ['plugins/dsh-android-bridge'],
      externals: ['vendor/dshmarketplace-plugin'],
      retiredExternals: ['vendor/dsh-undo-savepoint'],
    }, null, 2) + '\n',
    'scripts/profile-web.cordis.patch.yml': [
      '- insert:',
      '    - id: android-bridge',
      "      name: '@dsh-android/dsh-android-bridge'",
      '# 历史：dsh-model-capability 已退役，本 patch 不再有它的 insert 行',
    ].join('\n') + '\n',
  }
  const work = mkdtempSync(join(tmpdir(), 'retired-plugins-self-'))
  const makeRoot = (mutate) => {
    const root = mkdtempSync(join(work, 'case-'))
    const files = { ...CLEAN }
    if (mutate) mutate(files)
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) continue
      const abs = join(root, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, text)
    }
    return root
  }
  try {
    // 1-3 正控：干净样本（注释里的 token 允许）
    const cleanRoot = makeRoot()
    const clean = evaluate(cleanRoot)
    t('正控：入口干净（历史说明只写在注释里）-> exit 0', exitCodeOf(clean) === 0, 'code=' + exitCodeOf(clean))
    t('正控：注释行里的 token 被识别并计数（不是没看见）', clean.infos.length >= 3, 'infos=' + clean.infos.length)
    t('正控：dsh-android-model-capability 夹具不判红（裸 model-capability 会误伤，本门刻意不用它）',
      clean.violations.length === 0, JSON.stringify(clean.violations))

    // 4-5 负控：ps1 里恢复可执行注入引用
    let ps1 = CLEAN['scripts/build-apk-013.ps1'] + '$pluginDirs += @(Join-Path $Root "plugins/dsh-model-capability")\n'
    const ps1Line = ps1.split('\n').findIndex((l) => l.includes('dsh-model-capability') && !l.trim().startsWith('#')) + 1
    let res = evaluate(makeRoot((files) => { files['scripts/build-apk-013.ps1'] = ps1 }))
    t('负控：注入集里出现可执行引用 -> exit 1', exitCodeOf(res) === 1, 'code=' + exitCodeOf(res))
    t('负控：违规按 <file>:<line>: <trimmed> 定位（行号对得上，不是只报文件名）',
      res.violations.length === 1 && res.violations[0].line === ps1Line
        && fmt(res.violations[0]).startsWith('scripts/build-apk-013.ps1:' + ps1Line + ': '),
      JSON.stringify(res.violations))

    // 6 负控：恢复目录快照生成段（catalog-snapshot token）
    const snapText = CLEAN['scripts/build-snapshot-013.mjs']
      + "const outFile = join(ROOT, 'plugins', 'dsh-model-capability', 'lib', 'catalog-snapshot.json')\n"
    res = evaluate(makeRoot((files) => { files['scripts/build-snapshot-013.mjs'] = snapText }))
    t('负控：恢复目录快照生成段（catalog-snapshot 可执行行）-> exit 1', exitCodeOf(res) === 1, 'code=' + exitCodeOf(res))

    // 7 负控：plugin-dirs.json 的 dirs 里塞回该包
    res = evaluate(makeRoot((files) => {
      const m = JSON.parse(files[JSON_ENTRY])
      m.dirs.push('plugins/dsh-model-capability')
      files[JSON_ENTRY] = JSON.stringify(m, null, 2) + '\n'
    }))
    t('负控：plugin-dirs.json 的 dirs 塞回该包 -> exit 1', exitCodeOf(res) === 1, 'code=' + exitCodeOf(res))
    t('负控：JSON 数组违规点名到具体数组（dirs）',
      res.violations.some((v) => String(v.reason).includes('数组 dirs')), JSON.stringify(res.violations))

    // 8 负控：$comment 里留 token（JSON 无注释语义，历史说明也不留 token）
    res = evaluate(makeRoot((files) => {
      const m = JSON.parse(files[JSON_ENTRY])
      m.$comment = '历史缺陷：云端 pluginDirs 曾少一个插件（dsh-model-capability）'
      files[JSON_ENTRY] = JSON.stringify(m, null, 2) + '\n'
    }))
    t('负控：$comment 里留 token 同样判红（JSON 里的历史说明不留 token）', exitCodeOf(res) === 1, 'code=' + exitCodeOf(res))

    // 9 负控：装配行把插件挂回 profile（- id: model-capability 不含 dsh- 前缀，token 扫描抓不到）
    res = evaluate(makeRoot((files) => {
      files['scripts/profile-web.cordis.patch.yml'] += '    - id: model-capability\n'
    }))
    t('负控：patch 里出现 - id: model-capability 装配行 -> exit 1', exitCodeOf(res) === 1, 'code=' + exitCodeOf(res))
    t('负控：装配行按「装配行」判据报出（不是靠 token）',
      res.violations.some((v) => String(v.reason).includes('装配行')), JSON.stringify(res.violations))

    // 10-12 允许清单（默认空）：登记项放行、缺字段/过期不放行
    const allowOk = [{ entry: 'scripts/build-apk-013.ps1', reason: 'issue #1234 已登记 provenance', until: '2999-01-01' }]
    const negRoot = makeRoot((files) => { files['scripts/build-apk-013.ps1'] = ps1 })
    const allowRes = evaluate(negRoot, allowOk)
    t('允许清单：已登记且未过期 -> 放行（仍打印 WARN）',
      exitCodeOf(allowRes) === 0 && allowRes.allowed.length === 1, JSON.stringify(allowRes.allowed))
    t('允许清单：已过期 -> 不再放行',
      exitCodeOf(evaluate(negRoot, [{ ...allowOk[0], until: '2000-01-01' }])) === 1)
    t('允许清单：缺 reason/until -> 按违规处理',
      exitCodeOf(evaluate(negRoot, [{ entry: 'scripts/build-apk-013.ps1' }])) === 1)

    // 13 布局负控：扫描面入口缺席不得静默放行
    const missing = makeRoot((files) => { files['.github/workflows/release.yml'] = null })
    const missingRes = evaluate(missing)
    t('布局：入口缺席 -> exit 2（不静默放行）',
      exitCodeOf(missingRes) === 2 && missingRes.problems.length === 1, JSON.stringify(missingRes.problems))

    // 14 布局负控：JSON 不可解析 -> exit 2
    const brokenJson = makeRoot((files) => { files[JSON_ENTRY] = '{ "dirs": [\n' })
    t('布局：plugin-dirs.json 不可解析 -> exit 2', exitCodeOf(evaluate(brokenJson)) === 2)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return { fails, count }
}

if (argv.includes('--self-test')) {
  const { fails: stFails, count } = selfTest(false)
  if (stFails.length > 0) {
    console.error('CHECK-RETIRED-PLUGINS SELF-TEST FAILED（' + stFails.length + ' / ' + count + ' 项）：' + stFails.join('；'))
    process.exit(1)
  }
  console.log('CHECK-RETIRED-PLUGINS SELF-TEST PASSED（' + count + ' 项判别力断言：正控放行 / 注释计数 / 安卓夹具不误伤 / '
    + 'ps1 可执行引用 / catalog-snapshot 可执行行 / JSON 数组 / JSON 文本 / 装配行 / 允许清单三态 / 布局两态）')
  process.exit(0)
}

process.exit(report(evaluate(ROOT)))
