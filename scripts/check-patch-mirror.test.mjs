import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// check-patch-mirror.mjs 的镜像判别自证。
//
// 2026-10-28 政策：构建 / 门禁 / 校验脚本以 dsh-mobile-apk 为准，协调仓副本差异属正常；
// 仍要逐字节守的是 scripts/patches/** 与插件 / 子仓镜像目录。本文件给出三组判据：
//   正控：scripts/ 脚本（含 check-patch-mirror.mjs 自身）差异 -> 必须 PASS；
//   负控：patch 漂移 -> 必须 FAIL；
//   负控：plugin 内容漂移 / 清单漂移 -> 必须 FAIL。
// 被删掉的旧断言（脚本差一个字节就判红）正是本次修掉的误报来源。
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(HERE)
const SCRIPT = join(HERE, 'check-patch-mirror.mjs')
const PATCHES = ['registry.json', 'apply-patches.mjs', 'README.md']
const SCRIPT_ENTRY = 'scripts/build-apk-013.ps1'
const SELF_ENTRY = 'scripts/check-patch-mirror.mjs'
const CONFIG_ENTRY = 'scripts/control-ops-pending.json'

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

/** 从脚本源码的 MIRROR_TOP 里挑第一个**实体目录**条目（插件 / 子仓目录）做清单比对用例。 */
function firstDirEntry() {
  const src = readFileSync(SCRIPT, 'utf8')
  const start = src.indexOf('const MIRROR_TOP = [')
  assert.ok(start >= 0, '找不到 MIRROR_TOP 定义')
  const entries = [...src.slice(start, src.indexOf(']', start)).matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1])
  const hit = entries.find((rel) => {
    const abs = join(REPO, rel)
    try {
      // lstat：协调仓的 dsh-host-web-compat 等是符号链接，复制对端会指向真实树，
      // 后续破坏性用例会误删真实文件，必须跳过。
      return lstatSync(abs).isDirectory()
    } catch {
      return false
    }
  })
  assert.ok(hit, 'MIRROR_TOP 里没有实体目录条目，本用例需要调整')
  return hit
}

/** 递归找目录里的第一个普通文件（不跟随符号链接）。 */
function firstFile(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = lstatSync(full)
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

/**
 * 对端缺席用例必须跑在**隔离布局**里：协调仓根下真实存在 dsh-mobile-apk，
 * 主脚本的候选链会把它当成对端，`--peer <不存在>` 就永远测不到「缺席」分支。
 * 这里复制一份脚本 + 最小 patches 面到没有 nested APK 的临时根再跑。
 */
function runWithoutPeer(args) {
  const base = mkdtempSync(join(tmpdir(), 'patch-isolated-'))
  const root = join(base, 'repo')
  mkdirSync(join(root, 'scripts', 'patches'), { recursive: true })
  cpSync(SCRIPT, join(root, 'scripts', 'check-patch-mirror.mjs'))
  for (const f of ['registry.json', 'apply-patches.mjs']) {
    cpSync(join(REPO, 'scripts', 'patches', f), join(root, 'scripts', 'patches', f))
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-patch-mirror.mjs'), ...args], { encoding: 'utf8' })
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? ''), base }
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
  for (const rel of [SCRIPT_ENTRY, SELF_ENTRY, CONFIG_ENTRY]) cpSync(join(REPO, rel), join(peer, rel))
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
  assert.match(out, /PASS {2}镜像目录清单一致: /)
  assert.match(out, /APK-CANONICAL /)
  assert.match(out, /CHECK-PATCH-MIRROR PASSED/)
  assert.doesNotMatch(out, /FAIL {2}/)
})

test('负控：共享控制协议配置漂移仍判红，不能当作脚本副本忽略', () => {
  const target = join(peer, CONFIG_ENTRY)
  const original = readFileSync(target)
  try {
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n ')]))
    const { status, out } = run(['--peer', peer])
    assert.equal(status, 1, out)
    assert.match(out, /FAIL {2}镜像一致: scripts\/control-ops-pending\.json/)
  } finally { writeFileSync(target, original) }
})

test('正控：scripts/ 构建脚本差异属正常，不判红也不要求同步', () => {
  const targets = [SCRIPT_ENTRY, SELF_ENTRY]
  const originals = new Map(targets.map((rel) => [rel, readFileSync(join(peer, rel))]))
  try {
    for (const rel of targets) {
      const target = join(peer, rel)
      chmodSync(target, 0o644)
      writeFileSync(target, Buffer.concat([originals.get(rel), Buffer.from('\n# canonical drift is allowed by policy\n')]))
    }
    const { status, out } = run(['--peer', peer])
    assert.equal(status, 0, out)
    assert.match(out, /APK-CANONICAL {2}\d+ 项 scripts\/ 脚本条目/)
    assert.doesNotMatch(out, /FAIL {2}镜像一致: scripts\/(build-apk-013\.ps1|check-patch-mirror\.mjs)/)
  } finally {
    for (const rel of targets) {
      chmodSync(join(peer, rel), 0o644)
      writeFileSync(join(peer, rel), originals.get(rel))
    }
  }
})

test('负控：patch 漂移必须判红（scripts/patches/** 仍逐字节镜像）', () => {
  const target = join(peer, 'scripts', 'patches', 'README.md')
  const original = readFileSync(target)
  try {
    writeFileSync(target, Buffer.concat([original, Buffer.from('\n# patch drift\n')]))
    const { status, out } = run(['--peer', peer])
    assert.equal(status, 1, out)
    assert.match(out, /FAIL {2}镜像一致: scripts\/patches\/README\.md/)
  } finally {
    writeFileSync(target, original)
  }
})

test('负控：plugin 内容漂移必须判红（插件镜像面仍是真判据）', () => {
  const victim = firstFile(join(peer, dirEntry))
  assert.ok(victim, '对端目录里没有文件')
  const original = readFileSync(victim)
  try {
    writeFileSync(victim, Buffer.concat([original, Buffer.from('\n// plugin drift\n')]))
    const { status, out } = run(['--peer', peer])
    assert.equal(status, 1, out)
    assert.match(out, /FAIL {2}镜像目录内容一致: /)
  } finally {
    writeFileSync(victim, original)
  }
})

test('负控：plugin 清单一侧少文件必须判红（清单比对不是只看根路径）', () => {
  const victim = firstFile(join(peer, dirEntry))
  assert.ok(victim, '对端目录里没有文件')
  const original = readFileSync(victim)
  try {
    unlinkSync(victim)
    const { status, out } = run(['--peer', peer])
    assert.equal(status, 1, out)
    assert.match(out, /FAIL {2}镜像目录清单一致: /)
  } finally {
    chmodSync(dirname(victim), 0o755)
    writeFileSync(victim, original)
  }
})

test('--require-peer 下对端缺席必须判红，不得以 SKIP 结案', () => {
  const { status, out, base } = runWithoutPeer(['--peer', join(tmpdir(), 'patch-peer-absent-' + process.pid), '--require-peer'])
  try {
    assert.equal(status, 1, out)
    assert.match(out, /FAIL {2}--require-peer：对端树必须在场/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
test('不带 --require-peer 时对端缺席降级为具名 SKIP 且计数', () => {
  const { status, out, base } = runWithoutPeer(['--peer', join(tmpdir(), 'patch-peer-absent-skip-' + process.pid)])
  try {
    assert.equal(status, 0, out)
    assert.match(out, /SKIP\(#1\) {2}镜像层：对端树不在场/)
    assert.match(out, /CHECK-PATCH-MIRROR PASSED/)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
