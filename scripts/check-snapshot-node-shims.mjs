#!/usr/bin/env node
// check-snapshot-node-shims.mjs — 快照内 node 入口 shim 的「自定位 + 普通文件」门禁
//
// 真机实证（2026-10-31，arm64 真机 / HyperOS，实例跑在 Android 多用户 user 10 上）：
//   缺陷 1（构建期前缀烧死）：快照 usr/bin/pnpm 的 shim 把构建期设备前缀写死在 exec 行里
//     （/data/user/0/<包名>/files/usr/bin/node）。Android 的应用数据目录**随用户变化**：
//     user 10 上运行前缀是 /data/user/10/<包名>/files/usr，shim 指向不存在的路径 ⇒ 设备上 pnpm
//     exit 127，插件市场 / 普通插件 / subagent 全部装不上。构建期前缀不是运行期事实，shim 必须
//     用 $0 自己算前缀（自定位），构建期一个字面量都不烧。
//   缺陷 2（npm 不是普通文件）：快照 usr/bin/npm 是指向 ../lib/node_modules/npm/bin/npm-cli.js 的
//     **符号链接**。pnpm 在 dsh plugin add 的 passThruToNpm 里 spawnSync('npm')，经符号链接落地时
//     目标不在预期位置（ENOENT），市场一键安装的 npm 通道整条断掉。
// 两类缺陷的共同点：**构建期全绿、运行期必炸**。读源码看不出来（源码里拼的是 NEW_PREFIX，产物里
// 才是那个绝对值），所以判据必须落在**产物成员**上：类型（普通文件 vs symlink）、tar 模式（执行位）、
// 内容（首行 / 自定位要素 / 绝对前缀回流 / exec 目标在场）。
//
// 判据（同一套判据同时作用于两种输入面：产物 tar.xz / 解压后的 usr 树）：
//   N1 usr/bin/node 在场、普通文件、前 4 字节 == 7f 45 4c 46（ELF），tar 模式含执行位；
//   N2 usr/bin/pnpm 与 usr/bin/npm 在场、**普通文件**（npm 仍是 symlink = 缺陷 2 的旧形态）、
//      tar 模式含执行位；
//   N3 两个 shim 首行 == #!/system/bin/sh，且含自定位两要素
//      prefix=$(cd "$(dirname "$self")/.." && pwd) 与 exec "$prefix/bin/node"；
//   N4 两个 shim 的 exec 目标在快照内存在：
//      usr/lib/node_modules/pnpm/bin/pnpm.cjs、usr/lib/node_modules/npm/bin/npm-cli.js；
//   N5 两个 shim 文本内不得出现构建期设备绝对前缀（/data/user/<n>/ 或 /data/data/<pkg>/），
//      即缺陷 1 的反回归判据；命中时报告里点名 /data/user/<n>/。
//
// 用法：
//   node scripts/check-snapshot-node-shims.mjs <snapshot.tar.xz> [--require]
//   node scripts/check-snapshot-node-shims.mjs --stage <extractedUsrDir> [--require]
//   node scripts/check-snapshot-node-shims.mjs --self-test
// 退出码：0 = 通过（或 SKIP 结案）；1 = 有失败项（含 --require 档把 SKIP 转失败）；
//         2 = 用法错误 / 输入不可读。
//
// 输入面口径：
//   - tar 面是**产物面**（两条构建链与发布链用的就是它）。成员类型与模式取自 tar 头（-tvJf），
//     不读 Windows 解压后的权限位——那里根本没有 POSIX 执行位。
//   - stage 面是排障便利档（传入解压后的 **usr 目录本身**，里面有 bin/ 与 lib/）。它能看类型与内容，
//     但**没有 POSIX 模式**：执行位判据在 stage 面显式计一条 SKIP（--require 档把它转成失败），
//     绝不静默当成通过。
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync,
  readlinkSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TAR } from './lib/shell.mjs'

const SELF = fileURLToPath(import.meta.url)
const argv = process.argv.slice(2)
const REQUIRE = argv.includes('--require')

const NODE_REL = 'usr/bin/node'
const SHIMS = [
  { rel: 'usr/bin/pnpm', target: 'usr/lib/node_modules/pnpm/bin/pnpm.cjs' },
  { rel: 'usr/bin/npm', target: 'usr/lib/node_modules/npm/bin/npm-cli.js' },
]
const SHEBANG = '#!/system/bin/sh'
// 自定位两要素：前缀由 $0 反推 + node 相对前缀执行。两条都在场才算真自定位。
const SELF_LOCATE = 'prefix=$(cd "$(dirname "$self")/.." && pwd)'
const EXEC_NODE = 'exec "$prefix/bin/node"'
// 缺陷 1 的反回归判据：构建期设备绝对前缀。宁可误报（shim 里本不该出现任何 /data/ 绝对路径），
// 也不能漏报——漏报的后果是真机上 exit 127。
const BUILD_PREFIX_RE = /\/data\/(user\/\d+|data\/[^\s"]*)\//
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
// tar 列表首字符 -> 成员类型（- 普通文件 / l 符号链接 / d 目录 / h 硬链接 ...）。
const KIND = { '-': 'file', h: 'file', d: 'dir', l: 'symlink', b: 'other', c: 'other', p: 'other', s: 'other' }
const KIND_LABEL = { file: '普通文件', dir: '目录', symlink: '符号链接', other: '特殊文件', missing: '缺席' }

const usage = (why) => {
  console.error('CHECK-SNAPSHOT-NODE-SHIMS 用法错误：' + why)
  console.error('  node scripts/check-snapshot-node-shims.mjs <snapshot.tar.xz> [--require]')
  console.error('  node scripts/check-snapshot-node-shims.mjs --stage <extractedUsrDir> [--require]')
  console.error('  node scripts/check-snapshot-node-shims.mjs --self-test')
  process.exit(2)
}
const kindLabel = (kind) => KIND_LABEL[kind] ?? String(kind)
const linkHint = (d) => (d.kind === 'symlink' && d.link ? '（-> ' + d.link + '）' : '')
const hasExec = (perms) => typeof perms === 'string' && (perms[2] === 'x' || perms[5] === 'x' || perms[8] === 'x')
const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ')

/**
 * tar 面：先 -tvJf 取成员类型/模式（判 presence / type / 执行位），再一次性 -xJf 取内容（判 ELF 魔数 / 文本）。
 *
 * 为什么用 TAR 常量而不是裸 tar/WSL：Windows 上 PATH 里的 tar 常是 Git 自带 GNU tar，它把
 * D:\ 这样的参数当远端主机名（见 scripts/lib/shell.mjs 的 resolveTar 注释）；bsdtar 与 WSL 又不可混用。
 * 统一走 TAR 是唯一跨平台一致的口径。
 */
const tarFace = (archive) => {
  let listing
  try {
    listing = execFileSync(TAR, ['-tvJf', archive], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  } catch (e) {
    console.error('CHECK-SNAPSHOT-NODE-SHIMS 用法错误：归档不可读（' + String(e.message ?? e).split(/\r?\n/)[0] + '）')
    process.exit(2)
  }
  const entries = new Map()
  for (const rawLine of String(listing).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    if (line === '') continue
    // 首字符 = 类型，第 2..10 字符 = rwx 位。不是成员行（tar 的提示/统计行）就跳过。
    const perms = line.slice(1, 10)
    if (!/^[rwxsStT-]{9}$/.test(perms)) continue
    // 成员名前缀固定是 usr/（快照只有 usr 与 home 两面）。用锚点找名字，避免依赖日期/size 的列数
    // （实测中文 Windows 上 bsdtar 的日期列是「1月 01  2024」这种本地化形态）。
    const at = line.search(/\s(?:\.\/)?usr\//)
    if (at < 0) continue
    let rest = line.slice(at + 1)
    let link = null
    const arrow = rest.indexOf(' -> ')
    if (arrow >= 0) {
      link = rest.slice(arrow + 4).trim()
      rest = rest.slice(0, arrow)
    }
    const name = rest.replace(/^\.\//, '').replace(/\s+$/, '')
    entries.set(name, { kind: KIND[line[0]] ?? 'other', perms, link })
  }

  const work = mkdtempSync(join(tmpdir(), 'snapshot-node-shims-'))
  let extractError = null
  // 只解压「列表里声明为普通文件」的成员：符号链接在 Windows 上解压需要额外特权（而它本来就已判红），
  // 缺席成员也不该让解压整段失败——存在性由列表判定，内容缺失在判据里会如实报 FAIL。
  const wanted = [NODE_REL, ...SHIMS.map((s) => s.rel), ...SHIMS.map((s) => s.target)]
    .filter((rel) => entries.get(rel)?.kind === 'file')
  if (wanted.length > 0) {
    try {
      execFileSync(TAR, ['-xJf', archive, '-C', work, ...wanted], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 512 * 1024 * 1024,
      })
    } catch (e) {
      extractError = String(e.stderr ?? e.message ?? e).trim()
    }
  }
  const pathOf = (rel) => join(work, ...rel.split('/'))
  const firstBytes = (p, count) => {
    if (!existsSync(p)) return null
    const buf = Buffer.alloc(count)
    const fd = openSync(p, 'r')
    try {
      const got = readSync(fd, buf, 0, count, 0)
      return buf.subarray(0, got)
    } finally {
      closeSync(fd)
    }
  }
  return {
    label: archive,
    modeChecked: true,
    describe(rel) {
      const e = entries.get(rel)
      return e === undefined ? { kind: 'missing' } : e
    },
    readBytes(rel, count) {
      return entries.get(rel)?.kind === 'file' ? firstBytes(pathOf(rel), count) : null
    },
    readText(rel) {
      if (entries.get(rel)?.kind !== 'file') return null
      try { return readFileSync(pathOf(rel), 'utf8') } catch { return null }
    },
    extractError: () => extractError,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

/**
 * stage 面：解压后的 usr 树。类型/内容与 tar 面同判；POSIX 模式不可得（Windows 上的权限位不可信），
 * 由 modeChecked=false 显式计 SKIP。
 */
const stageFace = (stageRoot) => {
  const at = (rel) => join(stageRoot, ...(rel.startsWith('usr/') ? rel.slice(4) : rel).split('/'))
  return {
    label: '--stage ' + stageRoot,
    modeChecked: false,
    describe(rel) {
      let st
      try { st = lstatSync(at(rel)) } catch { return { kind: 'missing' } }
      if (st.isSymbolicLink()) {
        let link = null
        try { link = readlinkSync(at(rel)) } catch { /* 悬空链：照旧报符号链接 */ }
        return { kind: 'symlink', link }
      }
      if (st.isFile()) return { kind: 'file' }
      if (st.isDirectory()) return { kind: 'dir' }
      return { kind: 'other' }
    },
    readBytes(rel, count) {
      const p = at(rel)
      if (!existsSync(p)) return null
      const buf = Buffer.alloc(count)
      const fd = openSync(p, 'r')
      try {
        const got = readSync(fd, buf, 0, count, 0)
        return buf.subarray(0, got)
      } catch {
        return null
      } finally {
        closeSync(fd)
      }
    },
    readText(rel) {
      try { return readFileSync(at(rel), 'utf8') } catch { return null }
    },
    extractError: () => null,
    cleanup: () => {},
  }
}

/** 判据主体（两种输入面共用）。返回失败项数量；失败项已逐条打印。 */
const audit = (face) => {
  const failed = []
  let skipped = 0
  const fail = (label, detail) => {
    failed.push(label)
    console.log('FAIL  ' + label + (detail === undefined ? '' : ' -> ' + detail))
  }
  const pass = (label) => console.log('PASS  ' + label)
  const skip = (label, detail) => {
    skipped += 1
    console.log('SKIP(#' + skipped + ')  ' + label + (detail === undefined ? '' : ' -> ' + detail))
  }
  const expect = (label, ok, detail) => { if (ok) pass(label); else fail(label, detail) }

  console.log('快照面: ' + face.label + (face.modeChecked ? '' : '（stage 面：无 POSIX 模式，执行位判据不可核）'))
  const exErr = face.extractError()
  if (exErr) fail('快照成员解压失败（tar -xJf）', exErr.split(/\r?\n/)[0].slice(0, 200))

  // ── N1：usr/bin/node ─────────────────────────────────────────────────────
  const node = face.describe(NODE_REL)
  expect('N1 ' + NODE_REL + ' 在场', node.kind !== 'missing',
    '快照里没有 ' + NODE_REL + '：引擎没有可执行的 node（快照不完整）')
  if (node.kind !== 'missing') {
    expect('N1 ' + NODE_REL + ' 是普通文件', node.kind === 'file',
      '实际类型: ' + kindLabel(node.kind) + linkHint(node))
  }
  const magic = node.kind === 'file' ? face.readBytes(NODE_REL, 4) : null
  const isElf = magic !== null && magic.length === 4 && magic.equals(ELF_MAGIC)
  expect('N1 ' + NODE_REL + ' 前 4 字节是 ELF（7f 45 4c 46）', isElf,
    magic === null ? '内容不可读（成员未解出，或不是普通文件）' : '实际前 4 字节: ' + hex(magic))
  if (face.modeChecked) {
    expect('N1 ' + NODE_REL + ' tar 模式含执行位（' + String(node.perms ?? '-') + '）',
      node.kind === 'file' && hasExec(node.perms),
      'tar 头模式没有执行位：解压到设备后 /system/bin/sh 无法直接 exec 它')
  } else {
    skip('N1 ' + NODE_REL + ' 的 tar 模式执行位', 'stage 面没有 POSIX 模式（Windows 解压后的权限位不可信），改用 tar 面核')
  }

  // ── N2：两个 shim 必须是普通文件 ────────────────────────────────────────
  for (const shim of SHIMS) {
    const d = face.describe(shim.rel)
    expect('N2 ' + shim.rel + ' 在场', d.kind !== 'missing',
      '快照里没有 ' + shim.rel + '：' + (shim.rel.endsWith('npm')
        ? 'npm 通道缺席，pnpm 的 passThruToNpm 必 ENOENT'
        : 'pnpm 通道缺席，市场安装断链'))
    const isFile = d.kind === 'file'
    expect('N2 ' + shim.rel + ' 是普通文件', isFile,
      d.kind === 'symlink'
        ? '实际是符号链接' + linkHint(d) + '（缺陷 2 的旧形态：pnpm 的 passThruToNpm spawnSync npm 经它落地 ENOENT）'
        : '实际类型: ' + kindLabel(d.kind))
    if (face.modeChecked) {
      expect('N2 ' + shim.rel + ' tar 模式含执行位（' + String(d.perms ?? '-') + '）',
        isFile && hasExec(d.perms),
        isFile
          ? 'tar 头模式没有执行位：设备上 shim 不可执行（/system/bin/sh 拉不起来）'
          : '不是普通文件（' + kindLabel(d.kind) + '）：符号链接/目录不能当 shim 执行')
    } else {
      skip('N2 ' + shim.rel + ' 的 tar 模式执行位', 'stage 面没有 POSIX 模式，改用 tar 面核')
    }
  }

  // ── N3 / N5：shim 内容 ─────────────────────────────────────────────────
  const contents = new Map()
  for (const shim of SHIMS) {
    const d = face.describe(shim.rel)
    const content = d.kind === 'file' ? face.readText(shim.rel) : null
    contents.set(shim.rel, content)
    const why = content === null
      ? (d.kind === 'missing'
        ? '成员缺席，内容不可校验'
        : d.kind === 'symlink'
          ? '是符号链接' + linkHint(d) + '，内容不可按 shim 校验（缺陷 2 的旧形态）'
          : '内容不可读')
      : null
    const misses = []
    if (content === null) {
      misses.push(why)
    } else {
      const firstLine = content.split(/\r?\n/)[0]
      if (firstLine !== SHEBANG) misses.push('首行不是 ' + SHEBANG + '（实际 ' + JSON.stringify(firstLine) + '）')
      if (!content.includes(SELF_LOCATE)) misses.push('缺自定位要素 ' + SELF_LOCATE)
      if (!content.includes(EXEC_NODE)) misses.push('缺 exec 要素 ' + EXEC_NODE)
    }
    expect('N3 ' + shim.rel + ' 首行 ' + SHEBANG + ' + 自定位两要素', misses.length === 0, misses.join('；'))
  }

  // ── N4：exec 目标必须在快照内 ───────────────────────────────────────────
  for (const shim of SHIMS) {
    const target = face.describe(shim.target)
    const ok = target.kind === 'file' || target.kind === 'symlink'
    expect('N4 ' + shim.rel + ' 的 exec 目标在场: ' + shim.target, ok,
      target.kind === 'missing'
        ? '目标不在快照内：shim 执行时 node 会 ENOENT（' + basename(shim.rel) + ' 整条断链）'
        : '目标是' + kindLabel(target.kind) + '，不是可执行脚本')
  }

  // ── N5：构建期绝对前缀不得回流 ─────────────────────────────────────────
  for (const shim of SHIMS) {
    const content = contents.get(shim.rel)
    if (content === null) {
      fail('N5 ' + shim.rel + ' 不含构建期设备绝对前缀', '内容不可读，无法证明没有前缀回流')
      continue
    }
    const hit = BUILD_PREFIX_RE.exec(content)
    if (hit) {
      fail('N5 ' + shim.rel + ' 不含构建期设备绝对前缀',
        '命中 ' + JSON.stringify(hit[0]) + '：前缀随 Android 用户变化（user 10 = /data/user/10/...），'
        + '构建期写死即真机 exit 127（缺陷 1）')
    } else {
      pass('N5 ' + shim.rel + ' 不含构建期设备绝对前缀（/data/user/<n>/）')
    }
  }

  // 严格档：SKIP 不得结案（否则「stage 面核不了执行位」会静默变绿）。
  if (REQUIRE && skipped > 0) {
    fail('--require 严格档不得以 SKIP 结案（本次 ' + skipped + ' 处）',
      'stage 面没有 POSIX 模式判据；严格档请传 <snapshot.tar.xz>')
  }

  if (failed.length > 0) {
    console.error('CHECK-SNAPSHOT-NODE-SHIMS FAILED（' + failed.length + ' 项；快照面: ' + face.label
      + '；SKIP=' + skipped + '）：' + failed.slice(0, 3).join('；'))
  } else {
    console.log('CHECK-SNAPSHOT-NODE-SHIMS PASSED（快照面: ' + face.label + '；N1-N5 全部通过；SKIP=' + skipped + '）')
  }
  return failed.length
}

/**
 * 判别力自证（必须双向）：在临时目录造 usr 树 + 合成 tar.xz，5 例逐条跑自己。
 *
 * 为什么归档用 Python 的 tarfile 合成而不是「chmod 后 tar 打包」：Windows 没有 POSIX 执行位，
 * chmodSync 不会产生带 x 的成员头（check-snapshot-file-modes.mjs 的 --self-test 有同款实测）。
 * TarInfo.mode 是归档头字段，跨平台一致——这样「正样本必须有执行位」与「负控4 必须没有执行位」
 * 才有判别力。Python 是本仓既有依赖（同一条门禁的 --self-test 已在用），不是新增依赖。
 */
const selfTest = () => {
  const tmp = mkdtempSync(join(tmpdir(), 'snapshot-node-shims-selftest-'))
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const goodShim = (target) => [
    SHEBANG,
    '# dsh-mobile: 自定位 shim（前缀由 $0 推导，不烧构建期设备路径）',
    'self=$0',
    SELF_LOCATE,
    'exec "$prefix/bin/node" "$prefix/' + target.slice('usr/'.length) + '" "$@"',
    '',
  ].join('\n')
  // 缺陷 1 的原形：构建期前缀烧死在 exec 行里（真机快照实测的 268 字节 shim）。
  const oldShim = (target) => {
    const prefix = '/data/user/0/com.dsharnessmobile.shell/files/usr'
    return [
      SHEBANG,
      '# dsh-mobile: pnpm standalone shim（npm registry 打包，自包含；node 由快照提供）',
      'exec "' + prefix + '/bin/node" "' + prefix + '/' + target.slice('usr/'.length) + '" "$@"',
      '',
    ].join('\n')
  }
  const writeTree = (root, { pnpmText, npmText, npmFile = true }) => {
    const files = {
      'usr/bin/node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      'usr/bin/pnpm': pnpmText,
      'usr/lib/node_modules/pnpm/bin/pnpm.cjs': '#!/usr/bin/env node\nconsole.log(1)\n',
      'usr/lib/node_modules/npm/bin/npm-cli.js': '#!/usr/bin/env node\nconsole.log(1)\n',
    }
    if (npmFile) files['usr/bin/npm'] = npmText
    for (const [rel, data] of Object.entries(files)) {
      const p = join(root, ...rel.split('/'))
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, data)
    }
  }
  // 归档成员模式表：正样本全 0755；负控4 把两个 shim 降成 0644（tar 头无 x）。
  const specOf = ({ nodeMode = 0o755, pnpmMode = 0o755, npmMode = 0o755, npmKind = 'file' } = {}) => {
    const spec = [
      ['usr', 'dir', 0o755],
      ['usr/bin', 'dir', 0o755],
      ['usr/lib', 'dir', 0o755],
      ['usr/lib/node_modules', 'dir', 0o755],
      ['usr/lib/node_modules/pnpm', 'dir', 0o755],
      ['usr/lib/node_modules/pnpm/bin', 'dir', 0o755],
      ['usr/lib/node_modules/npm', 'dir', 0o755],
      ['usr/lib/node_modules/npm/bin', 'dir', 0o755],
      ['usr/bin/node', 'file', nodeMode],
      ['usr/bin/pnpm', 'file', pnpmMode],
      ['usr/lib/node_modules/pnpm/bin/pnpm.cjs', 'file', 0o644],
      ['usr/lib/node_modules/npm/bin/npm-cli.js', 'file', 0o644],
    ].map(([name, kind, mode]) => ({ name, kind, mode }))
    if (npmKind === 'file') spec.push({ name: 'usr/bin/npm', kind: 'file', mode: npmMode })
    if (npmKind === 'symlink') spec.push({ name: 'usr/bin/npm', kind: 'symlink', mode: 0o777, target: '../lib/node_modules/npm/bin/npm-cli.js' })
    return spec
  }
  const buildArchive = (root, archive, spec) => {
    const specPath = join(tmp, basename(archive) + '.json')
    writeFileSync(specPath, JSON.stringify(spec))
    const py = [
      'import io, json, os, sys, tarfile',
      'root, out, spec_path = sys.argv[1], sys.argv[2], sys.argv[3]',
      'with open(spec_path, encoding="utf-8") as fh:',
      '    spec = json.load(fh)',
      'with tarfile.open(out, "w:xz") as tf:',
      '    for item in spec:',
      '        info = tarfile.TarInfo(item["name"])',
      '        info.mode = int(item["mode"])',
      '        kind = item["kind"]',
      '        if kind == "dir":',
      '            info.type = tarfile.DIRTYPE',
      '            tf.addfile(info)',
      '        elif kind == "symlink":',
      '            info.type = tarfile.SYMTYPE',
      '            info.linkname = item["target"]',
      '            tf.addfile(info)',
      '        else:',
      '            with open(os.path.join(root, item["name"]), "rb") as fh:',
      '                data = fh.read()',
      '            info.size = len(data)',
      '            tf.addfile(info, io.BytesIO(data))',
    ].join('\n')
    execFileSync(python, ['-c', py, root, archive, specPath], { encoding: 'utf8' })
  }

  const goodPnpm = goodShim('usr/lib/node_modules/pnpm/bin/pnpm.cjs')
  const goodNpm = goodShim('usr/lib/node_modules/npm/bin/npm-cli.js')
  const cases = [
    {
      tag: 'ok', name: '正样本：自定位 shim + 普通文件 + 可执行位',
      tree: { pnpmText: goodPnpm, npmText: goodNpm }, spec: specOf(),
      tarExit: 0, tarMarker: 'CHECK-SNAPSHOT-NODE-SHIMS PASSED',
      stageExit: 0, stageMarker: 'CHECK-SNAPSHOT-NODE-SHIMS PASSED',
    },
    {
      tag: 'hardcoded', name: '负控1：pnpm shim 仍烧写 /data/user/0/... 构建期前缀（缺陷 1 原形）',
      tree: { pnpmText: oldShim('usr/lib/node_modules/pnpm/bin/pnpm.cjs'), npmText: goodNpm }, spec: specOf(),
      tarExit: 1, tarMarker: '/data/user/',
      stageExit: 1, stageMarker: '/data/user/',
    },
    {
      tag: 'no-npm', name: '负控2：缺 usr/bin/npm（普通文件缺席）',
      tree: { pnpmText: goodPnpm, npmText: '', npmFile: false }, spec: specOf({ npmKind: 'missing' }),
      tarExit: 1, tarMarker: 'N2 usr/bin/npm',
      stageExit: 1, stageMarker: 'N2 usr/bin/npm',
    },
    {
      tag: 'npm-symlink', name: '负控3：usr/bin/npm 仍是 symlink（缺陷 2 原形）',
      tree: { pnpmText: goodPnpm, npmText: '', npmFile: false }, spec: specOf({ npmKind: 'symlink' }),
      tarExit: 1, tarMarker: '符号链接',
      // stage 面需要宿主真的能建符号链接（Windows 非开发者模式会 EPERM）——建不出来就只验 tar 面。
      stageExit: 1, stageMarker: '符号链接', stageSymlink: true,
    },
    {
      tag: 'no-exec', name: '负控4：shim 无执行位（tar 模式 0644）',
      tree: { pnpmText: goodPnpm, npmText: goodNpm }, spec: specOf({ pnpmMode: 0o644, npmMode: 0o644 }),
      tarExit: 1, tarMarker: '执行位',
      // stage 面没有 POSIX 模式：这一例按设计**判绿**，且必须显式打印 SKIP 计数（不得静默）。
      stageExit: 0, stageMarker: 'SKIP(#1)',
    },
  ]

  let bad = 0
  try {
    for (const c of cases) {
      const root = join(tmp, c.tag)
      writeTree(root, c.tree)
      let stageNote = ''
      if (c.stageSymlink) {
        try {
          symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', join(root, 'usr', 'bin', 'npm'), 'file')
        } catch {
          c.stageExit = null
          stageNote = '；stage 面无法建符号链接（宿主权限），只验 tar 面'
        }
      }
      const archive = join(tmp, c.tag + '.tar.xz')
      buildArchive(root, archive, c.spec)

      const tarRun = spawnSync(process.execPath, [SELF, archive], { encoding: 'utf8' })
      const tarOut = (tarRun.stdout ?? '') + (tarRun.stderr ?? '')
      const tarOk = tarRun.status === c.tarExit && tarOut.includes(c.tarMarker)
      let stageOk = true
      let stageText = ''
      if (stageNote === '') {
        const stageRun = spawnSync(process.execPath, [SELF, '--stage', join(root, 'usr')], { encoding: 'utf8' })
        const stageOut = (stageRun.stdout ?? '') + (stageRun.stderr ?? '')
        stageOk = stageRun.status === c.stageExit && stageOut.includes(c.stageMarker)
        stageText = '；stage exit=' + stageRun.status + ' 期望 ' + c.stageExit
        if (!stageOk) stageText += '（stage 输出: ' + stageOut.trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 200) + '）'
      } else {
        stageText = stageNote
      }
      const ok = tarOk && stageOk
      if (!ok) bad += 1
      console.log((ok ? 'SELFTEST PASS  ' : 'SELFTEST FAIL  ') + c.name
        + '（tar exit=' + tarRun.status + ' 期望 ' + c.tarExit
        + '，命中 ' + JSON.stringify(c.tarMarker) + stageText + '）')
      if (!tarOk) {
        console.log('      tar 输出: ' + tarOut.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 400))
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log(bad === 0
    ? 'CHECK-SNAPSHOT-NODE-SHIMS SELF-TEST PASSED（正样本 1 + 受控负控 4；每例 tar 面与 stage 面各判一次）'
    : 'CHECK-SNAPSHOT-NODE-SHIMS SELF-TEST FAILED（' + bad + ' 项）')
  process.exit(bad === 0 ? 0 : 1)
}

if (argv.includes('--self-test')) selfTest()

// ── 参数解析 ────────────────────────────────────────────────────────────────
let stageArg
let tarArg
{
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--require') { i += 1; continue }
    if (a === '--stage') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) usage('--stage 需要一个 <extractedUsrDir> 参数')
      if (stageArg !== undefined) usage('--stage 只能给一次')
      stageArg = v
      i += 2
      continue
    }
    if (a.startsWith('--')) usage('未知参数: ' + a)
    if (tarArg !== undefined) usage('位置参数只能给一个 <snapshot.tar.xz>：' + tarArg + ' / ' + a)
    tarArg = a
    i += 1
  }
}
if (stageArg !== undefined && tarArg !== undefined) usage('两种输入面只能给一个（<snapshot.tar.xz> 与 --stage 互斥）')

// SKIP 纪律：没有输入面时**不得冒充通过**。计数 + 汇总 + 判据行三件套，--require 档转失败。
if (stageArg === undefined && tarArg === undefined) {
  console.log('SKIP(#1)  无输入面（既未给 <snapshot.tar.xz> 也未给 --stage <extractedUsrDir>）：本次没有判据输入')
  if (REQUIRE) {
    console.error('CHECK-SNAPSHOT-NODE-SHIMS FAILED（--require 严格档不得以 SKIP 结案：本次零判据；SKIP=1）')
    process.exit(1)
  }
  console.log('CHECK-SNAPSHOT-NODE-SHIMS SKIPPED（SKIP=1；两条构建链与发布链必须传 <snapshot.tar.xz> 真检）')
  process.exit(0)
}

let face
if (stageArg !== undefined) {
  if (!existsSync(stageArg) || !statSync(stageArg).isDirectory()) {
    usage('--stage 目录不存在或不是目录: ' + stageArg)
  }
  face = stageFace(stageArg)
} else {
  if (!existsSync(tarArg)) usage('快照归档不存在: ' + tarArg)
  face = tarFace(tarArg)
}
try {
  const bad = audit(face)
  process.exitCode = bad > 0 ? 1 : 0
} finally {
  face.cleanup()
}
