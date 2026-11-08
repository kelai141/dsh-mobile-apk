import { spawnSync } from 'node:child_process'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'
import { readHarnessIdentity } from './harness-identity.mjs'

const sha = /^[0-9a-f]{40}$/
const contractFields = [
  'type', 'main', 'module', 'browser', 'bin', 'types', 'typings', 'typesVersions',
  'exports', 'imports', 'files', 'dependencies', 'devDependencies',
  'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies',
  'bundledDependencies', 'bundleDependencies', 'engines', 'os', 'cpu', 'cordis',
]

function git(repo, args, input) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    input, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`)
  return result.stdout
}

function listTree(repo, commit) {
  return new Map(git(repo, ['ls-tree', '-rz', '--full-tree', commit])
    .toString('utf8').split('\0').filter(Boolean).map(entry => {
      const tab = entry.indexOf('\t')
      const [mode, type, hash] = entry.slice(0, tab).split(' ')
      return [entry.slice(tab + 1), { mode, type, hash }]
    }))
}

// Batch reads keep the scan independent of checkout paths, filters and package code.
function readManifests(repo, entries) {
  const hashes = [...new Set(entries.map(([, { hash }]) => hash))]
  const data = git(repo, ['cat-file', '--batch'], hashes.join('\n') + '\n')
  const parsed = new Map()
  let cursor = 0
  for (const hash of hashes) {
    const newline = data.indexOf(10, cursor)
    const [actual, type, length] = data.toString('ascii', cursor, newline).split(' ')
    const bytes = Number(length)
    const end = newline + 1 + bytes
    if (newline < 0 || actual !== hash || type !== 'blob' || !Number.isSafeInteger(bytes) ||
        bytes < 0 || data[end] !== 10) throw new Error(`Invalid manifest blob: ${hash}`)
    parsed.set(hash, data.toString('utf8', newline + 1, end))
    cursor = end + 1
  }
  return entries.map(([path, { hash }]) => {
    try {
      const manifest = JSON.parse(parsed.get(hash))
      if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') throw new Error('expected object')
      return [path, manifest]
    } catch (error) {
      throw new Error(`${path}: ${error.message}`)
    }
  })
}

function inventory(repo, tree) {
  // Discover manifests from the tree, regardless of workspace layout.
  // Nested @deepseek-ai/dsh-* packages also count unless they are fixtures/tests.
  const entries = [...tree].filter(([path, entry]) =>
    entry.type === 'blob' && entry.mode !== '120000' && /(^|\/)package\.json$/.test(path) &&
    !/(^|\/)(node_modules|fixtures?|__fixtures__|tests?|__tests__)(\/|$)/.test(path))
  if (!entries.some(([path]) => path === 'package.json')) throw new Error('Missing root package.json')
  const manifests = readManifests(repo, entries)
  const packages = new Map()
  let root
  for (const [path, manifest] of manifests) {
    if (path === 'package.json') {
      root = manifest
      continue
    }
    if (typeof manifest.name !== 'string' || !/^@deepseek-ai\/dsh(?:-|$)/.test(manifest.name)) continue
    if (packages.has(manifest.name)) throw new Error(`Duplicate Harness package: ${manifest.name} (${path})`)
    packages.set(manifest.name, { path, manifest })
  }
  if (!packages.size) throw new Error('No Harness workspace packages discovered')
  return { root, packages }
}

const directory = path => path.slice(0, path.lastIndexOf('/') + 1)
const orderedUnion = (left, right) => [...new Set([...left, ...right])].sort()
const identity = root => ({
  version: root.version ?? null,
  packageManager: root.packageManager ?? null,
  enginesNode: root.engines?.node ?? null,
})

function riskAreas(paths, names) {
  const risks = new Set()
  for (const path of paths) {
    if (/(^|\/)(client|web|website|ui(?:-[^/]+)?|host-web|web-app)(\/|$)/.test(path)) risks.add('webui')
    if (/(^|\/)(cli|appboot|config|profiles?|bundles?|loader|plugin-runtime)(\/|$)|(?:^|\/)cordis\.patch\.ya?ml$/.test(path)) risks.add('plugin-loading')
    if (/(^|\/)(native|\.github)(\/|$)|^(?:scripts\/|patches\/|pnpm-|package\.json$|tsdown\.)/.test(path)) risks.add('build-and-runtime')
    if (/(^|\/)package\.json$|^pnpm-/.test(path)) risks.add('npm-dependencies')
  }
  if (names.length) risks.add('workspace-packages')
  return [...risks].sort()
}

export function auditHarnessUpstream(repo, baseline, candidate) {
  for (const commit of [baseline.commit, candidate]) {
    if (typeof commit !== 'string' || !sha.test(commit)) throw new Error('Expected a full lowercase Git commit SHA')
    if (git(repo, ['cat-file', '-t', commit]).toString().trim() !== 'commit') {
      throw new Error(`Not a commit: ${commit}`)
    }
  }
  const beforeTree = listTree(repo, baseline.commit)
  const afterTree = candidate === baseline.commit ? beforeTree : listTree(repo, candidate)
  const before = inventory(repo, beforeTree)
  const after = afterTree === beforeTree ? before : inventory(repo, afterTree)
  const beforeIdentity = identity(before.root)
  const afterIdentity = identity(after.root)
  for (const field of Object.keys(beforeIdentity)) {
    if (beforeIdentity[field] !== baseline[field]) throw new Error(`Pinned ${field} disagrees with upstream tree`)
  }
  const paths = orderedUnion(beforeTree.keys(), afterTree.keys())
    .filter(path => !isDeepStrictEqual(beforeTree.get(path), afterTree.get(path)))
  const owners = new Map()
  for (const { packages } of [before, after]) {
    for (const [name, item] of packages) {
      const dir = directory(item.path)
      if (!owners.has(dir)) owners.set(dir, new Set())
      owners.get(dir).add(name)
    }
  }
  const touched = new Map()
  for (const path of paths) {
    for (let dir = directory(path); dir; dir = directory(dir.slice(0, -1))) {
      if (!owners.has(dir)) continue
      for (const name of owners.get(dir)) {
        if (!touched.has(name)) touched.set(name, [])
        touched.get(name).push(path)
      }
      break
    }
  }
  const changes = []
  for (const name of orderedUnion(before.packages.keys(), after.packages.keys())) {
    const old = before.packages.get(name)
    const next = after.packages.get(name)
    const changedPaths = touched.get(name) ?? []
    if (!changedPaths.length && old?.path === next?.path) continue
    const changedContractFields = contractFields.filter(field => {
      const left = old?.manifest[field]
      const right = next?.manifest[field]
      // Node tries conditions and fallback arrays in order.
      return ['exports', 'imports'].includes(field)
        ? JSON.stringify(left) !== JSON.stringify(right)
        : !isDeepStrictEqual(left, right)
    })
    changes.push({
      name,
      status: !old ? 'added' : !next ? 'removed' : old.path !== next.path ? 'moved' : 'modified',
      before: old ? { path: old.path, version: old.manifest.version ?? null } : null,
      after: next ? { path: next.path, version: next.manifest.version ?? null } : null,
      changedContractFields,
      changedPaths,
    })
  }
  return {
    schemaVersion: 1,
    inspectedAt: new Date().toISOString(),
    baseline: { commit: baseline.commit, ...beforeIdentity, packages: before.packages.size },
    candidate: { commit: candidate, ...afterIdentity, packages: after.packages.size },
    // A clean diff (e.g. an empty upstream commit) still does not approve a new SHA.
    decision: candidate === baseline.commit ? 'already-pinned' : 'requires-validation',
    risks: riskAreas(paths, changes),
    changes,
    changedPaths: paths,
  }
}

function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' },
    candidate: { type: 'string' },
    'require-pinned': { type: 'boolean' },
  } })
  if (!values.repo || !values.candidate) {
    throw new Error('Usage: node audit-harness-upstream.mjs --repo <upstream git dir> --candidate <commit> [--require-pinned]')
  }
  const report = auditHarnessUpstream(values.repo, readHarnessIdentity(), values.candidate)
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  if (values['require-pinned'] && report.decision !== 'already-pinned') process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
