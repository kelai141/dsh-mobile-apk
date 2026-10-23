// undo-route-auth.test.mjs — apk #222 route-auth patch regression.
//
// Copies the vendored undo plugin into an isolated package, applies the same U1 patch used by
// the snapshot build, imports the patched artifact, and dispatches requests through its actual
// registered /api/undo prefix handler. This catches both transform breakage and the exact-before-
// longest-prefix routing condition that bypasses client-connection's /api handler.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const targetRel = 'dsh-undo-savepoint/lib/index.js'
const source = join(repoRoot, 'vendor', targetRel)
const patchRunner = join(repoRoot, 'scripts', 'patches', 'apply-patches.mjs')
const webServerSources = [
  join(repoRoot, 'dsh', 'packages', 'host', 'webserver', 'src', 'index.ts'),
  join(repoRoot, '..', 'dsh', 'packages', 'host', 'webserver', 'src', 'index.ts'),
]
const failures = []

function check(label, ok, detail) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok || detail === undefined ? '' : ' -> ' + detail))
  if (!ok) failures.push(label)
}

function responseRecorder() {
  const out = { status: undefined, headers: undefined, body: undefined }
  return {
    out,
    writeHead(status, headers = {}) { out.status = status; out.headers = headers },
    end(body) { out.body = body },
  }
}

function request(method, url, headers, options = {}) {
  let bodyRead = false
  return {
    method,
    url,
    headers,
    get bodyRead() { return bodyRead },
    on(event, callback) {
      if (options.rejectBodyRead === true) {
        bodyRead = true
        throw new Error('handler attempted to read a rejected request body')
      }
      if (event === 'data' && options.body !== undefined) callback(Buffer.from(options.body))
      if (event === 'end') callback()
    },
    destroy() {},
  }
}

/** Match a route using the upstream documented exact-first/longest-prefix rules. */
function match(routes, pathname) {
  const exact = routes.find((route) => route.kind === 'exact' && route.path === pathname)
  if (exact !== undefined) return exact
  return routes.filter((route) => route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(route.path + '/')))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

const scratch = mkdtempSync(join(tmpdir(), 'undo-api-auth-'))
const prior = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_CONTROL_TOKEN_TEST: process.env.DSH_CONTROL_TOKEN_TEST,
  DSH_CONTROL_TOKEN: process.env.DSH_CONTROL_TOKEN,
  DSH_ENGINE_PORT: process.env.DSH_ENGINE_PORT,
}
const cleanups = []
const pendingEffects = []
try {
  const target = join(scratch, targetRel)
  mkdirSync(dirname(target), { recursive: true })
  // 0.4.9 起 index.js 把实现拆到 core.mjs/zip.mjs/i18n.mjs（且 core.mjs 再 import i18n.mjs 与 i18n/*.json）。
  // 只拷 index.js 会让 import 期 ERR_MODULE_NOT_FOUND（实测：Cannot find module .../lib/core.mjs）。
  // 这里整目录拷贝 lib/，并对文本文件统一归一为 LF（补丁锚点与结构断言都按 LF 写；
  // 若不归一，index.js 会被本循环以 CRLF 覆盖上面那行，结构断言随即失配——实测踩到）。
  const libDir = join(repoRoot, 'vendor', 'dsh-undo-savepoint', 'lib')
  for (const name of readdirSync(libDir, { recursive: true })) {
    const srcPath = join(libDir, name)
    if (!statSync(srcPath).isFile()) continue
    const destPath = join(scratch, 'dsh-undo-savepoint', 'lib', name)
    mkdirSync(dirname(destPath), { recursive: true })
    if (/\.(mjs|js|json)$/.test(name)) {
      writeFileSync(destPath, readFileSync(srcPath, 'utf8').replace(/\r\n/g, '\n'))
    } else {
      writeFileSync(destPath, readFileSync(srcPath))
    }
  }

  const applied = spawnSync(process.execPath,
    [patchRunner, scratch, '--apply', '--scope', 'vendor', '--only', 'undo-api-auth-U1'],
    { encoding: 'utf8' })
  check('apply-patches exits 0', applied.status === 0,
    (applied.stderr || applied.stdout || '').trim().split('\n').slice(-3).join(' '))
  const patched = readFileSync(target, 'utf8')
  check('U1 marker appears in patched undo artifact', patched.includes('dsh-mobile undo route auth (U1)'))
  check('U1 success responses are explicitly no-store', patched.includes('dsh-mobile undo no-store (U1)'))
  check('U1 guard precedes the REST try block', patched.includes('const rejection = dshMobileUndoAuthorize(req);\n        if (rejection !== undefined) { dshMobileUndoReject(res, rejection); return; }\n        try {'))
  const syntax = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' })
  check('patched artifact parses', syntax.status === 0, (syntax.stderr || '').split('\n')[0])
  const second = spawnSync(process.execPath,
    [patchRunner, scratch, '--apply', '--scope', 'vendor', '--only', 'undo-api-auth-U1'],
    { encoding: 'utf8' })
  check('re-apply is idempotent', second.status === 0 && readFileSync(target, 'utf8') === patched)

  // The vendored module resolves this peer synchronously at import time. A minimal ESM peer lets
  // the test execute the real route registration without involving the upstream read-only tree.
  const toolsDir = join(scratch, 'dsh-undo-savepoint', 'node_modules', '@deepseek-ai', 'dsh-tools')
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(join(toolsDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', exports: './index.js' }))
  writeFileSync(join(toolsDir, 'index.js'), 'export const defineTool = value => value;\n')

  const home = join(scratch, 'home')
  const token = 'undo-route-auth-token'
  process.env.DSH_HOME = home
  process.env.DSH_CONTROL_TOKEN_TEST = '1'
  process.env.DSH_CONTROL_TOKEN = token
  process.env.DSH_ENGINE_PORT = '4145'
  const engineHost = '127.0.0.1:4145'
  const mod = await import(pathToFileURL(target).href + '?undo-api-auth-test=1')
  const routes = []
  const browserRejection = (req) => {
    const port = process.env.DSH_ENGINE_PORT ?? '4145'
    const host = req.headers?.host
    const origin = req.headers?.origin
    if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return 403
    if (origin !== undefined && origin !== 'http://127.0.0.1:' + port && origin !== 'http://localhost:' + port) return 403
    return 401
  }
  let connection = { requestRejection: browserRejection }
  const rememberCleanup = (value) => {
    if (typeof value === 'function') cleanups.push(value)
    return value
  }
  const ctx = {
    get(name) { return name === 'connection' ? connection : undefined },
    logger: { warn() {}, info() {} },
    tools: { register() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    webServer: { register(route) { routes.push(route); return () => {} } },
    effect(fn) {
      const value = fn()
      if (value && typeof value.then === 'function') {
        pendingEffects.push(Promise.resolve(value).then(rememberCleanup, () => undefined))
      } else {
        rememberCleanup(value)
      }
      return () => {}
    },
  }
  mod.apply(ctx, {
    profileDir: join(home, 'profiles', 'web'),
    homeDir: home,
    manualDir: join(home, 'undo', 'manual'),
    autoDir: join(home, 'undo', 'auto'),
    autoEnabled: false,
  })
  const undo = routes.find((route) => route.kind === 'prefix' && route.path === '/api/undo')
  check('patched plugin registers the /api/undo prefix', undo !== undefined)

  const apiFallback = { kind: 'prefix', path: '/api', handler: async (_req, res) => { res.writeHead(599); res.end('wrong-route') } }
  const dispatched = match([apiFallback, ...(undo === undefined ? [] : [undo])], '/api/undo/status')
  check('longer /api/undo prefix wins over /api', dispatched === undo)
  const upstreamRouteSource = webServerSources.find((path) => existsSync(path))
  if (upstreamRouteSource === undefined) {
    check('upstream webserver source unavailable: local reverse-dispatch fixture remains active', true)
  } else {
    const upstreamRouteText = readFileSync(upstreamRouteSource, 'utf8')
    check('upstream webserver still documents exact-first then longest-prefix matching',
      upstreamRouteText.includes('const exact = this.exact.get(pathname)')
        && upstreamRouteText.includes('if (exact !== undefined) return exact')
        && upstreamRouteText.includes('prefix.length > best.path.length'))
  }

  if (undo !== undefined) {
    const noCredential = request('GET', '/api/undo/status', { host: engineHost })
    const unauthorized = responseRecorder()
    await dispatched.handler(noCredential, unauthorized)
    check('unauthenticated read through the longer prefix receives 401', unauthorized.out.status === 401, JSON.stringify(unauthorized.out))

    const forgedHost = responseRecorder()
    await undo.handler(request('GET', '/api/undo/status', { host: 'attacker.invalid' }), forgedHost)
    check('forged Host is rejected before data disclosure', forgedHost.out.status === 403 && forgedHost.out.body === undefined, JSON.stringify(forgedHost.out))

    const forgedOrigin = responseRecorder()
    await undo.handler(request('GET', '/api/undo/status', { host: engineHost, origin: 'https://attacker.invalid' }), forgedOrigin)
    check('cross-origin request is rejected before data disclosure', forgedOrigin.out.status === 403 && forgedOrigin.out.body === undefined, JSON.stringify(forgedOrigin.out))

    const rejectedMutation = request('POST', '/api/undo/remove', { host: engineHost }, { rejectBodyRead: true })
    const mutationOut = responseRecorder()
    await undo.handler(rejectedMutation, mutationOut)
    check('unauthenticated mutation returns 401 before reading its body', mutationOut.out.status === 401 && rejectedMutation.bodyRead === false, JSON.stringify(mutationOut.out))

    let browserAuthCalls = 0
    connection = { requestRejection: () => { browserAuthCalls++; return 401 } }
    const tokenOut = responseRecorder()
    await undo.handler(request('GET', '/api/undo/status', { host: engineHost, 'x-dsh-control-token': token }), tokenOut)
    check('valid control token reaches the read handler after trusted browser rejection',
      tokenOut.out.status === 200 && tokenOut.out.headers['cache-control'] === 'no-store' && browserAuthCalls === 1,
      JSON.stringify(tokenOut.out))

    connection = undefined
    const fallbackTokenOut = responseRecorder()
    await undo.handler(request('GET', '/api/undo/status', { host: engineHost, 'x-dsh-control-token': token }), fallbackTokenOut)
    check('mobile token fallback remains fail-closed but usable without connection', fallbackTokenOut.out.status === 200, JSON.stringify(fallbackTokenOut.out))

    process.env.DSH_ENGINE_PORT = '55231'
    const stalePort = responseRecorder()
    await undo.handler(request('GET', '/api/undo/status', { host: engineHost, 'x-dsh-control-token': token }), stalePort)
    check('fallback port is read per request and the previous authority is rejected', stalePort.out.status === 403, JSON.stringify(stalePort.out))
    const reboundPort = responseRecorder()
    await undo.handler(request('GET', '/api/undo/status', { host: '127.0.0.1:55231', 'x-dsh-control-token': token }), reboundPort)
    check('the newly published fallback authority is accepted', reboundPort.out.status === 200, JSON.stringify(reboundPort.out))
    process.env.DSH_ENGINE_PORT = '4145'

    process.env.DSH_CONTROL_TOKEN = ''
    connection = { requestRejection: () => undefined }
    const cookieOut = responseRecorder()
    await undo.handler(request('GET', '/api/undo/status', { host: engineHost }), cookieOut)
    check('authenticated browser session reaches the read handler', cookieOut.out.status === 200, JSON.stringify(cookieOut.out))
  }
} finally {
  await Promise.allSettled(pendingEffects)
  for (const dispose of cleanups.reverse()) {
    try { await dispose() } catch { /* isolated fixture cleanup is best effort */ }
  }
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('\nundo-route-auth: ' + failures.length + ' check(s) failed: ' + failures.join('; '))
  process.exit(1)
}
console.log('\nundo-route-auth: all checks passed')
