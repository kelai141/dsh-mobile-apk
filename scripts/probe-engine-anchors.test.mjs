import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url), 'utf8'))

test('source capture follows the contract package manager and rejects stale identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'rc3-anchor-identity-'))
  try {
    const scripts = join(root, 'scripts')
    mkdirSync(join(scripts, 'snapshot-config'), { recursive: true })
    copyFileSync(new URL('./probe-engine-anchors.mjs', import.meta.url), join(scripts, 'probe-engine-anchors.mjs'))
    writeFileSync(join(scripts, 'contract.json'), JSON.stringify(contract))
    writeFileSync(join(scripts, 'snapshot-config', 'engine-overlay.json'), JSON.stringify({
      engineVersion: contract.baseline, rootPackage: { version: contract.baseline },
    }))
    const manifest = {
      commit: contract.upstream.commit,
      packageManager: contract.upstream.packageManager,
      lockfileSha256: 'a'.repeat(64),
    }
    const input = join(root, 'source.json')
    const run = (data) => {
      writeFileSync(input, JSON.stringify(data))
      return spawnSync(process.execPath, [join(scripts, 'probe-engine-anchors.mjs'), '--source-manifest', input, '--clean'], { encoding: 'utf8' })
    }
    assert.equal(run(manifest).status, 0)
    for (const delta of [
      { packageManager: 'pnpm@0.0.1' },
      { commit: '0'.repeat(40) },
      { lockfileSha256: 'not-a-lock-hash' },
    ]) {
      const result = run({ ...manifest, ...delta })
      assert.equal(result.status, 2)
      assert.match(result.stderr, /source-build manifest/)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
