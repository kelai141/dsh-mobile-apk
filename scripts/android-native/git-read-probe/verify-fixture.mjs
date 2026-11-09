import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const binary = resolve(process.argv[2])
const fixture = mkdtempSync(join(tmpdir(), 'dsh-git-read-'))
const run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 60000 })
const fixtureScript = fileURLToPath(new URL('make-fixture.mjs', import.meta.url))
try {
  run(process.execPath, [fixtureScript, fixture])
  const repo = join(fixture, 'repo.git')
  const { baseCommit, headCommit } = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8'))
  const args = ['--repo', repo, '--base', baseCommit, '--head', headCommit,
    '--iterations', '1', '--warm-iterations', '2']
  const keys = ['blobCount', 'totalBytes', 'treeDigest', 'contentDigest', 'missing',
    'binarySha256', 'binaryLen', 'emptySha256', 'latin1Sha256', 'lookups']
  const project = row => Object.fromEntries(keys.map(key => [key, row[key]]))
  const check = () => {
    const gix = JSON.parse(run(binary, [...args, '--engine', 'gix']))
    for (const cache of [[], ['--cache-blobs']]) {
      const batch = JSON.parse(run(binary, [...args, '--engine', 'batch', '--git', 'git', ...cache]))
      assert.deepEqual(project(gix), project(batch))
      assert.equal(batch.spawns, '1')
    }
    assert.equal(gix.spawns, '0')
    assert.equal(gix.blobCount, '14')
    assert.equal(gix.missing, 'missing')
    assert.match(gix.lookups, /docs\/report\t2026\.md=[0-9a-f]{40}/)
    assert.match(gix.lookups, /src\/aXbYc1\.txt=absent/)
    return project(gix)
  }
  const loose = check()
  run('git', ['--git-dir', repo, 'update-ref', 'refs/heads/probe', headCommit])
  run('git', ['--git-dir', repo, 'repack', '-a', '-d'])
  const objects = run('git', ['--git-dir', repo, 'count-objects', '-v'])
  assert.match(objects, /^count: 0$/m)
  assert.match(objects, /^packs: 1$/m)
  assert.deepEqual(check(), loose)
  console.log('Git loose and packed fixture matched across all three variants')
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
