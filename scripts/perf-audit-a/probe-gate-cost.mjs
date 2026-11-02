#!/usr/bin/env node
// scripts/perf-audit-a/probe-gate-cost.mjs
// 任务 A1 判据工具：复现 check-gate-skips.mjs 的 probeAll（并发 8，无参跑每个门禁，
// 抓退出码与耗时），输出逐门禁耗时表。目的：解释 check-gate-skips 单条 200-300 s 的构成。
//
// 与 check-gate-skips 的差别：这里**只测量**，不做判据、不写拦截钩子，因此耗时略低于真门禁。
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(dirname(HERE))
const SCRIPTS = join(ROOT, 'scripts')
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 8)
const TIMEOUT_MS = 600 * 1000

const collect = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  if (e.name === 'node_modules' || e.name.startsWith('.')) return []
  const rel = prefix ? prefix + '/' + e.name : e.name
  if (e.isDirectory()) return collect(join(dir, e.name), rel)
  return e.name.startsWith('check-') && e.name.endsWith('.mjs') ? [rel] : []
})
const files = collect(SCRIPTS).sort().filter((f) => f !== 'check-gate-skips.mjs')

const run1 = (file) => new Promise((resolve) => {
  const t0 = process.hrtime.bigint()
  const child = spawn(process.execPath, [join(SCRIPTS, file)], { cwd: ROOT, stdio: 'ignore' })
  let timedOut = false
  const killer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, TIMEOUT_MS)
  child.on('error', () => { clearTimeout(killer); resolve({ file, ms: Number(process.hrtime.bigint() - t0) / 1e6, exit: null, timedOut }) })
  child.on('exit', (code) => { clearTimeout(killer); resolve({ file, ms: Number(process.hrtime.bigint() - t0) / 1e6, exit: code, timedOut }) })
})

const results = new Array(files.length)
let next = 0
const t0 = process.hrtime.bigint()
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, async () => {
  while (next < files.length) {
    const i = next; next += 1
    results[i] = await run1(files[i])
  }
}))
const wall = Number(process.hrtime.bigint() - t0) / 1e6
results.sort((a, b) => b.ms - a.ms)
const sum = results.reduce((a, r) => a + r.ms, 0)
console.log(JSON.stringify({
  gates: files.length, concurrency: CONCURRENCY, wallMs: Math.round(wall),
  serialSumMs: Math.round(sum),
  top: results.slice(0, 25).map((r) => ({ file: r.file, ms: Math.round(r.ms), exit: r.exit, timedOut: r.timedOut })),
  bottom: results.slice(-8).map((r) => ({ file: r.file, ms: Math.round(r.ms), exit: r.exit })),
  totalGatesOver1s: results.filter((r) => r.ms > 1000).length,
  totalMsTop5: Math.round(results.slice(0, 5).reduce((a, r) => a + r.ms, 0)),
}, null, 1))
