import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { rangeFromEvent, scanRange, scanPatch } from '../check-added-secrets.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCANNER = join(ROOT, 'scripts/check-added-secrets.mjs')
// Construct fake values at runtime so this test source does not itself contain a match.
const secret = 'ghp_' + 'A1b2C3d4'.repeat(4)
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'added-secrets-'))
  // Tests must not depend on host Git aliases, signing, hooks, or readable global config.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' }
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  function git(...args) {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '-q')
  git('config', 'user.name', 'Gate Test')
  git('config', 'user.email', 'gate@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  function put(path, data) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), data) }
  function commit() { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  function cli(...args) { return spawnSync(process.execPath, [SCANNER, ...args], { cwd, env, encoding: 'utf8' }) }
  return { cwd, git, put, commit, cli }
}

test('unchanged historical secrets and deletion are green; new nonsecret lines only', t => {
  const f = fixture(t)
  f.put('app/src/old.txt', secret + '\nkeep\n')
  const base = f.commit()
  f.put('app/src/old.txt', secret + '\nkeep\nnew ordinary line\n')
  const head = f.commit()
  assert.deepEqual(scanRange({ base, head, cwd: f.cwd }), { findings: [], addedLines: 1 })
  f.put('app/src/old.txt', 'keep\nnew ordinary line\n')
  assert.equal(scanRange({ base: head, head: f.commit(), cwd: f.cwd }).findings.length, 0)
})

test('controlled negative: added token outside old scan dirs fails CLI without leaking value', t => {
  const f = fixture(t)
  f.put('base.txt', 'base\n'); const base = f.commit()
  f.put('docs/new secret.txt', 'ordinary\n' + secret + '\n')
  const head = f.commit()
  const r = f.cli('--base', base, '--head', head)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /docs\/new secret\.txt.*:2 \(GitHub token\)/)
  assert.ok(!(r.stdout + r.stderr).includes(secret), 'must not echo token')
})

test('all four existing secret patterns remain blocking; placeholders are clean', () => {
  const values = ['sk-' + 'A'.repeat(16), secret, 'AKIA' + 'Z9'.repeat(8), 'xoxb-' + 'b2'.repeat(8)]
  const patch = 'diff --git a/a b/a\n+++ b/a\n@@ -0,0 +1,5 @@\n' + values.map(s => '+' + s).join('\n') + '\n+sk-example ghp_example\n'
  assert.equal(scanPatch(patch).findings.length, 4)
})

test('hunks ignore filename headers/context/deletions; ++ content and line numbers work', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/' + secret + '\n@@ -1,2 +1,2 @@\n ' + secret + '\n-' + secret + '\n+++ ' + secret + '\n@@ -8,0 +9 @@\n+' + secret + '\r\n\\ No newline at end of file\n'
  assert.deepEqual(scanPatch(patch).findings.map(f => f.line), [2, 9])
  assert.equal(scanPatch(patch).addedLines, 2)
})

test('pure rename, binary, conflict marker, mode-only and no-final-newline changes', t => {
  const f = fixture(t)
  f.put('old.txt', secret + '\n')
  f.put('binary.dat', Buffer.from('old\0' + secret))
  const base = f.commit()
  f.git('mv', 'old.txt', 'renamed.txt')
  f.git('update-index', '--chmod=+x', 'renamed.txt')
  f.put('binary.dat', Buffer.from('new\0' + secret))
  f.put('markers.txt', '<<<<<<< example\n=======\n>>>>>>> example')
  const head = f.commit()
  assert.equal(scanRange({ base, head, cwd: f.cwd }).findings.length, 0)
  f.put('markers.txt', '<<<<<<< example\n=======\n>>>>>>> example\n' + secret)
  assert.equal(scanRange({ base: head, head: f.commit(), cwd: f.cwd }).findings[0].line, 4)
})

test('Unicode and quoted filenames report the correct path', t => {
  const f = fixture(t)
  f.put('base', 'base'); const base = f.commit()
  const path = 'plugins/中文 空格.txt'
  f.put(path, secret + '\n')
  assert.equal(scanRange({ base, head: f.commit(), cwd: f.cwd }).findings[0].file, path)
  const quoted = 'diff --git a/x b/x\n+++ "b/a\\tb.txt"\n@@ -0,0 +1 @@\n+' + secret + '\n'
  assert.equal(scanPatch(quoted).findings[0].file, 'a\tb.txt')
})

test('PR merge-base scans multiple commits but not base-only or synthetic-merge content', t => {
  const f = fixture(t)
  f.put('common', 'common'); const common = f.commit()
  f.git('checkout', '-qb', 'topic')
  f.put('topic.txt', secret + '\n'); f.commit()
  f.put('later.txt', 'later\n'); const head = f.commit()
  f.git('checkout', '--detach', common)
  f.put('base-only.txt', secret + '\n'); const base = f.commit()
  // HEAD deliberately differs from event head.
  const event = { pull_request: { base: { sha: base }, head: { sha: head } } }
  f.put('event.json', JSON.stringify(event))
  const result = scanRange({ ...rangeFromEvent(event), cwd: f.cwd })
  assert.deepEqual(result.findings.map(x => x.file), ['topic.txt'])
  assert.equal(f.cli('--event', 'event.json').status, 1)
})

test('push uses before..after and zero-before scans only new head text', t => {
  const f = fixture(t)
  f.put('old', secret + '\n'); const base = f.commit()
  f.put('new', 'clean\n'); const head = f.commit()
  f.put('event.json', JSON.stringify({ before: base, after: head }))
  assert.equal(f.cli('--event', 'event.json').status, 0)
  assert.equal(scanRange({ base: '0'.repeat(40), head, cwd: f.cwd }).findings.length, 1)
})

test('net diff intentionally ignores intermediate added-then-deleted lines', t => {
  const f = fixture(t)
  f.put('file', 'clean\n'); const base = f.commit()
  f.put('file', secret + '\n'); f.commit()
  f.put('file', 'clean again\n'); const head = f.commit()
  assert.equal(scanRange({ base, head, cwd: f.cwd }).findings.length, 0)
})

test('missing, invalid, unavailable refs/events fail 2 rather than whole-tree fallback', t => {
  const f = fixture(t)
  f.put('base', 'base'); const head = f.commit()
  for (const args of [[], ['--base', 'missing', '--head', head], ['--base', 'f'.repeat(40), '--head', head], ['--event', 'absent.json']]) {
    assert.equal(f.cli(...args).status, 2)
  }
  f.put('bad.json', '{' + secret)
  const r = f.cli('--event', 'bad.json')
  assert.equal(r.status, 2)
  assert.ok(!(r.stdout + r.stderr).includes(secret))
  assert.throws(() => rangeFromEvent({}))
})

test('large diff is not silently truncated before token at tail', t => {
  const f = fixture(t)
  f.put('base', 'base'); const base = f.commit()
  f.put('large.txt', ('x'.repeat(120) + '\n').repeat(10000) + secret + '\n')
  const result = scanRange({ base, head: f.commit(), cwd: f.cwd })
  assert.equal(result.findings[0].line, 10001)
})

test('static workflow runs only scanner and self-test, preserving required check name', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/pr-gate.yml'), 'utf8')
  const staticJob = workflow.split('  static:\n')[1].split('  compile:\n')[0]
  assert.match(staticJob, /name: 冲突标记与敏感信息扫描/)
  assert.match(staticJob, /fetch-depth: 0/)
  assert.deepEqual([...staticJob.matchAll(/^\s+run: (.*)$/gm)].map(m => m[1]), [
    'node scripts/check-added-secrets.mjs --self-test',
    'node scripts/check-added-secrets.mjs --event "$GITHUB_EVENT_PATH"',
  ])
})
