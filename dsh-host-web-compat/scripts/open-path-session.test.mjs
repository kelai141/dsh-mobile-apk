// ST-15 行为回归（离线）：工具行文件链接必须按「行所属会话」解析，不再跨会话猜解。
// 直接对 lib/index.js 的 resolveSessionPath 做单元测试（从源码取出函数体，注入 fs/path 依赖），
// 外加源码级契约断言（DOM 事实判定、sessionId 传递、错误不静默）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve as resolvePath } from 'node:path'

// 统一换行（文件是 CRLF）：函数体提取按 '\n' 切，不随平台变
const SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8').split(String.fromCharCode(13)).join('')

function loadResolveSessionPath() {
  const start = SRC.indexOf('function resolveSessionPath(')
  assert.ok(start > 0, 'lib/index.js 必须定义 resolveSessionPath')
  const end = SRC.indexOf('\n}\n', start)
  assert.ok(end > start, 'resolveSessionPath 必须能被完整取出')
  const body = SRC.slice(start, end + 3)
  return new Function('existsSync', 'resolvePath', 'homedir', body + '\nreturn resolveSessionPath')(existsSync, resolvePath, homedir)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-open-path-'))
  const a = join(root, 'session-a')
  const b = join(root, 'session-b')
  mkdirSync(a, { recursive: true })
  mkdirSync(b, { recursive: true })
  return { root, a, b }
}

const ctxWith = (list) => ({ get: () => ({ list: () => list, get: (id) => list.find((s) => String(s.header.id) === String(id)) }) })

test('源码契约：DOM 事实判定取代静态工具名白名单', () => {
  assert.equal(SRC.includes('FILE_TOOLS'), false, 'FILE_TOOLS 静态副本必须删除')
  assert.ok(SRC.includes('[class*="fileLink"]'), '必须按「行内确有 fileLink 按钮」的 DOM 事实判定')
  assert.ok(SRC.includes('payload.sessionId=sid'), '页面必须把会话 id 随请求带给端点')
  assert.ok(SRC.includes('const { path: rel, sessionId } = JSON.parse(body)'), '端点必须接收 sessionId')
  assert.ok(SRC.includes('showOpenPathNotice'), '失败必须在页面提示（不得静默消费点击）')
})

test('会话作用域：两个会话各有一份同名文件 → 在 B 会话必须解析到 B 的文件', () => {
  const { a, b } = fixture()
  writeFileSync(join(a, 'same.txt'), 'A')
  writeFileSync(join(b, 'same.txt'), 'B')
  const resolve = loadResolveSessionPath()
  const ctx = ctxWith([
    { header: { id: 'session-a', cwd: a } },
    { header: { id: 'session-b', cwd: b } },
  ])
  assert.deepEqual(resolve('same.txt', ctx, 'session-b'), { abs: join(b, 'same.txt'), sessionId: 'session-b' })
  assert.deepEqual(resolve('same.txt', ctx, 'session-a'), { abs: join(a, 'same.txt'), sessionId: 'session-a' })
})

test('会话作用域：会话未知 → 结构化失败（绝不回落到别的会话）', () => {
  const { a } = fixture()
  writeFileSync(join(a, 'same.txt'), 'A')
  const resolve = loadResolveSessionPath()
  const ctx = ctxWith([{ header: { id: 'session-a', cwd: a } }])
  const out = resolve('same.txt', ctx, 'session-ghost')
  assert.equal(out.abs, undefined)
  assert.equal(out.error, 'session-unknown')
  assert.equal(out.sessionId, 'session-ghost')
})

test('会话作用域：该会话内不存在 → 结构化失败并回指会话（页面据此提示）', () => {
  const { a, b } = fixture()
  writeFileSync(join(b, 'only-b.txt'), 'B')
  const resolve = loadResolveSessionPath()
  const ctx = ctxWith([
    { header: { id: 'session-a', cwd: a } },
    { header: { id: 'session-b', cwd: b } },
  ])
  const out = resolve('only-b.txt', ctx, 'session-a')
  assert.equal(out.error, 'not-found-in-session')
  assert.equal(out.sessionId, 'session-a')
})

test('兼容旧页面（无 sessionId）：保留存在性消歧但显式标记 guessed', () => {
  const { a } = fixture()
  writeFileSync(join(a, 'legacy.txt'), 'A')
  const resolve = loadResolveSessionPath()
  const ctx = ctxWith([{ header: { id: 'session-a', cwd: a } }])
  const out = resolve('legacy.txt', ctx)
  assert.deepEqual(out, { abs: join(a, 'legacy.txt'), guessed: true })
})

test('绝对路径与不存在路径仍按原语义（结构化原因）', () => {
  const { a } = fixture()
  writeFileSync(join(a, 'abs.txt'), 'A')
  const resolve = loadResolveSessionPath()
  const ctx = ctxWith([])
  // 绝对分支按 POSIX 语义判定（设备是 Linux；Windows 上 "C:\\..." 不以 '/' 开头，
  // 落相对分支正是同一实现的行为）——两平台都用 '/' 形态断言：
  assert.equal(resolve('/definitely/not/here.txt', ctx).error, 'not-found')
  if (process.platform !== 'win32') {
    assert.deepEqual(resolve(join(a, 'abs.txt'), ctx), { abs: join(a, 'abs.txt') })
  }
  assert.equal(resolve(join(a, 'missing.txt'), ctx).error, 'not-found')
  assert.equal(resolve('', ctx).error, 'empty-path')
  assert.equal(resolve('rel-nothing.txt', ctx).error, 'not-found')
})
