// issue #1400：消息批次 id 直接拼进路径，`../../<相对路径>` 可读取并应用快照目录之外的
// 任意 `.json`，再按其中记录的路径执行还原/删除。
//
// 判据跑的是**真实 vendored 字节**（vendor/dsh-undo-savepoint/lib/core.mjs），不是复制品。
// 两个方向都要证：
//   ① 非法 id 读不到外部批次（fail-closed，且不把路径回显到错误里）；
//   ② **同一份批次内容**换成一个合法 id 放在 message-ops 目录里时必须真的生效——
//      否则「读不到」可能只是因为夹具本身没破坏力，判据恒真。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 直接用 URL.href 导入：把 URL 转成 pathname 再转回 file URL 会在 POSIX 上拼错路径
// （Windows 上因为盘符形态侥幸可用，CI 立刻暴露）。
const core = await import(new URL('../vendor/dsh-undo-savepoint/lib/core.mjs', import.meta.url).href)

/** 造一份「会删掉 victim」的批次内容。 */
function batchFor(victim) {
  return JSON.stringify({
    batchId: 'b1',
    messageId: 'm1',
    startedAt: new Date().toISOString(),
    ops: [{ tool: 'write_file', path: victim, beforeExists: false, afterExists: true }],
  }, null, 2)
}

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'undo-1400-'))
  const autoDir = join(root, 'auto')
  mkdirSync(join(autoDir, 'message-ops'), { recursive: true })
  const victim = join(root, 'victim.txt')
  writeFileSync(victim, 'should survive a blocked traversal\n')
  return { root, autoDir, victim }
}

test('#1400 非法批次 id 读不到外部批次：victim 必须存活', async () => {
  const { root, autoDir, victim } = makeTree()
  // 把批次放在 message-ops 的**上一级**，用 ../ 相对路径命中它
  writeFileSync(join(autoDir, 'evil.json'), batchFor(victim))
  const cfg = { autoDir, root }
  const r = await core.undoMessage(cfg, '../evil')
  assert.equal(r.ok, false, '非法 id 竟然执行了撤销：' + JSON.stringify(r))
  assert.equal(r.code, 'not-found', '非法 id 必须按 not-found 处理（fail-closed）')
  assert.equal(existsSync(victim), true, 'victim 被删了 —— 路径穿越生效')
  // 错误文案不得泄露**真实路径**（调用方自己的输入回显给他是无害的；泄露落盘位置才有害）
  assert.equal(String(r.error).includes(autoDir), false, '错误文案泄露了落盘路径：' + r.error)
  assert.equal(String(r.error).includes('message-ops'), false, '错误文案泄露了目录名：' + r.error)
  rmSync(root, { recursive: true, force: true })
})

test('#1400 反向：同一份批次内容用合法 id 放在 message-ops 里必须真的生效', async () => {
  const { root, autoDir, victim } = makeTree()
  writeFileSync(join(autoDir, 'message-ops', 'b1.json'), batchFor(victim))
  const cfg = { autoDir, root }
  const r = await core.undoMessage(cfg, 'b1')
  assert.equal(r.ok, true, '合法 id 却执行失败：' + JSON.stringify(r))
  assert.equal(existsSync(victim), false, '夹具本身没有破坏力 —— 上一条判据因此是恒真的')
  rmSync(root, { recursive: true, force: true })
})

test('#1400 绝对路径与分隔符变体同样被拒', async () => {
  const { root, autoDir, victim } = makeTree()
  const cfg = { autoDir, root }
  const evil = [
    '../evil',
    '..%2Fevil',
    'a/b',
    'a\\b',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    '..',
    '.',
    '',
    'x'.repeat(65),
  ]
  for (const id of evil) {
    const r = await core.undoMessage(cfg, id)
    assert.equal(r.ok, false, 'id 应被拒但执行了撤销: ' + JSON.stringify(id))
  }
  rmSync(root, { recursive: true, force: true })
})
