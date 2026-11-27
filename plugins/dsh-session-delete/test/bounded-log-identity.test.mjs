// 投影核对的 zstd 身份读取：只做**有界首行**读取，不再为一行身份读/解整份日志；
// 身份无法确定（损坏、截断、超过字节上限、目录扫描不完整）时必须保留缓存。
//
// 旧实现：readFile(整份日志) + zstdDecompressSync。日志是会话历史，动辄几十上百 MB；
// 启动核对却只需要第一行身份。这里用流式解压，压缩输入上限 1 MiB、解压首行上限 8 KiB，
// 取到换行就停 —— 主线程不再做整份同步解压。
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { constants, zstdCompressSync } from 'node:zlib'
import { sweepOrphanProjectionCaches } from '../src/session-delete.js'

const ID = 'session-12345678-1234-4abc-8def-1234567890ab'

/** 与 dsh-session-projection-cache 落盘一致的缓存文档。 */
function cacheDoc(id, createdAt, formatVersion = 4) {
  return JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion, createdAt, cwd: '/ws', isSeeded: false, inheritedEventCount: 0 },
      rows: { title: { ver: 1, seq: 0, val: 'title-' + id } },
    },
  })
}

/** 一行身份头（引擎保证第一个 zstd frame 就是这一行）。 */
function headerLine(id, createdAt, version = 4) {
  return JSON.stringify({ version, id, createdAt, cwd: '/ws', isSeeded: false }) + '\n'
}

function zstdFrame(buffer) {
  return zstdCompressSync(buffer, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bounded-identity-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const sessionDir = join(home, 'sessions', 'workspace', ID)
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(sessionDir, { recursive: true })
  await mkdir(cacheDir, { recursive: true })
  return { home, sessionDir, cacheDir }
}

test('8 MiB zstd log: identity is resolved from the bounded first line', async (t) => {
  const { home, sessionDir, cacheDir } = await fixture(t)
  const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
  const cachePath = join(cacheDir, ID + '.json')

  // 单个 8 MiB frame：身份行 + 大量历史。旧实现把整帧读进内存再同步解压；
  // 有界首行读取只喂到换行为止（压缩输入上限 1 MiB），大日志仍能识别身份。
  const body = randomBytes(8 * 1024 * 1024)
  await writeFile(logPath, zstdFrame(Buffer.concat([Buffer.from(headerLine(ID, 2000)), body])))
  assert.ok((await stat(logPath)).size > 1024 * 1024, '夹具必须是真正的「大体积」日志')

  // 缓存身份 createdAt=1000，日志身份 2000：读到身份才会删；读不到就会保留。
  await writeFile(cachePath, cacheDoc(ID, 1000))

  const result = await sweepOrphanProjectionCaches(home)
  assert.equal(result.aborted, false)
  assert.deepEqual(result.removed, [cachePath], '必须靠首行身份判定为「重建后的新会话」并清掉旧缓存')
  await assert.rejects(() => readFile(cachePath, 'utf8'), { code: 'ENOENT' })
})

test('a zstd log truncated inside its first block keeps the projection cache', async (t) => {
  const { home, sessionDir, cacheDir } = await fixture(t)
  const cachePath = join(cacheDir, ID + '.json')
  const frame = zstdFrame(Buffer.from(headerLine(ID, 2000)))
  // 砍在第一个 block 里：首行拼不出来，身份必须判为未知而不是「不是同一个会话」。
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), frame.subarray(0, 15))
  await writeFile(cachePath, cacheDoc(ID, 1000))

  const result = await sweepOrphanProjectionCaches(home)
  assert.equal(result.aborted, false)
  assert.deepEqual(result.removed, [])
  assert.ok((await readFile(cachePath, 'utf8')).includes(ID))
})

test('unknown identity (non-zstd bytes) keeps the projection cache', async (t) => {
  const { home, sessionDir, cacheDir } = await fixture(t)
  const cachePath = join(cacheDir, ID + '.json')
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), randomBytes(4096))
  await writeFile(cachePath, cacheDoc(ID, 1000))

  const result = await sweepOrphanProjectionCaches(home)
  assert.equal(result.aborted, false)
  assert.deepEqual(result.removed, [])
  assert.ok((await readFile(cachePath, 'utf8')).includes(ID), '身份读不出来时必须原样保留缓存')
})

test('a first line beyond the byte bound keeps the projection cache', async (t) => {
  const { home, sessionDir, cacheDir } = await fixture(t)
  const cachePath = join(cacheDir, ID + '.json')
  // 没有换行、且解压输出远超 8 KiB 首行上限：有界读取必须放弃并让调用方保留缓存。
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdFrame(Buffer.from('x'.repeat(9000))))
  await writeFile(cachePath, cacheDoc(ID, 1000))

  const result = await sweepOrphanProjectionCaches(home)
  assert.equal(result.aborted, false)
  assert.deepEqual(result.removed, [])
  assert.ok((await readFile(cachePath, 'utf8')).includes(ID))
})

test('a corrupt first line (unparsable JSON) keeps the projection cache', async (t) => {
  const { home, sessionDir, cacheDir } = await fixture(t)
  const cachePath = join(cacheDir, ID + '.json')
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), zstdFrame(Buffer.from('not-json\n')))
  await writeFile(cachePath, cacheDoc(ID, 1000))

  const result = await sweepOrphanProjectionCaches(home)
  assert.equal(result.aborted, false)
  assert.deepEqual(result.removed, [])
  assert.ok((await readFile(cachePath, 'utf8')).includes(ID))
})

test('an incomplete sessions scan keeps the projection cache (fail-closed)', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bounded-scan-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, ID + '.json')
  await writeFile(cachePath, cacheDoc(ID, 1000))
  // sessions 是不可读目录（普通文件）⇒ 扫描不完整；此时不得把「没看见会话目录」当成孤儿。
  await writeFile(join(home, 'sessions'), 'not a directory')

  const result = await sweepOrphanProjectionCaches(home)
  assert.equal(result.aborted, true, '扫描不完整必须报 aborted')
  assert.deepEqual(result.removed, [])
  assert.ok((await readFile(cachePath, 'utf8')).includes(ID), '目录扫描不完整时绝不误删')
})

test('zstd identity sniffing is bounded in source: streaming, capped, no whole-file read', () => {
  const source = readFileSync(new URL('../src/session-delete.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.equal(/zstdDecompressSync\s*\(/.test(source), false, '不得恢复整份同步解压')
  assert.match(source, /createZstdDecompress\(/, '必须走流式解压')
  assert.match(source, /SESSION_LOG_HEADER_MAX_INPUT_BYTES/, '压缩输入必须有明确上限')
  assert.match(source, /SESSION_LOG_HEADER_MAX_BYTES/, '解压后的首行必须有明确上限')
  assert.equal(/readFile\(filePath\)/.test(source), false, '身份路径不得整份读日志（readFile 只许读缓存 JSON）')
})
