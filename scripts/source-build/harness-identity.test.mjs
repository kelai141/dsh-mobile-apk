import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readHarnessIdentity } from './harness-identity.mjs'

const BASE = {
  baseline: '9.9.9-rc.9',
  upstream: {
    commit: '0123456789abcdef0123456789abcdef01234567',
    rootVersion: '9.9.9-rc.9',
    packageManager: 'pnpm@9.9.9',
    enginesNode: '^22.19.0 || >=24.0.0',
  },
}

function fixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-identity-'))
  const { baseline, ...upstreamOverrides } = overrides
  const contract = {
    ...structuredClone(BASE),
    ...(baseline === undefined ? {} : { baseline }),
    upstream: { ...structuredClone(BASE).upstream, ...upstreamOverrides },
  }
  const file = join(root, 'contract.json')
  writeFileSync(file, JSON.stringify(contract, null, 2) + '\n')
  return { root, file }
}

test('returns the exact pinned identity', (t) => {
  const { root, file } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const identity = readHarnessIdentity(file)
  assert.equal(identity.commit, BASE.upstream.commit)
  assert.equal(identity.version, BASE.baseline)
  assert.equal(identity.packageManager, BASE.upstream.packageManager)
})

test('rejects an abbreviated commit and a missing toolchain pin', (t) => {
  for (const overrides of [
    { commit: '0123456' },
    { commit: '0123456789ABCDEF0123456789ABCDEF01234567' },
    { packageManager: 'pnpm' },
    { enginesNode: '' },
  ]) {
    const { root, file } = fixture(overrides)
    t.after(() => rmSync(root, { recursive: true, force: true }))
    assert.throws(() => readHarnessIdentity(file), /contract\./, JSON.stringify(overrides))
  }
})

test('rejects a floating version and a baseline/root version disagreement', (t) => {
  const floating = fixture({ baseline: '9.9.9' })
  t.after(() => rmSync(floating.root, { recursive: true, force: true }))
  assert.throws(() => readHarnessIdentity(floating.file), /exact -rc release version/)
  const mismatched = fixture({ rootVersion: '9.9.9-rc.8' })
  t.after(() => rmSync(mismatched.root, { recursive: true, force: true }))
  assert.throws(() => readHarnessIdentity(mismatched.file), /disagrees with upstream\.rootVersion/)
})
