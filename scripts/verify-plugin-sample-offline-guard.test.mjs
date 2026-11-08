// verify-plugin-sample-offline-guard.test.mjs — 证明离线路径不碰 ADB。
//
// 做法：把 PATH 指向一个只含 stub 的空目录（execPath 保持不变），离线模式仍应正常工作。
// 如果脚本在离线路径里调用了 adb / 任何外部命令，这里会因为没有可执行文件而失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SCRIPT = join(HERE, 'verify-plugin-sample-device.mjs')

const runWithEmptyPath = (args) => {
  const emptyBin = mkdtempSync(join(tmpdir(), 'empty-bin-'))
  try {
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyBin, Path: emptyBin, ADB_SERVER_SOCKET: '' },
    })
  } finally {
    rmSync(emptyBin, { recursive: true, force: true })
  }
}

test('self-test 在没有 adb 的 PATH 下也能跑完', () => {
  const r = runWithEmptyPath(['--self-test'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PLUGIN-SAMPLE-DEVICE SELF-TEST PASS/)
})

test('夹具模式在没有 adb 的 PATH 下也能判定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fixture-'))
  try {
    writeFileSync(join(dir, 'list-plugins.json'), JSON.stringify({ result: { value: [{ entryId: 'dsh-task-ledger', moduleName: 'dsh-task-ledger', enabled: true, fiberPhase: 'active' }] } }))
    writeFileSync(join(dir, 'identity-response.json'), JSON.stringify({ status: 200, body: JSON.stringify({ uuid: null, name: null, initCommand: 'x' }), error: null }))
    const r = runWithEmptyPath(['--from-fixture', dir, '--out', join(dir, 'out')])
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /PLUGIN-SAMPLE PASS/)
    const verdict = readFileSync(join(dir, 'out', 'verdict.txt'), 'utf8')
    assert.match(verdict, /PLUGIN-SAMPLE PASS/)
    const evidence = JSON.parse(readFileSync(join(dir, 'out', 'evidence-case.json'), 'utf8'))
    assert.equal(evidence.status, 'pass')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('没有 --serial 时明确拒绝，而不是自己挑设备', () => {
  const r = runWithEmptyPath([])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--serial/)
})

