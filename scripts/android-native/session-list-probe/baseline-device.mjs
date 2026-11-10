// Run with the installed debug APK's own Node, from the app data root.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { PerformanceObserver, performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const [packagesPath, rawCount = '512', compression = 'zstd', binary] = process.argv.slice(2)
const count = Number(rawCount)
assert.ok(packagesPath && Number.isInteger(count) && count >= 12 && count <= 5000)
assert.ok(compression === 'zstd' || compression === 'none')
assert.ok(!binary || compression === 'zstd')
const moduleFile = name => resolve(packagesPath, name, 'lib/index.js')
const installed = name => import(pathToFileURL(moduleFile(name)).href)
const { Context } = await installed('cordis')
const { SESSION_FORMAT_VERSION, SessionId, SessionSeq } = await installed('dsh-session')
const plugin = await installed('dsh-session-persistence-jsonl')
const root = await mkdtemp(resolve('cache/dsh-session-list-'))
const projectRoot = join(root, 'workspaces')
const sessionRoot = join(root, 'sessions')
const fixtureId = i => SessionId('session-' + String(i).padStart(5, '0'))
const fixtureCwd = i => join(projectRoot, 'project-' + (i % 12))
const isLong = i => i < 12 || (i >= 24 && i % 16 === 0)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const content = '可复现的输入内容与 Android session payload。'.repeat(800)

async function mount(listConcurrency) {
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin, { root: sessionRoot, compression, listConcurrency })
  return { persistence: ctx.sessionPersistence, dispose: () => fiber.dispose() }
}

async function createCorpus() {
  const instance = await mount(3)
  try {
    // Two upstream-authored seeds per project: a short and a large prompt.
    // The timed operation is listing, so expand the corpus directly on disk.
    const seeds = Math.min(count, 24)
    for (let i = 0; i < seeds; i++) {
      const id = fixtureId(i)
      const handle = await instance.persistence.create({ version: SESSION_FORMAT_VERSION, id,
        createdAt: 1000 + i, isSeeded: false, cwd: fixtureCwd(i) })
      try {
        await handle.append([
          { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
          { type: 'user/message', seq: SessionSeq(1), time: 2, surfaceOp: 'append', data: {
            id: id + '-user', role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: isLong(i) ? content : 'List current workspace files' }],
          } },
        ])
      } finally {
        await handle.close()
      }
    }
    if (count <= seeds) return
    const rows = await instance.persistence.list()
    assert.equal(rows.length, seeds)
    const byId = new Map(rows.map(row => [row.header.id, row]))
    const encode = bytes => compression === 'none' ? bytes : zstdCompressSync(bytes, {
      params: { [constants.ZSTD_c_checksumFlag]: 1 },
    })
    const templates = await Promise.all(Array.from({ length: seeds }, async (_, i) => {
      const row = byId.get(fixtureId(i))
      const path = row.location.path
      assert.equal(basename(dirname(path)), fixtureId(i))
      const bytes = await readFile(path)
      const first = compression === 'none' ? null : zstdDecompressSync(bytes, { info: true })
      const plain = first?.buffer ?? bytes
      const newline = plain.indexOf(10)
      const bodyAt = first?.engine.bytesWritten ?? (newline + 1)
      assert.ok(newline > 0 && bodyAt < bytes.length)
      if (first) assert.equal(newline, plain.length - 1)
      const header = JSON.parse(plain.subarray(0, newline).toString())
      assert.equal(header.id, fixtureId(i))
      assert.equal(header.createdAt, 1000 + i)
      return { header, body: bytes.subarray(bodyAt), project: dirname(dirname(path)),
        filename: basename(path) }
    }))
    for (let base = seeds; base < count; base += 24) {
      await Promise.all(Array.from({ length: Math.min(24, count - base) }, async (_, offset) => {
        const i = base + offset
        const seed = templates[i % 12 + (isLong(i) ? 0 : 12)]
        const id = fixtureId(i)
        const dir = join(seed.project, id)
        await mkdir(dir)
        const header = Buffer.from(JSON.stringify({ ...seed.header, id, createdAt: 1000 + i }) + '\n')
        await writeFile(join(dir, seed.filename), Buffer.concat([encode(header), seed.body]))
      }))
    }
  } finally {
    await instance.dispose()
  }
}

const indices = new Map(Array.from({ length: count }, (_, i) => [fixtureId(i), i]))
function verify(rows) {
  assert.equal(rows.length, count)
  const seen = new Set()
  for (const row of rows) {
    const { id, cwd, createdAt, version } = row.header
    const i = indices.get(id)
    assert.ok(i !== undefined && !seen.has(id))
    seen.add(id)
    assert.equal(cwd, fixtureCwd(i))
    assert.equal(createdAt, 1000 + i)
    assert.equal(version, SESSION_FORMAT_VERSION)
    assert.ok(row.sizeBytes > 0 && row.revision && row.location.path.startsWith(sessionRoot + '/'))
  }
  return digest(JSON.stringify(rows))
}

let gc = []
const observer = new PerformanceObserver(records => gc.push(...records.getEntries()))
observer.observe({ entryTypes: ['gc'] })
async function sample(persistence) {
  await setImmediate()
  gc = []
  const rssBefore = process.memoryUsage.rss()
  const cpuBefore = process.cpuUsage()
  const start = performance.now()
  const rows = await persistence.list()
  const end = performance.now()
  const cpu = process.cpuUsage(cpuBefore)
  const rssAfter = process.memoryUsage.rss()
  await setImmediate()
  await setImmediate()
  const entries = gc.filter(entry => entry.startTime >= start && entry.startTime < end)
  return { ms: end - start, cpuMs: (cpu.user + cpu.system) / 1000, rssBefore, rssAfter,
    gcCount: entries.length, gcMs: entries.reduce((sum, entry) => sum + entry.duration, 0),
    digest: verify(rows) }
}

async function diagnose() {
  const instance = await mount(3)
  try {
    const { persistence } = instance
    const handle = await persistence.open(fixtureId(count - 1), 'read')
    try {
      const { events } = await handle.read()
      assert.equal(handle.header.id, fixtureId(count - 1))
      assert.equal(events.length, 2)
      assert.equal(events[1].data.content[0].text, isLong(count - 1) ? content : 'List current workspace files')
    } finally {
      await handle.close()
    }
    // A separate diagnostic trial keeps wrappers out of the latency matrix.
    await persistence.list()
    const phases = {}
    const undo = []
    try {
      for (const name of ['listArtifacts', 'listGenerations']) {
        const proto = Object.getPrototypeOf(persistence)
        const descriptor = Object.getOwnPropertyDescriptor(proto, name)
        assert.equal(typeof descriptor?.value, 'function', 'installed diagnostic shape changed: ' + name)
        Object.defineProperty(proto, name, { ...descriptor, value: async function (...args) {
          const start = performance.now()
          try {
            return await Reflect.apply(descriptor.value, this, args)
          } finally {
            phases[name] = performance.now() - start
          }
        } })
        undo.push(() => Object.defineProperty(proto, name, descriptor))
      }
      const row = await sample(persistence)
      assert.ok(phases.listArtifacts >= phases.listGenerations && phases.listGenerations > 0)
      return { ...phases, listMs: row.ms, digest: row.digest }
    } finally {
      for (const restore of undo.reverse()) restore()
    }
  } finally {
    await instance.dispose()
  }
}

async function compareBatch() {
  const { withBatch, checkHeaders } = await import('./batch-device.mjs')
  const trials = []
  for (const order of [
    ['upstream', 'js', 'rust'], ['rust', 'upstream', 'js'], ['js', 'rust', 'upstream'],
  ]) {
    for (const variant of order) {
      const instance = await mount(3)
      try {
        const measure = () => withBatch(instance.persistence, variant, binary,
          () => sample(instance.persistence))
        const first = await measure()
        const repeat = await measure()
        assert.equal(first.digest, repeat.digest)
        if (trials.length) assert.equal(first.digest, trials[0].first.digest)
        if (variant !== 'upstream') {
          for (const row of [first, repeat]) {
            assert.equal(row.headerBatch.hits, count)
            assert.equal(row.headerBatch.fallback, 0)
          }
        }
        trials.push({ variant, first, repeat })
      } finally {
        await instance.dispose()
      }
    }
  }
  const instance = await mount(3)
  try {
    const controls = await checkHeaders(instance.persistence, binary, root)
    const phases = await diagnose()
    assert.equal(phases.digest, trials[0].first.digest)
    return { trials, controls, phases }
  } finally {
    await instance.dispose()
  }
}

async function concurrencyBaseline() {
  const trials = []
  for (const order of [[3, 6, 12], [12, 3, 6], [6, 12, 3]]) {
    for (const concurrency of order) {
      const instance = await mount(concurrency)
      try {
        const first = await sample(instance.persistence)
        const repeat = await sample(instance.persistence)
        assert.equal(first.digest, repeat.digest)
        if (trials.length > 0) assert.equal(first.digest, trials[0].first.digest)
        trials.push({ concurrency, first, repeat })
      } finally {
        await instance.dispose()
      }
    }
  }
  const phases = await diagnose()
  assert.equal(phases.digest, trials[0].first.digest)
  return { trials, phases }
}

try {
  await createCorpus()
  const result = binary ? await compareBatch() : await concurrencyBaseline()
  console.log(JSON.stringify({ node: process.version, count, compression,
    version: SESSION_FORMAT_VERSION, moduleSha256: digest(await readFile(moduleFile('dsh-session-persistence-jsonl'))),
    ...result }, null, 2))
} finally {
  observer.disconnect()
  await rm(root, { recursive: true, force: true })
}
