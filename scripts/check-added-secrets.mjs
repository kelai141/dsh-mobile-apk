#!/usr/bin/env node
// PR source hygiene only: scan net added text lines, never the checkout or business contracts.
// Usage: --event <GitHub event JSON> | --base <sha> --head <sha> [--merge-base] | --self-test
// Exit: 0 clean; 1 suspected secret; 2 invalid input / incomplete Git evidence.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RULES = [
  ['API key', /sk-[A-Za-z0-9]{16,}/],
  ['GitHub token', /ghp_[A-Za-z0-9]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
]
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i
const ZERO = /^0+$/

function git(args, cwd) {
  const result = spawnSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    // Object-only inspection needs no host aliases/includes or global config permissions.
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' },
  })
  // Git stderr can contain arbitrary repository content. Do not echo it into CI logs.
  if (result.error || result.status !== 0) throw new Error('Git evidence unavailable; fetch the event commits and their history before scanning')
  return result.stdout
}

function commit(sha, cwd) {
  if (typeof sha !== 'string' || !SHA.test(sha) || ZERO.test(sha)) throw new Error('Expected a nonzero full commit SHA')
  return git(['rev-parse', '--verify', sha + '^{commit}'], cwd).trim()
}

export function rangeFromEvent(event) {
  if (event.pull_request) {
    return { base: event.pull_request.base?.sha, head: event.pull_request.head?.sha, mergeBase: true }
  }
  if (typeof event.before === 'string' && typeof event.after === 'string') {
    return { base: event.before, head: event.after, mergeBase: false }
  }
  throw new Error('Expected a pull_request or push event with commit SHAs')
}

// core.quotePath=false keeps Unicode readable; Git still C-quotes tabs/newlines/backslashes.
function newPath(header) {
  let path = header.slice(4)
  if (path.startsWith('"')) {
    const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }
    path = path.slice(1, -1).replace(/\\([0-7]{1,3}|[abfnrtv"\\])/g, (_, value) => (
      /^[0-7]/.test(value) ? String.fromCharCode(parseInt(value, 8)) : escapes[value] ?? value
    ))
  } else {
    path = path.replace(/\t$/, '')
  }
  return path.startsWith('b/') ? path.slice(2) : path
}

export function scanPatch(patch) {
  const findings = []
  let file = null
  let lineNumber = 0
  let remaining = 0
  let addedLines = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { file = null; remaining = 0; continue }
    if (line.startsWith('+++ ') && remaining === 0) { file = newPath(line); continue }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) { lineNumber = Number(hunk[1]); remaining = hunk[2] === undefined ? 1 : Number(hunk[2]); continue }
    if (remaining > 0 && line.startsWith('+')) {
      addedLines++
      for (const [kind, pattern] of RULES) {
        if (pattern.test(line.slice(1))) findings.push({ file, line: lineNumber, kind })
      }
      lineNumber++
      remaining--
    } else if (remaining > 0 && line.startsWith(' ')) {
      lineNumber++
      remaining--
    }
  }
  return { findings, addedLines }
}

export function resolveRange({ base, head, mergeBase = false, cwd = process.cwd() }) {
  const headCommit = commit(head, cwd)
  let start
  if (typeof base === 'string' && SHA.test(base) && ZERO.test(base) && !mergeBase) {
    // A new branch has no previous tree. Scan this commit's text, not historical commits.
    start = git(['hash-object', '-t', 'tree', '--stdin'], cwd).trim()
  } else {
    start = commit(base, cwd)
    if (mergeBase) start = git(['merge-base', start, headCommit], cwd).trim()
  }
  return { start, head: headCommit, cwd }
}

export function changedPaths(range) {
  const { start, head, cwd } = resolveRange(range)
  // Disable rename pairing so both old and new names participate (including .kt -> .txt).
  return git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none', start, head, '--'], cwd).split('\0').filter(Boolean)
}

export function scanRange(range) {
  const { start, head: headCommit, cwd } = resolveRange(range)
  const patch = git([
    '-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv',
    '--no-color', '--unified=0', '--find-renames', '--diff-filter=ACMRT', '--no-relative', '--ignore-submodules=none',
    '--src-prefix=a/', '--dst-prefix=b/', start, headCommit, '--',
  ], cwd)
  return scanPatch(patch)
}

export function main(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    const result = spawnSync(process.execPath, ['--test', join(HERE, 'tests', 'added-secrets.test.mjs')], { stdio: 'inherit' })
    return result.status ?? 2
  }
  try {
    let range
    if (argv.length === 2 && argv[0] === '--event') {
      range = rangeFromEvent(JSON.parse(readFileSync(argv[1], 'utf8')))
    } else if ((argv.length === 4 || (argv.length === 5 && argv[4] === '--merge-base')) && argv[0] === '--base' && argv[2] === '--head') {
      range = { base: argv[1], head: argv[3], mergeBase: argv.length === 5 }
    } else {
      throw new Error('Usage: --event <file> | --base <sha> --head <sha> [--merge-base] | --self-test')
    }
    const { findings, addedLines } = scanRange(range)
    for (const finding of findings) {
      // JSON-quote the path; no token values or raw source lines ever leave the scanner.
      console.error('FAIL added secret: ' + JSON.stringify(finding.file) + ':' + finding.line + ' (' + finding.kind + ')')
    }
    console.log((findings.length ? 'FAIL' : 'PASS') + ' added-secrets: added-lines=' + addedLines + ', findings=' + findings.length)
    return findings.length ? 1 : 0
  } catch {
    // Event parsing errors can also echo user-controlled text, so keep the error generic.
    console.error('ERROR added-secrets: invalid arguments/event or unavailable Git range; no whole-tree fallback')
    return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
