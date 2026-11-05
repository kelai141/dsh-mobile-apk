import { readFileSync, writeFileSync } from 'node:fs'
const D = 'docs/AGENTS/EXECUTION-MAP.md'
const mode = process.argv[2]
let d = readFileSync(D, 'utf8')
const ORIG = 'MainActivity.kt:1546#expect=webView.addJavascriptInterface('
const BAD  = 'MainActivity.kt:1546#expect=webView.addJavascriptInterface[('
if (mode === 'break') {
  if (!d.includes(ORIG)) { console.error('anchor not found'); process.exit(2) }
  writeFileSync(D, d.replace(ORIG, BAD))
  console.log('injected: one char changed ( ( -> [( )')
} else {
  if (!d.includes(BAD)) { console.error('broken anchor not found'); process.exit(2) }
  writeFileSync(D, d.replace(BAD, ORIG))
  console.log('restored')
}