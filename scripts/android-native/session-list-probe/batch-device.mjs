import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setImmediate } from 'node:timers/promises'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const magic = 0xfd2fb528
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function completeFrameEnd(bytes) {
  if (bytes.length < 5 || bytes.readUInt32LE() !== magic) return 0
  const descriptor = bytes[4]
  if (descriptor & 0x18) return 0
  const sizeFlag = descriptor >>> 6
  const dictionaryFlag = descriptor & 3
  const singleSegment = Boolean(descriptor & 0x20)
  const sizeBytes = sizeFlag ? 1 << sizeFlag : Number(singleSegment)
  let offset = 5 + Number(!singleSegment) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + sizeBytes
  while (offset + 3 <= bytes.length) {
    const block = bytes.readUIntLE(offset, 3)
    const type = (block >>> 1) & 3
    if (type === 3) return 0
    offset += 3 + (type === 1 ? 1 : block >>> 3)
    if (block & 1) {
      offset += descriptor & 4 ? 4 : 0
      return offset <= bytes.length ? offset : 0
    }
  }
  return 0
}

function jsHeader(path, scratch) {
  try {
    const fd = openSync(path, 'r')
    let read
    try {
      read = readSync(fd, scratch, 0, scratch.length, 0)
    } finally {
      closeSync(fd)
    }
    const end = completeFrameEnd(scratch.subarray(0, read))
    if (!end) return null
    const plain = zstdDecompressSync(scratch.subarray(0, end), { maxOutputLength: 65536 })
    if (plain.length === 0 || plain.indexOf(10) !== plain.length - 1) return null
    return utf8.decode(plain.subarray(0, -1))
  } catch {
    // The unchanged backend decides whether this is absent, torn or corrupt.
    return null
  }
}

async function jsBatch(paths, signal) {
  const start = performance.now()
  const scratch = Buffer.allocUnsafe(8192)
  const headers = []
  for (const [i, path] of paths.entries()) {
    if (i && i % 32 === 0) await setImmediate()
    signal?.throwIfAborted()
    headers.push(jsHeader(path, scratch))
  }
  return { headers, workMs: performance.now() - start }
}

function nativeBatch(binary, paths, signal) {
  return new Promise((done, reject) => {
    signal?.throwIfAborted()
    const started = performance.now()
    const child = execFile('/system/bin/linker64', [resolve(binary)], {
      encoding: 'utf8', signal, timeout: 60000, maxBuffer: 52 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) return reject(error)
      try {
        const parsed = JSON.parse(stdout)
        assert.ok(Array.isArray(parsed.headers) && parsed.headers.length === paths.length)
        assert.ok(parsed.headers.every(row => row === null || typeof row === 'string'))
        done({ ...parsed, elapsedMs: performance.now() - started })
      } catch (failure) {
        reject(failure)
      }
    })
    child.stdin.on('error', error => { if (!signal?.aborted) reject(error) })
    child.stdin.end(JSON.stringify(paths))
  })
}

export async function withBatch(persistence, variant, binary, run) {
  if (variant === 'upstream') return run()
  const proto = Object.getPrototypeOf(persistence)
  const generations = Object.getOwnPropertyDescriptor(proto, 'listGenerations')
  const first = Object.getOwnPropertyDescriptor(proto, 'readFirstZstdLine')
  assert.equal(typeof generations?.value, 'function')
  assert.equal(typeof first?.value, 'function')
  let lookup = new Map()
  let metrics
  let hits = 0
  let fallback = 0
  try {
    Object.defineProperty(proto, 'listGenerations', { ...generations, value: async function (signal) {
      const rows = await Reflect.apply(generations.value, this, [signal])
      signal?.throwIfAborted()
      const paths = rows.map(row => row.sourcePath)
      const { headers, ...stats } = variant === 'rust'
        ? await nativeBatch(binary, paths, signal) : await jsBatch(paths, signal)
      lookup = new Map(paths.map((path, index) => [path, headers[index]]))
      metrics = stats
      return rows
    } })
    Object.defineProperty(proto, 'readFirstZstdLine', { ...first, value: async function (path, signal) {
      signal?.throwIfAborted()
      const header = lookup.get(path)
      if (header != null) {
        hits++
        return header
      }
      fallback++
      return Reflect.apply(first.value, this, [path, signal])
    } })
    const row = await run()
    assert.ok(metrics && hits > 0)
    return { ...row, headerBatch: { ...metrics, hits, fallback } }
  } finally {
    Object.defineProperty(proto, 'readFirstZstdLine', first)
    Object.defineProperty(proto, 'listGenerations', generations)
  }
}

export async function checkHeaders(persistence, binary, root) {
  const frame = bytes => zstdCompressSync(Buffer.from(bytes), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 },
  })
  const good = frame('{"probe":"路径"}\n')
  const badChecksum = Buffer.from(good)
  badChecksum[badChecksum.length - 1] ^= 1
  const frames = [
    ['good', Buffer.concat([good, frame('events\n')])],
    ['bad-checksum', badChecksum],
    ['truncated', good.subarray(0, -2)],
    ['bad-magic', Buffer.from('not a Zstd frame')],
    ['extra-line', frame('{}\n{}\n')],
    ['absent', null],
  ]
  const paths = await Promise.all(frames.map(async ([name, bytes]) => {
    const path = join(root, 'control-' + name)
    if (bytes) await writeFile(path, bytes)
    return path
  }))
  const expected = []
  for (const path of paths) {
    try {
      expected.push(await persistence.readFirstZstdLine(path) ?? 'incomplete')
    } catch (error) {
      expected.push(error.code === 'ENOENT' ? 'absent' : error.constructor.name)
    }
  }
  assert.equal(expected[0], '{"probe":"路径"}')
  assert.equal(expected[2], 'incomplete')
  assert.equal(expected[5], 'absent')
  for (const index of [1, 3, 4]) assert.equal(expected[index], 'SessionPersistenceCorruptionError')
  const candidate = [expected[0], null, null, null, null, null]
  assert.deepEqual((await nativeBatch(binary, paths)).headers, candidate)
  assert.deepEqual((await jsBatch(paths)).headers, candidate)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(nativeBatch(binary, paths, aborted.signal), { name: 'AbortError' })
  await assert.rejects(jsBatch(paths, aborted.signal), { name: 'AbortError' })
  const running = new AbortController()
  const interrupted = nativeBatch(binary, paths, running.signal)
  running.abort()
  await assert.rejects(interrupted, { name: 'AbortError' })
  return Object.fromEntries(frames.map(([name], i) => [name, i === 0 ? 'matched' : expected[i]]))
}
