#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMPONENTS = ['dsh-shell-termux', 'dsh-client-ui-responsive', 'dsh-host-web-compat']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 })

function verifyCommit(root, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || git(root, 'rev-parse', 'HEAD').toString().trim() !== commit) throw new Error('project component provenance requires the checked-out GITHUB_SHA')
}

export function captureProjectInputs(root, commit) {
  verifyCommit(root, commit)
  const report = { schema: 1, sourceRepository: 'https://github.com/kelai141/dsh-mobile-apk', projectCommit: commit, components: {} }
  for (const directory of COMPONENTS) {
    const files = git(root, 'ls-tree', '-r', '--name-only', '-z', commit, '--', directory).toString().split('\0').filter(Boolean).sort()
    if (!files.includes(`${directory}/package.json`)) throw new Error(`project component missing from commit: ${directory}`)
    const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', directory).toString().split('\0').filter(Boolean)
    if (untracked.length) throw new Error(`untracked component inputs: ${untracked.join(', ')}`)
    const inputFiles = {}
    for (const path of files) {
      const committed = git(root, 'show', `${commit}:${path}`)
      const actual = readFileSync(join(root, path))
      if (!actual.equals(committed)) throw new Error(`component input differs from project commit: ${path}`)
      inputFiles[path.slice(directory.length + 1)] = sha256(committed)
    }
    const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8'))
    if (manifest.name !== `@dsh-android/${directory}`) throw new Error(`component package identity changed: ${directory}`)
    report.components[directory] = {
      source: 'checked-in project component', sourceCommit: commit, directory,
      packageName: manifest.name, packageVersion: manifest.version, inputFiles,
    }
  }
  const cordisKey = '@deepseek-ai/cordis'
  const overlay = JSON.parse(readFileSync(join(root, 'scripts/snapshot-config/engine-overlay.json'), 'utf8'))
  const host = JSON.parse(readFileSync(join(root, 'dsh-host-web-compat/package.json'), 'utf8'))
  if (!overlay.packages?.[cordisKey] || host.dependencies?.[cordisKey] !== overlay.packages[cordisKey]) throw new Error('host-web-compat Cordis dependency differs from engine overlay')
  return report
}

function libraryFiles(root, prefix = 'lib') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = `${prefix}/${entry.name}`
    if (entry.isDirectory()) return libraryFiles(root, path)
    if (!entry.isFile()) throw new Error(`component output is not a regular file: ${path}`)
    return path.endsWith('.map') ? [] : [path]
  })
}

export function captureProjectOutputs(root, commit, inputs) {
  verifyCommit(root, commit)
  if (inputs.schema !== 1 || inputs.projectCommit !== commit) throw new Error('project component input provenance belongs to a different commit')
  const report = structuredClone(inputs)
  for (const directory of COMPONENTS) {
    const component = report.components[directory]
    if (component?.sourceCommit !== commit || component.directory !== directory) throw new Error(`invalid component input provenance: ${directory}`)
    const outputFiles = {}
    const componentRoot = join(root, directory)
    for (const path of ['package.json', ...libraryFiles(componentRoot)]) outputFiles[path] = sha256(readFileSync(join(componentRoot, path)))
    if (!outputFiles['lib/index.js']) throw new Error(`component build did not produce lib/index.js: ${directory}`)
    if (outputFiles['package.json'] !== component.inputFiles['package.json']) throw new Error(`component manifest changed during build: ${directory}`)
    // This component ships checked-in JS; the source chain must never silently replace it.
    if (directory === 'dsh-host-web-compat' && outputFiles['lib/index.js'] !== component.inputFiles['lib/index.js']) throw new Error('host-web-compat output differs from its committed JavaScript source')
    for (const [path, hash] of Object.entries(component.inputFiles)) {
      // Dependency preparation intentionally realizes stale lock graphs; its report records that delta.
      if (path === 'package-lock.json') {
        component.resolvedLockSha256 = sha256(readFileSync(join(componentRoot, path)))
      } else if (sha256(readFileSync(join(componentRoot, path))) !== hash) {
        throw new Error(`component source changed during build: ${directory}/${path}`)
      }
    }
    component.outputFiles = outputFiles
  }
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, output] = process.argv.slice(2)
  if (!['inputs', 'outputs'].includes(mode) || !output || process.argv.length !== 4) throw new Error('usage: record-project-components.mjs <inputs|outputs> <report.json>')
  const root = process.cwd()
  const commit = process.env.GITHUB_SHA
  const report = mode === 'inputs' ? captureProjectInputs(root, commit) : captureProjectOutputs(root, commit, JSON.parse(readFileSync(output, 'utf8')))
  mkdirSync(dirname(resolve(output)), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(`project component ${mode} verified: ${commit}`)
}
