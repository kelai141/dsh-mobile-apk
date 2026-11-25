// sqlite-wal-vacuum.test.mjs — Real node:sqlite WAL checkpoint and incremental vacuum tests for S1 & S2

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { versionedFixture } from './lib/fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const S1_TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-storage-sqlite/lib/index.js'
const S2_TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session-query-sqlite/lib/index.js'
const S1_FIXTURE = versionedFixture('dsh-storage-sqlite', 'lib', 'index.js')
const S2_FIXTURE = versionedFixture('dsh-session-query-sqlite', 'lib', 'index.js')

test('S1 and S2 apply idempotently to fixtures and pass syntax checks', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sqlite-patch-check-'))
  try {
    const f1 = join(scratch, S1_TARGET)
    const f2 = join(scratch, S2_TARGET)
    mkdirSync(dirname(f1), { recursive: true })
    mkdirSync(dirname(f2), { recursive: true })
    writeFileSync(f1, readFileSync(S1_FIXTURE, 'utf8').replace(/\r\n/g, '\n'))
    writeFileSync(f2, readFileSync(S2_FIXTURE, 'utf8').replace(/\r\n/g, '\n'))

    const apply = spawnSync(process.execPath, [
      join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch,
      '--apply', '--scope', 'engine', '--only', 'sqlite-storage-wal-vacuum-S1,session-query-wal-vacuum-S2',
    ], { encoding: 'utf8' })
    assert.equal(apply.status, 0, apply.stderr + apply.stdout)

    const p1 = readFileSync(f1, 'utf8')
    const p2 = readFileSync(f2, 'utf8')
    const reApply = spawnSync(process.execPath, [
      join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), scratch,
      '--apply', '--scope', 'engine', '--only', 'sqlite-storage-wal-vacuum-S1,session-query-wal-vacuum-S2',
    ], { encoding: 'utf8' })
    assert.equal(reApply.status, 0, reApply.stderr + reApply.stdout)
    assert.equal(readFileSync(f1, 'utf8'), p1)
    assert.equal(readFileSync(f2, 'utf8'), p2)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('S1 configures auto_vacuum=INCREMENTAL, reclaims freed pages, and truncates WAL after reader release', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sqlite-s1-live-'))
  try {
    const modDir = join(scratch, 'storage-sqlite')
    mkdirSync(join(modDir, 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true })
    mkdirSync(join(modDir, 'node_modules', '@deepseek-ai', 'dsh-storage'), { recursive: true })
    writeFileSync(join(modDir, 'package.json'), JSON.stringify({ name: 'test-s1', type: 'module' }))
    writeFileSync(join(modDir, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', type: 'module', main: 'index.js' }))
    writeFileSync(join(modDir, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js'), 'const z = { object: () => ({}), string: () => ({ required: () => ({}) }), union: () => ({ default: () => ({}) }) }; export default z;\n')
    writeFileSync(join(modDir, 'node_modules', '@deepseek-ai', 'dsh-storage', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-storage', type: 'module', main: 'index.js' }))
    writeFileSync(join(modDir, 'node_modules', '@deepseek-ai', 'dsh-storage', 'index.js'), 'export class StorageError extends Error { constructor(c,m,o){super(m,o);this.code=c;} }\nexport const UNIT_NAME_RE = /^[a-z_]+$/;\nexport const storageBackendServiceKey = (k) => k;\n')

    const stage = join(scratch, 'stage')
    const patchedFile = join(stage, S1_TARGET)
    mkdirSync(dirname(patchedFile), { recursive: true })
    writeFileSync(patchedFile, readFileSync(S1_FIXTURE, 'utf8').replace(/\r\n/g, '\n'))
    const apply = spawnSync(process.execPath, [
      join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'), stage,
      '--apply', '--scope', 'engine', '--only', 'sqlite-storage-wal-vacuum-S1',
    ], { encoding: 'utf8' })
    assert.equal(apply.status, 0, apply.stderr)
    const entry = join(modDir, 'index.mjs')
    writeFileSync(entry, readFileSync(patchedFile, 'utf8'))

    const { SqliteStorageBackend } = await import(pathToFileURL(entry).href)
    const dbPath = join(scratch, 'store.db')
    const backend = new SqliteStorageBackend({ path: dbPath, journalMode: 'wal' })
    const unit = await backend.kv.open({ name: 'projcache', version: 1, tables: ['rows'], hasGlobal: false })

    // Verify auto_vacuum = 2 (INCREMENTAL) on new disk DB
    const db = await backend.ready
    assert.equal(db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, 2)

    const payload = { blob: 'x'.repeat(8192) }
    const keys = []
    for (let i = 0; i < 160; i += 1) {
      const k = `k${i}`
      keys.push(k)
      await unit.putRecord('rows', k, payload)
    }
    const walPath = `${dbPath}-wal`
    const dbSizeAfterWrites = statSync(dbPath).size
    const walSizeDuringWrites = existsSync(walPath) ? statSync(walPath).size : 0
    assert.ok(dbSizeAfterWrites > 50_000 || walSizeDuringWrites > 50_000)

    // Hold a long reader transaction open to block WAL truncation while deleting rows.
    const reader = new DatabaseSync(dbPath)
    reader.exec('BEGIN; SELECT count(*) FROM u_projcache_rows;')
    await unit.deleteRecords('rows', keys)
    reader.exec('COMMIT')
    reader.close()

    await backend.close()

    const walSizeAfterClose = existsSync(walPath) ? statSync(walPath).size : 0
    const dbSizeAfterClose = statSync(dbPath).size
    assert.equal(walSizeAfterClose, 0, 'WAL must truncate to 0 on backend.close() after reader release')
    assert.ok(dbSizeAfterClose < 200_000, `DB file should shrink after incremental_vacuum on delete+close, got ${dbSizeAfterClose}`)

    // Verify :memory: skips file pragmas without failing
    const memBackend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
    const memUnit = await memBackend.kv.open({ name: 'memunit', version: 1, tables: ['rows'], hasGlobal: false })
    await memUnit.putRecord('rows', 'a', { ok: true })
    await memUnit.deleteRecords('rows', ['a'])
    await memBackend.close()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
