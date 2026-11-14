#!/usr/bin/env node
// check-shebang-manifest.mjs — 构建期脚本清单「落点 + 内容」门禁（#1716 回归面）
//
// 为什么需要这条门禁：壳侧 SnapshotPrefixRewrite 只在
//   <files>/usr/.dsh-shebang-scripts.txt
// 这个**确切路径**存在时才走清单路径（只校验几百条脚本），否则回落到全树遍历
// （慢设备实测 527 秒）。上一版构建脚本把清单写到 stage 根、且命名为 shebang-scripts.txt：
//   · 归档只打 usr + home/.dsh + home/.gitconfig，stage 根的文件根本不进 tar；
//   · 名字也与壳侧读点不同。
// 于是清单永不命中，收益静默归零——而构建日志照样打印「清单已生成」，读日志看不出来。
// 这条门禁把判据放在**产物成员**上，构建链跑一次就能看出清单在不在对的位置。
//
// 判据：
//   M1 归档内存在 usr/.dsh-shebang-scripts.txt，且是普通文件（不是 symlink / 目录）；
//   M2 非空，每行都是 usr 内的相对路径（不以 / 开头、不含 .. 段、不以 usr/ 重复前缀开头）；
//   M3 抽样的列出的文件在归档内确实存在（防「清单内容与树不符」）；
//   M4 清单里至少有一条 bin/ 下的脚本（本快照必然有，值为 0 说明清单抓错了范围）。
//
// 用法：
//   node scripts/check-shebang-manifest.mjs <snapshot.tar.xz> [--require]
//   node scripts/check-shebang-manifest.mjs --stage <extractedUsrDir> [--require]
//   node scripts/check-shebang-manifest.mjs --self-test
// 退出码：0 = 通过；（--require 档）1 = 失败；2 = 用法错误 / 输入不可读。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const MANIFEST_REL = 'usr/.dsh-shebang-scripts.txt'
/** 清单里必须出现的目录前缀之一（fix-shebang.py 只扫这三个目录）。 */
const SCOPES = ['bin/', 'libexec/', 'lib/']

/** 从 tar.xz 里读出清单成员（返回 null 表示成员缺席）。 */
function manifestFromArchive(archive) {
  const py = [
    'import sys, tarfile',
    't = tarfile.open(sys.argv[1], "r")',
    'm = [x for x in t.getmembers() if x.name == sys.argv[2]]',
    'if not m:',
    '    print("MISSING")',
    'elif not m[0].isfile():',
    '    print("NOTFILE")',
    'else:',
    '    sys.stdout.write(t.extractfile(m[0]).read().decode("utf-8", "replace"))',
  ].join('\n')
  try {
    const out = execFileSync(PYTHON, ['-c', py, archive, MANIFEST_REL], {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out === 'MISSING' || out === 'NOTFILE') return { problem: out, text: null }
    return { problem: null, text: out }
  } catch (error) {
    return { problem: 'read-failed: ' + String(error.stderr ?? error.message ?? error).trim().slice(0, 200), text: null }
  }
}

/** 校验清单文本，返回失败项列表（空 = 通过）。 */
function judge(text, exists) {
  const failures = []
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  if (lines.length === 0) {
    failures.push('清单为空（壳侧 readScriptManifest 会当缺席处理，回落全树遍历）')
    return { failures, lines: 0 }
  }
  for (const rel of lines) {
    if (rel.startsWith('/')) { failures.push('清单含绝对路径: ' + rel); continue }
    if (rel.split('/').includes('..')) { failures.push('清单含 .. 段: ' + rel); continue }
    if (rel.startsWith('usr/')) { failures.push('清单路径应相对 usr，不得再带 usr/ 前缀: ' + rel); continue }
    if (!SCOPES.some((s) => rel.startsWith(s))) failures.push('清单路径不在 bin/libexec/lib 下: ' + rel)
  }
  if (failures.length) return { failures, lines: lines.length }
  const missing = lines.filter((rel) => !exists(rel))
  if (missing.length) failures.push('清单点名的文件在树内不存在（前 3 条）: ' + missing.slice(0, 3).join(', '))
  if (!lines.some((rel) => rel.startsWith('bin/'))) failures.push('清单没有任何 bin/ 脚本，抓取范围可疑')
  return { failures, lines: lines.length }
}

function archiveExistsProbe(archive) {
  const py = [
    'import sys, json, tarfile',
    't = tarfile.open(sys.argv[1], "r")',
    'names = {m.name for m in t}',
    'print(json.dumps(sorted(names)))',
  ].join('\n')
  const out = execFileSync(PYTHON, ['-c', py, archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const names = new Set(JSON.parse(out))
  return (rel) => names.has('usr/' + rel)
}

function runArchive(archive) {
  const read = manifestFromArchive(archive)
  if (read.text === null) return { failures: ['归档内不存在 ' + MANIFEST_REL + '（' + read.problem + '）'], lines: 0 }
  return judge(read.text, archiveExistsProbe(archive))
}

function runStage(usr) {
  if (!statSync(usr).isDirectory()) throw new Error('--stage 需要解压后的 usr 目录')
  const file = join(usr, basename(MANIFEST_REL))
  if (!existsSync(file)) return { failures: ['stage 内不存在 ' + MANIFEST_REL], lines: 0 }
  return judge(readFileSync(file, 'utf8'), (rel) => existsSync(join(usr, rel)))
}

if (process.argv.includes('--self-test')) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-shebang-manifest-'))
  const makeArchive = (tag, members) => {
    const archive = join(dir, tag + '.tar.xz')
    const spec = JSON.stringify(members)
    const py = [
      'import sys, json, io, tarfile',
      'with tarfile.open(sys.argv[1], "w:xz") as t:',
      '    for name, data in json.loads(sys.argv[2]):',
      '        info = tarfile.TarInfo(name)',
      '        payload = data.encode()',
      '        info.size = len(payload)',
      '        t.addfile(info, io.BytesIO(payload))',
    ].join('\n')
    execFileSync(PYTHON, ['-c', py, archive, spec])
    return archive
  }
  const run = (args) => spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8' })
  const good = makeArchive('good', [
    [MANIFEST_REL, 'bin/a\nlib/b\n'],
    ['usr/bin/a', '#!/system/bin/sh\n'],
    ['usr/lib/b', '#!/system/bin/sh\n'],
  ])
  // 旧缺陷形态：清单在 stage 根（归档里根本没有）且名字不同。
  const misplaced = makeArchive('misplaced', [
    ['usr/bin/a', '#!/system/bin/sh\n'],
    ['shebang-scripts.txt', 'bin/a\n'],
  ])
  const cases = [
    ['正控：清单在 usr/.dsh-shebang-scripts.txt 且路径存在 → 0', run([good, '--require']).status === 0],
    ['负控：清单写在 stage 根（旧缺陷）→ 1', run([misplaced, '--require']).status === 1],
    ['负控：清单点名不存在的文件 → 1', (() => {
      const bad = makeArchive('ghost', [[MANIFEST_REL, 'bin/a\nbin/ghost\n'], ['usr/bin/a', '#!/system/bin/sh\n'], ['usr/bin/zz', 'x']])
      return run([bad, '--require']).status === 1
    })()],
    ['负控：清单为空 → 1', (() => {
      const empty = makeArchive('empty', [[MANIFEST_REL, ''], ['usr/bin/a', 'x']])
      return run([empty, '--require']).status === 1
    })()],
    ['负控：清单含 usr/ 重复前缀 → 1', (() => {
      const dup = makeArchive('dup', [[MANIFEST_REL, 'usr/bin/a\n'], ['usr/bin/a', 'x']])
      return run([dup, '--require']).status === 1
    })()],
  ]
  let bad = 0
  for (const [name, ok] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name)
    if (!ok) bad += 1
  }
  rmSync(dir, { recursive: true, force: true })
  if (bad) {
    console.error('CHECK-SHEBANG-MANIFEST SELF-TEST FAILED（' + bad + ' 项）')
    process.exit(1)
  }
  console.log('CHECK-SHEBANG-MANIFEST SELF-TEST PASSED（5 项判别力断言：正控放行 / 旧缺陷落点 / 点名幽灵文件 / 空清单 / usr 前缀重复）')
  process.exit(0)
}

const stageIndex = process.argv.indexOf('--stage')
const input = stageIndex > 0 ? process.argv[stageIndex + 1] : process.argv[2]
if (!input || input.startsWith('--')) {
  console.error('用法: check-shebang-manifest.mjs <snapshot.tar.xz> | --stage <usrDir> | --self-test')
  process.exit(2)
}
let result
try {
  result = stageIndex > 0 ? runStage(input) : runArchive(input)
} catch (error) {
  console.error('CHECK-SHEBANG-MANIFEST ERROR: ' + String(error.message ?? error))
  process.exit(2)
}
for (const failure of result.failures) console.error('  - ' + failure)
if (result.failures.length) {
  console.error('CHECK-SHEBANG-MANIFEST FAILED（' + result.failures.length + ' 项）');
  process.exit(1)
}
console.log('CHECK-SHEBANG-MANIFEST PASSED（' + result.lines + ' 条脚本，落点 ' + MANIFEST_REL + '）')
