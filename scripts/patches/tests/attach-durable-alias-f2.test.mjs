import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { versionedFixture } from './lib/fixture.mjs'

const NODE = process.argv0 && isAbsolute(process.argv0) ? process.argv0 : process.execPath
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js'

test('attach-durable-F2 applies cleanly, is idempotent, and avoids alias payload duplication on link EACCES', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'attach-f2-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))

  const target = join(scratch, TARGET)
  mkdirSync(dirname(target), { recursive: true })
  const raw = readFileSync(versionedFixture('dsh-attachment-local', 'lib', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
  writeFileSync(target, raw)

  const applyArgs = [join(REPO, 'scripts', 'patches', 'apply-patches.mjs'), scratch, '--scope', 'engine', '--only', 'attach-durable-F2', '--apply']
  const first = spawnSync(NODE, applyArgs, { encoding: 'utf8' })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  const second = spawnSync(NODE, applyArgs, { encoding: 'utf8' })
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /changed=0/)

  // Behavioral simulation of publishImmutableAlias + dshMobileResolveReadableFilePath under link EACCES:
  const patched = readFileSync(target, 'utf8')
  assert.equal(patched.includes('dsh-mobile cas-alias-metadata fallback'), true)
  assert.equal(patched.includes('dshMobileResolveReadableFilePath'), true)
  assert.equal((patched.match(/dsh-mobile link->rename fallback/g) || []).length, 1)

  const fnStart = patched.indexOf('async function publishImmutableAlias(')
  const fnEnd = patched.indexOf('\nasync function stageImmutableObject(', fnStart)
  const resolveStart = patched.indexOf('function storedFileObjectPath(')
  const resolveEnd = patched.indexOf('\nasync function saveFileVerbatim(', resolveStart)
  assert.ok(fnStart > 0 && fnEnd > fnStart)
  assert.ok(resolveStart > 0 && resolveEnd > resolveStart)

  const homeRoot = mkdtempSync(join(tmpdir(), 'attach-behav-'))
  t.after(() => rmSync(homeRoot, { recursive: true, force: true }))
  const v1Root = join(homeRoot, 'attachments', 'v1')
  const payload = Buffer.from('shared-cas-pdf-payload-bytes')
  const sha = createHash('sha256').update(payload).digest('hex')
  const canonical = join(v1Root, 'file-objects', sha.slice(0, 2), sha)
  mkdirSync(dirname(canonical), { recursive: true })
  writeFileSync(canonical, payload)

  const { chmod, mkdir, readFile, rename, writeFile } = await import('node:fs/promises')
  const { existsSync: dshMobileExistsSync, readFileSync: dshMobileReadFileSync } = await import('node:fs')
  const { randomUUID } = await import('node:crypto')
  class AttachmentError extends Error {}
  const eaccesLink = async () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e }
  const storedFilePath = (r, ref) => join(r, 'files', sha.slice(0, 2), sha, ref.name)
  const ensureFileReference = () => sha
  const ensureDurableDirectory = async (p) => { await mkdir(p, { recursive: true }) }
  const ensureDurableHome = async (p) => p
  const syncDirectory = async () => {}

  const snippet = patched.slice(resolveStart, resolveEnd) + '\n' + patched.slice(fnStart, fnEnd)
    + '\nreturn { publishImmutableAlias, dshMobileResolveReadableFilePath };'
  const harness = new Function(
    'dirname', 'join', 'resolve', 'link', 'rename', 'writeFile', 'chmod', 'mkdir', 'randomUUID',
    'dshMobileExistsSync', 'dshMobileReadFileSync', 'AttachmentError', 'storedFilePath',
    'ensureFileReference', 'ensureDurableDirectory', 'ensureDurableHome', 'syncDirectory', 'digestFile',
    snippet,
  )(
    dirname, join, (x) => x, eaccesLink, rename, writeFile, chmod, mkdir, randomUUID,
    dshMobileExistsSync, dshMobileReadFileSync, AttachmentError, storedFilePath,
    ensureFileReference, ensureDurableDirectory, ensureDurableHome, syncDirectory,
    async () => sha,
  )

  await harness.publishImmutableAlias(v1Root, canonical, storedFilePath(v1Root, { name: 'a.pdf' }), sha)
  await harness.publishImmutableAlias(v1Root, canonical, storedFilePath(v1Root, { name: 'b.pdf' }), sha)

  // Canonical object survives intact; aliases are metadata files without duplicating payload bytes.
  assert.deepEqual(await readFile(canonical), payload)
  assert.equal(existsSync(storedFilePath(v1Root, { name: 'a.pdf' })), false)
  assert.equal(existsSync(storedFilePath(v1Root, { name: 'a.pdf' }) + '.dsh-alias.json'), true)
  assert.equal(existsSync(storedFilePath(v1Root, { name: 'b.pdf' }) + '.dsh-alias.json'), true)
  assert.equal(harness.dshMobileResolveReadableFilePath(v1Root, { attachmentId: `sha256:${sha}`, name: 'a.pdf', bytes: payload.length }), canonical)
  assert.equal(harness.dshMobileResolveReadableFilePath(v1Root, { attachmentId: `sha256:${sha}`, name: 'b.pdf', bytes: payload.length }), canonical)

  // Legacy physical entity continues to win on read (backward-compatible dual-read).
  const legacyTarget = storedFilePath(v1Root, { name: 'legacy.pdf' })
  mkdirSync(dirname(legacyTarget), { recursive: true })
  writeFileSync(legacyTarget, payload)
  assert.equal(harness.dshMobileResolveReadableFilePath(v1Root, { attachmentId: `sha256:${sha}`, name: 'legacy.pdf', bytes: payload.length }), legacyTarget)
})
