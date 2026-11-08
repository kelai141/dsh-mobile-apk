// Mirrors the read-only measure() in dsh-android-linux-env/src/runtime-cache.ts.
const { lstatSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

function measure(path) {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return [stat.isFile() ? stat.size : 0, 1]
  let bytes = 0
  let files = 0
  for (const name of readdirSync(path)) {
    try {
      const [b, f] = measure(join(path, name))
      bytes += b
      files += f
    } catch {
      // The production planner skips unreadable children.
    }
  }
  return [bytes, files]
}

if (process.argv.length !== 3) throw new Error('usage: compare-node.cjs <test directory>')
const [bytes, files] = measure(process.argv[2])
console.log(`bytes=${bytes} files=${files}`)
