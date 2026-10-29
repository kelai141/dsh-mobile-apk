// issue #912：坏会话**隔离**（不是删除）的三条不变式。
//
// 背景：v0→v1 迁移拒绝某条 user/message 是**上游**判定（session-format-v0-to-v1），
// 修它要 engine 补丁 + 真实夹具（当前造不出来）。读不出历史的会话本身已不可用，
// 用户需要的是「别再挡着我」+「数据还能拿回来」，所以做隔离而不是删除、也不是改上游。
//
// 三条不变式（各自一条用例）：
//  ① 隔离后该会话**不再出现在扫描路径上**（列表里消失）；
//  ② 隔离**不碰其它会话**；
//  ③ 隔离**可逆** —— 文件原样保留，rename 回去即恢复。
//
// 另外：隔离必须**用户手动触发**（本模块只提供能力，不做自动隔离）——
// 自动隔离等于替用户删历史。
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  QUARANTINE_DIR,
  SessionDeleteError,
  findSessionDir,
  quarantineStoredSession,
  sessionsRoot,
} from '../src/session-delete.js'

const ID = 'session-12345678-1234-4abc-8def-1234567890ab'
const OTHER = 'session-aaaabbbb-cccc-4ddd-8eee-ffff00001111'
const KEY = '--workspace--'

async function homeWith(ids) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-quarantine-'))
  for (const id of ids) {
    const dir = join(sessionsRoot(home), KEY, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.lock'), '')
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
  }
  return home
}

test('① 隔离后该会话不再出现在扫描路径上，且隔离件在 .corrupt 下', async () => {
  const home = await homeWith([ID])
  const r = await quarantineStoredSession({ home, sessionId: ID })
  assert.equal(r.ok, true)
  assert.equal(r.restorable, true)
  await assert.rejects(
    findSessionDir(sessionsRoot(home), ID),
    (error) => error instanceof SessionDeleteError && error.code === 'not-found',
  )
  assert.ok(r.quarantinedTo.includes(QUARANTINE_DIR), '隔离件必须在 .corrupt 下')
  assert.equal((await stat(r.quarantinedTo)).isDirectory(), true)
})

test('② 隔离不碰其它会话', async () => {
  const home = await homeWith([ID, OTHER])
  const otherBefore = await findSessionDir(sessionsRoot(home), OTHER)
  await quarantineStoredSession({ home, sessionId: ID })
  const otherAfter = await findSessionDir(sessionsRoot(home), OTHER)
  assert.equal(otherAfter, otherBefore)
  assert.equal((await stat(join(otherAfter, 'session.v4.jsonl.zstd'))).size, 1)
})

test('③ 隔离可逆：文件仍在，rename 回去即恢复', async () => {
  const home = await homeWith([ID])
  const r = await quarantineStoredSession({ home, sessionId: ID })
  assert.equal((await stat(join(r.quarantinedTo, 'session.v4.jsonl.zstd'))).size, 1, '数据必须仍在')
  await rename(r.quarantinedTo, r.dir)
  const back = await findSessionDir(sessionsRoot(home), ID)
  assert.equal(back, r.dir)
  assert.equal((await stat(join(back, 'session.lock'))).size, 0)
})

test('④ 仍在运行的会话拒绝隔离（不替用户动活会话）', async () => {
  const home = await homeWith([ID])
  await assert.rejects(
    quarantineStoredSession({ home, sessionId: ID, isActive: true }),
    (error) => error instanceof SessionDeleteError && error.code === 'session-active',
  )
})