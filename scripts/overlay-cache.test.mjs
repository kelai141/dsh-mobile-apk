// overlay-cache.test.mjs — issue #1414 回归：缓存命中必须校验，落盘必须原子。
//
// 缺陷形态（改前）：`if (existsSync(dest)) return dest` —— 上次中断留下的截断 tgz、或换镜像后
// 同名不同字节的包，会被原样解进引擎树，构建日志里没有任何异常。落盘也是裸 writeFileSync。
//
// 判据选「命中返回什么」+「残档有没有被清掉」，而不是「有没有打日志」：日志措辞会改，
// 文件在不在、返回不返回路径不会骗人。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIDECAR_SUFFIX, overlayCacheHit, overlayCacheStore } from './lib/overlay-cache.mjs'

const sha = (buf) => createHash('sha512').update(buf).digest('base64')
const payload = Buffer.from('overlay tarball bytes for #1414\n', 'utf8')

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-cache-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('未命中时返回 null（不抛）', () => withDir((dir) => {
  assert.equal(overlayCacheHit(join(dir, 'pkg-1.0.0.tgz')), null)
}))

test('落盘后写 sidecar，且再次命中返回同一路径', () => withDir((dir) => {
  const dest = join(dir, 'pkg-1.0.0.tgz')
  assert.equal(overlayCacheStore(dest, payload), dest)
  assert.equal(readFileSync(dest + SIDECAR_SUFFIX, 'utf8').trim(), sha(payload))
  assert.equal(overlayCacheHit(dest), dest)
}))

test('内容被截断（摘要不符）时不命中，并清掉残档与 sidecar', () => withDir((dir) => {
  const dest = join(dir, 'pkg-1.0.0.tgz')
  overlayCacheStore(dest, payload)
  // 模拟「上次写到一半被杀」：文件被截断，sidecar 还是旧的
  writeFileSync(dest, payload.subarray(0, 5))
  assert.equal(overlayCacheHit(dest), null, '坏包不得被当成命中')
  assert.equal(existsSync(dest), false, '残档必须被清掉（否则下次还会命中）')
  assert.equal(existsSync(dest + SIDECAR_SUFFIX), false, 'sidecar 必须一并清掉')
}))

test('没有 sidecar 的旧缓存不命中，并被清掉', () => withDir((dir) => {
  const dest = join(dir, 'pkg-1.0.0.tgz')
  writeFileSync(dest, payload) // 旧实现留下的缓存：只有 tgz，没有摘要
  assert.equal(overlayCacheHit(dest), null, '无法证明完整性的缓存不得直接使用')
  assert.equal(existsSync(dest), false)
}))

test('sidecar 为空串时同样不命中', () => withDir((dir) => {
  const dest = join(dir, 'pkg-1.0.0.tgz')
  writeFileSync(dest, payload)
  writeFileSync(dest + SIDECAR_SUFFIX, '  \n')
  assert.equal(overlayCacheHit(dest), null)
}))

test('原子落盘：不残留 .tmp- 文件', () => withDir((dir) => {
  const dest = join(dir, 'pkg-1.0.0.tgz')
  overlayCacheStore(dest, payload)
  const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
  assert.deepEqual(leftovers, [])
}))
