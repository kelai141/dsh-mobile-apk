import { readFileSync } from 'node:fs'
const s = readFileSync(process.argv[2], 'utf8')
const all = [...s.matchAll(/data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)/g)]
let onboarding = 0
const other = []
for (const m of all) {
  const before = s.slice(Math.max(0, m.index - 140), m.index)
  if (before.includes('onboarding_')) onboarding++
  else other.push({ mime: m[1], chars: m[2].length, ctx: before.replace(/\s+/g, ' ').slice(-110) })
}
console.log('total data URIs: ' + all.length)
console.log('onboarding vars: ' + onboarding)
console.log('other: ' + other.length)
for (const o of other) console.log('  ' + o.mime + ' chars=' + o.chars + '  ctx=...' + o.ctx)