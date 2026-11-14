import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { hasKotlinChanges } from '../pr-kotlin-changes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SCRIPT = join(ROOT, 'scripts/pr-kotlin-changes.mjs')
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'kotlin-changes-'))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(cwd, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0' }
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  git('init', '-q'); git('config', 'user.name', 'Gate Test'); git('config', 'user.email', 'gate@example.invalid')
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false')
  const put = (path, data = 'fixture\n') => { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), data) }
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD') }
  const cli = (event) => {
    put('event.json', JSON.stringify(event))
    const output = join(cwd, 'output.txt')
    const result = spawnSync(process.execPath, [SCRIPT, '--event', 'event.json'], { cwd, env: { ...env, GITHUB_OUTPUT: output }, encoding: 'utf8' })
    return { ...result, output: result.status === 0 ? readFileSync(output, 'utf8') : '' }
  }
  return { cwd, git, put, commit, cli }
}

test('controlled negative: docs, JS and Gradle .kts only must not start Kotlin job', t => {
  const f = fixture(t)
  f.put('base.txt'); const base = f.commit()
  f.put('docs/Kotlin.md'); f.put('build.gradle.kts'); f.put('scripts/test.mjs'); f.put('not.kt.txt')
  const head = f.commit()
  assert.equal(hasKotlinChanges({ base, head, cwd: f.cwd }), false)
  const r = f.cli({ before: base, after: head })
  assert.equal(r.status, 0)
  assert.equal(r.output, 'kotlin=false\n')
})

test('added and modified .kt at any depth start Kotlin job', t => {
  const f = fixture(t)
  f.put('base.txt'); const base = f.commit()
  f.put('app/src/test/中文 Test.kt', 'class Test\n'); const added = f.commit()
  assert.equal(hasKotlinChanges({ base, head: added, cwd: f.cwd }), true)
  f.put('app/src/test/中文 Test.kt', 'class Modified\n'); const head = f.commit()
  assert.equal(hasKotlinChanges({ base: added, head, cwd: f.cwd }), true)
  const r = f.cli({ pull_request: { base: { sha: base }, head: { sha: head } } })
  assert.equal(r.status, 0)
  assert.equal(r.output, 'kotlin=true\n')
})

test('deleted .kt starts Kotlin job', t => {
  const f = fixture(t)
  f.put('Only.kt'); const base = f.commit()
  f.git('rm', 'Only.kt'); f.put('base.txt'); const head = f.commit()
  assert.equal(hasKotlinChanges({ base, head, cwd: f.cwd }), true)
})

test('renamed .kt to non-Kotlin and reverse rename both start Kotlin job', t => {
  const f = fixture(t)
  f.put('Old.kt'); const base = f.commit()
  f.git('mv', 'Old.kt', 'not-kotlin.txt'); const renamed = f.commit()
  assert.equal(hasKotlinChanges({ base, head: renamed, cwd: f.cwd }), true)
  f.git('mv', 'not-kotlin.txt', 'New.kt'); const head = f.commit()
  assert.equal(hasKotlinChanges({ base: renamed, head, cwd: f.cwd }), true)
})

test('PR ignores base-only Kotlin changes; uses event head, not checkout HEAD', t => {
  const f = fixture(t)
  f.put('common.txt'); const common = f.commit()
  f.git('checkout', '-qb', 'topic'); f.put('docs.md'); const head = f.commit()
  f.git('checkout', '--detach', common); f.put('BaseOnly.kt'); const base = f.commit()
  assert.equal(hasKotlinChanges({ base, head, mergeBase: true, cwd: f.cwd }), false)
})

test('new push from zero-before checks current .kt paths; bad refs fail without false selection', t => {
  const f = fixture(t)
  f.put('Root.kt'); const head = f.commit()
  const r = f.cli({ before: '0'.repeat(40), after: head })
  assert.equal(r.status, 0); assert.equal(r.output, 'kotlin=true\n')
  const bad = f.cli({ before: 'f'.repeat(40), after: head })
  assert.equal(bad.status, 2); assert.equal(bad.output, '')
})

test('workflow skips whole compile job unless path selector returns true; static stays independent', () => {
  const text = readFileSync(join(ROOT, '.github/workflows/pr-gate.yml'), 'utf8')
  const changes = text.split('  changes:\n')[1].split('  compile:\n')[0]
  const compile = text.split('  compile:\n')[1].split('  maintenance:\n')[0]
  assert.match(changes, /kotlin: \$\{\{ steps\.paths\.outputs\.kotlin \}\}/)
  assert.match(changes, /fetch-depth: 0/)
  assert.match(changes, /run: node scripts\/pr-kotlin-changes\.mjs --self-test/)
  assert.match(changes, /id: paths\n\s+run: node scripts\/pr-kotlin-changes\.mjs --event "\$GITHUB_EVENT_PATH"/)
  assert.match(compile, /needs: changes/)
  assert.match(compile, /if: \$\{\{ needs\.changes\.outputs\.kotlin == 'true' \}\}/)
  const staticJob = text.split('  static:\n')[1].split('  changes:\n')[0]
  assert.doesNotMatch(staticJob, /needs: changes|pr-kotlin-changes/)
})
