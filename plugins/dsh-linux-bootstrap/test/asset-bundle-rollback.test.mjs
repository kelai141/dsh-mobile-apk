import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { publishBundle } from '../src/asset-bundle.js'

/** 造一个 root：旧包已发布在 <root>/<sha256>，新包在别处待发布。 */
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-1374-'))
  const finalDirectory = path.join(root, 'abc123')
  await mkdir(finalDirectory, { recursive: true })
  await writeFile(path.join(finalDirectory, 'old-marker.txt'), 'old')
  const staging = path.join(root, 'stage')
  await mkdir(staging, { recursive: true })
  await writeFile(path.join(staging, 'new-marker.txt'), 'new')
  const asset = { sha256: 'abc123', size: 10, unpackedSize: 3 }
  return { root, finalDirectory, packageDirectory: staging, asset }
}

const backups = async (root) => (await readdir(root)).filter((n) => n.startsWith('.backup-'))

test('deferCommit keeps the previous copy until commit (issue #1374)', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const handle = await publishBundle({ ...f, unpackedSize: 3, token: 'tk1', deferCommit: true })
  assert.ok(handle && typeof handle.commit === 'function' && typeof handle.rollback === 'function',
    'deferCommit=true must return a commit/rollback handle')
  // 新包已就位
  assert.equal(await readFile(path.join(f.finalDirectory, 'new-marker.txt'), 'utf8'), 'new')
  // 旧包**仍在备份里**（这正是能回滚的前提；默认路径会立刻删掉它）
  assert.deepEqual((await backups(f.root)).length, 1, 'backup must be deferred, not deleted')
  await handle.commit()
  assert.deepEqual(await backups(f.root), [], 'commit must drop the backup')
  assert.equal(await readFile(path.join(f.finalDirectory, 'new-marker.txt'), 'utf8'), 'new')
})

test('rollback restores the previous copy after a later failure (issue #1374)', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const handle = await publishBundle({ ...f, unpackedSize: 3, token: 'tk2', deferCommit: true })
  await handle.rollback()
  // 旧包回到原位、新包已移走
  assert.equal(await readFile(path.join(f.finalDirectory, 'old-marker.txt'), 'utf8'), 'old')
  await assert.rejects(() => readFile(path.join(f.finalDirectory, 'new-marker.txt'), 'utf8'))
  assert.deepEqual(await backups(f.root), [], 'rollback must consume the backup')
})

test('the caller rolls the assets back BEFORE rolling the host scope back (issue #1374)', async () => {
  // 接线判据：publish 成功之后 host 安装/激活才失败的那条路径，必须**先回滚资产**
  // 再回滚 host scope。反过来会留下「host 已回滚、磁盘仍是新包」——正是本 issue 的半态。
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  const catchAt = src.indexOf('} catch (error) {')
  assert.ok(catchAt > 0, 'index.js must have the install catch block')
  const block = src.slice(catchAt, src.indexOf('state.lastError = safeError(error)', catchAt))
  const assetAt = block.indexOf('assetHandle?.rollback')
  const hostAt = block.indexOf('hostResult?.rollback')
  assert.ok(assetAt >= 0, 'catch must roll the published assets back')
  assert.ok(hostAt >= 0, 'catch must still roll the host scope back')
  assert.ok(assetAt < hostAt, 'asset rollback must come first')
  // 提交点必须在激活成功之后，且失败时不丢错误
  assert.ok(src.includes('assetRollbackError'), 'a failed asset rollback must be recorded, not swallowed')
  assert.ok(src.includes('assetHandle?.commit'), 'a successful install must commit (drop the backup)')
})

test('default behaviour is unchanged: no deferred backup, no handle', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.root, { recursive: true, force: true }))
  const handle = await publishBundle({ ...f, unpackedSize: 3, token: 'tk3' })
  assert.equal(handle, null, 'without deferCommit the old semantics must hold')
  assert.deepEqual(await backups(f.root), [], 'backup must be cleaned immediately')
  assert.equal(await readFile(path.join(f.finalDirectory, 'new-marker.txt'), 'utf8'), 'new')
})
