// normalize-snapshot 的行为回归。
//
// 本文件的重点不是「正例能跑通」，而是**三条反证**——它们定义了这套归一化的安全边界：
//   ① 序列顺序不得被归一化（YAML 序列有语义，排序它就是制造假绿）；
//   ② 时间戳字段缺席时必须判红（规则的前提失效，不能静默放过）；
//   ③ **真差异不得被吞掉**——这条是全案的分水岭：归一化若把「某包多了一条依赖」
//      也一并抹平，那它就从防线变成了后门。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'

import {
  blankTimestampLine,
  canonicalizePackedManifest,
  canonicalJson,
  canonicalYamlMapping,
  normalizeSnapshot,
} from './normalize-snapshot.mjs'

const ENGINE = join('usr', 'lib', 'node_modules', '@deepseek-ai', 'dsh')

/** 造一个最小的快照目录：可指定若干文件的内容。 */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-norm-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

test('canonicalJson：键序无语义——两种顺序归一后相同', () => {
  const a = canonicalJson('{"b":1,"a":{"y":2,"x":3}}')
  const b = canonicalJson('{"a":{"x":3,"y":2},"b":1}')
  assert.equal(a, b)
  // 数组顺序**有**语义，必须原样保留（不排序）
  assert.equal(canonicalJson('["b","a"]'), '[\n  "b",\n  "a"\n]\n')
})

test('canonicalYamlMapping：映射键序无语义', () => {
  const a = canonicalYamlMapping('top:\n  "z": 1\n  "a": 2\n')
  const b = canonicalYamlMapping('top:\n  "a": 2\n  "z": 1\n')
  assert.equal(a, b)
  // 含 `:` 的引号键必须被当作一个键（本链实况：@deepseek-ai/...-local@file:///home/...）
  const withColon = canonicalYamlMapping('t:\n  "a@file:///x": true\n')
  assert.match(withColon, /a@file:\/\/\/x/)
})

test('反证①：YAML 序列不得被当作映射排序，必须判红', () => {
  assert.throws(
    () => canonicalYamlMapping('- .\n- ./src\n', 'p.yaml'),
    /不是块映射条目|拒绝猜测/,
    '序列顺序有语义，排序它就是制造假绿——必须响亮失败',
  )
})

test('反证②：时间戳字段缺席时必须判红，不得静默放过', () => {
  assert.throws(
    () => blankTimestampLine('{"other": 1}\n', 'prunedAt', 'm.yaml'),
    /找不到时间戳字段/,
    '规则的前提（该字段存在）失效时放过，等于让归一化悄悄失效',
  )
  // 正例：字段在场则取值被抹平，键名仍在（差异仍可见）
  const out = blankTimestampLine('  "prunedAt": "Sun, 27 Sep 2026 14:38:40 GMT"\n', 'prunedAt')
  assert.match(out, /"prunedAt": "<normalized-timestamp>"/)
})

test('端到端：只差 JSON 键序的两个快照，归一化摘要相同', () => {
  const files = {
    [join('a', 'package.json')]: '{"name":"x","dependencies":{"b":"1","a":"2"}}\n',
    [join(ENGINE, 'pnpm-workspace.yaml')]: 'patched:\n  "z": "1"\n  "a": "2"\n',
    [join(ENGINE, 'node_modules', '.modules.yaml')]: '  "prunedAt": "T"\n',
    [join(ENGINE, 'node_modules', '.pnpm-workspace-state-v1.json')]: '{"lastValidatedTimestamp":1}\n',
  }
  const reordered = {
    [join('a', 'package.json')]: '{"dependencies":{"a":"2","b":"1"},"name":"x"}\n',
    [join(ENGINE, 'pnpm-workspace.yaml')]: 'patched:\n  "a": "2"\n  "z": "1"\n',
    [join(ENGINE, 'node_modules', '.modules.yaml')]: '  "prunedAt": "OTHER"\n',
    [join(ENGINE, 'node_modules', '.pnpm-workspace-state-v1.json')]: '{"lastValidatedTimestamp":2}\n',
  }
  const one = fixture(files)
  const two = fixture(reordered)
  try {
    assert.equal(
      normalizeSnapshot(one).normalizedManifestSha256,
      normalizeSnapshot(two).normalizedManifestSha256,
    )
  } finally {
    rmSync(one, { recursive: true, force: true })
    rmSync(two, { recursive: true, force: true })
  }
})

test('反证③：真差异绝不能被归一化吞掉', () => {
  const base = {
    [join('a', 'package.json')]: '{"name":"x","dependencies":{"a":"2","b":"1"}}\n',
    [join('a', 'keep.txt')]: 'same\n',
  }
  const variants = {
    '多一条依赖': { ...base, [join('a', 'package.json')]: '{"name":"x","dependencies":{"a":"2","b":"1","c":"3"}}\n' },
    '改了取值': { ...base, [join('a', 'package.json')]: '{"name":"x","dependencies":{"a":"999","b":"1"}}\n' },
    '多一个文件': { ...base, [join('a', 'extra.txt')]: 'new\n' },
    '非 JSON 文件内容变了': { ...base, [join('a', 'keep.txt')]: 'changed\n' },
  }
  const ref = fixture(base)
  const digest = normalizeSnapshot(ref).normalizedManifestSha256
  try {
    for (const [label, files] of Object.entries(variants)) {
      const root = fixture(files)
      try {
        assert.notEqual(normalizeSnapshot(root).normalizedManifestSha256, digest,
          `反证③失败：「${label}」是真实差异，却被归一化抹平了——归一化已从防线变成后门`)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  } finally {
    rmSync(ref, { recursive: true, force: true })
  }
})

/** 造一个 npm 形态的 tarball（条目在 `package/` 下），返回其路径与清理函数。 */
function makeTarball(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tgz-src-'))
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  const tgz = `${root}.tgz`
  execFileSync('tar', ['-czf', tgz, '-C', root, 'package'])
  return { tgz, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(tgz, { force: true }) } }
}

test('B：键序不同的两个 tarball，重打包后逐字节相同', () => {
  const one = makeTarball({
    'package/package.json': '{"name":"x","version":"1.0.0","dependencies":{"b":"1","a":"2"}}\n',
    'package/lib/index.js': 'exports.x = 1\n',
  })
  const two = makeTarball({
    'package/package.json': '{"dependencies":{"a":"2","b":"1"},"version":"1.0.0","name":"x"}\n',
    'package/lib/index.js': 'exports.x = 1\n',
  })
  try {
    canonicalizePackedManifest(one.tgz, 'one')
    canonicalizePackedManifest(two.tgz, 'two')
    assert.equal(
      readFileSync(one.tgz).toString('binary'),
      readFileSync(two.tgz).toString('binary'),
      '键序是唯一差异时，重打包必须产出同一份字节——否则下游整套哈希照样每次都漂',
    )
  } finally {
    one.cleanup(); two.cleanup()
  }
})

test('B：重打包保留 package/ 前缀（消费方按 --strip-components=1 解包）', () => {
  const one = makeTarball({ 'package/package.json': '{"name":"x"}\n' })
  try {
    canonicalizePackedManifest(one.tgz, 'one')
    const listing = execFileSync('tar', ['-tzf', one.tgz], { encoding: 'utf8' }).trim().split('\n')
    assert.ok(listing.length > 0)
    for (const entry of listing) {
      assert.match(entry, /^package(\/|$)/, `条目 ${entry} 丢了 package/ 前缀——消费方会解包出错`)
    }
  } finally {
    one.cleanup()
  }
})

test('反证④：tarball 里的真实差异不得被重打包抹平', () => {
  const base = {
    'package/package.json': '{"name":"x","dependencies":{"a":"2","b":"1"}}\n',
  }
  const ref = makeTarball(base)
  const variant = makeTarball({ ...base, 'package/package.json': '{"name":"x","dependencies":{"a":"2","b":"1","c":"3"}}\n' })
  try {
    canonicalizePackedManifest(ref.tgz, 'ref')
    canonicalizePackedManifest(variant.tgz, 'variant')
    assert.notEqual(
      readFileSync(ref.tgz).toString('binary'),
      readFileSync(variant.tgz).toString('binary'),
      '反证④失败：多了一条依赖是真实差异，却被重打包抹平了',
    )
  } finally {
    ref.cleanup(); variant.cleanup()
  }
})

test('B：重打包是幂等的（再跑一次字节不变）', () => {
  const one = makeTarball({ 'package/package.json': '{"name":"x","dependencies":{"b":"1","a":"2"}}\n' })
  try {
    canonicalizePackedManifest(one.tgz, 'once')
    const once = readFileSync(one.tgz).toString('binary')
    canonicalizePackedManifest(one.tgz, 'twice')
    assert.equal(readFileSync(one.tgz).toString('binary'), once, '重打包不幂等 ⇒ 每跑一次就换一份字节')
  } finally {
    one.cleanup()
  }
})

test('B：跨秒真实重打包仍逐字节相同，gzip 头不携带时间戳或文件名', async (t) => {
  const files = {
    'package/package.json': '{"name":"x","version":"1.0.0","dependencies":{"b":"1","a":"2"}}\n',
    'package/lib/index.js': 'exports.x = 1\n',
  }
  const one = makeTarball(files)
  const two = makeTarball(files)
  try {
    canonicalizePackedManifest(one.tgz, 'first-second')
    const first = readFileSync(one.tgz)
    const firstSecond = Math.floor(Date.now() / 1000)
    // 不改系统时间、不伪造头字节：真实等待跨秒，再走同一条完整重打包路径。
    await delay(1100)
    assert.ok(Math.floor(Date.now() / 1000) > firstSecond, '第二次重打包必须发生在下一秒以后')
    canonicalizePackedManifest(two.tgz, 'later-second')
    const second = readFileSync(two.tgz)
    const firstMtime = first.readUInt32LE(4)
    const secondMtime = second.readUInt32LE(4)
    const samePayload = gunzipSync(first).equals(gunzipSync(second))
    t.diagnostic(JSON.stringify({ firstMtime, secondMtime, samePayload }))
    assert.equal(samePayload, true, '解压后的 tar 字节必须相同，排除内容变化')
    assert.deepEqual(second, first, '跨秒重打包必须逐字节相同；不能只比较归一化后的摘要')
    assert.equal(firstMtime, 0, 'gzip mtime 必须固定为 0')
    assert.equal(secondMtime, 0, '跨秒后 gzip mtime 仍必须为 0')
    assert.equal(first[3] & 8, 0, 'gzip 不得携带第一个临时文件名')
    assert.equal(second[3] & 8, 0, 'gzip 不得携带第二个临时文件名')
  } finally {
    one.cleanup(); two.cleanup()
  }
})

test('skipped 可见：后缀命中的非 JSON 文件被登记而不是静默', () => {
  const root = fixture({
    // 带注释的 JSONC：.json 后缀但非严格 JSON（实测快照里有 36 个，都是第三方 tsconfig.json）
    [join('a', 'tsconfig.json')]: '{\n  // comment\n  "compilerOptions": {}\n}\n',
  })
  try {
    const report = normalizeSnapshot(root)
    assert.equal(report.skipped.length, 1)
    assert.equal(report.skipped[0].rule, 'json-key-order')
    assert.equal(report.rules.find((r) => r.id === 'json-key-order').applied, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
