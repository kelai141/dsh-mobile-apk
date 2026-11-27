/** 审计 §4 最大单点：dsh-app-boot 安装域包扫描 realpath 记忆化（S1）的锚点、等价性与负控。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { versionedFixture } from './lib/fixture.mjs'
import { buildScopeModule } from './lib/scope-module.mjs'
import {
  APPSCOPE_FASTPATH_MARKER,
  countAppbootScopeAnchors,
  hasAppbootScopeFastpath,
  patchAppbootScopeFastpath,
} from '../data/appboot-scope-fastpath-S1.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(versionedFixture('dsh-app-boot', 'lib', 'index.js'), 'utf8')
const patched = patchAppbootScopeFastpath(source)
const PATCH_ID = 'appboot-scope-fastpath-S1'
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'

/** 建一棵可控的包树：app/package.json 为 installAnchor，依赖落在 app/node_modules。 */
function makeTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'scope-s1-'))
  const write = (dir, name, version, extra = {}) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, ...extra }, null, 2) + '\n')
  }
  try {
    return fn({ root, write, app: join(root, 'app'), nm: join(root, 'app', 'node_modules') })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** 把上游态与补丁后态逐项比对。 */
function compare(upstream, patchedModule, tree) {
  const pick = (m) => {
    const r = m.collectInstallationScopePackages(join(tree.app, 'package.json'), new Set())
    return {
      packageDirs: [...r.packageDirs].sort(),
      declarers: [...r.declarers].sort(),
      versions: [...r.versions].sort(),
      packageNames: [...r.packageNames].sort(),
    }
  }
  return { upstream: pick(upstream), patched: pick(patchedModule) }
}

test('S1 在真实产物上四组锚点各命中一次、幂等、marker 落字节', () => {
  assert.deepEqual(countAppbootScopeAnchors(source), [1, 1, 1, 1, 1], 'realModuleDirectory 签名/整段、两个 BFS 入口与 packageDirFromAnchor 各恰好一处')
  assert.equal(hasAppbootScopeFastpath(source), false, '上游态不得被误判为已施加')
  assert.ok(hasAppbootScopeFastpath(patched))
  assert.equal(patchAppbootScopeFastpath(patched), patched, '重复施加必须零变化')
  // marker 恰好出现 3 次：函数体注释 1 处 + 两个 BFS 入口各 1 处。
  assert.equal(patched.split(APPSCOPE_FASTPATH_MARKER).length - 1, 3)
  // 只增加代码，不删上游字节：补丁后必须包含上游每一个函数原样。
  for (const marker of ['function readPackageManifest(anchor) {', 'function packageDirFromAnchor(anchor, packageName) {']) {
    assert.ok(patched.includes(marker), '不得改动无关函数: ' + marker)
  }
})

test('S1 产物仍是可解析的 ESM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scope-s1-parse-'))
  try {
    const probe = join(dir, 'index.mjs')
    writeFileSync(probe, patched)
    const check = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr || check.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('S1 等价性：links / declarers / versions / packageNames 与上游逐项相等', () => {
  const upstream = buildScopeModule(source)
  const patchedModule = buildScopeModule(patched)
  makeTree(({ write, app, nm }) => {
    // 覆盖：直接依赖、peer 依赖、传递依赖（两条路径汇聚同一包）、声明了但未安装、上层 node_modules。
    write(app, '@x/dsh', '0.2.1-rc.2', {
      dependencies: { 'pkg-a': '1', 'pkg-b': '1', 'missing-pkg': '1' },
      peerDependencies: { 'pkg-peer': '1' },
    })
    write(join(nm, 'pkg-a'), 'pkg-a', '1.0.0', { dependencies: { 'pkg-c': '1' } })
    write(join(nm, 'pkg-b'), 'pkg-b', '1.1.0', { dependencies: { 'pkg-c': '1' } })
    write(join(nm, 'pkg-c'), 'pkg-c', '2.0.0')
    write(join(nm, 'pkg-peer'), 'pkg-peer', '3.0.0')
    const tree = { app, nm }
    const { upstream: a, patched: b } = compare(upstream, patchedModule, tree)
    for (const key of ['packageDirs', 'declarers', 'versions', 'packageNames']) {
      assert.deepEqual(b[key], a[key], key + ' 必须与上游逐项相等')
    }
    assert.deepEqual(a.packageNames, ['@x/dsh', 'pkg-a', 'pkg-b', 'pkg-c', 'pkg-peer'])
  })
})

test('S1 等价性反证：符号链接条目必须仍被 realpath 解析（不得走 parent/child 快路径）', () => {
  const upstream = buildScopeModule(source)
  const patchedModule = buildScopeModule(patched)
  makeTree(({ root, write, app, nm }) => {
    write(app, '@x/dsh', '0.2.1-rc.2', { dependencies: { 'linked-pkg': '1', 'plain-pkg': '1' } })
    // 真实目标在 app 之外、目录名与包名不同 —— 只有真的 realpath 才能得到它。
    const store = join(root, '.store', 'linked-pkg-abc')
    write(store, 'linked-pkg', '4.5.6', { dependencies: { 'plain-pkg': '1' } })
    mkdirSync(nm, { recursive: true })
    let linkOk = true
    try {
      symlinkSync(store, join(nm, 'linked-pkg'), 'junction')
    } catch {
      linkOk = false
    }
    if (!linkOk) return // Windows 无创建链接权限时该反证不成立，跳过而不是假绿。
    const tree = { app, nm }
    const { upstream: a, patched: b } = compare(upstream, patchedModule, tree)
    assert.deepEqual(b.packageDirs, a.packageDirs, '包目录必须与上游一致（含 realpath 解析结果）')
    assert.deepEqual(b.declarers, a.declarers)
    assert.deepEqual(b.versions, a.versions)
    // 直接断言解析结果：必须是 realpath 后的真实目录，而不是 parent/child 拼接。
    const linkPath = join(nm, 'linked-pkg')
    assert.equal(upstream.realModuleDirectory(linkPath), patchedModule.realModuleDirectory(linkPath))
    assert.notEqual(patchedModule.realModuleDirectory(linkPath), linkPath, '符号链接必须解析到真实目录')
  })
})

test('S1 等价性：dependencyClosure 与 skippedBundles 分支逐项相等', () => {
  const upstream = buildScopeModule(source)
  const patchedModule = buildScopeModule(patched)
  makeTree(({ write, app, nm }) => {
    write(app, '@x/dsh', '0.2.1-rc.2', { dependencies: { 'pkg-a': '1' } })
    write(join(nm, 'pkg-a'), 'pkg-a', '1.0.0', { dependencies: { 'pkg-b': '1' }, peerDependencies: { 'pkg-peer': '1' } })
    write(join(nm, 'pkg-b'), 'pkg-b', '2.0.0')
    write(join(nm, 'pkg-peer'), 'pkg-peer', '3.0.0')
    write(join(nm, 'bundle-x'), 'bundle-x', '5.0.0', { dependencies: { 'pkg-b': '1', 'only-here': '1' } })
    write(join(nm, 'only-here'), 'only-here', '6.0.0')

    const runClosure = (m) => {
      const declarations = new Map()
      const versions = new Map()
      const reserved = new Set(['@x/dsh', 'pkg-a', 'pkg-b', 'pkg-peer'])
      const out = m.dependencyClosure([join(nm, 'bundle-x', 'package.json')], reserved, declarations, versions)
      return { out: [...out].sort(), declarations: [...declarations].sort(), versions: [...versions].sort() }
    }
    const ca = runClosure(upstream)
    const cb = runClosure(patchedModule)
    for (const key of ['out', 'declarations', 'versions']) {
      assert.deepEqual(cb[key], ca[key], 'dependencyClosure.' + key + ' 必须与上游逐项相等')
    }

    // skippedBundles 命中时改走 readProfileManifest，失败被吞 —— 两条分支都必须等价。
    const runSkipped = (m) => {
      const r = m.collectInstallationScopePackages(join(app, 'package.json'), new Set(['pkg-b']))
      return { packageDirs: [...r.packageDirs].sort(), versions: [...r.versions].sort() }
    }
    assert.deepEqual(runSkipped(patchedModule), runSkipped(upstream))
  })
})

test('S1 per-scan 缓存不跨调用残留：删包后再扫，补丁后与上游同样看见变化', () => {
  const upstream = buildScopeModule(source)
  const patchedModule = buildScopeModule(patched)
  makeTree(({ write, app, nm }) => {
    write(app, '@x/dsh', '0.2.1-rc.2', { dependencies: { 'pkg-a': '1', 'pkg-b': '1' } })
    write(join(nm, 'pkg-a'), 'pkg-a', '1.0.0')
    write(join(nm, 'pkg-b'), 'pkg-b', '2.0.0')
    const count = (m) => m.collectInstallationScopePackages(join(app, 'package.json'), new Set()).packageDirs.size
    const before = count(patchedModule)
    assert.equal(before, count(upstream))
    rmSync(join(nm, 'pkg-b'), { recursive: true, force: true })
    const afterUpstream = count(upstream)
    const afterPatched = count(patchedModule)
    assert.equal(afterPatched, afterUpstream, '树变了以后补丁后必须与上游一致')
    assert.ok(afterPatched < before, '删包必须被看见（缓存只活一次扫描）')
  })
})

test('S1 负控：锚点被改动必须抛错拒绝写半成品', () => {
  const REAL_ANCHOR = 'function realModuleDirectory(path) {'
  // ① 上游形态漂移：realModuleDirectory 被重写
  assert.throws(
    () => patchAppbootScopeFastpath(source.replace(REAL_ANCHOR, 'function realModuleDirectory(path) { // drifted')),
    /期望恰好命中 1 处，实际 0/, '锚点失配必须抛错')
  // ② 冒出了第二个同名函数但函数体不同：整段锚点仍只命中一次，只有签名计数能拦住。
  //    漏掉这条的后果是静默失效 —— JS 的函数声明后定义覆盖前定义，我们的改写会被盖掉。
  assert.throws(
    () => patchAppbootScopeFastpath(source + '\n' + REAL_ANCHOR + '\n\treturn path;\n}\n'),
    /realModuleDirectory 签名: 期望恰好 1 处，实际 2/, '同名第二定义必须抛错')
  // ③ 两个 BFS 入口各自也是硬锚点
  assert.throws(
    () => patchAppbootScopeFastpath(source.replace('function dependencyClosure(anchors, reserved, declarers, versions) {',
      'function dependencyClosure(anchors, reserved, declarers, versions, extra) {')),
    /dependencyClosure: 期望恰好命中 1 处，实际 0/, 'BFS 入口漂移必须抛错')
  // ④ 半打形态：marker 在但替换形态不完整
  assert.throws(
    () => patchAppbootScopeFastpath(source.replace(REAL_ANCHOR, '/* ' + APPSCOPE_FASTPATH_MARKER + ' */\n' + REAL_ANCHOR)),
    /marker 但替换形态不完整/, '半打必须拒绝')
})

test('S1 runner 集成：--check 判红、--apply 成功、--check 转绿、再次 --apply 逐字节幂等；撤回后回到上游', () => {
  const stage = mkdtempSync(join(tmpdir(), 'scope-s1-stage-'))
  const file = join(stage, TARGET)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
    const runner = (mode) => spawnSync(process.execPath, [
      join(HERE, '..', 'apply-patches.mjs'), stage, mode, '--only', PATCH_ID, '--scope', 'engine',
    ], { encoding: 'utf8', cwd: join(HERE, '..', '..', '..') })

    assert.equal(runner('--check').status, 1, '未施加时 --check 必须判红')
    const applied = runner('--apply')
    assert.equal(applied.status, 0, (applied.stderr || '') + (applied.stdout || ''))
    const onDisk = readFileSync(file, 'utf8')
    assert.ok(hasAppbootScopeFastpath(onDisk))
    assert.equal(runner('--check').status, 0, '已施加后 --check 必须为绿')
    assert.equal(runner('--apply').status, 0)
    assert.equal(readFileSync(file, 'utf8'), onDisk, '重复施加必须逐字节零变化')

    // 撤回对照：把补丁写回上游字节后，行为回到上游（这是「补丁真的是唯一差异」的证明）。
    writeFileSync(file, source)
    assert.equal(readFileSync(file, 'utf8'), source, '撤回后必须逐字节回到上游')
    assert.equal(hasAppbootScopeFastpath(readFileSync(file, 'utf8')), false)
    assert.equal(runner('--check').status, 1, '撤回后 --check 必须重新判红')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
