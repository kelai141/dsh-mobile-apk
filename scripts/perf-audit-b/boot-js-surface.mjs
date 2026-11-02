#!/usr/bin/env node
/**
 * B1/B2 主脚本：算出「WebView 首屏真正要下载 + 求值多少字节 JS」，逐条列出并汇总。
 *
 * 口径为何这样定（不是估的）：引擎侧 dsh-client-modules/lib/index.js:108 自述
 *   「node 半边扫 Host Loader 的 entries，凡 package.json 里 dsh.client.platform === 'web'
 *     的包都收进 client 模块表，其 ./client 导出成为首屏 bundle」。
 * 所以首屏 JS 面 = 生效 Loader entry -> 其包的 package.json -> dsh.client(platform=web) -> exports["./client"] 的字节。
 *
 * 装配顺序按 cordis-plugin-include 的语义：bundles 里的 patch 依次叠加，最后是用户 profile 的
 * cordis.patch.yml；同名 id 后写覆盖前写（disabled: true 即关停）。
 *
 * 用法：node scripts/perf-audit-b/boot-js-surface.mjs <解包后的快照根目录>
 * 输出：stdout JSON；stderr 人类可读摘要。
 */
import { createBrotliCompress, createGzip, constants } from 'node:zlib'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const root = process.argv[2]
if (root === undefined) {
  console.error('用法: node scripts/perf-audit-b/boot-js-surface.mjs <解包后的快照根目录>')
  process.exit(2)
}

const ENGINE = join(root, 'usr/lib/node_modules/@deepseek-ai/dsh')
const ENGINE_MODULES = join(ENGINE, 'node_modules')
const PROFILE = join(root, 'home/.dsh/profiles/web')

/** 解析一份 cordis.patch.yml：收集 insert 的 {id,name} 与就地覆盖的 {id,disabled}。 */
function parsePatch(text) {
  const lines = text.split(/\r?\n/)
  const inserted = []
  const overrides = []
  let cur = null
  let curIsInsert = false
  const flush = () => {
    if (cur === null) return
    if (curIsInsert) inserted.push(cur)
    else overrides.push(cur)
    cur = null
  }
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '')
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()
    if (body.startsWith('#')) continue
    const idm = /^-\s+id:\s*(.+)$/.exec(body)
    if (idm !== null) {
      flush()
      curIsInsert = indent > 0
      cur = { id: idm[1].trim(), name: undefined, disabled: false, line: lines.indexOf(raw) + 1 }
      continue
    }
    if (cur === null) continue
    const nm = /^name:\s*(.+)$/.exec(body)
    if (nm !== null) { cur.name = nm[1].trim().replace(/^['"]|['"]$/g, ''); continue }
    if (/^disabled:\s*true\s*$/.test(body)) { cur.disabled = true; continue }
    // disabled 也可写成表达式（!!js ...），一律视为「可能关停」，但只统计字面 true
  }
  flush()
  return { inserted, overrides }
}

const profilePkg = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
const bundles = profilePkg.dsh?.profile?.bundles ?? []

const layers = []
for (const b of bundles) {
  const p = join(ENGINE_MODULES, b, 'cordis.patch.yml')
  if (existsSync(p)) layers.push({ key: b, text: readFileSync(p, 'utf8') })
}
layers.push({ key: 'profile-cordis.patch.yml', text: readFileSync(join(PROFILE, 'cordis.patch.yml'), 'utf8') })

/** @type {Map<string, {id:string,name?:string,disabled:boolean,inserted:boolean,layer:string}>} */
const merged = new Map()
for (const layer of layers) {
  const { inserted, overrides } = parsePatch(layer.text)
  for (const e of inserted) {
    merged.set(e.id, { id: e.id, name: e.name, disabled: e.disabled, inserted: true, layer: layer.key })
  }
  for (const e of overrides) {
    const prev = merged.get(e.id)
    if (prev === undefined) {
      merged.set(e.id, { id: e.id, name: undefined, disabled: e.disabled, inserted: false, layer: layer.key })
    } else {
      merged.set(e.id, { ...prev, disabled: e.disabled, layer: layer.key })
    }
  }
}

const active = [...merged.values()].filter((e) => !e.disabled)
const withName = active.filter((e) => typeof e.name === 'string')

/** 把 loader 的 module specifier 解析成包根目录（含子路径导出如 pkg/tools -> pkg）。 */
function resolvePkgDir(spec) {
  if (spec.startsWith('.') || spec.startsWith('cordis:')) return undefined
  const parts = spec.split('/')
  const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  // 三处落点：引擎自带 node_modules / 引擎根部 / 出厂 profile 的 node_modules（@dsh-android/* 与 vendor 在这）
  const candidates = [
    join(ENGINE_MODULES, pkgName),
    join(ENGINE, 'node_modules', pkgName),
    join(PROFILE, 'node_modules', pkgName),
  ]
  for (const c of candidates) if (existsSync(join(c, 'package.json'))) return c
  return undefined
}

async function gzipSize(buf) {
  let total = 0
  const gz = createGzip({ level: 1 }) // 与出厂 webServer compressionLevel: 1 一致
  gz.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), gz, async (s) => { for await (const _ of s) void 0 })
  return total
}
async function brotliSize(buf) {
  let total = 0
  const br = createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
  br.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), br, async (s) => { for await (const _ of s) void 0 })
  return total
}

const rows = []
const seenPkg = new Set()
for (const e of withName) {
  const dir = resolvePkgDir(e.name)
  if (dir === undefined) continue
  let pkg
  try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) } catch { continue }
  const decl = pkg.dsh?.client
  if (decl === undefined || decl === null || typeof decl !== 'object') continue
  if (decl.platform !== 'web') continue
  if (seenPkg.has(pkg.name)) continue
  seenPkg.add(pkg.name)
  const exp = pkg.exports?.['./client']
  const rel = typeof exp === 'string' ? exp : (exp?.default ?? exp?.import ?? exp?.require)
  if (typeof rel !== 'string') continue
  const file = join(dir, rel)
  let buf
  try { buf = readFileSync(file) } catch { continue }
  rows.push({
    entryId: e.id,
    package: pkg.name,
    immediately: decl.immediately === true,
    raw: buf.length,
    gzip: await gzipSize(buf),
    brotli: await brotliSize(buf),
    path: relative(root, file).split('\\').join('/'),
  })
}

rows.sort((a, b) => b.raw - a.raw)
const sum = (k) => rows.reduce((a, r) => a + r[k], 0)

// 本仓自有（@dsh-android/*）与 vendor 的归属拆分
const isRepoOwned = (p) => p.startsWith('@dsh-android/') || p.startsWith('dsh-undo-savepoint') || p.startsWith('dshmarketplace')
const repoRows = rows.filter((r) => isRepoOwned(r.package))
const upstreamRows = rows.filter((r) => !isRepoOwned(r.package))

const report = {
  root,
  loaderEntries: {
    total: merged.size,
    active: active.length,
    withName: withName.length,
  },
  bootClientBundles: {
    count: rows.length,
    rawBytes: sum('raw'),
    gzipBytes: sum('gzip'),
    brotliBytes: sum('brotli'),
    rawMiB: Number((sum('raw') / 1048576).toFixed(2)),
    gzipMiB: Number((sum('gzip') / 1048576).toFixed(2)),
    immediately: rows.filter((r) => r.immediately).length,
  },
  repoOwned: {
    count: repoRows.length,
    rawBytes: repoRows.reduce((a, r) => a + r.raw, 0),
    gzipBytes: repoRows.reduce((a, r) => a + r.gzip, 0),
    packages: repoRows.map((r) => r.package),
  },
  upstream: {
    count: upstreamRows.length,
    rawBytes: upstreamRows.reduce((a, r) => a + r.raw, 0),
    gzipBytes: upstreamRows.reduce((a, r) => a + r.gzip, 0),
  },
  rows,
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n')

process.stderr.write([
  'Loader entry: 声明 ' + merged.size + ' · 生效 ' + active.length + ' · 带包名 ' + withName.length,
  '首屏 client bundle: ' + rows.length + ' 个，raw ' + report.bootClientBundles.rawMiB + ' MiB'
    + '，gzip(level1) ' + report.bootClientBundles.gzipMiB + ' MiB',
  '  本仓自有 ' + repoRows.length + ' 个 / ' + (report.repoOwned.rawBytes / 1024).toFixed(1) + ' KiB raw',
  '  上游 ' + upstreamRows.length + ' 个 / ' + (report.upstream.rawBytes / 1048576).toFixed(2) + ' MiB raw',
].join('\n') + '\n')
