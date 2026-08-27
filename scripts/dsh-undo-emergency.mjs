// dsh-undo-emergency.mjs — dsh-undo-savepoint 安卓急救命令行（PRD D6 方案 a）
// 与引擎平级：运行在 Termux 运行时（引擎同款 node）内，即使 DSH 完全起不来也可执行
// 等价撤销/安全模式/回退。快照格式与 dsh-undo-savepoint 插件/工具完全一致
// （manifest.json + files[] + content-addressed blobs + safe-mode 备份状态）。
//
// 用法：
//   node dsh-undo-emergency.mjs list                       列出全部快照
//   node dsh-undo-emergency.mjs restore <id|latest>         恢复到指定快照
//   node dsh-undo-emergency.mjs restore-last-good           恢复 crash 归因得出的最后良好快照
//   node dsh-undo-emergency.mjs undo                        撤销上一次自动快照（等价 restore auto-latest）
//   node dsh-undo-emergency.mjs safe-mode on|off|status     安全模式：on=仅 dsh-undo 可启动的最小装配
//   node dsh-undo-emergency.mjs boot-state                  显示插件崩溃归因状态（crashed/lastGoodAt/crashReason）
//
// 环境变量：DSH_HOME（默认 ~/.dsh）｜DSH_UNDO_ROOT（默认 $DSH_HOME/undo-snapshots）
//          DSH_UNDO_PROFILE（默认 web；scoped 存储 <root>/<profile>/ 优先，兼容 flat 旧库）
// 安全边界：本工具只写配置文件与插件代码树（同快照范围），不触碰用户数据目录
// （sessions/storages/凭据真实值）；敏感文件快照为脱敏副本，真实值在本机 vault 中，
// 恢复时优先从 vault 取真实值（与插件 applySnapshot 语义一致），vault 缺失才写占位。
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, cpSync } from 'node:fs'
import { join, basename, dirname, sep, resolve } from 'node:path'
import { homedir } from 'node:os'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const UNDO_ROOT = process.env.DSH_UNDO_ROOT || join(DSH_HOME, 'undo-snapshots')
const PROFILE = process.env.DSH_UNDO_PROFILE || 'web'
const PROFILE_ROOT = join(DSH_HOME, 'profiles', PROFILE)

function storeDirs() {
  const scoped = join(UNDO_ROOT, PROFILE)
  const scopedExists = existsSync(join(scoped, 'manual')) || existsSync(join(scoped, 'auto'))
  const flat = existsSync(join(UNDO_ROOT, 'manual')) || existsSync(join(UNDO_ROOT, 'auto'))
  if (scopedExists && !flat) return { root: scoped, blobs: join(scoped, 'blobs') }
  // 两种都存在时 scoped 优先（新布局），blobs 在各自根下
  if (scopedExists || !flat) return { root: scoped, blobs: join(scoped, 'blobs'), scoped: true }
  return { root: UNDO_ROOT, blobs: join(UNDO_ROOT, 'blobs'), scoped: false }
}

function listSnapshots() {
  const { root } = storeDirs()
  const out = []
  for (const kind of ['auto', 'manual']) {
    const dir = join(root, kind)
    if (!existsSync(dir)) continue
    for (const id of readdirSync(dir)) {
      const mf = join(dir, id, 'manifest.json')
      if (!existsSync(mf)) continue
      try {
        const m = JSON.parse(readFileSync(mf, 'utf8'))
        out.push({ id, kind, time: m.time, reason: m.reason ?? '', files: (m.files ?? []).length, plugins: (m.plugins ?? []).length })
      } catch (e) {
        out.push({ id, kind, error: 'manifest 读取失败' })
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : -1))
}

function destToTarget(name) {
  // name: 'profile-cordis.patch.yml' / 'home-settings.yaml'（路径分隔符已被 - 化）
  if (name.startsWith('profile-')) {
    const rel = name.slice('profile-'.length)
    return join(PROFILE_ROOT, rel)
  }
  if (name.startsWith('home-')) {
    return join(DSH_HOME, name.slice('home-'.length))
  }
  return null
}

/** 读取插件崩溃归因状态（auto/boot-state.json），读不到返回 null。 */
function readBootState() {
  const { root } = storeDirs()
  const p = join(root, 'auto', 'boot-state.json')
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

/**
 * 最后良好快照（对齐插件 lastGoodSnapshot，v0.3 模块 3 语义）：
 * 时间不晚于 lastGoodAt 的最新非 pre-restore 快照。
 * boot-state.json 缺失时直接取最新 auto（退化语义，等价旧版 undo）。
 */
function lastGoodSnapshot() {
  const boots = readBootState()
  const at = boots?.lastGoodAt
  const t = typeof at === 'string' ? Date.parse(at) : NaN
  const snaps = listSnapshots().filter((s) => s.kind === 'auto' && !s.error)
  if (Number.isNaN(t)) return { snap: snaps[0] ?? null, source: 'fallback-latest' }
  const good = snaps.find((s) => (s.time ? Date.parse(s.time) : NaN) <= t)
  return { snap: good ?? null, source: 'lastGoodAt' }
}

/** vault 真实值查表：<autoDir>/env-vault/<sha1>.env（与插件 readVault 同布局）。 */
function readVaultFile(sha1) {
  const { root } = storeDirs()
  const p = join(root, 'auto', 'env-vault', `${sha1}.env`)
  if (!existsSync(p)) return null
  try { return readFileSync(p) } catch { return null }
}

/** 从快照恢复：配置文件 + 插件代码树（blob 解引用，跨机安全：dir 取 node_modules 后相对段） */
function restore(idOrLatest, { pretend = false } = {}) {
  const { root, blobs } = storeDirs()
  const snaps = listSnapshots()
  const target = idOrLatest === 'latest'
    ? snaps.find((s) => s.kind === 'auto')
    : snaps.find((s) => s.id === idOrLatest)
  if (!target) {
    console.log(`未找到快照 '${idOrLatest}'（可用：${snaps[0]?.id ?? '无'}）`)
    return false
  }
  const snapDir = join(root, target.kind, target.id)
  const m = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'))
  console.log(`恢复快照 ${target.id}（${target.kind}，${m.reason ?? '无原因'}）`)
  let restored = 0
  for (const f of m.files ?? []) {
    const dest = destToTarget(f.name)
    if (!dest) { console.log(`  跳过（未知目标）${f.name}`); continue }
    const src = join(snapDir, f.name)
    if (!existsSync(src)) { console.log(`  跳过（快照缺文件）${f.name}`); continue }
    // 敏感文件：vault 有真实值 → 完整还原（本机）；缺 → 写脱敏占位并提示
    let buf = readFileSync(src)
    let sensitiveNote = ''
    if (/^home-\.env$|^profile-\.env$|^home-\.credentials\.yaml$/.test(f.name)) {
      const ref = m.envVaultRefs?.[f.name]
      if (typeof ref === 'string' && ref !== '') {
        const real = readVaultFile(ref)
        if (real !== null) buf = real
        else sensitiveNote = `  ⚠️ vault 缺失：${f.name} 写入脱敏占位（请手动补真实值）`
      } else if (m.sensitiveMode === 'redact') {
        sensitiveNote = `  ⚠️ 快照本身脱敏：${f.name} 写入脱敏占位（请手动补真实值）`
      }
    }
    if (!pretend) {
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, buf)
    }
    console.log(`  ${f.name} -> ${dest}${sensitiveNote}`)
    restored++
  }
  for (const p of m.plugins ?? []) {
    const nmIdx = p.dir?.split(sep).lastIndexOf('node_modules')
    const relNm = nmIdx >= 0 ? p.dir.split(sep).slice(nmIdx + 1).join(sep) : p.name
    const pkgDir = join(PROFILE_ROOT, 'node_modules', relNm)
    for (const f of p.files ?? []) {
      const blob = join(blobs, f.hash)
      if (!existsSync(blob)) { console.log(`  blob 缺失 ${f.hash.slice(0, 8)}（${p.name} ${f.path}）`); continue }
      const dest = join(pkgDir, f.path)
      if (!pretend) {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(blob, dest)
      }
      console.log(`  [插件] ${p.name} ${f.path} -> ${dest}`)
      restored++
    }
  }
  for (const f of m.profileFiles ?? []) {
    const blob = join(blobs, f.hash)
    if (!existsSync(blob)) continue
    const rel = f.path.startsWith('./') ? f.path.slice(2) : f.path
    const dest = join(PROFILE_ROOT, rel)
    if (!pretend) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(blob, dest) }
    console.log(`  [profile] ${rel} -> ${dest}`)
    restored++
  }
  console.log(`完成：还原 ${restored} 项。重启 DSH（壳应用重启引擎）后生效。`)
  return true
}

/** restore-last-good：boot-state.json 归因 → 最后良好快照 → 恢复。 */
function restoreLastGood({ pretend = false } = {}) {
  const { snap, source } = lastGoodSnapshot()
  boots = readBootState()
  if (!snap) {
    console.log('无可用最后良好快照（boot-state=' + JSON.stringify(boots ?? {}) + '）')
    return false
  }
  console.log(`目标快照来源：${source}${source === 'lastGoodAt' ? `（lastGoodAt=${boots?.lastGoodAt}）` : ''}`)
  return restore(snap.id, { pretend })
}

function safeMode(action) {
  const { root } = storeDirs()
  const autoDir = join(root, 'auto')
  // 与插件一致的状态文件名（v0.3 插件用 safe-mode.json；旧急救 CLI 误用
  // safe-mode-state.json 造成两侧状态互相不可见）
  const stateFile = join(autoDir, 'safe-mode.json')
  const patch = join(PROFILE_ROOT, 'cordis.patch.yml')
  const homePatch = join(DSH_HOME, 'cordis.patch.yml')
  const id = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-' + Math.random().toString(16).slice(2, 6)
  if (action === 'on') {
    const prev = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
    if (prev?.active) {
      console.log('安全模式已在开启状态')
      return true
    }
    mkdirSync(autoDir, { recursive: true })
    const backup = join(autoDir, `safe-mode-backup-${id}.yml`)
    const homeBackup = join(autoDir, `safe-mode-home-backup-${id}.yml`)
    // 兼容旧急救 CLI 写的 safe-mode-state.json：迁移到插件同名文件
    const legacy = join(autoDir, 'safe-mode-state.json')
    if (existsSync(legacy) && !existsSync(stateFile)) {
      try { copyFileSync(legacy, stateFile) } catch { /* 忽略 */ }
    }
    // 先做变更前建档（等价 Windows 版 pre-snapshot）
    createManifestSnapshot('safe-mode-before')
    if (existsSync(patch)) copyFileSync(patch, backup)
    else writeFileSync(backup, '[]\n')
    const homeExisted = existsSync(homePatch)
    if (homeExisted) copyFileSync(homePatch, homeBackup)
    if (!existsSync(backup)) { console.log('安全模式备份写入失败，拒绝进入'); return false }
    const minimal = `# dsh-undo-savepoint SAFE MODE (entered ${new Date().toISOString()})\n# 除 dsh-undo-savepoint 外全部插件临时禁用。\n- insert:\n    - id: dsh-undo-savepoint\n      name: dsh-undo-savepoint\n`
    mkdirSync(PROFILE_ROOT, { recursive: true })
    writeFileSync(patch, minimal)
    if (homeExisted) writeFileSync(homePatch, '# dsh-undo-savepoint SAFE MODE (home level)\n[]\n')
    writeFileSync(stateFile, JSON.stringify({ active: true, enteredAt: new Date().toISOString(), backup, homeBackup, snapshotId: id, homeExisted }, null, 2))
    rmSync(legacy, { force: true })
    console.log(`安全模式 ON（建档 ${id}）。重启 DSH 将以最小插件装配启动。`)
    return true
  }
  if (action === 'off') {
    if (!existsSync(stateFile)) { console.log('安全模式未开启'); return true }
    const st = JSON.parse(readFileSync(stateFile, 'utf8'))
    if (existsSync(st.backup)) copyFileSync(st.backup, patch)
    if (st.homeExisted && existsSync(st.homeBackup)) copyFileSync(st.homeBackup, homePatch)
    rmSync(stateFile, { force: true })
    console.log('安全模式 OFF：已还原 patch（重启 DSH 恢复完整插件）')
    return true
  }
  if (action === 'status') {
    if (existsSync(stateFile)) {
      const st = JSON.parse(readFileSync(stateFile, 'utf8'))
      console.log(`安全模式：开启中（进入于 ${st.enteredAt}）`)
    } else {
      console.log('安全模式：未开启')
    }
    return true
  }
  console.log('safe-mode 用法：node dsh-undo-emergency.mjs safe-mode on|off|status')
  return false
}

function createManifestSnapshot(reason) {
  // 与插件一致的最小建档：profile/home 配置文件的现价拷贝（不建插件树 blob，避免重复实现；
  // 完整快照由插件在 DSH 可启动时生成；本工具保住"回退入口"而非"全量备份"）。
  const { root } = storeDirs()
  const dir = join(root, 'manual', 'emg-' + new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14) + '-0000')
  mkdirSync(dir, { recursive: true })
  const files = []
  const spec = [
    ['profile', 'cordis.patch.yml'], ['profile', 'package.json'], ['profile', 'cordis.yml'],
    ['profile', 'pnpm-workspace.yaml'], ['profile', 'pnpm-lock.yaml'],
    ['home', 'cordis.patch.yml'], ['home', 'settings.yaml'],
  ]
  for (const [rootKey, rel] of spec) {
    const src = rootKey === 'profile' ? join(PROFILE_ROOT, rel) : join(DSH_HOME, rel)
    if (!existsSync(src)) continue
    const destName = `${rootKey}-${rel.replaceAll('/', '-')}`
    copyFileSync(src, join(dir, destName))
    files.push({ name: destName, size: 0 })
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: basename(dir), time: new Date().toISOString(), kind: 'manual', reason, files, plugins: [], profileFiles: [], sensitiveMode: 'redact', redacted: [], envVaultRefs: {} }, null, 2))
  return basename(dir)
}

let boots = null
const [cmd, arg] = process.argv.slice(2)
if (!cmd) {
  console.log(`用法：node dsh-undo-emergency.mjs <list|restore <id|latest>|restore-last-good|undo|safe-mode on|off|status|boot-state>
DSH_HOME=${DSH_HOME} / 存储=${UNDO_ROOT} / 档案=${PROFILE}`)
  process.exit(1)
}
let ok = false
switch (cmd) {
  case 'list': {
    const snaps = listSnapshots()
    if (!snaps.length) console.log('暂无快照。')
    for (const s of snaps) {
      console.log(`${s.id}  [${s.kind}]  ${s.time ?? ''}  ${s.reason ?? ''}${s.error ? '（' + s.error + '）' : ''}  文件${s.files} 插件${s.plugins}`)
    }
    ok = true
    break
  }
  case 'restore': ok = restore(arg || 'latest'); break
  case 'restore-last-good': ok = restoreLastGood(); break
  case 'undo': ok = restore('latest'); break
  case 'boot-state': {
    const s = readBootState()
    console.log(s ? JSON.stringify(s, null, 2) : 'boot-state.json 不存在（插件尚未启动过或快照为空）')
    ok = true
    break
  }
  case 'safe-mode': ok = safeMode(arg ?? 'status'); break
  default: console.log('未知命令：' + cmd)
}
process.exit(ok ? 0 : 1)
