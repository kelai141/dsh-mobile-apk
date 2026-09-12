// ST-17 回归（离线）：工具链表单一来源 + 结构化 missing。
// 判据：工具链状态出现结构化 missing（包名口径，与 dsh-shell-termux probe() 一致）；
//       第二张字面量清单必须消失（表只在 shell-termux 里）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { PROBE_BINARIES, REQUIRED_TOOLCHAIN } from '@dsh-android/dsh-shell-termux'

function makeCtx(services) {
  const routes = new Map()
  const tools = []
  const target = {
    tools: { register(t) { tools.push(t) } },
    webServer: { register(route) { routes.set(route.path, route); return () => { routes.delete(route.path) } } },
    get: (name) => services[name],
  }
  return { ctx: target, routes, tools }
}

async function callRoute(harness, path) {
  const route = harness.routes.get(path)
  assert.ok(route, '路由必须注册：' + path)
  const res = { code: 0, body: '', headers: {}, writeHead(c, h) { this.code = c; this.headers = h ?? {} }, end(b) { this.body = b ?? '' } }
  await route.handler({}, res)
  assert.equal(res.code, 200)
  return JSON.parse(res.body)
}

function fixturePrefix(binaries) {
  const prefix = mkdtempSync(join(tmpdir(), 'dsh-prefix-'))
  mkdirSync(join(prefix, 'bin'), { recursive: true })
  for (const b of binaries) writeFileSync(join(prefix, 'bin', b), '')
  return prefix
}

async function withPrefix(prefix, fn) {
  const previous = process.env.TERMUX__PREFIX
  process.env.TERMUX__PREFIX = prefix
  try {
    const harness = makeCtx({ androidPrivilege: { status: () => ({ tier: 'T0' }) } })
    apply(harness.ctx)
    return await fn(harness)
  } finally {
    if (previous === undefined) delete process.env.TERMUX__PREFIX
    else process.env.TERMUX__PREFIX = previous
  }
}

test('ST-17 单一表：源里不再有第二张字面量清单，且 import 自 dsh-shell-termux', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("from '@dsh-android/dsh-shell-termux'"), '必须 import 单一表')
  for (const legacy of ["'busybox'", "'python'", "'openssl'", "'jq'"]) {
    assert.equal(src.includes(legacy), false, '旧第二张表残留：' + legacy)
  }
  assert.ok(Array.isArray(PROBE_BINARIES) && PROBE_BINARIES.includes('ls'), 'shell-termux 的探针表必须在场')
  assert.ok(Array.isArray(REQUIRED_TOOLCHAIN) && REQUIRED_TOOLCHAIN.includes('coreutils'), '包表必须在场')
})

test('ST-17 结构化 missing：缺 findutils/ripgrep 时按包名列出（partial）', async () => {
  const prefix = fixturePrefix(['bash', 'ls', 'cat', 'grep'])
  await withPrefix(prefix, async (harness) => {
    const status = await callRoute(harness, '/api/android/env/status')
    assert.equal(status.toolchainState, 'partial')
    assert.deepEqual(status.missing, ['findutils', 'ripgrep'])
    assert.equal(status.tools.bash, true)
    assert.equal(status.tools.find, false)
    assert.equal(status.tools.rg, false)
    // tools 的键集合 == 单一探针表（不再有第二份 15 项清单）
    assert.deepEqual(Object.keys(status.tools).sort(), [...PROBE_BINARIES].sort())
  })
})

test('ST-17 bash 缺失 → unusable 且 missing = 整表（与 probe() 同语义）', async () => {
  const prefix = fixturePrefix(['ls', 'cat', 'grep'])
  await withPrefix(prefix, async (harness) => {
    const status = await callRoute(harness, '/api/android/env/status')
    assert.equal(status.toolchainState, 'unusable')
    assert.deepEqual(status.missing, [...REQUIRED_TOOLCHAIN])
  })
})

test('ST-17 齐全 → full / missing 空', async () => {
  const prefix = fixturePrefix([...PROBE_BINARIES])
  await withPrefix(prefix, async (harness) => {
    const status = await callRoute(harness, '/api/android/env/status')
    assert.equal(status.toolchainState, 'full')
    assert.deepEqual(status.missing, [])
  })
})
