#!/usr/bin/env node
// check-engine-overlay.mjs — 引擎 overlay 快照抽验门禁（0.13.3 W1）
// 对 snapshot.tar.xz 单遍流式扫描，断言 engine-overlay.json 登记表在快照内全量落位：
//   1. 根包 @deepseek-ai/dsh 版本 == engineVersion
//   2. packages 逐包在场且版本精确一致（220 包）
//   3. vendorTop / pins / nested 同上
//   4. keepUnpublished 包仍在树内（任意版本）
//   5. dsh-agent-presets 内置 presets/ 非空（0.1.2-rc.1 新载体）
// 退出 0 = PASS；1 = FAIL（拒绝打包）。双仓同版（雷点 10）。
//
// 用法：node scripts/check-engine-overlay.mjs <snapshot.tar.xz> [--manifest scripts/snapshot-config/engine-overlay.json]
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const snap = process.argv[2]
let manArg = null
{
  const i = process.argv.indexOf('--manifest')
  if (i > 0) manArg = resolve(process.argv[i + 1])
}
const manifestPath = manArg ?? join(HERE, 'snapshot-config', 'engine-overlay.json')
if (!snap) { console.error('用法: node scripts/check-engine-overlay.mjs <snapshot.tar.xz> [--manifest <engine-overlay.json>]'); process.exit(2) }
const M = JSON.parse(readFileSync(manifestPath, 'utf8'))
// W8 合规核验：overlay 新引 npm 依赖的许可证登记（非 copyleft 面，漂移即拒）
const LICENSES = JSON.parse(readFileSync(join(HERE, 'snapshot-config', 'engine-overlay-licenses.json'), 'utf8')).licenses
// 引擎树补丁登记表（marker 抽验来源，0.13.5 起）
const PATCH_REGISTRY = JSON.parse(readFileSync(join(HERE, 'patches', 'registry.json'), 'utf8'))

const NM = 'usr/lib/node_modules/@deepseek-ai/dsh/'
const want = new Map() // tarPath -> { kind, name, version, host }
const put = (rel, kind, name, version) => want.set(NM + rel, { kind, name, version })
put('package.json', 'root', '@deepseek-ai/dsh', M.engineVersion)
for (const [n, v] of Object.entries(M.packages)) put(`node_modules/${n}/package.json`, 'pkg', n, v)
for (const [n, v] of Object.entries(M.vendorTop ?? {})) put(`node_modules/${n}/package.json`, 'vendor', n, v)
for (const [n, v] of Object.entries(M.pins ?? {})) put(`node_modules/${n}/package.json`, 'pin', n, v)
for (const [h, children] of Object.entries(M.nested ?? {})) {
  for (const [n, v] of Object.entries(children)) put(`node_modules/${h}/node_modules/${n}/package.json`, 'nested', n, v)
}
for (const entry of M.keepUnpublished ?? []) {
  const name = entry.replace(/ \(.+\)$/, '')
  put(`node_modules/${name}/package.json`, 'keep', name, null)
}
put('node_modules/@deepseek-ai/dsh-agent-presets/package.json', 'presets-carrier', '@deepseek-ai/dsh-agent-presets', null)
const presetsPrefix = NM + 'node_modules/@deepseek-ai/dsh-agent-presets/presets/'
let presetsEntries = 0
// 引擎树补丁 marker 随门禁抽验（0.13.5 起登记表驱动）：scripts/patches/registry.json
// 内每个 scope=engine 补丁，其 target 文件必须带该补丁的 marker——防「补丁未施加/版本漂移」
// 的静默半成品（新增补丁自动纳入，无需再手改本文件）。
for (const patch of PATCH_REGISTRY.patches.filter((p) => p.scope === 'engine')) {
  const marker = String(patch.marker ?? '').replace(/（.*$/, '').trim()
  if (marker.length === 0) continue
  want.set(patch.target, { kind: 'patch-marker', name: patch.id, version: null, marker })
}

const py = `
import tarfile, json, sys
want = json.loads(open(sys.argv[2], 'r', encoding='utf-8').read())
nm = sys.argv[4]
hits = {}
present = {}
presets = 0
looked_non_pkg = 0
with tarfile.open(sys.argv[1], 'r|xz') as t:
    for m in t:
        n = m.name
        if n.startswith(sys.argv[3]) and m.isfile():
            presets += 1
        if not m.isfile():
            continue
        # 关键（0.13.8-b 实锤回归）：want 里既有 package.json，也有 .js/.ts 目标（patch-marker）——
        # 一律要取回内容。曾经这里只放行 package.json，导致 7 个 .js marker 永远「缺失」→ 假红拒打包。
        need_hit = n in want
        need_present = n.endswith('/package.json') and n.startswith(nm)
        if not (need_hit or need_present):
            continue
        txt = t.extractfile(m).read().decode('utf-8', 'replace')
        if need_hit:
            hits[n] = txt
        if not need_present:
            looked_non_pkg += 1
            continue
        # 反向面：快照内每个包的 (version, deps) —— 供依赖闭包判定「未登记且无来源」
        try:
            j = json.loads(txt)
        except Exception:
            continue
        present[n] = {'name': j.get('name'), 'version': j.get('version'), 'dir': nm,
                      'deps': list((j.get('dependencies') or {}).keys())
                              + list((j.get('optionalDependencies') or {}).keys())
                              + list((j.get('peerDependencies') or {}).keys())}
print(json.dumps({'hits': hits, 'presets': presets, 'present': present, 'lookedNonPkg': looked_non_pkg}))
`
let res
try {
  // python 脚本与 want 清单都经临时文件传递（cmd.exe 对多行 -c 参数/超长 argv 直接碎裂）
  const tmpPy = join(dirname(snap), `.engine-overlay-scan-${process.pid}.py`)
  const wantFile = join(dirname(snap), `.engine-overlay-want-${process.pid}.json`)
  writeFileSync(tmpPy, py)
  writeFileSync(wantFile, JSON.stringify([...want.keys(), presetsPrefix]))
  try {
    const snapWin = snap.replace(/\\/g, '/')
    res = JSON.parse(execSync(`${process.platform === 'win32' ? 'python' : 'python3'} ${JSON.stringify(tmpPy)} ${JSON.stringify(snapWin)} ${JSON.stringify(wantFile)} ${JSON.stringify(presetsPrefix)} ${JSON.stringify(NM)}`, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }))
  } finally {
    rmSync(tmpPy, { force: true })
    rmSync(wantFile, { force: true })
  }
} catch (e) {
  console.error(`ENGINE-OVERLAY CHECK FAILED（扫描执行失败）: ${String(e).slice(0, 400)}`)
  process.exit(1)
}

const fails = []
let checked = 0
// 防回归自检（0.13.8-b）：want 含非 package.json 目标（patch-marker 的 .js/.ts）时，扫描器必须真的
// 取回过这类目标——否则「marker 面」会整体失效而无人知（本轮 7 项假红即此形态）。
{
  const nonPkgWant = [...want.keys()].filter((p) => !p.endsWith('/package.json')).length
  const looked = res.lookedNonPkg ?? 0
  if (nonPkgWant > 0 && looked === 0) {
    fails.push('扫描器口径失效：want 含 ' + nonPkgWant + ' 个非 package.json 目标（patch-marker 等），但一个都没取回')
  }
}
for (const [path, meta] of want) {
  const content = res.hits[path]
  if (!content) {
    if (meta.kind === 'keep') fails.push(`keep 包缺失: ${meta.name}`)
    else fails.push(`[${meta.kind}] 缺失: ${meta.name} (${path})`)
    continue
  }
  if (meta.version) {
    let ver = null
    try { ver = JSON.parse(content).version } catch { /* 保留 null */ }
    if (ver !== meta.version) fails.push(`[${meta.kind}] 版本不符: ${meta.name} 期望 ${meta.version} 实得 ${ver}`)
    checked++
  } else if (meta.kind === 'patch-marker') {
    if (!content.includes(meta.marker)) fails.push(`[patch-marker] ${meta.name} 标记「${meta.marker}」缺席（补丁未施加或版本漂移）`)
    checked++
  } else if (meta.kind === 'vendor' || meta.kind === 'nested' || meta.kind === 'pin') {
    // W8：登记清单内的包顺带核验 license 字段（比对 engine-overlay-licenses.json）
    const expected = LICENSES[meta.name]
    if (expected !== undefined) {
      let license = null
      try { license = JSON.parse(content).license } catch { /* 保留 null */ }
      if (typeof license !== 'string' || !license.toUpperCase().includes(expected.toUpperCase())) {
        fails.push(`[license] ${meta.name} 登记 ${expected} 实得 ${license}——上游许可变更，人工核对后更新登记`)
      }
    }
    checked++
  } else checked++
}
// ── 反向面（0.13.8-b ST-17）：快照里出现的包必须「已登记」或「可由已登记包经依赖闭包到达」──
// 单向门禁只证「登记的都在」，证不了「在的都登记/有来源」——未登记且无来源的包 = 幽灵面（可能是上游新增
// 依赖、也可能是被塞进来的包）。传递依赖不逐个登记（npm 提升会产生数百条、每次上游 bump 都变），
// 而是用快照自身的 dependencies 做闭包，闭包外的一律判红。
{
  const present = res.present ?? {}
  const declared = new Set()
  for (const name of Object.keys(M.packages ?? {})) declared.add(name)
  for (const name of Object.keys(M.vendorTop ?? {})) declared.add(name)
  for (const name of Object.keys(M.pins ?? {})) declared.add(name)
  for (const entry of M.keepUnpublished ?? []) declared.add(entry.replace(/ \(.+$/, '').trim())
  declared.add('@deepseek-ai/dsh-agent-presets')
  for (const name of M.extraPresent ?? []) declared.add(name)
  // name -> tarPath（同名多副本时取第一个：闭包判定只需可达性）
  // 只统计「顶层包目录」：路径 = <NM>node_modules/<pkg|@scope/pkg>/package.json。
  // 更深层的 package.json 是嵌套副本；name 与目录名不一致的是 exports 子路径等非包目录（跳过）。
  const byName = new Map()
  for (const [path, meta] of Object.entries(present)) {
    if (!meta || !meta.name) continue
    const rel = path.slice(NM.length + 'node_modules/'.length)
    const parts = rel.split('/')
    const dirName = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    const depth = parts[0].startsWith('@') ? 3 : 2
    if (parts.length !== depth) continue          // 嵌套副本
    if (meta.name !== dirName) continue           // exports 子路径/别名目录
    if (byName.has(meta.name)) continue
    byName.set(meta.name, meta)
  }
  const reached = new Set()
  const queue = [...declared].filter((n) => byName.has(n))
  for (const n of queue) reached.add(n)
  while (queue.length > 0) {
    const cur = byName.get(queue.shift())
    for (const dep of cur?.deps ?? []) {
      if (reached.has(dep)) continue
      reached.add(dep)
      if (byName.has(dep)) queue.push(dep)
    }
  }
  const unaccounted = [...byName.keys()].filter((n) => !declared.has(n) && !reached.has(n)).sort()
  checked += 0
  console.log('  反向面：快照内 ' + byName.size + ' 包 / 登记 ' + declared.size + ' / 依赖闭包可达 ' + reached.size
    + ' / 无来源 ' + unaccounted.length)
  // 根安装集断言（防「删登记项靠闭包兜住」）：dsh 根 package.json 的每个直接依赖都必须**逐条登记**
  // （版本钉面）或在 extraPresent 里显式声明——从 overlay 表删一个根依赖即红。
  const rootMeta = present[NM + 'package.json']
  const rootDeps = rootMeta?.deps ?? []
  const rootUnpinned = rootDeps.filter((n) => !declared.has(n)).sort()
  console.log('  根安装集：直接依赖 ' + rootDeps.length + ' 条 / 未登记 ' + rootUnpinned.length)
  if (rootUnpinned.length > 0) {
    fails.push('dsh 根直接依赖未登记（版本钉缺失）' + rootUnpinned.length + ' 个: [' + rootUnpinned.slice(0, 8).join(', ') + ']')
  }
  if (unaccounted.length > 0) {
    fails.push('未登记且依赖闭包不可达的包 ' + unaccounted.length + ' 个: [' + unaccounted.slice(0, 5).join(', ') + ']'
      + '——若为上游新增依赖请登记进 engine-overlay.json，若是被塞入的包请移除')
  }
}
if (res.presets < 1) fails.push(`dsh-agent-presets 内置 presets/ 为空（${res.presets} 项）——0.1.2-rc.1 预设载体缺席`)
else console.log(`  dsh-agent-presets presets/ 条目: ${res.presets}`)

if (fails.length) {
  console.error(`ENGINE-OVERLAY CHECK FAILED（${fails.length} 项）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`ENGINE-OVERLAY CHECK PASSED（${checked} 包版本断言 + presets 在场；引擎 ${M.engineVersion}）`)
