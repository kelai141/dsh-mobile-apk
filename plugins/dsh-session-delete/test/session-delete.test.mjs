import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  SessionDeleteError,
  assertSessionId,
  deleteStoredSession,
  findSessionDir,
  sessionsRoot,
  sweepGraveyards,
} from '../src/session-delete.js'

const ID = 'session-12345678-1234-4abc-8def-1234567890ab'

async function homeWith(ids, key = '--workspace--') {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  for (const id of ids) {
    const dir = join(sessionsRoot(home), key, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.lock'), '')
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
  }
  return home
}

test('rejects ids that are not session-<uuid>', async () => {
  for (const bad of ['', 'session-1', '../etc/passwd', 'session-12345678-1234-4abc-8def-1234567890ab/../x']) {
    assert.throws(() => assertSessionId(bad), (error) => error instanceof SessionDeleteError && error.code === 'invalid-id')
  }
})

test('reports a missing session without touching the tree', async () => {
  const home = await homeWith([])
  await assert.rejects(
    deleteStoredSession({ home, sessionId: ID }),
    (error) => error instanceof SessionDeleteError && error.code === 'not-found',
  )
})

test('refuses to delete a session that is still running', async () => {
  const home = await homeWith([ID])
  await assert.rejects(
    deleteStoredSession({ home, sessionId: ID, isActive: true }),
    (error) => error instanceof SessionDeleteError && error.code === 'session-active',
  )
  const dir = join(sessionsRoot(home), '--workspace--', ID)
  assert.equal((await stat(dir)).isDirectory(), true)
})

test('deletes the stored directory and runs bookkeeping first', async () => {
  const home = await homeWith([ID])
  const seen = []
  const result = await deleteStoredSession({
    home,
    sessionId: ID,
    isActive: false,
    beforeRemove: async (info) => { seen.push(info.sessionId) },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(seen, [ID])
  const groups = await readdir(sessionsRoot(home))
  assert.equal(groups.length, 1)
  assert.deepEqual(await readdir(join(sessionsRoot(home), '--workspace--')), [])
})

test('refuses an ambiguous id that exists in two workspace directories', async () => {
  const home = await homeWith([ID], '--a--')
  await homeWith([]) // keep mkdtemp shape stable; create the second copy explicitly below
  const second = join(sessionsRoot(home), '--b--', ID)
  await mkdir(second, { recursive: true })
  await assert.rejects(
    deleteStoredSession({ home, sessionId: ID }),
    (error) => error instanceof SessionDeleteError && error.code === 'ambiguous',
  )
  assert.equal((await stat(join(sessionsRoot(home), '--a--', ID))).isDirectory(), true)
  assert.equal((await stat(second)).isDirectory(), true)
})

test('findSessionDir resolves the single matching directory', async () => {
  const home = await homeWith([ID])
  assert.equal(await findSessionDir(sessionsRoot(home), ID), join(sessionsRoot(home), '--workspace--', ID))
})

// ── host 侧编排：removeSession 用注入的 ctx 读活会话/工作区登记，再走同一个核心 ──
import { removeSession } from '../src/index.js'

function fakeCtx({ live = false, activity = [], registry = {}, detach = null, waterfall = null, detachThrows = false, noDetachCapability = false } = {}) {
  const calls = []
  const state = { live }
  const sessions = {
    get: (id) => (state.live ? { id, header: { id } } : undefined),
    flush: async () => { calls.push('flush') },
  }
  if (!noDetachCapability) {
    sessions.liveEntryFor = (session) => ({
      detach: () => {
        calls.push('detach:' + session.id)
        if (detachThrows) throw new Error('detach exploded')
        if (detach) detach()
        state.live = false
      },
    })
  }
  const ctx = {
    calls,
    state,
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'workspaceRegistry') return registry
      return undefined
    },
  }
  if (waterfall !== null) ctx.waterfall = waterfall
  else ctx.waterfall = async () => activity
  return ctx
}

test('removeSession refuses a running session before touching the disk', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await assert.rejects(
      removeSession(fakeCtx({ live: true, activity: [{ kind: 'agent' }] }), ID),
      (error) => error instanceof SessionDeleteError && error.code === 'session-active',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('removeSession refuses when the engine exposes no unload path (files stay)', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx({ live: true, activity: [], noDetachCapability: true })
    await assert.rejects(
      removeSession(ctx, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'unload-failed',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('removeSession drops archive/pin membership then deletes the directory', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const calls = []
  try {
    const result = await removeSession(fakeCtx({
      registry: {
        unarchiveSession: async (id) => { calls.push('unarchive:' + id) },
        unpinSession: async (id) => { calls.push('unpin:' + id) },
      },
    }), ID)
    assert.equal(result.ok, true)
    assert.deepEqual(calls, ['unarchive:' + ID, 'unpin:' + ID])
    assert.deepEqual(await readdir(join(sessionsRoot(home), '--workspace--')), [])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('logs every deletion step through the injected logger', async () => {
  const home = await homeWith([ID])
  const lines = []
  await deleteStoredSession({
    home,
    sessionId: ID,
    logger: (level, message) => lines.push(level + ':' + message),
  })
  assert.deepEqual(lines, [
    'info:delete requested',
    'info:resolved session directory',
    'info:moving session directory out of the scan path',
    'info:removing session directory',
    'info:session deleted',
  ])
})

test('removeSession without the activity waterfall refuses (state unknown, never guess)', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 故意不提供 waterfall：老引擎形态 ⇒ 状态未知 ⇒ 拒绝
    const ctx = {
      get(name) {
        if (name === 'sessions') return { get: () => ({ header: { id: ID } }) }
        return undefined
      },
    }
    await assert.rejects(
      removeSession(ctx, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'activity-unknown',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('removeSession refuses even an unloaded session when the probe is unavailable', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await assert.rejects(
      removeSession({ get: () => undefined }, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'activity-unknown',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a directory that vanishes mid-delete reports not-found, not a hard failure', async () => {
  const home = await homeWith([ID])
  const dir = join(sessionsRoot(home), '--workspace--', ID)
  await assert.rejects(
    deleteStoredSession({
      home,
      sessionId: ID,
      beforeRemove: async () => { await rm(dir, { recursive: true, force: true }) },
    }),
    (error) => error instanceof SessionDeleteError && error.code === 'not-found',
  )
})

test('a throwing activity probe refuses instead of guessing idle', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx({ waterfall: async () => { throw new Error('provider exploded') } })
    await assert.rejects(
      removeSession(ctx, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'activity-unknown',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a non-array activity probe result refuses instead of guessing idle', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx({ waterfall: async () => 'not-an-array' })
    await assert.rejects(
      removeSession(ctx, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'activity-unknown',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// issue #1203：**顺序已反转**。旧用例名与断言写的是「先卸载、后删文件」，那正是本条要修的
// 缺陷形态——卸载在 rename 之前，一旦移动失败就是「内存没了、磁盘还在」。现在目录先离开
// 扫描路径，卸载才跑；所以断言从「卸载时目录还在」改为「卸载时目录已不在原位（但未销毁）」。
test('a live session is unloaded after its directory leaves the scan path', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const dir = join(sessionsRoot(home), '--workspace--', ID)
  let dirPresentAtDetach = null
  try {
    const ctx = fakeCtx({ live: true, activity: [], detach: () => { dirPresentAtDetach = existsSync(dir) } })
    const result = await removeSession(ctx, ID)
    assert.equal(result.ok, true)
    // issue #1203：卸载发生在目录**离开扫描路径之后**，故此刻原位已不存在（内容仍在 graveyard，
    // 随后才 rm）。旧断言要求此处为 true，等于钉死「先卸载后移动」这个缺陷顺序。
    assert.equal(dirPresentAtDetach, false, '卸载必须在目录移出扫描路径之后才发生')
    assert.deepEqual(ctx.calls, ['detach:' + ID])
    // 卸载后不再 live（api-session/removed 因此会广播）。
    assert.equal(ctx.get('sessions').get(ID), undefined)
    assert.deepEqual(await readdir(join(sessionsRoot(home), '--workspace--')), [])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a detach failure aborts the delete and keeps the files', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx({ live: true, activity: [], detachThrows: true })
    await assert.rejects(
      removeSession(ctx, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'unload-failed',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('a running session is refused before any file work happens', async () => {
  const home = await homeWith([ID])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx({ live: true, activity: [{ kind: 'agent' }] })
    await assert.rejects(
      removeSession(ctx, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'session-active',
    )
    assert.equal((await stat(join(sessionsRoot(home), '--workspace--', ID))).isDirectory(), true)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// ── 接口契约回归：只允许公开接口，禁止再次引入 private API ──────────────────
import { readFileSync } from 'node:fs'

/** 去掉注释再断言：注释里解释「为什么不用 private API」是允许的。 */
function codeOf(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('host half never calls the flush API (it requires a live session)', () => {
  const source = codeOf('../src/index.js')
  assert.equal(/\.flush\s*\(/.test(source), false, 'flush(session) requires a live session; the plugin must not call it')
})

test('client half never calls private navigation APIs (clearMain / shortcuts.find)', () => {
  const source = codeOf('../src/client.js')
  assert.equal(/clearMain/.test(source), false, 'clearMain is private upstream')
  assert.equal(/shortcuts\.find/.test(source), false, 'the Shortcuts service has no find()')
  assert.equal(/liveEntryFor/.test(source), false, 'liveEntryFor is private upstream')
})

test('a missing directory reports not-found and keeps the session live', async () => {
  // 受控复现（维护者提出）：live 会话但磁盘上没有目录 → 必须 not-found，且会话仍在 live 集合。
  const home = await homeWith([])
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ctx = fakeCtx({ live: true, activity: [] })
    await assert.rejects(
      removeSession(ctx, ID),
      (error) => error instanceof SessionDeleteError && error.code === 'not-found',
    )
    assert.deepEqual(ctx.calls, [])
    assert.notEqual(ctx.get('sessions').get(ID), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('sweepGraveyards removes only .deleting-* leftovers, never live sessions', async () => {
  const home = await homeWith([ID])
  const key = '--workspace--'
  const graveyard = join(sessionsRoot(home), key, ID + '.deleting-lx8p2')
  await mkdir(graveyard)
  await writeFile(join(graveyard, 'session.lock'), '')

  const removed = await sweepGraveyards(home)

  assert.equal(removed.length, 1, 'exactly the graveyard is removed')
  assert.equal(removed[0], graveyard)
  assert.equal(existsSync(graveyard), false, 'graveyard directory is gone')
  assert.equal(existsSync(join(sessionsRoot(home), key, ID)), true, 'live session directory untouched')
})

test('sweepGraveyards is a no-op without a sessions root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  assert.deepEqual(await sweepGraveyards(home), [])
  assert.deepEqual(await sweepGraveyards(''), [])
})
