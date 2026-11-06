// issue #1588：登出与在途刷新的竞态。
//
// 缺陷形态：TokenManager.doRefresh 刷新成功后无条件 save(next)，而 logout 只调
// deleteAccountSession、**不等也不作废**在途刷新。于是：
//   刷新在途 -> 用户登出 -> 删除完成 -> 刷新返回 -> 落盘 -> 账号复活。
// 因 refresh token 已轮换，这份残留是**可用的**（不是僵尸，是能用的凭据）。
//
// 判据全部是行为判据：给真实 TokenManager 喂一个卡住的 refresh，在中途执行登出该做的事，
// 然后看「刷新结果有没有落盘」「调用方拿到的是什么」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAccountSession, deleteAccountSession, loadStore } from '../lib/auth/store.js'
import { TokenManager } from '../lib/providers/common.js'

const PROVIDER = 'claude'
const ACCOUNT = 'a@example.com'

const session = (tag, expiresAt = Date.now() + 3600_000) => ({
  accessToken: 'access-' + tag,
  refreshToken: 'refresh-' + tag,
  expiresAt,
})

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'subs-1588-'))
  return { path: join(dir, 'auth.json'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** 造一个绑到临时 store 的 TokenManager；refresh 由调用方控制。 */
function managerFor(path, refresh, onSave) {
  return new TokenManager({
    displayName: 'Claude',
    preemptMs: 60_000,
    load: async () => {
      const store = await loadStore(path)
      const entry = store[PROVIDER]
      return entry === undefined ? undefined : entry.accounts[ACCOUNT]
    },
    save: async (next) => {
      onSave?.()
      await saveAccountSession(PROVIDER, ACCOUNT, next, path)
    },
    remove: () => deleteAccountSession(PROVIDER, ACCOUNT, path),
    refresh,
    isPermanent: () => false,
  })
}

test('#1588 在途刷新返回时账号已被登出：不得落盘、不得复活、不得交回旧会话', async () => {
  const s = await tempStore()
  try {
    // 会话已在 preempt 窗口内，session() 会真的发起刷新。
    await saveAccountSession(PROVIDER, ACCOUNT, session('1', Date.now() + 1000), s.path)
    let releaseRefresh
    const gate = new Promise((resolve) => { releaseRefresh = resolve })
    let saved = 0
    const manager = managerFor(s.path, async () => { await gate; return session('2') }, () => { saved += 1 })
    const pending = manager.session()
    // 让 session() 真正走到 refresh 那一步。
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 登出：作废在途刷新（这正是 logout 里新增的那一行），再删存储。
    manager.invalidate()
    await deleteAccountSession(PROVIDER, ACCOUNT, s.path)
    releaseRefresh()
    await assert.rejects(pending, (error) => error.code === 'MISSING_CREDENTIAL',
      '登出后刷新返回必须报 MISSING_CREDENTIAL，而不是把已登出账号的会话交回去')
    assert.equal(saved, 0, '登出后不得调用 save 落盘，实得 save 次数 ' + saved)
    const store = JSON.parse(await readFile(s.path, 'utf8'))
    assert.equal(store[PROVIDER], undefined, '登出后不得复活账号，实得：' + JSON.stringify(store[PROVIDER]))
  } finally {
    await s.cleanup()
  }
})

test('#1588 正常刷新仍要落盘（防「一律不写」的假绿）', async () => {
  const s = await tempStore()
  try {
    await saveAccountSession(PROVIDER, ACCOUNT, session('1', Date.now() + 1000), s.path)
    const manager = managerFor(s.path, async () => session('2'))
    const fresh = await manager.session()
    assert.equal(fresh.accessToken, 'access-2', '刷新后应返回新 token')
    const store = JSON.parse(await readFile(s.path, 'utf8'))
    assert.equal(store[PROVIDER].accounts[ACCOUNT].accessToken, 'access-2',
      '账号仍在时刷新结果必须落盘，实得：' + JSON.stringify(store[PROVIDER]))
  } finally {
    await s.cleanup()
  }
})

test('#1588 首次登录不受影响：空 store 里也能写第一条会话', async () => {
  // 反向保护：如果修法改成「store 里没有条目就拒写」，首次登录会被一起堵死。
  // 这条钉住「登出判据必须靠代次，不能靠 store 里有没有条目」。
  const s = await tempStore()
  try {
    await saveAccountSession(PROVIDER, ACCOUNT, session('first'), s.path)
    const store = JSON.parse(await readFile(s.path, 'utf8'))
    assert.equal(store[PROVIDER].accounts[ACCOUNT].accessToken, 'access-first',
      '首次登录必须能建立条目，实得：' + JSON.stringify(store[PROVIDER]))
  } finally {
    await s.cleanup()
  }
})

test('#1588 未登出时 invalidate 之外的代次不变：连续两次刷新都能落盘', async () => {
  const s = await tempStore()
  try {
    await saveAccountSession(PROVIDER, ACCOUNT, session('1', Date.now() + 1000), s.path)
    let round = 1
    const manager = managerFor(s.path, async () => session(String(++round)))
    await manager.session()
    // 强制第二次刷新（401 路径）
    const second = await manager.session(true)
    assert.equal(second.accessToken, 'access-3', '第二次刷新应返回新 token')
    const store = JSON.parse(await readFile(s.path, 'utf8'))
    assert.equal(store[PROVIDER].accounts[ACCOUNT].accessToken, 'access-3', '第二次刷新也必须落盘')
  } finally {
    await s.cleanup()
  }
})
