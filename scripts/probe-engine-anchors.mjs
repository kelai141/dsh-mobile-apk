#!/usr/bin/env node
// probe-engine-anchors.mjs — 在「补丁施加前」的引擎产物上跑锚点命中矩阵
// 施加对象是 .deploy-tmp/anchor-probe-<引擎版>/root 下的 tgz 副本：仓库、stage、快照都不碰。
//
// 为什么需要它（0.14.2 两条实锤）：
//   1) 拿 stage 目录当探针根 = 拿上一次的陈旧解包现场当现状。本轮实测 stage 里仍是 0.1.2-rc.1
//      引擎树（构建的中间态并不总与登记表同版本），据此得出的「锚点命中」结论全是错的。
//   2) 补丁测试的夹具是写死版本的 0.1.5 副本，补丁在真树上全断而 16 个测试全绿。
// 本脚本的真值源 = engine-overlay.json 的 (包名, 版本) → .deploy-tmp/engine-overlay/ 里构建期
// 实际拉取过的 tgz。那批 tgz 就是 overlay 写进 stage 的字节，与快照内的引擎内容同源。
//
// 用法：
//   node scripts/probe-engine-anchors.mjs                 # 全量 engine 补丁命中矩阵
//   node scripts/probe-engine-anchors.mjs --only <id,..>  # 单条
//   node scripts/probe-engine-anchors.mjs --fixtures      # 顺带把纯净产物写成补丁测试夹具（随版）
//   node scripts/probe-engine-anchors.mjs --fixtures --capture-only --overlay <full-overlay.json> --source-manifest <export.json>
//     # 构建期只捕获真实产物，不运行补丁或探针；没有 0.2 产物时明确失败，不补造 hash/字节
//   node scripts/probe-engine-anchors.mjs --clean         # 只清探针根不重跑
// 退出码：0 = 全部命中（或已应用）；1 = 有锚点未命中；2 = 用法/前置（缓存缺失等）。
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const NM_PREFIX = 'usr/lib/node_modules/@deepseek-ai/dsh/'
const CACHE = join(ROOT, '.deploy-tmp', 'engine-overlay')

const args = process.argv.slice(2)
const badFlag = args.filter((a) => a.startsWith('-') && !['--only', '--clean', '--engine', '--fixtures', '--capture-only', '--overlay', '--source-manifest'].includes(a))
if (badFlag.length) {
  console.error('未知参数: ' + badFlag.join(' ') + '\n用法: node scripts/probe-engine-anchors.mjs [--only id,..] [--engine <ver>] [--overlay <full.json>] [--source-manifest <export.json>] [--fixtures [--capture-only]|--clean]')
  process.exit(2)
}
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null
if (onlyIdx >= 0 && !args[onlyIdx + 1]) { console.error('--only 需要逗号分隔的补丁 id'); process.exit(2) }
const value = flag => {
  const index = args.indexOf(flag)
  if (index < 0) return null
  if (!args[index + 1] || args[index + 1].startsWith('--')) {
    console.error(flag + ' 需要参数'); process.exit(2)
  }
  return args[index + 1]
}
const wantEngine = value('--engine')
const captureOnly = args.includes('--capture-only')
if (captureOnly && !args.includes('--fixtures')) {
  console.error('--capture-only 必须与 --fixtures 同用'); process.exit(2)
}
if (args.includes('--fixtures') && only) {
  console.error('--fixtures 不能与 --only 同用：拒绝部分夹具集'); process.exit(2)
}

const contract = JSON.parse(readFileSync(join(ROOT, 'scripts', 'contract.json'), 'utf8'))
const overlayPath = resolve(ROOT, value('--overlay') ?? 'scripts/snapshot-config/engine-overlay.json')
const overlay = JSON.parse(readFileSync(overlayPath, 'utf8'))
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(contract.baseline)) throw new Error('无效 contract.baseline')
if (overlay.engineVersion !== contract.baseline || overlay.rootPackage?.version !== contract.baseline) {
  console.error('overlay/contract 基线不一致：拒绝跨代夹具'); process.exit(2)
}
const sourceManifestPath = value('--source-manifest')
const sourceManifest = sourceManifestPath ? JSON.parse(readFileSync(resolve(ROOT, sourceManifestPath), 'utf8')) : null
if (sourceManifest && (sourceManifest.commit !== contract.upstream.commit
  || sourceManifest.packageManager !== contract.upstream.packageManager || !/^[0-9a-f]{64}$/.test(sourceManifest.lockfileSha256 ?? ''))) {
  console.error('source-build manifest 身份/真实 lock hash 与合同不符'); process.exit(2)
}
const sourcePackages = new Map((sourceManifest?.packages ?? []).map(packageInfo => [packageInfo.name, packageInfo]))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
if (wantEngine && wantEngine !== overlay.engineVersion) {
  console.error(`登记表引擎为 ${overlay.engineVersion}，与 --engine ${wantEngine} 不符。`
    + ' 追版要先跑 gen-engine-overlay.mjs --write 重钉登记表，探针不提供跨版本拼树。')
  process.exit(2)
}
const probeRoot = join(ROOT, '.deploy-tmp', `anchor-probe-${overlay.engineVersion}`, 'root')
if (args.includes('--clean')) {
  rmSync(probeRoot, { recursive: true, force: true })
  console.log(`已清探针根: ${probeRoot}`)
  process.exit(0)
}

// ── 引擎路径 → (tgz 内文件) 的归属表 ──
// rootPackage 的 lib/bin.js 落在引擎根；其余三包（packages/vendorTop/pins）落在顶层 node_modules；
// nested 落在宿主包的 node_modules。keepUnpublished 不从 tgz 覆盖（树内保留基座旧版），
// 所以命中矩阵对它无效——单独判红而不是静默跳过，避免「探针说 OK」被当成真话。
const owners = new Map() // 引擎相对目录 -> { name, version, keepUnpublished? }
owners.set('', { name: overlay.rootPackage.name, version: overlay.rootPackage.version })
for (const group of ['packages', 'vendorTop', 'pins']) {
  for (const [name, version] of Object.entries(overlay[group] ?? {})) owners.set(`node_modules/${name}`, { name, version })
}
for (const [host, children] of Object.entries(overlay.nested ?? {})) {
  for (const [name, version] of Object.entries(children)) {
    owners.set(`node_modules/${host}/node_modules/${name}`, { name, version })
  }
}
const keepNames = new Set((overlay.keepUnpublished ?? []).map((e) => String(e).replace(/ \(.+$/, '').trim()))

/** 目标相对路径 → 最深匹配的包归属（'usr/lib/.../<pkg>/lib/x.js' 里最长的那段目录）。 */
function ownerOf(rel) {
  const parts = rel.split('/')
  for (let i = parts.length - 2; i >= 0; i--) {
    const dir = parts.slice(0, i + 1).join('/')
    const own = owners.get(dir)
    if (own) return { own, dir, inner: parts.slice(i + 1).join('/') }
  }
  // 引擎根包自己的文件（lib/bin.js 等）：不属于任何 node_modules 子目录
  if (!rel.startsWith('node_modules/')) {
    const root = owners.get('')
    if (root) return { own: root, dir: '', inner: rel }
  }
  return null
}

const tgzName = (name, version) => `${name.replace('@', '').replace('/', '-')}-${version}.tgz`

/** npm tgz = gzip + ustar（前缀 `package/`）。纯 node 解，不依赖外部 tar（MSYS 会咬，坑 166）。 */
const archives = new Map()
function readTgz(tgzPath, own) {
  if (archives.has(tgzPath)) return archives.get(tgzPath)
  const tarball = readFileSync(tgzPath)
  const tarballSha256 = sha256(tarball)
  const info = sourcePackages.get(own.name)
  if (sourceManifest && own.name.startsWith('@deepseek-ai/') && (!info || info.version !== own.version
    || info.file !== tgzName(own.name, own.version) || info.sha256 !== tarballSha256
    || info.sourceCommit !== contract.upstream.commit)) {
    throw new Error('source-build tarball identity/hash 漂移: ' + own.name)
  }
  const buf = gunzipSync(tarball)
  const files = new Map()
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '')
    if (!name) break
    const prefix = buf.subarray(off + 345, off + 500).toString('utf8').replace(/\0.*$/, '')
    const full = prefix ? prefix + '/' + name : name
    const size = parseInt(buf.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8)
    if (!Number.isSafeInteger(size) || size < 0 || off + 512 + size > buf.length) throw new Error('无效 tar member size')
    const type = buf[off + 156]
    if (full.startsWith('package/') && (type === 0 || type === 48)) {
      const inner = full.slice('package/'.length)
      if (!inner || inner.startsWith('/') || inner.includes('\\') || inner.split('/').some(part => part === '..' || part === '.')) {
        throw new Error('不安全 tar 路径: ' + full)
      }
      if (files.has(inner)) throw new Error('重复 tar member: ' + full)
      files.set(inner, buf.subarray(off + 512, off + 512 + size))
    }
    off += 512 + Math.ceil(size / 512) * 512
  }
  const packageBytes = files.get('package.json')
  if (!packageBytes) throw new Error('tarball 无 package.json: ' + own.name)
  const pkg = JSON.parse(packageBytes.toString('utf8'))
  if (pkg.name !== own.name || pkg.version !== own.version) throw new Error('tarball 包身份与 overlay 不符: ' + own.name)
  const archive = { files, provenance: {
    tarballFile: tgzName(own.name, own.version), tarballSha256,
    inputKind: info ? 'source-build' : 'published-tarball',
    ...(info ? { sourceCommit: info.sourceCommit, sourceLockfileSha256: sourceManifest.lockfileSha256 } : {}),
  } }
  archives.set(tgzPath, archive)
  return archive
}

const registry = JSON.parse(readFileSync(join(ROOT, 'scripts', 'patches', 'registry.json'), 'utf8'))
const targets = registry.patches.filter((p) => (p.scope ?? 'vendor') === 'engine')
/* 退役条目（registry.retired[]）**不施加补丁**，但**必须继续供夹具**：
 * 退役的前提是「上游已原生满足它」，而这个前提会随上游再次漂移 ⇒ 守卫测试必须直接对上游真产物断言。
 * 此前退役（A3/A5/C3）直接从 patches 删条目，夹具随之停供、守卫测试跑不起来（0.14.2 rc.2 追版实锤）。 */
const retiredTargets = (registry.retired ?? []).filter((p) => (p.scope ?? 'vendor') === 'engine')
const materialized = new Map() // tgz 文件 -> 命中它的补丁数
const problems = []
const discoveredTargets = {}

function materialize(target, patchId) {
  if (typeof target !== 'string' || !target.startsWith(NM_PREFIX) || target.includes('\\')
    || target.split('/').some(part => part === '..' || part === '.')) throw new Error('目标不在引擎树内: ' + target)
  const owner = ownerOf(target.slice(NM_PREFIX.length))
  if (!owner) throw new Error('找不到包归属: ' + target)
  const { name, version } = owner.own
  const cacheFile = join(CACHE, tgzName(name, version))
  if (!existsSync(cacheFile)) throw new Error(name + '@' + version + ' 缺真实构建缓存 ' + cacheFile)
  const archive = readTgz(cacheFile, owner.own)
  for (const inner of [owner.inner, 'package.json']) {
    const bytes = archive.files.get(inner)
    if (!bytes) throw new Error('tgz 内没有 ' + inner + ' (' + name + '@' + version + ')')
    const actualTarget = NM_PREFIX + (owner.dir ? owner.dir + '/' : '') + inner
    const key = tgzName(name, version) + '::' + inner
    const rec = materialized.get(key) ?? { bytes, target: actualTarget, name, version, inner, provenance: archive.provenance, patchIds: [] }
    if (!rec.patchIds.includes(patchId)) rec.patchIds.push(patchId)
    materialized.set(key, rec)
  }
}
/** D1's bundled chunk hash is build output, not source metadata. Discover exactly one real chunk. */
function patchTargets(patch) {
  if (patch.id !== 'terminal-inspector-android-D1') return [patch.target, ...(patch.additionalTargets ?? [])]
  const owner = ownerOf(patch.target.slice(NM_PREFIX.length))
  if (!owner || owner.own.name !== '@deepseek-ai/dsh-subprocess-local') throw new Error('D1 package ownership drift')
  const cacheFile = join(CACHE, tgzName(owner.own.name, owner.own.version))
  const archive = readTgz(cacheFile, owner.own)
  const anchor = 'function createProcessInspector(platform = process.platform, arch = process.arch, internals = DEFAULT_INTERNALS) {'
  const candidates = [...archive.files].filter(([inner, bytes]) => /^lib\/runner-launch-[^/]+\.js$/.test(inner)
    && bytes.toString('utf8').includes(anchor)
    && bytes.toString('utf8').includes('terminal inspection is unsupported on platform'))
  if (candidates.length !== 1) throw new Error('D1 exact chunk discovery requires one inspector, found ' + candidates.length)
  const target = NM_PREFIX + owner.dir + '/' + candidates[0][0]
  discoveredTargets[patch.id] = [target]
  return [target, ...(patch.additionalTargets ?? [])]
}
for (const p of [...targets, ...retiredTargets]) {
  if (only && !only.includes(p.id)) continue
  try {
    for (const target of patchTargets(p)) materialize(target, p.id)
  } catch (error) { problems.push(p.id + ': ' + error.message) }
}

if (problems.length) {
  console.error('探针前置未满足（不跑命中矩阵，避免半张表被当成全表）:')
  for (const m of problems) console.error('  - ' + m)
  process.exit(2)
}

// ── 夹具随版（--fixtures）：补丁测试的输入必须是它声称的那个引擎版本 ──
// 0.14.2 的实锤：补丁在 rc.1 真树上断 9 条，而 16 个补丁测试全绿——因为它们的夹具是 0.1.5 的副本。
// 夹具与真产物同源（同一批 tgz 的原始字节），「夹具版本 == contract.baseline」由
// scripts/check-patch-fixtures.mjs 把守；合成夹具（手写最小复现）必须在 manifest 里显式声明，
// 沉默不再是选项。
if (args.includes('--fixtures')) {
  const fixRoot = join(HERE, 'patches', 'tests', 'fixtures')
  const manifestPath = join(fixRoot, 'manifest.json')
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { fixtures: {} }
  manifest.$comment = 'Current fixtures are exact unmodified files from the build cache, including multi-file companions and package identity. Provenance/file hashes are computed at capture time, never guessed from source or old releases.'
  for (const meta of Object.values(manifest.fixtures)) {
    if (meta.source === 'engine-tgz' && meta.engine !== contract.baseline) {
      meta.source = 'superseded'
      meta.reason = 'Historical artifact; not current-baseline regression input. Current real build artifacts were captured separately.'
    }
  }
  const captured = new Map()
  for (const rec of materialized.values()) {
    const short = rec.name === overlay.rootPackage.name ? 'dsh-root' : rec.name.replace(/^@[^/]+\//, '')
    const dir = short + '-' + contract.baseline
    const entry = captured.get(dir) ?? {
      source: 'engine-tgz', engine: contract.baseline, package: rec.name + '@' + rec.version,
      provenance: rec.provenance, files: [], fileSha256: {}, targets: {}, patchIds: [],
    }
    if (entry.package !== rec.name + '@' + rec.version || entry.provenance.tarballSha256 !== rec.provenance.tarballSha256) {
      throw new Error('同名夹具目录的包版本/产物来源冲突: ' + dir)
    }
    entry.files.push(rec.inner)
    entry.fileSha256[rec.inner] = sha256(rec.bytes)
    entry.targets[rec.inner] = rec.target
    entry.patchIds = [...new Set([...entry.patchIds, ...rec.patchIds])]
    captured.set(dir, entry)
  }
  // All sources and companions were verified before touching the fixture tree.
  for (const [dir, meta] of captured) {
    const path = join(fixRoot, dir)
    if (resolve(path) !== resolve(fixRoot, dir) || !/^[a-zA-Z0-9_.-]+$/.test(dir)) throw new Error('不安全夹具目录: ' + dir)
    rmSync(path, { recursive: true, force: true })
    mkdirSync(path, { recursive: true })
    meta.files.sort()
    manifest.fixtures[dir] = meta
  }
  for (const rec of materialized.values()) {
    const short = rec.name === overlay.rootPackage.name ? 'dsh-root' : rec.name.replace(/^@[^/]+\//, '')
    const dest = join(fixRoot, short + '-' + contract.baseline, rec.inner)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, rec.bytes)
  }
  manifest.capture = {
    engine: contract.baseline, sourceCommit: contract.upstream.commit, discoveredTargets,
    overlaySha256: sha256(readFileSync(overlayPath)), registrySha256: sha256(readFileSync(join(HERE, 'patches', 'registry.json'))),
    ...(sourceManifestPath ? { sourceManifestSha256: sha256(readFileSync(resolve(ROOT, sourceManifestPath))) } : {}),
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log('真实夹具已捕获: ' + materialized.size + ' 文件 / ' + contract.baseline)
}
if (captureOnly) {
  console.log('CAPTURE ONLY: no patch application or anchor acceptance was performed')
  process.exit(0)
}
// Recreate only this checked scratch directory; a previous partial probe must not supply missing files.
if (resolve(probeRoot) !== resolve(ROOT, '.deploy-tmp', 'anchor-probe-' + overlay.engineVersion, 'root')) throw new Error('不安全探针根')
rmSync(probeRoot, { recursive: true, force: true })
for (const rec of materialized.values()) {
  const dest = join(probeRoot, rec.target)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, rec.bytes)
}

for (const p of targets) {
  const rel = p.target.slice(NM_PREFIX.length)
  const owner = ownerOf(rel)
  if (owner && keepNames.has(owner.own.name)) {
    console.log(`  注意: ${p.id} 的目标包 ${owner.own.name} 在 keepUnpublished 内`
      + `（树内保留基座 ${owner.own.version}），本矩阵的「命中」不代表它随版对齐`)
  }
}

console.log(`探针根: ${probeRoot}`)
console.log(`引擎 ${overlay.engineVersion} / 复现 ${[...materialized.values()].filter((v) => v.bytes).length} 个产物文件`)
// 为什么跑 --apply 而不是 --check：apply-patches 的 check() 语义是「补丁已施加？」，
// 对纯净产物树 check 模式必然把每一条都报成「缺席」——那不是命中矩阵，是同义反复。
// 真矩阵只有施加才能得到：锚点在 → [ok] applied，锚点漂 → [fail] + 精确原因。
// 落笔对象是 .deploy-tmp 下的探针根（tgz 副本），仓库与 stage 都不碰。
const cli = [join(HERE, 'patches', 'apply-patches.mjs'), probeRoot, '--scope', 'engine', '--apply']
if (only) cli.push('--only', only.join(','))
const r = spawnSync(process.execPath, cli, { encoding: 'utf8' })
process.stdout.write(r.stdout ?? '')
process.stderr.write(r.stderr ?? '')
process.exit(r.status ?? 1)
