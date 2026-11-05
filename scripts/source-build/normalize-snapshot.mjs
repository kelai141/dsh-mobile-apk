#!/usr/bin/env node
// normalize-snapshot.mjs — 快照的**语义归一化**：把「表示层差异」从摘要里剔除，
// 使「两次构建语义等价」成为可外部复算的机械判据。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// 本链的产物**不是逐字节可复现**的（实测见 docs/AGENTS/gotchas.md 坑 210）：
// 同一套构建输入、相隔 90 分钟的两次构建，APK sha256 不同。逐文件比对后，
// 差异全部落在表示层——JSON/YAML 的**映射键序**与 pnpm 的若干**时间戳字段**：
//
//   259 × @deepseek-ai/*/package.json       仅键序不同（内容逐字相同）
//     1 × pnpm-workspace.yaml               allowBuilds 映射键序不同（值全同）
//     1 × node_modules/.modules.yaml        prunedAt 时间戳
//     1 × .pnpm-workspace-state-v1.json     lastValidatedTimestamp 时间戳
//     1 × usr/var/lib/dpkg/available        **真实内容差异**（多两个包）——本条不归一化，见下
//
// 若不剔除它们，任何「重跑比哈希」的验证都会失效。而那个失效是**静默的**：
// 哈希本来就漂 ⇒「两次不同」不再是信号 ⇒ 真差异（比如某次构建静默少了一个包）
// 也一并看不见了。恒亮的警报灯等于没有警报灯。
//
// ── 三条设计约束（缺一不可）────────────────────────────────────────────────
//   1. **规则封闭**：每条规则都要能写清「为什么这个差异不可能影响行为」，不得泛化。
//      尤其：`dpkg/available` 那条**不得**归一化——它是事实差异（包数 3003 vs 3001），
//      不是表示差异。把两者混进同一句「反正不影响」，就是给静默失败开后门。
//   2. **可无依赖复算**：外部人拿到产物 + 本脚本即可重算，不引第三方包
//      （故 YAML 部分自带受限归一化器，而非依赖 js-yaml）。
//   3. **响亮失败**：遇到不认识的形态一律 throw，不得静默放过——否则本脚本自己
//      就成了新的静默出口。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   tar -xJf <snapshot.tar.xz> -C <dir>
//   node normalize-snapshot.mjs <dir> [--out report.json]
//
// 退出码：0 = 成功；1 = 遇到无法安全归一化的形态（消息里给出文件与原因）。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

const sha256 = (data) => createHash('sha256').update(data).digest('hex')
/** 时间戳字段的固定哨兵值：保留键位（差异可见）但抹掉取值（差异无语义）。 */
const TIMESTAMP_SENTINEL = '<normalized-timestamp>'

// ── 规则清单（封闭；每条都要写清理由）──────────────────────────────────────

/**
 * 引擎根在快照内的固定位置。下面三条 YAML/状态规则只对**精确路径**生效——因为同名文件
 * 在别处还存在，且形态不同：`home/.dsh/profiles/{web,headless}/pnpm-workspace.yaml` 是
 * **序列**（`- .`），而序列顺序**有**语义，排序它就是制造假绿。
 * 这条边界是被 fail-loud 抓出来的：首版用 `endsWith` 泛化匹配，跑到 profiles/headless
 * 就响亮报错了——这正是「遇到不认识的形态必须报错而不是猜」的价值。
 */
const ENGINE_ROOT = 'usr/lib/node_modules/@deepseek-ai/dsh'

/**
 * 规范化 JSON：递归按字典序重建对象（JSON 对象键序按规范无语义），
 * 并把 `blankFields` 列出的字段值替换成哨兵。
 */
export function canonicalJson(text, blankFields = []) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out = {}
      for (const key of Object.keys(value).sort()) {
        out[key] = blankFields.includes(key) ? TIMESTAMP_SENTINEL : walk(value[key])
      }
      return out
    }
    return value
  }
  return JSON.stringify(walk(JSON.parse(text)), null, 2) + '\n'
}

/**
 * 把 tarball 内 `package/package.json` 的键按规范重排，整体重打包（坑 210）。
 *
 * 与快照级归一化同源：**构建期写进去的规范形态**与**校验期算出来的**必须是同一件事，
 * 故共用 `canonicalJson` 并放在同一个模块里。
 *
 * 为什么需要：`pnpm pack` 产出的 package.json **键序不稳定**——实测 316 个包里 260 个的
 * tarball 哈希两次构建不同，而 version 全部相同，差异只在对象键序。下游整套哈希
 * （tarball → 快照 → APK）因此每次都漂，使「重跑比哈希」这条最廉价的完整性判据永远失效。
 *
 * 为什么在 build 侧就地做（而不是产物生成之后）：此处上游尚无任何哈希被记录、也没有签名，
 * 规范化后的字节**就是**构建产物本身——此后所有 provenance 描述的都是真正发货的东西。
 * 放到产物末端则要重做 tar/xz、重打 zip、**重新签名**，反而引入三个新的不确定性来源。
 *
 * 重打包必须**自身确定**，否则只是把一个不确定性换成另一个。四条都用**可移植**手段做到，
 * 不依赖 GNU 专有开关（`--sort=name` / `--mtime=@0` / `--owner=0` 在 bsdtar 上不认，
 * 而「本地验不了、要等一小时 CI 才知道」本身就不可接受）：
 *   ① 条目顺序 —— 显式传入**递归排序后**的路径清单，顺序由我们给，不由 readdir 决定；
 *   ② 时间戳   —— 先 `utimesSync` 把整棵树钉到固定时刻，再打包；
 *   ③ 属主     —— 不指定：CI 上恒为同一个用户，跨运行本来就不变；
 *   ④ gzip 头  —— Node 的 gzip 不写原文件名，mtime 固定为 0；不得交给
 *      `tar -czf`——它调用的 gzip 会把**当前时刻**写进头里，跨秒重跑即换字节
 *      （Windows 上实测：同一输入两次重打包只差 header 的 4 字节 mtime）。
 * 保留 npm 的 `package/` 前缀——消费方 `inject-dsh-engine-packages.mjs` 按
 * `--strip-components=1` 解包，前缀层数不能变。
 */
const REPACK_MTIME = new Date(0)
/** 递归列出目录内全部条目（相对 `base` 的路径），按名排序——顺序即打包顺序。 */
function sortedEntryList(base) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      out.push(relative(base, full).replaceAll('\\', '/'))
      // 先钉 mtime 再递归：目录自身也进 tar 头
      utimesSync(full, REPACK_MTIME, REPACK_MTIME)
      if (lstatSync(full).isDirectory()) walk(full)
    }
  }
  walk(base)
  return out
}

export function canonicalizePackedManifest(tarball, name = '<tarball>') {
  const work = mkdtempSync(join(tmpdir(), 'dsh-pack-'))
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', work])
    const stage = join(work, 'package')
    if (!existsSync(join(stage, 'package.json'))) {
      throw new Error(`${name}: packed tarball has no package/package.json`)
    }
    writeFileSync(join(stage, 'package.json'), canonicalJson(readFileSync(join(stage, 'package.json'), 'utf8')))
    const entries = sortedEntryList(stage).map((rel) => join('package', rel))
    const archive = join(work, 'canonical.tar')
    execFileSync('tar', ['-cf', archive, '-C', work, ...entries])
    // gzipSync 的 header 固定 mtime=0 且不含文件名；输出只由输入字节决定。
    writeFileSync(tarball, gzipSync(readFileSync(archive)))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// 块映射条目：三种键形态（双引号 / 单引号 / 裸键）+ 冒号 + 取值。
// 引号键内部**允许** `:`（本链的键就含它：`"@deepseek-ai/dsh-subprocess-local@file:///home/..."`），
// 首版把 `:` 一律排除在键字符外，直接把这一类键判成了「不是块映射条目」。
const KVP = /^([ ]*)(?:"([^"]*)"|'([^']*)'|([^:#"'\][{}]+)):[ ]?(.*)$/
const keyOf = (m) => m[2] ?? m[3] ?? m[4]
const valueOf = (m) => (m[5] ?? '').trim()
/** 取值以这些字符开头 ⇒ 块标量 / 流式集合 / 锚点别名 / 标签 / 注释，本归一化器不处理，判红。 */
const UNSUPPORTED_VALUE = /^[|>{[&*!#]/
/** 缩进里出现制表符 ⇒ 不可靠的块结构，判红（YAML 禁 tab 缩进）。 */
const TAB_INDENT = /^[ ]*\t/

/**
 * 受限 YAML **块映射**归一化：只处理「顶层 `key:` + 缩进一段简单映射」这一种形态
 * （本链里需要它的只有 `pnpm-workspace.yaml` 一个文件）。
 *
 * 为什么受限：YAML 的**映射**键序无语法语义（与 JSON 同），但**序列**顺序**有**语义。
 * 想当然地「整体排序」会把序列顺序也改掉，那是制造假绿。故此处：
 *   - 只排序映射条目，序列/流式/锚点/块标量一律**判红**而不是猜；
 *   - 无法安全处理时 throw，由调用方把文件与原因打出来。
 */
export function canonicalYamlMapping(text, pathForError = '<yaml>') {
  // 逐行**按结构位置**校验，而不是「整行扫禁用字符」——后者会误伤：本链的键里含 `@`
  // （`"@earendil-works/pi-ai@0.85.1"`），首版把 `@` 列进禁用集就直接把它误判了。
  const lines = text.split('\n')
  const blocks = []
  let current = null
  for (const line of lines) {
    if (line.trim() === '') continue
    const reject = (why) => {
      throw new Error(`${pathForError}: ${why}，拒绝猜测：${line.slice(0, 80)}`)
    }
    if (TAB_INDENT.test(line)) reject('缩进含制表符')
    if (/^\s*#/.test(line)) reject('含注释（注释位置会影响重建结果）')
    if (/^\s*(---|\.\.\.)\s*$/.test(line)) reject('含文档分隔符')
    const match = line.match(KVP)
    if (!match) reject('不是块映射条目（疑似序列/流式/缩进块）')
    const indent = match[1].length
    const key = keyOf(match)
    const value = valueOf(match)
    if (UNSUPPORTED_VALUE.test(value)) reject('取值疑似块标量/流式集合/锚点/标签')
    if (indent === 0) {
      if (value !== '') reject('顶层条目带值（本归一化器只处理「块头 + 缩进映射」形态）')
      current = { key, children: [] }
      blocks.push(current)
      continue
    }
    if (!current) reject('首行即缩进（疑似序列）')
    if (value === '') reject('缩进条目无值（疑似嵌套块或多行标量）')
    current.children.push({ key, line: line.replace(/[ ]+$/, '') })
  }
  if (blocks.length === 0) throw new Error(`${pathForError}: 未解析出任何顶层块，拒绝猜测`)
  return blocks
    .sort((a, b) => a.key.localeCompare(b.key))
    .flatMap((block) => [
      `${block.key}:`,
      ...block.children.sort((a, b) => a.key.localeCompare(b.key)).map((child) => child.line),
    ])
    .join('\n') + '\n'
}

/** 把某一行级时间戳字段的**取值**换成哨兵（保留键名与缩进，差异仍然可见）。 */
export function blankTimestampLine(text, field, pathForError = '<yaml>') {
  const re = new RegExp(`^(\\s*)("?${field}"?):(.*)$`, 'm')
  if (!re.test(text)) {
    throw new Error(`${pathForError}: 找不到时间戳字段 ${field}——规则的前提已不成立，拒绝静默放过`)
  }
  return text.replace(re, `$1$2: "${TIMESTAMP_SENTINEL}"`)
}

/**
 * 规则清单。`match` 收路径（正斜杠、相对快照根），`apply` 收文件文本。
 * 一条文件可命中多条（按数组顺序依次施加）。
 */
export const RULES = [
  {
    id: 'json-key-order',
    // 宽匹配（后缀）⇒ strict:false：.json 后缀下混有带注释的 tsconfig.json（实测 36 个），
    // 那不是 JSON，规则对其不适用，登记后放过。
    strict: false,
    note: 'JSON 对象键序按规范无语义（RFC 8259 §4），递归排序键不影响任何读取方',
    match: (p) => p.endsWith('.json'),
    apply: (text) => canonicalJson(text),
  },
  {
    id: 'yaml-mapping-key-order',
    strict: true, // 精确匹配：该文件**应当**是块映射，形态不符即判红
    note: 'YAML 映射键序无语义；仅对已知受影响的块映射文件施加（序列顺序有语义，故不泛化）',
    match: (p) => p === `${ENGINE_ROOT}/pnpm-workspace.yaml`,
    apply: (text, p) => canonicalYamlMapping(text, p),
  },
  {
    id: 'pnpm-pruned-timestamp',
    strict: true, // 精确匹配：找不到字段说明前提失效，判红而不是放过
    note: 'pnpm 记录本次 prune 时刻的字段，取值随构建时间变，无语义',
    match: (p) => p === `${ENGINE_ROOT}/node_modules/.modules.yaml`,
    apply: (text, p) => blankTimestampLine(text, 'prunedAt', p),
  },
  {
    id: 'pnpm-validated-timestamp',
    strict: true, // 精确匹配：同上
    note: 'pnpm workspace 状态文件的最近校验时刻（epoch ms），取值随构建时间变，无语义',
    match: (p) => p === `${ENGINE_ROOT}/node_modules/.pnpm-workspace-state-v1.json`,
    apply: (text) => canonicalJson(text, ['lastValidatedTimestamp']),
  },
]

// ── 遍历与摘要 ─────────────────────────────────────────────────────────────

const norm = (p) => p.split(sep).join('/')

/** 收集快照内全部条目：常规文件记内容，符号链接记**指向**（不跟随——链接目标变了是真差异）。 */
export function collectEntries(root) {
  const entries = []
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = norm(relative(root, full))
      const st = lstatSync(full)
      if (st.isSymbolicLink()) entries.push({ path: rel, kind: 'symlink', body: readlinkSync(full) })
      else if (st.isDirectory()) walk(full)
      else if (st.isFile()) entries.push({ path: rel, kind: 'file', body: readFileSync(full) })
    }
  }
  walk(root)
  return entries
}

/**
 * 归一化整个快照，返回报告。**`manifest` 一并返回**：两个快照比对时，只知「摘要不等」
 * 无法回答「差在哪」，而那个答案恰恰决定它是真差异、还是规则清单又漏了一类。
 */
export function normalizeSnapshot(root) {
  const entries = collectEntries(root)
  const ruleCounts = new Map()
  const skipped = []
  const manifest = []
  for (const entry of entries) {
    if (entry.kind === 'symlink') {
      manifest.push(`${entry.path}\0symlink\0${entry.body}`)
      continue
    }
    let text = entry.body.toString('utf8')
    let touched = false
    for (const rule of RULES) {
      if (!rule.match(entry.path)) continue
      try {
        text = rule.apply(text, entry.path)
      } catch (error) {
        // 「规则不适用于这个文件」与「这个文件有问题」是两回事，按**匹配方式的宽窄**区分：
        //   - 宽匹配（按后缀命中的 json-key-order）：文件根本不是 JSON 时规则本就不适用
        //     ⇒ 登记后放过（实测 1430 个 .json 里有 36 个是带注释的 tsconfig.json）。
        //   - 精确匹配（按路径命中的那三条 pnpm/yaml 规则）：那些文件**应当**是已知形态，
        //     对不上就是前提失效 ⇒ 一律响亮失败（故它们声明 strict 且抛普通 Error，
        //     不会因为恰好是 SyntaxError 就滑进「跳过」路径）。
        // 放过不等于静默：跳过的进 report.skipped[] 并在 CLI 打出，外部人看得到。
        if (rule.strict || !(error instanceof SyntaxError)) throw error
        skipped.push({ path: entry.path, rule: rule.id, reason: error.message.split('\n')[0] })
        continue
      }
      ruleCounts.set(rule.id, (ruleCounts.get(rule.id) ?? 0) + 1)
      touched = true
    }
    // 文本规则不得命中二进制：命中即说明规则清单写错了（例如误按后缀匹配到打包产物）
    if (touched && Buffer.from(text, 'utf8').includes(0)) {
      throw new Error(`${entry.path}: 被文本规则命中但内容是二进制——规则清单有误`)
    }
    manifest.push(`${entry.path}\0${touched ? 'normalized' : 'raw'}\0${sha256(text)}`)
  }
  manifest.sort()
  return {
    fileCount: entries.length,
    normalizedManifestSha256: sha256(manifest.join('\n')),
    rules: RULES.map((rule) => ({
      id: rule.id,
      strict: rule.strict === true,
      note: rule.note,
      applied: ruleCounts.get(rule.id) ?? 0,
    })),
    // 规则不适用而原样入摘要的文件；它们的内容若不稳定，摘要就会不同 ⇒ 届时由比对暴露
    skipped,
    manifest,
  }
}

function main() {
  // 参数解析放在 main 里（而不是模块顶层）：本文件同时作为模块被单测 import，
  // 顶层解析会在 import 时因「测试进程没有快照路径参数」而 process.exit(2)。
  const argv = process.argv.slice(2)
  const root = argv.find((a) => !a.startsWith('--'))
  if (!root) {
    console.error('usage: node normalize-snapshot.mjs <extracted-snapshot-dir> [--out report.json]')
    process.exit(2)
  }
  const outIndex = argv.indexOf('--out')
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : null
  const report = normalizeSnapshot(root)
  const serializable = { root, ...report, manifest: undefined }
  if (outPath) writeFileSync(outPath, JSON.stringify(serializable, null, 2) + '\n')
  console.log(`normalized snapshot digest: ${report.normalizedManifestSha256}`)
  console.log(`  files: ${report.fileCount}`)
  for (const rule of report.rules) console.log(`  rule ${rule.id.padEnd(28)} applied=${rule.applied}`)
  if (report.skipped.length) console.log(`  WARN 规则不适用而原样计入: ${report.skipped.length} 个（见 report.skipped[]）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
