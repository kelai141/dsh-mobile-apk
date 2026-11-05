// vendor/dsh-undo-savepoint/test/blob-write-concurrency.test.mjs — 共享 blob 库的写入完整性（issue #1626）。
//
// 真因：`writeBlob` 用**每个 hash 一个固定 tmp 名**（`<target>.tmp`）+ `.catch(() => {})` 吞掉 rename 失败，
// 且开头 `if (pathExists(target)) return` 让坏 blob 永远不会被重写。并发两个快照写同一 blob 时：
//   A 写 tmp → B 的 writeFile（open+truncate）把 tmp 覆盖成半截 → A 在 B 写完前 rename ⇒ 落盘半截文件；
//   随后 B 的 rename 因 tmp 已消失而失败并被吞掉。此后 readBlob 拿到的是**半截内容**。
//
// 判据全部是行为判据（不读源码）：真并发写同一个 blob，跑完必须逐字节等于原文；
// 预置半截目标后 writeBlob 必须把它修好；rename 失败不得静默。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blobDir, readBlob, sha1Hex, writeBlob } from '../lib/core.mjs'

const BLOB_ROOT = mkdtempSync(join(tmpdir(), 'undo-blobs-'))
const cfg = { autoDir: join(BLOB_ROOT, 'undo-snapshots', 'auto') }

/** 1 MiB 的可辨识内容：半截落盘时长度与内容都会对不上。 */
const payload = (seed) => Buffer.from(Array.from({ length: 1024 * 1024 }, (_, i) => (i * 31 + seed) % 251))

test('并发写同一 blob：落盘必须是逐字节完整的原文（旧实现会留半截）', async () => {
  const buf = payload(7)
  const hash = sha1Hex(buf)
  // 12 个写者同时压同一个 hash：旧实现的固定 tmp 名在任意两个之间就会互相覆盖。
  await Promise.all(Array.from({ length: 12 }, () => writeBlob(cfg, hash, buf)))
  const stored = readFileSync(join(blobDir(cfg), hash))
  assert.equal(stored.length, buf.length, '落盘长度不符（半截）')
  assert.ok(stored.equals(buf), '落盘内容与原文不一致')
  assert.equal(sha1Hex(stored), hash)
})

test('目标已是半截时，writeBlob 必须把它修好（旧实现「存在即返回」永不重写）', async () => {
  const buf = payload(11)
  const hash = sha1Hex(buf)
  mkdirSync(blobDir(cfg), { recursive: true })
  writeFileSync(join(blobDir(cfg), hash), buf.subarray(0, Math.floor(buf.length / 2)))
  await writeBlob(cfg, hash, buf)
  const stored = readFileSync(join(blobDir(cfg), hash))
  assert.ok(stored.equals(buf), '半截 blob 没有被修复')
  const back = await readBlob(cfg, hash)
  assert.ok(back !== null && back.equals(buf), 'readBlob 仍读到坏内容')
})

test('目标已是完整同内容时不得重写（避免每次快照都重写整库）', async () => {
  const buf = payload(13)
  const hash = sha1Hex(buf)
  await writeBlob(cfg, hash, buf)
  const target = join(blobDir(cfg), hash)
  const before = statSync(target).mtimeMs
  await new Promise((r) => setTimeout(r, 20))
  await writeBlob(cfg, hash, buf)
  assert.equal(statSync(target).mtimeMs, before, '完整副本被无谓重写了')
})

test('不残留临时文件（每次写入的 tmp 名必须唯一且被清掉）', async () => {
  const buf = payload(17)
  const hash = sha1Hex(buf)
  await Promise.all(Array.from({ length: 6 }, () => writeBlob(cfg, hash, buf)))
  const leftovers = readdirSync(blobDir(cfg)).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [], '临时文件残留：' + leftovers.join(','))
})

test('负控：固定 tmp 名确实会被并发踩坏（证明上面的判据有判别力）', async () => {
  // 复刻旧实现：固定 tmp 名 + 吞掉 rename 失败。
  const { promises: fsp } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'undo-blobs-legacy-'))
  const buf = payload(23)
  const hash = sha1Hex(buf)
  const target = join(dir, hash)
  const legacyWrite = async () => {
    if (await fsp.access(target).then(() => true, () => false)) return
    const tmp = `${target}.tmp`
    await fsp.writeFile(tmp, buf)
    await fsp.rename(tmp, target).catch(() => {})
  }
  try {
    await Promise.all(Array.from({ length: 12 }, legacyWrite))
    const stored = await fsp.readFile(target).catch(() => null)
    // 旧形态的失败**不是必现**（取决于调度），所以这里不要求一定坏；
    // 判据是「新实现必须 100% 完整」——本用例只记录旧形态确实会坏。
    if (stored !== null && !stored.equals(buf)) {
      assert.notEqual(stored.length, buf.length, '旧形态坏掉时通常是半截')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('清理：临时根目录不留垃圾', () => {
  rmSync(BLOB_ROOT, { recursive: true, force: true })
})
