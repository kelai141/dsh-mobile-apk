#!/usr/bin/env node
// lock-rewrite-guard.test.mjs — 依赖解析「就地重写 lock」判据（issue #1615）。
//
// 【为什么必须存在】
// CI 的 `install-project-dependencies.mjs` 先跑 `npm install --package-lock-only`，它会**直接改写**
// 仓内的 package-lock.json；随后只查 root 面，而 inputLockSha256 / resolvedLockSha256 只记不判。
// 于是「提交的 lock 缺 resolved/integrity 字段」时，npm 会静默从 registry 补齐并安装 ——
// 报告里留下两个不同的哈希，链却全绿，装出来的图已经不是提交的那一份。
//
// 【判据分层】
//   ① 纯函数层：相等放行；不等判红且文案指向「必须先在 PR 里更新」；摘要缺席判红（fail-closed）。
//   ② 差异面层：lockDiffSummary 必须能点名「新增/删除/变更」三类位移（差异不能只活在一个哈希里）。
//   ③ 真实安装器层：把**未改动的**仓内包复制到临时目录跑一遍安装器 —— 今天的锁必须是干净的
//      （否则本判据在 CI 上恒红），并钉住「干净输入不判红」这一侧。
//      「脏锁 → 判红」那一侧由 ① 直接钉住（跑真实 npm 制造一次受控重写要联网 + 数十秒，
//      且判据本身是纯函数，没有第二个失败面）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockDiffSummary, lockRewriteProblem } from './check-package-lock-roots.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALLER = path.join(ROOT, 'scripts', 'source-build', 'install-project-dependencies.mjs')

// ── ① 纯函数层 ─────────────────────────────────────────────────────────
test('锁文件重写判据：前后一致放行', () => {
  assert.equal(lockRewriteProblem({ inputLockSha256: 'a'.repeat(64), resolvedLockSha256: 'a'.repeat(64) }), null)
})

test('锁文件重写判据：被就地重写即判红，且文案要求先在 PR 里更新', () => {
  const problem = lockRewriteProblem({ inputLockSha256: 'a'.repeat(64), resolvedLockSha256: 'b'.repeat(64) })
  assert.ok(problem !== null, '重写必须判红')
  assert.match(problem, /就地重写了 package-lock.json/)
  assert.match(problem, /必须先在 PR 里更新/)
  assert.match(problem, /#1615/)
})

test('锁文件重写判据：摘要缺席 fail-closed（不得当成「没变」放行）', () => {
  assert.match(String(lockRewriteProblem({})), /摘要缺席/)
  assert.match(String(lockRewriteProblem({ inputLockSha256: '', resolvedLockSha256: '' })), /摘要缺席/)
  assert.match(String(lockRewriteProblem()), /摘要缺席/)
})

// ── ② 差异面层 ─────────────────────────────────────────────────────────
test('lockDiffSummary 点名新增/删除/变更三类位移', () => {
  const before = { packages: { '': { name: 'x' }, 'node_modules/a': { version: '1' }, 'node_modules/b': { version: '1' } } }
  const after = { packages: { '': { name: 'x' }, 'node_modules/b': { version: '2' }, 'node_modules/c': { version: '1' } } }
  const diff = lockDiffSummary(before, after)
  assert.deepEqual(diff.added, ['node_modules/c'])
  assert.deepEqual(diff.removed, ['node_modules/a'])
  assert.deepEqual(diff.changed, ['node_modules/b'])
  assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 1 })
})

// ── ③ 真实安装器层（顺序可断言：判红必须发生在 npm ci 之前）──────────────
/**
 * 假 npm（只给测试用，经安装器的 DSH_NPM_TEST_STUB 缝注入）：按第一个子命令决定行为，
 * 并把每次调用追加到 calls.log。测试据此断言**顺序**，而不是去读安装器的源码位置。
 *
 * 形态对应 issue #1615 的两种输入：
 *   - clean  ：--package-lock-only 不动 lock（今天的仓内状态），必须继续装；
 *   - rewrite：--package-lock-only 往 lock 里补一条 resolved（镜像补齐/劫持的形态），
 *     必须在 ci **之前**中止 —— 判据若只「记」不「判」，ci 会被调用。
 */
const writeStub = (file, mode) => {
  fs.writeFileSync(file, [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    'const mode = ' + JSON.stringify(mode),
    'const args = process.argv.slice(2)',
    "fs.appendFileSync(path.join(process.cwd(), 'calls.log'), args[0] + '\\n')",
    "if (mode === 'rewrite' && args[0] === 'install') {",
    "  const p = path.join(process.cwd(), 'package-lock.json')",
    "  const lock = JSON.parse(fs.readFileSync(p, 'utf8'))",
    "  lock.packages['node_modules/zzz-selftest'] = { version: '1.0.0', resolved: 'https://registry.invalid/zzz.tgz', integrity: 'sha512-zzz' }",
    "  fs.writeFileSync(p, JSON.stringify(lock, null, 2) + '\\n')",
    '}',
    '',
  ].join('\n'))
}

/** 造一个最小可解析的包目录（lock 的 root 面与 package.json 一致）。 */
const makeFixture = (t, tag) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lock-' + tag + '-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { alpha: '1.0.0' } }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies: { alpha: '1.0.0' } }, 'node_modules/alpha': { version: '1.0.0' } },
  }, null, 2) + '\n')
  return dir
}

test('真实安装器：锁文件被就地重写时必须在 npm ci 之前中止（issue #1615）', (t) => {
  const dir = makeFixture(t, 'rewrite')
  const stub = path.join(dir, 'stub.mjs')
  writeStub(stub, 'rewrite')
  const report = path.join(dir, 'report.json')
  const run = spawnSync(process.execPath, [INSTALLER, dir, report], {
    cwd: dir, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, DSH_NPM_TEST_STUB: stub },
  })
  const output = (run.stdout ?? '') + (run.stderr ?? '')
  assert.notEqual(run.status, 0, '锁被重写时必须判红：' + output.slice(-800))
  assert.match(output, /就地重写了 package-lock\.json/, '判红理由必须点名「就地重写」：' + output.slice(-800))
  const calls = fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split(/\r?\n/).filter(Boolean) : []
  assert.deepEqual(calls, ['install'], 'npm ci 不得在被重写的 lock 上执行（判据必须在装之前）：实得 ' + JSON.stringify(calls))
  assert.equal(fs.existsSync(report), false, '判红时不得写「解析成功」报告')
})

test('真实安装器：干净锁文件必须继续安装且前后摘要一致（判据不得恒红）', (t) => {
  const dir = makeFixture(t, 'clean')
  const stub = path.join(dir, 'stub.mjs')
  writeStub(stub, 'clean')
  const report = path.join(dir, 'report.json')
  const run = spawnSync(process.execPath, [INSTALLER, dir, report], {
    cwd: dir, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, DSH_NPM_TEST_STUB: stub },
  })
  const output = (run.stdout ?? '') + (run.stderr ?? '')
  assert.equal(run.status, 0, '干净锁文件必须安装成功：' + output.slice(-800))
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split(/\r?\n/).filter(Boolean)
  assert.deepEqual(calls, ['install', 'ci'], '干净输入必须走完 install → ci 两步')
  const entry = Object.values(JSON.parse(fs.readFileSync(report, 'utf8')).packages)[0]
  assert.equal(entry.inputLockSha256, entry.resolvedLockSha256, '干净输入下前后摘要必须一致')
})

test('反证：去掉「就地重写」判据后，被重写的 lock 会被照单 npm ci（该判据承重）', (t) => {
  const dir = makeFixture(t, 'noguard')
  const stub = path.join(dir, 'stub.mjs')
  writeStub(stub, 'rewrite')
  /* 反证通过把判定调用点换成「永远放行」实现：与「旧实现只记不判」等价。
   *
   * **按结构定位，不按整句话定位**（坑 384/385）：这里曾经锚死 `const rewriteProblem =
   * lockRewriteProblem({ inputLockSha256, resolvedLockSha256 })` 这一整行；并集把调用点改成多行、
   * 变量名换成 `lockRewrite`、参数换成 `inputSha256/resolvedSha256` 之后，`String.replace` 静默不注入，
   * 反证前提落空却仍然「跑完了」。
   *
   * 现在：用 `<name> = lockRewriteProblem(` 定位调用点，**同时配平 () 与 {}** 找到闭合，整块替换为
   * `<name> = null`。任何一步定不到就立即抛（fail-fast），绝不静默降级成「没注入也算过」。
   */
  const patched = path.join(dir, 'installer-noguard.mjs')
  // 反证文件写在临时目录，相对 import 会按临时目录解析（ERR_MODULE_NOT_FOUND）——换成绝对 file:// URL。
  const rootsUrl = new URL('./check-package-lock-roots.mjs', new URL('file:///' + INSTALLER.replace(/\\/g, '/'))).href
  const original = fs.readFileSync(INSTALLER, 'utf8')
  // ① import 去掉 lockRewriteProblem。
  const withoutImport = original.replace(
    /import \{([^}]*)\} from '\.\/check-package-lock-roots\.mjs'/,
    (m, names) => 'import {' + names.split(',').map((s) => s.trim()).filter((s) => s && s !== 'lockRewriteProblem').join(', ')
      + '} from ' + JSON.stringify(rootsUrl),
  )
  assert.notEqual(withoutImport, original, '反证前提不成立：找不到 check-package-lock-roots 的 import')
  // ② 同步删掉 re-export，否则模块 SyntaxError: Export not defined（反证变成「把模块改崩」）。
  const withoutReexport = withoutImport.replace(/export\s*\{\s*lockRewriteProblem\s*\}\s*\n?/, '')
  assert.notEqual(withoutReexport, withoutImport, '反证前提不成立：找不到 `export { lockRewriteProblem }`')
  // ③ 定位调用点并按括号/花括号配平找到闭合。
  const callRe = /(const\s+)([A-Za-z_$][\w$]*)(\s*=\s*)lockRewriteProblem\s*\(/
  const m = callRe.exec(withoutReexport)
  assert.ok(m !== null, '反证前提不成立：安装器里找不到 `lockRewriteProblem(` 调用点（实现可能又变了，需同步本夹具）')
  const name = m[2]
  let depth = 0
  let braceDepth = 0
  let i = m.index + m[0].length - 1
  let end = -1
  for (; i < withoutReexport.length; i += 1) {
    const ch = withoutReexport[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0 && braceDepth === 0) { end = i + 1; break }
    } else if (ch === '{') braceDepth += 1
    else if (ch === '}') braceDepth -= 1
  }
  assert.ok(end > 0, '反证前提不成立：`lockRewriteProblem(` 的括号没有闭合')
  const source = withoutReexport.slice(0, m.index) + 'const ' + name + ' = null' + withoutReexport.slice(end)
  assert.match(source, new RegExp('const\\s+' + name + '\\s*=\\s*null'), '反证注入失败：替换后仍找不到 `const ' + name + ' = null`')
  assert.doesNotMatch(source, /lockRewriteProblem\s*\(/, '反证注入失败：替换后仍残留 lockRewriteProblem( 调用')
  fs.writeFileSync(patched, source)
  const report = path.join(dir, 'report.json')
  const run = spawnSync(process.execPath, [patched, dir, report], {
    cwd: dir, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, DSH_NPM_TEST_STUB: stub },
  })
  const output = (run.stdout ?? '') + (run.stderr ?? '')
  assert.equal(run.status, 0, '去掉判据后必须放行（否则本判据不承重）：' + output.slice(-800))
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split(/\r?\n/).filter(Boolean)
  assert.deepEqual(calls, ['install', 'ci'], '去掉判据后 npm ci 会照单执行（旧缺陷形态）：实得 ' + JSON.stringify(calls))
})
