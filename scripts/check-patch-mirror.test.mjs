import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `check-patch-mirror.mjs`（499 行）守「双仓补丁镜像逐字节一致」，但此前**零测试面**：
// 把 `cmp()` 改成恒等、或把某条清单比对删掉，CI 不会有任何反应。
//
// 这里不改脚本本身（它把 ROOT 写死在十几处，为测试动主干的风险大于收益），而是拿**真实仓库当本侧**、
// 拿临时目录当对端：`--peer` 本来就接受任意目录（只要含 `scripts/patches/registry.json`）。
// 对端只造本用例要断言的那几块（patches 三件 + data/ + tests/ + 一个文件型镜像面 + 一个目录型镜像面），
// 其余 90 多条清单条目走脚本既有的「对端无此文件 ⇒ SKIP」路径 —— 跑得快，也不会因清单增删而假红。
// peer 只造一次（data + tests 约 12 MB），各用例在它上面破坏再恢复。
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const SCRIPT = join(HERE, 'check-patch-mirror.mjs')
const PATCHES = ['registry.json', 'apply-patches.mjs', 'README.md']
const FILE_ENTRY = 'scripts/build-apk-013.ps1'

/**
 * 把复制出来的树权限放开：仓库里的镜像面在磁盘上常是只读位，`cpSync` 会原样保留 ——
 * 之后 `unlinkSync` / `rmSync` 会 EACCES。复制完放开一次，删除前再放开一次。
 */
function relax(p) {
  let st
  try {
    st = lstatSync(p)
  } catch {
    return
  }
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    chmodSync(p, 0o755)
    for (const name of readdirSync(p)) relax(join(p, name))
  } else {
    chmodSync(p, 0o644)
  }
}

/** 从脚本源码的 MIRROR_TOP 里挑第一个目录型条目（插件 / 子仓目录）做清单比对用例。 */
function firstDirEntry() {
  const src = readFileSync(SCRIPT, 'utf8')
  const start = src.indexOf('const MIRROR_TOP = [')
  assert.ok(start >= 0, '找不到 MIRROR_TOP 定义')
  const entries = [...src.slice(start, src.indexOf(']', start)).matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1])
  const hit = entries.find((rel) => {
    const abs = join(REPO, rel)
    return existsSync(abs) && statSync(abs).isDirectory()
  })
  assert.ok(hit, 'MIRROR_TOP 里没有目录型条目，本用例需要调整')
  return hit
}

/** 递归找目录里的第一个普通文件。 */
function firstFile(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      const inner = firstFile(full)
      if (inner) return inner
    } else if (st.isFile()) {
      return full
    }
  }
  return null
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

let peer = null
let dirEntry = null

before(() => {
  dirEntry = firstDirEntry()
  peer = mkdtempSync(join(tmpdir(), 'patch-peer-'))
  mkdirSync(join(peer, 'scripts', 'patches'), { recursive: true })
  for (const f of PATCHES) cpSync(join(REPO, 'scripts', 'patches', f), join(peer, 'scripts', 'patches', f))
  for (const sub of ['data', 'tests']) {
    cpSync(join(REPO, 'scripts', 'patches', sub), join(peer, 'scripts', 'patches', sub), { recursive: true })
  }
  cpSync(join(REPO, FILE_ENTRY), join(peer, FILE_ENTRY))
  cpSync(join(REPO, dirEntry), join(peer, dirEntry), { recursive: true })
  relax(peer)
})

after(() => {
  if (peer === null) return
  relax(peer)
  rmSync(peer, { recursive: true, force: true })
})

test('与本侧逐字节一致的对端树通过（其余清单条目走 SKIP）', () => {
  const { status, out } = run(['--peer', peer])
  assert.equal(status, 0, out)
  assert.match(out, /PASS  镜像一致: scripts\/build-apk-013\.ps1/)
  assert.match(out, /PASS  镜像目录清单一致: /)
  assert.match(out, /CHECK-PATCH-MIRROR PASSED/)
})

test('对端某个镜像文件差一个字节就判红（cmp 不是恒等）', () => {
  const target = join(peer, FILE_ENTRY)
  const original = readFileSync(target)
  try {
    chmodSync(target, 0o644)
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n# drift\n')]))
    const { status, out } = run(['--peer', peer])
    assert.equal(status, 1, out)
    assert.match(out, /FAIL  镜像一致: scripts\/build-apk-013\.ps1/)
  } finally {
    chmodSync(target, 0o644)
    writeFileSync(target, original)
  }
})

test('对端目录型镜像面少一个文件就判红（清单比对不是只看根路径）', () => {
  const victim = firstFile(join(peer, dirEntry))
  assert.ok(victim, '对端目录里没有文件')
  const original = readFileSync(victim)
  try {
    unlinkSync(victim)
    const { status, out } = run(['--peer', peer])
    assert.equal(status, 1, out)
    assert.match(out, /FAIL  镜像目录清单一致: /)
  } finally {
    chmodSync(dirname(victim), 0o755)
    writeFileSync(victim, original)
  }
})

test('--require-peer 下对端缺席必须判红，不得以 SKIP 结案', () => {
  const missing = join(tmpdir(), 'patch-peer-absent-' + process.pid)
  assert.ok(!existsSync(missing))
  const { status, out } = run(['--peer', missing, '--require-peer'])
  assert.equal(status, 1, out)
  assert.match(out, /FAIL  --require-peer：对端树必须在场/)
})

test('不带 --require-peer 时对端缺席降级为具名 SKIP 且计数', () => {
  const missing = join(tmpdir(), 'patch-peer-absent-skip-' + process.pid)
  assert.ok(!existsSync(missing))
  const { status, out } = run(['--peer', missing])
  assert.equal(status, 0, out)
  assert.match(out, /SKIP\(#1\)  镜像层：对端树不在场/)
  assert.match(out, /CHECK-PATCH-MIRROR PASSED/)
})
