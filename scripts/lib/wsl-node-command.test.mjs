import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { wslNodeCommand } from './shell.mjs'

test('WSL 重入把隔离目录传给 node，且环境变量不能执行 shell 语法', () => {
  const value = "/tmp/dsh stage's $(printf injected)"
  const command = wslNodeCommand('/tmp', '-e', [
    'process.stdout.write(JSON.stringify({stage:process.env.DSH_SNAPSHOT_STAGE,cwd:process.cwd()}))',
  ], { DSH_SNAPSHOT_STAGE: value })
  const executable = process.platform === 'win32' ? 'wsl.exe' : 'bash'
  const args = process.platform === 'win32' ? ['-e', 'bash', '-lc', command] : ['-lc', command]
  const result = spawnSync(executable, args, { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  // 登录 shell 可能先输出用户的启动信息，解析最后一行。
  const json = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(json.stage, value)
  assert.equal(json.cwd, '/tmp')
  assert.throws(() => wslNodeCommand('/tmp', '-e', [], { 'BAD;name': 'x' }))
})
