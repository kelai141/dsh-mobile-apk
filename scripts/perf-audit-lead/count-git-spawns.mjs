// 量化 check-upstream-patch-bytes.test.mjs 里的 git 子进程 spawn 次数
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const matrix = JSON.parse(readFileSync(join(root, 'scripts/third-party-licenses.json'), 'utf8'))
const captured = JSON.parse(readFileSync(join(root, 'scripts/patches/tests/fixtures/manifest.json'), 'utf8'))
console.log('androidComponents (each does 1 git cat-file --filters):', matrix.androidComponents.length)
console.log('fixtures manifest keys:', Object.keys(captured).join(', '))
const src = readFileSync(join(root, 'scripts/check-upstream-patch-bytes.test.mjs'), 'utf8')
console.log('execFileSync call sites in test:', (src.match(/execFileSync\(/g) || []).length)
console.log('filtered() helper call sites:', (src.match(/filtered\(/g) || []).length)
// measure the cost of ONE git cat-file --filters
const t0 = Date.now()
execFileSync('git', ['-c', 'core.autocrlf=true', 'cat-file', '--filters', 'HEAD:scripts/patches/upstream/pi-ai-1.1.0.patch'], { cwd: root })
console.log('one git cat-file --filters =', Date.now() - t0, 'ms')
