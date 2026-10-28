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
  const buildArchive = (tag, fileMode) => {
    const dir = mkdtempSync(join(tmpdir(), 'snapmode-src-'))
    mkdirSync(join(dir, 'usr'), { recursive: true })
    chmodSync(join(dir, 'usr'), 0o700)
    const file = join(dir, 'usr', 'a.txt')
    writeFileSync(file, 'data')
    chmodSync(file, fileMode)
    const archive = join(tmpdir(), 'snapmode-' + tag + '-' + process.pid + '.tar.xz')
    execFileSync(TAR, ['-cJf', archive, '-C', dir, './usr'])
    rmSync(dir, { recursive: true, force: true })
    return archive
  }

  const okArchive = buildArchive('ok', 0o600)
  const badArchive = buildArchive('bad', 0o644)
  const missing = join(tmpdir(), 'snapmode-missing-' + process.pid + '.tar.xz')
  const r1 = runGate(okArchive)
  const r2 = runGate(badArchive)
  const r3 = runGate(missing)
  const cases = [
    ['合规归档（文件 600 / 目录 700）→ PASSED 且 exit 0', r1.code === 0 && r1.out.includes('SNAPSHOT_MODE_CHECK_PASSED')],
    ['不合规归档（文件 644）→ FAILED 且 exit 1', r2.code === 1 && r2.out.includes('SNAPSHOT_MODE_CHECK_FAILED')],
    ['归档不存在 → 用法错 exit 2', r3.code === 2],
  ]
  let bad = 0
  for (const [label, ok] of cases) {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label)
    if (!ok) bad += 1
  }
  rmSync(okArchive, { force: true })
  rmSync(badArchive, { force: true })
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

const checker = String.raw`
import sys, tarfile
path = sys.argv[1]
invalid = []
counts = {'files': 0, 'dirs': 0, 'symlinks': 0, 'exec': 0, 'data': 0}
with tarfile.open(path, 'r:xz') as archive:
    for member in archive:
        mode = member.mode & 0o777
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
if invalid:
    print('SNAPSHOT_MODE_CHECK_FAILED entries=' + str(len(invalid)))
    for name, actual, expected in invalid[:20]:
        print(name + ': mode=' + actual + ' expected=' + expected)
    sys.exit(1)
print('SNAPSHOT_MODE_CHECK_PASSED files={files} dirs={dirs} symlinks={symlinks} exec={exec} data={data}'.format(**counts))
`

try {
  const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', checker, path], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  process.stdout.write(output)
} catch (error) {
  if (error.stdout) process.stdout.write(String(error.stdout))
  if (error.stderr) process.stderr.write(String(error.stderr))
  process.exit(error.status ?? 1)
}
