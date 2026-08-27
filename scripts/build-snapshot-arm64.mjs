// build-snapshot-arm64.mjs — M2a: assemble the arm64 environment snapshot from Termux's official aarch64 repo.
// Runs on the host (no arm64 device needed): resolve the dependency graph → download .deb → bsdtar extract → readelf structural check.
// Runtime validation needs an arm64 device (MuMu's arm64 is a translation layer, not valid for verification).
import { execSync } from 'node:child_process'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = 'https://packages.termux.dev/apt/termux-main'
const INDEX_URL = BASE + '/dists/stable/main/binary-aarch64/Packages'
const OUT = join(root, 'snapshot-arm64')
const DEB_DIR = join(OUT, '.debs')

// Target package set (nodejs-lts runtime + agent toolchain)
const TARGETS = ['nodejs-lts', 'bash', 'coreutils', 'findutils', 'grep', 'sed', 'ripgrep', 'tar', 'xz-utils', 'zstd', 'diffutils']

console.log('== 1/4 解析 aarch64 包索引 ==')
const idx = await fetch(INDEX_URL).then(r => r.text())
const pkgs = new Map()
for (const block of idx.split('\n\n')) {
  const name = block.match(/^Package: (.+)$/m)?.[1]
  if (!name) continue
  const deps = block.match(/^Depends: (.+)$/m)?.[1] ?? ''
  const filename = block.match(/^Filename: (.+)$/m)?.[1]
  if (filename) pkgs.set(name, { deps: parseDeps(deps), filename })
}
console.log('indexed:', pkgs.size, 'packages')

// Dependency closure (BFS)
const needed = new Set()
const queue = [...TARGETS]
while (queue.length > 0) {
  const name = queue.shift()
  if (needed.has(name)) continue
  const p = pkgs.get(name)
  if (!p) { console.warn('  (missing from index: ' + name + ')'); continue }
  needed.add(name)
  for (const d of p.deps) if (!needed.has(d)) queue.push(d)
}
console.log('resolved deps:', needed.size, 'packages')
console.log('  ' + [...needed].sort().join(' '))

console.log('== 2/4 下载 .deb ==')
mkdirSync(DEB_DIR, { recursive: true })
const urls = [...needed].map(n => ({ name: n, url: BASE + '/' + pkgs.get(n).filename, file: join(DEB_DIR, n + '.deb') }))
let downloaded = 0
for (const u of urls) {
  if (existsSync(u.file)) { downloaded++; continue }
  try {
    const r = await fetch(u.url, { signal: AbortSignal.timeout(60000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    writeFileSync(u.file, Buffer.from(await r.arrayBuffer()))
    downloaded++
  } catch (e) {
    console.warn('  FAIL ' + u.name + ': ' + e.message)
  }
}
console.log('downloaded:', downloaded, '/', urls.length)

console.log('== 3/4 解压到 usr/ ==')
const USR = join(OUT, 'usr')
mkdirSync(USR, { recursive: true })
let extracted = 0
for (const u of urls) {
  if (!existsSync(u.file)) continue
  const tmp = join(DEB_DIR, 'x-' + u.name)
  mkdirSync(tmp, { recursive: true })
  try {
    execSync('tar -xf "' + u.file + '" -C "' + tmp + '"', { stdio: 'ignore' })
    const dataTar = join(tmp, 'data.tar.xz')
    if (existsSync(dataTar)) {
      // Termux debs carry full root-relative paths
      // (data/data/com.termux/files/usr/...) — strip to the prefix root.
      execSync('tar -xf "' + dataTar + '" --strip-components=6 -C "' + USR + '"', { stdio: 'ignore' })
      extracted++
    }
  } catch (e) {
    console.warn('  EXTRACT FAIL ' + u.name + ': ' + e.message)
  }
}
console.log('extracted:', extracted)

console.log('== 4/4 readelf 结构验证 ==')
for (const bin of ['bin/node', 'bin/bash', 'bin/ls']) {
  const p = join(USR, bin)
  if (!existsSync(p)) { console.log('  MISSING ' + bin); continue }
  try {
    const h = execSync('readelf -h "' + p + '" 2>&1', { encoding: 'utf8' })
    const machine = h.match(/Machine:s+(.+)/)?.[1] ?? '?'
    const interp = execSync('readelf -l "' + p + '" 2>&1', { encoding: 'utf8' }).match(/interpreter:s+(.+)/)?.[1] ?? '?'
    console.log('  ' + bin + ': ' + machine.trim() + ' | interp: ' + interp.trim())
  } catch (e) {
    console.log('  ' + bin + ': readelf failed (' + e.message.split('\n')[0] + ')')
  }
}

function parseDeps(deps) {
  return deps.split(',').map(s => s.trim().split(' ')[0].trim()).filter(Boolean)
}
console.log('DONE — arm64 tree at ' + OUT)