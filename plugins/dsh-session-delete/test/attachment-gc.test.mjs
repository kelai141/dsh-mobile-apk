import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { collectGlobalAttachmentReferences, sweepOrphanAttachments } from '../lib/index.js'

const SHA_LIVE = '1'.repeat(64)
const SHA_QUARANTINE = '2'.repeat(64)
const SHA_DRAFT = '3'.repeat(64)
const SHA_EXPORT = '4'.repeat(64)
const SHA_INCOMING = '5'.repeat(64)
const SHA_ORPHAN_OLD = '6'.repeat(64)
const SHA_ORPHAN_RECENT = '7'.repeat(64)

async function createAttachmentFixture(now) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-attach-gc-'))
  const oldTime = new Date(now - 48 * 60 * 60 * 1000)
  const freshTime = new Date(now - 10 * 60 * 1000)

  const putObject = async (bucket, sha, bytes, mtime, isAliasDir = false) => {
    const dir = path.join(home, 'attachments', 'v1', bucket, sha.slice(0, 2))
    await mkdir(dir, { recursive: true })
    if (isAliasDir) {
      const aliasDir = path.join(dir, sha)
      await mkdir(aliasDir, { recursive: true })
      const metaFile = path.join(aliasDir, 'report.pdf.dsh-alias.json')
      await writeFile(metaFile, JSON.stringify({ sha256: sha }))
      await utimes(metaFile, mtime, mtime)
      await utimes(aliasDir, mtime, mtime)
      return aliasDir
    }
    const target = path.join(dir, sha)
    await writeFile(target, bytes)
    await utimes(target, mtime, mtime)
    return target
  }

  // Referenced objects across all durability classes
  const pLive = await putObject('objects', SHA_LIVE, 'live-img', oldTime)
  const pQuarantine = await putObject('file-objects', SHA_QUARANTINE, 'quarantined-file', oldTime)
  const pDraft = await putObject('objects', SHA_DRAFT, 'draft-img', oldTime)
  const pExport = await putObject('file-objects', SHA_EXPORT, 'exported-file', oldTime)
  const pIncoming = await putObject('file-objects', SHA_INCOMING, 'incoming-file', oldTime)
  // Unreferenced expired orphan & recent orphan inside cooling window
  const pOrphanObj = await putObject('file-objects', SHA_ORPHAN_OLD, 'orphan-bytes', oldTime)
  const pOrphanAlias = await putObject('files', SHA_ORPHAN_OLD, '', oldTime, true)
  const pRecentObj = await putObject('objects', SHA_ORPHAN_RECENT, 'recent-orphan', freshTime)

  // Write reference sources
  const liveSessionDir = path.join(home, 'sessions', '--ws--', 'session-11111111-1111-4111-8111-111111111111')
  await mkdir(liveSessionDir, { recursive: true })
  await writeFile(
    path.join(liveSessionDir, 'session.v4.jsonl.zstd'),
    zstdCompressSync(Buffer.from(JSON.stringify({ type: 'attachment', id: `sha256:${SHA_LIVE}` }) + '\n')),
  )

  const corruptDir = path.join(home, 'sessions', '.corrupt', 'session-22222222-2222-4222-8222-222222222222')
  await mkdir(corruptDir, { recursive: true })
  await writeFile(path.join(corruptDir, 'session.jsonl'), `{"ref":"sha256:${SHA_QUARANTINE}"}\n`)

  await mkdir(path.join(home, 'drafts'), { recursive: true })
  await writeFile(path.join(home, 'drafts', 'composer.json'), `{"id":"sha256:${SHA_DRAFT}"}`)

  await mkdir(path.join(home, 'exports'), { recursive: true })
  await writeFile(path.join(home, 'exports', 'bundle.json'), `{"id":"sha256:${SHA_EXPORT}"}`)

  const incomingDir = path.join(home, 'workspaces', 'incoming')
  await mkdir(incomingDir, { recursive: true })
  await writeFile(path.join(incomingDir, '.pending-notify.ndjson'), `external\t/tmp/x.pdf\tsha256:${SHA_INCOMING}\n`)

  return { home, pLive, pQuarantine, pDraft, pExport, pIncoming, pOrphanObj, pOrphanAlias, pRecentObj }
}

test('collectGlobalAttachmentReferences captures live, quarantined, draft, export, and incoming digests', async (t) => {
  const now = 1_750_000_000_000
  const f = await createAttachmentFixture(now)
  t.after(() => rm(f.home, { recursive: true, force: true }))

  const census = await collectGlobalAttachmentReferences(f.home)
  assert.equal(census.complete, true)
  for (const sha of [SHA_LIVE, SHA_QUARANTINE, SHA_DRAFT, SHA_EXPORT, SHA_INCOMING]) {
    assert.equal(census.refs.has(sha), true, `expected ${sha} to be referenced`)
  }
  assert.equal(census.refs.has(SHA_ORPHAN_OLD), false)
})

test('sweepOrphanAttachments is dry-run by default and only deletes expired unreferenced objects when apply=true', async (t) => {
  const now = 1_750_000_000_000
  const f = await createAttachmentFixture(now)
  t.after(() => rm(f.home, { recursive: true, force: true }))

  const dry = await sweepOrphanAttachments({ home: f.home, now })
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.equal(dry.deleted.length, 0)
  assert.equal(dry.candidates.length, 2)
  assert.equal(existsSync(f.pOrphanObj), true)
  assert.equal(existsSync(f.pOrphanAlias), true)

  const applied = await sweepOrphanAttachments({ home: f.home, now, apply: true })
  assert.equal(applied.ok, true)
  assert.equal(applied.dryRun, false)
  assert.equal(applied.deleted.length, 2)
  assert.equal(existsSync(f.pOrphanObj), false)
  assert.equal(existsSync(f.pOrphanAlias), false)

  // Every referenced asset & recent unreferenced asset inside cooling window stays untouched.
  for (const keep of [f.pLive, f.pQuarantine, f.pDraft, f.pExport, f.pIncoming, f.pRecentObj]) {
    assert.equal(existsSync(keep), true, `must keep ${keep}`)
  }
})

test('sweepOrphanAttachments fails closed and deletes nothing when any reference source is corrupt or unreadable', async (t) => {
  const now = 1_750_000_000_000
  const f = await createAttachmentFixture(now)
  t.after(() => rm(f.home, { recursive: true, force: true }))

  // Corrupt a zstd session file so reference census is incomplete.
  const brokenSession = path.join(f.home, 'sessions', '--ws--', 'session-bad.v4.jsonl.zstd')
  await writeFile(brokenSession, Buffer.from('not-valid-zstd-payload'))

  const res = await sweepOrphanAttachments({ home: f.home, now, apply: true })
  assert.equal(res.ok, false)
  assert.equal(res.aborted, 'incomplete-reference-scan')
  assert.equal(res.deleted.length, 0)
  assert.ok(res.incompleteReasons.length >= 1)
  assert.equal(existsSync(f.pOrphanObj), true, 'incomplete census must never delete any file')
})
