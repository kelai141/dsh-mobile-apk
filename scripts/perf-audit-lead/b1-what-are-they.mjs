import { readFileSync } from 'node:fs'
const f = process.argv[2]
const src = readFileSync(f, 'utf8')
const re = /data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)/g
const webpSize = (b) => {
  if (b.length < 30) return undefined
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const fmt = b.toString('ascii', 12, 16)
  if (fmt === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), fmt }
  if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, fmt }
  if (fmt === 'VP8L') { const bits = b.readUInt32LE(21); return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1, fmt } }
  return { fmt }
}
let m, i = 0
while ((m = re.exec(src)) !== null) {
  i++
  const mime = m[1]
  const buf = Buffer.from(m[2], 'base64')
  let dim = mime === 'webp' ? webpSize(buf) : undefined
  if (mime === 'svg+xml') dim = { svgHead: buf.toString('utf8').slice(0, 70).replace(/\s+/g, ' ') }
  const before = src.slice(Math.max(0, m.index - 250), m.index)
  const nm = /([A-Za-z_$][\w$]*)\s*[:=]\s*["'`]?$/.exec(before)
  console.log(String(i).padStart(2) + '. ' + mime.padEnd(8) + ' bytes=' + String(buf.length).padStart(7) + ' dim=' + JSON.stringify(dim) + (nm ? '  var=' + nm[1] : ''))
}