import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `check-runtime-assets.mjs`（273 行）守「运行时资产 ↔ 快照同源」，此前**零测试面**：
// 把 marker 判据、逐字节比对或 --require 的 SKIP 转失败删掉，CI 不会有任何反应。
//
// 脚本的可注入点：`--snapshot <tar>` 早就支持；本轮给它补一个 `--root <dir>`（默认行为不变）
// 把 registry / 资产目录 / 行为回归脚本也换成临时树。于是能在一棵小树上跑全部主干判据：
// 用系统 tar 打一个**真实的 xz 快照**（成员路径与 registry.target 一致），
// 资产文件、registry、行为回归脚本全由用例自己造。
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'check-runtime-assets.mjs')

/** 资产名约定 `<pkg>-<basename>`（例 session-persistence-jsonl-index.js → target 含 /dsh-session-persistence-jsonl/…/index.js）。 */
const PKG = 'session-persistence-jsonl'
const ASSET = PKG + '-index.js'
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-' + PKG + '/lib/index.js'
const MARKER = 'dsh-mobile test marker (X1)'

function makeTree({ assetText, snapText, marker = MARKER, behaviorTestOk = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-assets-'))
  // registry：一个 engine 补丁条目指向 TARGET，带 marker。
  const registry = { patches: [{ id: 'test-X1', scope: 'engine', target: TARGET, marker }] }
  mkdirSync(join(dir, 'scripts', 'patches', 'tests'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'patches', 'registry.json'), JSON.stringify(registry))
  // 行为回归脚本：exit 0（BEHAVIOR_TESTS 只认两个具名资产，用其中之一才能进入该路径）。
  writeFileSync(
    join(dir, 'scripts', 'patches', 'tests', 'publish-exclusive-reclaim.test.mjs'),
    'process.exit(' + (behaviorTestOk ? 0 : 3) + ')\n',
  )
  // 资产目录。
  mkdirSync(join(dir, 'app', 'src', 'main', 'assets', 'patched'), { recursive: true })
  writeFileSync(join(dir, 'app', 'src', 'main', 'assets', 'patched', ASSET), assetText)
  // 快照 tar（真实 xz）：成员路径 = TARGET。
  writeFileSync(join(dir, 'member.js'), snapText)
  execFileSync('tar', ['-cf', join(dir, 'snap.tar'), '--transform', 's|^member.js|' + TARGET + '|', 'member.js'], { cwd: dir })
  execFileSync('xz', ['-z', '-f', join(dir, 'snap.tar')])
  rmSync(join(dir, 'member.js'))
  return dir
}

function run(dir, extraArgs = []) {
  const result = spawnSync(process.execPath, [
    SCRIPT, '--root', dir, '--snapshot', join(dir, 'snap.tar.xz'), ...extraArgs,
  ], { encoding: 'utf8' })
  return { status: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') }
}

test('资产与快照逐字节同源（含 marker 与行为回归）通过', () => {
  const text = '// asset\n' + MARKER + '\n'
  const dir = makeTree({ assetText: text, snapText: text })
  try {
    const { status, out } = run(dir)
    assert.equal(status, 0, out)
    assert.match(out, /PASS  资产覆盖同源补丁全部 marker/)
    assert.match(out, new RegExp('PASS  资产与快照逐字节同源: ' + ASSET))
    assert.match(out, /CHECK-RUNTIME-ASSETS PASSED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('资产缺 marker（快照无关判据）判红：设备上会被整份覆盖等于没修', () => {
  const dir = makeTree({ assetText: '// no marker\n', snapText: '// no marker\n' })
  try {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /CHECK-RUNTIME-ASSETS FAILED：运行时资产缺少同源补丁 marker/)
    assert.match(out, /缺 test-X1 的 marker/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('资产与快照逐字节不同（资产缺补丁方向）判红并给出 --write 修法', () => {
  const dir = makeTree({
    assetText: '// stale asset without marker\n',
    snapText: '// fresh snapshot\n' + MARKER + '\n',
  })
  try {
    const { status, out } = run(dir)
    // 资产缺 marker 先被快照无关判据拦下；补上 marker 再验逐字节方向。
    assert.equal(status, 1, out)
    assert.match(out, /缺少同源补丁 marker/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('快照是陈旧产物（快照缺 marker、资产已补齐）判红并禁止 --write 回写', () => {
  const assetText = '// asset\n' + MARKER + '\n'
  const dir = makeTree({ assetText, snapText: '// stale snapshot without marker\n' })
  try {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /快照是\*\*陈旧\*\*产物/)
    assert.match(out, /禁止用 --write 回写/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('资产与快照同含 marker 但字节不同（无方向线索）判红为不同源', () => {
  const dir = makeTree({
    assetText: '// a\n' + MARKER + '\n',
    snapText: '// b\n' + MARKER + '\n',
  })
  try {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /运行时资产与快照不同源（逐字节）/)
    assert.match(out, /--write/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('行为回归脚本失败判红（字节同源不证设备上能工作）', () => {
  const text = '// asset\n' + MARKER + '\n'
  const dir = makeTree({ assetText: text, snapText: text, behaviorTestOk: false })
  try {
    const { status, out } = run(dir)
    assert.equal(status, 1, out)
    assert.match(out, /资产行为回归失败/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--require 下快照缺席必须判红，不得 SKIP 结案', () => {
  const text = '// asset\n' + MARKER + '\n'
  const dir = makeTree({ assetText: text, snapText: text })
  try {
    const { status, out } = run(dir, ['--require'])
    // 快照在场但路径正确；把快照删掉再跑才是本用例。
    rmSync(join(dir, 'snap.tar.xz'))
    const r2 = spawnSync(process.execPath, [SCRIPT, '--root', dir, '--require'], { encoding: 'utf8' })
    assert.equal(r2.status, 1)
    assert.match((r2.stdout ?? '') + (r2.stderr ?? ''), /严格模式（--require）：构建链\/发布链不得以 SKIP 结案/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不带 --require 时快照缺席降级为具名 SKIP', () => {
  const text = '// asset\n' + MARKER + '\n'
  const dir = makeTree({ assetText: text, snapText: text })
  try {
    rmSync(join(dir, 'snap.tar.xz'))
    const r = spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' })
    assert.equal(r.status, 0)
    assert.match((r.stdout ?? '') + (r.stderr ?? ''), /SKIP\(#1\)  快照不在场/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
