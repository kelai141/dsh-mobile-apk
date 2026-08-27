// Extract the tool-call sequence from a session log (T2 regression baseline)
import { readFileSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8')
const seq = []
for (const line of text.trim().split('\n')) {
  const j = JSON.parse(line)
  if (j.type === 'tool/call') {
    const d = j.data ?? {}
    seq.push({ name: d.name, args: String(d.arguments ?? '') })
  }
}
console.log(JSON.stringify(seq, null, 1))
