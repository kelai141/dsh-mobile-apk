// vendor/dsh-undo-savepoint/test/undo-gc-busy-1590.test.mjs — blob GC 与建快照的互斥（issue #1590）。
//
// 真因：createSnapshot 的顺序是 mkdir 占位 -> 逐文件 writeBlob -> **最后**才 writeManifest。
// 中间那段「blob 已写、manifest 未写」的窗口里，该快照对 listSnapshots 不可见，
// 它的 blob 在 refs 里一个都没有 ⇒ 并行来的 undo_prune / undo_compact 把它们当孤儿删掉，
// 之后 applySnapshot 只能报 `snapshot blob missing` 跳过——安全网**静默**失效。
//
// 判据全部是行为判据（不读源码）：让 createSnapshot 停在窗口里，跑一次真实的 GC，
// 再放行建快照，检查它 manifest 里引用的每一个 blob 都还在盘上、且内容逐字节正确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'undo-1590-'))
const PLUGINS = join(ROOT, 'plugins')
const PLUGIN_DIR = join(PLUGINS, 'race-plugin')

/** 被测模块在调用时才按属性查 fs.promises，所以先装记账/闸门再 import 也有效；为稳妥两边都装。 */
const realReadFile = fs.promises.readFile
const realStat = fs.promises.stat

let gate = null
let gatedPath = null

function makeCfg(overrides = {}) {
  const base = join(ROOT, 'store-' + Math.random().toString(16).slice(2))
  const autoDir = join(base, 'auto')
  const manualDir = join(base, 'manual')
  mkdirSync(autoDir, { recursive: true })
  mkdirSync(manualDir, { recursive: true })
  return { autoDir, manualDir, suppressAuto: 0, restoredHashes: new Map(), keepAuto: 20, keepPre: 10, autoCleanup: true, profileDirs: [], profile: 'web', ...overrides }
}

/** 造一个插件目录：两个文件，够让 writeBlob 与「窗口」都发生。 */
function makePlugin() {
  mkdirSync(PLUGIN_DIR, { recursive: true })
  writeFileSync(join(PLUGIN_DIR, 'package.json'), JSON.stringify({ name: 'race-plugin', version: '1.0.0' }))
  writeFileSync(join(PLUGIN_DIR, 'a.js'), 'export const a = 1\n'.repeat(40))
  writeFileSync(join(PLUGIN_DIR, 'b.js'), 'export const b = 2\n'.repeat(40))
}
makePlugin()

const core = await import('../lib/core.mjs')

/** 在「已写至少一个 blob、manifest 还没落」的那一刻把 createSnapshot 挂住。 */
function armGateOnSecondPluginFile(blobDirPath) {
  gatedPath = join(PLUGIN_DIR, 'b.js')
  let armed = false
  fs.promises.readFile = async function (target, ...rest) {
    if (!armed && String(target) === gatedPath) {
      let haveBlob = false
      try { haveBlob = readdirSync(blobDirPath).some((n) => !n.includes('.tmp')) } catch { /* 目录还没建 */ }
      if (haveBlob) {
        armed = true
        await gate
      }
    }
    return realReadFile.call(this, target, ...rest)
  }
  return () => { fs.promises.readFile = realReadFile }
}

const blobFiles = (cfg) => {
  try { return readdirSync(join(join(cfg.autoDir, '..'), 'blobs')).filter((n) => !n.includes('.tmp')) } catch { return [] }
}

test('#1590 建快照窗口里来的 prune 不得删掉正在写的快照 blob（旧实现删完 manifest 就指向空洞）', async () => {
  const cfg = makeCfg({ pluginDirs: [PLUGIN_DIR] })
  const blobsDir = join(cfg.autoDir, '..', 'blobs')
  let release
  gate = new Promise((resolve) => { release = resolve })
  const restoreReadFile = armGateOnSecondPluginFile(blobsDir)
  try {
    const pending = core.createSnapshot(cfg, 'auto', 'race-window')
    // 等到窗口真的打开：blob 目录里已有内容，而 listSnapshots 仍看不到这份快照。
    const deadline = Date.now() + 5000
    while (blobFiles(cfg).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5))
    assert.ok(blobFiles(cfg).length > 0, '夹具没进入窗口（一个 blob 都没写出来）——判据失效')
    const visible = await core.listSnapshots(cfg)
    assert.equal(visible.length, 0, '窗口里这份快照本就不该对 listSnapshots 可见（否则本用例测的不是那个竞态）')

    // 真实的 GC 路径：pruneAuto 就是 undo_prune 工具与 /api/undo/prune 的执行体。
    await core.pruneAuto(cfg, visible)
    const survived = blobFiles(cfg).length
    assert.ok(survived > 0, 'GC 把正在写的快照 blob 删光了（这正是 issue #1590）')

    release()
    const snap = await pending
    const refs = (snap.plugins ?? []).flatMap((p) => (p.files ?? []).map((f) => f.hash))
    assert.ok(refs.length > 0, '快照没有引用任何 blob，判据失效')
    for (const hash of refs) {
      const p = join(blobsDir, hash)
      let bytes = null
      try { bytes = readFileSync(p) } catch { /* missing */ }
      assert.ok(bytes !== null, 'manifest 引用的 blob 在盘上不存在：' + hash + '（安全网已被删残）')
      assert.equal(core.sha1Hex(bytes), hash, 'blob 内容与 hash 不符：' + hash)
    }
  } finally {
    restoreReadFile()
    gate = null
    rmSync(join(cfg.autoDir, '..'), { recursive: true, force: true })
  }
})

test('#1590 跨进程写者（本进程看不见）：最近写入的 blob 必须被 GC 跳过', async () => {
  const cfg = makeCfg()
  const blobsDir = join(cfg.autoDir, '..', 'blobs')
  mkdirSync(blobsDir, { recursive: true })
  const fresh = 'fresh-blob-' + 'a'.repeat(16)
  const stale = 'stale-blob-' + 'b'.repeat(16)
  writeFileSync(join(blobsDir, fresh), Buffer.from('written by another process just now'))
  writeFileSync(join(blobsDir, stale), Buffer.from('orphan from an old prune'))
  // 只把「老」的那份推到安全窗之外；fresh 保持当前 mtime。
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
  utimesSync(join(blobsDir, stale), old, old)

  const r = await core.undoCompact(cfg)
  const left = readdirSync(blobsDir)
  assert.ok(left.includes(fresh), '刚写入的 blob 被删了（跨进程写者的快照会被删残）：' + JSON.stringify(left))
  assert.equal(left.includes(stale), false, '过期孤儿没被清掉 —— GC 变成了不做事的空实现')
  assert.equal(r.removed, 1, '应当恰好清掉 1 个过期孤儿，实得 ' + r.removed)
  rmSync(join(cfg.autoDir, '..'), { recursive: true, force: true })
})

test('#1590 restore 在飞（undoBusy）时 pruneAuto 必须整体让路，且如实报告跳过', async () => {
  const cfg = makeCfg({ undoBusy: true })
  const blobsDir = join(cfg.autoDir, '..', 'blobs')
  mkdirSync(blobsDir, { recursive: true })
  const orphan = 'orphan-' + 'c'.repeat(16)
  writeFileSync(join(blobsDir, orphan), Buffer.from('orphan'))
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
  utimesSync(join(blobsDir, orphan), old, old)

  const removed = await core.pruneAuto(cfg, [])
  assert.equal(removed.blobsSkippedBusy, true, 'busy 时没有报告跳过 —— 调用方会以为 GC 真跑过')
  assert.equal(removed.removedBlobs ?? 0, 0, 'busy 时仍然动了 blob')
  assert.ok(readdirSync(blobsDir).includes(orphan), 'busy 时 blob 被删了（正在写 pre-restore 快照就会被删残）')

  // 直接调那两个导出也必须 fail-closed，不能只靠调用点记得判。
  assert.equal(await core.pruneOrphanBlobs(cfg, []), 0, 'pruneOrphanBlobs 在 busy 时仍删了 blob')
  const compact = await core.undoCompact(cfg)
  assert.equal(compact.blobsSkippedBusy, true)
  assert.ok(readdirSync(blobsDir).includes(orphan))
  rmSync(join(cfg.autoDir, '..'), { recursive: true, force: true })
})

test('#1590 非 busy 且无新写入时 GC 照常工作（防「一律不删」的假绿）', async () => {
  const cfg = makeCfg()
  const blobsDir = join(cfg.autoDir, '..', 'blobs')
  mkdirSync(blobsDir, { recursive: true })
  const orphan = 'orphan-' + 'd'.repeat(16)
  writeFileSync(join(blobsDir, orphan), Buffer.from('orphan'))
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000)
  utimesSync(join(blobsDir, orphan), old, old)
  const removed = await core.pruneAuto(cfg, [])
  assert.equal(removed.blobsSkippedBusy, false)
  assert.equal(removed.removedBlobs, 1, '正常情况下孤儿必须被清掉，实得 ' + removed.removedBlobs)
  rmSync(join(cfg.autoDir, '..'), { recursive: true, force: true })
})

test('清理：临时根目录不留垃圾', () => {
  fs.promises.readFile = realReadFile
  fs.promises.stat = realStat
  rmSync(ROOT, { recursive: true, force: true })
})
