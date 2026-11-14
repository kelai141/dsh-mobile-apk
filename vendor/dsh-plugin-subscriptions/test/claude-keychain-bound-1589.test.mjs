// issue #1589：从 Claude Code 导入的账号，第一次成功刷新后永久脱离同步。
//
// 缺陷形态：`keychainBound` 是「该账号跟随 ~/.claude/.credentials.json」的唯一标记，导入时
// 写入。但 `claudeSession()` / `refreshClaude()` 的返回都不携带它，`refreshClaudeSynced`
// 返回的 base/next 也不携带；而 TokenManager.doRefresh **每次都 save** —— 于是第一次成功
// 刷新就把标记从盘上抹掉，5 分钟同步定时器（`if (session.keychainBound !== true) continue`）
// 从此跳过该账号：DSH 不再读 CLI 轮换后的 token，自己的 refresh token 过期 → invalid_grant
// → 判永久失效 → 删会话，用户必须重新导入，且掉登录时没有任何提示说明原因。
//
// 判据全部是行为判据（不读源码）：真调 refreshClaudeSynced 的两条出口，
// 看返回的会话是否仍带着 keychainBound；再走一遍真实 TokenManager 的 session()，
// 看落盘的那一条有没有把标记丢掉。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 本包在仓内没有 node_modules（vendor 目录只放已构建的 lib/，不编译、不安装）。
// 判据要跑的是**真实 vendored 字节**，所以只把两个纯外部依赖桩掉：
// dsh-llm（提供 LlmError 等符号）与 dsh-home-paths（决定 store 落盘根）。
const STUB_DIR = mkdtempSync(join(tmpdir(), 'subs-1589-stub-'))
const LLM_STUB = join(STUB_DIR, 'dsh-llm.mjs')
writeFileSync(LLM_STUB, [
  'export const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"',
  'export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED"',
  'export const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED"',
  'export const isContextWindowExceededError = () => false',
  'export const isQuotaExceededError = () => false',
  'export const ReasoningEffortId = (x) => x',
  'export const attributionHeaders = () => ({})',
  'export class LlmAdapter {}',
  'export class LlmError extends Error { constructor(m, code, opts) { super(m); this.code = code; this.cause = opts?.cause } }',
  'export function errorChain(e) { return String(e) }',
  'export function resolveRetryPolicy(p) { return p }',
  '',
].join('\n'))
const HOME_ROOT = mkdtempSync(join(tmpdir(), 'subs-1589-home-'))
const HOME_STUB = join(STUB_DIR, 'dsh-home.mjs')
writeFileSync(HOME_STUB, 'export function dshHome() { return ' + JSON.stringify(HOME_ROOT) + ' }\n'
  + 'export function dshHomePath(...p) { return ' + JSON.stringify(HOME_ROOT) + ' + "/" + p.join("/") }\n')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: pathToFileURL(LLM_STUB).href, shortCircuit: true }
    if (specifier === '@deepseek-ai/dsh-home-paths') return { url: pathToFileURL(HOME_STUB).href, shortCircuit: true }
    return next(specifier, context)
  },
})

const { refreshClaudeSynced } = await import('../lib/auth/claude-code-creds.js')
const { saveAccountSession, loadStore } = await import('../lib/auth/store.js')
const { TokenManager } = await import('../lib/providers/common.js')

const PROVIDER = 'claude'
const ACCOUNT = 'imported@example.com'

/** 一条「从 Claude Code 导入」的会话：token 字段齐全，外加唯一标记。 */
const boundSession = (tag, expiresInMs) => ({
  accessToken: 'access-' + tag,
  refreshToken: 'refresh-' + tag,
  expiresAt: Date.now() + expiresInMs,
  scopes: 'user:profile user:inference',
  keychainBound: true,
})

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'subs-1589-'))
  return { path: join(dir, 'auth.json'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('#1589 走「源里已有更新 token」出口时，返回的会话仍带 keychainBound', async () => {
  // Claude Code 的源文件比手里的新（CLI 刚轮换过）——这一条走 base = fromSource 分支。
  const stored = boundSession('stale', 60 * 60 * 1000)
  const fresh = { ...boundSession('from-cli', 60 * 60 * 1000) }
  delete fresh.keychainBound // 源里本来就没有这个标记
  const original = process.env.CLAUDE_CONFIG_DIR
  const dir = await mkdtemp(join(tmpdir(), 'subs-1589-cli-'))
  try {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, expiresAt: fresh.expiresAt,
    } }), 'utf8')
    process.env.CLAUDE_CONFIG_DIR = dir
    const result = await refreshClaudeSynced(stored, async () => { throw new Error('不该走到网络') })
    assert.equal(result.accessToken, fresh.accessToken, '应当采用源里更新的 token')
    assert.equal(result.keychainBound, true, '返回的会话丢了 keychainBound —— 下次 save 就会把标记抹掉')
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original
    await rm(dir, { recursive: true, force: true })
  }
})

test('#1589 走「自己刷新」出口时，返回的会话仍带 keychainBound', async () => {
  const stored = boundSession('1', 1000) // 已在 preempt 窗口内
  const refreshed = { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: Date.now() + 60 * 60 * 1000 }
  const result = await refreshClaudeSynced(stored, async () => refreshed)
  assert.equal(result.accessToken, 'access-2', '应当返回刷新后的 token')
  assert.equal(result.keychainBound, true, '刷新出口丢了 keychainBound')
})

test('#1589 真实 TokenManager 刷新后落盘的那一条必须仍带 keychainBound', async () => {
  const s = await tempStore()
  try {
    await saveAccountSession(PROVIDER, ACCOUNT, boundSession('1', 1000), s.path)
    const manager = new TokenManager({
      displayName: 'Claude',
      preemptMs: 60_000,
      load: async () => {
        const store = await loadStore(s.path)
        const entry = store[PROVIDER]
        return entry === undefined ? undefined : entry.accounts[ACCOUNT]
      },
      save: (next) => saveAccountSession(PROVIDER, ACCOUNT, next, s.path),
      remove: () => rm(s.path, { force: true }),
      // 与 index.js 的接线同形：绑定账号走 synced 版本。
      refresh: (session) => session.keychainBound === true
        ? refreshClaudeSynced(session, async () => ({ accessToken: 'access-3', refreshToken: 'refresh-3', expiresAt: Date.now() + 60 * 60 * 1000 }))
        : (async () => ({ accessToken: 'access-x', refreshToken: 'refresh-x', expiresAt: Date.now() + 60 * 60 * 1000 }))(),
      isPermanent: () => false,
    })
    const fresh = await manager.session()
    assert.equal(fresh.accessToken, 'access-3')
    const onDisk = JSON.parse(await readFile(s.path, 'utf8'))[PROVIDER].accounts[ACCOUNT]
    assert.equal(onDisk.keychainBound, true,
      '刷新落盘后标记丢了 —— 5 分钟同步定时器将从此刻起永久跳过该账号：' + JSON.stringify(onDisk))
  } finally {
    await s.cleanup()
  }
})

test('#1589 未绑定的普通账号不得被反向打上 keychainBound（防「一律加标记」的假绿）', async () => {
  const plain = { accessToken: 'access-p', refreshToken: 'refresh-p', expiresAt: Date.now() + 1000 }
  const result = await refreshClaudeSynced(plain, async () => ({ accessToken: 'access-q', refreshToken: 'refresh-q', expiresAt: Date.now() + 60 * 60 * 1000 }))
  assert.equal(result.keychainBound, undefined, '普通账号被误标成跟随 Claude Code 的账号')
})
