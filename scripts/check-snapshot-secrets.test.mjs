import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 这个门禁是「发行快照里不得含明文凭据」的唯一防线，此前没有自测。
// 2026-10-28 自查发现它的 settings.yaml 内容级判据只认 sk-/apiKey/私钥头/引擎 token，
// 漏了 `token:` `password:` `secret:` 这类「键名+分隔符」形态（而 seed 的 settings.yaml
// 正是 YAML 键值文件，LogSanitizer.SENSITIVE_KV 那边早就覆盖了同族键名）。
// 下面用**真实 tar 跑真门禁**（不是单测内部函数），因为它的判据分散在路径级与内容级两处。
const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = join(HERE, 'check-snapshot-secrets.mjs')

// 最小发行快照骨架：两条前置断言（usr/ 前缀 + 引擎包）必须满足，否则门禁按"不是发行快照"硬失败。
const SKELETON = {
  'usr/bin/node': 'x',
  'usr/lib/node_modules/@deepseek-ai/dsh/package.json': '{}',
}

function makeSnapshot(files) {
  const root = mkdtempSync(join(tmpdir(), 'snapsec-'))
  const stage = join(root, 'stage')
  const all = { ...SKELETON, ...files }
  for (const [rel, content] of Object.entries(all)) {
    const p = join(stage, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  const tar = join(root, 'snap.tar.xz')
  // 显式列目录（不要 `-C stage .`）：那会产出 `./usr/...` 成员名，`startsWith('usr/')` 就不成立。
  const tops = [...new Set(Object.keys(all).map((k) => k.split('/')[0]))]
  execFileSync('tar', ['-cJf', tar, '-C', stage, ...tops])
  return { tar, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function runGate(tar, extra = []) {
  try {
    execFileSync(process.execPath, [GATE, tar, ...extra], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out: 'PASSED' }
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout ?? '') + String(error.stderr ?? '') }
  }
}

function withSnapshot(files, fn) {
  const s = makeSnapshot(files)
  try { return fn(s.tar) } finally { s.cleanup() }
}

test('干净的 settings.yaml 必须通过（新判据不得把占位模板判红）', () => {
  const r = withSnapshot({
    'home/.dsh/settings.yaml': 'model: default\nport: 3080\ntokenTimeout: 30\napiKey: ""\ntoken: ""\n',
  }, (tar) => runGate(tar))
  assert.equal(r.code, 0, '干净模板被误判：' + r.out)
})

test('settings.yaml 里的 token: 值必须判红（旧判据的漏网形态）', () => {
  const r = withSnapshot({ 'home/.dsh/settings.yaml': 'a: 1\ntoken: abc12345\n' }, (tar) => runGate(tar))
  assert.equal(r.code, 1, 'token: 值没被检出：' + r.out)
  assert.match(r.out, /settings-yaml-secret/)
})

test('password / secret / credential 同族键名也要判红', () => {
  for (const line of ['password: hunter2', 'secret: topsecret', 'credentials: abcdef']) {
    const r = withSnapshot({ 'home/.dsh/settings.yaml': line + '\n' }, (tar) => runGate(tar))
    assert.equal(r.code, 1, line + ' 没被检出：' + r.out)
  }
})

test('敏感路径命中（.credentials / sessions / .npmrc）判红', () => {
  for (const p of ['home/.dsh/.credentials', 'home/.dsh/sessions/x.json', 'home/.npmrc']) {
    const r = withSnapshot({ [p]: 'x' }, (tar) => runGate(tar))
    assert.equal(r.code, 1, p + ' 没被检出：' + r.out)
  }
})

test('不是发行快照时必须硬失败，不接受空集假绿', () => {
  // 缺 usr/ 前缀 ⇒ 旧实现会在空成员列表上全部 PASS（review C3 的假绿形态）
  const root = mkdtempSync(join(tmpdir(), 'snapsec-bad-'))
  const stage = join(root, 'stage')
  mkdirSync(join(stage, 'home'), { recursive: true })
  writeFileSync(join(stage, 'home/readme.txt'), 'x')
  const tar = join(root, 'bad.tar.xz')
  execFileSync('tar', ['-cJf', tar, '-C', stage, 'home'])
  try {
    const r = runGate(tar)
    assert.equal(r.code, 1, '缺 usr/ 却通过 = 假绿：' + r.out)
    assert.match(r.out, /usr\//)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
