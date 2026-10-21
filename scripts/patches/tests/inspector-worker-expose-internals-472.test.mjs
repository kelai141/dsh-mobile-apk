/** issue #472：inspector Worker 的 execArgv 锚点、幂等、三向拒绝与 runner 集成。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { versionedFixture } from './lib/fixture.mjs'
import {
  INSPECTOR_WORKER_MARKER,
  hasInspectorWorkerExposeInternals,
  patchInspectorWorkerExposeInternals,
} from '../data/inspector-worker-expose-internals-472.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(versionedFixture('dsh-experimental-inspector', 'lib', 'index.js'), 'utf8')
const patched = patchInspectorWorkerExposeInternals(source)

const OPTIONS_ANCHOR = '\tconst options = {\n'
  + '\t\tworkerData: boot,\n'
  + '\t\ttransferList: [boot.hostSourcePort],\n'
  + '\t\texecArgv: []\n'
  + '\t};'

test('472 在真实产物上恰好命中一次、幂等、可解析，marker 恰好出现一次', () => {
  assert.equal(source.split(OPTIONS_ANCHOR).length - 1, 1, 'spawnWorker options 锚点必须恰好一处')
  assert.ok(hasInspectorWorkerExposeInternals(patched))
  assert.equal(patchInspectorWorkerExposeInternals(patched), patched, '重复施加必须零变化')
  assert.ok(patched.includes('execArgv: ["--expose-internals"]'))
  // marker 必须真的落字节：check-engine-overlay 靠它抽验「补丁未施加 / 版本漂移」。
  assert.equal(patched.split(INSPECTOR_WORKER_MARKER).length - 1, 1)
  // 产物是 ESM（import 语句），按 .mjs 交给 node 解析；vm.Script 只接受脚本，会误报。
  const dir = mkdtempSync(join(tmpdir(), 'inspector-472-parse-'))
  const probe = join(dir, 'index.mjs')
  try {
    writeFileSync(probe, patched)
    const check = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' })
    assert.equal(check.status, 0, check.stderr || check.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('锚点漂移、重复、半打三向拒绝', () => {
  assert.throws(
    () => patchInspectorWorkerExposeInternals(source.replace(OPTIONS_ANCHOR, '\tconst options = {};')),
    /期望恰好命中 1 处，实际 0/,
  )
  assert.throws(
    () => patchInspectorWorkerExposeInternals(source + OPTIONS_ANCHOR),
    /期望恰好命中 1 处，实际 2/,
  )
  // 半打：marker 在但锚点未换 —— 拒绝在可疑产物上继续。
  assert.throws(
    () => patchInspectorWorkerExposeInternals(source.replace('function spawnWorker(boot) {',
      '/* ' + INSPECTOR_WORKER_MARKER + ' */\nfunction spawnWorker(boot) {')),
    /marker 但锚点不完整/,
  )
})

test('runner 集成：--check 前判红、--apply 成功、--check 后为绿、再次 --apply 逐字节幂等', () => {
  const stage = mkdtempSync(join(tmpdir(), 'inspector-472-stage-'))
  const target = 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-inspector/lib/index.js'
  const file = join(stage, target)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
    const runner = mode => spawnSync(process.execPath, [
      join(HERE, '..', 'apply-patches.mjs'), stage, mode, '--only', 'inspector-worker-expose-internals-472', '--scope', 'engine',
    ], { encoding: 'utf8', cwd: join(HERE, '..', '..', '..') })

    assert.equal(runner('--check').status, 1, '未施加时 --check 必须判红')
    const applied = runner('--apply')
    assert.equal(applied.status, 0, (applied.stderr || '') + (applied.stdout || ''))
    const onDisk = readFileSync(file, 'utf8')
    assert.ok(hasInspectorWorkerExposeInternals(onDisk))
    assert.equal(runner('--check').status, 0, '已施加后 --check 必须为绿')
    assert.equal(runner('--apply').status, 0)
    assert.equal(readFileSync(file, 'utf8'), onDisk, '重复施加必须逐字节零变化')
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
})
