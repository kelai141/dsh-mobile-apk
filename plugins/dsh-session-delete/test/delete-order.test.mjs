// issue #1203 负控：会话删除/隔离必须**先移目录、后卸载**。
//
// 缺陷形态：afterResolve（delete）/ beforeResolve（quarantine）跑在 rename/mkdir **之前**，
// 而移动是卸载之后唯一的步骤。移动一失败就得到该模块注释点名要避免的状态：
//   会话从内存里没了、目录还在磁盘上 —— 用户看到「删除失败」，但界面上会话已消失。
//
// 判据设计：不读源码、不 grep 调用顺序，而是用**可控失败**驱动真实函数，断言两个可观测量：
//   ① 卸载钩子有没有跑（unloadRan）；
//   ② 目录是否仍在扫描路径上（existsSync）。
// 反证要求：移动失败时 ① 必须为 false 且 ② 必须为 true —— 也就是「什么都没发生」。
// 正控要求：全部成功时 ① 必须为 true 且 ② 必须为 false —— 也就是「真的删掉了」。
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { renameSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  QUARANTINE_DIR,
  SessionDeleteError,
  deleteStoredSession,
  quarantineStoredSession,
  sessionsRoot,
} from '../lib/session-delete.js'

const ID = 'session-12345678-1234-4abc-8def-1234567890ab'
const KEY = '--workspace--'

async function homeWith(id) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-order-'));
  const dir = join(sessionsRoot(home), KEY, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.lock'), '');
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x');
  return { home, dir };
}

test('#1203 反证：delete 移动目录失败时，不得卸载内存会话（否则「内存没了、磁盘还在」）', async () => {
  const { home, dir } = await homeWith(ID);
  const keyDir = join(sessionsRoot(home), KEY);
  let unloadRan = false;
  let bookkeepingRan = false;
  // 确定性地让随后的 rename(dir, graveyard) 失败：把 KEY 目录整体挪走，再在原位放一个
  // **同名普通文件**。于是 dir 这条路径不再可达，rename 必失败。
  //
  // 注入点从 beforeRemove 换成 logger：issue #1617 之后 beforeRemove 已经**不在**
  // findSessionDir 与 rename 之间了（那正是这次修的缺陷），拿它当注入点等于测的是旧顺序。
  // 「resolved session directory」这条日志恰好仍在两者之间，用同步文件操作在那一刻破坏路径。
  await assert.rejects(
    deleteStoredSession({
      home, sessionId: ID, isActive: false,
      afterResolve: async () => { unloadRan = true },
      beforeRemove: async () => { bookkeepingRan = true },
      logger: (level, message) => {
        if (message !== 'resolved session directory') return
        renameSync(keyDir, keyDir + '.moved')
        writeFileSync(keyDir, 'now a file')
      },
    }),
    (e) => e instanceof SessionDeleteError,
  );
  assert.equal(unloadRan, false, '移动失败时不得卸载内存会话（旧实现先卸载后移动）');
  // issue #1617：移动失败时归档/置顶记账也必须一次都没跑——旧实现先记账后移动，
  // 于是「删除失败」的会话已经悄悄退出归档/置顶。
  assert.equal(bookkeepingRan, false, '移动失败时不得留下归档/置顶的副作用（issue #1617）');
  // 父目录被挪到 <KEY>.moved，故原路径不再可达；用挪走后的真实路径确认内容未被删。
  const movedDir = join(keyDir + '.moved', ID);
  assert.equal(existsSync(movedDir), true, '会话目录内容必须仍在（只是父目录被挪走，未被删除）');
})

test('#1203 反证：delete 卸载钩子必须跑在目录移动之后（顺序本身）', async () => {
  const { home, dir } = await homeWith(ID);
  let movedAway = false;
  await assert.rejects(
    deleteStoredSession({
      home, sessionId: ID, isActive: false,
      afterResolve: async () => {
        movedAway = !existsSync(dir);
        throw new Error('unload exploded');
      },
    }),
    (e) => e instanceof SessionDeleteError,
  );
  assert.equal(movedAway, true, '卸载钩子必须跑在目录移动**之后**（先移后卸载）');
  assert.equal(existsSync(dir), true, '卸载失败后目录必须被移回原位，否则「可恢复」是假的');
})

test('#1203 正控：delete 全部成功时目录消失且卸载跑过', async () => {
  const { home, dir } = await homeWith(ID);
  let unloadRan = false;
  const r = await deleteStoredSession({
    home, sessionId: ID, isActive: false,
    afterResolve: async () => { unloadRan = true },
  });
  assert.equal(r.ok, true);
  assert.equal(unloadRan, true, '成功路径必须卸载');
  assert.equal(existsSync(dir), false, '成功路径目录必须消失');
})

/**
 * issue #1617：删除的归档/置顶记账不得留下「删除失败但副作用已发生」的中间态。
 *
 * 缺陷形态：`beforeRemove` 先 unarchive/unpin，随后 rename 失败（EACCES/ENOSPC）→ 返回 500
 * 「删除失败」，会话还在列表里，但已悄悄退出归档/置顶。
 *
 * 判据是**行为**：让移动确定性失败，断言记账钩子一次都没被调用，且目录仍在扫描路径上。
 * 把 beforeRemove 挪回 rename 之前，这条立刻红。
 */
test('#1617 反证：移动失败时归档/置顶记账必须一次都没跑', async () => {
  const { home, dir } = await homeWith(ID);
  const keyDir = join(sessionsRoot(home), KEY);
  let bookkeeping = 0;
  await assert.rejects(
    deleteStoredSession({
      home, sessionId: ID, isActive: false,
      beforeRemove: async () => { bookkeeping += 1 },
      logger: (level, message) => {
        if (message !== 'resolved session directory') return
        renameSync(keyDir, keyDir + '.moved')
        writeFileSync(keyDir, 'now a file')
      },
    }),
    (e) => e instanceof SessionDeleteError,
  );
  assert.equal(bookkeeping, 0, '移动失败 = 什么都没发生，记账不得跑过（issue #1617）');
})

/**
 * issue #1617 正控：成功路径上记账**必须**跑，且必须跑在目录离开扫描路径之后。
 * 只有反证没有正控时，「干脆永不记账」也能过。
 */
test('#1617 正控：删除成功时记账跑过，且那时目录已离开扫描路径', async () => {
  const { home, dir } = await homeWith(ID);
  let dirGoneWhenBookkeeping = null;
  const r = await deleteStoredSession({
    home, sessionId: ID, isActive: false,
    beforeRemove: async () => { dirGoneWhenBookkeeping = !existsSync(dir) },
  });
  assert.equal(r.ok, true);
  assert.equal(dirGoneWhenBookkeeping, true, '记账必须在目录已离开扫描路径之后才跑');
})

test('#1203 反证：quarantine 移动失败时不得卸载（.corrupt 被普通文件占位）', async () => {
  const { home, dir } = await homeWith(ID);
  // 确定性失败：把 .corrupt 位置占成普通文件，mkdir(trash) 必抛错。
  await writeFile(join(dirname(dir), QUARANTINE_DIR), 'not a dir');
  let unloadRan = false;
  await assert.rejects(
    quarantineStoredSession({
      home, sessionId: ID, isActive: false,
      beforeResolve: async () => { unloadRan = true },
    }),
    (e) => e instanceof SessionDeleteError,
  );
  assert.equal(unloadRan, false, '移动失败时不得卸载（否则内存没了、磁盘还在）');
  assert.equal(existsSync(dir), true, '目录必须仍在扫描路径上');
})

test('#1203 正控：quarantine 全部成功时目录离开扫描路径且卸载跑过', async () => {
  const { home, dir } = await homeWith(ID);
  let unloadRan = false;
  const r = await quarantineStoredSession({
    home, sessionId: ID, isActive: false,
    beforeResolve: async () => { unloadRan = true },
  });
  assert.equal(r.ok, true);
  assert.equal(r.restorable, true);
  assert.equal(unloadRan, true, '成功路径必须卸载');
  assert.equal(existsSync(dir), false, '成功路径目录必须离开扫描路径');
  assert.equal(existsSync(r.quarantinedTo), true, '隔离件必须存在（可恢复）');
})
