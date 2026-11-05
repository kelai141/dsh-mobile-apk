import { readFileSync } from 'node:fs'
const lines = readFileSync('scripts/perf-audit-lead/snapshot-index.txt','utf8').split(/\r?\n/).filter(Boolean)
const RE = /^(\S+)\s+(\S+)\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.*?)\s*$/
const files = []
for (const raw of lines) { const m = raw.match(RE); if (!m || !m[1].startsWith('-')) continue
  files.push({ size: Number(m[3]), name: m[4] }) }
const MB = n => (n/1048576).toFixed(2)
const total = files.reduce((a,f)=>a+f.size,0)
console.log('parsed files:', files.length, ' total MiB:', MB(total))

function report(label, pred) {
  const hit = files.filter(pred)
  const s = hit.reduce((a,f)=>a+f.size,0)
  const dirs = new Map()
  for (const f of hit) { const d = f.name.split('/').slice(0,4).join('/'); dirs.set(d,(dirs.get(d)??0)+f.size) }
  console.log('\n### ' + label + ' -> ' + hit.length + ' files, ' + MB(s) + ' MiB (' + (100*s/total).toFixed(2) + '%)')
  for (const [d,v] of [...dirs].sort((a,b)=>b[1]-a[1]).slice(0,6)) console.log('    ' + MB(v).padStart(9) + ' MiB  ' + d)
}

report('man pages (.1-.9, .man)', f => /\.(1|2|3|4|5|6|7|8|9|n|man)(\.gz)?$/.test(f.name))
report('gobject-introspection .gir/.typelib', f => /\.(gir|typelib)$/.test(f.name))
report('C headers usr/include', f => f.name.startsWith('usr/include/'))
report('perl docs .pod/.html under share', f => /\.pod$/.test(f.name))
report('TypeScript sources .ts in node_modules', f => /node_modules\//.test(f.name) && /\.tsx?$/.test(f.name) && !/\.d\.ts$/.test(f.name))
report('.d.ts anywhere', f => /\.d\.(ts|mts|cts)$/.test(f.name))
report('test/spec/fixtures dirs', f => /\/(test|tests|__tests__|spec|fixtures|__fixtures__)\//.test('/'+f.name+'/'))
report('markdown docs', f => /\.(md|markdown)$/i.test(f.name))
report('txt docs', f => /\.txt$/i.test(f.name))
report('locale/po/mo', f => /\.(po|mo|pot)$/.test(f.name) || /\/(locale|locales)\//.test('/'+f.name+'/'))
report('sourcemaps .map', f => /\.map$/.test(f.name))
report('vim runtime usr/share/vim', f => f.name.startsWith('usr/share/vim'))
report('perl .pm', f => /\.pm$/.test(f.name))
report('python .py', f => /\.py$/.test(f.name))
report('static libs .a', f => /\.a$/.test(f.name))
report('static .la (libtool)', f => /\.la$/.test(f.name))
report('gzip .gz (non traineddata)', f => /\.gz$/.test(f.name) && !/traineddata/.test(f.name))
report('home/.dsh profiles HEADLESS (not used on device?)', f => f.name.includes('profiles/headless'))
report('home/.dsh headless-bad profile', f => f.name.includes('profiles/headless-bad'))
report('tessdata .traineddata.gz', f => /traineddata/.test(f.name))

console.log('\n=== usr/share breakdown ===')
const share = files.filter(f=>f.name.startsWith('usr/share/'))
const sd = new Map(); for (const f of share) { const d=f.name.split('/').slice(0,3).join('/'); sd.set(d,(sd.get(d)??0)+f.size) }
for (const [d,v] of [...sd].sort((a,b)=>b[1]-a[1]).slice(0,15)) console.log('  ' + MB(v).padStart(9) + ' MiB  ' + d)

console.log('\n=== @deepseek-ai/dsh breakdown (200.74 MiB) ===')
const dsh = files.filter(f=>f.name.includes('usr/lib/node_modules/@deepseek-ai/dsh/'))
const dd = new Map(); for (const f of dsh) { const m=f.name.match(/@deepseek-ai\/dsh\/node_modules\/((?:@[^/]+\/)?[^/]+)\//); const k=m?m[1]:'(own files)'; dd.set(k,(dd.get(k)??0)+f.size) }
console.log('  total', MB(dsh.reduce((a,f)=>a+f.size,0)), 'MiB')
for (const [d,v] of [...dd].sort((a,b)=>b[1]-a[1]).slice(0,20)) console.log('  ' + MB(v).padStart(9) + ' MiB  ' + d)
