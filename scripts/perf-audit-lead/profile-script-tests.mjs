// 按 check-script-tests 的同一清单逐文件计时，找出 222.6s/82.4s 的时间去向。
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT_DIR = join(ROOT, 'scripts')
const mod = await import(join(SCRIPT_DIR, 'check-script-tests.mjs')).catch(() => null)
// 模块顶层会执行主流程，所以不能 import；改为静态复刻同一口径
const INLINED = ['build-hard-manifest.test.mjs','build-injection-staging.test.mjs','check-api-route-auth-artifact.test.mjs','check-inject-completeness.test.mjs','verify-webview-settings.test.mjs']
const PLAIN = ['check-code-map-anchors.test.mjs','check-perf-instrumentation.test.mjs','verify-state-sync-modep.test.mjs']
const discovered = readdirSync(SCRIPT_DIR).filter((f) => f.endsWith('.test.mjs')).sort()
const exempt = new Set(INLINED), plainSet = new Set(PLAIN)
const candidates = discovered.filter((f) => !exempt.has(f))
const nodeTestFiles = candidates.filter((f) => !plainSet.has(f))
const plainFiles = candidates.filter((f) => plainSet.has(f))
console.log('discovered=' + discovered.length + ' candidates=' + candidates.length + ' nodeTest=' + nodeTestFiles.length + ' plain=' + plainFiles.length)
const rows = []
const t0 = Date.now()
for (const f of [...nodeTestFiles, ...plainFiles]) {
  const s = Date.now()
  const r = spawnSync(process.execPath, plainSet.has(f) ? [join('scripts', f)] : ['--test', '--test-force-exit', '--test-reporter=spec', '--test-concurrency=1', join('scripts', f)], { cwd: ROOT, encoding: 'utf8', timeout: 15 * 60 * 1000 })
  const ms = Date.now() - s
  const out = String((r.stdout ?? '') + (r.stderr ?? ''))
  const pass = /ℹ pass (\d+)/.exec(out.replace(/\r/g, ''))?.[1] ?? '-'
  const fail = /ℹ fail (\d+)/.exec(out.replace(/\r/g, ''))?.[1] ?? '-'
  rows.push({ file: f, ms, status: r.status, pass, fail, plain: plainSet.has(f) })
}
const total = Date.now() - t0
rows.sort((a, b) => b.ms - a.ms)
console.log('')
console.log('=== per-file wall (serial, sum=' + (total / 1000).toFixed(1) + 's) ===')
for (const r of rows) console.log(String(r.ms).padStart(7) + 'ms  pass=' + String(r.pass).padStart(3) + ' fail=' + String(r.fail).padStart(2) + ' exit=' + String(r.status).padStart(2) + '  ' + r.file + (r.plain ? '  [plain]' : ''))
const top = rows.slice(0, 8).reduce((a, r) => a + r.ms, 0)
console.log('')
console.log('top-8 share: ' + (100 * top / total).toFixed(1) + '%')
const sumPass = rows.filter((r) => !r.plain).reduce((a, r) => a + (Number(r.pass) || 0), 0)
const sumFail = rows.filter((r) => !r.plain).reduce((a, r) => a + (Number(r.fail) || 0), 0)
console.log('SUM pass (node:test files) =', sumPass, ' SUM fail =', sumFail)
