import { readFileSync } from 'node:fs'
const lines = readFileSync('scripts/perf-audit-lead/snapshot-index.txt', 'utf8').split(/\r?\n/).filter(Boolean)
let files = 0, dirs = 0, links = 0, other = 0, totalBytes = 0
const byExt = new Map(), byTopDir = new Map(), byPkg = new Map()
const cats = { map: [0,0], dts: [0,0], test: [0,0], docs: [0,0], locale: [0,0], ts: [0,0], other: [0,0] }
const all = []
const RE = /^(\S+)\s+(\S+)\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.*?)\s*$/
for (const raw of lines) {
  const m = raw.match(RE)
  if (!m) { other++; continue }
  const perms = m[1], size = Number(m[3]), name = m[4]
  all.push({ perms, size, name })
  if (perms.startsWith('d')) { dirs++; continue }
  if (perms.startsWith('l')) { links++; continue }
  files++; totalBytes += size
  const base = name.split('/').pop()
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : ''
  byExt.set(ext, (byExt.get(ext) ?? 0) + size)
  byTopDir.set(name.split('/').slice(0,2).join('/'), (byTopDir.get(name.split('/').slice(0,2).join('/')) ?? 0) + size)
  const pkgM = name.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//)
  if (pkgM) byPkg.set(pkgM[1], (byPkg.get(pkgM[1]) ?? 0) + size)
  const seg = '/' + name + '/'
  if (/\.map$/.test(name)) { cats.map[0]++; cats.map[1] += size }
  else if (/\.d\.(ts|mts|cts)$/.test(name)) { cats.dts[0]++; cats.dts[1] += size }
  else if (/\/(test|tests|__tests__|spec|fixtures|__fixtures__)\//.test(seg)) { cats.test[0]++; cats.test[1] += size }
  else if (/\.(md|markdown|txt|rst)$/i.test(name) || /\/(docs|man|examples?)\//.test(seg)) { cats.docs[0]++; cats.docs[1] += size }
  else if (/\/(locale|locales|i18n|lang|translations?)\//.test(seg) || /\.(po|mo|pot)$/.test(name)) { cats.locale[0]++; cats.locale[1] += size }
  else if (/\.tsx?$/.test(name)) { cats.ts[0]++; cats.ts[1] += size }
  else { cats.other[0]++; cats.other[1] += size }
}
const MB = (n) => (n / 1048576).toFixed(2)
const pct = (n) => (totalBytes ? (100 * n / totalBytes).toFixed(2) + '%' : 'n/a')
console.log('=== ARCHIVE STRUCTURE ===')
console.log('entries =', lines.length, '| files =', files, '| dirs =', dirs, '| symlinks =', links, '| unparsed =', other)
console.log('totalUncompressed =', totalBytes, 'B =', MB(totalBytes), 'MiB')
console.log('compressed = 191.57 MiB | expansion ratio =', (totalBytes / (191.57*1048576)).toFixed(2) + 'x')
console.log('avgBytesPerFile =', Math.round(totalBytes / Math.max(files,1)))
console.log('\n=== TOP 20 EXTENSIONS BY BYTES ===')
for (const [e, s] of [...byExt].sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log(String(e||'(none)').padEnd(14), MB(s).padStart(11), 'MiB', pct(s).padStart(8))
console.log('\n=== TOP 20 DIRECTORY PREFIXES BY BYTES ===')
for (const [d, s] of [...byTopDir].sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log(d.padEnd(44), MB(s).padStart(11), 'MiB', pct(s).padStart(8))
console.log('\n=== TOP 25 node_modules PACKAGES BY BYTES ===')
for (const [p, s] of [...byPkg].sort((a,b)=>b[1]-a[1]).slice(0,25)) console.log(p.padEnd(48), MB(s).padStart(11), 'MiB', pct(s).padStart(8))
console.log('\n=== DEAD-WEIGHT CATEGORIES (mutually exclusive, priority order) ===')
for (const [k,[n,s]] of Object.entries(cats)) console.log(k.padEnd(8), 'files=' + String(n).padStart(6), MB(s).padStart(11), 'MiB', pct(s).padStart(8))
const removable = cats.map[1] + cats.dts[1] + cats.test[1]
console.log('\n>>> removable(.map + .d.ts + test fixtures) =', MB(removable), 'MiB =', pct(removable))
console.log('\n=== LARGEST 15 INDIVIDUAL FILES ===')
for (const { size, name } of all.filter(a=>a.perms.startsWith('-')).sort((a,b)=>b.size-a.size).slice(0,15)) console.log(MB(size).padStart(9), 'MiB ', name)
