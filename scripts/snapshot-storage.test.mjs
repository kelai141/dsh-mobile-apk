import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pruneHoistedDuplicates, pruneRetiredAttachmentSeed } from './lib/profile-seed.mjs'

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

test('hoistedDedup 仅移除版本一致的冗余嵌套 zod 并保留 Inspector 按需裁剪', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hoisted-dedup-'))
  try {
    const slim = JSON.parse(readFileSync(new URL('./snapshot-config/slim.json', import.meta.url), 'utf8'))
    const overlay = JSON.parse(readFileSync(new URL('./snapshot-config/engine-overlay.json', import.meta.url), 'utf8'))
    assert.equal(overlay.vendorTop.zod, '4.6.6')
    for (const host of slim.hoistedDedup[0].hosts) {
      assert.equal(overlay.nested?.[host]?.zod, undefined, `${host} must not re-pin nested zod@4.6.6`)
    }
    assert.ok(
      slim.treeDelete.some((e) => e.path.endsWith('/dsh-experimental-inspector/lib/devtools')),
      'slim.json must strip optional inspector devtools static bundle from default snapshot',
    )

    const engineNm = join(root, 'usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
    mkdirSync(join(engineNm, 'zod'), { recursive: true })
    writeFileSync(join(engineNm, 'zod', 'package.json'), JSON.stringify({ name: 'zod', version: '4.6.6' }))
    writeFileSync(join(engineNm, 'zod', 'index.js'), 'module.exports = { version: "4.6.6" }')

    for (const host of slim.hoistedDedup[0].hosts) {
      const nestedZod = join(engineNm, ...host.split('/'), 'node_modules', 'zod')
      mkdirSync(nestedZod, { recursive: true })
      writeFileSync(join(nestedZod, 'package.json'), JSON.stringify({ name: 'zod', version: '4.6.6' }))
    }
    // Mismatched version is preserved cleanly.
    const mismatchHost = join(engineNm, '@deepseek-ai', 'dsh-other', 'node_modules', 'zod')
    mkdirSync(mismatchHost, { recursive: true })
    writeFileSync(join(mismatchHost, 'package.json'), JSON.stringify({ name: 'zod', version: '3.25.0' }))

    const removed = pruneHoistedDuplicates(root, slim.hoistedDedup)
    assert.equal(removed, 4)
    for (const host of slim.hoistedDedup[0].hosts) {
      assert.equal(existsSync(join(engineNm, ...host.split('/'), 'node_modules', 'zod')), false)
    }
    assert.equal(existsSync(mismatchHost), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
