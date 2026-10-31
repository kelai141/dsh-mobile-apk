// 软链自净化（issue #1204）：自指链不得「先删再抛」，越界目标不得被改写成逃逸相对链。
//
// 两条都是**机制级**缺陷，与真实快照内容无关：手工搭 stage 树即可复现，不需要 snapshot.tar.xz。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sanitizeSymlinks, OLD_DEVICE_PREFIX } from './symlink-sanitize.mjs'

/** 建一棵最小 stage 树：usr/bin + usr/lib，返回根路径。 */
function makeStage() {
  const root = mkdtempSync(join(tmpdir(), 'symlink-sanitize-'))
  mkdirSync(join(root, 'usr', 'bin'), { recursive: true })
  mkdirSync(join(root, 'usr', 'lib'), { recursive: true })
  return root
}

/** Windows 上非管理员/未开发者模式建软链会 EPERM —— 那是环境限制，不是判据失效。 */
function trySymlink(target, path) {
  try {
    symlinkSync(target, path)
    return true
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return false
    throw e
  }
}

test('#1204 ① 指向自己所在目录的链：按 dropped 处理，不抛 ENOENT、不先删后建', (t) => {
  const root = makeStage()
  try {
    const self = join(root, 'usr', 'bin', 'self')
    if (!trySymlink(OLD_DEVICE_PREFIX + '/usr/bin', self)) return t.skip('本机不允许建软链（EPERM）')
    // 旧实现：relative() 得空串 → rmSync 之后 symlinkSync('') 抛 ENOENT，链接已被删掉。
    const stats = sanitizeSymlinks(root, ['usr'])
    assert.equal(stats.rewrote, 0, '自指链不得计为改写')
    assert.equal(stats.dropped, 1, '自指链必须计为 dropped')
    assert.equal(lstatSync(self, { throwIfNoEntry: false }), undefined, '链接必须被删除（不留悬空件）')
    // 同目录其它内容不得被牵连
    assert.ok(lstatSync(join(root, 'usr', 'bin')).isDirectory())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('#1204 ② 带 .. 的越界目标：必须 dropped，不得改写成逃出 stage 树的相对链', (t) => {
  const root = makeStage()
  const outside = mkdtempSync(join(tmpdir(), 'symlink-outside-'))
  try {
    writeFileSync(join(outside, 'passwd'), 'root:x:0:0\n')
    const evil = join(root, 'usr', 'bin', 'evil')
    // 目标形如 /data/data/com.termux/files/../../outside/passwd —— 剥前缀后是 ../../outside/passwd，
    // 而构建机上那条越界路径**真实存在**（这里用绝对路径构造同样的相对逃逸）。
    const escapeTarget = OLD_DEVICE_PREFIX + '/../../' + outside.replace(/\\/g, '/').replace(/^\//, '') + '/passwd'
    if (!trySymlink(escapeTarget, evil)) return t.skip('本机不允许建软链（EPERM）')
    const stats = sanitizeSymlinks(root, ['usr'])
    assert.equal(stats.rewrote, 0, '越界目标不得被改写成相对链（旧实现 rewrote=1 且链逃出 stage 树）')
    assert.equal(stats.dropped, 1, '越界目标必须计为 dropped')
    assert.equal(lstatSync(evil, { throwIfNoEntry: false }), undefined, '逃逸链必须被删除')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('#1204 反向用例：树内合法旧前缀链仍必须改写为相对链（修法不得误伤）', (t) => {
  const root = makeStage()
  try {
    writeFileSync(join(root, 'usr', 'lib', 'real.so'), 'ELF')
    const ok = join(root, 'usr', 'bin', 'ok')
    if (!trySymlink(OLD_DEVICE_PREFIX + '/usr/lib/real.so', ok)) return t.skip('本机不允许建软链（EPERM）')
    const stats = sanitizeSymlinks(root, ['usr'])
    assert.equal(stats.rewrote, 1, '树内合法旧前缀链必须仍是 rewrote=1')
    assert.equal(stats.dropped, 0)
    assert.equal(readlinkSync(ok), join('..', 'lib', 'real.so'), '改写结果必须是相对链 ../lib/real.so')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
