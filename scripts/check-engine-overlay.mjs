#!/usr/bin/env node
// check-engine-overlay.mjs — 引擎 overlay 快照抽验门禁（0.13.3 W1）
// 对 snapshot.tar.xz 单遍流式扫描，断言 engine-overlay.json 登记表在快照内全量落位：
//   1. 根包 @deepseek-ai/dsh 版本 == engineVersion
//   2. packages 逐包在场且版本精确一致（220 包）
//   3. vendorTop / pins / nested 同上
//   4. keepUnpublished 包仍在树内（任意版本）
//   5. 内置预设载体非空：agent-preset 的 skills/ 与 web-app 的 presets/（0.14.2 起，见 CARRIERS）
// 退出 0 = PASS；1 = FAIL（拒绝打包）。双仓同版（雷点 10）。
//
// 用法：node scripts/check-engine-overlay.mjs <snapshot.tar.xz> [--manifest scripts/snapshot-config/engine-overlay.json]
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { resolveEnginePatchTarget } from './patches/resolve-engine-patch-target.mjs'
import { planPiStreaming } from './patches/pi-upstream-streaming-020.mjs'
import { planPatch as planPtcAndroid } from './patches/ptc-android-native-A1.mjs'
import { planMimoThinking } from './patches/mimo-thinking-toggle-056.mjs'

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
/* 内置预设载体（0.14.2 追版重锚）。旧断言盯 `@deepseek-ai/dsh-agent-presets/presets/`，该包在
 * 0.1.7 被拆成 agent-preset + agent-preset-registry（gen-engine-overlay 的孤儿段实测删除），
 * 载体形态也变了——0.1.7-rc.1 的 tarball 实测：agent-preset 出 `skills/`（15 项），
 * web-app 出 `presets/*.patch.yml`（4 项：cordis/minimal/ptc/standard）。
 * 两条都继续断言：只断「包在场」会被 overlay 覆盖（冗余），断「目录非空」才挡得住
 * 「发布了包但内容没打进去」（files 漏项 = 上游发布回归）。 */
const CARRIERS = [
  { label: 'agent-preset skills/', prefix: NM + 'node_modules/@deepseek-ai/dsh-agent-preset/skills/' },
  { label: 'web-app presets/', prefix: NM + 'node_modules/@deepseek-ai/dsh-web-app/presets/' },
]
/* 行面来源文件（**从快照里读**，不读工作树）：三个 cordis.patch.yml 决定「哪些包真的会被 import」。
 * 正向闭包只对这张行面问责——不在行面上的包（一堆 experimental provider、test-only 面）
 * 缺依赖不会影响 boot，对它们判红是假红（本轮实测 66 条里只有 3 条真影响 boot）。
 * 用**解析器**读 id/name/disabled，不用 grep 判存在性（PLAN §1.1 的 grep 误判教训）。 */
const ROW_FILES = [
  NM + 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml',
  NM + 'node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml',
  'home/.dsh/profiles/web/cordis.patch.yml',
]
/** 从一份 cordis.patch.yml 抽出「会被挂载且未 disabled」的行名：Set<name>。
 *
 * 手写行式状态机（本仓无 yaml 依赖）。**不用 grep 判 id 存在性**——PLAN §1.1 记过一次
 * grep 把注释里的 id 与另一个序列混起来的误判；这里的规则是够用的最小状态机：
 *   - 以 `- ` 开头的行开启一个**新的序列项**（无论缩进，因为 patch 文件是被 patch 的片段序列，
 *     项的嵌套全部通过 `insert:` 的序列表达）；
 *   - 其余 `key: value` 行归当前项；
 *   - 项结束时结算：有 name 且 disabled 非 none/false ⇒ 计入挂载集。
 * 注释行（`#`）与空行跳过；`!!js` 表达式原样当字符串（只判「有没有值」，不判语义）。
 * 自证：`--self-test` 用合成 patch 验 disabled/insert 嵌套/注释四个分支。 */
function mountedRowNames(text) {
  const out = new Set()
  const finish = (item) => {
    if (item === null || item.name === null) return
    // 只有**字面 true** 才算禁用。`disabled: !!js "<表达式>"` 是条件禁用：我们是 profile 启动器
    // （存在 profileContext），故 base 里 `!ctx.get('profileContext')` 这类表达式的行实际是**挂载**的
    // ——这正是 PLAN §1.1 A-6 的发现（hmr / plugin-manager / tool-plugin-manager 三行）。
    // 把条件行当禁用会漏掉它们的依赖（实测：漏掉 execa，正是本轮 boot 崩的一条）。
    if (item.disabled === true) return
    out.add(item.name)
  }
  let item = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (line.length === 0) continue
    if (/^- /.test(line) || line === '-') {
      finish(item)
      item = { name: null, disabled: null }
      const rest = line === '-' ? '' : line.slice(2).trim()
      if (rest.length > 0) {
        const m = /^name:\s*['"]?([^'"]+?)['"]?$/.exec(rest)
        if (m) item.name = m[1].trim()
      }
      continue
    }
    if (item === null) continue
    const mName = /^name:\s*['"]?([^'"]+?)['"]?$/.exec(line)
    if (mName) { item.name = mName[1].trim(); continue }
    const mDis = /^disabled:\s*(.+)$/.exec(line)
    if (mDis) {
      const v = mDis[1].trim()
      // 字面 true 才禁用；`!!js <expr>` / false 一律视为挂载（见 finish() 的理由）
      item.disabled = (v === 'true') ? true : null
    }
  }
  finish(item)
  return out
}
/* 正向闭包豁免：上游声明了运行时依赖、但**故意**不进 overlay 的名字。
 * 空集是目标态——每加一条必须在注释里写清为什么不需要覆盖（平台可选 / 宿主既有 / 由 profile 提供）。
 * 不许用「没看见」代替裁决。 */
const RUNTIME_MISSING_OK = new Set([
  /* 0.14.2 实测：rc.1 的 dsh-office-to-pdf（web-app bundle 新行）运行时依赖
   * @deepseek-ai/libreoffice-kit。我们在 profile patch 里**显式禁用该行**（见
   * scripts/profile-web.cordis.patch.yml 的同名条目），故它不在行面上、也不该进 overlay。
   * 依据（可复算）：libreoffice-kit 的 platformTarget() 只认 darwin/win32/linux-glibc，
   * Android 下 process.platform === 'android' ⇒ 返回 undefined ⇒ resolveEngine() 落到
   * `if (platform !== 'linux') throw new Error('Unsupported LibreOfficeKit host: android-x64')`，
   * **无条件抛**（152 MB 的 -wasm 引擎也救不了：那一步同样被 platform !== 'linux' 挡掉）。
   * 上游对「没有转换器」的既定降级路径就是 UI 的 unavailable guidance
   * （ui-sidebar-documentpreview README：移除 remote.officeToPdf 注入即恢复不可用提示）。
   * 若日后要恢复该能力，须先给出 Android 上真能跑的引擎实现，再同时删掉本豁免与 profile 的禁用行。 */
  '@deepseek-ai/libreoffice-kit',
])
let presetsEntries = 0
// 引擎树补丁 marker 随门禁抽验（0.13.5 起登记表驱动）：scripts/patches/registry.json
// 内每个 scope=engine 补丁，其 target 文件必须带该补丁的 marker——防「补丁未施加/版本漂移」
// 的静默半成品（新增补丁自动纳入，无需再手改本文件）。
for (const patch of PATCH_REGISTRY.patches.filter((p) => p.scope === 'engine' && p.overlayCheck !== false)) {
  for (const path of [patch.target, ...(patch.additionalTargets ?? [])]) {
    const marker = String(patch.targetMarkers?.[path] ?? patch.marker ?? '').replace(/（.*$/, '').trim()
    if (!marker && !patch.verifier) throw new Error('engine patch missing verification: ' + patch.id)
    const requiredMarkers = [...(want.get(path)?.requiredMarkers ?? []), ...(path === patch.target ? patch.requiredMarkers ?? [] : [])]
    if (requiredMarkers.some(marker => typeof marker !== 'string' || !marker.trim())) throw new Error('engine patch invalid requiredMarkers: ' + patch.id)
    want.set(path, { kind: 'patch-marker', name: patch.id, version: null, marker, requiredMarkers: [...new Set(requiredMarkers)],
      verifier: patch.verifier, discovery: path === patch.target ? patch.targetDiscovery : undefined })
  }
  if (patch.verifier) {
    // 取包根 = 目标路径里**最靠后**的 /lib/ 或 /dist/ 之前那段。不能写成「有 /lib/ 就用 /lib/」：
// 引擎树里所有路径都以 `usr/lib/node_modules/...` 开头，那个 /lib/ 在索引 3，会让 packageBase 退化成 `usr`
// （实测：pi-ai 的 dist/api/*.js 被判「usr/package.json 缺失」的假红）。
const libIdx = patch.target.lastIndexOf('/lib/')
const distIdx = patch.target.lastIndexOf('/dist/')
const packageBase = patch.target.slice(0, Math.max(libIdx, distIdx))
    if (!want.has(packageBase + '/package.json')) want.set(packageBase + '/package.json', { kind: 'verifier-identity', name: patch.id, version: null })
  }
}

/** Resolve exact telemetry requirements using the consumer's actual nested lookup order. */
function exactRuntimeDependencyGaps(present, roots) {
  const gaps = []
  const seen = new Set()
  const queue = [...roots]
  const resolvePackage = (consumer, dependency) => {
    let directory = consumer.slice(0, consumer.lastIndexOf('/'))
    while (directory) {
      const candidate = directory + '/node_modules/' + dependency + '/package.json'
      if (!directory.endsWith('/node_modules') && directory !== 'node_modules'
        && present[candidate]?.name === dependency) return candidate
      directory = directory.slice(0, Math.max(0, directory.lastIndexOf('/')))
    }
    return null
  }
  while (queue.length) {
    const consumer = queue.shift()
    if (seen.has(consumer)) continue
    seen.add(consumer)
    const metadata = present[consumer]
    if (!metadata) continue
    for (const [dependency, required] of Object.entries(metadata.runtimeRequirements ?? {})) {
      const resolved = resolvePackage(consumer, dependency)
      if (!resolved) {
        gaps.push({ consumer, dependency, required, actual: null, resolved: null })
        continue
      }
      const actual = present[resolved].version
      if (/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(required) && actual !== required) {
        gaps.push({ consumer, dependency, required, actual, resolved })
      }
      queue.push(resolved)
    }
  }
  return gaps
}
// Exact dependency resolution ends.

const py = `
import tarfile, json, sys
want = set(json.loads(open(sys.argv[2], 'r', encoding='utf-8').read()))
discoveries = json.loads(open(sys.argv[6], 'r', encoding='utf-8').read())  # 发现式目标（目录 + 文件名前缀）
nm = sys.argv[3]
prefixes = json.loads(open(sys.argv[4], 'r', encoding='utf-8').read())   # 内置预设载体目录，见 CARRIERS
mounts = set(json.loads(open(sys.argv[5], 'r', encoding='utf-8').read())) # 行面来源文件（bundle/profile patch）
hits = {}
present = {}
rowFiles = {}
carriers = [0] * len(prefixes)
looked_non_pkg = 0
with tarfile.open(sys.argv[1], 'r|xz') as t:
    for m in t:
        n = m.name
        if m.isfile():
            for idx, pre in enumerate(prefixes):
                if n.startswith(pre):
                    carriers[idx] += 1
        if not m.isfile():
            continue
        # 行面（谁真的被挂载）：bundle/profile 的 cordis.patch.yml 原样取回，供正向闭包定范围
        if n in mounts:
            rowFiles[n] = t.extractfile(m).read().decode('utf-8', 'replace')
            continue
        # 关键（0.13.8-b 实锤回归）：want 里既有 package.json，也有 .js/.ts 目标（patch-marker）——
        # 一律要取回内容。曾经这里只放行 package.json，导致 7 个 .js marker 永远「缺失」→ 假红拒打包。
        # want 是「目标路径」的集合；discovery 另用一张表（discovery 是目录+文件名前缀的**发现式**目标，
        # 精确文件名随上游构建哈希变化，不能钉死 —— 见 resolve-engine-patch-target.mjs）。
        need_hit = n in want or any(
            n.startswith(d['directory'] + '/')
            and '/' not in n[len(d['directory']) + 1:]
            and n.rsplit('/', 1)[-1].startswith(d['filenamePrefix']) and n.endswith('.js')
            for d in discoveries)
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
                              + list((j.get('peerDependencies') or {}).keys()),
                      'runtimeDeps': list((j.get('dependencies') or {}).keys()),
                      'runtimeRequirements': j.get('dependencies') or {}}
print(json.dumps({'hits': hits, 'carriers': carriers, 'present': present, 'rowFiles': rowFiles, 'lookedNonPkg': looked_non_pkg}))
`
let res
try {
  // python 脚本与 want 清单都经临时文件传递（cmd.exe 对多行 -c 参数/超长 argv 直接碎裂）
  const tmpPy = join(dirname(snap), `.engine-overlay-scan-${process.pid}.py`)
  const wantFile = join(dirname(snap), `.engine-overlay-want-${process.pid}.json`)
  const carrierFile = join(dirname(snap), `.engine-overlay-carriers-${process.pid}.json`)
  const mountFile = join(dirname(snap), `.engine-overlay-mounts-${process.pid}.json`)
  const discoveryFile = join(dirname(snap), `.engine-overlay-discovery-${process.pid}.json`)
  writeFileSync(tmpPy, py)
  writeFileSync(wantFile, JSON.stringify([...want.keys(), ...CARRIERS.map(c => c.prefix)]))
  writeFileSync(discoveryFile, JSON.stringify([...want.values()]
    .map((m) => m.discovery)
    .filter((d) => d !== undefined)))
  writeFileSync(carrierFile, JSON.stringify(CARRIERS.map(c => c.prefix)))
  writeFileSync(mountFile, JSON.stringify(ROW_FILES))
  try {
    const snapWin = snap.replace(/\\/g, '/')
    res = JSON.parse(execSync(`${process.platform === 'win32' ? 'python' : 'python3'} ${JSON.stringify(tmpPy)} ${JSON.stringify(snapWin)} ${JSON.stringify(wantFile)} ${JSON.stringify(NM)} ${JSON.stringify(carrierFile)} ${JSON.stringify(mountFile)} ${JSON.stringify(discoveryFile)}`, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }))
  } finally {
    rmSync(tmpPy, { force: true })
    rmSync(wantFile, { force: true })
    rmSync(carrierFile, { force: true })
    rmSync(mountFile, { force: true })
    rmSync(discoveryFile, { force: true })
  }
} catch (e) {
  console.error(`ENGINE-OVERLAY CHECK FAILED（扫描执行失败）: ${String(e).slice(0, 400)}`)
  process.exit(1)
}

const fails = []
let checked = 0
for (const patch of PATCH_REGISTRY.patches.filter(p => p.scope === 'engine' && p.overlayCheck !== false)) {
  try {
    if (patch.targetDiscovery) {
      const target = resolveEnginePatchTarget(patch, Object.entries(res.hits))
      const meta = want.get(patch.target)
      want.delete(patch.target)
      want.set(target, meta)
    }
    if (patch.verifier) {
      const isPi = patch.id === 'pi-upstream-streaming-020' && patch.verifier === patch.id
      const isPtc = patch.id === 'ptc-android-native-A1' && patch.verifier === patch.id
      const isMimo = patch.id === 'mimo-thinking-toggle-056' && patch.verifier === patch.id
      if (!isPi && !isPtc && !isMimo) throw new Error('unknown exact verifier: ' + patch.id)
      const base = isPi ? NM + 'node_modules/@earendil-works/pi-ai' : NM + 'node_modules/@deepseek-ai/dsh-ptc-runtime-node'
      const read = file => {
        const text = res.hits[base + '/' + file]
        if (typeof text !== 'string') throw new Error('missing exact-verifier target: ' + file)
        return text
      }
      const plan = isPi
        ? planPiStreaming('', read)
        : isPtc
          ? planPtcAndroid('', false, read)
          : planMimoThinking(file => res.hits[file])
      if (plan.some(file => file.before !== file.after)) throw new Error('incomplete exact multi-file patch: ' + patch.id)
    }
  } catch (error) { fails.push('[exact-patch] ' + patch.id + ': ' + error.message) }
}
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
    if (!meta.verifier && !content.includes(meta.marker)) fails.push(`[patch-marker] ${meta.name} 标记「${meta.marker}」缺席（快照早于本代码集的补丁集，或补丁未施加；engine 补丁在构建快照时施加，官方 release 快照只含它发布那一刻的补丁集 —— 请用 node scripts/build-snapshot-013.mjs <abi> 按当前代码集重建快照后再打包）`)
    for (const marker of meta.requiredMarkers ?? []) {
      if (!content.includes(marker)) fails.push(`[patch-marker] ${meta.name} 必需标记「${marker}」缺席（快照来自旧补丁集）`)
    }
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

  /* ── 正向闭包完备性（0.14.2 设备实锤缺口，G-2 同族）────────────────────────────
   * 上面那条是**反向**判据（在的都登记/有来源）。它挡不住本轮实锤的三类静默缺席，
   * 因为那三类恰好都"有来源"或"根本不在树里"：
   *   ① 上游新增的**非 @deepseek-ai 运行时依赖**（实锤：dsh-plugin-manager 要 execa@^10.0.0）——
   *      快照里根本没有这个包，反向面看不见"缺席"；
   *   ② **住 packages/ 之外、却被 packages/ 内包依赖**的 @deepseek-ai 包（实锤：dsh-office-to-pdf
   *      要 @deepseek-ai/libreoffice-kit）——同样是不在场；
   *   ③ vendorTop 的**版本**没跟上游抬（实锤：@deepseek-ai/cosmokit 钉 1.8.3，rc.1 要 createVolatile
   *      ⇒ 必须 1.8.4+）——包在场、版本也"登记一致"，但依赖方要的符号不存在。
   * 三类的设备后果都是 boot 阶段硬崩（ERR_MODULE_NOT_FOUND / missing export），
   * 而**本地门禁全绿**：所有判据都只读登记表，没人读"上游声明的依赖有没有被满足"。
   *
   * 判据：快照内每个**上游包**（@deepseek-ai/* 与登记过的 vendor）声明的**运行时 dependencies**
   * 必须能在快照内解析到（或在运行时豁免表里显式登记）。缺口逐条列出**引用者**，
   * 逼一次显式裁决——不许再靠"没看见"通过。
   */
  // 行面：从快照里的三份 cordis.patch.yml 解析出「真会被 import」的包名
  const mounted = new Set()
  const rowSources = res.rowFiles ?? {}
  let mountFilesRead = 0
  for (const path of ROW_FILES) {
    const text = rowSources[path]
    if (typeof text !== 'string') continue
    mountFilesRead++
    for (const n of mountedRowNames(text)) mounted.add(n)
  }
  // 行面必须都读到（缺文件 = 判据空转，比判红更危险）
  if (mountFilesRead !== ROW_FILES.length) {
    fails.push('行面文件未全部取到（' + mountFilesRead + '/' + ROW_FILES.length + '）——正向闭包判据会空转')
  }
  /* 行面来源（0.14.6 实测）：mounted 取自 ROW_FILES 三份 cordis.patch.yml（dsh-base / dsh-web-app / profile web）。
   * 下一个人若要**离线**复算引用链，注意真实链可能与手推不符：实测 regexpp 的真实链是
   * `@deepseek-ai/dsh-plugin-manager -> @deepseek-ai/dsh-app-boot -> @eslint-community/regexpp`
   * （引进来的是 dsh-plugin-manager 这条挂载行，不是 dsh-web-app），以本门禁打印的链为准。
   *
   * 0.14.6（otel 设备实锤）：本判据原为**一层**——只断言挂载包自己声明的直接运行时依赖在场。
   * 一层判据挡不住「本体的传递依赖缺席」：got 本体已登记并在场，got 自己的 12 条 dependencies
   * 全部不在树里 ⇒ 一层判据恒绿。设备后果：dsh-otel 顶部静态 import got 在
   * got/dist/source/create.js 处 ERR_MODULE_NOT_FOUND ⇒ dsh-otel 整条 failed to import ⇒
   * session-telemetry-otel pending(waiting for service: otel) ⇒ engine.log "2 entries did not activate"，
   * 而本地门禁 412 条断言**全绿**（重构前实测：正向闭包缺口 0 但 PASSED）。
   * 现改为**传递闭包（BFS）**：从行面出发逐层要求在场，缺口逐条列出**完整引用链**
   * （行面 -> … -> 缺的包），逼一次显式裁决。引用链是本改造的全部价值：它把「谁把这条依赖引进来的」
   * 直接写在失败输出里，排障者不必再手推闭包。 */
  // Telemetry uses exact experimental SDK versions; package presence is insufficient.
  const telemetryRoots = ['@deepseek-ai/dsh-otel', '@deepseek-ai/dsh-session-telemetry-otel']
    .filter(name => mounted.has(name))
    .map(name => NM + 'node_modules/' + name + '/package.json')
  for (const gap of exactRuntimeDependencyGaps(present, telemetryRoots)) {
    fails.push('[telemetry-runtime] ' + gap.consumer + ' requires ' + gap.dependency + '@' + gap.required
      + ', resolved ' + (gap.actual ?? 'missing') + ' at ' + (gap.resolved ?? 'no package'))
  }
  const runtimeGaps = new Map()
  const closureReached = new Set()
  {
    const queue = []
    for (const name of mounted) {
      if (closureReached.has(name)) continue
      closureReached.add(name)
      if (byName.has(name)) queue.push({ name, chain: [name] })
    }
    while (queue.length > 0) {
      const { name, chain } = queue.shift()
      for (const dep of byName.get(name)?.runtimeDeps ?? []) {
        const next = chain.concat(dep)
        if (byName.has(dep)) {
          if (closureReached.has(dep)) continue
          closureReached.add(dep)
          queue.push({ name: dep, chain: next })
          continue
        }
        if (RUNTIME_MISSING_OK.has(dep)) continue
        if (!runtimeGaps.has(dep)) runtimeGaps.set(dep, [])
        // 每条链都记下来（同一条缺席依赖可能由多条行面路径引入）；显示面有界，故封顶 4 条。
        const chains = runtimeGaps.get(dep)
        if (chains.length < 4) chains.push(next.join(' -> '))
      }
    }
  }
  console.log('  正向闭包：行面 ' + mountFilesRead + ' 文件 / 挂载点 ' + mounted.size + ' 个'
    + ' / 传递可达 ' + closureReached.size + ' / 运行时依赖缺口 ' + runtimeGaps.size)
  // 自证（0.14.6 防判据空转）：传递闭包必须真的**往下走过层**——可达集不大于挂载点就说明
  // 快照包元数据或行面解析退化了，本判据在空转。空转比判红更危险：它会安静地放过同一形态的下一次。
  if (closureReached.size <= mounted.size) {
    fails.push('正向闭包判据疑似空转：传递可达 ' + closureReached.size + ' 不大于挂载点 ' + mounted.size
      + '——快照包元数据（runtimeDeps）或行面解析已退化，本判据没有真正走传递层')
  }
  if (runtimeGaps.size > 0) {
    for (const [dep, chains] of [...runtimeGaps.entries()].sort()) {
      console.log('    ' + dep + '  <- ' + chains.slice(0, 3).join('  |  ') + (chains.length > 3 ? ' 等 ' + chains.length + ' 条链' : ''))
    }
    fails.push('行面（会被挂载的包）的**传递**运行时依赖在快照内不可解析 ' + runtimeGaps.size + ' 条（见上方引用链）'
      + '——登记进 engine-overlay.json 的 packages/vendorTop（含全部传递依赖），'
      + '或在 check-engine-overlay.mjs 的 RUNTIME_MISSING_OK 里显式豁免并给理由。'
      + '历史教训：execa / @deepseek-ai/libreoffice-kit / cosmokit@1.8.3 都是这么漏的，'
      + '0.14.6 又添一例（got 本体在场、12 条传递依赖全缺 ⇒ 设备 dsh-otel failed to import 而门禁全绿）。'
      + '（未挂载的实验性 provider 不在本判据内——它们缺依赖不影响 boot，对它们判红是假红。）')
  }
  checked += 0
  console.log('  反向面：快照内 ' + byName.size + ' 包 / 登记 ' + declared.size + ' / 依赖闭包可达 ' + reached.size
    + ' / 无来源 ' + unaccounted.length)
  // 根安装集断言（防「删登记项靠闭包兜住」）：dsh 根 package.json 的每个直接依赖都必须**逐条登记**
  // （版本钉面）或在 extraPresent 里显式声明——从 overlay 表删一个根依赖即红。
  const rootMeta = present[NM + 'package.json']
  const rootDeps = rootMeta?.deps ?? []
  // 声明但不安装的直接依赖（每条都带上游依据）。**两向判定**：
  //   ① 未登记且不在此表 ⇒ 判红（版本钉缺失，本条原有语义不变）；
  //   ② 在此表但快照里**真的存在** ⇒ 也判红（install 面已变，豁免过期，必须删条目而不是留着洗绿）。
  const uninstalled = new Map((M.uninstalledRootDeps ?? []).map((e) => [e.name, e]))
  const rootUnpinned = rootDeps.filter((n) => !declared.has(n) && !uninstalled.has(n)).sort()
  console.log('  根安装集：直接依赖 ' + rootDeps.length + ' 条 / 未登记 ' + rootUnpinned.length
    + ' / 声明但不安装 ' + uninstalled.size)
  if (rootUnpinned.length > 0) {
    fails.push('dsh 根直接依赖未登记（版本钉缺失）' + rootUnpinned.length + ' 个: [' + rootUnpinned.slice(0, 8).join(', ') + ']')
  }
  for (const [name, entry] of uninstalled) {
    if (rootDeps.includes(name) === false) {
      fails.push('uninstalledRootDeps 条目 "' + name + '" 已不是 dsh 根直接依赖——上游已改，请删掉该条目')
      continue
    }
    if (byName.has(name)) {
      fails.push('uninstalledRootDeps 条目 "' + name + '" 在快照里**确实存在**——声明与实况矛盾，'
        + '该包已进安装面：请改为登记进 packages 并删除本条豁免')
      continue
    }
    console.log('    [未安装] ' + name + '（上游依据：' + String(entry.reason).slice(0, 40) + '…）')
  }
  if (unaccounted.length > 0) {
    fails.push('未登记且依赖闭包不可达的包 ' + unaccounted.length + ' 个: [' + unaccounted.slice(0, 5).join(', ') + ']'
      + '——若为上游新增依赖请登记进 engine-overlay.json，若是被塞入的包请移除')
  }
}
CARRIERS.forEach((c, idx) => {
  const count = res.carriers?.[idx] ?? 0
  if (count < 1) fails.push(`内置预设载体为空：${c.label} 命中 ${count} 项（包在但内容没发布 = 上游 files 漏项，产品面「没有可用预设」）`)
  else console.log(`  预设载体 ${c.label}: ${count} 项`)
})

// ── 基座残留剔除的反向断言（0.14.2）：slim.json 声明「已剔掉」的包必须真的不在树里 ──
// 与构建期的剔除步互为镜像：清单说了不算，产物说了算。剔除步失效（基座换代 / 路径变更）时
// 这里判红，而不是让死代码悄悄回流每个快照。
{
  const stale = (JSON.parse(readFileSync(join(HERE, 'snapshot-config', 'slim.json'), 'utf8')).engineStalePackages ?? [])
  const present = res.present ?? {}
  const names = new Set(Object.values(present).map((m) => m?.name).filter(Boolean))
  for (const entry of stale) {
    if (names.has(entry.name)) {
      fails.push(`基座残留未剔除: ${entry.name}——slim.json 声明要删，快照里却还在（剔除步未生效或基座换代）`)
    }
  }
  if (stale.length) console.log(`  基座残留反向断言：${stale.length} 条声明已逐条核验（在树即红）`)
}

if (fails.length) {
  console.error(`ENGINE-OVERLAY CHECK FAILED（${fails.length} 项）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`ENGINE-OVERLAY CHECK PASSED（${checked} 包版本断言 + presets 在场；引擎 ${M.engineVersion}）`)
