// removal-seam-1582.test.mjs — issue #1582 回归：移除类补丁的判据必须是**肯定式**。
//
// 缺陷形态：E1..E6 的 check() 写成 `!s.includes(<被删掉的原文>)`——「标记不存在 = 已应用」。
// 于是上游把那几行改个形态（region 改名、表达式重排、导出换名），六条 check 全部变真、
// 六条 apply 一次都不跑，而 --apply + --check 双跑全绿：设备上移动端本该裁掉的设置 UI 重新出现。
//
// 本文件钉住两件事，缺一即回归：
//   ① 判据本体是**肯定式**：marker 在场才算已应用；marker 缺席（=没删过）必须判缺席；
//   ② 端到端：把真实 vendored 字节里的删除痕迹抹掉（模拟「上游改形态后补丁从未跑过」），
//      `--check` 必须判红退出 1；反过来对仓库里真实的 vendor 树必须全绿（判据不是永红）。
//
// 为什么反例走**临时副本**而不是改仓库文件：与 apply-patches 的其它回归同款——
// 半途被杀也不会留下一棵脏的 vendor 树。
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { REMOVAL_MARKERS, removalApplied } from '../lib/removal-seam.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const runner = join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs')
const VENDOR = join(repoRoot, 'vendor', 'dsh-undo-savepoint')
const REMOVAL_IDS = ['undo-E1', 'undo-E2', 'undo-E3', 'undo-E4', 'undo-E5', 'undo-E6']

test('每条移除类补丁都登记了 marker（新增移除类补丁必须登记，否则永远判缺席）', () => {
  for (const id of REMOVAL_IDS) {
    assert.equal(typeof REMOVAL_MARKERS[id], 'string', id)
    assert.ok(REMOVAL_MARKERS[id].length > 0, id)
  }
})

test('判据是肯定式：marker 在场 = 已应用；marker 缺席 = 未应用（不是「原文不在场」）', () => {
  for (const id of REMOVAL_IDS) {
    assert.equal(removalApplied('a\n/* ' + 'x' + ' */\nb', id), false, id + '：无 marker 必须判未应用')
    assert.equal(removalApplied('a\n' + REMOVAL_MARKERS[id] + '\nb', id), true, id + '：marker 在场必须判已应用')
  }
})

test('未登记的 id 一律判未应用（不静默放行）', () => {
  assert.equal(removalApplied(REMOVAL_MARKERS['undo-E1'], 'undo-E9-not-registered'), false)
  assert.equal(removalApplied(null, 'undo-E1'), false)
})

test('真实 vendored 字节：六条 marker 全部在场（当前 vendor 是已施加态）', () => {
  const source = readFileSync(join(VENDOR, 'lib', 'client.js'), 'utf8')
  for (const id of REMOVAL_IDS) assert.equal(removalApplied(source, id), true, id + ' 在 vendor 里缺席')
})

/** 造一棵「补丁从未施加」的 vendor 临时副本（把六条 marker 抹掉）。 */
const scratchTreeWithoutMarkers = () => {
  const scratch = mkdtempSync(join(tmpdir(), 'removal-seam-1582-'))
  const lib = join(scratch, 'dsh-undo-savepoint', 'lib')
  mkdirSync(lib, { recursive: true })
  for (const file of ['client.js', 'core.mjs', 'index.js']) {
    copyFileSync(join(VENDOR, 'lib', file), join(lib, file))
  }
  const clientPath = join(lib, 'client.js')
  let text = readFileSync(clientPath, 'utf8')
  for (const id of REMOVAL_IDS) text = text.split(REMOVAL_MARKERS[id]).join('')
  writeFileSync(clientPath, text)
  return scratch
}

test('端到端反例：抹掉删除痕迹后 --check 必须判红（旧判据在这里是绿的）', () => {
  const scratch = scratchTreeWithoutMarkers()
  try {
    const r = spawnSync(process.execPath,
      [runner, scratch, '--check', '--only', REMOVAL_IDS.join(',')], { encoding: 'utf8' })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    assert.notEqual(r.status, 0, 'marker 缺席却仍报成功：判据退回否定式（#1582 回归）' + '\n' + out)
    for (const id of REMOVAL_IDS) assert.match(out, new RegExp('\\[fail\\] ' + id + ' 缺席'), id + ' 未判缺席')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('端到端正控：真实 vendor 树 --check 必须全绿（判据不是永红）', () => {
  const r = spawnSync(process.execPath,
    [runner, join(repoRoot, 'vendor'), '--check', '--only', REMOVAL_IDS.join(',')], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  assert.equal(r.status, 0, out)
  for (const id of REMOVAL_IDS) assert.match(out, new RegExp('\\[skip\\] ' + id + ' 已应用'), id)
})