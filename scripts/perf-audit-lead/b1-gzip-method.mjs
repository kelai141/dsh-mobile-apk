import { readFileSync } from 'node:fs'
import { createGzip, gzipSync } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
const buf = readFileSync(process.argv[2])
const syncRun = (level) => { const t0 = process.hrtime.bigint(); const out = gzipSync(buf, { level }); return { ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: out.length } }
const streamRun = async (level) => {
  const t0 = process.hrtime.bigint()
  let total = 0
  const g = createGzip({ level })
  g.on('data', (c) => { total += c.length })
  await pipeline(Readable.from([buf]), g, async (s) => { for await (const _ of s) void 0 })
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: total }
}
const main = async () => {
  const A = [], B = []
  for (let i = 0; i < 5; i++) { A.push(syncRun(1)); B.push(await streamRun(1)) }
  const med = (a) => a.map(x => x.ms).sort((x, y) => x - y)[2]
  console.log('file bytes = ' + buf.length)
  console.log('A gzipSync    level=1 median: ' + med(A).toFixed(1) + ' ms  out=' + A[0].bytes)
  console.log('B streaming   level=1 median: ' + med(B).toFixed(1) + ' ms  out=' + B[0].bytes)
}
main()