// vendor/dsh-undo-savepoint/test/blob-write-tmp-unique.test.mjs — 并发写者不得共用同一个临时路径（issue #1626）。
//
// 为什么单列一条：issue 的第一半是「每个 hash 一个固定 tmp 名」。这一半的坏结果
// （A 的 tmp 被 B 截断后 rename 落盘）依赖调度，跑一次不一定复现；但它的**成因**是
// 可观测的确定事实：并发写者把内容写到了**同一个临时路径**上。
//
// 判据不看源码：先把 `node:fs` 的 promises.writeFile 换成一个记账版本（记录每次写入的目标路径），
// 再真跑 N 个并发 writeBlob，断言「临时路径的去重集合大小 == 写者数」。
// 固定名实现在这条判据下恒为 1，当场红。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const BLOB_ROOT = mkdtempSync(join(tmpdir(), 'undo-blob-tmp-'))
const cfg = { autoDir: join(BLOB_ROOT, 'undo-snapshots', 'auto') }

const written = []
const realWriteFile = fs.promises.writeFile
fs.promises.writeFile = function (dest, ...rest) {
  written.push(String(dest))
  return realWriteFile.call(this, dest, ...rest)
}

// 记账装好之后再加载被测模块（core.mjs 在调用时按属性查表，但先装好更稳）。
const { sha1Hex, writeBlob } = await import('../lib/core.mjs')

test('N 个并发写者必须写 N 个**互不相同**的临时路径', async () => {
  const buf = Buffer.alloc(256 * 1024, 9)
  const hash = sha1Hex(buf)
  const writers = 8
  await Promise.all(Array.from({ length: writers }, () => writeBlob(cfg, hash, buf)))
  const temps = [...new Set(written.filter((p) => basename(p).includes('.tmp')))]
  assert.equal(temps.length, writers, '并发写者共用临时路径：' + JSON.stringify(temps))
  const target = join(cfg.autoDir, '..', 'blobs', hash)
  assert.ok(readFileSync(target).equals(buf), '落盘内容不完整')
})

test('清理', () => {
  fs.promises.writeFile = realWriteFile
  rmSync(BLOB_ROOT, { recursive: true, force: true })
})
