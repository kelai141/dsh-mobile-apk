import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  deleteStoredSession,
  quarantineStoredSession,
  removeSessionProjectionCacheFile,
  sweepOrphanProjectionCaches,
} from '../src/session-delete.js'
import { apply } from '../src/index.js'

const ID_LIVE = 'session-11111111-1111-4111-8111-111111111111'
const ID_QUAR = 'session-22222222-2222-4222-8222-222222222222'
const ID_ORPH = 'session-33333333-3333-4333-8333-333333333333'
const ID_RECR = 'session-44444444-4444-4444-8444-444444444444'
const ID_GRAV = 'session-55555555-5555-4555-8555-555555555555'

function makeProjCacheDoc(id, createdAt, formatVersion = 4) {
  return JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion, createdAt, cwd: '/ws', isSeeded: false, inheritedEventCount: 0 },
      rows: { title: { ver: 1, seq: 0, val: `title-${id}` } },
    },
  })
}

test('deleteStoredSession removes matching session_projcache entry and .bak siblings', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-projcache-del-'))
  try {
    const sessionDir = join(home, 'sessions', '-ws', ID_LIVE)
    const otherDir = join(home, 'sessions', '-ws', ID_ORPH)
    await mkdir(sessionDir, { recursive: true })
    await mkdir(otherDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
    await writeFile(join(otherDir, 'session.v4.jsonl.zstd'), 'x')

    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, `${ID_LIVE}.json`), makeProjCacheDoc(ID_LIVE, 1000))
    await writeFile(join(cacheDir, `${ID_LIVE}.json.bak.202611250000`), '{bad}')
    await writeFile(join(cacheDir, `${ID_ORPH}.json`), makeProjCacheDoc(ID_ORPH, 2000))

    const res = await deleteStoredSession({ home, sessionId: ID_LIVE, isActive: false })
    assert.equal(res.ok, true)

    await assert.rejects(() => readFile(join(cacheDir, `${ID_LIVE}.json`)), { code: 'ENOENT' })
    await assert.rejects(() => readFile(join(cacheDir, `${ID_LIVE}.json.bak.202611250000`)), { code: 'ENOENT' })
    assert.ok((await readFile(join(cacheDir, `${ID_ORPH}.json`), 'utf8')).includes(ID_ORPH))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('quarantineStoredSession keeps session_projcache intact for recovery', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-projcache-quar-'))
  try {
    const sessionDir = join(home, 'sessions', '-ws', ID_QUAR)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x')

    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, `${ID_QUAR}.json`), makeProjCacheDoc(ID_QUAR, 1000))

    const res = await quarantineStoredSession({ home, sessionId: ID_QUAR, isActive: false })
    assert.equal(res.restorable, true)
    assert.ok((await readFile(join(cacheDir, `${ID_QUAR}.json`), 'utf8')).includes(ID_QUAR))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('sweepOrphanProjectionCaches removes orphans and lifecycle-mismatched caches while keeping live and quarantined', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-projcache-sweep-'))
  try {
    const ws = join(home, 'sessions', '-ws')
    // 1. Live matching session (zstd v4 header)
    await mkdir(join(ws, ID_LIVE), { recursive: true })
    const liveHeader = JSON.stringify({ version: 4, id: ID_LIVE, createdAt: 1000, cwd: '/ws', isSeeded: false }) + '\n'
    await writeFile(join(ws, ID_LIVE, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(liveHeader)))

    // 2. Quarantined recoverable session (kept!)
    await mkdir(join(ws, '.corrupt', `${ID_QUAR}.1700000000`), { recursive: true })
    await writeFile(join(ws, '.corrupt', `${ID_QUAR}.1700000000`, 'session.v4.jsonl.zstd'), 'q')

    // 3. Recreated session reusing ID_RECR with newer createdAt=9999 vs cache createdAt=1111
    await mkdir(join(ws, ID_RECR), { recursive: true })
    const recrHeader = JSON.stringify({ version: 4, id: ID_RECR, createdAt: 9999, cwd: '/ws', isSeeded: false }) + '\n'
    await writeFile(join(ws, ID_RECR, 'session.v4.jsonl'), recrHeader)

    // 4. Graveyard dir (leftover deleting dir, preserved until graveyard sweep removes it)
    await mkdir(join(ws, `${ID_GRAV}.deleting-abc`), { recursive: true })

    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, `${ID_LIVE}.json`), makeProjCacheDoc(ID_LIVE, 1000))
    await writeFile(join(cacheDir, `${ID_QUAR}.json`), makeProjCacheDoc(ID_QUAR, 2000))
    await writeFile(join(cacheDir, `${ID_ORPH}.json`), makeProjCacheDoc(ID_ORPH, 3000))
    await writeFile(join(cacheDir, `${ID_RECR}.json`), makeProjCacheDoc(ID_RECR, 1111))
    await writeFile(join(cacheDir, `${ID_GRAV}.json`), makeProjCacheDoc(ID_GRAV, 5000))

    const res = await sweepOrphanProjectionCaches(home)
    assert.equal(res.aborted, false)
    assert.equal(res.removed.length, 2)

    await readFile(join(cacheDir, `${ID_LIVE}.json`), 'utf8')
    await readFile(join(cacheDir, `${ID_QUAR}.json`), 'utf8')
    await readFile(join(cacheDir, `${ID_GRAV}.json`), 'utf8')
    await assert.rejects(() => readFile(join(cacheDir, `${ID_ORPH}.json`)), { code: 'ENOENT' })
    await assert.rejects(() => readFile(join(cacheDir, `${ID_RECR}.json`)), { code: 'ENOENT' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('apply route handler evicts in-memory sessionProjectionCache table after deleteStoredSession', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-projcache-mem-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const sessionDir = join(home, 'sessions', '-ws', ID_LIVE)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
    const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(cacheDir, { recursive: true })
    await writeFile(join(cacheDir, `${ID_LIVE}.json`), makeProjCacheDoc(ID_LIVE, 1000))

    const deletedInMemory = []
    const routes = new Map()
    const ctx = {
      effect: (fn) => { if (typeof fn === 'function') fn(); return () => {} },
      webServer: {
        register: (spec) => { routes.set(spec.path, spec.handler); return () => {} },
      },
      get: (name) => {
        if (name === 'connection') return { requestRejection: () => undefined }
        if (name === 'sessionProjectionCache') {
          return { table: { delete: async (id) => { deletedInMemory.push(id); return true } } }
        }
        return undefined
      },
      waterfall: async () => [],
      logger: { warn: () => {}, error: () => {} },
    }
    apply(ctx)
    const handler = routes.get('/api/session-delete')
    assert.ok(typeof handler === 'function')

    let statusCode = 0
    let body = ''
    const req = (async function* () { yield Buffer.from(JSON.stringify({ sessionId: ID_LIVE })) })()
    req.method = 'POST'
    const res = {
      writeHead: (s) => { statusCode = s },
      end: (text) => { body = text },
    }
    await handler(req, res)
    assert.equal(statusCode, 200)
    assert.equal(JSON.parse(body).ok, true)
    assert.deepEqual(deletedInMemory, [ID_LIVE])
    await assert.rejects(() => readFile(join(cacheDir, `${ID_LIVE}.json`)), { code: 'ENOENT' })
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    await rm(home, { recursive: true, force: true })
  }
})
