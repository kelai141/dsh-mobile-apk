// issue #1032：`--dir` 遍历必须跟随符号链接。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { collectApkFiles } from '../scripts/check-apk-signatures.mjs'

test('直接子文件与嵌套目录都能被收集（回归）', () => {
  const root = mkdtempSync(join(tmpdir(), 'apkdir-'))
  try {
    writeFileSync(join(root, 'a.apk'), 'x')
    mkdirSync(join(root, 'nested'))
    writeFileSync(join(root, 'nested', 'b.APK'), 'x')
    writeFileSync(join(root, 'ignore.txt'), 'x')
    const got = collectApkFiles(root).map((p) => p.split(/[\\/]/).pop()).sort()
    assert.deepEqual(got, ['a.apk', 'b.APK'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('符号链接（junction）目录里的 APK 必须被收集', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'apkdir-'))
  const outside = mkdtempSync(join(tmpdir(), 'apkout-'))
  try {
    writeFileSync(join(outside, 'linked.apk'), 'x')
    try {
      symlinkSync(outside, join(root, 'link'), 'junction')
    } catch {
      t.skip('本机无建链权限')
      return
    }
    const got = collectApkFiles(root).map((p) => p.split(/[\\/]/).pop())
    assert.deepEqual(got, ['linked.apk'])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('不存在的目录返回 null（不抛）', () => {
  assert.equal(collectApkFiles(join(tmpdir(), 'does-not-exist-xyz')), null)
})