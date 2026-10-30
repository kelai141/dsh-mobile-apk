#!/usr/bin/env node
// check-tool-name-promises.mjs —— 工具名「承诺 vs 实现」门禁（0.14.1 块N）。
//
// 为什么需要（0.14.1 设备实测缺陷 B2）：
//   指引里承诺的工具**从未被实现**。android_vdisplay_input 出现在三处模型可见文案里
//   （manage 的 android_screen_list 描述、android_ui_dump 失败文案与坐标指引、bridge 的坐标模式指引）
//   与 Skill 文档中，但全仓没有任何 defineTool 声明它——模型照指引调用只会拿到 unknown tool。
//   「指引指向一条不存在的路」比拒绝更难排查：模型会把 unknown tool 当成自己参数写错，反复重试。
//
// 判据（文本在场 != 行为在场，issue #1037）：
//   1) 注册集 = 插件 src 里所有**声明位**的 android_* 字面量——「键: 'android_x'」形态
//      （含 name:、以及 contract.ts 里的 tier: 'android_browser_tier' 这类名册键）
//      ∪ const *TOOL* = 'android_x' 常量形态（如 CAPABILITY_TOOL_NAME）。
//      **声明位只在剥注释后的文本上判**：一行 // name: 'android_ghost' 不是声明位
//      （旧实现在原始文本上匹配 = 注释即声明，复现①）。引号风格不比字节：单/双引号等价
//      （旧实现只认单引号，一次引号格式化就把已声明工具判成悬空，复现④）。
//   2) 提及集 = 插件 src 与 **docs/AGENTS/**/*.md** 里出现过的 android_* 标识符
//      （描述文案、guidance、注释都算）。拼接与模板字面量按**运行期等价**还原后再匹配：
//      'call ' + 'android_' + 'x' 与 `android_${'x'}` 都算提及（复现②）。
//      以 * 结尾的通配片段（android_vdisplay_*）与以下划线结尾的前缀片段不是工具名。
//   3) 插件面：提及集 ⊆ 注册集；例外必须逐条写进 ALLOW 并注明理由。
//   4) docs 面：docs 里的提及若找不到声明位，必须报出来（复现③）。docs 可以**合法地**提到
//      不存在于本仓的名字（外部 MCP 封装、已下线工具的史实记述），这类名字逐条登记在
//      DOC_NON_PROMISES，每条必须有理由与登记时间，且**过期即红**（名字已声明 / 文档里已无此提及）。
//
// 实测基线（2026-10-30）：插件面 26 声明 / 26 提及 / 0 漏；docs 面 4 条非承诺登记，0 漏。
//
// 用法：
//   node scripts/check-tool-name-promises.mjs             # 两仓布局自适应
//   node scripts/check-tool-name-promises.mjs --self-test # 判别力自证（注释/拼接/引号/docs 五族双向用例）
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const APK_ROOT = resolve(HERE, '..')
const BACKTICK = '\u0060'

/**
 * 允许「被提及但未声明」的例外（**插件面**）。只允许是真实存在的非本仓工具，且必须写明理由；
 * 空数组是本仓的常态——加任何一条都应在 PR 里被质疑。
 */
const ALLOW = []

/**
 * docs 面的「非承诺」登记：文档里合法出现、但本仓确实没有声明位的名字。
 *
 * 与 ALLOW 的区别：ALLOW 是「名字属于另一个产品面」，本表是「这句话不是在承诺一个工具」。
 * 二者都**必须有理由**且**过期即红**（见 staleDocEntries）：豁免一旦不再需要就必须删掉，
 * 否则它会把后来的真承诺一起放行。
 */
const DOC_NON_PROMISES = [
  {
    name: 'android_adb_shell_exec',
    why: '史实记述：gotchas.md 坑 249 记的是「ADB 通道恒判未就绪」时该名字永不返回 via:adb，本仓从未声明它',
    since: '2026-10',
  },
  {
    name: 'android_ui_describe',
    why: '外部 MCP 封装名（会话侧工具，非本仓插件工具面），emulator-test-protocol.md 的 B 轨原语旁注',
    since: '2026-10',
  },
  {
    name: 'android_ui_resolve',
    why: '外部 MCP 封装名（同 android_ui_describe），不在本仓插件工具面',
    since: '2026-10',
  },
  {
    name: 'android_ui_tap',
    why: '外部 MCP 封装名（同 android_ui_describe），不在本仓插件工具面',
    since: '2026-10',
  },
]

/** 声明位形态 A： name: 'android_x' / tier: 'android_browser_tier'（名册键）。单/双引号等价。 */
const DECL_KEY = /\b[\w$]+:\s*(['"])(android_[a-z0-9_]+)\1/g
/** 声明位形态 B： export const CAPABILITY_TOOL_NAME = 'android_capabilities'。单/双引号等价。 */
const DECL_CONST = /(?:export\s+)?const\s+\w*TOOL\w*\s*=\s*(['"])(android_[a-z0-9_]+)\1/g
/** 提及：任意位置的 android_* 标识符。 */
const MENTION = /\bandroid_[a-z][a-z0-9_]*/g

/**
 * 剥掉行注释与块注释：注释的每个字符替换成空格（换行保留），因此**行号与偏移不变**，
 * 注释两侧的文本也不会被粘成一个本不存在的匹配。字符串/模板字面量内容原样保留
 * （声明位与提及本来就活在字符串里）。
 */
export function stripComments(source) {
  // 逐行剥：**引号状态不跨行**。正则字面量里的引号（如 /['"]/）若跨行保持「在字符串里」，
  // 后面整段真实注释就会被当成字符串内容放过 —— 那正是本门禁要防的假绿（实测踩过：
  // manage/src/index.ts 里一处正则引号把文件尾部一行 // name: 'android_x' 判成了声明位）。
  // 状态只在行内维持 ⇒ 最坏是「本行后半段被多剥」，方向是误判红，不会把注释判绿。
  let inBlock = false
  return source.split('\n').map((line) => {
    let out = ''
    let index = 0
    let quote = null
    while (index < line.length) {
      const c = line[index]
      const next = line[index + 1]
      if (inBlock) {
        if (c === '*' && next === '/') { inBlock = false; out += '  '; index += 2; continue }
        out += ' '
        index += 1
        continue
      }
      if (quote !== null) {
        if (c === '\\') { out += c + (next ?? ''); index += 2; continue }
        out += c
        if (c === quote) quote = null
        index += 1
        continue
      }
      if (c === '/' && next === '/') { out += ' '.repeat(line.length - index); index = line.length; continue }
      if (c === '/' && next === '*') { inBlock = true; out += '  '; index += 2; continue }
      if (c === '"' || c === "'" || c === BACKTICK) { quote = c; out += c; index += 1; continue }
      out += c
      index += 1
    }
    return out
  }).join('\n')
}

/** 读一个字符串字面量（含模板字面量与 ${} 内的静态串），返回 { value, end }；end 为字面量后一位。 */
function readLiteral(source, start) {
  const quote = source[start]
  let index = start + 1
  let value = ''
  while (index < source.length) {
    const c = source[index]
    if (c === '\\') {
      value += source[index] + (source[index + 1] ?? '')
      index += 2
      continue
    }
    if (quote === BACKTICK && c === '$' && source[index + 1] === '{') {
      // 模板插值：静态字符串表达式按运行期值代入，其余用不可作标识符的哨兵隔开。
      let depth = 0
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '{') depth += 1
        else if (source[cursor] === '}') { depth -= 1; if (depth === 0) break }
        cursor += 1
      }
      const inner = source.slice(index + 2, cursor).trim()
      const staticString = /^(['"])([\s\S]*)\1$/.exec(inner)
      value += staticString === null ? '\u0001' : staticString[2]
      index = cursor + 1
      continue
    }
    if (c === quote) { index += 1; break }
    value += c
    index += 1
  }
  return { value, end: index }
}

/**
 * 把「相邻字符串字面量的 + 拼接」与模板字面量还原成运行期字符串值，输出到其所在位置。
 * 判据目的：'call ' + 'android_' + 'x' 在运行期是 'call android_x'，它同样是一条承诺——
 * 只看原始文本会完全看不见它（issue #1037 复现②）。
 */
export function restoreStringExpressions(source) {
  // 逐行还原（同 stripComments：不跨行持有引号状态）。跨行的 + 拼接不猜——宁可漏还原
  // 也不要把两行的片段拼成一个本不存在的名字（那会制造假红）。
  return source.split('\n').map(restoreOnLine).join('\n')
}

/** 单行内的字面量拼接/模板插值还原。 */
function restoreOnLine(line) {
  let out = ''
  let index = 0
  while (index < line.length) {
    const c = line[index]
    if (c !== '"' && c !== "'" && c !== BACKTICK) { out += c; index += 1; continue }
    const first = readLiteral(line, index)
    let value = first.value
    let cursor = first.end
    for (;;) {
      let probe = cursor
      while (probe < line.length && /\s/.test(line[probe])) probe += 1
      if (line[probe] !== '+') break
      probe += 1
      while (probe < line.length && /\s/.test(line[probe])) probe += 1
      if (probe >= line.length) break
      const quote = line[probe]
      if (quote !== '"' && quote !== "'" && quote !== BACKTICK) break
      const next = readLiteral(line, probe)
      value += next.value
      cursor = next.end
    }
    out += value
    index = cursor
  }
  return out
}

/** 通配/前缀片段不是工具名：android_vdisplay_* 与 android_vdisplay_ 都属此列。 */
function isFragmentMention(text, start, name) {
  if (name.endsWith('_')) return true
  let probe = start + name.length
  while (probe < text.length && (text[probe] === ' ' || text[probe] === '\t')) probe += 1
  return text[probe] === '*'
}

/** 从一段文本里收集提及（原始文本 + 拼接/模板还原后的等价文本）。 */
export function mentionsOf(text, into = new Set()) {
  // 三面都看：原始文本（注释里的提及同样算承诺，fail-closed）、剥注释文本、
  // 以及**还原拼接/模板后**的等价文本（#1037 复现②）。
  const clean = stripComments(text)
  for (const candidate of [text, clean, restoreStringExpressions(clean)]) {
    for (const m of candidate.matchAll(MENTION)) {
      if (isFragmentMention(candidate, m.index, m[0])) continue
      into.add(m[0])
    }
  }
  return into
}

export function collectRegistry(texts) {
  const out = new Set()
  for (const t of texts) {
    const clean = stripComments(t)
    for (const m of clean.matchAll(DECL_KEY)) out.add(m[2])
    for (const m of clean.matchAll(DECL_CONST)) out.add(m[2])
  }
  return out
}

export function collectMentions(texts) {
  const out = new Set()
  for (const t of texts) mentionsOf(t, out)
  return out
}

/** @returns 提及但未声明的名字（已剔除 ALLOW）。 */
export function findPromises(registry, mentions, allow = ALLOW) {
  const allowed = new Set(allow.map((e) => e.name))
  return [...mentions].filter((n) => !registry.has(n) && !allowed.has(n)).sort()
}

/** 非承诺登记是否合规（理由/时间在场，且名字确实还没被声明）。 */
export function validDocEntry(entry, declaredNames = []) {
  if (typeof entry.name !== 'string' || entry.name === '') return false
  if (typeof entry.why !== 'string' || entry.why.trim().length < 10) return false
  if (typeof entry.since !== 'string' || entry.since.trim() === '') return false
  if (declaredNames.includes(entry.name)) return false
  return true
}

/** docs 面：提及但未声明的名字 − 合规的 DOC_NON_PROMISES 登记。 */
export function findDocPromises(registry, docMentions, entries = DOC_NON_PROMISES) {
  const declared = [...registry]
  const excused = new Set(entries.filter((e) => validDocEntry(e, declared)).map((e) => e.name))
  return [...docMentions].filter((n) => !registry.has(n) && !excused.has(n)).sort()
}

/** 陈旧登记：名字已被声明，或文档里已经没有这一条提及（豁免不再需要）。 */
export function staleDocEntries(entries, registry, docMentions) {
  return entries
    .filter((entry) => registry.has(entry.name) || !docMentions.has(entry.name))
    .map((entry) => entry.name + (registry.has(entry.name) ? '（已声明）' : '（文档里已无此提及）'))
}

function pluginSourceFiles(root) {
  const bases = [join(root, 'plugins'), join(root, '..', 'plugins')]
  const pluginsDir = bases.find((b) => existsSync(b))
  if (pluginsDir === undefined) throw new Error('找不到 plugins/ 目录：' + bases.join(' | '))
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'lib', 'dist', 'test'].includes(entry.name)) continue
        walk(p)
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        files.push(p)
      }
    }
  }
  for (const name of readdirSync(pluginsDir)) {
    const src = join(pluginsDir, name, 'src')
    if (existsSync(src) && statSync(src).isDirectory()) walk(src)
  }
  return { pluginsDir, files }
}

/** docs/AGENTS 下的全部 .md —— 模型可见指引的语料面（issue #1037 复现③）。 */
function docFiles(root) {
  const bases = [join(root, 'docs', 'AGENTS'), join(root, '..', 'docs', 'AGENTS')]
  const docsDir = bases.find((b) => existsSync(b))
  if (docsDir === undefined) return { docsDir: null, files: [] }
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.md')) files.push(p)
    }
  }
  walk(docsDir)
  return { docsDir, files }
}

function selfTest() {
  const cases = [
    {
      name: '正例：声明与提及一致',
      texts: ["  ctx.tools.register(defineTool({ name: 'android_ui_dump', description: '用 android_ui_dump 取树' }))"],
      expect: [],
    },
    {
      name: '反例（0.14.1 B2 原形）：文案承诺了没实现的工具',
      texts: ["  description: '纯 Shizuku 下改用 android_vdisplay_input（tap/swipe/keyevent/text）'"],
      expect: ['android_vdisplay_input'],
    },
    {
      name: '正例：常量声明位也算数（不得误报 android_capabilities）',
      texts: ["export const CAPABILITY_TOOL_NAME = 'android_capabilities'", "  text: '先调 android_capabilities'"],
      expect: [],
    },
    {
      name: '正例：名册键形态也算数（browser contract 的 tier 项）',
      texts: ["  tier: 'android_browser_tier',", "  text: '用 android_browser_tier 看档位'"],
      expect: [],
    },
    {
      name: '反例 #1037 复现①：注释里的 name: 不算声明位（注释即声明必须判红）',
      texts: ["// name: 'android_ghost_comment'", "  text: '请调 android_ghost_comment'"],
      expect: ['android_ghost_comment'],
    },
    {
      name: '反例 #1037 复现①：块注释里的声明位同样不算',
      texts: ["/* name: 'android_ghost_block' */", "  text: '请调 android_ghost_block'"],
      expect: ['android_ghost_block'],
    },
    {
      name: '反例 #1037 复现②：字符串拼接还原后必须算提及（拼接不可见必须判红）',
      texts: ["  text: 'call ' + 'android_' + 'ghost_concat' + ' now'"],
      expect: ['android_ghost_concat'],
    },
    {
      name: '反例 #1037 复现②：模板字面量里的静态段同样还原',
      texts: ['  text: `call android_ghost_tpl now`'],
      expect: ['android_ghost_tpl'],
    },
    {
      name: '正例 #1037 复现④：双引号声明位等价（引号风格变化不得假红）',
      texts: ['  name: "android_screen_list", description: "用 android_screen_list 列屏"'],
      expect: [],
    },
    {
      name: '正例：通配片段 android_vdisplay_* 不是工具名（不得假红）',
      texts: ['  模型调 android_vdisplay_* 工具', "export const VDISPLAY_TOOL_NAME = 'android_vdisplay_status'"],
      expect: [],
    },
  ]
  let failed = 0
  for (const c of cases) {
    const texts = c.texts.map((t) => t.split('`').join(BACKTICK))
    const got = findPromises(collectRegistry(texts), collectMentions(texts))
    if (JSON.stringify(got) !== JSON.stringify(c.expect)) {
      failed += 1
      console.error('SELF-TEST FAIL（' + c.name + '）：期望 ' + JSON.stringify(c.expect) + ' 实得 ' + JSON.stringify(got))
    }
  }
  // #1037 复现③：docs 面的提及必须能报出来（且登记过的非承诺不算漏）。
  const docRegistry = new Set(['android_ui_dump'])
  const docMentions = new Set(['android_ui_dump', 'android_ghost_doc'])
  const docMissed = findDocPromises(docRegistry, docMentions, [])
  if (JSON.stringify(docMissed) !== JSON.stringify(['android_ghost_doc'])) {
    failed += 1
    console.error('SELF-TEST FAIL（#1037 复现③ docs 提及未声明必须报出）：实得 ' + JSON.stringify(docMissed))
  }
  const excused = findDocPromises(docRegistry, docMentions, [{ name: 'android_ghost_doc', why: '外部 MCP 封装名，非本仓工具面', since: '2026-10' }])
  if (excused.length !== 0) {
    failed += 1
    console.error('SELF-TEST FAIL（合规的非承诺登记应放行）：实得 ' + JSON.stringify(excused))
  }
  const noReason = findDocPromises(docRegistry, docMentions, [{ name: 'android_ghost_doc', since: '2026-10' }])
  if (noReason.length !== 1) {
    failed += 1
    console.error('SELF-TEST FAIL（无理由的非承诺登记不得放行）：实得 ' + JSON.stringify(noReason))
  }
  const stale = staleDocEntries([{ name: 'android_ui_dump', why: 'x'.repeat(12), since: '2026-10' }], docRegistry, docMentions)
  if (stale.length !== 1) {
    failed += 1
    console.error('SELF-TEST FAIL（已声明的名字仍挂在非承诺登记里 = 陈旧，必须判出）：实得 ' + JSON.stringify(stale))
  }
  if (failed > 0) {
    console.error('CHECK-TOOL-NAME-PROMISES SELF-TEST FAILED（' + failed + ' 例）')
    process.exit(1)
  }
  console.log('CHECK-TOOL-NAME-PROMISES SELF-TEST PASSED（' + (cases.length + 4) + ' 项：注释 / 拼接 / 模板 / 引号 / docs 五族双向用例）')
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const { pluginsDir, files } = pluginSourceFiles(APK_ROOT)
  const texts = files.map((f) => readFileSync(f, 'utf8'))
  const registry = collectRegistry(texts)
  const mentions = collectMentions(texts)
  const pluginMissing = findPromises(registry, mentions)

  const { docsDir, files: docs } = docFiles(APK_ROOT)
  const docMentions = new Set()
  for (const f of docs) mentionsOf(readFileSync(f, 'utf8'), docMentions)
  const docMissing = findDocPromises(registry, docMentions)
  const staleDocs = staleDocEntries(DOC_NON_PROMISES, registry, docMentions)
  const badEntries = DOC_NON_PROMISES.filter((e) => !validDocEntry(e, [...registry])).map((e) => e.name)

  if (pluginMissing.length > 0) {
    console.error('CHECK-TOOL-NAME-PROMISES FAILED[plugin-promise]：以下工具名在插件文案里被承诺，但全仓没有声明位——')
    for (const name of pluginMissing) {
      // 报位置时把「拼接还原后才看得见」的文件也算上（否则拼接形态会报一个空文件名列表）。
      const where = files.filter((f, i) => texts[i].includes(name) || restoreStringExpressions(stripComments(texts[i])).includes(name))
        .slice(0, 3).map((f) => relative(APK_ROOT, f))
      console.error('  ' + name + '  <- 出现在：' + where.join(' , '))
    }
    console.error('  修法二选一：① 补实现（defineTool 声明该名字）；② 若该工具不存在也不该存在，改指引文案。')
    console.error('  **不得**把名字加进 ALLOW 了事（那是把「指引指向不存在的路」制度化）。')
  }
  if (docMissing.length > 0) {
    console.error('CHECK-TOOL-NAME-PROMISES FAILED[doc-promise]：docs 指引里承诺了、但全仓没有声明位——')
    for (const name of docMissing) {
      const where = docs.filter((f) => readFileSync(f, 'utf8').includes(name)).slice(0, 3).map((f) => relative(APK_ROOT, f))
      console.error('  ' + name + '  <- 出现在：' + where.join(' , '))
    }
    console.error('  修法二选一：① 补实现；② 改文档文案。若该提及本就不是承诺（外部 MCP 封装名/史实记述），')
    console.error('  登记进本脚本的 DOC_NON_PROMISES 并写明 why 与 since（过期即红）。')
  }
  if (badEntries.length > 0 || staleDocs.length > 0) {
    console.error('CHECK-TOOL-NAME-PROMISES FAILED[stale-doc-exemption]：DOC_NON_PROMISES 登记不合规——')
    if (badEntries.length > 0) console.error('  缺 why（>=10 字）/ since 或已被声明：' + badEntries.join(', '))
    if (staleDocs.length > 0) console.error('  过期（豁免已不再需要，请删掉）：' + staleDocs.join(', '))
  }
  if (pluginMissing.length > 0 || docMissing.length > 0 || badEntries.length > 0 || staleDocs.length > 0) {
    process.exit(1)
  }
  console.log('CHECK-TOOL-NAME-PROMISES PASSED（声明 ' + registry.size + ' 个 · 插件提及 ' + mentions.size + ' 个 · docs 提及 '
    + docMentions.size + ' 个 · 漏报 0' + (ALLOW.length > 0 ? ' · 白名单 ' + ALLOW.length + ' 条' : ' · 无白名单')
    + ' · docs 非承诺登记 ' + DOC_NON_PROMISES.length + ' 条）')
  console.log('  （扫描 ' + files.length + ' 个插件源文件 + ' + docs.length + ' 个 docs 指引文件，docs 目录：'
    + (docsDir === null ? '<缺席>' : relative(APK_ROOT, docsDir) || '.') + '）')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
