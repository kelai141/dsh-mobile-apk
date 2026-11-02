import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const captured = JSON.parse(readFileSync(join(root, 'scripts/patches/tests/fixtures/manifest.json'), 'utf8'))
let files = 0, dirs = 0
for (const [d, fx] of Object.entries(captured.fixtures)) { dirs++; files += Object.keys(fx.fileSha256 ?? {}).length }
console.log('fixture dirs =', dirs, ' files =', files)
console.log('=> each file costs 2 subprocess-ish ops (readFileSync + git cat-file --filters)')
console.log('=> git spawns in this single test =', files)
console.log('=> at ~55ms/spawn  =>  ~' + (files * 55 / 1000).toFixed(1) + ' s')
