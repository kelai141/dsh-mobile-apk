// Run as an initialized debug APK's UID. Measure the installed Sharp backend.
// This isolates one attachment codec path, not the Cordis service or a full upload.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { performance } = require('node:perf_hooks')

const pkg = resolve('files/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/sharp')
const input = readFileSync(process.argv[2])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const counts = process.resourceUsage()
const started = performance.now()
const sharp = require(pkg)
const loadMs = performance.now() - started
const loadCpuMs = (process.resourceUsage().userCPUTime - counts.userCPUTime
  + process.resourceUsage().systemCPUTime - counts.systemCPUTime) / 1000
const wasmLoaded = Object.keys(require.cache).some(path => path.includes('/@img/sharp-wasm32/'))
assert.ok(wasmLoaded, 'installed Sharp backend was not WASM')

const options = { failOn: 'error', limitInputPixels: false }
async function timed(name, action) {
  const before = process.cpuUsage()
  const start = performance.now()
  const result = await action()
  const { user, system } = process.cpuUsage(before)
  return { result, name, wallMs: performance.now() - start, cpuMs: (user + system) / 1000 }
}

async function run() {
  const rows = []
  for (let iteration = 0; iteration < 6; iteration++) {
    const stats = []
    const source = sharp(input, options)
    const admission = await timed('admission', async () => {
      const metadata = await source.metadata()
      assert.equal(metadata.format, 'jpeg')
      assert.equal(metadata.orientation, 6)
      await source.raw().toBuffer()
      return metadata
    })
    const { width, height } = admission.result
    stats.push({ ...admission, result: undefined })
    const encoded = await timed('resize-encode', () => sharp(input, options)
      .rotate().toColourspace('srgb').resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true }))
    stats.push({ ...encoded, result: undefined })
    const data = encoded.result.data
    const verified = await timed('verify-output', async () => {
      const result = sharp(data, options)
      const meta = await result.metadata()
      assert.deepEqual([meta.format, meta.width, meta.height], ['jpeg', 1200, 1600])
      assert.equal(meta.exif, undefined)
      assert.equal(meta.orientation, undefined)
      assert.equal(meta.space, 'srgb')
      assert.equal(meta.depth, 'uchar')
      assert.equal(meta.hasAlpha, false)
      await result.raw().toBuffer()
    })
    stats.push({ ...verified, result: undefined })
    rows.push({ iteration, source: { width, height }, stats, output: { bytes: data.length, sha256: sha256(data) } })
  }
  const bad = input.subarray(0, Math.floor(input.length / 2))
  await assert.rejects(sharp(bad, options).raw().toBuffer())
  console.log(JSON.stringify({
    node: process.version, arch: process.arch, sharp: sharp.versions, wasmLoaded, loadMs, loadCpuMs,
    peakRssKiB: process.resourceUsage().maxRSS, input: { bytes: input.length, sha256: sha256(input) }, rows,
  }, null, 2))
}

run().catch(error => { console.error(error); process.exitCode = 1 })
