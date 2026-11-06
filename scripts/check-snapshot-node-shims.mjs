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
// 快照内的**可执行 shim** 全表（issue #1234）。
//
// 为什么从 2 条扩到 5 条：缺陷 1 修 #1243 时只覆盖了报障的 pnpm/npm，同一段构建代码里
// tar / git / usr/libexec/dsh-node 三个 wrapper 用的是同一套「构建期烧前缀」写法，一个没改。
// 判据若只盯 pnpm/npm，下次同类复发依旧全绿——门禁的覆盖面本身就是判据的一部分。
//
// exec 行逐条写死而不是从模板生成：这五条 exec 形态互不相同（node 直启 / node 经 linker64 /
// 自管真身二进制），把它们抽象成一个模板反而会让「某条写错了」表现为「模板对、实例错」，
// 而本门禁要判的正是**产物里的那一行**。
const SHIMS = [
  { rel: 'usr/bin/pnpm', target: 'usr/lib/node_modules/pnpm/bin/pnpm.cjs', exec: 'exec "$prefix/bin/node"' },
  { rel: 'usr/bin/npm', target: 'usr/lib/node_modules/npm/bin/npm-cli.js', exec: 'exec "$prefix/bin/node"' },
  // apk#87：git 编译期 --exec-path 写死 com.termux，wrapper 注入 GIT_EXEC_PATH 后 exec 真身。
  { rel: 'usr/bin/git', target: 'usr/bin/git.real', exec: 'exec "$prefix/bin/git.real"' },
  // PRD F1.1：GNU tar 压缩与执行拦截冲突，wrapper unset 遗留变量后 exec 真身。
  { rel: 'usr/bin/tar', target: 'usr/bin/tar.real', exec: 'exec "$prefix/bin/tar.real"' },
  // C1：app-data 的 ELF 在 untrusted_app 下不能直接 exec，交给系统 linker（exec 目标 = usr/bin/node）。
  { rel: 'usr/libexec/dsh-node', target: NODE_REL, exec: 'exec /system/bin/linker64 "$prefix/bin/node"' },
]
const SHEBANG = '#!/system/bin/sh'
// 自定位要素：前缀由 $0 反推。每条的 exec 行单独写在 SHIMS 里（见上）。
const SELF_LOCATE = 'prefix=$(cd "$(dirname "$self")/.." && pwd)'
// fix-shebang 面（N6）：本包名 —— 运行期重写器认的就是这个 pkg 的 usr 前缀。
const PKG = 'com.dsharnessmobile.shell'
// 运行期重写器（SnapshotPrefixRewrite.kt）能修的前缀形态；shebang 脚本里出现的 /data/ 必须落在这里。
const REWRITABLE_PREFIX_RE = new RegExp('^/data/(?:user/[0-9]+|data)/' + PKG.replace(/\./g, '\\.') + '/files/usr')
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
  // 去重：`usr/bin/node` 既是 NODE_REL，又是若干 shim 的 exec 目标，同一成员会被列两次。
  // GNU tar（Linux/CI）对**重复的成员参数**直接报 `Not found in archive` 并 exit 1，
  // 而 bsdtar（Windows 自带）会静默接受 —— 于是同一份判据在 Windows 绿、在 Linux 红。
  // 去重不改变「解压哪些成员」的语义，只是把重复项收成一个。
  const wanted = [...new Set([NODE_REL, ...SHIMS.map((s) => s.rel), ...SHIMS.map((s) => s.target)])]
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
    // N6：全树 shebang 扫描只在 tar 面提供（stage 面是「已解压的 usr 树」，用 readdir 也行，
    // 但 stage 面本来就是排障便利档，不给它加一条会拖慢几秒的全树遍历）。
    shebangPrefixHits: () => scanShebangPrefixes(archive),
  }
}

/**
 * 全树扫描 usr/{bin,libexec,lib} 下文本脚本的 shebang，抽出其中的 /data/ 前缀（N6 的输入）。
 *
 * 为什么走 Python 流式扫描而不是 `tar -xJf` 再 readdir：真机快照这三个目录有 3 万+ 小文件，
 * 解压耗时是流式读头的数倍（实测：解压三目录 >2 分钟，流式扫头 41 秒）。本仓已有「判据落在
 * 内嵌 Python 里」的先例（check-snapshot-file-modes.mjs）。**只读每个成员的头 256 字节**，
 * 不落盘、不修改归档。
 *
 * @returns {{rel: string, prefix: string}[]|null} null = 本机没有 python（由调用方计 SKIP，不得静默变绿）。
 */
const scanShebangPrefixes = (archive) => {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const probe = spawnSync(python, ['-c', 'print(1)'], { encoding: 'utf8' })
  if (probe.status !== 0) return null
  // 逐行拼 Python 源码（不走模板字符串）：这里面既有 b"#!" 又有 \\n 转义，用模板字符串会让
  // 反斜杠层数随外层变化——本轮实测就是在这里把正则拼成了非法字面量。逐行 + 单引号最稳。
  const py = [
    'import json, sys, tarfile',
    'archive = sys.argv[1]',
    'LIMIT = 4 * 1024 * 1024',
    'SHEBANG = b"#!"',
    'NEWLINE = b"\\n"',
    'out = []',
    'with tarfile.open(archive, "r|xz") as tf:',
    '    for m in tf:',
    '        if not m.isreg() or m.size > LIMIT:',
    '            continue',
    '        name = m.name',
    '        if not (name.startswith("usr/bin/") or name.startswith("usr/libexec/") or name.startswith("usr/lib/")):',
    '            continue',
    '        fh = tf.extractfile(m)',
    '        if fh is None:',
    '            continue',
    '        head = fh.read(256)',
    '        if not head.startswith(SHEBANG):',
    '            continue',
    '        line = head.split(NEWLINE, 1)[0].decode("utf-8", "replace")',
    '        for token in line.split():',
    '            if token.startswith("#!"):',
    '                token = token[2:]',
    '            if token.startswith("/data/"):',
    '                out.append({"rel": name, "prefix": token})',
    'print(json.dumps(out))',
  ].join('\n')
  const run = spawnSync(python, ['-c', py, archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (run.status !== 0) return null
  try { return JSON.parse(run.stdout) } catch { return null }
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
    // stage 面不提供全树 shebang 扫描（见 tarFace 里的同名字段注释）。
    shebangPrefixHits: () => null,
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

  // ── N2：每个 shim 必须是普通文件 ────────────────────────────────────────
  for (const shim of SHIMS) {
    const d = face.describe(shim.rel)
    expect('N2 ' + shim.rel + ' 在场', d.kind !== 'missing',
      '快照里没有 ' + shim.rel + '：' + (shim.absenceHint ?? (shim.rel.endsWith('npm')
        ? 'npm 通道缺席，pnpm 的 passThruToNpm 必 ENOENT'
        : 'shim 通道缺席（设备上该命令不可用）')))
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
      if (!content.includes(shim.exec)) misses.push('缺 exec 要素 ' + shim.exec)
      // 自定位要素必须**先于** exec 行：写在 exec 之后等于没写（exec 已把进程换掉）。
      if (content.includes(shim.exec) && content.indexOf(SELF_LOCATE) > content.indexOf(shim.exec)) {
        misses.push('自定位要素在 exec 行之后（exec 已换掉进程，前缀永远算不出来）')
      }
    }
    expect('N3 ' + shim.rel + ' 首行 ' + SHEBANG + ' + 自定位 + exec 要素', misses.length === 0, misses.join('；'))
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

  // ── N6：shebang 面的构建期前缀必须**可被运行期重写器修掉** ──────────────
  //
  // 背景（issue #1234 第 5 条）：shebang 是内核 execve 直接解析的绝对路径，没有 $0、没有 sh 语法，
  // 因此 fix-shebang.py 烧进 usr/bin|libexec|lib 文本脚本头里的构建期前缀**无法自定位**。处置是
  // 壳侧首次解压后的一次性重写（SnapshotPrefixRewrite.kt）。
  //
  // 判据不是「不许出现 /data/ 前缀」（那会把整类脚本判红，而它们必须存在），而是**每一处都得可修**：
  // 命中行里出现的 /data/ 前缀必须落在重写器认得的形态（/data/{user/<n>|data}/<本包>/files/usr）。
  // 出现第三种形态（例如别的包名、或构建机绝对路径）⇒ 运行期也修不掉 ⇒ 设备上必然 exec 失败。
  const shebangHits = face.shebangPrefixHits()
  if (shebangHits === null) {
    skip('N6 文本 shim 的 shebang 前缀可被运行期重写器修掉',
      '本输入面不提供全树扫描（stage 面只看固定成员），N6 只在 <snapshot.tar.xz> 面判')
  } else {
    const bad = shebangHits.filter((h) => !REWRITABLE_PREFIX_RE.test(h.prefix))
    expect('N6 文本 shim 的 shebang 前缀均可被运行期重写器修掉（命中 ' + shebangHits.length + ' 处）',
      bad.length === 0,
      bad.slice(0, 3).map((h) => h.rel + ' => ' + h.prefix).join('；')
        + '（这些形态运行期重写器认不出 ⇒ 设备上 exec 必然失败）')
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
  /**
   * 正样本 shim 文本：按 [SHIMS] 里每条**自己的** exec 形态生成。
   *
   * 为什么不复用构建脚本的模板：门禁要判的是**产物**。与构建脚本共用模板会让「模板对、产物错」
   * 无法暴露；这里逐条手写，等于第二份独立表述——两份对不上就是缺陷。
   */
  const goodShim = (rel) => {
    const head = [SHEBANG, '# dsh-mobile: 自定位 shim（前缀由 $0 推导，不烧构建期设备路径）', 'self=$0', SELF_LOCATE]
    const tail = (rel === 'usr/bin/git')
      ? ['export GIT_EXEC_PATH="$prefix/libexec/git-core"', 'exec "$prefix/bin/git.real" "$@"']
      : (rel === 'usr/bin/tar')
        ? ['unset -v TERMUX_APP__LEGACY_DATA_DIR', 'exec "$prefix/bin/tar.real" "$@"']
        : (rel === 'usr/libexec/dsh-node')
          ? ['export LD_LIBRARY_PATH="$prefix/lib"', 'exec /system/bin/linker64 "$prefix/bin/node" "$@"']
          : ['exec "$prefix/bin/node" "$prefix/' + SHIMS.find((s) => s.rel === rel).target.slice('usr/'.length) + '" "$@"']
    return head.concat(tail).concat(['']).join('\n')
  }
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
  /**
   * 造一棵合成 usr 树。`overrides` 里的文本按 rel 覆盖（负控用它把某一条打回旧形态）。
   *
   * 正样本默认全部合规：五条 shim 各自自定位 + 各自的 exec 目标在场 + 一个合规 shebang 脚本。
   */
  const writeTree = (root, overrides = {}) => {
    const files = {
      'usr/bin/node': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      'usr/lib/node_modules/pnpm/bin/pnpm.cjs': '#!/usr/bin/env node\nconsole.log(1)\n',
      'usr/lib/node_modules/npm/bin/npm-cli.js': '#!/usr/bin/env node\nconsole.log(1)\n',
      // exec 目标（真身二进制用 ELF 头，类型判据只要求「在场且普通文件」）。
      'usr/bin/git.real': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      'usr/bin/tar.real': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      // N6 的正样本：一个 shebang 里带**可被运行期重写器修掉**的构建期前缀的脚本。
      'usr/bin/legacy-script': '#!/data/user/0/' + PKG + '/files/usr/bin/bash\necho ok\n',
    }
    for (const shim of SHIMS) files[shim.rel] = goodShim(shim.rel)
    Object.assign(files, overrides)
    for (const [rel, data] of Object.entries(files)) {
      if (data === null) continue
      const p = join(root, ...rel.split('/'))
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, data)
    }
  }
  /**
   * 归档成员模式表。正样本全 0755；负控按 tag 改某几条的 mode 或类型。
   *
   * @param opts.noExecFor 该 rel 的成员头降成 0644（负控：无执行位）。
   * @param opts.missing 该 rel 不出现在归档里（负控：缺席）。
   * @param opts.symlinkFor 该 rel 以符号链接形态出现（负控：不是普通文件）。
   * @param opts.symlinkTarget symlinkFor 的链接目标。
   */
  const specOf = (opts = {}) => {
    const { noExecFor = null, missing = null, symlinkFor = null, symlinkTarget = null } = opts
    const dirs = [
      'usr', 'usr/bin', 'usr/lib', 'usr/libexec',
      'usr/lib/node_modules', 'usr/lib/node_modules/pnpm', 'usr/lib/node_modules/pnpm/bin',
      'usr/lib/node_modules/npm', 'usr/lib/node_modules/npm/bin',
    ]
    const files = [
      ['usr/bin/node', 0o755],
      ['usr/lib/node_modules/pnpm/bin/pnpm.cjs', 0o644],
      ['usr/lib/node_modules/npm/bin/npm-cli.js', 0o644],
      ['usr/bin/git.real', 0o755],
      ['usr/bin/tar.real', 0o755],
      ['usr/bin/legacy-script', 0o755],
      ...SHIMS.map((s) => [s.rel, 0o755]),
    ]
    const spec = dirs.map((name) => ({ name, kind: 'dir', mode: 0o755 }))
    for (const [name, mode] of files) {
      if (name === missing) continue
      if (name === symlinkFor) {
        spec.push({ name, kind: 'symlink', mode: 0o777, target: symlinkTarget })
        continue
      }
      spec.push({ name, kind: 'file', mode: name === noExecFor ? 0o644 : mode })
    }
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

  const bakedGit = [
    SHEBANG,
    '# dsh-mobile 0.13.0: git exec-path 重定位（issue apk#87）',
    'export GIT_EXEC_PATH="/data/user/0/' + PKG + '/files/usr/libexec/git-core"',
    'exec "/data/user/0/' + PKG + '/files/usr/bin/git.real" "$@"',
    '',
  ].join('\n')
  const bakedPtc = [
    SHEBANG,
    '# dsh-mobile: PTC node launcher (C1)',
    'export LD_LIBRARY_PATH="/data/user/0/' + PKG + '/files/usr/lib"',
    'exec /system/bin/linker64 "/data/user/0/' + PKG + '/files/usr/bin/node" "$@"',
    '',
  ].join('\n')
  // 自定位行**写在 exec 之后**（写法看着有、实际永远算不出来）：N3 的顺序判据必须抓到。
  const lateSelfLocate = [
    SHEBANG,
    '# dsh-mobile: 自定位要素被放到 exec 之后',
    'exec "$prefix/bin/git.real" "$@"',
    'self=$0',
    SELF_LOCATE,
    '',
  ].join('\n')
  const cases = [
    {
      tag: 'ok', name: '正样本：五条 shim 各自自定位 + 普通文件 + 可执行位',
      tree: {}, spec: specOf(),
      tarExit: 0, tarMarker: 'CHECK-SNAPSHOT-NODE-SHIMS PASSED',
      stageExit: 0, stageMarker: 'CHECK-SNAPSHOT-NODE-SHIMS PASSED',
    },
    {
      tag: 'hardcoded', name: '负控1：pnpm shim 仍烧写 /data/user/0/... 构建期前缀（缺陷 1 原形）',
      tree: { 'usr/bin/pnpm': oldShim('usr/lib/node_modules/pnpm/bin/pnpm.cjs') }, spec: specOf(),
      tarExit: 1, tarMarker: '/data/user/',
      stageExit: 1, stageMarker: '/data/user/',
    },
    {
      tag: 'no-npm', name: '负控2：缺 usr/bin/npm（普通文件缺席）',
      tree: { 'usr/bin/npm': null }, spec: specOf({ missing: 'usr/bin/npm' }),
      tarExit: 1, tarMarker: 'N2 usr/bin/npm',
      stageExit: 1, stageMarker: 'N2 usr/bin/npm',
    },
    {
      tag: 'npm-symlink', name: '负控3：usr/bin/npm 仍是 symlink（缺陷 2 原形）',
      tree: { 'usr/bin/npm': null }, spec: specOf({ symlinkFor: 'usr/bin/npm', symlinkTarget: '../lib/node_modules/npm/bin/npm-cli.js' }),
      tarExit: 1, tarMarker: '符号链接',
      // stage 面需要宿主真的能建符号链接（Windows 非开发者模式会 EPERM）——建不出来就只验 tar 面。
      stageExit: 1, stageMarker: '符号链接', stageSymlink: 'usr/bin/npm',
    },
    {
      tag: 'no-exec', name: '负控4：shim 无执行位（tar 模式 0644）',
      tree: {}, spec: specOf({ noExecFor: 'usr/bin/pnpm' }),
      tarExit: 1, tarMarker: '执行位',
      // stage 面没有 POSIX 模式：这一例按设计**判绿**，且必须显式打印 SKIP 计数（不得静默）。
      stageExit: 0, stageMarker: 'SKIP(#1)',
    },
    {
      tag: 'baked-git', name: '负控5：git wrapper 仍烧构建期前缀（issue #1234 的原形，此前无判据）',
      tree: { 'usr/bin/git': bakedGit }, spec: specOf(),
      tarExit: 1, tarMarker: '/data/user/',
      stageExit: 1, stageMarker: '/data/user/',
    },
    {
      tag: 'baked-ptc', name: '负控6：PTC dsh-node wrapper 仍烧构建期前缀（issue #1234 的原形）',
      tree: { 'usr/libexec/dsh-node': bakedPtc }, spec: specOf(),
      tarExit: 1, tarMarker: '/data/user/',
      stageExit: 1, stageMarker: '/data/user/',
    },
    {
      tag: 'late-self-locate', name: '负控7：自定位行写在 exec 之后（看着有、实际算不出来）',
      tree: { 'usr/bin/git': lateSelfLocate }, spec: specOf(),
      tarExit: 1, tarMarker: 'exec 行之后',
      stageExit: 1, stageMarker: 'exec 行之后',
    },
    {
      tag: 'unrewritable-shebang', name: '负控8：shebang 里出现运行期重写器认不出的前缀（N6 原形）',
      tree: { 'usr/bin/legacy-script': '#!/data/user/0/com.example.other/files/usr/bin/bash\necho ok\n' }, spec: specOf(),
      tarExit: 1, tarMarker: 'N6',
      // stage 面不提供全树 shebang 扫描（N6 计 SKIP）：这一例按设计判绿，但必须显式打印 SKIP。
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
        const linkRel = c.stageSymlink
        const linkPath = join(root, ...linkRel.split('/'))
        try {
          rmSync(linkPath, { force: true })
          symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', linkPath, 'file')
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
    ? 'CHECK-SNAPSHOT-NODE-SHIMS SELF-TEST PASSED（正样本 1 + 受控负控 8；每例 tar 面与 stage 面各判一次）'
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
