// issue #1398 + #1399：并发撤销互斥 + 快照 id 的原子占位。
//
// 判据跑的是**真实 vendored 字节**（vendor/dsh-undo-savepoint/lib/core.mjs）。
//
// #1398 缺陷形态：restore() 的唯一前置 `if (hasOpenTurn()) return busyError()` 只读不置位，
//   两次并发请求都能通过，随后各自建 pre-restore 并交错 applySnapshot —— 文件集互相覆盖成
//   混合态，还多出两个 pre-restore 快照。
// #1399 缺陷形态：id 冲突用 `do/while(pathExists)` 预检 + `mkdir(recursive: true)`，两者之间
//   是 TOCTOU 窗口，且 recursive 吞掉 EEXIST —— 同一秒内并发两次会落进同一目录互相覆盖。
//   修法要求：**占位失败后绝不能退回使用该目录**（那等于把竞态换成覆盖）。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promises as fsp } from 'node:fs'
import test from 'node:test'

const CORE_URL = new URL('../vendor/dsh-undo-savepoint/lib/core.mjs', import.meta.url).href
const core = await import(CORE_URL)

function makeCfg() {
  const root = mkdtempSync(join(tmpdir(), 'undo-1398-'))
  const autoDir = join(root, 'auto')
  const manualDir = join(root, 'manual')
  mkdirSync(autoDir, { recursive: true })
  mkdirSync(manualDir, { recursive: true })
  return { root, cfg: { autoDir, manualDir, root, suppressAuto: 0, restoredHashes: new Map(), keepSnapshots: 50, profile: 'web' } }
}

// ── #1399：原子占位 ───────────────────────────────────────────────────────────

test('#1399 并发创建快照不得落进同一目录（每个调用各自占一个 id）', async () => {
  const { root, cfg } = makeCfg()
  const N = 8
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => core.createSnapshot(cfg, 'auto', 'probe-' + String(i))),
  )
  const ids = results.map((r) => r.id)
  assert.equal(new Set(ids).size, N, 'id 必须两两不同，实得 ' + JSON.stringify(ids))
  const dirs = readdirSync(cfg.autoDir).filter((n) => n !== 'env-vault')
  assert.equal(dirs.length, N, '必须落下 ' + N + ' 个互不相同的快照目录，实得 ' + JSON.stringify(dirs))
  for (const id of ids) {
    assert.ok(statSync(join(cfg.autoDir, id)).isDirectory(), '每个 id 都应有自己的目录: ' + id)
  }
  rmSync(root, { recursive: true, force: true })
})

test('#1399 占位撞车（EEXIST）必须换 id 重试，绝不复用被占的那个目录', async () => {
  const { root, cfg } = makeCfg()
  const realMkdir = fsp.mkdir
  let failedPath = null
  let calls = 0
  // 只让**第一次** mkdir 抛 EEXIST，其余放行：模拟「另一个写者刚好抢到了这个 id」。
  fsp.mkdir = async (p, opts) => {
    // createSnapshot 先 mkdir(base, {recursive:true})，那不是占位，不能算一次撞车。
    if (String(p) === cfg.autoDir) return realMkdir(p, opts)
    calls += 1
    if (calls === 1) { failedPath = String(p); const err = new Error('EEXIST'); err.code = 'EEXIST'; throw err }
    return realMkdir(p, opts)
  }
  try {
    const r = await core.createSnapshot(cfg, 'auto', 'retry')
    assert.ok(failedPath !== null, '夹具没有触发 EEXIST（判据失效）')
    const claimed = join(cfg.autoDir, r.id)
    assert.notEqual(claimed, failedPath, '撞车后复用了被占的目录 —— 那是把竞态换成了覆盖')
    assert.ok(statSync(claimed).isDirectory(), '必须真的占到一个新目录')
    // 被注入 EEXIST 的那个候选目录本就不该由本调用创建（它属于「别人」）。
    assert.equal(existsSync(failedPath), false, '撞车后仍然往被占的目录里写了东西')
  } finally {
    fsp.mkdir = realMkdir
    rmSync(root, { recursive: true, force: true })
  }
})

test('#1399 一直撞车时必须失败关闭，不得静默复用或无限重试', async () => {
  const { root, cfg } = makeCfg()
  const realMkdir = fsp.mkdir
  let calls = 0
  // 只拦「快照 id 目录」这一层：createSnapshot 先 mkdir(base, {recursive:true})，那不是占位。
  fsp.mkdir = async (p, opts) => {
    if (String(p) === cfg.autoDir) return realMkdir(p, opts)
    calls += 1
    const err = new Error('EEXIST')
    err.code = 'EEXIST'
    throw err
  }
  try {
    await assert.rejects(() => core.createSnapshot(cfg, 'auto', 'always-busy'), /collision|claim/i)
    assert.ok(calls > 1 && calls <= 8, '必须在有界次数内放弃（实得 ' + calls + ' 次）')
  } finally {
    fsp.mkdir = realMkdir
    rmSync(root, { recursive: true, force: true })
  }
})

// ── #1398：并发撤销互斥 ───────────────────────────────────────────────────────

test('#1398 已有撤销在跑时，第二个请求必须拿到 busy 而不是继续执行', async () => {
  const { root, cfg } = makeCfg()
  cfg.undoBusy = true
  const r = await core.restore(cfg, 'undo')
  assert.equal(r.ok, false, '并发撤销竟然通过了：' + JSON.stringify(r))
  assert.equal(r.error?.code, 'busy', '必须以 busy 拒绝，实得 ' + JSON.stringify(r.error))
  rmSync(root, { recursive: true, force: true })
})

test('#1398 同一 tick 发起两次撤销：恰好一个被 busy 拒绝', async () => {
  const { root, cfg } = makeCfg()
  const [a, b] = await Promise.all([core.restore(cfg, 'undo'), core.restore(cfg, 'undo')])
  const busyCount = [a, b].filter((r) => r.ok === false && r.error?.code === 'busy').length
  assert.equal(busyCount, 1, '必须恰好一个被互斥挡住，实得 ' + busyCount + ' 个 busy（a=' + JSON.stringify(a).slice(0, 80) + ' b=' + JSON.stringify(b).slice(0, 80) + '）')
  rmSync(root, { recursive: true, force: true })
})

test('#1398 单飞标志必须在 finally 复位（失败路径也要复位）', async () => {
  const { root, cfg } = makeCfg()
  const r = await core.restore(cfg, 'undo')
  assert.equal(r.ok, false, '空目录下撤销应无可撤销（前置）')
  assert.equal(cfg.undoBusy, false, '失败路径没有复位单飞标志 —— 下一次撤销会被永久 busy 挡住')
  // 复位之后必须能再次进入（不被上一次的失败卡死）
  const again = await core.restore(cfg, 'undo')
  assert.equal(again.ok, false)
  assert.notEqual(again.error?.code, 'busy', '复位失败：第二次被误判成并发')
  rmSync(root, { recursive: true, force: true })
})
