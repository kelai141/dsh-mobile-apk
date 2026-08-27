// check-third-party.mjs — 第三方许可合规门禁（GPL 义务 A1-A5/B1-B3 的自动化面）
//
// 职责（对 .deploy-tmp/snapshot-013/<abi>/stage/root/usr 的快照运行时树）：
// ① 矩阵完整：dpkg status 每个已装包都在 scripts/third-party-licenses.json 有记录；
// ② copyleft（GPL/LGPL 族）包的 usr/share/doc/<pkg>/copyright 在快照内存在（A1：GPL 全文随包分发）；
// ③ LICENSES/ 标准文本覆盖矩阵所需族（A2 源）；
// ④ --write-notices <out>：生成 THIRD_PARTY_NOTICES.md（组件/版本/许可/上游，B1）。
// 退出 0=通过；非 0=拒绝打包（build-apk-013.ps1 门禁接入）。
//
// 用法：node scripts/check-third-party.mjs <usrDir> [--write-notices <path>] [--licenses <dir>]
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { wslPath, sh } from './lib/shell.mjs'

const usr = process.argv[2]
const licensesDir = process.argv.includes('--licenses') ? process.argv[process.argv.indexOf('--licenses') + 1] : 'LICENSES'
const writeIdx = process.argv.indexOf('--write-notices')
const noticesPath = writeIdx >= 0 ? process.argv[writeIdx + 1] : null
const tarIdx = process.argv.indexOf('--tar')
const tarPath = tarIdx >= 0 ? process.argv[tarIdx + 1] : null
if ((!usr && !tarPath) || (!existsSync(join(usr, 'var/lib/dpkg/status')) && !tarPath)) {
  console.error('用法: node scripts/check-third-party.mjs <usrDir|--tar <snapshot.tar.xz>> [--write-notices <path>]')
  process.exit(2)
}

const matrix = JSON.parse(readFileSync('scripts/third-party-licenses.json', 'utf8'))

/** 目标存在性视图：Windows 直接 stat 对 9p 上的 root-600 文件会 EACCES 误报，
 *  因此支持 --tar 经 WSL/原生 shell 列归档（tar -tvf 带大小），成员存在且 size>0 才算在场。 */
function availability() {
  const map = new Map()
  if (tarPath) {
    const abs = wslPath(resolve(tarPath))
    const out = sh(`tar -tvf "${abs}" 2>/dev/null | grep -E 'usr/share/LICENSES/|usr/share/doc/[^/]+/copyright'`, { maxBuffer: 96 * 1024 * 1024 })
    for (const line of out.split('\n')) {
      if (!line.includes('usr/share/LICENSES/') && !/usr\/share\/doc\/[^/]+\/copyright/.test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pathIdx = parts.findIndex((t) => t.startsWith('usr/share/'))
      if (pathIdx < 0) continue
      const path = parts[pathIdx]
      const size = Number(parts[pathIdx - 3] ?? 0)
      const linkIdx = line.indexOf(' -> ')
      if (linkIdx >= 0) {
        map.set(path, { size, target: line.slice(linkIdx + 4).trim() })
      } else {
        map.set(path, size)
      }
    }
  } else {
    for (const pkg of packagesAvailable()) {
      const rel = `usr/share/doc/${pkg}/copyright`
      try {
        const st = statSync(join(usr, rel))
        map.set(rel, st.size)
      } catch { /* absent */ }
    }
  }
  return map
}

/** 直读模式（无 --tar）：从 dpkg status 取包列表；tar 模式同。 */
function packagesAvailable() {
  const text = readFileSync(join(usr, 'var/lib/dpkg/status'), 'utf8')
  const out = []
  for (const b of text.split('\n\n')) {
    const pkg = /^Package: (.+)$/m.exec(b)?.[1]
    if (pkg) out.push(pkg)
  }
  return out
}

/** dpkg status → [{pkg, version}]（--tar 模式经 WSL 从归档内抽取；直读模式读本地 usr）。 */
function readPackages() {
  let text
  if (tarPath) {
    const abs = wslPath(resolve(tarPath))
    text = sh(`tar -xOf "${abs}" usr/var/lib/dpkg/status`, { maxBuffer: 32 * 1024 * 1024 })
  } else {
    text = readFileSync(join(usr, 'var/lib/dpkg/status'), 'utf8')
  }
  const blocks = text.split('\n\n')
  const out = []
  for (const b of blocks) {
    const pkg = /^Package: (.+)$/m.exec(b)?.[1]
    const version = /^Version: (.+)$/m.exec(b)?.[1]
    if (pkg) out.push({ pkg, version: version ?? '?' })
  }
  return out
}

const packages = readPackages()
const failures = []
const copyleft = []
const rows = []
const avail = availability()

for (const { pkg, version } of packages) {
  const license = matrix.packages[pkg]
  if (!license) {
    failures.push(`矩阵缺条目: ${pkg}@${version}（加入 scripts/third-party-licenses.json）`)
    rows.push({ pkg, version, license: '???', copyleft: false })
    continue
  }
  const isCopyleft = matrix.copyleftFamilies.some((f) => license.includes(f))
  if (isCopyleft) copyleft.push(pkg)
  rows.push({ pkg, version, license, copyleft: isCopyleft })
  // A1：copyleft 包许可证全文必须在场。Termux 布局不一致——三种形态任一即可：
  //  a) doc/<pkg>/copyright 软链 → usr/share/LICENSES/<fam>.txt（size>0）
  //  b) doc/<pkg>/COPYING* 实体文件（liblzma/util-linux 等）
  //  c) usr/share/LICENSES/<fam>.txt 标准文本在场（兜底：共享许可证库）
  const famMap = {
    'GPL-1.0+': 'GPL-2.0.txt', 'GPL-2.0': 'GPL-2.0.txt', 'GPL-2.0+': 'GPL-2.0.txt',
    'GPL-3.0+': 'GPL-3.0.txt', 'LGPL-2.1+': 'LGPL-2.1.txt', 'LGPL-3.0+': 'LGPL-3.0.txt',
  }
  const famFile = Object.entries(famMap).find(([f]) => license.includes(f))?.[1] ?? null
  const rel = `usr/share/doc/${pkg}/copyright`
  const entry = avail.get(rel)
  let okSize = typeof entry === 'number' ? entry > 0 : false
  let diag = ''
  if (!okSize && typeof entry === 'object' && entry) {
    // symlink 目标相对「自身所在目录」解析（doc/<pkg>/ + ../../ = share/）——不是相对 doc/
    const target = join(dirname(rel), entry.target).replace(/\\/g, '/')
    const t = avail.get(target)
    okSize = typeof t === 'number' ? t > 0 : false
    diag = `(link -> ${target} size=${typeof t === 'number' ? t : 'missing'})`
  }
  // b) COPYING* 实体文件
  if (!okSize) {
    for (const k of [...avail.keys()]) {
      if (k.startsWith(`usr/share/doc/${pkg}/COPYING`) && typeof avail.get(k) === 'number' && (avail.get(k) ?? 0) > 0) {
        okSize = true
        diag = `(COPYING*)`
        break
      }
    }
  }
  // c) 共享标准文本
  if (!okSize && famFile) {
    const t = avail.get(`usr/share/LICENSES/${famFile}`)
    okSize = typeof t === 'number' ? t > 0 : false
    if (okSize) diag = `(shared LICENSES/${famFile})`
  }
  if (isCopyleft && !okSize) {
    failures.push(`copyleft 包缺 copyright 全文: ${rel} ${diag}`)
  }
}

// A2：LICENSES 标准文本覆盖矩阵所需族
const neededTexts = new Set()
for (const { license } of rows) {
  for (const fam of ['GPL-2.0+', 'GPL-3.0+', 'LGPL-2.1+', 'LGPL-3.0+']) {
    if (license.includes(fam.split('+')[0])) neededTexts.add(matrix.licenseTexts[fam])
  }
}
for (const rel of neededTexts) {
  if (!existsSync(rel)) failures.push(`LICENSES 标准文本缺失: ${rel}`)
}

if (noticesPath) {
  const lines = [
    '# THIRD_PARTY_NOTICES',
    '',
    '> 本清单由 `scripts/check-third-party.mjs --write-notices` 从快照 dpkg 清单生成；',
    '> 与快照一起分发（APK assets/）。每个组件的许可证全文随快照包分发于 `usr/share/doc/<pkg>/copyright`，',
    '> 标准 GNU 文本副本另见仓库 `LICENSES/`。',
    '',
    '| 组件 | 版本 | 许可证 | 上游源码 |',
    '|---|---|---|---|',
  ]
  const src = 'https://github.com/termux/termux-packages/tree/master/packages'
  for (const { pkg, version, license } of rows.sort((a, b) => a.pkg.localeCompare(b.pkg))) {
    lines.push(`| ${pkg} | ${version} | ${license} | [termux-packages/${pkg}](${src}/${pkg}) |`)
  }
  lines.push('')
  lines.push('## 源码要约（GPL §3）')
  lines.push('')
  lines.push('上表各 copyleft 组件的对应源码及完整构建脚本，见 <https://github.com/termux/termux-packages>（按版本标签对应）。')
  lines.push('本发行快递包含对上述二进制的再加工：Termux 包的前缀/编译期路径重写（`scripts/fix-shebang.py`、`scripts/inject-snapshot.py`、')
  lines.push('`termux-elf-cleaner` 调用与 `build-snapshot-013.mjs` 中的 RUNPATH/shebang 处理）、快照归档与插件注入（`build-apk-013.ps1`）；')
  lines.push('改写说明与工具随本仓库发布（见 `docs/RELEASE.md` 合规声明）。')
  mkdirSync(join(noticesPath, '..'), { recursive: true })
  writeFileSync(noticesPath, lines.join('\n'))
  console.log(`notices written: ${noticesPath}（${rows.length} 组件，${copyleft.length} copyleft）`)
}

if (failures.length) {
  console.error(`THIRD-PARTY CHECK FAILED（${failures.length}）`)
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`third-party ok: ${packages.length} 组件（copyleft ${copyleft.length}: ${copyleft.join(', ')}）`)
