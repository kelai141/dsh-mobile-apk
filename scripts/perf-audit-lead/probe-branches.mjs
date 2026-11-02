import { execFileSync } from 'node:child_process'
const git = (...a) => { try { return execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1e8 }).trim() } catch { return '' } }
const BASE = '47869404'
const branches = ['perf/0.14.10-startup','perf/0.14.10-power','perf/0.14.10-ui-injection','perf/0.14.10-integration','perf/engine-esm-resolve','perf/snapshot-secrets-single-extract','perf/trim-release-gates']
console.log('=== branch merge status vs origin/main ===')
for (const b of branches) {
  const sha = git('rev-parse', b); if (!sha) { console.log(b, 'MISSING'); continue }
  let inMain = false
  try { execFileSync('git', ['merge-base','--is-ancestor', sha, BASE]); inMain = true } catch {}
  const ahead = git('rev-list','--count', BASE + '..' + b)
  const behind = git('rev-list','--count', b + '..' + BASE)
  console.log(b.padEnd(38), sha.slice(0,8), inMain ? 'ANCESTOR-OF-MAIN' : 'not-in-main', 'ahead=' + ahead, 'behind=' + behind)
}
console.log('\n=== audit-like docs across all refs ===')
const names = git('for-each-ref','--format=%(refname:short)','refs/heads','refs/remotes').split('\n').filter(Boolean)
const found = new Set()
for (const ref of ['origin/main', ...names]) {
  const files = git('ls-tree','-r','--name-only', ref).split('\n')
  for (const f of files) if (/AUDIT|PERF-|perf-|BOOT-|SPEED|性能审计/i.test(f) && /\.md$/.test(f)) {
    const key = ref + ' :: ' + f
    if (!found.has(key)) { found.add(key) }
  }
}
console.log([...found].sort().join('\n'))
