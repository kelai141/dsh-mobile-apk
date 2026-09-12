#!/usr/bin/env node
// check-strip-noop.mjs — 剥离清单后置断言（0.13.8-b ST-16 / 坑：剥离步骤静默 no-op）。
//
// 背景：`build-snapshot-013.mjs` 的剥离步骤按 `scripts/snapshot-config/strip.json` 删三类东西
// （secretLeaves / stalePnpmState / runtimeDirs）。此前**没有任何断言证明剥离真的发生了**：清单写错键名、
// 路径前缀漂移、或剥离后又被后续步骤写回，都会让机密/陈旧状态随快照出厂而无人知。
//
// 断言（两种输入模式二选一）：
//   A. `--stage <stageRoot>`（构建期，剥离步骤紧后）：清单项在 stage 树里必须**不存在**；
//      且 `home/.dsh/settings.yaml` 必须在场（锚点：证明这不是「DH 整个没合并」造成的空树假绿）。
//   B. `<tar.xz>`（产物期）：清单项在归档成员里必须不存在（同一断言，作用于最终产物）。
//   C. `--base <base-dsh.tar.xz>`（可选，反 no-op 强化）：清单项**在基座里存在**的那些，在输出里必须消失
//      （证明剥离动作真的命中过，而不是清单与基座都对不上）。
//
// 用法：node scripts/check-strip-noop.mjs <tar.xz> [--base <base-dsh.tar.xz>]
//       node scripts/check-strip-noop.mjs --stage <stageRoot> [--base <base-dsh.tar.xz>]
// 退出码：0 = 通过；1 = 清单项仍在场 / 锚点缺席 / 反 no-op 未命中；2 = 用法或输入不可读。
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const stage = argOf('stage', null)
const base = argOf('base', null)
const tar = argv.find((a) => !a.startsWith('--') && a !== stage && a !== base)
if (!argv.includes('--self-test') && ((!stage && !tar) || (stage && !existsSync(stage)))) {
  console.error('用法: node scripts/check-strip-noop.mjs <tar.xz> [--base <base-dsh.tar.xz>] 或 --stage <stageRoot> [--base ...]')
  process.exit(2)
}

// --self-test：自包含两向验证（临时 tar + 临时 stage，不碰仓库）。发布链/构建链用正式模式。
if (process.argv.includes('--self-test')) {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const tmp = mkdtempSync(join(tmpdir(), 'strip-self-'))
  const mkTar = (name, members) => {
    const dir = join(tmp, name)
    for (const rel of members) {
      const p = join(dir, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'x')
    }
    const tarPath = join(tmp, name + '.tar')
    execFileSync('tar', ['-cf', tarPath, '-C', dir, 'home'])
    return tarPath
  }
  const clean = mkTar('clean', ['home/.dsh/settings.yaml'])
  const dirty = mkTar('dirty', ['home/.dsh/settings.yaml', 'home/.dsh/attachments/leak.txt'])
  const cleanRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url), clean], { encoding: 'utf8' })
  const dirtyRun = spawnSync(process.execPath, [fileURLToPath(import.meta.url), dirty], { encoding: 'utf8' })
  const ok = cleanRun.status === 0 && dirtyRun.status === 1 && dirtyRun.stdout.includes('attachments')
  console.log((ok ? 'STRIP-NOOP SELF-TEST PASSED' : 'STRIP-NOOP SELF-TEST FAILED')
    + '（干净 tar exit=' + cleanRun.status + ' 期望 0；含 attachments 泄漏的 tar exit=' + dirtyRun.status + ' 期望 1）')
  if (!ok) console.log((dirtyRun.stdout + dirtyRun.stderr).slice(0, 300))
  rmSync(tmp, { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}

const strip = JSON.parse(readFileSync(join(ROOT, 'scripts', 'snapshot-config', 'strip.json'), 'utf8'))
const failures = []
let checked = 0
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

/** 待断言条目：{ 类别, 逻辑路径（相对 home/.dsh）, 是否目录 }。 */
const items = [
  ...(strip.secretLeaves ?? []).map((p) => ({ kind: 'secretLeaves', rel: p, dir: false })),
  ...(strip.stalePnpmState ?? []).map((p) => ({ kind: 'stalePnpmState', rel: p, dir: false })),
  ...(strip.runtimeDirs ?? []).map((p) => ({ kind: 'runtimeDirs', rel: p.replace(/\/$/, ''), dir: true })),
]
if (items.length === 0) { console.error('CHECK-STRIP-NOOP FAILED：strip.json 清单为空（清单失效？）'); process.exit(1) }

// 输入抽象：stage 树 → 文件系统；tar → 成员集合
let tarEntries = null
if (tar) {
  try { tarEntries = new Set(execFileSync('tar', ['-tf', tar], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\n').map((s) => s.trim()).filter(Boolean)) }
  catch (e) { console.error('CHECK-STRIP-NOOP FAILED：tar 不可读（' + e.message + '）'); process.exit(2) }
}
const stripPrefix = 'home/.dsh/'
const present = (rel, dir) => {
  if (tarEntries) {
    const full = stripPrefix + rel
    return dir ? [...tarEntries].some((e) => e === full || e.startsWith(full + '/'))
      : tarEntries.has(full) || [...tarEntries].some((e) => e.startsWith(full + '/'))
  }
  const p = join(stage, 'home', '.dsh', rel)
  return existsSync(p)
}

for (const it of items) {
  checked += 1
  check('清单项已剥离（' + it.kind + '）: home/.dsh/' + it.rel, !present(it.rel, it.dir), '仍在场 —— 剥离步骤未命中清单（键名/前缀漂移？）')
}

// 锚点：settings.yaml 必须在场（防「DH 整树缺席」造成的空树假绿）
if (tarEntries) check('锚点 home/.dsh/settings.yaml 在场', tarEntries.has('home/.dsh/settings.yaml'))
else check('锚点 home/.dsh/settings.yaml 在场', existsSync(join(stage, 'home', '.dsh', 'settings.yaml')))

// 反 no-op：基座里存在的条目，输出里必须消失
if (base) {
  if (!existsSync(base)) { check('--base 可读: ' + base, false); } else {
    let baseEntries
    try { baseEntries = new Set(execFileSync('tar', ['-tf', base], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).split('\n').map((s) => s.trim()).filter(Boolean)) }
    catch (e) { check('--base 可读: ' + base, false, e.message); baseEntries = new Set() }
    const inBase = (rel, dir) => {
      const full = stripPrefix + rel
      return dir ? [...baseEntries].some((e) => e === full || e.startsWith(full + '/'))
        : baseEntries.has(full) || [...baseEntries].some((e) => e.startsWith(full + '/'))
    }
    const hit = items.filter((it) => inBase(it.rel, it.dir))
    check('反 no-op：基座里至少有清单项命中（' + hit.length + '/' + items.length + '）', hit.length > 0,
      '基座里一条都不存在 —— 清单与基座对不上（键名/前缀漂移），剥离断言形同虚设')
    for (const it of hit) check('反 no-op：' + it.kind + ' ' + it.rel + ' 在输出里消失', !present(it.rel, it.dir))
  }
}

if (failures.length > 0) {
  console.error('CHECK-STRIP-NOOP FAILED（' + failures.length + ' 项，核对 ' + checked + ' 条清单项）：' + failures.slice(0, 5).join('；'))
  process.exit(1)
}
console.log('CHECK-STRIP-NOOP PASSED（' + checked + ' 条清单项均不在场' + (base ? '，且反 no-op 命中' : '') + '）')
