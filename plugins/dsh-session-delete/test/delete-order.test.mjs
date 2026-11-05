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
} from '../src/session-delete.js'

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
  // 确定性地让随后的 rename(dir, graveyard) 失败：在 beforeRemove 里把 KEY 目录整体挪走，
  // 再在原位放一个**同名普通文件**。于是 dir 这条路径不再可达，rename 必失败。
  // （选 beforeRemove 是因为它在 findSessionDir 之后、rename 之前，正好卡在中间。）
  await assert.rejects(
    deleteStoredSession({
      home, sessionId: ID, isActive: false,
      afterResolve: async () => { unloadRan = true },
      beforeRemove: async () => {
        await rename(keyDir, keyDir + '.moved');
        await writeFile(keyDir, 'now a file');
      },
    }),
    (e) => e instanceof SessionDeleteError,
  );
  assert.equal(unloadRan, false, '移动失败时不得卸载内存会话（旧实现先卸载后移动）');
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
