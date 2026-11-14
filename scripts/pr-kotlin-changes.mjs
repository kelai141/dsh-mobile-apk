#!/usr/bin/env node
// Path-only PR job selection; no business checks or build dependencies.
import { appendFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { changedPaths, rangeFromEvent } from './check-added-secrets.mjs'

export function hasKotlinChanges(range) {
  return changedPaths(range).some(path => path.endsWith('.kt'))
}

export function main(argv, env = process.env) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    const result = spawnSync(process.execPath, ['--test', join(dirname(fileURLToPath(import.meta.url)), 'tests/kotlin-changes.test.mjs')], { stdio: 'inherit' })
    return result.status ?? 2
  }
  try {
    if (argv.length !== 2 || argv[0] !== '--event') throw new Error('Expected --event <GitHub event JSON>')
    const kotlin = hasKotlinChanges(rangeFromEvent(JSON.parse(readFileSync(argv[1], 'utf8'))))
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'kotlin=' + kotlin + '\n')
    console.log('PASS pr-kotlin-changes: kotlin=' + kotlin)
    return 0
  } catch {
    console.error('ERROR pr-kotlin-changes: invalid event or unavailable Git range; selection not emitted')
    return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
