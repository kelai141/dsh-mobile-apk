#!/usr/bin/env node
/**
 * farm-link-idempotency.test.mjs — profile 共享农场建链的**幂等性单元证明**
 *
 * 为什么需要它：`build-snapshot-013.mjs` 每次构建都先 `rm -rf stage`（L106），
 * 所以「连跑两次构建观察 kept=1」这个观测点**在构建层根本不存在**——第二次跑时
 * stage 已被删，链必然重建（made=1）。幂等的观测点在**建链逻辑本身**，不在构建流程。
 *
 * 这里把 build-snapshot-013.mjs 的 farm 段原样复刻成小函数，在 mkdtemp 假树上跑两遍：
 *   ① 第一次 made=1 / kept=0，且 readlink(link) === want；
 *   ② 第二次 made=0 / kept=1；
 *   ③ **反证**：把建链改回宿主绝对路径（wslPath(target) 的等价物）→ 第二次必然 kept=0，
 *      因为 readlink（绝对）!== want（相对）。这正是修前「kept 恒 0」的硬证据。
 *
 * 用法：node scripts/farm-link-idempotency.test.mjs
 * 退出码：0=全过；1=有断言失败。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const PKG = 'undici'
const ENGINE_REL = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/' + PKG

/* Windows 无「创建符号链接」权限时 symlinkSync 会 EPERM（本机实测）。
 * 这里做**最小降级**：真链接可用就用真链接；不可用则用内存表模拟 link→target 映射，
 * 语义等价（判据只依赖「读回的字符串」与相对/绝对之别），并打印 NOTE 说明。 */
const MEM = new Map()
let useMem = false
let modeReported = false
function trySymlink(target, link) {
  if (useMem) { MEM.set(link, target); return }
  try { symlinkSync(target, link) } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      useMem = true
      console.log('  MODE  内存模型（本机 symlinkSync 不可用：' + e.code + '）—— CI/Linux 上会走真链接')
      MEM.set(link, target)
      return
    }
    throw e
  }
}
function tryReadlink(link) {
  if (useMem) {
    if (!MEM.has(link)) { const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err }
    return MEM.get(link)
  }
  return readlinkSync(link)
}
function tryUnlink(link) {
  if (useMem) { MEM.delete(link); return }
  rmSync(link, { force: true })
}

/**
 * build-snapshot-013.mjs 的 farm 段复刻。
 * @param stage - 假 stage 根
 * @param opts.useAbsolute - true = 修前的错误写法（用宿主绝对路径建链）
 * @returns {{made:number, kept:number}}
 */
function farmStep(stage, { useAbsolute = false } = {}) {
  const farm = join(stage, 'home', '.dsh', 'profiles', 'node_modules')
  const target = join(stage, ENGINE_REL)          // 绝对 stage 路径（与构建器同形）
  const want = relative(farm, target)             // 应有的相对目标
  let made = 0
  let kept = 0
  const link = join(farm, PKG)
  let ok = false
  try { ok = tryReadlink(link) === want } catch { /* 缺席 */ }
  if (ok) return { made: 0, kept: 1 }
  try { tryUnlink(link) } catch { /* ignore */ }
  // 修法：用 want（相对）；修前：用 target（绝对宿主路径）
  trySymlink(useAbsolute ? target : want, link)
  made += 1
  return { made, kept }
}

const root = mkdtempSync(join(tmpdir(), 'farm-idem-'))
try {
  const stage = join(root, 'stage')
  mkdirSync(join(stage, ENGINE_REL), { recursive: true })
  writeFileSync(join(stage, ENGINE_REL, 'package.json'), '{"name":"undici","version":"8.11.2"}')
  mkdirSync(join(stage, 'home', '.dsh', 'profiles', 'node_modules'), { recursive: true })

  const farm = join(stage, 'home', '.dsh', 'profiles', 'node_modules')
  const target = join(stage, ENGINE_REL)
  const want = relative(farm, target)
  const link = join(farm, PKG)

  // ① 第一次：建链
  const r1 = farmStep(stage)
  assert.equal(r1.made, 1, '第一次必须建链')
  assert.equal(r1.kept, 0, '第一次不应命中已就位')
  assert.equal(tryReadlink(link), want, '链目标必须等于 want（相对路径）')
  console.log('  MODE  本次 link 载体 = ' + (useMem ? '内存模型（symlink 不可用）' : '真实符号链接（symlinkSync/readlinkSync）'))
  console.log('  PASS  ① 第一次 made=1 kept=0，readlink === want（' + want + '）')

  // ② 第二次：幂等命中
  const r2 = farmStep(stage)
  assert.equal(r2.made, 0, '第二次不应重建')
  assert.equal(r2.kept, 1, '第二次必须命中已就位')
  console.log('  PASS  ② 第二次 made=0 kept=1（幂等）')

  // ③ 反证：修前的绝对路径写法 → 第二次 kept 必然 0
  tryUnlink(link)
  const b1 = farmStep(stage, { useAbsolute: true })
  assert.equal(b1.made, 1, '修前写法第一次也建链')
  assert.notEqual(tryReadlink(link), want, '修前写法 readlink 是绝对路径，不等于 want')
  const b2 = farmStep(stage, { useAbsolute: true })
  assert.equal(b2.kept, 0, '修前写法第二次必然 kept=0（readlink !== want）')
  assert.equal(b2.made, 1, '修前写法每次都重建')
  console.log('  PASS  ③ 反证：绝对宿主路径写法下 kept 恒 0（readlink !== want）')

  console.log('FARM-LINK-IDEMPOTENCY PASSED（3 项）')
} finally {
  rmSync(root, { recursive: true, force: true })
}
