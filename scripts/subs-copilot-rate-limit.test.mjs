// issue #1624：Copilot 403 带限流信号时不得判永久错误（否则会删掉整条 GitHub token）。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const STUB_DIR = mkdtempSync(join(tmpdir(), 'subs-1624-'))
const LLM_STUB = join(STUB_DIR, 'dsh-llm.mjs')
writeFileSync(LLM_STUB, [
  'export const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE"',
  'export const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED"',
  'export const QUOTA_EXCEEDED_CODE = "QUOTA_EXCEEDED"',
  'export const isContextWindowExceededError = () => false',
  'export const isQuotaExceededError = () => false',
  'export const ReasoningEffortId = (x) => x',
  'export class LlmAdapter {}',
  'export class LlmError extends Error { constructor(m, code, opts) { super(m, opts); this.code = code } }',
  'export function errorChain(e) { return String(e) }',
  'export function resolveRetryPolicy(p) { return p }',
].join('\n') + '\n')

const HOME_STUB = join(STUB_DIR, 'dsh-home.mjs')
writeFileSync(HOME_STUB, 'export function dshHome() { return "/tmp" }\nexport function dshHomePath(...p) { return "/tmp/" + p.join("/") }\n')

const UNDICI_STUB = join(STUB_DIR, 'undici.mjs')
writeFileSync(UNDICI_STUB, 'export class ProxyAgent {}\nexport const fetch = globalThis.fetch\n')

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-llm') {
      return { url: pathToFileURL(LLM_STUB).href, shortCircuit: true }
    }
    if (specifier === '@deepseek-ai/dsh-home-paths') {
      return { url: pathToFileURL(HOME_STUB).href, shortCircuit: true }
    }
    if (specifier === 'undici') {
      return { url: pathToFileURL(UNDICI_STUB).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

const { oauthEndpointError } = await import('../vendor/dsh-plugin-subscriptions/lib/providers/common.js')
const { isCopilotPermanentRefreshError } = await import('../vendor/dsh-plugin-subscriptions/lib/providers/copilot.js')

test('#1624: 401 判为永久凭据失效', async () => {
  const res = new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
  const err = await oauthEndpointError(res, 'copilot')
  assert.equal(isCopilotPermanentRefreshError(err), true)
})

test('#1624: 403 带 retry-after 按瞬时错误处理，不删凭据', async () => {
  const res = new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit.' }), {
    status: 403,
    headers: { 'retry-after': '60' },
  })
  const err = await oauthEndpointError(res, 'copilot')
  assert.equal(err.retryAfterMs, 60_000)
  assert.equal(err.rateLimited, true)
  assert.equal(isCopilotPermanentRefreshError(err), false)
})

test('#1624: 403 带 x-ratelimit-remaining: 0 按瞬时错误处理，不删凭据', async () => {
  const res = new Response('{}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0' },
  })
  const err = await oauthEndpointError(res, 'copilot')
  assert.equal(err.rateLimited, true)
  assert.equal(isCopilotPermanentRefreshError(err), false)
})

test('#1624: 403 响应体含 rate limit 语义（即使无头）按瞬时错误处理', async () => {
  const res = new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 })
  const err = await oauthEndpointError(res, 'copilot')
  assert.equal(isCopilotPermanentRefreshError(err), false)
})

test('#1624: 403 明确为授权/订阅拒绝对话且无限流头时仍判永久', async () => {
  const res = new Response(JSON.stringify({ message: 'Access denied' }), { status: 403 })
  const err = await oauthEndpointError(res, 'copilot')
  assert.equal(err.rateLimited, false)
  assert.equal(isCopilotPermanentRefreshError(err), true)
})

test('#1624: 500 判为瞬时错误', async () => {
  const res = new Response('oops', { status: 500 })
  const err = await oauthEndpointError(res, 'copilot')
  assert.equal(isCopilotPermanentRefreshError(err), false)
})

test('#1624: 打包入口 lib/index.js 同步包含 rateLimited 与限流豁免逻辑', () => {
  const bundled = readFileSync(new URL('../vendor/dsh-plugin-subscriptions/lib/index.js', import.meta.url), 'utf8')
  assert.match(bundled, /error\.rateLimited/)
  assert.match(bundled, /x-ratelimit-remaining/)
})
