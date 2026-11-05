import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The workflow contract is the single pinned identity. Source-audit scripts must
// not carry private copies of the commit or version: that is how the 0.2.0-rc.2
// binding survived an upstream bump while every guard still looked pinned.
const CONTRACT_PATH = resolve(import.meta.dirname, '..', 'contract.json')
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+-rc\.\d+$/
const PACKAGE_MANAGER_PATTERN = /^pnpm@\d+\.\d+\.\d+$/

export function readHarnessIdentity(contractPath = CONTRACT_PATH) {
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'))
  const upstream = contract?.upstream
  const commit = upstream?.commit
  const version = contract?.baseline
  const packageManager = upstream?.packageManager
  const enginesNode = upstream?.enginesNode
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    throw new Error('contract.upstream.commit must be a full lowercase Git commit')
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error('contract.baseline must be an exact -rc release version')
  }
  if (upstream.rootVersion !== version) {
    throw new Error(`contract baseline ${version} disagrees with upstream.rootVersion ${upstream.rootVersion}`)
  }
  if (typeof packageManager !== 'string' || !PACKAGE_MANAGER_PATTERN.test(packageManager)) {
    throw new Error('contract.upstream.packageManager must be an exact pnpm version')
  }
  if (typeof enginesNode !== 'string' || !enginesNode.trim()) {
    throw new Error('contract.upstream.enginesNode must be declared')
  }
  return { contract, commit, version, packageManager, enginesNode }
}
