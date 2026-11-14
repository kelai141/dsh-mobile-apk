import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deleteStoredSession, quarantineStoredSession, sweepGraveyards } from '../src/session-delete.js'

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
