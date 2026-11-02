// 从 node --test spec reporter 输出里按文件聚合耗时，找出真正的时间去向。
import { readFileSync } from 'node:fs'
const log = readFileSync(process.argv[2], 'utf8').replace(/\r/g, '')
// spec reporter: "✔ <name> (12.3ms)" and file headers "▶ file" / "test at scripts\x.test.mjs:12:1"
const perTest = [...log.matchAll(/[✔✖ℹ▶].*?\(([\d.]+)ms\)/g)].map((m) => Number(m[1]))
const total = perTest.reduce((a, b) => a + b, 0)
console.log('tests with duration:', perTest.length)
console.log('sum of per-test durations:', (total / 1000).toFixed(1), 's')
console.log('max single test:', Math.max(...perTest).toFixed(1), 'ms')
console.log('median:', perTest.sort((a, b) => a - b)[Math.floor(perTest.length / 2)].toFixed(1), 'ms')
// count files
const files = [...log.matchAll(/test at (scripts[\\/][^:]+):/g)].map((m) => m[1])
const uniq = [...new Set(files)]
console.log('distinct test files seen in output:', uniq.length)
console.log('')
console.log('=== 时间分布 ===')
const buckets = [[0,10],[10,100],[100,1000],[1000,5000],[5000,1e9]]
for (const [lo,hi] of buckets) {
  const n = perTest.filter((x)=>x>=lo&&x<hi).length
  if (n) console.log('  ' + String(lo).padStart(5) + '-' + (hi===1e9?'inf':hi) + 'ms : ' + String(n).padStart(4) + ' tests')
}
