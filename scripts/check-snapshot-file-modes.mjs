// check-snapshot-file-modes.mjs — validates final snapshot permissions against Android extraction policy.
// Usage: node scripts/check-snapshot-file-modes.mjs <snapshot.tar.xz>
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { TAR } from './lib/shell.mjs'

// ── --self-test：判别力自证（2026-10-29 补；此前这条门禁零判别力面）──────────────────
//
// 判据在内嵌的 Python 里，造真实 tar.xz 才跑得起来。这里现场做两个**极小**归档：
// 一个合规（文件 600 / 目录 700）、一个不合规（文件 644），再加一条「归档不存在」——
// 三条一起证明这条门禁该红时真红、该绿时真绿，而不是只看它对真快照说 PASS。
if (process.argv.includes('--self-test')) {
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { fileURLToPath } = await import('node:url')

  const self = fileURLToPath(import.meta.url)
  const runGate = (archive) => {
    try {
      const out = execFileSync(process.execPath, [self, archive], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      return { code: 0, out }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
    }
  }
  /**
   * 归档全部用 Python 的 `tarfile` 造成员级（而不是 `chmod` 目录再 `tar` 打包），理由是本机的实测事实：
   * **Windows 上 chmod 不能复现 POSIX 位** —— `chmodSync(0o700)` 落成 0777、`0o600` 落成 0666，
   * 于是「合规归档」那条用例在 Windows 上必然假红（本轮实测：基线 `--self-test` 在 Windows 上
   * 就是 1 项 FAIL）。`TarInfo.mode` 是归档头里的字段，与宿主文件系统无关，跨平台一致。
   * @param members 形如 [['usr','dir','0700'], ['usr/run','elf','4700']]（kind: dir|elf|data，mode 八进制串）。
   */
  const buildArchive = (tag, members) => {
    const archive = join(tmpdir(), 'snapmode-' + tag + '-' + process.pid + '.tar.xz')
    const py = [
      'import sys, tarfile, io',
      'path = sys.argv[1]',
      'spec = sys.argv[2]',
      'with tarfile.open(path, "w:xz") as t:',
      '    for item in spec.split(","):',
      '        if item == "": continue',
      '        name, kind, mode = item.split("|")',
      '        info = tarfile.TarInfo(name)',
      '        info.mode = int(mode, 8)',
      '        if kind == "dir":',
      '            info.type = tarfile.DIRTYPE',
      '            t.addfile(info)',
      '        else:',
      `            data = bytes([0x7f]) + b"ELF" if kind == "elf" else b"data"`,
      '            info.size = len(data)',
      '            t.addfile(info, io.BytesIO(data))',
    ].join('\n')
    const spec = members.map((m) => m.join('|')).join(',')
    execFileSync('python', ['-c', py, archive, spec])
    return archive
  }
  const COMPLIANT = [['usr', 'dir', '0700'], ['usr/a.txt', 'data', '0600']]

  const okArchive = buildArchive('ok', COMPLIANT)
  const badArchive = buildArchive('bad', [['usr', 'dir', '0700'], ['usr/a.txt', 'data', '0644']])
  const missing = join(tmpdir(), 'snapmode-missing-' + process.pid + '.tar.xz')
  // #1071 A：零成员归档 ——「每个成员都对」对空集恒真。
  const emptyArchive = buildArchive('empty', [])
  // #1071 B：setuid 二进制 4700 —— 原 `& 0o777` 把它读成 0700 报「模式正确」。
  const setuidArchive = buildArchive('setuid', [['usr', 'dir', '0700'], ['usr/run', 'elf', '4700']])
  // 放行例：同样的 ELF 但 0700 且无高位 —— 必须仍然 PASS（证明新判据不是一律拒）。
  const cleanElfArchive = buildArchive('cleanelf', [['usr', 'dir', '0700'], ['usr/run', 'elf', '0700']])
  const r1 = runGate(okArchive)
  const r2 = runGate(badArchive)
  const r3 = runGate(missing)
  const r4 = runGate(emptyArchive)
  const r5 = runGate(setuidArchive)
  const r6 = runGate(cleanElfArchive)
  const cases = [
    ['合规归档（文件 600 / 目录 700）→ PASSED 且 exit 0', r1.code === 0 && r1.out.includes('SNAPSHOT_MODE_CHECK_PASSED')],
    ['不合规归档（文件 644）→ FAILED 且 exit 1', r2.code === 1 && r2.out.includes('SNAPSHOT_MODE_CHECK_FAILED')],
    ['归档不存在 → 用法错 exit 2', r3.code === 2],
    ['#1071 空归档（0 成员）→ FAILED 且 exit 1（对空集恒真不算通过）',
      r4.code === 1 && r4.out.includes('归档为空')],
    ['#1071 setuid 二进制（4700）→ FAILED 且 exit 1（高位不再被 0o777 掩掉）',
      r5.code === 1 && r5.out.includes('高位权限位')],
    ['#1071 放行例：同样的 ELF 但 0700 无高位 → PASSED 且 exit 0',
      r6.code === 0 && r6.out.includes('SNAPSHOT_MODE_CHECK_PASSED')],
  ]
  let bad = 0
  for (const [label, ok] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
    if (!ok) bad += 1
  }
  for (const a of [okArchive, badArchive, emptyArchive, setuidArchive, cleanElfArchive]) rmSync(a, { force: true })
  console.log(bad === 0
    ? 'SNAPSHOT_MODE_SELF_TEST_PASSED（' + cases.length + ' 项）'
    : 'SNAPSHOT_MODE_SELF_TEST_FAILED（' + bad + ' 项）')
  process.exit(bad === 0 ? 0 : 1)
}

const snapshot = process.argv[2]
if (!snapshot) {
  console.error('usage: node check-snapshot-file-modes.mjs <snapshot.tar.xz>')
  process.exit(2)
}
const path = resolve(snapshot)
if (!existsSync(path)) {
  console.error('snapshot not found: ' + path)
  process.exit(2)
}

/**
 * 内嵌检查器（Python + tarfile）。
 *
 * 两条判据在这里被补上（#1071）：
 *   A **非空下限**：原实现只打印计数、从不断言非零。「每个成员的模式都对」对**空集恒真**——
 *     一个 0 成员的归档（或解压链路某段静默产出空包）直接报 PASSED。解压出来什么都没有，
 *     而门禁说的是「模式全部正确」。脚本自己的名字与用途（「最终快照权限对 Android 解压策略」）
 *     就预设了「这是快照」；零成员的东西不是快照。下限取 1（不是某个具体数字）：这条判据回答的是
 *     「检查过东西了吗」，具体应有的规模由 snapshot 链自己的清单守，在这里钉死数字只会多一处漂移源。
 *   B **高位权限位**：原实现 `mode = member.mode & 0o777` 把 setuid/setgid/sticky 全抹掉，
 *     于是 `chmod 4700` 的 setuid-root 二进制被判成 0700「模式正确」。安装到设备上的 setuid 位
 *     是真实攻击面（快照解压后由应用进程持有），必须原样报出来。改为同时看 0o7000 段：
 *     任何成员带 setuid/setgid/sticky ⇒ 判红（Android 应用内的快照不需要这三个位）。
 * 报错文案分开：模式不对（含高位）与「归档里什么都没有」是两类事故，混在一句里会让读的人改错地方。
 */
const checker = String.raw`
import sys, tarfile
path = sys.argv[1]
invalid = []
high = []
counts = {'files': 0, 'dirs': 0, 'symlinks': 0, 'exec': 0, 'data': 0, 'other': 0}
with tarfile.open(path, 'r:xz') as archive:
    for member in archive:
        if not (member.isfile() or member.isdir() or member.issym()):
            counts['other'] += 1
        mode = member.mode & 0o777
        special = member.mode & 0o7000
        if special:
            high.append((member.name, oct(member.mode), oct(special)))
        if member.isfile():
            counts['files'] += 1
            handle = archive.extractfile(member)
            prefix = handle.read(4) if handle else b''
            if handle:
                handle.close()
            executable = prefix.startswith(b'\x7fELF') or prefix.startswith(b'#!')
            expected = 0o700 if executable else 0o600
            counts['exec' if executable else 'data'] += 1
            if mode != expected:
                invalid.append((member.name, oct(mode), oct(expected)))
        elif member.isdir():
            counts['dirs'] += 1
            if mode != 0o700:
                invalid.append((member.name, oct(mode), oct(0o700)))
        elif member.issym():
            counts['symlinks'] += 1
members = counts['files'] + counts['dirs'] + counts['symlinks'] + counts['other']
failed = False
if invalid:
    failed = True
    print('SNAPSHOT_MODE_CHECK_FAILED entries=' + str(len(invalid)))
    for name, actual, expected in invalid[:20]:
        print(name + ': mode=' + actual + ' expected=' + expected)
if high:
    failed = True
    print('SNAPSHOT_MODE_CHECK_FAILED 高位权限位 members=' + str(len(high)))
    for name, actual, special in high[:20]:
        print(name + ': mode=' + actual + ' 含 setuid/setgid/sticky=' + special + '（快照里不得出现）')
if members == 0:
    failed = True
    print('SNAPSHOT_MODE_CHECK_FAILED 归档为空：0 个成员')
    print('  「每个成员的模式都对」对空集恒真——零成员的归档不是快照，检查器什么都没检查就报了通过。')
if failed:
    sys.exit(1)
print('SNAPSHOT_MODE_CHECK_PASSED files={files} dirs={dirs} symlinks={symlinks} exec={exec} data={data} members='.format(**counts) + str(members))
`

try {
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', checker, path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  process.stdout.write(output)
} catch (error) {
  if (error.stdout) process.stdout.write(String(error.stdout))
  if (error.stderr) process.stderr.write(String(error.stderr))
  process.exit(error.status ?? 1)
}