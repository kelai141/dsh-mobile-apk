import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { screenCommandVerdict } from '../lib/screen-scope.js'

const cases = [String.raw`$'\x73creencap'`, String.raw`$'\163creencap'`, String.raw`$'/system/bin/\x73creencap'`]

test('#1610: encoded command names fail closed; argument words remain allowed', () => {
  for (const name of cases) {
    assert.equal(screenCommandVerdict(name + ' -p /sdcard/real.png', () => false), 'deny-unparsed')
    assert.equal(screenCommandVerdict('echo ' + name, () => false), 'allow')
  }
})

test('#1610 negative control: restoring the quote exemption reproduces the bypass', async () => {
  const source = readFileSync(new URL('../lib/screen-scope.js', import.meta.url), 'utf8')
  const old = source.replace(/(const head = firstShellWord\(segment.trim\(\)\).word;\s*)(\/\/ #1610)/,
    (_, head, comment) => head + `if (head.startsWith("$'") || head.startsWith('$"')) return false;\n` + comment)
  assert.ok(old !== source, 'negative control must actually restore the exemption')
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(old).toString('base64'))
  for (const name of cases) {
    assert.equal(mutant.screenCommandVerdict(name + ' -p /sdcard/real.png', () => false), 'allow')
  }
})
