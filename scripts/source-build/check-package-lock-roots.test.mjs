import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkPackageLockRoot } from './check-package-lock-roots.mjs'

test('accepts matching root dependencies regardless of key order', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-root-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', dependencies: { a: '1', b: '2' },
  }))
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { b: '2', a: '1' } } },
  }))
  assert.deepEqual(checkPackageLockRoot(directory), [])
})

test('rejects a stale dependency pin in the lock root', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-root-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', dependencies: { cordis: '4.0.4' },
  }))
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { cordis: '4.0.1' } } },
  }))
  assert.match(checkPackageLockRoot(directory).join('\n'), /dependencies.*不一致/)
})

test('accepts entries outside the package dir when they are file: dependencies', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-root-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', dependencies: { peer: 'file:../peer' },
  }))
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    packages: {
      '': { name: 'fixture', version: '1.0.0', dependencies: { peer: 'file:../peer' } },
      '../peer': { name: 'peer', version: '0.1.0', license: 'MIT' },
    },
  }))
  assert.deepEqual(checkPackageLockRoot(directory), [])
})

test('rejects a lock whose entries live outside the package dir (generated via a symlink layout)', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-root-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', devDependencies: { cordis: '4.1.0' },
  }))
  // 实测形态：npm 在协调仓根跑，apk/<pkg> 是符号链接，于是每个键都带上相对协调仓根的路径。
  fs.writeFileSync(path.join(directory, 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    version: 'file:../../apk/fixture',
    packages: {
      '': { name: 'fixture', version: '1.0.0', devDependencies: { cordis: '4.1.0' } },
      '../../apk/fixture/node_modules/cordis': { name: 'cordis', version: '4.1.0' },
    },
  }))
  const errors = checkPackageLockRoot(directory).join('\n')
  assert.match(errors, /顶层 version .* 不一致/)
  assert.match(errors, /1 条锁条目越出包目录/)
  // 负控的另一半：报错必须点名修法，否则维护者只会看到「不一致」而不知道去哪个目录重跑。
  assert.match(errors, /npm install --package-lock-only --ignore-scripts/)
})
