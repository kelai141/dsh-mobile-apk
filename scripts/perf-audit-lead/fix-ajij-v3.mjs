import { readFileSync, writeFileSync } from 'node:fs'
const D = 'docs/AGENTS/EXECUTION-MAP.md'
let d = readFileSync(D, 'utf8')
const a = 'MainActivity.kt:1532#expect=webView.addJavascriptInterface('
const b = 'MainActivity.kt:1546#expect=webView.addJavascriptInterface('
const n = d.split(a).length - 1
d = d.split(a).join(b)
writeFileSync(D, d)
console.log('rewrote: ' + n + ' (1532 -> 1546)')