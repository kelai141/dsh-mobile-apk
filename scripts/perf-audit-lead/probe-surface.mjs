import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPTS = join(ROOT, 'scripts')
const collect = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === 'node_modules' || e.name.startsWith('.')) return []
  const rel = prefix ? prefix + '/' + e.name : e.name
  if (e.isDirectory()) return collect(join(dir, e.name), rel)
  return e.name.startsWith('check-') && e.name.endsWith('.mjs') ? [rel] : []
})
const all = collect(SCRIPTS).sort()
const cls = { unitTest: [], aggregator: [], runner: [], regular: [] }
for (const f of all) {
  const base = f.split('/').pop()
  if (base.endsWith('.test.mjs')) cls.unitTest.push(f)
  else if (base === 'check-release-gates.mjs' || base === 'check-gate-skips.mjs') cls.aggregator.push(f)
  else {
    // heuristic: does it spawn node --test / run suites?
    const src = readFileSync(join(SCRIPTS, f), 'utf8')
    if (/-\-test|node:test|spawnSync\(process\.execPath, \[.*--test/.test(src)) cls.runner.push(f)
    else cls.regular.push(f)
  }
}
console.log('total check-*.mjs under scripts/:', all.length)
for (const [k, v] of Object.entries(cls)) console.log(k.padEnd(12), v.length, k === 'regular' ? '' : '-> ' + v.join(', '))
console.log('\n--- runner (spawns node --test) detail ---')
for (const f of cls.runner) {
  const src = readFileSync(join(SCRIPTS, f), 'utf8')
  const hits = (src.match(/--test/g) || []).length
  console.log('  ' + f.padEnd(40) + ' --test occurrences=' + hits)
}
