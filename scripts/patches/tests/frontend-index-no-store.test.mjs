import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  FRONTEND_INDEX_NO_STORE_MARKER,
  hasFrontendIndexNoStore,
  patchFrontendIndexNoStore,
} from '../data/frontend-index-no-store.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(HERE, '..', '..', '..')
const TARGET = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js'
const pristine = readFileSync(versionedFixture('dsh-host-frontend-static', 'lib', 'index.js'), 'utf8')

test('frontend-index-no-store applies cleanly, is idempotent, and rejects drifted anchors', () => {
  assert.equal(hasFrontendIndexNoStore(pristine), false)
  const patched = patchFrontendIndexNoStore(pristine)
  assert.equal(hasFrontendIndexNoStore(patched), true)
  assert.equal(patchFrontendIndexNoStore(patched), patched)
  assert.equal(patched.split(FRONTEND_INDEX_NO_STORE_MARKER).length - 1, 1)

  assert.throws(
    () => patchFrontendIndexNoStore(pristine.replace('headers = { "content-type": HTML_MIME };', 'headers = { "content-type": "text/plain" };')),
    /expected exactly 1 headers anchor/,
  )
})

test('index response emits no-store while non-index assets keep ETag and no-cache', async () => {
  const patched = patchFrontendIndexNoStore(pristine)
  const scratch = mkdtempSync(join(tmpdir(), 'frontend-no-store-'))
  try {
    const deps = join(scratch, 'node_modules', '@deepseek-ai', 'schemastery')
    mkdirSync(deps, { recursive: true })
    writeFileSync(join(deps, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', type: 'module', exports: './index.js' }))
    writeFileSync(join(deps, 'index.js'), 'const schema = { required() { return this; } }; export default { object: () => ({}), string: () => schema };')
    const modulePath = join(scratch, 'index.mjs')
    writeFileSync(modulePath, patched)
    const { apply } = await import(pathToFileURL(modulePath))

    const dist = join(scratch, 'dist')
    mkdirSync(dist)
    const index = join(dist, 'index.html')
    writeFileSync(index, '<html><head></head><body>ok</body></html>')
    writeFileSync(join(dist, 'bundle.js'), 'console.log(1)')

    let handler
    apply({
      webServer: {
        registerFallback(spec) { handler = spec.resource },
        renderIndex(html) { return html },
      },
      connection: { browserPeer: undefined, authorizeIndex() { return true } },
      effect(fn) { fn() },
    }, { distIndex: index })

    const rootRes = await handler(new Request('http://127.0.0.1/'))
    assert.equal(rootRes.status, 200)
    assert.equal(rootRes.headers.get('cache-control'), 'no-store, no-cache, must-revalidate')
    assert.equal(rootRes.headers.get('pragma'), 'no-cache')

    const assetRes = await handler(new Request('http://127.0.0.1/bundle.js'))
    assert.equal(assetRes.status, 200)
    assert.equal(assetRes.headers.get('cache-control'), 'no-cache')
    assert.ok(assetRes.headers.get('etag'))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('runner integration: --check fails before apply, passes after apply, and is idempotent', () => {
  const stage = mkdtempSync(join(tmpdir(), 'frontend-no-store-stage-'))
  const file = join(stage, TARGET)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, pristine)
    const runner = (mode) => spawnSync(process.execPath, [
      join(HERE, '..', 'apply-patches.mjs'), stage, mode, '--only', 'frontend-index-no-store-C1', '--scope', 'engine',
    ], { encoding: 'utf8', cwd: repoRoot })

    assert.equal(runner('--check').status, 1)
    assert.equal(runner('--apply').status, 0)
    const onDisk = readFileSync(file, 'utf8')
    assert.equal(hasFrontendIndexNoStore(onDisk), true)
    assert.equal(runner('--check').status, 0)
    assert.equal(runner('--apply').status, 0)
    assert.equal(readFileSync(file, 'utf8'), onDisk)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
