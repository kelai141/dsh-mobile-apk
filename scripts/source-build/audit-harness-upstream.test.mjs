import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { auditHarnessUpstream } from './audit-harness-upstream.mjs'

test('compares committed trees, discovers package changes and requires validation for any new SHA', t => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-upstream-audit-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  const write = (path, value) => {
    const target = join(repo, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value))
  }
  const commit = message => {
    git('add', '-A')
    git('-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', message)
    return git('rev-parse', 'HEAD')
  }
  const pkg = (dir, name, fields = {}) =>
    write(dir + '/package.json', { name: '@deepseek-ai/dsh-' + name, version: '0.1.0', ...fields })
  git('init', '-q')
  write('package.json', { version: '0.2.2-rc.1', packageManager: 'pnpm@11.28.5', engines: { node: '>=24.9.0' } })
  pkg('packages/old', 'old')
  pkg('packages/custom', 'custom')
  pkg('packages/client/theme', 'theme', { exports: { node: './node.js', default: './default.js' } })
  pkg('packages/client/theme/test/fixture', 'theme')
  write('packages/client/theme/src/config.ts', 'schema 1')
  const baseline = { commit: commit('baseline'), version: '0.2.2-rc.1', packageManager: 'pnpm@11.28.5', enginesNode: '>=24.9.0' }
  assert.equal(auditHarnessUpstream(repo, baseline, baseline.commit).decision, 'already-pinned')
  const empty = auditHarnessUpstream(repo, baseline, commit('empty'))
  assert.equal(empty.decision, 'requires-validation')
  assert.deepEqual(empty.changedPaths, [])

  rmSync(join(repo, 'packages/old'), { recursive: true })
  mkdirSync(join(repo, 'extensions'))
  renameSync(join(repo, 'packages/custom'), join(repo, 'extensions/custom'))
  pkg('extensions/extra', 'extra', { peerDependencies: { '@deepseek-ai/dsh-custom': '^0.1.0' } })
  pkg('packages/client/theme', 'theme', { exports: { default: './default.js', node: './node.js' } })
  write('packages/client/theme/src/config.ts', 'schema 2')
  write('packages/client/theme/cordis.patch.yml', 'rows: []')
  write('apps/cli/src/loader.ts', 'loader changed')
  write('pnpm-lock.yaml', 'dependencies changed')
  const candidate = commit('candidate')
  write('packages/client/theme/package.json', 'invalid dirty file')
  const report = auditHarnessUpstream(repo, baseline, candidate)
  assert.deepEqual(report.changes.map(({ name, status }) => [name, status]), [
    ['@deepseek-ai/dsh-custom', 'moved'],
    ['@deepseek-ai/dsh-extra', 'added'],
    ['@deepseek-ai/dsh-old', 'removed'],
    ['@deepseek-ai/dsh-theme', 'modified'],
  ])
  const theme = report.changes.at(-1)
  assert.deepEqual(theme.changedContractFields, ['exports'])
  assert.ok(theme.changedPaths.includes('packages/client/theme/src/config.ts'))
  assert.deepEqual(report.risks, ['build-and-runtime', 'npm-dependencies', 'plugin-loading', 'webui', 'workspace-packages'])
  assert.throws(() => auditHarnessUpstream(repo, { ...baseline, version: 'wrong' }, candidate), /Pinned version/)
  assert.throws(() => auditHarnessUpstream(repo, baseline, 'HEAD'), /full lowercase/)
  assert.throws(() => auditHarnessUpstream(repo, baseline, git('rev-parse', 'HEAD^{tree}')), /Not a commit/)

  pkg('extensions/duplicate', 'theme')
  pkg('packages/client/theme', 'theme')
  assert.throws(() => auditHarnessUpstream(repo, baseline, commit('duplicate')), /Duplicate Harness package/)
})
