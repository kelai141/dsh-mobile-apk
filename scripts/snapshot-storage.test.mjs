import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pruneRetiredAttachmentSeed } from './lib/profile-seed.mjs'

const stage = JSON.parse(readFileSync(new URL('./snapshot-config/slim.json', import.meta.url))).retiredAttachmentSeed
const retired = ['dsh-attachment-formats/lib/index.js', 'pdfjs-dist/package.json', 'LICENSE', 'lib/client.js']
const preserved = ['@napi-rs/canvas/package.json', 'third-party-plugin/package.json', '.pnpm/lock.yaml']

test('退役附件裁剪仅操作摘要匹配的出厂 Web profile 路径', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-attachment-seed-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const webModules = join(root, 'home', '.dsh', 'profiles', 'web', 'node_modules')
  const headlessModules = join(root, 'home', '.dsh', 'profiles', 'headless', 'node_modules')
  const keep = [...preserved.map((file) => join(webModules, file)), ...retired.map((file) => join(headlessModules, file))]
  const remove = retired.map((file) => join(webModules, file))
  for (const file of [...keep, ...remove]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'fixture')
  }

  const baseArchive = join(root, 'base-dsh.tar.xz')
  const bytes = Buffer.from('audited fixture')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(baseArchive, 'different fixture')
  assert.equal(pruneRetiredAttachmentSeed(root, baseArchive, { ...stage, sha256 }), null)
  for (const file of [...keep, ...remove]) assert.ok(existsSync(file), file)

  writeFileSync(baseArchive, bytes)
  assert.equal(pruneRetiredAttachmentSeed(root, baseArchive, { ...stage, sha256 }), stage.entries.length)
  for (const file of keep) assert.equal(readFileSync(file, 'utf8'), 'fixture', file)
  for (const file of remove) assert.ok(!existsSync(file), file)
})

