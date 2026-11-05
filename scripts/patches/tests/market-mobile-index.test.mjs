// market-K-mobile-index 回归：勾「仅移动端可用」必须按**真集合**分页。
//
// 真因（0.15.0 用户反馈）：分页用的是目录接口的 total（4544 条），而 compat 是本包用
// 23 条硬编码映射本地派生的，接口没有 compat 过滤参数——于是过滤只在「当前页 96 条里」
// 生效，页码仍按 4544 算成 48 页。
//
// 本测试不联网：把打补丁后的 Wc / MK 抽出来，用一个假目录客户端喂数据，
// 钉住四件事：ok 名单从映射表派生、去重、按 star 排序、二级调用走缓存。
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 本机（Android/Termux）的 process.execPath 可能指向 /apex/.../linker64 而不是 node，
// 直接拿它 spawn 脚本会报 bad ELF magic。只在确实像 node 时用它，否则走 PATH 里的 node。
const here = dirname(fileURLToPath(import.meta.url))
const NODE = /(^|[\\/])node(\.exe)?$/i.test(process.execPath) ? process.execPath : 'node'
const repoRoot = join(here, '..', '..', '..')
const vendor = join(repoRoot, 'vendor', 'dshmarketplace-plugin')

/** 在临时树里应用补丁链，返回打补丁后的 index.js 文本。 */
function patchedIndex() {
  const scratch = mkdtempSync(join(tmpdir(), 'market-k-'))
  cpSync(vendor, join(scratch, 'dshmarketplace-plugin'), { recursive: true })
  execFileSync(NODE, [
    join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs'),
    scratch,
    '--apply', '--only', 'market-K-mobile-index,market-D-server',
  ], { stdio: 'pipe' })
  return readFileSync(join(scratch, 'dshmarketplace-plugin', 'lib', 'index.js'), 'utf8')
}

/** 从产物里抽出 Wc / MK，注入假目录客户端。 */
function loadLogic(src, fakeC) {
  const wc = src.slice(src.indexOf('function Wc('), src.indexOf('function Dt('))
  const mk = src.slice(src.indexOf('var MK_CACHE='), src.indexOf('function Dt('))
  return new Function('c', wc + '\n' + mk + '\n;return { Wc, MK };')(fakeC)
}

const okNames = (src) => {
  const map = src.slice(src.indexOf('let _={'), src.indexOf('},_ok='))
  return [...map.matchAll(/"([^"]+)":"ok"/g)].map((m) => m[1])
}

test('移动端集合：从映射表派生 ok 名单，去重后按 star 降序', async () => {
  const src = patchedIndex()
  const names = okNames(src)
  assert.ok(names.length >= 10, 'ok 名单应从 Wc 的映射表派生')
  let calls = 0
  const fakeC = async ({ q }) => {
    calls++
    // 每个名字回两条：一条精确命中（该名字），一条干扰项
    const pkg = q
    return { results: [
      { fullName: `owner/${pkg}`, name: pkg, stars: 100, category: 'ui' },
      { fullName: `someone/${pkg}`, name: pkg, stars: 50, category: 'ui' },
      { fullName: 'noise/unrelated', name: 'unrelated', stars: 999, category: 'ui' },
    ] }
  }
  const { MK } = loadLogic(src, fakeC)
  const items = await MK(fakeC)
  assert.equal(calls, names.length, '每个 ok 名字各查一次')
  assert.equal(items.length, names.length * 2, '同一包名在不同作者下会命中多条，均保留（fullName 不同）')
  const stars = items.map((x) => Number(x.stars))
  assert.deepEqual(stars, [...stars].sort((a, b) => b - a), '结果按 star 降序')
  assert.ok(items.every((x) => x.compat === 'ok'), '集合里只允许 compat=ok')
})

test('移动端集合：二级调用走缓存，不再请求上游', async () => {
  const src = patchedIndex()
  let calls = 0
  const fakeC = async ({ q }) => {
    calls++
    return { results: [{ fullName: `owner/${q}`, name: q, stars: 10, category: 'ui' }] }
  }
  const { MK } = loadLogic(src, fakeC)
  await MK(fakeC)
  const first = calls
  assert.ok(first > 0)
  await MK(fakeC)
  assert.equal(calls, first, '缓存窗口内不得重复请求目录')
})

test('分页：total 等于集合长度，页码按 96 条一页算', async () => {
  const src = patchedIndex()
  const fakeC = async ({ q }) => ({ results: [{ fullName: `owner/${q}`, name: q, stars: 1, category: 'ui' }] })
  const { MK } = loadLogic(src, fakeC)
  const items = await MK(fakeC)
  const pages = Math.max(1, Math.ceil(items.length / 96))
  assert.equal(pages, 1, 'ok 集合只有十几条，页码必须是 1 页而不是 48')
  assert.ok(src.includes('_c={total:_idx.length'), '路由必须用集合长度当 total')
})
