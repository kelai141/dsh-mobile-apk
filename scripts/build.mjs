// Build all adapter packages against their pinned rc.6 baselines.
// Usage: node scripts/build.mjs [package-dir]
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = process.argv[2]
const packages = target
  ? [target]
  : ['dsh-shell-termux', 'dsh-host-web-compat'].filter((p) => existsSync(join(root, p, 'tsconfig.json')))

for (const pkg of packages) {
  const dir = join(root, pkg)
  console.log(`build ${pkg}...`)
  execSync('npm run build', { cwd: dir, stdio: 'inherit' })
  console.log(`built ${pkg}`)
}
