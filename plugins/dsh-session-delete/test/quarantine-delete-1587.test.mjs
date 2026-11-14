import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deleteStoredSession, inspectQuarantine, quarantineStoredSession, sweepGraveyards } from '../src/session-delete.js'

const ID = 'session-12345678-1234-4abc-8def-1234567890ab'
const OTHER = 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-quarantine-delete-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'sessions', 'workspace')
  await mkdir(join(root, ID), { recursive: true })
  await writeFile(join(root, ID, 'history'), 'private conversation')
  return { home, root }
}
async function copy(root, id = ID, timestamp = '1700000000000') {
  const dir = join(root, '.corrupt', id + '.' + timestamp)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'history'), 'private conversation')
  return dir
}

test('#1587: quarantine then permanent delete removes the actual files; retry is truly not-found', async t => {
  const { home } = await fixture(t)
  const first = await quarantineStoredSession({ home, sessionId: ID })
  assert.equal((await deleteStoredSession({ home, sessionId: ID })).ok, true)
  assert.equal(existsSync(first.quarantinedTo), false)
  await assert.rejects(deleteStoredSession({ home, sessionId: ID }), { code: 'not-found' })
})

test('#1587: permanent delete covers stored and multiple quarantined copies across workspaces', async t => {
  const { home, root } = await fixture(t)
  const copies = [await copy(root), await copy(root, ID, '1700000000001'),
    await copy(join(home, 'sessions', 'other-workspace'))]
  const unrelated = await copy(root, OTHER)
  await deleteStoredSession({ home, sessionId: ID })
  assert.equal(existsSync(join(root, ID)), false)
  for (const path of copies) assert.equal(existsSync(path), false, path)
  assert.equal(existsSync(unrelated), true)
})

test('#1587: running and ambiguous sessions preserve all quarantine copies', async t => {
  const { home, root } = await fixture(t)
  const path = await copy(root)
  await assert.rejects(deleteStoredSession({ home, sessionId: ID, isActive: true }), { code: 'session-active' })
  await mkdir(join(home, 'sessions', 'duplicate', ID), { recursive: true })
  await assert.rejects(deleteStoredSession({ home, sessionId: ID }), { code: 'ambiguous' })
  assert.equal(existsSync(path), true)
  assert.equal(existsSync(join(root, ID)), true)
})

test('#1587: malformed quarantine never becomes successful not-found', async t => {
  const { home, root } = await fixture(t)
  await writeFile(join(root, '.corrupt'), 'not a directory')
  // 会话本身在场：删得掉就照常删（形态异常只挡住「这个工作区里的副本」，不挡本会话）。
  //
  // 边界收窄的理由：旧实现在这里直接 delete-failed，于是**任意**工作区的一个杂散
  // .corrupt 文件就让整台设备的会话都删不掉 —— 错误文案还是「隔离区不是真目录」，
  // 用户没有任何可行动信息。实测：目标会话完好、在别的工作区，仍报 delete-failed。
  assert.equal((await deleteStoredSession({ home, sessionId: ID })).ok, true)
  assert.equal(existsSync(join(root, ID)), false)
  // 一处都没命中且隔离区形态异常时，仍不得冒充 not-found（文件可能就藏在里面）。
  await assert.rejects(deleteStoredSession({ home, sessionId: ID }), { code: 'delete-failed' })
})

test('#1587: removal failure reports leftover; retry removes it without restart', async t => {
  const { home } = await fixture(t)
  await quarantineStoredSession({ home, sessionId: ID })
  let leftover
  await assert.rejects(deleteStoredSession({ home, sessionId: ID,
    removeDir: async () => { throw Object.assign(new Error('controlled EACCES'), { code: 'EACCES' }) },
  }), error => {
    leftover = error.details?.graveyard
    return error.code === 'delete-failed' && error.details?.leftover === true && error.details?.errno === 'EACCES'
  })
  assert.equal(existsSync(leftover), true)
  await deleteStoredSession({ home, sessionId: ID })
  assert.equal(existsSync(leftover), false)
})

test('#1587: unload failure restores a quarantine copy and reports failure', async t => {
  const { home } = await fixture(t)
  const { quarantinedTo } = await quarantineStoredSession({ home, sessionId: ID })
  await assert.rejects(deleteStoredSession({ home, sessionId: ID,
    afterResolve: async () => { throw new Error('controlled unload failure') },
  }), { code: 'delete-failed' })
  assert.equal(existsSync(quarantinedTo), true)
})

test('#1587: quarantine directory links cannot turn deletion into traversal of another tree', async t => {
  const { home, root } = await fixture(t)
  const external = join(home, 'outside')
  const path = await copy(external)
  await symlink(join(external, '.corrupt'), join(root, '.corrupt'), 'junction')
  await assert.rejects(deleteStoredSession({ home, sessionId: ID }), { code: 'delete-failed' })
  assert.equal(existsSync(path), true)
  assert.equal(existsSync(join(root, ID)), true)
})

test('#1587: a quarantined entry that is a link must not be reported as absent or deleted', async t => {
  const { home, root } = await fixture(t)
  const external = join(home, 'outside')
  await mkdir(external)
  await writeFile(join(external, 'history'), 'keep')
  await mkdir(join(root, '.corrupt'))
  await symlink(external, join(root, '.corrupt', ID + '.1700000000000'), 'junction')
  await assert.rejects(deleteStoredSession({ home, sessionId: ID }), { code: 'delete-failed' })
  assert.equal(existsSync(join(external, 'history')), true)
})

test('#1587: startup sweeps deletion leftovers inside quarantine but retains recoverable copies', async t => {
  const { home, root } = await fixture(t)
  const recoverable = await copy(root)
  const leftover = await copy(root, ID, '1700000000001.deleting-abc.deleting-def')
  const unrelated = join(root, '.corrupt', 'notes.deleting-abc')
  await mkdir(unrelated)
  assert.deepEqual(await sweepGraveyards(home), [leftover])
  for (const path of [recoverable, unrelated, join(root, ID)]) assert.equal(existsSync(path), true)
})

test('#1587 negative control: omitting quarantine discovery reproduces false not-found with files remaining', async t => {
  const { home } = await fixture(t)
  const { quarantinedTo } = await quarantineStoredSession({ home, sessionId: ID })
  const source = readFileSync(new URL('../src/session-delete.js', import.meta.url), 'utf8')
  const old = source.replace(
    'const quarantined = await findQuarantinedDirs(root, sessionId, { onProblems: (p) => quarantineProblems.push(...p) })',
    'const quarantined = []',
  )
  assert.ok(old !== source)
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(old).toString('base64'))
  await assert.rejects(mutant.deleteStoredSession({ home, sessionId: ID }), { code: 'not-found' })
  assert.equal(existsSync(quarantinedTo), true)
})
test('#1587: a stray .corrupt file in an unrelated workspace must not block this session', async t => {
  const { home, root } = await fixture(t)
  // 无关工作区里的杂散普通文件（用户手动/旧版本遗留/同步工具/解压事故都会产生）。
  const other = join(home, 'sessions', 'ws-unrelated')
  await mkdir(other, { recursive: true })
  await writeFile(join(other, '.corrupt'), 'stray file')
  const warnings = []
  const result = await deleteStoredSession({ home, sessionId: ID, logger: (_l, message) => warnings.push(message) })
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(root, ID)), false)
  // 被忽略的异常必须留痕，否则「这个工作区里的副本看得见吗」没有线索。
  assert.equal(warnings.some((w) => w.includes('quarantine anomaly ignored')), true)
})

// ── #1587 第二条残留面：删除进行到一半留下的 `<id>.deleting-*` ────────────────
//
// deleteStoredSession 的最后一步是 rm；它失败（EACCES / 磁盘满）或进程被杀时，目录停在
// `<id>.deleting-*`。此后 findSessionDir 只报 not-found（名字已不是 id）、隔离查找只看
// .corrupt/，于是路由 404 → 客户端按「已删除」收尾，而整份数据仍在磁盘上，**重试也删不掉**
// （只能等下次启动 sweep）。修前实测：只剩墓地目录时 deleteStoredSession 抛 not-found，
// 目录存在 = true。
async function graveyard(root, id = ID, slug = 'abc') {
  const dir = join(root, id + '.deleting-' + slug)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'history'), 'private conversation')
  return dir
}

test('#1587: 只剩上次删除的墓地目录时，重试必须真的清掉它而不是报 not-found', async t => {
  const { home, root } = await fixture(t)
  await rm(join(root, ID), { recursive: true, force: true })
  const leftover = await graveyard(root)
  const result = await deleteStoredSession({ home, sessionId: ID })
  assert.equal(result.ok, true)
  assert.equal(result.dir, leftover, '回执必须指向真正被清掉的那个目录')
  assert.equal(existsSync(leftover), false, '墓地目录必须被清掉，而不是「报成功但文件还在」')
})

test('#1587: 墓地目录与存储目录/隔离副本一起命中时全部清理，且不碰别的会话', async t => {
  const { home, root } = await fixture(t)
  const storedCopy = await copy(root)
  const leftover = await graveyard(root)
  const unrelated = await copy(root, OTHER)
  await deleteStoredSession({ home, sessionId: ID })
  for (const path of [join(root, ID), storedCopy, leftover]) assert.equal(existsSync(path), false, path)
  assert.equal(existsSync(unrelated), true, '别的会话的隔离件不得被牵连')
})

test('#1587: 隔离入口遇到只剩墓地目录时报 deletion-incomplete，不给可恢复假象', async t => {
  const { home, root } = await fixture(t)
  await rm(join(root, ID), { recursive: true, force: true })
  const leftover = await graveyard(root)
  await assert.rejects(quarantineStoredSession({ home, sessionId: ID }), (error) => {
    assert.equal(error.code, 'deletion-incomplete')
    assert.deepEqual(error.details?.paths, [leftover])
    return true
  })
  assert.equal(existsSync(leftover), true, '报错不得顺手删掉数据')
})

// issue #1587 的「磁盘单调增长」那一半：隔离件**不自动过期**（可恢复承诺，删了就是替用户
// 删历史），但「.corrupt/ 吃了多少」必须可查 —— 否则用户报「存储一直涨」时无从下手。
test('#1587: 隔离区占用可清点；清点不删除、不越界', async t => {
  const { home, root } = await fixture(t)
  const kept = await copy(root)
  const { quarantinedTo } = await quarantineStoredSession({ home, sessionId: ID })
  // 第二个工作区的另一份隔离件也要算进来（按 home 清点，不只看一个工作区）。
  const other = await copy(join(home, 'sessions', 'ws-other'), OTHER, '1700000000002')
  const report = await inspectQuarantine(home)
  assert.equal(report.count, 3, '跨工作区的隔离件都要清点在内')
  assert.equal(report.bytes > 0, true, '必须给出字节数，否则「吃掉多少」还是不可见')
  assert.deepEqual(report.dirs.slice().sort(), [kept, other, quarantinedTo].sort())
  // 清点是只读的：跑完文件必须原样在（可恢复承诺不受影响）。
  for (const path of [kept, other, quarantinedTo]) assert.equal(existsSync(path), true, path)
})

test('#1587: 没有隔离区时清点返回空且不抛', async t => {
  const { home } = await fixture(t)
  assert.deepEqual(await inspectQuarantine(home), { count: 0, bytes: 0, dirs: [] })
  assert.deepEqual(await inspectQuarantine(''), { count: 0, bytes: 0, dirs: [] })
})

test('#1587: 墓地目录里的链接不参与删除（不得顺着链接删树外）', async t => {
  const { home, root } = await fixture(t)
  await rm(join(root, ID), { recursive: true, force: true })
  const external = join(home, 'outside')
  await mkdir(external, { recursive: true })
  await writeFile(join(external, 'history'), 'keep')
  await symlink(external, join(root, ID + '.deleting-link'), 'junction')
  // 同名的真目录必须照删：链接跳过不能退化成「整类目录都不处理」。
  const real = await graveyard(root, ID, 'real')
  await deleteStoredSession({ home, sessionId: ID })
  assert.equal(existsSync(real), false, '真墓地目录必须被清掉')
  assert.equal(existsSync(join(external, 'history')), true, '树外数据必须完好')
})
