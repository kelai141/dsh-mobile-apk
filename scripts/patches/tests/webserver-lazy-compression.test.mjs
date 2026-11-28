import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get } from 'node:http'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { patchManagedPortBind } from '../data/managed-port-bind-EP1.mjs'
import { hasWebserverLazyCompression, patchWebserverLazyCompression } from '../data/webserver-lazy-compression.mjs'
import { versionedFixture } from './lib/fixture.mjs'

const source = readFileSync(versionedFixture('dsh-host-webserver', 'lib', 'index.js'), 'utf8')
const patched = patchWebserverLazyCompression(source)
const body = 'webserver response '.repeat(128)

test('webserver anchors reject missing, duplicate and partially applied edits', () => {
  const anchors = [
    'import Negotiator from "negotiator";',
    'this.gzip = resolved.compression === "gzip" ? createGzipMiddleware(resolved) : void 0;',
    'function createGzipMiddleware(config) {',
    '\tasync [Service.init]() {\n\t\tconst handle = async (req, res) => {',
  ]
  assert.equal(hasWebserverLazyCompression(source), false)
  assert.equal(hasWebserverLazyCompression(patched), true)
  assert.equal(patchWebserverLazyCompression(patched), patched)
  for (const anchor of anchors) {
    assert.ok(source.includes(anchor), anchor)
    assert.throws(() => patchWebserverLazyCompression(source.replace(anchor, '')), /webserver/)
    assert.throws(() => patchWebserverLazyCompression(source + '\n' + anchor), /webserver/)
  }
  assert.throws(() => patchWebserverLazyCompression(source + '\nasync [Service.init]() {}'), /one Service.init/)
  assert.throws(() => patchWebserverLazyCompression(patched.replace('await Promise.all', 'Promise.all')), /partial marker/)
  assert.throws(() => patchWebserverLazyCompression('import "negotiator";\n' + patched), /partial marker/)
})

test('webserver lazy compression composes with EP1 in either order', () => {
  assert.equal(patchWebserverLazyCompression(patchManagedPortBind(source)), patchManagedPortBind(patched))
})

const INIT = Symbol.for('webserver-fixture.init')
const moduleUrl = (code) => 'data:text/javascript,' + encodeURIComponent(code)
const modules = new Map([
  ['@deepseek-ai/cordis', moduleUrl('export class Service { static init = Symbol.for("webserver-fixture.init"); constructor(ctx) { this.ctx = ctx } }')],
  ['@deepseek-ai/schemastery', moduleUrl('const schema = new Proxy(() => schema, { get: () => schema }); export default schema')],
  ['ipaddr.js', moduleUrl('export default {}')],
  ['negotiator', moduleUrl([
    'export default class Negotiator {',
    '  constructor(req) { this.req = req }',
    '  encoding(allowed) { return allowed.find((value) => value === this.req.headers["accept-encoding"]) }',
    '}',
  ].join('\n'))],
  ['compression', moduleUrl([
    'import { gzipSync } from "node:zlib";',
    'function compression({ level, threshold, filter }) {',
    '  return (req, res, next) => {',
    '    const end = res.end;',
    '    res.end = function (body) {',
    '      if (req.headers["accept-encoding"] === "gzip" && body.length >= threshold && filter(req, res)) {',
    '        res.setHeader("content-encoding", "gzip");',
    '        body = gzipSync(body, { level });',
    '      }',
    '      return end.call(this, body);',
    '    };',
    '    next();',
    '  };',
    '}',
    'compression.filter = () => true;',
    'export default compression;',
  ].join('\n'))],
])

async function startWebserver(t, mode, imports) {
  const dir = mkdtempSync(join(tmpdir(), 'webserver-lazy-'))
  const file = join(dir, 'index.mjs')
  const url = pathToFileURL(file).href
  writeFileSync(file, patched)
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL !== url || !modules.has(specifier)) return nextResolve(specifier, context)
      if (specifier === 'compression' || specifier === 'negotiator') imports.push(specifier)
      return { url: modules.get(specifier), shortCircuit: true }
    },
  })
  t.after(() => {
    hooks.deregister()
    rmSync(dir, { recursive: true, force: true })
  })
  const { WebServer } = await import(url)
  let stop
  const ctx = { effect: async (start) => { stop = await start() } }
  const server = new WebServer(ctx, {
    host: '127.0.0.1', port: 0, compression: mode, compressionLevel: 1, compressionThresholdBytes: 1024,
  })
  assert.deepEqual(imports, [], 'module evaluation and construction must not resolve either gzip dependency')
  const respond = (responder) => (req, res) => {
    res.setHeader('content-type', 'text/plain')
    responder(res)
    res.end(body)
  }
  server.register({ kind: 'exact', path: '/response', handler: respond(() => {}) })
  server.register({ kind: 'exact', path: '/events', handler: respond((res) => res.setHeader('content-type', 'text/event-stream')) })
  server.register({ kind: 'exact', path: '/range', handler: respond((res) => res.setHeader('content-range', 'bytes 0-1/2')) })
  await server[INIT]()
  t.after(() => stop())
  return server.port
}

function request(port, path, encoding) {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, headers: { 'accept-encoding': encoding } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode, encoding: res.headers['content-encoding'], body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('webserver none serves an HTTP response without resolving compression or negotiator', async (t) => {
  const imports = []
  const port = await startWebserver(t, 'none', imports)
  assert.deepEqual(await request(port, '/response', 'gzip'), { status: 200, encoding: undefined, body: Buffer.from(body) })
  assert.deepEqual(imports, [])
})

test('webserver gzip resolves both dependencies during init and sends a gzip response', async (t) => {
  const imports = []
  const port = await startWebserver(t, 'gzip', imports)
  assert.deepEqual(imports.sort(), ['compression', 'negotiator'])
  const gzip = await request(port, '/response', 'gzip')
  assert.equal(gzip.status, 200)
  assert.equal(gzip.encoding, 'gzip')
  assert.equal(gunzipSync(gzip.body).toString(), body)
  for (const [path, encoding] of [['/response', 'br'], ['/events', 'gzip'], ['/range', 'gzip']]) {
    assert.deepEqual(await request(port, path, encoding), { status: 200, encoding: undefined, body: Buffer.from(body) })
  }
})
