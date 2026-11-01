import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { TAR } from './lib/shell.mjs'
import { versionedFixture } from './patches/tests/lib/fixture.mjs'
import { PREVIEW_LOCAL, PREVIEW_PI, PREVIEW_DEEPSEEK, patchRequestPreview } from './patches/image-request-preview-P1.mjs'
import { patchImageExpiry } from './patches/image-expiry-E1.mjs'

const scripts = dirname(fileURLToPath(import.meta.url)), root = dirname(scripts)
const registry = JSON.parse(readFileSync(join(scripts, 'patches/registry.json')))

function fixture(change) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-assets-companions-'))
  const temporaryRoot = join(dir, 'repo'), stage = join(dir, 'stage'), archive = join(dir, 'snapshot.tar')
  const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data) }
  cpSync(join(scripts, 'patches'), join(temporaryRoot, 'scripts/patches'), { recursive: true, filter: path => !path.includes(join('patches', 'tests')) })
  write(join(temporaryRoot, 'scripts/patches/registry.json'), JSON.stringify(registry))
  for (const [file, kind] of [[PREVIEW_LOCAL, 'local'], [PREVIEW_PI, 'pi'], [PREVIEW_DEEPSEEK, 'deepseek']]) {
    const name = file.split('/').at(-3)
    write(join(stage, file), patchImageExpiry(patchRequestPreview(readFileSync(versionedFixture(name, 'lib/index.js'), 'utf8'), kind), kind))
    write(join(stage, file.replace(/lib\/index\.js$/, 'package.json')), readFileSync(versionedFixture(name, 'package.json')))
  }
  const geometry = PREVIEW_LOCAL.replace('dsh-attachment-local', 'dsh-attachment')
  write(join(stage, geometry), readFileSync(versionedFixture('dsh-attachment', 'lib/index.js')))
  write(join(stage, geometry.replace(/lib\/index\.js$/, 'package.json')), readFileSync(versionedFixture('dsh-attachment', 'package.json')))
  const android = spawnSync(process.execPath, [join(temporaryRoot, 'scripts/patches/apply-patches.mjs'), stage, '--apply', '--scope', 'engine', '--only', 'attach-durable-F2'], { encoding: 'utf8' })
  assert.equal(android.status, 0, android.stdout + android.stderr)
  write(join(temporaryRoot, 'app/src/main/assets/patched/attachment-local-index.js'), readFileSync(join(stage, PREVIEW_LOCAL)))
  change?.({ stage, temporaryRoot })
  const packed = spawnSync(TAR, ['-cf', archive, '-C', stage, 'usr'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, packed.stderr)
  const result = spawnSync(process.execPath, [join(scripts, 'check-runtime-assets.mjs'), '--root', temporaryRoot, '--snapshot', archive, '--require'], { encoding: 'utf8', maxBuffer: 4000000 })
  rmSync(dir, { recursive: true, force: true })
  return { ...result, output: result.stdout + result.stderr }
}

test('多文件资产正控：候选资产与同快照配套文件、包身份一起通过真实门禁', () => {
  const result = fixture()
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /SKIP=0/)
  assert.match(result.output, /补丁本体在场/)
})

test('受控负控：配套文件缺失或正文漂移，即使主资产同字节且marker齐全也必须红', () => {
  const missing = fixture(({ stage }) => rmSync(join(stage, PREVIEW_PI)))
  assert.notEqual(missing.status, 0)
  assert.match(missing.output, /companion is missing/)
  const drift = fixture(({ stage }) => {
    const file = join(stage, PREVIEW_PI)
    writeFileSync(file, readFileSync(file, 'utf8').replace('1600 / Math.max(ref.width, ref.height)', '3200 / Math.max(ref.width, ref.height)'))
  })
  assert.notEqual(drift.status, 0)
  assert.match(drift.output, /结构断言失败/)
})

test('受控负控：主资产本体漂移、仅保留marker和正确配套时不能借快照本体冒充通过', () => {
  const result = fixture(({ stage, temporaryRoot }) => {
    const file = join(stage, PREVIEW_LOCAL)
    const data = readFileSync(file, 'utf8').replace('request-image-android-p1', 'request-image-broken')
    writeFileSync(file, data)
    writeFileSync(join(temporaryRoot, 'app/src/main/assets/patched/attachment-local-index.js'), data)
  })
  assert.notEqual(result.status, 0)
  assert.match(result.output, /结构断言失败/)
})
