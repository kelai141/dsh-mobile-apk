// Run as an isolated debug APK UID, with its cwd at the app data root.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const [nativePath, modulePath] = process.argv.slice(2)
assert.ok(nativePath && modulePath, 'pass the native binary and installed file-reference-local lib/index.js')
const module = resolve(modulePath)
const { WorkspaceFileSearch, DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES: excludedDirectories } =
  await import(pathToFileURL(module).href)
const queries = ['file', 'f019', 'module', 'zzzz', '路径', 'STRASSE', 'ος', '😀', 'İNPUT',
  '.private', 'README', 'linked-module', 'node_modules']
const config = { maxEntries: 50000, maxResults: 20, excludedDirectories }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(root) {
  for (let dir = 0; dir < 160; dir++) {
    const part = join(root, 'module-' + String(dir).padStart(3, '0'))
    mkdirSync(part)
    for (let n = 0; n < 125; n++) writeFileSync(join(part, 'file-' + String(n).padStart(3, '0') + '.ts'), '')
  }
  for (const filename of ['README.md', '路径-😀.txt', 'İnput.txt', 'Straße.txt', 'STRASSE.md',
    'ΟΣ.txt', 'ος.txt', 'οσ.txt', '😀-README.txt', '\ue000-README.txt', '.private.md']) {
    writeFileSync(join(root, filename), '')
  }
  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'README.md'), '')
  symlinkSync('module-000', join(root, 'linked-module'))
}

async function upstream(root) {
  const search = new WorkspaceFileSearch(root, config)
  const signal = new AbortController().signal
  const started = performance.now()
  const cpuStart = process.cpuUsage()
  try {
    const first = await search.list(queries[0], signal)
    const coldMs = performance.now() - started
    const rows = [first]
    const warm = performance.now()
    for (let repeat = 0; repeat < 8; repeat++) {
      for (const query of queries) {
        const result = await search.list(query, signal)
        if (repeat === 0) rows.push(result)
      }
    }
    const cpu = process.cpuUsage(cpuStart)
    return { coldMs, warmMs: performance.now() - warm, cpuMs: (cpu.user + cpu.system) / 1000, rows }
  } finally {
    search.dispose()
  }
}

function rust(root) {
  const start = performance.now()
  const result = spawnSync('/system/bin/linker64', [resolve(nativePath), root, ...queries], {
    encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return { ...JSON.parse(result.stdout), withSpawnMs: performance.now() - start }
}

const root = mkdtempSync(resolve('cache/dsh-file-reference-'))
try {
  fixture(root)
  const samples = []
  for (let i = 0; i < 6; i++) {
    const first = i % 2 ? await upstream(root) : rust(root)
    const second = i % 2 ? rust(root) : await upstream(root)
    const [node, native] = i % 2 ? [first, second] : [second, first]
    assert.deepEqual(native.rows, node.rows, 'ranking differs from the installed upstream JS')
    assert.ok(node.rows[0].length === 20 && node.rows[4].length === 0 && node.rows[5].length > 0)
    assert.equal(node.rows.at(-2).length, 0, 'symlink must not enter the index')
    assert.equal(node.rows.at(-1).length, 0, 'excluded directory must not enter the index')
    const resultSha256 = sha256(JSON.stringify(node.rows))
    delete node.rows
    delete native.rows
    samples.push({ node, native, resultSha256 })
  }
  console.log(JSON.stringify({ moduleSha256: sha256(readFileSync(module)), node: process.version,
    queries, files: 20011, samples }, null, 2))
} finally {
  rmSync(root, { recursive: true })
}
