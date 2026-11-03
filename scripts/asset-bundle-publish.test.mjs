// issue #1375：publish 的回滚失败不得被吞；备份清理必须在成功之后且在 try 之外；
// .backup-* 必须有人回收（原先只清 .stage-*）。
//
// 判据跑**真实源码**（plugins/dsh-linux-bootstrap/src/asset-bundle.js 的导出函数）。
//
// 关于「回滚失败」这一支：它需要「第一次 rename 失败 + 回滚 rename 也失败」同时成立，
// 而这个模块没有 fs 注入缝（直接 import node:fs/promises），无法在测试里稳定构造该交错。
// 所以该支由**源码契约**钉住（AggregateError 在场 + 函数体内无 .catch(() => {})），
// 不假装成行为用例。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const SOURCE = readFileSync(new URL('../plugins/dsh-linux-bootstrap/src/asset-bundle.js', import.meta.url), 'utf8')
const MOD = await import(new URL('../plugins/dsh-linux-bootstrap/src/asset-bundle.js', import.meta.url).href)

/** publishBundle 的函数体（本文件顶层函数以列 0 的 } 结束）。 */
function publishBody() {
  const start = SOURCE.indexOf('export async function publishBundle(')
  assert.ok(start > 0, '必须存在 export publishBundle')
  const end = SOURCE.indexOf('\n}\n', start)
  assert.ok(end > start, 'publishBundle 必须能被完整取出')
  return SOURCE.slice(start, end)
}

const ASSET = { sha256: 'a'.repeat(64), size: 1, unpackedSize: 1 }

test('#1375 发布成功：旧副本被换下、.backup-* 不残留', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-bundle-1375-'))
  const final = join(root, ASSET.sha256)
  mkdirSync(final, { recursive: true })
  writeFileSync(join(final, 'old.txt'), 'old')
  const pkg = join(root, 'pkg-new')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'new.txt'), 'new')

  await MOD.publishBundle({ root, finalDirectory: final, packageDirectory: pkg, asset: ASSET, unpackedSize: 1, token: 'tok1' })

  assert.ok(statSync(join(final, 'new.txt')).isFile(), '新包必须就位')
  assert.equal(statSync(join(final, 'old.txt'), { throwIfNoEntry: false }), undefined, '旧内容必须已被换下')
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('.backup-')), [], '发布成功后不得残留 .backup-*')
  rmSync(root, { recursive: true, force: true })
})

test('#1375 发布失败：回滚把旧副本放回原位', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-bundle-1375-'))
  const final = join(root, ASSET.sha256)
  mkdirSync(final, { recursive: true })
  writeFileSync(join(final, 'old.txt'), 'old')

  await assert.rejects(
    () => MOD.publishBundle({ root, finalDirectory: final, packageDirectory: join(root, 'missing'), asset: ASSET, unpackedSize: 1, token: 'tok2' }),
    (error) => error instanceof Error && !(error instanceof AggregateError),
    '只失败一次时不该抛 AggregateError（回滚是成功的）',
  )
  assert.ok(statSync(join(final, 'old.txt')).isFile(), '回滚必须把旧副本放回原位')
  rmSync(root, { recursive: true, force: true })
})

test('#1375 sweepStaleBundleDirs 只清超龄的 .backup-* / .stage-*，不动别的目录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'asset-bundle-1375-'))
  for (const name of ['.backup-old', '.stage-old', '.backup-fresh', 'plain-dir']) mkdirSync(join(root, name), { recursive: true })
  const past = (Date.now() - 60 * 60 * 1000) / 1000
  utimesSync(join(root, '.backup-old'), past, past)
  utimesSync(join(root, '.stage-old'), past, past)

  const removed = await MOD.sweepStaleBundleDirs(root)

  assert.deepEqual(removed.slice().sort(), ['.backup-old', '.stage-old'])
  assert.deepEqual(readdirSync(root).sort(), ['.backup-fresh', 'plain-dir'], '新鲜的备份与普通目录必须留下')
  rmSync(root, { recursive: true, force: true })
})

test('#1375 源码契约：publishBundle 内不得吞错，回滚失败必须显式上报', () => {
  // 先剥掉注释：本文件里注释会**引用**旧写法（rename(...).catch(() => {})），
  // 不剥就会把「解释缺陷」误判成「仍有缺陷」。
  const code = publishBody().split('\n')
    .filter((line) => {
      const s = line.trimStart()
      return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'))
    })
    .join('\n')
  assert.equal(/\.catch\(\(\) => \{\}\)/.test(code), false,
    'publishBundle 内仍有 .catch(() => {})：回滚或清理失败会被静默吞掉')
  assert.ok(code.includes('AggregateError'), '回滚失败必须显式上报（AggregateError）')
  assert.ok(code.includes('previous copy remains at'), '必须点明旧包还在哪个目录')
})

test('#1375 源码契约：备份清理在发布 try 之外（rm 抛错不得把成功改判为失败）', () => {
  const body = publishBody()
  const renameAt = body.indexOf('await rename(packageDirectory, finalDirectory)')
  const catchAt = body.indexOf('} catch (error) {', renameAt)
  const cleanupAt = body.indexOf('await rm(backupDirectory, { recursive: true, force: true })')
  assert.ok(renameAt > 0 && cleanupAt > renameAt, '清理必须在发布 rename 之后')
  assert.ok(catchAt > renameAt && cleanupAt > catchAt,
    '清理必须落在发布 try/catch 之外，否则 rm 失败会被当成发布失败')
})