// issue #1528：rollback 失败必须留痕（warn + 落盘），陈旧的 `.backup-*` 必须有清理路径。
//
// 缺陷形态：`index.js` 只把错误塞进 `error.assetRollbackError`，既不 warn 也不落盘 ——
// 半态现场（新包已 rm、旧包 rename 不回来）事后无迹可查；`deferCommit` 后进程被杀还会留下
// 永不清理的 `.backup-<token>`。
//
// 判据全部是行为：真跑发布链路，看日志文件里有没有那一行、看陈旧目录有没有被删。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROLLBACK_FAILURE_LOG, publishBundle, pruneStaleBackups, recordRollbackFailure } from '../src/asset-bundle.js'

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-1528-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const asset = { sha256: 'a'.repeat(64), size: 1 }

function seedPackage(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}')
}

test('rollback 失败：必须落盘一行（含 token 与原因），且错误照旧抛出', () => withDir(async (root) => {
  const finalDirectory = join(root, 'sha')
  seedPackage(finalDirectory)
  const packageDirectory = join(root, 'staged')
  seedPackage(packageDirectory)
  const handle = await publishBundle({
    root, finalDirectory, packageDirectory, asset, unpackedSize: 1, token: 'tok1', deferCommit: true,
  })
  assert.ok(handle && typeof handle.rollback === 'function', 'deferCommit 必须返回 rollback 句柄')
  // 把备份删掉，让 rollback 的 rename 必然失败（旧包已不在）
  rmSync(join(root, '.backup-tok1'), { recursive: true, force: true })
  await assert.rejects(() => handle.rollback(), 'rollback 失败必须抛出，不得假装成功')
  const log = readFileSync(join(root, ROLLBACK_FAILURE_LOG), 'utf8').trim().split('\n')
  assert.equal(log.length, 1, '必须恰好落一行：' + log.join('|'))
  const entry = JSON.parse(log[0])
  assert.equal(entry.token, 'tok1', '必须能定位是哪一次发布')
  assert.ok(entry.error && entry.error.length > 0, '必须带原因')
})
)

test('pruneStaleBackups：只删陈旧的 .backup-*，新备份与普通目录不动', () => withDir(async (dir) => {
  const old = join(dir, '.backup-old')
  const fresh = join(dir, '.backup-fresh')
  const normal = join(dir, 'sha123')
  mkdirSync(old); mkdirSync(fresh); mkdirSync(normal)
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  utimesSync(old, twoHoursAgo, twoHoursAgo)
  const removed = await pruneStaleBackups(dir, { olderThanMs: 60 * 60 * 1000 })
  assert.deepEqual(removed, ['.backup-old'], '只该删陈旧的那个：' + JSON.stringify(removed))
  const left = readdirSync(dir).sort()
  assert.deepEqual(left, ['.backup-fresh', 'sha123'], '新备份与普通目录必须留着：' + JSON.stringify(left))
})
)

test('发布链路入口会真的清陈旧备份（接线判据，不只是函数本身）', () => withDir(async (root) => {
  const stale = join(root, '.backup-stale')
  mkdirSync(stale)
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000
  utimesSync(stale, twoHoursAgo, twoHoursAgo)
  const finalDirectory = join(root, 'sha')
  seedPackage(finalDirectory)
  const packageDirectory = join(root, 'staged')
  seedPackage(packageDirectory)
  await publishBundle({ root, finalDirectory, packageDirectory, asset, unpackedSize: 1, token: 'tok2', deferCommit: true })
  const left = readdirSync(root)
  assert.ok(!left.includes('.backup-stale'), '陈旧备份必须被发布链路入口清掉：' + JSON.stringify(left))
})
)

test('recordRollbackFailure：写日志失败不得改变控制流（best-effort）', async () => {
  // 传一个不可写的 root：函数不得抛，调用方仍能拿到原始错误
  await recordRollbackFailure('/definitely/not/writable/root', 'tok', new Error('boom'))
})