import { readdirSync } from 'node:fs'
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
const all = collect(SCRIPTS).sort().filter((f) => f !== 'check-gate-skips.mjs')
const isTest = (f) => /\.test\.mjs$/.test(f.split('/').pop())
const isAgg = (f) => ['check-gate-skips.mjs', 'check-release-gates.mjs'].includes(f.split('/').pop())
const pristine = all.length
const mine = all.filter((f) => !isTest(f) && !isAgg(f)).length
console.log('discovered check-*.mjs (excl self) :', pristine)
console.log('pristine probe pool (spawns)      :', pristine)
console.log('narrowed probe pool (spawns)      :', mine)
console.log('reduction                         :', pristine - mine, '(' + (100 * (pristine - mine) / pristine).toFixed(1) + '%)')
console.log('')
console.log('NOTE: check-script-tests.mjs is a RUNNER (spawns node --test x16), NOT a *.test.mjs,')
console.log('      so it stays in the probe pool. It is the remaining dominant single item.')
console.log('      in pool now? ', !isTest('check-script-tests.mjs') && !isAgg('check-script-tests.mjs'))
