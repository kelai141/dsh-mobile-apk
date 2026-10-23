#!/usr/bin/env node
// check-plugin-tests.mjs — 每个插件自带的 test/*.test.mjs 必须真实跑通（0.14.0 新增）。
//
// 为什么需要这个门禁：虚拟屏插件的 android_vdisplay_create/destroy 曾经**完全不可用**
// （服务方法被摘出服务对象裸调，this 丢失 → controlQueue undefined），而该插件**一个测试都没有**，
// 于是没有任何门禁发现它。这个缺口不是「某个测试漏了」，而是「没有任何机制要求插件有测试」。
//
// 判据（逐插件）：
//   1) 有 test/*.test.mjs → 必须通过，且有效通过数 > 0（全 skip = 假绿，exit 0 不算数）；
//   2) 没有 test 目录 → WARN 不拦（避免把「历史欠账」当阻塞项），但在输出里点名，让缺口可见。
//
// 真实执行插件自己的 test/*.test.mjs，不做静态提取。
import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const PLUGIN_DIR = join(ROOT, 'plugins')
/** A test runner must not hold CI forever; a hard timeout keeps the failing unit visible. */
const TEST_TIMEOUT_MS = 5 * 60 * 1000

/** Convert a Windows drive path for the WSL npm installation when it exists. */
function toWslPath(path) {
  const full = resolve(path)
  const match = /^([a-z]):[\\/](.*)$/i.exec(full)
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}` : null
}

/**
 * 去掉 ANSI 颜色转义。为什么必须去（本轮实测）：vitest 的输出是
 * `[2m Tests [22m [1m[32m262 passed[39m[22m`，按裸文本匹配 `Tests\s+(\d+) passed` 永远不中，
 * 于是「测试全绿」被判成「未产生有效通过数（全 skip = 假绿）」——**假红**。
 * 这条路径此前没被走过（7 个插件都用 node:test），接上子仓后才暴露。
 * @param text - 子进程输出（stdout + stderr）。
 * @returns 去掉 ESC[...m 序列的文本。
 */
function stripAnsi(text) {
  return text.replace(/\[[0-9;]*[A-Za-z]/g, '')
}

const plugins = existsSync(PLUGIN_DIR)
  ? readdirSync(PLUGIN_DIR).filter((n) => existsSync(join(PLUGIN_DIR, n, 'package.json')))
  : []
if (plugins.length === 0) { console.error('CHECK-PLUGIN-TESTS FAILED：找不到任何插件'); process.exit(1) }

let ran = 0
let failed = 0
const noTests = []

for (const plugin of plugins.sort()) {
  const testDir = join(PLUGIN_DIR, plugin, 'test')
  if (!existsSync(testDir)) { noTests.push(plugin); continue }
  const files = readdirSync(testDir).filter((f) => f.endsWith('.test.mjs') || f.endsWith('.test.ts')).map((f) => join(testDir, f))
  if (files.length === 0) { noTests.push(plugin); continue }
  ran += 1
  // 运行器按文件内容自动判定：本仓 6 个插件用 node:test，client/UI 侧用 vitest。
  // 写死任一个都会把另一种判成失败（首次跑本门禁即实测到该误报）。
  const { readFileSync } = await import('node:fs')
  // 扫**全文件**而非固定行窗口：注释头长度不定，只看前 N 行会把 import 挡在窗口外
  // （首次跑本门禁实测到：vdisplay 的 16 行注释把 node:test import 挤到第 17 行，检测漏判）。
  // 同时看所有测试文件：一个插件可能混用（任一文件用 node:test 即按 node:test 跑）。
  const usesNodeTest = files.some((f) => /from 'node:test'/.test(readFileSync(f, 'utf8')))
  const args = usesNodeTest
    ? ['--test', '--test-force-exit', '--test-reporter=spec', ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
    : ['vitest', 'run', ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
  // 不用 shell:true——execPath 在 Windows 上含空格（'C:\Program Files\...'），shell 会把它拆断
  // （首次跑本门禁实测到该误报）。直接以 argv 形式 spawn，由内核处理路径。
  // vitest 的 --root 固定到插件目录，避免从上层配置解析导致 'No test suite found'。
  const spawnArgs = usesNodeTest
    ? args
    : ['vitest', 'run', '--root', join(PLUGIN_DIR, plugin), ...files.map((f) => f.slice(join(PLUGIN_DIR, plugin).length + 1))]
  const bin = usesNodeTest ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx')
  const r2 = spawnSync(bin, spawnArgs, { cwd: join(PLUGIN_DIR, plugin), encoding: 'utf8', timeout: TEST_TIMEOUT_MS })
  const out2 = (r2.stdout ?? '') + (r2.stderr ?? '')
  // 通过数：node:test spec 报 'ℹ pass N'；vitest 报 'Tests N passed'。两者都接受，任一为 0 判红。
  // 通过数：node:test spec 报 'ℹ pass N'；vitest 报 'Tests N passed'；Node 20 TAP 报 '# pass N'。
  const plain2 = stripAnsi(out2)
  const passN2 = Number((/^ℹ pass (\d+)/m.exec(plain2) ?? /Tests\s+(\d+) passed/m.exec(plain2) ?? /# pass (\d+)/m.exec(plain2))?.[1] ?? '0')
  // 失败数：必须锚定字段本身，不能用裸 /(\d+) failed/ —— 它会命中 'cancelled 0' 之类无关行的
  // 相邻数字，或把 'ℹ fail 0' 里的 0 与别处的数字混起来（首次跑本门禁实测到该误判）。
  const failN2 = Number(/^ℹ fail (\d+)/m.exec(plain2)?.[1] ?? /^\s*(\d+) failed/m.exec(plain2)?.[1] ?? '0')
  if (r2.status !== 0 || failN2 !== 0) {
    failed += 1
    console.error('FAIL  ' + plugin + ' 的单测未通过（runner=' + (usesNodeTest ? 'node:test' : 'vitest') + (r2.error?.code === 'ETIMEDOUT' ? ', timeout=' + TEST_TIMEOUT_MS + 'ms' : '') + '）')
    console.error(out2.split('\n').slice(-25).join('\n'))
  } else if (passN2 <= 0) {
    failed += 1
    console.error('FAIL  ' + plugin + ' 的单测未产生有效通过数（全 skip = 假绿）')
  } else {
    console.log('PASS  ' + plugin + '（' + files.length + ' 个文件 / ' + passN2 + ' 项通过，' + (usesNodeTest ? 'node:test' : 'vitest') + '）')
  }
}
if (noTests.length > 0) {
  console.log('WARN  以下插件没有 test/*.test.mjs（缺口可见，不阻塞）：' + noTests.join(', '))
}

// ── 注入层与子仓（0.14.1 批 3 补）：测试在场，但**此前没人按开关** ────────────────
//
// 真因（2026-09-23 设备实测）：`dsh-host-web-compat/lib/index.js` 是**每次页面加载最先求值的代码**，
// 它的注入脚本以模板串拼装；模板串内的注释里出现一个反引号就会把模板提前截断，症状是
// **引擎启动即失败**（`SyntaxError: Unexpected identifier`），用户看到「引擎启动失败」。
// 该仓自带 `npm test`（把模板切片 eval 出来逐一断言）**能判红这件事**——实测注入一个反引号即
// `ℹ fail 1 / ReferenceError: api is not defined`；但本门禁此前只扫 `plugins/*`，
// 于是「探测器在场、没人按开关」。下面两段把开关接上。
let skipped = 0

// ① 免依赖的**解析门**（始终可跑，不参与 SKIP）：`node --check` 尊重 package.json 的 `type=module`，
//    且不需要 node_modules，所以这一条没有「环境缺依赖就跳过」的借口。
const SYNTAX_CHECKED = ['dsh-host-web-compat/lib/index.js']
/** SKIP 计数器 + 行格式：check-gate-skips.mjs 要求每个 SKIP 行自带 `(#n)` 计数（或显式 SKIP=）。 */
const skipLine = (msg) => { skipped += 1; console.log('SKIP(#' + skipped + ') ' + msg) }
for (const rel of SYNTAX_CHECKED) {
  if (!existsSync(join(ROOT, rel))) {
    skipLine('解析门（文件不在场）：' + rel)
    continue
  }
  ran += 1
  const r4 = spawnSync(process.execPath, ['--check', rel], { cwd: ROOT, encoding: 'utf8' })
  const out4 = (r4.stdout ?? '') + (r4.stderr ?? '')
  if (r4.status !== 0) {
    failed += 1
    console.error('FAIL  ' + rel + ' 语法不合法（页面注入会整块失效、引擎可能起不来）')
    console.error(out4.split('\n').slice(0, 12).join('\n'))
  } else {
    console.log('PASS  解析门：' + rel)
  }
}

// ② 子仓自带测试（更细的行为断言）。两条路径：
//    - 依赖装好（node_modules 在场）→ 跑它自己声明的 `npm test`（完整契约，含 smoke 脚本）；
//    - 依赖缺失 → 退到 `node --test` 跑它自带的 *.test.mjs（这些用例只依赖 node 内置模块，
//      例如注入层的套件用 `new Function` 解析模板片段，不需要 cordis）。
//    两条都不可用时才 SKIP 计数（不判绿）。
const fsmod = await import('node:fs')
const SUBREPO_TESTS = ['dsh-host-web-compat', 'dsh-client-ui-responsive']
for (const repo of SUBREPO_TESTS) {
  const dir = join(ROOT, repo)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) {
    skipLine(repo + ' 的子仓测试（子仓不在场）')
    continue
  }
  const pkg = JSON.parse(fsmod.readFileSync(pkgPath, 'utf8'))
  const hasDeps = existsSync(join(dir, 'node_modules'))
  const bare = []
  for (const sub of ['test', 'scripts']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const f of fsmod.readdirSync(d)) if (f.endsWith('.test.mjs')) bare.push(join(sub, f))
  }
  if (!hasDeps && bare.length === 0) {
    skipLine(repo + ' 的子仓测试（无依赖且无自带 *.test.mjs）')
    continue
  }
  if (!hasDeps && typeof pkg.scripts?.test !== 'string') {
    skipLine(repo + ' 的子仓测试（无依赖且未声明 test 脚本）')
    continue
  }
  ran += 1
  const useNpm = hasDeps && typeof pkg.scripts?.test === 'string'
  const wslDir = process.platform === 'win32' && repo === 'dsh-client-ui-responsive' ? toWslPath(dir) : null
  const wslReady = wslDir === null ? null : spawnSync('wsl.exe', [
    '--cd', wslDir, '--exec', 'bash', '-lc', 'command -v npm >/dev/null && test -e node_modules/.bin/vitest',
  ], { encoding: 'utf8' })
  const useWslNpm = useNpm && wslReady !== null && wslReady.error === undefined && wslReady.status === 0
  // Windows 上 `spawnSync('npm.cmd')` 在无 shell 时可能直接 ENOENT/EINVAL（本机实测：errno 无输出、
  // status 为空），于是「测试明明全绿」却被判红。这里先直调，spawn 失败再退到 shell:true 重试
  // ——重试只影响「怎么起 npm」，判据仍是它的退出码与通过数。
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  let r3 = useWslNpm
    ? spawnSync('wsl.exe', ['--cd', wslDir, '--exec', 'env', 'npm_config_cache=/tmp/dsh-mobile-npm-cache', 'npm', 'test'], { cwd: dir, encoding: 'utf8', timeout: TEST_TIMEOUT_MS })
    : useNpm
      ? spawnSync(npmBin, ['test'], { cwd: dir, encoding: 'utf8', timeout: TEST_TIMEOUT_MS })
      : spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=spec', ...bare], { cwd: dir, encoding: 'utf8', timeout: TEST_TIMEOUT_MS })
  if (useNpm && (r3.error !== undefined || r3.status === null)) {
    console.log('NOTE  ' + repo + '：npm 直调失败（' + String(r3.error?.code ?? 'no-status') + '），退到 shell 重试')
    // shell:true 在 Node 24 会打一条 DEP0190 弃用提示（noise，与被测对象无关），子进程关掉它。
    r3 = spawnSync(npmBin, ['test'], { cwd: dir, encoding: 'utf8', shell: true, env: { ...process.env, NODE_OPTIONS: '--no-deprecation' }, timeout: TEST_TIMEOUT_MS })
  }
  if (r3.error !== undefined && r3.error !== null) {
    failed += 1
    console.error('FAIL  ' + repo + ' 的子仓测试无法启动：' + String(r3.error.message) + (r3.error.code === 'ETIMEDOUT' ? '（timeout=' + TEST_TIMEOUT_MS + 'ms）' : ''))
    continue
  }
  const out3 = (r3.stdout ?? '') + (r3.stderr ?? '')
  // 通过数：node:test 报 'ℹ pass N' / '# pass N'；vitest 报 'Tests N passed'。
  // 必须先剥 ANSI：vitest 的输出里 'Tests' 与数字之间夹着颜色转义，裸文本匹配永远不中（假红）。
  const plain3 = stripAnsi(out3)
  const passN3 = Number((/^ℹ pass (\d+)/m.exec(plain3) ?? /Tests\s+(\d+) passed/m.exec(plain3) ?? /^# pass (\d+)/m.exec(plain3))?.[1] ?? '0')
  const failN3 = Number(/^ℹ fail (\d+)/m.exec(plain3)?.[1] ?? /^\s*(\d+) failed/m.exec(plain3)?.[1] ?? '0')
  const how = useWslNpm ? 'WSL npm test' : useNpm ? 'npm test' : 'node --test（无依赖路径）'
  if (r3.status !== 0 || failN3 !== 0) {
    failed += 1
    console.error('FAIL  ' + repo + ' 的子仓测试未通过（' + how + '）')
    console.error(out3.split('\n').slice(-25).join('\n'))
  } else if (passN3 <= 0) {
    failed += 1
    console.error('FAIL  ' + repo + ' 的子仓测试未产生有效通过数（全 skip = 假绿）')
  } else {
    console.log('PASS  ' + repo + '（' + how + ' / ' + passN3 + ' 项通过）')
  }
}

if (failed > 0) {
  console.error('CHECK-PLUGIN-TESTS FAILED（' + failed + ' 个单测单元有问题；已跑 ' + ran + ' 个；SKIP=' + skipped + '）')
  process.exit(1)
}
// SKIP= 必须出现在收口行：聚合链的 check-gate-skips.mjs 按它核对「跳过项被如实计数」，
// 只写中文「N 项 SKIP」会被判成「有 SKIP 行但汇总缺席」。
console.log('CHECK-PLUGIN-TESTS PASSED（已跑 ' + ran + ' 个单测单元；SKIP=' + skipped
  + (noTests.length > 0 ? '；' + noTests.length + ' 个插件暂无测试' : '') + '）')
